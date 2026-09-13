import { EventEmitter } from 'events';
import { PlaylistQueue } from '../playlist/queue';
import { StreamController } from './streamController';
import { DestinationStreamStatus, StreamStatus } from './types';
import { ApiError } from '../errors';
import { DestinationRepository } from '../destinations/destinationRepository';
import { SessionOverlayCache } from './sessionOverlayCache';
import { BroadcastMeta, DestinationLifecycle, StreamDestinationProvider } from '../destinations/streamDestinationProvider';
import { createReconnectPolicy } from './reconnectPolicy';
import { buildStreamScene, StreamSceneDeps } from './streamScene';

// Extra, optional per-start() options beyond the existing (destinationId, playlistId, meta)
// shape — kept as a trailing object rather than reworking the whole signature, since playlistId/
// meta are unaffected and every existing call site stays valid as-is.
export interface StreamStartOptions {
  // No template selected -> DEFAULT_TEMPLATE_ELEMENTS is used, not an error; see the "Overlay
  // templates" section of CLAUDE.md for why templateId is optional rather than required.
  templateId?: string;
  // Set by StreamSessionManager when this destination is part of a multi-destination session,
  // so sibling destinations rendering the identical (track, template) pair can share one render
  // instead of each paying for their own. Absent for a standalone single-destination stream.
  overlayCache?: SessionOverlayCache;
  sessionId?: string;
}

// Everything destination-agnostic (the ffmpeg-facing deps, the repositories a scene is resolved
// from) is reused verbatim from StreamSceneDeps rather than re-declared, so the two can never
// drift; only the destination half is added here.
export interface StreamManagerDeps extends StreamSceneDeps {
  destinationRepository: Pick<DestinationRepository, 'findById'>;
  providers: Record<string, StreamDestinationProvider>;
}

export class StreamManager extends EventEmitter {
  private readonly controllers = new Map<string, StreamController>();
  private readonly lifecycles = new Map<string, { providerType: string; lifecycle: DestinationLifecycle }>();
  private readonly starting = new Set<string>();

  constructor(private readonly deps: StreamManagerDeps) {
    super();
    // Every open SSE connection (across ALL destinations and ALL users) adds one
    // 'statusChanged' listener to this single shared instance — legitimately unbounded
    // by design (as many people as want to watch a stream's status), not a leak. Disable
    // Node's default max-listeners warning (10) so a busy multi-tenant deployment doesn't
    // spam stderr with MaxListenersExceededWarning.
    this.setMaxListeners(0);
  }

  get(destinationId: string): StreamController | undefined {
    return this.controllers.get(destinationId);
  }

  async start(destinationId: string, playlistId: string, meta?: Partial<BroadcastMeta>, options?: StreamStartOptions): Promise<void> {
    // Synchronous, id-keyed re-entrancy guard: two overlapping start() calls for the same
    // destination must not both pass the (also synchronous) "already active" check below
    // before either has registered a controller — that race would leak the loser's
    // StreamController (orphaned ffmpeg pusher) and DestinationLifecycle (e.g. a live YouTube
    // broadcast with no finalize ever called). Reject the second call before ANY async work.
    if (this.starting.has(destinationId)) {
      throw new ApiError(409, 'a stream is already starting for this destination');
    }
    // A controller left behind in 'error' state (unexpected pusher exit) must not
    // block a restart — only a live streaming/paused session is "already active".
    const existing = this.controllers.get(destinationId);
    if (existing) {
      const state = existing.status().state;
      if (state === 'streaming' || state === 'paused') {
        throw new ApiError(409, 'a stream is already active for this destination');
      }
      if (state === 'error' || state === 'reconnecting') {
        // An error-state controller's collaborators (CanvasFeeder's heartbeat, AudioRelay's
        // decode process) are still alive until torn down — stop() runs that teardown. A
        // reconnecting controller has a pending respawn timer instead — stop() cancels that too.
        // A manual restart while reconnecting is a deliberate user override: tear down and start
        // fresh (a brand-new provider.prepareSession() below, a new YouTube broadcast if
        // applicable), same as it's always behaved for 'error'. Skipped for 'idle' (already torn
        // down; stop() would throw 409 for a non-active session).
        existing.stop();
      }
      this.controllers.delete(destinationId);
      // A stale entry here means an earlier session's lifecycle (e.g. a YouTube broadcast/
      // stream) was never finalized — the pusher died before StreamManager got a chance to,
      // or the destination is being restarted before that session's own cleanup ran. Finalize
      // it now so restarting a destination never silently orphans a YouTube broadcast.
      const staleEntry = this.lifecycles.get(destinationId);
      this.lifecycles.delete(destinationId);
      if (staleEntry) {
        staleEntry.lifecycle.finalize().catch((err) => {
          console.error('failed to finalize a stale destination lifecycle before restart', err);
        });
      }
    }

    this.starting.add(destinationId);
    try {
      const destination = await this.deps.destinationRepository.findById(destinationId);
      if (!destination) throw new ApiError(404, 'destination not found');

      // Scene resolution (playlist/template/track ownership, gif probing, canvas placement, the
      // overlay renderer) has no destination concept in it and lives in streamScene.ts. The
      // playlist and template must belong to the same user who owns the destination, otherwise any
      // user owning a destination could stream another user's private playlist — buildStreamScene
      // enforces that against the userId passed here.
      const scene = await buildStreamScene(this.deps, {
        userId: destination.userId,
        playlistId,
        templateId: options?.templateId,
        sceneId: destinationId,
        overlayCache: options?.overlayCache,
        sessionId: options?.sessionId,
      });

      const provider = this.deps.providers[destination.provider];
      if (!provider) throw new ApiError(400, `unsupported destination provider: ${destination.provider}`);
      const resolvedMeta: BroadcastMeta = {
        title: meta?.title ?? scene.playlistName,
        description: meta?.description,
        privacyStatus: meta?.privacyStatus,
        latencyPreference: meta?.latencyPreference,
      };
      const session = await provider.prepareSession(destination, resolvedMeta);

      const queue = new PlaylistQueue(scene.tracks);

      const controller = new StreamController({
        library: scene.library,
        queue,
        buildOverlay: scene.buildOverlay,
        createCanvasFeeder: scene.createCanvasFeeder,
        createAudioRelay: scene.createAudioRelay,
        createPersistentEncoder: () => scene.createPersistentEncoder({ rtmpUrl: session.rtmpUrl, streamKey: session.streamKey }),
        createPulseVisualizer: scene.createPulseVisualizer,
        // Generic uptime/crash-loop/attempt/time-budget gating lives in reconnectPolicy.ts;
        // the only thing folded in here is provider-specific knowledge StreamController itself
        // must not know about — a YouTube destination's lifecycle being in a terminal phase, or
        // having already seen an auth-class failure (a revoked OAuth grant won't fix itself by
        // retrying). Absent lifecycle (CustomRtmpProvider — no broadcast/lifecycle concept at
        // all) means no provider-side veto; reconnect is then gated purely on uptime/crash-loop.
        reconnectPolicy: createReconnectPolicy({
          isRetryableDestination: () => {
            if (!session.lifecycle) return true;
            const phase = session.lifecycle.phase();
            if (phase === 'error' || phase === 'complete') return false;
            if (session.lifecycle.isAuthError?.()) return false;
            return true;
          },
        }),
        onError: (exitCode) => {
          // Previously silent — an operator watching a real dropped stream (e.g. the RTMP
          // connection itself breaking) had nothing in the app's own logs saying this happened at
          // all, only ffmpeg's raw, unattributed, untimestamped stderr to reverse-engineer it from.
          console.error(
            `[${new Date().toISOString()}] destination ${destinationId}: persistent encoder exited unexpectedly (code=${exitCode}), tearing down and finalizing lifecycle`,
          );
          const entry = this.lifecycles.get(destinationId);
          this.lifecycles.delete(destinationId);
          entry?.lifecycle.finalize().catch((err) => {
            console.error('failed to finalize destination lifecycle after an unexpected pusher exit', err);
          });
        },
        onStatusChanged: () => {
          this.emit('statusChanged', destinationId);
        },
      });

      this.controllers.set(destinationId, controller);
      try {
        await controller.start();
      } catch (err) {
        this.controllers.delete(destinationId);
        if (session.lifecycle) {
          await session.lifecycle.finalize().catch((finalizeErr) => {
            console.error('failed to finalize destination lifecycle after a failed start()', finalizeErr);
          });
        }
        throw err;
      }

      if (session.lifecycle) {
        this.lifecycles.set(destinationId, { providerType: destination.provider, lifecycle: session.lifecycle });
        session.lifecycle.onPhaseChange?.(() => {
          const phase = session.lifecycle!.phase();
          // A terminal phase (the health-check timeout, or an auth-class failure short-
          // circuiting it — see youtubeProvider.ts) means the destination's YouTube side is
          // confirmed dead: the local StreamController must actually stop instead of continuing
          // to push to a dead ingest forever (previously it just sat there until a human called
          // /stream/stop), and must NOT attempt to reconnect against it — the reconnectPolicy
          // above already refuses to retry once phase is terminal, but the controller itself
          // also needs to be torn down since nothing else will stop a still-alive local pipeline.
          if (phase === 'error' || phase === 'complete') {
            // Guard against acting on a DIFFERENT, newer session for this same destinationId —
            // a manual restart could have already replaced both map entries by the time this
            // (async) phase-change callback fires. Same stale-async-result hazard as the onError
            // hook above (see CLAUDE.md's "Known follow-ups"); closing over `controller`/
            // `session.lifecycle` from this start() call and comparing against the CURRENT map
            // entries avoids introducing a new instance of it here.
            if (this.controllers.get(destinationId) === controller) {
              if (controller.status().state !== 'idle') controller.stop();
              this.controllers.delete(destinationId);
            }
            if (this.lifecycles.get(destinationId)?.lifecycle === session.lifecycle) {
              this.lifecycles.delete(destinationId);
            }
          }
          this.emit('statusChanged', destinationId);
        });
        session.lifecycle.onPushStarted();
      }
    } finally {
      this.starting.delete(destinationId);
    }
  }

  async stop(destinationId: string): Promise<void> {
    this.requireController(destinationId).stop();
    this.controllers.delete(destinationId);
    const entry = this.lifecycles.get(destinationId);
    this.lifecycles.delete(destinationId);
    if (entry) {
      await entry.lifecycle.finalize().catch((err) => {
        console.error('failed to finalize destination lifecycle on stop', err);
      });
    }
  }

  pause(destinationId: string): void {
    this.requireController(destinationId).pause();
  }

  async resume(destinationId: string): Promise<void> {
    return this.requireController(destinationId).resume();
  }

  async next(destinationId: string): Promise<void> {
    return this.requireController(destinationId).next();
  }

  async previous(destinationId: string): Promise<void> {
    return this.requireController(destinationId).previous();
  }

  playByName(destinationId: string, name: string): void {
    this.requireController(destinationId).playByName(name);
  }

  status(destinationId: string): DestinationStreamStatus {
    const controller = this.controllers.get(destinationId);
    const base: StreamStatus = controller ? controller.status() : { state: 'idle', currentTrack: null, nextTrack: null };
    const entry = this.lifecycles.get(destinationId);
    if (!entry) return base;
    return {
      ...base,
      provider: { type: entry.providerType, phase: entry.lifecycle.phase(), watchUrl: entry.lifecycle.watchUrl() },
    };
  }

  private requireController(destinationId: string): StreamController {
    const controller = this.controllers.get(destinationId);
    if (!controller) throw new ApiError(409, 'stream is not active');
    return controller;
  }
}
