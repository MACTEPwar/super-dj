import { EventEmitter } from 'events';
import { PlaylistQueue } from '../playlist/queue';
import { StreamController } from './streamController';
import { StreamStatus } from './types';
import { ApiError } from '../errors';
import { createReconnectPolicy } from './reconnectPolicy';
import { buildStreamScene, StreamSceneDeps } from './streamScene';
import { LocalRelaySession, LocalRelayTarget } from './localRelayTarget';
import { MediaMtxAuthRegistry } from './mediaMtxAuth';

export interface LocalStreamStatus extends StreamStatus {
  // True once the encoder is publishing into MediaMTX — including while paused, because pausing
  // only swaps the audio to silence and never interrupts the local publish. This is exactly the
  // condition under which the HLS preview can produce a playlist.
  previewReady: boolean;
  playlistId: string | null;
  templateId: string | null;
  startedAt: string | null;
}

export interface LocalPreviewTarget {
  hlsBaseUrl: string;
  authorization: string;
}

export interface LocalStreamManagerDeps {
  sceneDeps: StreamSceneDeps;
  relayTarget: Pick<LocalRelayTarget, 'create'>;
  authRegistry: Pick<MediaMtxAuthRegistry, 'register' | 'unregister'>;
  // Spec open question #8: every logged-in user can now start an encode without owning any
  // destination at all, so a per-host ceiling is required rather than optional.
  maxConcurrentStreams: number;
  // Spec open question #7: a local stream with nothing forwarded and nobody watching still costs
  // a full libx264 encode, so it cannot run forever.
  maxSessionDurationMs: number;
  // Injected for tests; production always uses the real buildStreamScene.
  buildScene?: typeof buildStreamScene;
}

// Everything one user's local stream owns. Deliberately a struct rather than a bare
// StreamController: Phase B adds `forwards: Map<string, DestinationForward>` here, and nothing else
// about this class has to change for that.
interface LocalStreamEntry {
  controller: StreamController;
  relay: LocalRelaySession;
  playlistId: string;
  templateId: string | null;
  startedAt: number;
  expiryTimer: NodeJS.Timeout;
}

const IDLE_STATUS: LocalStreamStatus = {
  state: 'idle', currentTrack: null, nextTrack: null,
  previewReady: false, playlistId: null, templateId: null, startedAt: null,
};

/**
 * Owns exactly one local stream per user account, keyed by userId — the replacement for
 * StreamManager's destinationId-keyed registry. Phase A has no destination concept at all: the
 * encoder pushes into MediaMTX and nothing pulls from it except the preview proxy.
 */
export class LocalStreamManager extends EventEmitter {
  private readonly streams = new Map<string, LocalStreamEntry>();
  private readonly starting = new Set<string>();
  private readonly buildScene: typeof buildStreamScene;

  constructor(private readonly deps: LocalStreamManagerDeps) {
    super();
    // Every open SSE connection adds a 'statusChanged' listener to this one shared instance —
    // legitimately unbounded by design, not a leak. Same reasoning as StreamManager's.
    this.setMaxListeners(0);
    this.buildScene = deps.buildScene ?? buildStreamScene;
  }

  async start(userId: string, playlistId: string, options?: { templateId?: string }): Promise<void> {
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
    // `streams.size` before any of them incremented it (that only happens after buildScene's
    // await, well below), and all pass the cap. `starting.size` closes that window because it is
    // incremented right here, synchronously — whichever call's synchronous prologue runs first
    // necessarily finishes reserving before the next one's prologue starts (JS never interleaves
    // two synchronous stretches). A stream stuck in `error` also no longer pins a slot forever:
    // `active` excludes it, since an errored encoder has already stopped costing real CPU.
    const active = [...this.streams.values()].filter((e) => e.controller.status().state !== 'error').length;
    if (active + this.starting.size >= this.deps.maxConcurrentStreams) {
      throw new ApiError(429, 'too many local streams are running on this host; try again later');
    }

    this.starting.add(userId);
    try {
      const scene = await this.buildScene(this.deps.sceneDeps, {
        userId,
        playlistId,
        templateId: options?.templateId,
        // One pipeline per user in this phase, so the user's own id is a sufficient namespace for
        // the on-disk overlay PNGs.
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
        // No isRetryableDestination veto: there is no destination at this layer. This push is a
        // container-network hop that essentially never drops for network reasons, so reconnect
        // here fires only on a genuine ffmpeg crash/OOM — and then a respawn against the SAME
        // still-registered relay session is exactly the right thing to do.
        reconnectPolicy: createReconnectPolicy(),
        onError: (exitCode) => {
          console.error(
            `[${new Date().toISOString()}] user ${userId}: local encoder exited unexpectedly (code=${exitCode}) and reconnect gave up; revoking its MediaMTX credentials`,
          );
          // Revoke immediately, but keep the entry so status() can keep reporting 'error' until the
          // user restarts or stops. Only fires once reconnect has given up — a pending respawn
          // still needs these credentials.
          const entry = this.streams.get(userId);
          if (entry && entry.relay.path === relay.path) {
            clearTimeout(entry.expiryTimer);
            this.deps.authRegistry.unregister(relay.path);
          }
        },
        onStatusChanged: () => { this.emit('statusChanged', userId); },
      });

      const expiryTimer = setTimeout(() => {
        console.warn(`[stream] user ${userId}: local stream hit the maximum session duration, stopping it`);
        try {
          this.stop(userId);
        } catch (err) {
          console.error('failed to stop a local stream that hit its maximum duration', err);
        }
      }, this.deps.maxSessionDurationMs);
      // Never let an idle 12-hour timer hold the process open on shutdown — same discipline as
      // CanvasFeeder's heartbeat interval.
      expiryTimer.unref();

      const entry: LocalStreamEntry = {
        controller, relay, playlistId, templateId: options?.templateId ?? null,
        startedAt: Date.now(), expiryTimer,
      };
      this.streams.set(userId, entry);

      try {
        await controller.start();
      } catch (err) {
        // controller.start() can throw AFTER already spawning the encoder/CanvasFeeder/AudioRelay
        // (it awaits getAudioDurationSeconds/buildOverlay for the first track only after setting
        // state to 'streaming' and starting the pipeline) — e.g. a missing/corrupt first track's
        // audio file. Without this stop(), the ffmpeg process and its 200ms CanvasFeeder heartbeat
        // keep running as a genuine orphan: its MediaMTX credentials are revoked by discard() below
        // while it is still connected and publishing (MediaMTX does not re-authorise an
        // already-established RTMP connection), the concurrency slot is freed while the CPU cost
        // is not, and nothing will ever reap it.
        if (controller.status().state !== 'idle') controller.stop();
        this.discard(userId, entry);
        throw err;
      }
    } finally {
      this.starting.delete(userId);
    }
  }

  stop(userId: string): void {
    const entry = this.require(userId);
    if (entry.controller.status().state !== 'idle') entry.controller.stop();
    this.discard(userId, entry);
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

  status(userId: string): LocalStreamStatus {
    const entry = this.streams.get(userId);
    if (!entry) return { ...IDLE_STATUS };
    const base = entry.controller.status();
    return {
      ...base,
      previewReady: base.state === 'streaming' || base.state === 'paused',
      playlistId: entry.playlistId,
      templateId: entry.templateId,
      startedAt: new Date(entry.startedAt).toISOString(),
    };
  }

  // The ONLY way the preview route learns which MediaMTX path to read: resolved server-side from
  // the authenticated user. Never accept a path or token from the client — see the spec's security
  // section. Returns null unless this user still owns a LIVE MediaMTX registration, so a dead
  // session's credential is never handed out.
  //
  // 'reconnecting' counts as live and 'error' does not, which is exactly the split onError draws:
  // a pending respawn is about to publish again through these same still-registered credentials
  // (nothing has been unregistered yet), whereas 'error' means reconnect gave up and onError has
  // already revoked them — handing them out then would only produce upstream 401s. Note this is a
  // deliberately broader condition than status()'s `previewReady`, which answers a different
  // question: whether HLS can produce a playlist *right now* (it cannot while the encoder is down
  // between respawns), not whether the credential is still worth holding on to.
  previewTarget(userId: string): LocalPreviewTarget | null {
    const entry = this.streams.get(userId);
    if (!entry) return null;
    const state = entry.controller.status().state;
    if (state !== 'streaming' && state !== 'paused' && state !== 'reconnecting') return null;
    return { hlsBaseUrl: entry.relay.hlsBaseUrl, authorization: entry.relay.readAuthorization };
  }

  private require(userId: string): LocalStreamEntry {
    const entry = this.streams.get(userId);
    if (!entry) throw new ApiError(409, 'local stream is not active');
    return entry;
  }

  // Drops every trace of a session: its expiry timer, its MediaMTX credentials, and its registry
  // slot (which is what frees capacity under maxConcurrentStreams).
  private discard(userId: string, entry: LocalStreamEntry): void {
    clearTimeout(entry.expiryTimer);
    this.deps.authRegistry.unregister(entry.relay.path);
    if (this.streams.get(userId) === entry) this.streams.delete(userId);
  }
}
