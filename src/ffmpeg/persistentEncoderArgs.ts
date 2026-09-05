export interface EqualizerConfig {
  x: number;
  y: number;
  width: number;
  height: number;
}

// A single animated (multi-frame) image asset used by an 'image' template element. Composited
// natively by ffmpeg, exactly like the equalizer — resvg (the Satori-driven render path every
// other 'image' element uses) decodes a GIF to one static frame only, since SVG has no concept
// of an animated raster embed. See src/ffmpeg/imageFrameCount.ts for how `frameCount` is probed.
export interface GifOverlayConfig {
  x: number;
  y: number;
  width: number;
  height: number;
  filePath: string;
  frameCount: number;
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
  // Composited here, not by CanvasFeeder — see the [0:v] pix_fmt comment below for why this
  // moved out of CanvasFeeder's own one-shot render.
  backgroundPath: string;
  equalizer?: EqualizerConfig;
  gifOverlays?: GifOverlayConfig[];
}): string[] {
  const { width, height, fps, heartbeatFps, rtmpUrl, streamKey, backgroundPath, equalizer, gifOverlays = [] } = params;
  const pulseInputIndex = 3 + gifOverlays.length;
  const inputs = [
    // yuva420p, not yuv420p: this pipe used to carry an opaque frame (CanvasFeeder flattened the
    // background into it before every write), which meant nothing composited "under" [0:v] in
    // this filter graph could ever be visible. Giving it a real alpha channel — preserved end to
    // end from the Satori/resvg-rendered overlay PNG through segmentArgs.ts's own format=yuva420p
    // — is what lets the background image and any animated-gif elements below actually show
    // through wherever the canvas has nothing drawn, while still correctly hiding behind an
    // opaque cover/title/playlist where it does. Verified against a real ffmpeg binary: without
    // this, a full-frame background gif visibly hid title/playlist text that should render on
    // top of it, because both were fully opaque and stacked with the canvas UNDER the gif.
    '-f', 'rawvideo', '-pix_fmt', 'yuva420p', '-s', `${width}x${height}`, '-r', String(heartbeatFps), '-i', 'pipe:3',
    // -re paces audio consumption to real time, which backpressures AudioRelay's decode-only
    // process through the pipe's bounded OS buffer — the same relationship -re had with the whole
    // FIFO in the earlier per-segment pipeline's pusher, just narrowed to the audio leg
    // specifically now that video timing is independently governed by CanvasFeeder's own
    // heartbeat.
    '-re', '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:4',
    // -loop 1 replays this one still image for the life of the session — the same "always
    // available, never changes" role CanvasFeeder's own background compositing used to play,
    // just now as its own persistent input instead of being pre-flattened into pipe:3.
    '-loop', '1', '-r', String(fps), '-i', backgroundPath,
    // pipe:3 is input 0, pipe:4 is input 1, the looped background is input 2, so each gif file
    // becomes input 3, 4, 5... in array order — the filter graph below references these indices
    // directly.
    ...gifOverlays.flatMap((g) => ['-i', g.filePath]),
    // Present only when the template has an equalizer element — this is PulseVisualizer's own
    // continuously-fed pipe (raw RGBA straight-alpha, unpremultiplied in Node — see
    // PulseVisualizer/unpremultiply.ts and the design spec's alpha spike), not an ffmpeg-native
    // filter like the earlier showfreqs MVP. Placed last, after every gif input, so adding it
    // never renumbers the gif input indices above.
    ...(equalizer ? ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${equalizer.width}x${equalizer.height}`, '-r', String(fps), '-i', 'pipe:5'] : []),
  ];

  const filterLines: string[] = [
    `[2:v]scale=${width}:${height}[vbg]`,
    // overlay's output cadence follows its MAIN input's frame arrivals, and [0:v] only arrives at
    // heartbeatFps (CanvasFeeder resends/rerenders that often — plenty for mostly-static cover/
    // title/playlist content, but far too slow for a reactive spectrum or a looping gif
    // underneath it). Without this `fps=` stage, a fast-changing branch composited below the
    // canvas never actually reaches the encoder at its own real rate: overlay just recomputes
    // once per incoming main frame, so libx264 ends up emitting mostly duplicate frames —
    // visibly stepped/laggy motion. Verified against a real ffmpeg binary: dup=78 of 98 encoded
    // frames over a 3s clip without this stage, dup=0 with it. Cheap fix — `fps` duplicates
    // already-decoded frames inside the filter graph, no extra CanvasFeeder writes/renders.
    `[0:v]fps=${fps},format=yuva420p[vcanvas]`,
  ];
  let videoPad = 'vbg';

  // Each gif is composited onto the background, in template-element order, before the canvas is
  // laid on top of all of them — see the canvas-overlay stage below for why that order matters.
  gifOverlays.forEach((gif, i) => {
    const inputIndex = 3 + i;
    const gifPad = `gif${i}`;
    const nextPad = `vgif${i}`;
    filterLines.push(
      // `loop`'s own `size=<frameCount>` (a filter-graph-internal replay), not `-stream_loop`
      // on the input — verified against a real ffmpeg binary: `-stream_loop -1` on a gif input
      // left the whole composited output frozen on the gif's first frame indefinitely (the gif
      // demuxer doesn't reset cleanly on a stream-level loop), while `loop=` genuinely cycled
      // through every frame. `fps=` matches this branch to the same target rate as the canvas,
      // for the same duplicate-frame reason as the `[vcanvas]` stage above.
      `[${inputIndex}:v]loop=loop=-1:size=${gif.frameCount},fps=${fps},scale=${gif.width}:${gif.height}[${gifPad}]`,
    );
    filterLines.push(`[${videoPad}][${gifPad}]overlay=${gif.x}:${gif.y}[${nextPad}]`);
    videoPad = nextPad;
  });

  // The canvas (every Satori-baked element — cover/title/playlist/text/static image) always
  // composites on top of the background and every gif overlay, exactly like it did when Satori
  // was the only renderer and painted everything in one pass. Pulling an animated-gif element out
  // into its own native overlay branch must not change where the REST of the template's elements
  // land in the stack, or a full-frame background gif silently hides title/playlist text that
  // was meant to render above it — a real bug this fixes (verified against a real ffmpeg binary
  // and a real deployed template).
  filterLines.push(`[${videoPad}][vcanvas]overlay=0:0[vcanvas_top]`);
  videoPad = 'vcanvas_top';

  if (equalizer) {
    // format=yuva420p is the actual straight-alpha compositing conversion — the input is declared
    // 'rgba' (straight alpha, thanks to PulseVisualizer's unpremultiply step), and this is the
    // same conversion stage every other alpha-carrying branch in this graph already goes through
    // (compare [0:v]'s own format=yuva420p above).
    filterLines.push(`[${pulseInputIndex}:v]format=yuva420p[pulse]`);
    filterLines.push(`[${videoPad}][pulse]overlay=${equalizer.x}:${equalizer.y}[vout]`);
    videoPad = 'vout';
  }

  const mapping = ['-filter_complex', filterLines.join(';'), '-map', `[${videoPad}]`, '-map', '1:a'];

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
