import { VideoParams } from './types';
import { escapeDrawtext, formatDuration } from './overlayText';

export interface NowPlayingOverlay {
  title: string;
  playlistLines: string[];
  durationSeconds: number;
}

export function buildTrackSegmentArgs(params: VideoParams & {
  audioPath: string;
  coverPath: string;
  backgroundPath: string;
  fontFile: string;
  overlay: NowPlayingOverlay;
  startOffsetSeconds?: number;
  outputTsOffsetSeconds?: number;
}): string[] {
  const { width, height, fps, audioPath, coverPath, backgroundPath, fontFile, overlay } = params;
  const coverSize = Math.round(height * 0.6);
  const panelX = coverSize + 80;
  const title = escapeDrawtext(overlay.title);
  const duration = escapeDrawtext(formatDuration(overlay.durationSeconds));
  const playlist = escapeDrawtext(overlay.playlistLines.join('\n'));

  const filterComplex = [
    `[1:v]scale=${coverSize}:${coverSize}[cover]`,
    `[0:v]scale=${width}:${height}[bg]`,
    `[bg][cover]overlay=40:40[bg1]`,
    `[bg1]drawtext=fontfile=${fontFile}:text='${title}':x=${panelX}:y=40:fontsize=42:fontcolor=white[bg2]`,
    `[bg2]drawtext=fontfile=${fontFile}:text='%{pts\\:hms} / ${duration}':x=${panelX}:y=100:fontsize=28:fontcolor=white[bg3]`,
    `[bg3]drawtext=fontfile=${fontFile}:text='${playlist}':x=${panelX}:y=160:fontsize=22:fontcolor=white:line_spacing=8[outv]`,
  ].join(';');

  const args = ['-loop', '1', '-i', backgroundPath, '-loop', '1', '-i', coverPath];

  if (params.startOffsetSeconds) {
    args.push('-ss', String(params.startOffsetSeconds));
  }

  args.push(
    '-i', audioPath,
    '-filter_complex', filterComplex,
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

export function buildPauseSegmentArgs(params: VideoParams & { backgroundPath: string; outputTsOffsetSeconds?: number }): string[] {
  const args = [
    '-loop', '1',
    '-i', params.backgroundPath,
    '-f', 'lavfi',
    '-i', 'anullsrc=r=44100:cl=stereo',
    '-c:v', 'libx264',
    '-tune', 'stillimage',
    '-c:a', 'aac',
    '-ar', '44100',
    '-ac', '2',
    '-pix_fmt', 'yuv420p',
    '-r', String(params.fps),
    '-g', String(params.fps * 2),
    '-vf', `scale=${params.width}:${params.height}`,
  ];
  if (params.outputTsOffsetSeconds) {
    args.push('-output_ts_offset', String(params.outputTsOffsetSeconds));
  }
  args.push('-f', 'mpegts', 'pipe:1');
  return args;
}
