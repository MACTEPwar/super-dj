export interface TimerElementPosition {
  x: number;
  y: number;
  fontSize: number;
  color: string;
}

export interface NowPlayingOverlay {
  durationSeconds: number;
  // The rendered picture (cover/title/playlist, per the selected template) for this segment —
  // CanvasFeeder writes it to a fixed on-disk path before each one-shot canvas-frame render and
  // composites it via ffmpeg's own `overlay` filter, replacing the hand-built drawtext filter
  // graph this used to be.
  overlayPng: Buffer;
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
  const parts = [
    `[0:v]scale=${width}:${height}[bg]`,
    `[1:v]scale=${width}:${height}[ov]`,
  ];
  if (!timer) {
    parts.push('[bg][ov]overlay=0:0[outv]');
    return parts.join(';');
  }
  parts.push('[bg][ov]overlay=0:0[base]');
  parts.push(`[base]drawtext=fontfile=${fontFile}:text='${timer.text}':x=${timer.x}:y=${timer.y}:fontsize=${timer.fontSize}:fontcolor=${timer.color}[outv]`);
  return parts.join(';');
}

// A single still frame — background + overlay PNG composited, optional drawtext layered on top —
// rendered once and handed back as raw YUV420p bytes on stdout. Used by CanvasFeeder (see
// canvasFeeder.ts) both on an actual content change (track switch, pause/resume, a timer tick)
// and never on any other cadence — CanvasFeeder itself is what resends the same rendered frame on
// a fixed heartbeat between renders, this function only ever produces ONE new frame per call.
export function buildCanvasFrameArgs(params: {
  backgroundPath: string;
  overlayPngPath: string;
  fontFile: string;
  timer?: TimerOverlay | null;
  width: number;
  height: number;
}): string[] {
  const { backgroundPath, overlayPngPath, fontFile, width, height } = params;
  return [
    '-y',
    '-i', backgroundPath,
    '-i', overlayPngPath,
    '-filter_complex', overlayFilterComplex(width, height, fontFile, params.timer ?? null),
    '-map', '[outv]',
    '-frames:v', '1',
    '-f', 'rawvideo',
    '-pix_fmt', 'yuv420p',
    '-',
  ];
}
