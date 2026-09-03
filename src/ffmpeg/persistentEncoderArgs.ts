export function buildPersistentEncoderArgs(params: {
  width: number;
  height: number;
  fps: number;
  // The rate CanvasFeeder actually writes new/resent frames at (its heartbeat interval) — this
  // must match CanvasFeeder's real wall-clock write cadence exactly, or ffmpeg's synthesized PTS
  // (frame count / this declared rate) drifts from real elapsed time. See CanvasFeeder.
  heartbeatFps: number;
  rtmpUrl: string;
  streamKey: string;
}): string[] {
  const { width, height, fps, heartbeatFps, rtmpUrl, streamKey } = params;
  return [
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${width}x${height}`, '-r', String(heartbeatFps), '-i', 'pipe:3',
    // -re paces audio consumption to real time, which backpressures AudioRelay's decode-only
    // process through the pipe's bounded OS buffer — the same relationship -re had with the whole
    // FIFO in the earlier per-segment pipeline's pusher, just narrowed to the audio leg
    // specifically now that video timing is independently governed by CanvasFeeder's own
    // heartbeat.
    '-re', '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:4',
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', String(fps), '-g', String(fps * 2),
    '-c:a', 'aac', '-b:a', '192k',
    '-f', 'flv', `${rtmpUrl}/${streamKey}`,
  ];
}
