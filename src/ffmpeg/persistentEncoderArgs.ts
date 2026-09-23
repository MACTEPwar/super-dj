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

// ffmpeg's `overlay` filter composites in yuv420 by default and silently rounds an odd x/y DOWN
// to the even chroma grid, displacing the WHOLE overlay one pixel up/left — verified against a
// real ffmpeg binary: a white box at overlay=141:501 lit rows 500 and 501 and left its own last
// row/column unpainted (odd width/height are handled fine; only the position matters). A gif
// element is opaque right up to its edge, so at an odd position its picture landed one row/column
// OUTSIDE its declared box. `format=rgb` makes the overlay composite in packed RGB, where there
// is no chroma grid and the placement is exact (verified: 0/255/255/0 on the rows and columns
// around the box). It's effectively free here — the main input at this point in the graph is the
// decoded background image, already RGB, so the one RGB->yuv420p conversion of the 1280x720
// chain simply moves from the first gif overlay to the canvas overlay below. (Measured on the
// pulse stage, whose main is already yuv420p, the same option costs ~0.85ms per frame — see the
// equalizer overlay below for why it doesn't need it.)
const GIF_OVERLAY_FORMAT = 'format=rgb';

/**
 * Where the Satori-baked canvas sits relative to the animated-gif overlays.
 *
 * Every non-gif element is baked into one flat PNG, so the canvas can only be composited as a
 * whole — but a template's element ORDER says which of those elements belong behind a gif and
 * which in front of it. buildStreamScene() (streamScene.ts) splits the baked elements around the
 * first gif element's position and picks the placement that reproduces that order:
 *
 * - `top` — the canvas goes over every gif. The only possibility when there are no gifs at all,
 *   and also correct when every baked element is listed after the first gif. This is exactly the
 *   single-layer graph that predates the split, byte for byte.
 * - `bottom` — the canvas goes under every gif, for a template whose baked elements are all
 *   listed before the first gif (e.g. just a full-frame background image with a gif over it).
 *   Still one canvas input; only the compositing order moves.
 * - `split` — baked elements exist on BOTH sides of the first gif, so there are two canvas
 *   layers: pipe:3 carries the below one, pipe:6 the above one, and the gifs composite between.
 *   This is the only placement that costs a second Satori render and a second pipe.
 *
 * Before this existed the canvas was always `top`, which meant a full-frame opaque element listed
 * BEFORE a gif hid it completely — verified against a real ffmpeg binary: zero frame-to-frame
 * change in the gif's region, at a flat luma matching the canvas's own background.
 */
export type CanvasPlacement = 'top' | 'bottom' | 'split';

// The playlist window's burst layer (PlaylistWindowFeeder, pipe:7) — transparent while idle, the
// insert animation during a burst. Composited directly above whichever baked canvas layer the
// template's playlist element is actually baked into, so its z-position relative to the gifs
// matches the settled window's own. `layer` says which of the two baked canvas layers that is:
// 'top' for the canvas that ends up on top ('vcanvas_top', or the only canvas when there's no
// split), 'below' for the below-canvas layer of a 'bottom'/'split' placement. See
// compositePlaylistWindow() below for how the two are reconciled with `canvasPlacement`.
export type PlaylistWindowLayerConfig = {
  x: number;
  y: number;
  width: number;
  height: number;
  fps: number;
  layer: 'below' | 'top';
};

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
  // Defaults to 'top' — the pre-split behaviour, and the only meaningful value with no gifs.
  canvasPlacement?: CanvasPlacement;
  // Present only when the resolved template has a playlist-window element — see
  // PlaylistWindowLayerConfig above.
  playlistWindow?: PlaylistWindowLayerConfig;
}): string[] {
  const { width, height, fps, heartbeatFps, rtmpUrl, streamKey, backgroundPath, equalizer, gifOverlays = [], canvasPlacement = 'top', playlistWindow } = params;
  const pulseInputIndex = 3 + gifOverlays.length;
  // Appended after the pulse input, not before it, so neither the gif input indices (3...) nor
  // pulseInputIndex above moves when a template gains a second canvas layer.
  const aboveCanvasInputIndex = pulseInputIndex + (equalizer ? 1 : 0);
  // Appended after the above-canvas input (present only for 'split'), so declaring the playlist
  // window's own burst layer never renumbers anything declared before it.
  const playlistWindowInputIndex = aboveCanvasInputIndex + (canvasPlacement === 'split' ? 1 : 0);
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
    // The second ("above") canvas layer, present only for a 'split' template — same declaration
    // as pipe:3 because it carries exactly the same kind of frame, produced by the same
    // CanvasFeeder on the same heartbeat. Last in the list for the same non-renumbering reason
    // the pulse input is placed after the gifs.
    ...(canvasPlacement === 'split'
      ? ['-f', 'rawvideo', '-pix_fmt', 'yuva420p', '-s', `${width}x${height}`, '-r', String(heartbeatFps), '-i', 'pipe:6']
      : []),
    // The playlist window's BURST layer (PlaylistWindowFeeder): transparent while idle, the insert
    // animation during a burst — the settled window stays baked in pipe:3. Present only when the
    // template has a playlist element (decided once per session, like every input). Declared last,
    // so no earlier index moves. Its motion is rendered in Node: ffmpeg's overlay/drawbox refuse
    // runtime x/y commands (sendcmd spike: "Function not implemented").
    ...(playlistWindow
      ? ['-f', 'rawvideo', '-pix_fmt', 'yuva420p', '-s', `${playlistWindow.width}x${playlistWindow.height}`, '-r', String(playlistWindow.fps), '-i', 'pipe:7']
      : []),
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
    // Same treatment for the second layer when there is one — see CanvasPlacement.
    ...(canvasPlacement === 'split' ? [`[${aboveCanvasInputIndex}:v]fps=${fps},format=yuva420p[vcanvas2]`] : []),
  ];
  let videoPad = 'vbg';

  const compositePlaylistWindow = () => {
    // Directly above the canvas layer the playlist element is baked into, so burst frames keep
    // the baked window's z-position relative to the gifs. Even x/y (computePlaylistWindowRegion)
    // makes yuv420 placement exact without GIF_OVERLAY_FORMAT's RGB round trip.
    filterLines.push(`[${playlistWindowInputIndex}:v]format=yuva420p[plwin]`);
    filterLines.push(`[${videoPad}][plwin]overlay=${playlistWindow!.x}:${playlistWindow!.y}[vplwin]`);
    videoPad = 'vplwin';
  };

  // For 'bottom' and 'split', the elements the template lists BEFORE its first gif go down first,
  // so the gifs below then composite over them instead of under them.
  if (canvasPlacement !== 'top') {
    filterLines.push(`[${videoPad}][vcanvas]overlay=0:0[vcanvas_below]`);
    videoPad = 'vcanvas_below';
    if (playlistWindow?.layer === 'below') compositePlaylistWindow();
  }

  // Each gif is composited in template-element order onto whatever is underneath it so far — the
  // background, plus the below-canvas layer when the template has one.
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
    // See GIF_OVERLAY_FORMAT: exact placement at odd coordinates.
    filterLines.push(`[${videoPad}][${gifPad}]overlay=${gif.x}:${gif.y}:${GIF_OVERLAY_FORMAT}[${nextPad}]`);
    videoPad = nextPad;
  });

  // Whatever the template lists AFTER its first gif composites on top of every gif: the whole
  // canvas for 'top' (the no-gif case — this is the original single-layer behaviour, which must
  // not change), or the second canvas layer for 'split'. 'bottom' has nothing left to lay on top,
  // so the last gif stage is already the final video pad. Getting this wrong in either direction
  // is a real, observed bug: with the canvas pinned on top, a full-frame element listed before a
  // gif hid it entirely; with the canvas pinned below, a full-frame gif would hide the title/
  // playlist text meant to sit over it.
  if (canvasPlacement === 'top' || canvasPlacement === 'split') {
    const topCanvasPad = canvasPlacement === 'split' ? 'vcanvas2' : 'vcanvas';
    filterLines.push(`[${videoPad}][${topCanvasPad}]overlay=0:0[vcanvas_top]`);
    videoPad = 'vcanvas_top';
  }
  // For 'top' placement there is no below layer at all, so a 'below' value is treated as 'top'
  // here — this and the 'below'-layer call above are mutually exclusive by construction, so the
  // playlist window is never composited twice.
  if (playlistWindow && (playlistWindow.layer === 'top' || canvasPlacement === 'top')) compositePlaylistWindow();

  if (equalizer) {
    // format=yuva420p is the actual straight-alpha compositing conversion — the input is declared
    // 'rgba' (straight alpha, thanks to PulseVisualizer's unpremultiply step), and this is the
    // same conversion stage every other alpha-carrying branch in this graph already goes through
    // (compare [0:v]'s own format=yuva420p above).
    filterLines.push(`[${pulseInputIndex}:v]format=yuva420p[pulse]`);
    // Deliberately NOT GIF_OVERLAY_FORMAT: the main input here is already yuv420p (the canvas
    // overlay's output), so compositing in RGB would add an RGB round trip of the whole 1280x720
    // frame — measured at ~0.85ms per frame (1.40 -> 2.25ms for the encode stage) on a machine
    // far less contended than the deployment host. It isn't needed for containment: the pulse
    // frame is inset from every edge by at least its own stroke margin (see layoutPulsePoints in
    // src/render/pulseSvg.ts), so the <=1px rounding of an odd coordinate moves the picture a
    // pixel WITHIN the box and can never paint outside it (pulseGeometry in pulseSvg.ts keeps at
    // least EDGE_CLEARANCE_PX of empty pixels on every edge, for any glow/box combination) — verified on the composited output at
    // an odd position (141:501): nothing outside the box beyond x264's own ringing (max 7/255),
    // identical to the even-position run.
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
