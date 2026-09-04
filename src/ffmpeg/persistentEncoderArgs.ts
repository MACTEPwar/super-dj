export interface EqualizerConfig {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

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
  equalizer?: EqualizerConfig;
}): string[] {
  const { width, height, fps, heartbeatFps, rtmpUrl, streamKey, equalizer } = params;
  const inputs = [
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${width}x${height}`, '-r', String(heartbeatFps), '-i', 'pipe:3',
    // -re paces audio consumption to real time, which backpressures AudioRelay's decode-only
    // process through the pipe's bounded OS buffer — the same relationship -re had with the whole
    // FIFO in the earlier per-segment pipeline's pusher, just narrowed to the audio leg
    // specifically now that video timing is independently governed by CanvasFeeder's own
    // heartbeat.
    '-re', '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:4',
  ];

  // Present only when the template actually has an equalizer element — every existing
  // template's args are completely unaffected. Splits the audio so the visualization branch
  // never touches what actually gets encoded as the stream's real audio; showfreqs draws a
  // transparent reactive spectrum (colorkey removes its own black background) which is then
  // overlaid on top of the already-composited canvas video. See the design spec for why this
  // is solid color / continuous-spectrum only for this MVP, and why it always renders above
  // every other element (it's composited after the canvas is already flattened, not part of
  // Satori's own element stacking).
  const mapping = equalizer
    ? [
        '-filter_complex',
        `[1:a]asplit=2[a_out][a_viz];` +
        `[a_viz]showfreqs=s=${equalizer.width}x${equalizer.height}:mode=bar:colors=${equalizer.color},format=yuva420p,colorkey=black:0.1:0.1[eq];` +
        `[0:v][eq]overlay=${equalizer.x}:${equalizer.y}[vout]`,
        '-map', '[vout]', '-map', '[a_out]',
      ]
    : ['-map', '0:v', '-map', '1:a'];

  return [
    ...inputs,
    ...mapping,
    // -preset ultrafast: without an explicit preset, libx264 defaults to "medium", which cannot
    // sustain real-time 1280x720@30fps encoding on a CPU-contended host (measured: ~0.29x
    // realtime speed under real multi-tenant load) -- the encoder falls further and further
    // behind real time the longer a session runs, since nothing here re-syncs it, which is what
    // produces a visibly growing lag between a next/previous command and when its audio/video
    // actually reaches the output. ultrafast measured ~0.9x+ and climbing under the same
    // contended conditions. The quality cost is a reasonable trade here since -tune stillimage
    // already signals near-static content (a composited overlay PNG, not real video motion).
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', String(fps), '-g', String(fps * 2),
    '-c:a', 'aac', '-b:a', '192k',
    '-f', 'flv', `${rtmpUrl}/${streamKey}`,
  ];
}
