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
  outputTsOffsetSeconds?: number;
}): string[] {
  const { width, height, fps, audioPath, backgroundPath, overlayPngPath, fontFile } = params;

  const args = ['-loop', '1', '-i', backgroundPath, '-loop', '1', '-i', overlayPngPath];

  if (params.startOffsetSeconds) {
    args.push('-ss', String(params.startOffsetSeconds));
  }

  args.push(
    '-i', audioPath,
    '-filter_complex', overlayFilterComplex(width, height, fontFile, params.timer ?? null),
    '-map', '[outv]',
    '-map', '2:a',
    '-c:v', 'libx264',
    '-tune', 'stillimage',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '44100',
    '-ac', '2',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-g', String(fps * 2),
    '-shortest',
  );
  // Every segment is its own ffmpeg process, so its muxer starts PTS/DTS back at ~0 by
  // default — but the pusher treats the FIFO as one continuous stream and paces it with
  // -re against real elapsed time since it started. Without carrying the running
  // session-elapsed offset forward into each new segment, every switch reintroduces a
  // PTS discontinuity: the pusher briefly free-runs (no real-time pacing) until the new
  // segment's timestamps catch back up, which is what shows up as a burst/stall and
  // decode artifacts right at the switch. See StreamController's elapsedSessionSeconds().
  if (params.outputTsOffsetSeconds) {
    args.push('-output_ts_offset', String(params.outputTsOffsetSeconds));
  }
  args.push('-f', 'mpegts', 'pipe:1');

  return args;
}

// Always takes an overlayPngPath, same as buildTrackSegmentArgs — SegmentFeeder resolves it to
// whichever picture is already on disk (the last playing track's, or the blank fallback if
// nothing has been rendered yet) before calling this, so pausing only ever changes the audio
// (silence instead of the track), never the overlay, and this function never needs to know
// whether that path holds a "real" render or the fallback. Same for `timer` — its `text` is
// already frozen (not a live pts expression) by the time it gets here.
export function buildPauseSegmentArgs(params: VideoParams & {
  backgroundPath: string;
  overlayPngPath: string;
  fontFile: string;
  timer?: TimerOverlay | null;
  outputTsOffsetSeconds?: number;
}): string[] {
  const { width, height, fps, backgroundPath, overlayPngPath, fontFile } = params;

  const args = [
    '-loop', '1', '-i', backgroundPath,
    '-loop', '1', '-i', overlayPngPath,
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-filter_complex', overlayFilterComplex(width, height, fontFile, params.timer ?? null),
    '-map', '[outv]',
    '-map', '2:a',
    '-c:v', 'libx264',
    '-tune', 'stillimage',
    '-c:a', 'aac',
    '-ar', '44100',
    '-ac', '2',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-g', String(fps * 2),
  ];
  if (params.outputTsOffsetSeconds) {
    args.push('-output_ts_offset', String(params.outputTsOffsetSeconds));
  }
  args.push('-f', 'mpegts', 'pipe:1');
  return args;
}
