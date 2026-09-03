import { VideoParams } from './types';

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

export function buildTrackSegmentArgs(params: VideoParams & {
  audioPath: string;
  backgroundPath: string;
  overlayPngPath: string;
  fontFile: string;
  timer?: TimerOverlay | null;
  startOffsetSeconds?: number;
  // Bounds each output leg's length explicitly (see the -t comment below) — probed once up
  // front (ffprobe, via getAudioDurationSeconds) and threaded all the way through from
  // NowPlayingOverlay.durationSeconds.
  durationSeconds: number;
  videoFifoPath: string;
  audioFifoPath: string;
}): string[] {
  const { width, height, fps, audioPath, backgroundPath, overlayPngPath, fontFile, videoFifoPath, audioFifoPath } = params;

  const args = ['-y', '-loop', '1', '-i', backgroundPath, '-loop', '1', '-i', overlayPngPath];

  if (params.startOffsetSeconds) {
    args.push('-ss', String(params.startOffsetSeconds));
  }

  args.push('-i', audioPath, '-filter_complex', overlayFilterComplex(width, height, fontFile, params.timer ?? null));

  // Two independent raw elementary-stream outputs (see the Stage 2 design doc) instead of one
  // muxed MPEG-TS output, so -shortest can't be used to bound this segment's length the way it
  // used to — -shortest only compares streams muxed into the SAME output, and ffmpeg has
  // nothing to compare within either of these on its own. The video leg in particular is driven
  // by an infinite `-loop 1` background/overlay image and would never end on its own without an
  // explicit bound.
  const remainingSeconds = Math.max(0, params.durationSeconds - (params.startOffsetSeconds ?? 0));

  args.push(
    '-map', '[outv]',
    '-c:v', 'libx264',
    '-tune', 'stillimage',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-g', String(fps * 2),
    '-t', String(remainingSeconds),
    '-f', 'h264', videoFifoPath,
    '-map', '2:a',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '44100',
    '-ac', '2',
    '-t', String(remainingSeconds),
    '-f', 'adts', audioFifoPath,
  );

  return args;
}

// Pause segments are killed externally (next/resume/stop), never by hitting an encoded-length
// bound, so — unlike buildTrackSegmentArgs — neither output leg needs a -t here; both the
// looped image and anullsrc are already infinite sources that just run until SegmentFeeder
// kills this process.
export function buildPauseSegmentArgs(params: VideoParams & {
  backgroundPath: string;
  overlayPngPath: string;
  fontFile: string;
  timer?: TimerOverlay | null;
  videoFifoPath: string;
  audioFifoPath: string;
}): string[] {
  const { width, height, fps, backgroundPath, overlayPngPath, fontFile, videoFifoPath, audioFifoPath } = params;

  return [
    '-y',
    '-loop', '1', '-i', backgroundPath,
    '-loop', '1', '-i', overlayPngPath,
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-filter_complex', overlayFilterComplex(width, height, fontFile, params.timer ?? null),
    '-map', '[outv]',
    '-c:v', 'libx264',
    '-tune', 'stillimage',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-g', String(fps * 2),
    '-f', 'h264', videoFifoPath,
    '-map', '2:a',
    '-c:a', 'aac',
    '-ar', '44100',
    '-ac', '2',
    '-f', 'adts', audioFifoPath,
  ];
}
