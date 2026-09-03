export interface TimerElementPosition {
  x: number;
  y: number;
  fontSize: number;
  color: string;
}

export interface NowPlayingOverlay {
  durationSeconds: number;
  // The rendered picture (cover/title/playlist, per the selected template) for this segment —
  // SegmentFeeder writes it to a fixed on-disk path and composites it via ffmpeg's own `overlay`
  // filter, replacing the hand-built drawtext filter graph this used to be.
  overlayPng: Buffer;
  // Position/style for the template's timer element, if it has one — null if not. Unlike
  // overlayPng, this isn't baked into a picture: SegmentFeeder turns it into a native ffmpeg
  // drawtext (ticking live on a track segment, frozen on a pause segment).
  timer: TimerElementPosition | null;
}

// A fully-composed drawtext overlay: position/style plus the already-built `text` (either a
// live `%{pts\:hms:OFFSET}` expression for a playing track, or a static frozen string for a
// pause segment) — segmentArgs.ts just plugs it into the filter graph, it doesn't need to know
// which case produced it. See SegmentFeeder.feedTrack()/feedPause().
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
