import { TextStyle } from '../templates/templateTypes';
import { resolveFontFile } from '../render/fontRegistry';

export interface TimerElementPosition {
  x: number;
  y: number;
  fontSize: number;
  color: string;
  style: TextStyle;
}

export interface NowPlayingOverlay {
  durationSeconds: number;
  // The rendered picture (cover/title/playlist, per the selected template) for this segment —
  // CanvasFeeder writes it to a fixed on-disk path before each one-shot canvas-frame render and
  // composites it via ffmpeg's own `overlay` filter, replacing the hand-built drawtext filter
  // graph this used to be.
  overlayPng: Buffer;
  // The second canvas layer, present only for a template whose baked elements straddle its first
  // animated-gif element (see CanvasPlacement in persistentEncoderArgs.ts): `overlayPng` then
  // holds only the elements listed BEFORE that gif and is composited under every gif, while this
  // holds the ones listed after it and is composited over them. Absent for every other template,
  // which keeps rendering as one flat layer exactly as before.
  overlayPngAbove?: Buffer;
  // Position/style for the template's timer element, if it has one — null if not. Unlike
  // overlayPng, this isn't baked into a picture: it becomes a native ffmpeg drawtext, given
  // its `text` as an already-formatted plain string (see TimerOverlay below).
  timer: TimerElementPosition | null;
}

// A fully-composed drawtext overlay: position/style plus the already-built `text`. Always a
// plain, already-formatted string — StreamController.timerText() computes it (ticking elapsed
// time for a playing track, frozen for a pause segment) and CanvasFeeder passes it through as-
// is; there's no live pts-expression any more, since there's no continuous per-track encode
// process for one to run against — segmentArgs.ts just plugs the finished string into the
// filter graph, it doesn't need to know which case produced it.
export interface TimerOverlay extends TimerElementPosition {
  text: string;
}

function overlayFilterComplex(width: number, height: number, fontFile: string, timer: TimerOverlay | null): string {
  // format=yuva420p keeps this frame's real per-pixel transparency (from the Satori/resvg-
  // rendered overlay PNG) all the way out to raw stdout — see buildCanvasFrameArgs's doc comment
  // for why: PersistentEncoder's own filter graph now composites the background image and any
  // animated-gif elements BELOW this canvas, and relies on this alpha to let them show through
  // wherever nothing is drawn (and be correctly hidden behind an opaque cover/title/playlist).
  if (!timer) {
    return `[0:v]scale=${width}:${height},format=yuva420p[outv]`;
  }
  const base = `[0:v]scale=${width}:${height},format=yuva420p[base]`;
  const fontfile = resolveFontFile(timer.style.fontFamily, timer.style.bold, timer.style.italic);
  // Escape colons in the text value for ffmpeg drawtext filter syntax
  const escapedText = timer.text.replace(/:/g, '\\:');
  let drawtext = `[base]drawtext=fontfile=${fontfile}:text='${escapedText}':x=${timer.x}:y=${timer.y}:fontsize=${timer.fontSize}:fontcolor=${timer.color}`;
  if (timer.style.stroke) {
    drawtext += `:borderw=${timer.style.stroke.width}:bordercolor=${timer.style.stroke.color}`;
  }
  if (timer.style.shadow) {
    drawtext += `:shadowx=${timer.style.shadow.offsetX}:shadowy=${timer.style.shadow.offsetY}:shadowcolor=${timer.style.shadow.color}`;
  }
  drawtext += '[outv]';
  return `${base};${drawtext}`;
}

// A single still frame of JUST the Satori/resvg-rendered overlay PNG (cover/title/playlist/etc,
// with real transparency preserved), optional drawtext layered on top — rendered once and handed
// back as raw YUVA420p bytes on stdout. The background image is NOT composited here any more
// (that moved to PersistentEncoder's own filter graph, alongside any animated-gif elements —
// see buildPersistentEncoderArgs) precisely so this frame's transparency survives into the raw
// bytes CanvasFeeder writes to pipe:3, instead of being flattened onto an opaque background before
// it ever reaches the persistent encoder. Used by CanvasFeeder (see canvasFeeder.ts) both on an
// actual content change (track switch, pause/resume, a timer tick) and never on any other cadence
// — CanvasFeeder itself is what resends the same rendered frame on a fixed heartbeat between
// renders, this function only ever produces ONE new frame per call.
export function buildCanvasFrameArgs(params: {
  overlayPngPath: string;
  fontFile: string;
  timer?: TimerOverlay | null;
  width: number;
  height: number;
}): string[] {
  const { overlayPngPath, fontFile, width, height } = params;
  return [
    '-y',
    '-i', overlayPngPath,
    '-filter_complex', overlayFilterComplex(width, height, fontFile, params.timer ?? null),
    '-map', '[outv]',
    '-frames:v', '1',
    '-f', 'rawvideo',
    '-pix_fmt', 'yuva420p',
    '-',
  ];
}
