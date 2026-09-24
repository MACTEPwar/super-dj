import { EventEmitter } from 'events';
import { StreamDestination } from '@prisma/client';
import { PlaylistQueue } from '../playlist/queue';
import { Track } from '../playlist/types';
import { StreamController } from './streamController';
import { SessionState } from './types';
import { ApiError } from '../errors';
import { createReconnectPolicy, createForwardReconnectPolicy } from './reconnectPolicy';
import { buildStreamScene, StreamSceneDeps } from './streamScene';
import { LocalRelaySession, LocalRelayTarget } from './localRelayTarget';
import { MediaMtxAuthRegistry } from './mediaMtxAuth';
import { DestinationForward, DestinationForwardStatus, ForwardDesiredState } from './destinationForward';
import { RelayProcess } from '../ffmpeg/relayProcess';
import { DestinationRepository } from '../destinations/destinationRepository';
import { BroadcastMeta, StreamDestinationProvider } from '../destinations/streamDestinationProvider';

// 'starting' is the spec's promotion of the old side-channel `starting` Set into a real reported
// state: a destination toggle can now arrive mid-start and the UI must not read 'idle' while a
// start is in flight. Deliberately a STATUS-layer state only — StreamController never produces it,
// so SessionState itself stays exactly as it is.
export type LocalSessionState = SessionState | 'starting';

export interface LocalStreamState {
  state: LocalSessionState;
  currentTrack: string | null;
  nextTrack: string | null;
  // True once the encoder is publishing into MediaMTX — including while paused, because pausing
  // only swaps the audio to silence and never interrupts the local publish. This is exactly the
  // condition under which the HLS preview can produce a playlist.
  previewReady: boolean;
  playlistId: string | null;
  templateId: string | null;
  startedAt: string | null;
}

// The spec's combined payload: one local stream, and 0..N independently toggleable destinations.
// Zero destinations is a fully valid running state, not a degenerate one.
export interface LocalStreamStatus {
  local: LocalStreamState;
  destinations: DestinationForwardStatus[];
}

export interface StartLocalStreamOptions {
  templateId?: string;
}

export interface LocalPreviewTarget {
  hlsBaseUrl: string;
  authorization: string;
}

export interface LocalStreamManagerDeps {
  sceneDeps: StreamSceneDeps;
  relayTarget: Pick<LocalRelayTarget, 'create'>;
  authRegistry: Pick<MediaMtxAuthRegistry, 'register' | 'unregister'>;
  destinationRepository: Pick<DestinationRepository, 'findById'>;
  providers: Record<string, StreamDestinationProvider>;
  // Spec open question #8: every logged-in user can start an encode without owning any destination
  // at all, so a per-host ceiling is required rather than optional.
  maxConcurrentStreams: number;
  // Spec open question #7: a local stream with nothing forwarded and nobody watching still costs a
  // full libx264 encode, so it cannot run forever.
  maxSessionDurationMs: number;
  // Injected for tests; production always uses the real buildStreamScene.
  buildScene?: typeof buildStreamScene;
  // Injected for tests; production builds a RelayProcess on the SAME Spawner the scene uses, so a
  // relay's ffmpeg stderr is drained and timestamped exactly like the encoder's.
  createRelay?: (params: { inputUrl: string; outputUrl: string }) => RelayProcess;
}

interface LocalStreamEntry {
  controller: StreamController;
  relay: LocalRelaySession;
  playlistId: string;
  templateId: string | null;
  startedAt: number;
  expiryTimer: NodeJS.Timeout;
}

const IDLE_LOCAL_STATE: LocalStreamState = {
  state: 'idle', currentTrack: null, nextTrack: null,
  previewReady: false, playlistId: null, templateId: null, startedAt: null,
};

/**
 * Owns exactly one local stream per user account plus that account's destination forwards — the
 * replacement for BOTH the old, now-deleted per-destination stream manager (destinationId-keyed
 * controllers) and the old, now-deleted multi-destination session manager (fan-out over N of
 * them). There is one encode now, so there is nothing to fan out: destinations are readers of the
 * same local relay, toggled independently, and none of them can ever desynchronise from another
 * or take the encode down with it.
 */
export class LocalStreamManager extends EventEmitter {
  private readonly streams = new Map<string, LocalStreamEntry>();
  private readonly starting = new Set<string>();
  // userId -> destinationId -> forward. Survives the stream being idle: a forward toggled on with
  // nothing running parks at 'pending' (zero external side effects) and comes to life on the next
  // start.
  private readonly forwards = new Map<string, Map<string, DestinationForward>>();
  private readonly buildScene: typeof buildStreamScene;
  private readonly createRelay: (params: { inputUrl: string; outputUrl: string }) => RelayProcess;

  constructor(private readonly deps: LocalStreamManagerDeps) {
    super();
    // Every open SSE connection adds a 'statusChanged' listener to this one shared instance —
    // legitimately unbounded by design, not a leak.
    this.setMaxListeners(0);
    this.buildScene = deps.buildScene ?? buildStreamScene;
    this.createRelay = deps.createRelay
      ?? ((params) => new RelayProcess({ spawner: deps.sceneDeps.spawner, ...params }));
  }

  async start(userId: string, playlistId: string, options: StartLocalStreamOptions = {}): Promise<void> {
    // Synchronous, id-keyed re-entrancy guard: two overlapping starts for the same user must not
    // both pass the "already active" check below before either has registered an entry — that race
    // would leak the loser's whole pipeline (an orphaned ffmpeg pushing into a path nothing will
    // ever unregister). Reject the second call before ANY async work.
    if (this.starting.has(userId)) throw new ApiError(409, 'a local stream is already starting for this account');

    const existing = this.streams.get(userId);
    if (existing) {
      const state = existing.controller.status().state;
      if (state === 'streaming' || state === 'paused') {
        throw new ApiError(409, 'a local stream is already active for this account');
      }
      // 'error' (gave up after an unexpected encoder exit) or 'reconnecting' (a respawn is
      // pending): the collaborators may still be alive, so tear them down before starting fresh.
      // 'idle' has nothing left to tear down and stop() would throw for it.
      if (state !== 'idle') existing.controller.stop();
      this.discard(userId, existing);
    }

    // Synchronous check-and-reserve, with no `await` between reading these counts and reserving a
    // slot: N concurrent start() calls for N *different* users would otherwise all observe
    // `streams.size` before any of them incremented it. `starting.size` closes that window because
    // it is incremented right here, synchronously. A stream stuck in `error` also no longer pins a
    // slot forever: `active` excludes it, since an errored encoder has already stopped costing CPU.
    const active = [...this.streams.values()].filter((e) => e.controller.status().state !== 'error').length;
    if (active + this.starting.size >= this.deps.maxConcurrentStreams) {
      throw new ApiError(429, 'too many local streams are running on this host; try again later');
    }

    this.starting.add(userId);
    this.emit('statusChanged', userId);
    try {
      const scene = await this.buildScene(this.deps.sceneDeps, {
        userId,
        playlistId,
        templateId: options.templateId,
        // One pipeline per user, so the user's own id is a sufficient namespace for the on-disk
        // overlay PNGs.
        sceneId: userId,
      });

      // Minted AFTER the scene resolves, so a 404/403/409 never burns a token, and registered
      // BEFORE the encoder starts, so the publish attempt can never lose a race with its own
      // authorisation.
      const relay = this.deps.relayTarget.create(userId);
      this.deps.authRegistry.register(relay);

      const controller = new StreamController({
        library: scene.library,
        queue: new PlaylistQueue(scene.tracks),
        buildOverlay: scene.buildOverlay,
        createCanvasFeeder: scene.createCanvasFeeder,
        createAudioRelay: scene.createAudioRelay,
        createPersistentEncoder: () => scene.createPersistentEncoder({
          rtmpUrl: relay.publishRtmpUrl,
          streamKey: relay.publishStreamKey,
        }),
        createPulseVisualizer: scene.createPulseVisualizer,
        createPlaylistWindowFeeder: scene.createPlaylistWindowFeeder,
        createMarqueeFeeder: scene.createMarqueeFeeder,
        resolveMarqueeRow: scene.resolveMarqueeRow,
        // No isRetryableDestination veto: there is no destination at THIS layer any more — the
        // encoder pushes into a container-network MediaMTX that essentially never drops for network
        // reasons, so reconnect here fires only on a genuine ffmpeg crash/OOM. Destination-side
        // reconnect is each DestinationForward's own concern, on its own faster schedule.
        reconnectPolicy: createReconnectPolicy(),
        onError: (exitCode) => {
          console.error(
            `[${new Date().toISOString()}] user ${userId}: local encoder exited unexpectedly (code=${exitCode}) and reconnect gave up; revoking its MediaMTX credentials`,
          );
          const entry = this.streams.get(userId);
          if (entry && entry.relay.path === relay.path) {
            clearTimeout(entry.expiryTimer);
            this.deps.authRegistry.unregister(relay.path);
          }
        },
        onStatusChanged: () => {
          this.emit('statusChanged', userId);
          // Every local state change is a forward-relevant event: starting to publish, pausing
          // (still publishing), reconnecting (hold), giving up (finalize).
          this.reconcileForwards(userId);
        },
      });

      const expiryTimer = setTimeout(() => {
        console.warn(`[stream] user ${userId}: local stream hit the maximum session duration, stopping it`);
        void this.stop(userId).catch((err) => {
          console.error('failed to stop a local stream that hit its maximum duration', err);
        });
      }, this.deps.maxSessionDurationMs);
      // Never let an idle 12-hour timer hold the process open on shutdown.
      expiryTimer.unref();

      const entry: LocalStreamEntry = {
        controller, relay, playlistId, templateId: options.templateId ?? null,
        startedAt: Date.now(), expiryTimer,
      };
      this.streams.set(userId, entry);

      try {
        await controller.start();
      } catch (err) {
        // controller.start() can throw AFTER already spawning the encoder/CanvasFeeder/AudioRelay.
        // Without this stop(), they keep running as a genuine orphan whose MediaMTX credentials
        // discard() is about to revoke.
        if (controller.status().state !== 'idle') controller.stop();
        this.discard(userId, entry);
        throw err;
      }

      // A forward can SURVIVE across stop-and-restart without going through getOrCreateForward at
      // all: an encoder crash finalizes it into 'pending' (branch 1) without pruning it (desired is
      // still 'on'), and this restart's start() call has no destination list of its own any more —
      // destinations are toggled independently via setDestinationDesired(), before or after start().
      // Without this, that surviving forward's very next prepareSession() would read the STALE row
      // captured whenever it was originally constructed, missing any youtubeLiveStreamId a prior
      // session persisted — the exact bug setDestination() exists to prevent, just reachable from a
      // different call site than the toggle route. Refresh every surviving forward's row here, not
      // only the ones this call happens to also be (re-)toggling on.
      await this.refreshForwardRows(userId);
      this.reconcileForwards(userId);
    } finally {
      this.starting.delete(userId);
      this.emit('statusChanged', userId);
    }
  }

  async stop(userId: string): Promise<void> {
    const entry = this.require(userId);
    const forwards = [...(this.forwards.get(userId)?.values() ?? [])];
    // Set every intent to off SYNCHRONOUSLY first, so no forward can spawn a new relay or prepare a
    // new broadcast while the teardown below is in flight. Spec: "Stop while a forward is
    // mid-toggle-on — set every desired = off; the in-flight prepare completes, registers, and the
    // next reconcile() finalizes it. No special case needed."
    for (const forward of forwards) forward.setDesired('off');
    if (entry.controller.status().state !== 'idle') entry.controller.stop();
    this.discard(userId, entry);
    await Promise.all(forwards.map((forward) => forward.shutdown()));
    this.forwards.delete(userId);
    this.emit('statusChanged', userId);
  }

  pause(userId: string): void {
    this.require(userId).controller.pause();
  }

  async resume(userId: string): Promise<void> {
    return this.require(userId).controller.resume();
  }

  async next(userId: string): Promise<void> {
    return this.require(userId).controller.next();
  }

  async previous(userId: string): Promise<void> {
    return this.require(userId).controller.previous();
  }

  playByName(userId: string, name: string): void {
    this.require(userId).controller.playByName(name);
  }

  enqueueTrack(userId: string, track: Track): void {
    this.require(userId).controller.enqueueTrack(track);
  }

  /**
   * The checkbox. Idempotent, never blocks on the work it triggers, and valid in every local-stream
   * state including idle (a toggle while nothing runs parks at 'pending' rather than 409ing, so
   * pre-checking before a start and toggling mid-stream are one code path). `meta` is this
   * destination's own broadcast title/description/privacy/latency, supplied by the caller right at
   * the moment of toggling ON — this is where per-destination broadcast settings actually apply,
   * not a session-wide default chosen once at start(). Ignored on toggle-off, and optional on
   * toggle-on too (see DestinationForward.setDesired()'s own doc comment for the fallback).
   */
  async setDestinationDesired(
    userId: string,
    destinationId: string,
    desired: ForwardDesiredState,
    meta?: Partial<BroadcastMeta>,
  ): Promise<LocalStreamStatus> {
    const destination = await this.requireOwnedDestination(userId, destinationId);
    this.requireProvider(destination);
    const forward = this.getOrCreateForward(userId, destination);
    // `title` defaults to the destination's own name — the natural fallback now that there is no
    // shared playlist/session context to default it from (the old start()-level default used the
    // playlist's name; a per-destination toggle has no playlist name of its own to reach for).
    // A plain `{ title: destination.name, ...meta }` spread would NOT do this correctly: the route
    // always includes every key (title included) even when its value is `undefined`, and spreading
    // an explicit `undefined` overwrites the default rather than falling through to it.
    forward.setDesired(desired, meta ? {
      title: meta.title ?? destination.name,
      description: meta.description,
      privacyStatus: meta.privacyStatus,
      latencyPreference: meta.latencyPreference,
    } : undefined);
    // Deliberately NOT pruning here, even for desired === 'off': a toggle-off starts finalize()
    // asynchronously (this call returns before it resolves), and isInactive() correctly reports
    // false while it's 'stopping' — but calling pruneForwards() eagerly right after setDesired()
    // is exactly the pattern that made the earlier (buggy) version of isInactive() dangerous: any
    // future weakening of that check would silently reopen the toggle-off-then-fast-toggle-on race
    // (see isInactive()'s comment). Pruning instead happens from onStatusChanged (below in
    // getOrCreateForward), which fires every time a forward's OWN state actually changes — so a
    // forward is only ever removed once it has genuinely finished settling to off.
    return this.status(userId);
  }

  /**
   * Called when a destination row is deleted. Toggles that forward off and finalizes its lifecycle
   * WITHOUT touching the local stream — the pre-rework code called `streamManager.stop
   * (destinationId)` here, which in this model would tear down the user's whole encode to delete
   * one checkbox (the spec calls this out as an "easy one-line miss that orphans a broadcast").
   */
  async removeDestination(userId: string, destinationId: string): Promise<void> {
    const forward = this.forwards.get(userId)?.get(destinationId);
    if (!forward) return;
    await forward.shutdown();
    this.forwards.get(userId)?.delete(destinationId);
    this.pruneForwards(userId);
  }

  status(userId: string): LocalStreamStatus {
    return { local: this.localState(userId), destinations: this.forwardStatuses(userId) };
  }

  // The ONLY way the preview route learns which MediaMTX path to read: resolved server-side from
  // the authenticated user. Never accept a path or token from the client. Returns null unless this
  // user still owns a LIVE MediaMTX registration, so a dead session's credential is never handed
  // out. 'reconnecting' counts as live (a pending respawn still needs it) and 'error' does not.
  previewTarget(userId: string): LocalPreviewTarget | null {
    const entry = this.streams.get(userId);
    if (!entry) return null;
    const state = entry.controller.status().state;
    if (state !== 'streaming' && state !== 'paused' && state !== 'reconnecting') return null;
    return { hlsBaseUrl: entry.relay.hlsBaseUrl, authorization: entry.relay.readAuthorization };
  }

  private localState(userId: string): LocalStreamState {
    const entry = this.streams.get(userId);
    if (!entry) {
      return this.starting.has(userId) ? { ...IDLE_LOCAL_STATE, state: 'starting' } : { ...IDLE_LOCAL_STATE };
    }
    const base = entry.controller.status();
    return {
      state: base.state,
      currentTrack: base.currentTrack,
      nextTrack: base.nextTrack,
      previewReady: base.state === 'streaming' || base.state === 'paused',
      playlistId: entry.playlistId,
      templateId: entry.templateId,
      startedAt: new Date(entry.startedAt).toISOString(),
    };
  }

  private forwardStatuses(userId: string): DestinationForwardStatus[] {
    return [...(this.forwards.get(userId)?.values() ?? [])].map((forward) => forward.status());
  }

  // `destination` MUST be re-applied on every call, even when an existing forward is returned.
  // A `DestinationForward` is created once and can live across many `prepareSession()` calls
  // (respawn, toggle-off-then-on, a parked 'pending' forward that finally starts) — if it kept
  // using the row captured at CONSTRUCTION time, `YoutubeProvider.prepareSession()`'s persisted
  // `youtubeLiveStreamId` (written to the DB by Task 5, so the NEXT prepareSession reuses the same
  // liveStream) would never be visible to that same forward object: it would keep reading its own
  // stale in-memory copy (still `null`) and create a brand-new liveStream every time, silently
  // defeating the entire point of Task 4/5 and — since `finalize()` no longer deletes the
  // liveStream (Task 5) — leaking one permanently on every such call. `setDestination()` is called
  // with a FRESH row every time (the caller already has one from `requireOwnedDestination`), on
  // both the existing-forward early return and the newly-constructed path.
  private getOrCreateForward(userId: string, destination: StreamDestination): DestinationForward {
    let forwards = this.forwards.get(userId);
    if (!forwards) {
      forwards = new Map<string, DestinationForward>();
      this.forwards.set(userId, forwards);
    }
    const existing = forwards.get(destination.id);
    if (existing) {
      existing.setDestination(destination);
      return existing;
    }

    const forward = new DestinationForward({
      destination,
      provider: this.requireProvider(destination),
      sourceUrl: () => this.sourceUrlFor(userId),
      isSourcePublishing: () => this.isSourcePublishing(userId),
      createRelay: this.createRelay,
      // No isRetryableDestination veto passed: it would be REDUNDANT here, not a missing safety
      // net. The only thing it could veto is a retry against a destination whose provider lifecycle
      // has already gone terminal ('error'/'complete', including the auth-class short-circuit) —
      // and DestinationForward.pass()'s own branch 3 (checkTerminalProviderPhase) already catches
      // exactly that, ahead of every branch that could start or respawn a relay. Wiring it too
      // would add a second, independently-maintained copy of the same check.
      reconnectPolicy: createForwardReconnectPolicy(),
      onStatusChanged: () => {
        // Prune from the ONE place a forward's own actual-state transitions flow through, so a
        // forward is only ever dropped once it has genuinely finished settling to 'off' — never
        // eagerly from the synchronous toggle call (see setDestinationDesired()'s comment).
        const forwardsForUser = this.forwards.get(userId);
        if (forwardsForUser?.get(destination.id)?.isInactive()) this.pruneForwards(userId);
        this.emit('statusChanged', userId);
      },
    });
    forwards.set(destination.id, forward);
    return forward;
  }

  private sourceUrlFor(userId: string): string | null {
    const entry = this.streams.get(userId);
    if (!entry) return null;
    const state = entry.controller.status().state;
    // 'error' means reconnect gave up and onError already revoked this session's MediaMTX
    // credentials — the session is over, so forwards must finalize rather than keep holding.
    // 'reconnecting' deliberately still returns the URL: that is what makes forwards HOLD instead
    // of burning a broadcast (and ~330 quota units, and every viewer's link) over a few seconds of
    // encoder downtime.
    if (state === 'idle' || state === 'error') return null;
    return entry.relay.readRtmpUrl;
  }

  private isSourcePublishing(userId: string): boolean {
    const state = this.streams.get(userId)?.controller.status().state;
    return state === 'streaming' || state === 'paused';
  }

  private reconcileForwards(userId: string): void {
    // reconcile() never rejects (DestinationForward.run() catches), so these are fire-and-forget by
    // design: a status change must not wait on a YouTube round-trip.
    for (const forward of this.forwards.get(userId)?.values() ?? []) void forward.reconcile();
  }

  // Called once, from start(), right before reconcileForwards() — NOT from every onStatusChanged
  // (that one stays synchronous/fire-and-forget on purpose; a plain local DB read on every relay
  // exit or pause/resume would be needless load). A local DB lookup, not a provider round-trip, so
  // awaiting it here doesn't reintroduce the "a status change must not wait on YouTube" problem
  // reconcileForwards's own comment guards against.
  private async refreshForwardRows(userId: string): Promise<void> {
    const forwards = [...(this.forwards.get(userId)?.values() ?? [])];
    await Promise.all(forwards.map(async (forward) => {
      const row = await this.deps.destinationRepository.findById(forward.destinationId);
      if (row) forward.setDestination(row);
    }));
  }

  // Drop forwards that want nothing and hold nothing, so a user who ticked and unticked a box does
  // not carry a dead entry in every status payload forever.
  private pruneForwards(userId: string): void {
    const forwards = this.forwards.get(userId);
    if (!forwards) return;
    for (const [destinationId, forward] of forwards) {
      if (forward.isInactive()) forwards.delete(destinationId);
    }
    if (forwards.size === 0) this.forwards.delete(userId);
  }

  private async requireOwnedDestination(userId: string, destinationId: string): Promise<StreamDestination> {
    const destination = await this.deps.destinationRepository.findById(destinationId);
    if (!destination) throw new ApiError(404, 'destination not found');
    if (destination.userId !== userId) throw new ApiError(403, 'not your destination');
    return destination;
  }

  private requireProvider(destination: StreamDestination): StreamDestinationProvider {
    const provider = this.deps.providers[destination.provider];
    if (!provider) throw new ApiError(400, `unsupported destination provider: ${destination.provider}`);
    return provider;
  }

  private require(userId: string): LocalStreamEntry {
    const entry = this.streams.get(userId);
    if (!entry) throw new ApiError(409, 'local stream is not active');
    return entry;
  }

  // Drops every trace of a session: its expiry timer, its MediaMTX credentials, and its registry
  // slot (which is what frees capacity under maxConcurrentStreams). Forwards are handled
  // separately, by stop() itself (which calls this) — a stop is a full stop, not a pause: every
  // forward's desired is forced to 'off' and its lifecycle finalized before the forward map entry
  // is dropped, so a destination a user wants "checked next time" is a frontend-side preference
  // (the idle-mode checklist in Stream.tsx), not something this manager remembers across a
  // stop/start on its own.
  private discard(userId: string, entry: LocalStreamEntry): void {
    clearTimeout(entry.expiryTimer);
    this.deps.authRegistry.unregister(entry.relay.path);
    if (this.streams.get(userId) === entry) this.streams.delete(userId);
  }
}
