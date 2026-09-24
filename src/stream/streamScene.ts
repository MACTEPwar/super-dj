import { posix as path } from 'path';
import { Track } from '../playlist/types';
import { CanvasFeeder } from '../ffmpeg/canvasFeeder';
import { AudioRelay } from '../ffmpeg/audioRelay';
import { PersistentEncoder } from '../ffmpeg/persistentEncoder';
import { PulseVisualizer } from '../ffmpeg/pulseVisualizer';
import { CanvasPlacement, GifOverlayConfig } from '../ffmpeg/persistentEncoderArgs';
import { NowPlayingOverlay } from '../ffmpeg/segmentArgs';
import { getAudioDurationSeconds } from '../ffmpeg/duration';
import { getImageFrameCount } from '../ffmpeg/imageFrameCount';
import { PlaylistWindowFeeder } from '../ffmpeg/playlistWindowFeeder';
import { Spawner, PipeSpawner } from '../ffmpeg/types';
import { computePlaylistWindowRegion } from '../render/playlistWindowGeometry';
import { WindowRow, windowRowLines, PLAYLIST_WINDOW_VISIBLE_ROWS } from '../playlist/window';
import { ApiError } from '../errors';
import { PlaylistRepository } from '../playlists/playlistRepository';
import { TrackRepository, TrackOverlayOverride } from '../tracks/trackRepository';
import { TemplateRepository } from '../templates/templateRepository';
import { TemplateImageService, InvalidAssetIdError } from '../templates/templateImageService';
import {
  TemplateElement, TimerElement, EqualizerElement, PlaylistElement, DEFAULT_TEMPLATE_ELEMENTS,
  normalizeEqualizerElement, globalPulseStrength,
} from '../templates/templateTypes';
import { renderTemplatePng } from '../render/renderOverlay';
import { BLANK_OVERLAY_PNG } from '../render/blankOverlay';
import { measureTextWidth } from '../render/textWidth';
import { measureRowHeight } from '../render/rowHeight';
import { MarqueeFeeder, MarqueeRowRect } from '../ffmpeg/marqueeFeeder';
import { LibraryLike } from './streamController';

// Also declared (as '1280x720'/'30fps'-shaped strings) in src/destinations/youtubeApiClient.ts's
// createStream — keep both in sync if this ever changes.
export const VIDEO_WIDTH = 1280;
export const VIDEO_HEIGHT = 720;
export const VIDEO_FPS = 30;
// How often CanvasFeeder resends its last-rendered frame — see canvasFeeder.ts and
// persistentEncoderArgs.ts's heartbeatFps for why these two must always match.
export const CANVAS_HEARTBEAT_MS = 200;
export const CANVAS_HEARTBEAT_FPS = 1000 / CANVAS_HEARTBEAT_MS;
export const PLAYLIST_WINDOW_FPS = VIDEO_FPS; // Task 10's measured fallback rule may lower this to 15

// Where the encoder pushes. Supplied by the caller because that is the ONE thing this module
// deliberately knows nothing about: LocalStreamManager passes a minted MediaMTX publish URL, and
// a DestinationForward pushes from MediaMTX rather than through here at all.
export interface RtmpTarget {
  rtmpUrl: string;
  streamKey: string;
}

export interface StreamSceneDeps {
  spawner: Spawner;
  pipeSpawner: PipeSpawner;
  fifoDir: string;
  defaultCoverPath: string;
  backgroundImagePath: string;
  fontFile: string;
  fontFamily: string;
  playlistRepository: Pick<PlaylistRepository, 'listTracks' | 'findById'>;
  trackRepository: Pick<TrackRepository, 'listByUser'>;
  templateRepository: Pick<TemplateRepository, 'findById'>;
  templateImageService: Pick<TemplateImageService, 'resolvePath' | 'resolveOriginalPath'>;
}

export interface BuildStreamSceneParams {
  // The owner every resource below must belong to.
  userId: string;
  playlistId: string;
  // Absent -> DEFAULT_TEMPLATE_ELEMENTS, not an error. See CLAUDE.md's overlay-templates notes.
  templateId?: string;
  // Namespaces this scene's on-disk overlay PNGs. The userId today — one pipeline per account —
  // which is all this needs to be.
  sceneId: string;
}

export interface StreamScene {
  playlistName: string;
  tracks: Track[];
  library: LibraryLike;
  // windowRows is PlaylistQueue.windowSnapshot() — the playlist element's lines. omitLivePlaylist
  // renders "variant A": the first playlist element left out, while the pipe:7 burst layer draws
  // it instead (see PlaylistWindowAnimator).
  buildOverlay: (track: Track, windowRows: WindowRow[], opts?: { omitLivePlaylist?: boolean; currentRowOverrideText?: string }) => Promise<NowPlayingOverlay>;
  createCanvasFeeder: () => CanvasFeeder;
  createAudioRelay: () => AudioRelay;
  createPersistentEncoder: (target: RtmpTarget) => PersistentEncoder;
  // These four are deliberately `T | undefined` rather than `field?:` — LocalStreamManager's own
  // forwarding of this object's fields into StreamControllerDeps had the identical `field?:` shape
  // once, and silently dropping two of them (a real bug found live on the demo stand — see
  // CLAUDE.md's marquee section) compiled clean and stalled the encoder in production. A required-
  // but-nullable key forces every future reader of THIS object (there is currently only one:
  // localStreamManager.ts) to make an explicit decision about each field, closing the same bug
  // class one layer up from where it was actually fixed.
  createPulseVisualizer: (() => PulseVisualizer) | undefined;
  // Present only when the template has an on-canvas playlist element (pipe:7 exists exactly then).
  createPlaylistWindowFeeder: (() => PlaylistWindowFeeder) | undefined;
  // Present only when the template has an on-canvas playlist element — same gate as
  // createPlaylistWindowFeeder.
  createMarqueeFeeder: (() => MarqueeFeeder) | undefined;
  // Given the current row's own rendered text (already prefixed "▶ ...") and its index within the
  // window, decides whether the NAME portion (marker stripped) overflows the space left after the
  // marker and, if so, the exact rect for just the name (starting right after the marker, so the
  // marker itself never scrolls and is never covered), the name text alone (what
  // MarqueeFeeder.activate() should render — NOT the marker), the measured name width, and the
  // marker text itself (what the caller should use as the baked row's override, so the marker
  // stays visibly baked while only the name scrolls live). Returns null when the name fits, or
  // when there's no room for it at all. Absent when the template has no playlist element.
  resolveMarqueeRow: ((currentRowText: string, rowIndex: number) => Promise<{ rect: MarqueeRowRect; nameText: string; textWidth: number; markerText: string } | null>) | undefined;
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

/**
 * Everything a stream needs that has no destination concept in it: which tracks play, what the
 * picture looks like, and how to build the three/four ffmpeg-facing collaborators. Originally
 * extracted out of the old, now-deleted per-destination stream manager's start() method (see
 * CLAUDE.md's "Overlay templates"/local-first notes), which used to interleave all of this with
 * provider lookup, prepareSession() and lifecycle wiring. LocalStreamManager.start() is the one
 * remaining caller.
 */
export async function buildStreamScene(deps: StreamSceneDeps, params: BuildStreamSceneParams): Promise<StreamScene> {
  const { userId, playlistId, templateId, sceneId } = params;

  const playlist = await deps.playlistRepository.findById(playlistId);
  if (!playlist) throw new ApiError(404, 'playlist not found');
  if (playlist.userId !== userId) throw new ApiError(403, 'not your playlist');

  // Same ownership rule as the playlist above. No templateId at all is valid — it just means the
  // built-in default layout is used instead of a user-authored one.
  let templateElements: TemplateElement[] = DEFAULT_TEMPLATE_ELEMENTS;
  if (templateId) {
    const template = await deps.templateRepository.findById(templateId);
    if (!template) throw new ApiError(404, 'template not found');
    if (template.userId !== userId) throw new ApiError(403, 'not your template');
    templateElements = template.elements as unknown as TemplateElement[];
  }

  const tracks: Track[] = await deps.playlistRepository.listTracks(playlistId);
  if (tracks.length === 0) throw new ApiError(409, 'playlist is empty');

  const allUserTracksRaw = await deps.trackRepository.listByUser(userId);
  const allUserTracks: Track[] = allUserTracksRaw.map((t) => ({
    name: t.name, audioPath: t.audioPath, coverPath: t.coverPath,
    overlayOverride: t.overlayOverride as TrackOverlayOverride | null,
  }));

  const overlayImagePath = path.join(deps.fifoDir, `super-dj-overlay-${sceneId}.png`);

  const timerElement = templateElements.find((e): e is TimerElement => e.type === 'timer') ?? null;
  const rawEqualizerElement = templateElements.find((e): e is EqualizerElement => e.type === 'equalizer') ?? null;
  // A template saved before colors[]/glowLayers/glowRadius/coreWidth existed can still carry the
  // old {color: string} shape in the database — nothing re-validates a stored template's elements
  // on read, only on write. Used as-is this crashes the whole process on the element's first
  // render tick; normalizeEqualizerElement patches in the default style (or drops the element)
  // instead. See its own doc comment in templateTypes.ts.
  const equalizerElement = rawEqualizerElement ? normalizeEqualizerElement(rawEqualizerElement) : null;

  // A multi-frame (animated) image can't be rendered by Satori/resvg — resvg decodes a GIF to
  // exactly one static frame, since SVG has no concept of an animated raster embed (see
  // GifOverlayConfig's doc comment in persistentEncoderArgs.ts). Detected once here, same "fixed
  // for the life of this session" treatment as timer/equalizer, and excluded from the Satori bake
  // below so it isn't rendered twice (once, wrongly, as a static Satori image; once, correctly, as
  // a native ffmpeg overlay).
  // Probed (and, if animated, played) from templateImageService.resolveOriginalPath() — NOT
  // resolvePath()'s `${assetId}.png`, which TemplateImageService.upload() already flattened to a
  // single frame via `ffmpeg -frames:v 1` at upload time. Probing/playing that flattened copy
  // would never find more than 1 frame no matter how the ffmpeg args below are built — a real bug
  // caught only by checking the actual file on disk against a real deployed template, not by
  // reasoning about the filter graph in isolation.
  const animatedImageAssetIds = new Set<string>();
  const gifOverlays: GifOverlayConfig[] = [];
  for (const el of templateElements) {
    if (el.type !== 'image') continue;
    const originalPath = await deps.templateImageService.resolveOriginalPath(userId, templateId ?? '', el.assetId);
    if (!originalPath) continue; // no original on disk — stays static
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

  // A timer isn't baked into the rendered PNG (see TimerElement's doc comment) — split it out once
  // here, since the template is fixed for the life of this session, rather than on every
  // buildOverlay() call.
  const isBaked = (e: TemplateElement) =>
    e.type !== 'timer' && e.type !== 'equalizer' && !(e.type === 'image' && animatedImageAssetIds.has(e.assetId));

  // Every baked element is flattened into ONE picture by Satori, so the canvas can only be
  // composited as a whole — but the template's element order says which of those elements belong
  // behind a gif and which in front of it. Split them at the first gif's position: a full-frame
  // opaque element listed before a gif used to hide it completely, because the single canvas was
  // always composited on top of every gif (reproduced against a real ffmpeg binary: zero
  // frame-to-frame change in the gif's region). See CanvasPlacement.
  //
  // Note this is a two-layer approximation, not a full per-element z-order: with gifs on both
  // sides of a baked element (e.g. [a, gif1, b, gif2]), `b` lands above BOTH gifs rather than
  // between them. Every element still ends up on the correct side of the FIRST gif, which is what
  // the reported bug is about; a full interleave would mean one Satori render and one pipe per gif.
  const firstGifIndex = templateElements.findIndex((e) => e.type === 'image' && animatedImageAssetIds.has(e.assetId));
  const hasGifs = gifOverlays.length > 0;
  const belowElements = hasGifs ? templateElements.slice(0, firstGifIndex).filter(isBaked) : templateElements.filter(isBaked);
  const aboveElements = hasGifs ? templateElements.slice(firstGifIndex + 1).filter(isBaked) : [];
  // The timer is a native drawtext rather than part of either baked picture, and has always
  // rendered above everything else — so it needs an upper layer to sit on even when no baked
  // element does, instead of being drawn under a gif that could then cover it.
  const splitCanvas = hasGifs && (aboveElements.length > 0 || timerElement !== null);
  // With gifs present the canvas is never pinned on top: a track's own overlayOverride background
  // is the bottom-most thing in the scene and has to be able to go UNDER them, and whether any
  // given track carries one isn't knowable when the encoder's args are built.
  const canvasPlacement: CanvasPlacement = !hasGifs ? 'top' : splitCanvas ? 'split' : 'bottom';
  const aboveOverlayImagePath = splitCanvas
    ? path.join(deps.fifoDir, `super-dj-overlay-above-${sceneId}.png`)
    : undefined;

  // The FIRST playlist element gets a burst layer (pipe:7) for insert animations. It stays BAKED
  // in the canvas like before — the layer is transparent except during a burst (see
  // PlaylistWindowAnimator). Later playlist elements (rare) are only ever baked. The layer sits
  // directly above whichever canvas layer the element is baked into.
  const livePlaylistElement = templateElements.find((e): e is PlaylistElement => e.type === 'playlist') ?? null;
  const livePlaylistRegion = livePlaylistElement
    ? computePlaylistWindowRegion(livePlaylistElement, { width: VIDEO_WIDTH, height: VIDEO_HEIGHT }, PLAYLIST_WINDOW_VISIBLE_ROWS)
    : null;
  const livePlaylist = livePlaylistElement && livePlaylistRegion
    ? {
        element: livePlaylistElement,
        region: livePlaylistRegion,
        layer: (canvasPlacement !== 'top' && belowElements.includes(livePlaylistElement) ? 'below' : 'top') as 'below' | 'top',
      }
    : null;

  // PlaylistQueue.windowSnapshot() always prefixes the current row with exactly this 2-character
  // marker (queue.ts: `▶ ${name}`, not itself an exported constant there — matching that file's
  // own convention of not extracting one). Pinned here as a named length, not a silent
  // `.slice(0, 2)`, so the coupling is visible if that prefix ever changes.
  const CURRENT_ROW_MARKER_LENGTH = 2; // '▶' + ' '

  const resolveMarqueeRow = livePlaylist
    ? async (
        currentRowText: string,
        rowIndex: number,
      ): Promise<{ rect: MarqueeRowRect; nameText: string; textWidth: number; markerText: string } | null> => {
        const el = livePlaylist.element;
        const markerText = currentRowText.slice(0, CURRENT_ROW_MARKER_LENGTH);
        const nameText = currentRowText.slice(CURRENT_ROW_MARKER_LENGTH);
        const markerWidth = await measureTextWidth(markerText, el.style.fontFamily, el.style.bold, el.style.italic, el.fontSize);
        // No room for any scrolling text at all — fall back to the plain, already-ellipsis-
        // truncated full row (no marquee), rather than a marquee rect with zero or negative width.
        if (markerWidth >= el.width) return null;
        const nameWidth = await measureTextWidth(nameText, el.style.fontFamily, el.style.bold, el.style.italic, el.fontSize);
        if (nameWidth <= el.width - markerWidth) return null;
        const rowHeight = await measureRowHeight(el);
        const rect: MarqueeRowRect = { x: el.x + markerWidth, y: el.y + rowIndex * rowHeight, width: el.width - markerWidth, height: rowHeight };
        // Defense in depth: computePlaylistWindowRegion clamps pipe:8's own region to the canvas,
        // but a rowIndex far enough down (a playlist element near the canvas bottom) could still
        // push this rect outside that region. blitYuva420p has no bounds check of its own — an
        // out-of-range y here would write into the wrong plane offsets and corrupt the frame
        // rather than fail cleanly, so skip the marquee entirely rather than risk that.
        const region = livePlaylist.region;
        const fitsRegion = rect.x >= region.x && rect.y >= region.y
          && rect.x + rect.width <= region.x + region.width
          && rect.y + rect.height <= region.y + region.height;
        if (!fitsRegion) return null;
        return { rect, nameText, textWidth: nameWidth, markerText };
      }
    : undefined;

  const buildOverlay = async (
    track: Track,
    windowRows: WindowRow[],
    opts: { omitLivePlaylist?: boolean; currentRowOverrideText?: string } = {},
  ): Promise<NowPlayingOverlay> => {
    // The rows come from PlaylistQueue.windowSnapshot() — queued (inserted) tracks included, and
    // an inserted current track anchored where the base playlist will pick back up.
    const effectiveRows = opts.currentRowOverrideText !== undefined
      ? windowRows.map((r) => (r.isCurrent ? { ...r, text: opts.currentRowOverrideText! } : r))
      : windowRows;
    const playlistLines = windowRowLines(effectiveRows);
    const durationSeconds = await getAudioDurationSeconds(track.audioPath);

    const renderLayer = (elements: TemplateElement[], layer: 'below' | 'above') => {
      // Variant A: identity-filter exactly the live element, so a second playlist element (or
      // anything else) stays baked. Without omitLivePlaylist this is the original element list.
      const shown = opts.omitLivePlaylist && livePlaylist ? elements.filter((e) => e !== livePlaylist.element) : elements;
      return renderTemplatePng({
        elements: applyOverlayOverride(shown, track.overlayOverride),
        title: track.name,
        playlistLines,
        coverPath: track.coverPath ?? deps.defaultCoverPath,
        width: VIDEO_WIDTH,
        height: VIDEO_HEIGHT,
        fontPath: deps.fontFile,
        fontFamily: deps.fontFamily,
        imageAssets: resolveImageAssets(shown, deps.templateImageService, userId, templateId ?? ''),
        // The track's own background override is the bottom-most thing in the scene, so it only ever
        // belongs on the lower layer — painted on the upper one it would cover every gif.
        background: layer === 'below' ? track.overlayOverride?.backgroundColor : undefined,
      });
    };

    let overlayPng: Buffer;
    let overlayPngAbove: Buffer | undefined;
    try {
      [overlayPng, overlayPngAbove] = await Promise.all([
        renderLayer(belowElements, 'below'),
        splitCanvas ? renderLayer(aboveElements, 'above') : Promise.resolve(undefined),
      ]);
    } catch (err) {
      // The RTMP connection staying up matters more than any one segment's picture — see
      // CLAUDE.md's overlay-templates notes. /templates/{id}/preview (an interactive, synchronous
      // request) deliberately does NOT catch the same failure. Both layers go blank together: a
      // declared canvas pipe that never receives a frame would stall the encoder's whole filter
      // graph, so the upper layer always gets SOMETHING when the template has one.
      console.error('template render failed for a live segment, falling back to a blank overlay', err);
      overlayPng = BLANK_OVERLAY_PNG;
      overlayPngAbove = splitCanvas ? BLANK_OVERLAY_PNG : undefined;
    }

    return {
      durationSeconds,
      overlayPng,
      overlayPngAbove,
      timer: timerElement
        ? { x: timerElement.x, y: timerElement.y, fontSize: timerElement.fontSize, color: timerElement.color, style: timerElement.style }
        : null,
    };
  };

  return {
    playlistName: playlist.name,
    tracks,
    library: {
      list: () => tracks,
      findByName: (name: string) => allUserTracks.find((t) => t.name === name),
    },
    buildOverlay,
    createCanvasFeeder: () => new CanvasFeeder({
      spawner: deps.spawner,
      overlayImagePath,
      aboveOverlayImagePath,
      fontFile: deps.fontFile,
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      heartbeatMs: CANVAS_HEARTBEAT_MS,
    }),
    createAudioRelay: () => new AudioRelay({ spawner: deps.spawner }),
    createPersistentEncoder: (target: RtmpTarget) => new PersistentEncoder({
      spawner: deps.pipeSpawner,
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      fps: VIDEO_FPS,
      heartbeatFps: CANVAS_HEARTBEAT_FPS,
      rtmpUrl: target.rtmpUrl,
      streamKey: target.streamKey,
      backgroundPath: deps.backgroundImagePath,
      // Rounded to integers: PulseVisualizer's raw video pipe declares `-s <width>x<height>` to
      // ffmpeg, which (like the old showfreqs `s=` option before it) requires integer dimensions
      // and errors out (exit -22) on a fractional value — isValidSize doesn't enforce that (see
      // templateTypes.ts), so a saved template could still carry one. x/y are rounded too for
      // consistency, even though overlay's x/y accept fractional expressions — an equalizer
      // element's position/size should just always be whole pixels.
      equalizer: equalizerElement
        ? {
            x: Math.round(equalizerElement.x), y: Math.round(equalizerElement.y),
            width: Math.round(equalizerElement.width), height: Math.round(equalizerElement.height),
          }
        : undefined,
      gifOverlays,
      canvasPlacement,
      playlistWindow: livePlaylist
        ? {
            x: livePlaylist.region.x, y: livePlaylist.region.y,
            width: livePlaylist.region.width, height: livePlaylist.region.height,
            fps: PLAYLIST_WINDOW_FPS, layer: livePlaylist.layer,
          }
        : undefined,
      marquee: livePlaylist
        ? { x: livePlaylist.region.x, y: livePlaylist.region.y, width: livePlaylist.region.width, height: livePlaylist.region.height, fps: PLAYLIST_WINDOW_FPS }
        : undefined,
    }),
    createPlaylistWindowFeeder: livePlaylist
      ? () => new PlaylistWindowFeeder({ element: livePlaylist.element, region: livePlaylist.region, fps: PLAYLIST_WINDOW_FPS })
      : undefined,
    createMarqueeFeeder: livePlaylist
      ? () => new MarqueeFeeder({ element: livePlaylist.element, region: livePlaylist.region, fps: PLAYLIST_WINDOW_FPS })
      : undefined,
    resolveMarqueeRow,
    createPulseVisualizer: equalizerElement
      ? () => new PulseVisualizer({
          width: Math.round(equalizerElement.width),
          height: Math.round(equalizerElement.height),
          fps: VIDEO_FPS,
          colors: equalizerElement.colors,
          glowLayers: equalizerElement.glowLayers,
          glowRadius: equalizerElement.glowRadius,
          coreWidth: equalizerElement.coreWidth,
          sensitivity: equalizerElement.sensitivity,
          smoothing: equalizerElement.smoothing,
          beatBoost: equalizerElement.beatBoost,
          bandCount: equalizerElement.bandCount,
          // The template field is a 0-20 knob; the engine wants its own strength scale.
          globalPulse: globalPulseStrength(equalizerElement.globalPulse),
        })
      : undefined,
  };
}
