import { posix as path } from 'path';
import { EventEmitter } from 'events';
import { PlaylistQueue } from '../playlist/queue';
import { Track } from '../playlist/types';
import { StreamController } from './streamController';
import { DestinationStreamStatus, StreamStatus } from './types';
import { CanvasFeeder } from '../ffmpeg/canvasFeeder';
import { AudioRelay } from '../ffmpeg/audioRelay';
import { PersistentEncoder } from '../ffmpeg/persistentEncoder';
import { PulseVisualizer } from '../ffmpeg/pulseVisualizer';
import { GifOverlayConfig } from '../ffmpeg/persistentEncoderArgs';
import { NowPlayingOverlay } from '../ffmpeg/segmentArgs';
import { getAudioDurationSeconds } from '../ffmpeg/duration';
import { getImageFrameCount } from '../ffmpeg/imageFrameCount';
import { buildPlaylistWindowLines } from '../ffmpeg/overlayText';
import { Spawner, PipeSpawner } from '../ffmpeg/types';
import { ApiError } from '../errors';
import { PlaylistRepository } from '../playlists/playlistRepository';
import { DestinationRepository } from '../destinations/destinationRepository';
import { TrackRepository, TrackOverlayOverride } from '../tracks/trackRepository';
import { TemplateRepository } from '../templates/templateRepository';
import { TemplateImageService, InvalidAssetIdError } from '../templates/templateImageService';
import { TemplateElement, TimerElement, EqualizerElement, DEFAULT_TEMPLATE_ELEMENTS } from '../templates/templateTypes';
import { renderTemplatePng } from '../render/renderOverlay';
import { BLANK_OVERLAY_PNG } from '../render/blankOverlay';
import { SessionOverlayCache } from './sessionOverlayCache';
import { BroadcastMeta, DestinationLifecycle, StreamDestinationProvider } from '../destinations/streamDestinationProvider';

// Also declared (as '1280x720'/'30fps'-shaped strings) in src/destinations/youtubeApiClient.ts's
// createStream — keep both in sync if this ever changes.
const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 720;
const VIDEO_FPS = 30;
// How often CanvasFeeder resends its last-rendered frame — see canvasFeeder.ts and
// persistentEncoderArgs.ts's heartbeatFps for why these two must always match.
const CANVAS_HEARTBEAT_MS = 200;
const CANVAS_HEARTBEAT_FPS = 1000 / CANVAS_HEARTBEAT_MS;
const PLAYLIST_WINDOW_BEFORE = 2;
const PLAYLIST_WINDOW_AFTER = 7;

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

export interface StreamManagerDeps {
  spawner: Spawner;
  pipeSpawner: PipeSpawner;
  fifoDir: string;
  defaultCoverPath: string;
  backgroundImagePath: string;
  fontFile: string;
  fontFamily: string;
  playlistRepository: Pick<PlaylistRepository, 'listTracks' | 'findById'>;
  destinationRepository: Pick<DestinationRepository, 'findById'>;
  trackRepository: Pick<TrackRepository, 'listByUser'>;
  templateRepository: Pick<TemplateRepository, 'findById'>;
  templateImageService: Pick<TemplateImageService, 'resolvePath' | 'resolveOriginalPath'>;
  providers: Record<string, StreamDestinationProvider>;
}

// Applies a track's overlayOverride.color to every title/text element's own color — playlist/
// timer/cover/image elements are left untouched. A missing/null override (or an override with
// no `color` set) is a no-op, leaving the template's own elements exactly as authored.
function applyOverlayOverride(elements: TemplateElement[], override: TrackOverlayOverride | null | undefined): TemplateElement[] {
  if (!override?.color) return elements;
  return elements.map((el) => ((el.type === 'title' || el.type === 'text') ? { ...el, color: override.color! } : el));
}

// Resolves every 'image' element's assetId to the on-disk PNG path renderTemplatePng needs to
// read (see TemplateImageService.resolvePath) — one entry per image element actually present.
function resolveImageAssets(
  elements: TemplateElement[],
  templateImageService: Pick<TemplateImageService, 'resolvePath'>,
  userId: string,
  templateId: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const el of elements) {
    if (el.type !== 'image') continue;
    // Defense in depth: isValidTemplateElement now constrains assetId's shape at save time, so
    // InvalidAssetIdError should be unreachable here — but a template saved BEFORE that
    // validation landed could still carry a malformed id. Skipping just that element keeps
    // renderTemplatePng's per-element black-rect fallback reachable; letting the throw escape
    // would instead blank the ENTIRE overlay (via buildOverlay's blank-overlay catch) for the
    // whole session.
    try {
      result[el.assetId] = templateImageService.resolvePath(userId, templateId, el.assetId);
    } catch (err) {
      if (!(err instanceof InvalidAssetIdError)) throw err;
      console.warn(`[stream] skipping template image element with invalid assetId: ${el.assetId}`);
    }
  }
  return result;
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
      if (state === 'error') {
        // An error-state controller's collaborators (CanvasFeeder's heartbeat, AudioRelay's
        // decode process) are still alive until torn down — stop() runs that teardown. Skipped
        // for 'idle' (already torn down; stop() would throw 409 for a non-active session).
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

      // The playlist must belong to the same user who owns the destination, otherwise
      // any user owning a destination could stream another user's private playlist.
      const playlist = await this.deps.playlistRepository.findById(playlistId);
      if (!playlist) throw new ApiError(404, 'playlist not found');
      if (playlist.userId !== destination.userId) throw new ApiError(403, 'not your playlist');

      // Same ownership rule as the playlist above. No templateId at all is valid — it just
      // means the built-in default layout is used instead of a user-authored one.
      let templateElements: TemplateElement[] = DEFAULT_TEMPLATE_ELEMENTS;
      if (options?.templateId) {
        const template = await this.deps.templateRepository.findById(options.templateId);
        if (!template) throw new ApiError(404, 'template not found');
        if (template.userId !== destination.userId) throw new ApiError(403, 'not your template');
        templateElements = template.elements as unknown as TemplateElement[];
      }

      const tracks: Track[] = await this.deps.playlistRepository.listTracks(playlistId);
      if (tracks.length === 0) throw new ApiError(409, 'playlist is empty');

      const allUserTracksRaw = await this.deps.trackRepository.listByUser(destination.userId);
      const allUserTracks: Track[] = allUserTracksRaw.map((t) => ({
        name: t.name, audioPath: t.audioPath, coverPath: t.coverPath,
        overlayOverride: t.overlayOverride as TrackOverlayOverride | null,
      }));

      const provider = this.deps.providers[destination.provider];
      if (!provider) throw new ApiError(400, `unsupported destination provider: ${destination.provider}`);
      const resolvedMeta: BroadcastMeta = {
        title: meta?.title ?? playlist.name,
        description: meta?.description,
        privacyStatus: meta?.privacyStatus,
        latencyPreference: meta?.latencyPreference,
      };
      const session = await provider.prepareSession(destination, resolvedMeta);

      const queue = new PlaylistQueue(tracks);
      const overlayImagePath = path.join(this.deps.fifoDir, `super-dj-overlay-${destinationId}.png`);

      const timerElement = templateElements.find((e): e is TimerElement => e.type === 'timer') ?? null;
      const equalizerElement = templateElements.find((e): e is EqualizerElement => e.type === 'equalizer') ?? null;

      // A multi-frame (animated) image can't be rendered by Satori/resvg — resvg decodes a GIF
      // to exactly one static frame, since SVG has no concept of an animated raster embed (see
      // GifOverlayConfig's doc comment in persistentEncoderArgs.ts). Detected once here, same
      // "fixed for the life of this session" treatment as timer/equalizer, and excluded from the
      // Satori bake below so it isn't rendered twice (once, wrongly, as a static Satori image;
      // once, correctly, as a native ffmpeg overlay).
      // Probed (and, if animated, played) from templateImageService.resolveOriginalPath() — NOT
      // resolvePath()'s `${assetId}.png`, which TemplateImageService.upload() already flattened
      // to a single frame via `ffmpeg -frames:v 1` at upload time. Probing/playing that flattened
      // copy would never find more than 1 frame no matter how the ffmpeg args below are built —
      // a real bug caught only by checking the actual file on disk against a real deployed
      // template, not by reasoning about the filter graph in isolation.
      const animatedImageAssetIds = new Set<string>();
      const gifOverlays: GifOverlayConfig[] = [];
      for (const el of templateElements) {
        if (el.type !== 'image') continue;
        const originalPath = await this.deps.templateImageService.resolveOriginalPath(destination.userId, options?.templateId ?? '', el.assetId);
        if (!originalPath) continue; // no original on disk (e.g. an asset uploaded before this existed) — stays static
        let frameCount: number;
        try {
          frameCount = await getImageFrameCount(originalPath);
        } catch (err) {
          console.warn(`[stream] failed to probe image element "${el.assetId}" for animation, treating as a static image`, err);
          continue;
        }
        if (frameCount > 1) {
          animatedImageAssetIds.add(el.assetId);
          gifOverlays.push({
            x: Math.round(el.x), y: Math.round(el.y),
            width: Math.round(el.width), height: Math.round(el.height),
            filePath: originalPath, frameCount,
          });
        }
      }

      // A timer isn't baked into the rendered PNG (see TimerElement's doc comment) — split it
      // out once here, since the template is fixed for the life of this session, rather than on
      // every buildOverlay() call.
      const bakedElements = templateElements.filter((e) =>
        e.type !== 'timer' && e.type !== 'equalizer' && !(e.type === 'image' && animatedImageAssetIds.has(e.assetId)),
      );

      const buildOverlay = async (track: Track): Promise<NowPlayingOverlay> => {
        const currentIndex = tracks.findIndex((t) => t.name === track.name);
        const playlistLines = buildPlaylistWindowLines(tracks, currentIndex, PLAYLIST_WINDOW_BEFORE, PLAYLIST_WINDOW_AFTER);
        const durationSeconds = await getAudioDurationSeconds(track.audioPath);

        const render = () => renderTemplatePng({
          elements: applyOverlayOverride(bakedElements, track.overlayOverride),
          title: track.name,
          playlistLines,
          coverPath: track.coverPath ?? this.deps.defaultCoverPath,
          width: VIDEO_WIDTH,
          height: VIDEO_HEIGHT,
          fontPath: this.deps.fontFile,
          fontFamily: this.deps.fontFamily,
          imageAssets: resolveImageAssets(bakedElements, this.deps.templateImageService, destination.userId, options?.templateId ?? ''),
          background: track.overlayOverride?.backgroundColor,
        });

        let overlayPng: Buffer;
        try {
          overlayPng = options?.overlayCache && options.sessionId
            ? await options.overlayCache.getOrRender(
              { sessionId: options.sessionId, trackName: track.name, templateId: options.templateId ?? null },
              render,
            )
            : await render();
        } catch (err) {
          // The RTMP connection staying up matters more than any one segment's picture — see
          // CLAUDE.md's overlay-templates notes. /templates/{id}/preview (an interactive,
          // synchronous request) deliberately does NOT catch the same failure; only the live
          // pipeline falls back silently.
          console.error('template render failed for a live segment, falling back to a blank overlay', err);
          overlayPng = BLANK_OVERLAY_PNG;
        }

        return {
          durationSeconds,
          overlayPng,
          timer: timerElement
            ? { x: timerElement.x, y: timerElement.y, fontSize: timerElement.fontSize, color: timerElement.color, style: timerElement.style }
            : null,
        };
      };

      const controller = new StreamController({
        library: {
          list: () => tracks,
          findByName: (name: string) => allUserTracks.find((t) => t.name === name),
        },
        queue,
        buildOverlay,
        createCanvasFeeder: () => new CanvasFeeder({
          spawner: this.deps.spawner,
          overlayImagePath,
          fontFile: this.deps.fontFile,
          width: VIDEO_WIDTH,
          height: VIDEO_HEIGHT,
          heartbeatMs: CANVAS_HEARTBEAT_MS,
        }),
        createAudioRelay: () => new AudioRelay({ spawner: this.deps.spawner }),
        createPersistentEncoder: () => new PersistentEncoder({
          spawner: this.deps.pipeSpawner,
          width: VIDEO_WIDTH,
          height: VIDEO_HEIGHT,
          fps: VIDEO_FPS,
          heartbeatFps: CANVAS_HEARTBEAT_FPS,
          rtmpUrl: session.rtmpUrl,
          streamKey: session.streamKey,
          backgroundPath: this.deps.backgroundImagePath,
          // Rounded to integers: PulseVisualizer's raw video pipe declares `-s <width>x<height>`
          // to ffmpeg, which (like the old showfreqs `s=` option before it) requires integer
          // dimensions and errors out (exit -22) on a fractional value — isValidSize doesn't
          // enforce that (see templateTypes.ts), so a saved template could still carry one.
          // x/y are rounded too for consistency, even though overlay's x/y accept fractional
          // expressions — an equalizer element's position/size should just always be whole
          // pixels.
          equalizer: equalizerElement
            ? {
                x: Math.round(equalizerElement.x), y: Math.round(equalizerElement.y),
                width: Math.round(equalizerElement.width), height: Math.round(equalizerElement.height),
              }
            : undefined,
          gifOverlays,
        }),
        createPulseVisualizer: equalizerElement
          ? () => new PulseVisualizer({
              width: Math.round(equalizerElement.width),
              height: Math.round(equalizerElement.height),
              fps: VIDEO_FPS,
              colors: equalizerElement.colors,
              glowLayers: equalizerElement.glowLayers,
              glowRadius: equalizerElement.glowRadius,
              coreWidth: equalizerElement.coreWidth,
            })
          : undefined,
        onError: () => {
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
        session.lifecycle.onPhaseChange?.(() => { this.emit('statusChanged', destinationId); });
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
