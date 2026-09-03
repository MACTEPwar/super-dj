import { VideoParams } from './types';

export interface NowPlayingOverlay {
  durationSeconds: number;
  // The rendered picture (cover/title/playlist, per the selected template) for this segment —
  // SegmentFeeder writes it to a fixed on-disk path and composites it via ffmpeg's own `overlay`
  // filter, replacing the hand-built drawtext filter graph this used to be.
  overlayPng: Buffer;
}

function overlayFilterComplex(width: number, height: number): string {
  return [
    `[0:v]scale=${width}:${height}[bg]`,
    `[1:v]scale=${width}:${height}[ov]`,
    `[bg][ov]overlay=0:0[outv]`,
  ].join(';');
}

export function buildTrackSegmentArgs(params: VideoParams & {
  audioPath: string;
  backgroundPath: string;
  overlayPngPath: string;
  startOffsetSeconds?: number;
  outputTsOffsetSeconds?: number;
}): string[] {
  const { width, height, fps, audioPath, backgroundPath, overlayPngPath } = params;

  const args = ['-loop', '1', '-i', backgroundPath, '-loop', '1', '-i', overlayPngPath];

  if (params.startOffsetSeconds) {
    args.push('-ss', String(params.startOffsetSeconds));
  }

  args.push(
    '-i', audioPath,
    '-filter_complex', overlayFilterComplex(width, height),
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
// whether that path holds a "real" render or the fallback.
export function buildPauseSegmentArgs(params: VideoParams & {
  backgroundPath: string;
  overlayPngPath: string;
  outputTsOffsetSeconds?: number;
}): string[] {
  const { width, height, fps, backgroundPath, overlayPngPath } = params;

  const args = [
    '-loop', '1', '-i', backgroundPath,
    '-loop', '1', '-i', overlayPngPath,
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-filter_complex', overlayFilterComplex(width, height),
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
