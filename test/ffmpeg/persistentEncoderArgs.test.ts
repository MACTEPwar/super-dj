import { buildPersistentEncoderArgs } from '../../src/ffmpeg/persistentEncoderArgs';

describe('buildPersistentEncoderArgs', () => {
  const base = {
    width: 1280, height: 720, fps: 30, heartbeatFps: 5,
    rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2', streamKey: 'abcd-1234',
    backgroundPath: '/assets/background.png',
  };

  it('reads raw video (with alpha) from pipe:3 and raw PCM audio from pipe:4, loops the background image, encodes and muxes to the rtmp url + stream key', () => {
    const args = buildPersistentEncoderArgs(base);

    expect(args).toEqual([
      // yuva420p (not yuv420p): the canvas now carries real per-pixel transparency from
      // CanvasFeeder/segmentArgs.ts — see the "canvas always composites on top of the
      // background and every gif overlay" test below for why.
      '-f', 'rawvideo', '-pix_fmt', 'yuva420p', '-s', '1280x720', '-r', '5', '-i', 'pipe:3',
      '-re', '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:4',
      // The background image used to be flattened onto the canvas by CanvasFeeder itself and
      // sent as one opaque frame; it's now composited here instead, as its own persistent input,
      // so an animated gif element can be layered between it and the (now-transparent) canvas.
      // -loop 1 replays this one still image indefinitely, matching the earlier canvas replay
      // CanvasFeeder achieved with its own opaque per-frame flattening.
      '-loop', '1', '-r', '30', '-i', '/assets/background.png',
      '-filter_complex',
      '[2:v]scale=1280:720[vbg];[0:v]fps=30,format=yuva420p[vcanvas];[vbg][vcanvas]overlay=0:0[vcanvas_top]',
      '-map', '[vcanvas_top]', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', '30', '-g', '60',
      '-c:a', 'aac', '-b:a', '192k',
      '-f', 'flv', 'rtmp://a.rtmp.youtube.com/live2/abcd-1234',
    ]);
  });

  it('-re is on the audio input only, not the video input (video timing is governed by the caller\'s own heartbeat)', () => {
    const args = buildPersistentEncoderArgs(base);

    const reIndex = args.indexOf('-re');
    const pipe4Index = args.indexOf('pipe:4');
    const pipe3Index = args.indexOf('pipe:3');
    expect(reIndex).toBeGreaterThan(pipe3Index);
    expect(reIndex).toBeLessThan(pipe4Index);
  });

  it('adds a straight-alpha rawvideo pipe:5 input and overlays it on top of the canvas when an equalizer element is present', () => {
    const args = buildPersistentEncoderArgs({
      ...base,
      equalizer: { x: 40, y: 500, width: 400, height: 150 },
    });

    // PulseVisualizer (Node) renders and unpremultiplies this frame itself — there is no more
    // ffmpeg-native showfreqs/asplit branch; ffmpeg's only job for this element is to composite
    // an already-rendered straight-alpha RGBA frame, same as any other overlay.
    expect(args).toEqual(expect.arrayContaining([
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '400x150', '-r', '30', '-i', 'pipe:5',
    ]));
    const filterArg = args[args.indexOf('-filter_complex') + 1];
    expect(filterArg).toContain('[3:v]format=yuva420p[pulse]');
    expect(filterArg).toContain('[vcanvas_top][pulse]overlay=40:500[vout]');
    expect(args).toEqual(expect.arrayContaining(['-map', '[vout]', '-map', '1:a']));
    // No more audio split for visualization — ffmpeg never touches the audio for this element any
    // more (PulseVisualizer taps AudioRelay's PCM directly in Node instead).
    expect(filterArg).not.toContain('asplit');
    expect(args).not.toEqual(expect.arrayContaining(['-map', '[a_out]']));
  });

  // Root cause (verified against a real ffmpeg binary, not just asserted from the string shape):
  // overlay's output cadence follows its MAIN input, and [0:v] is the raw canvas pipe declared at
  // heartbeatFps (5 — CanvasFeeder only resends/rerenders that often, which is plenty for mostly-
  // static cover/title/playlist content). Without upsampling [0:v] first, showfreqs' internal
  // ~25-30fps spectrum never actually reaches the encoder: overlay only recomputes when a new
  // main-input frame arrives (5/sec), so libx264 was measured emitting ~80% duplicate frames
  // (dup=78 of 98 over a 3s clip) — a visibly stepped/laggy spectrum despite showfreqs computing
  // a fresh frame far more often than that. Inserting `fps=<fps>` on [0:v] before the overlay
  // (cheap frame duplication inside the filter graph, no extra CanvasFeeder writes/renders) lets
  // overlay recompute at the full output rate instead, which the same real-binary check confirmed
  // eliminates the duplicate-frame reporting entirely.
  it('upsamples the canvas video to the target fps before compositing it, so the equalizer isn\'t bottlenecked by the canvas heartbeat rate', () => {
    const args = buildPersistentEncoderArgs({
      ...base,
      equalizer: { x: 40, y: 500, width: 400, height: 150 },
    });
    const filterArg = args[args.indexOf('-filter_complex') + 1];
    expect(filterArg).toContain('[0:v]fps=30,format=yuva420p[vcanvas]');
  });

  // Root cause (verified against a real ffmpeg binary): resvg (the Satori/image-element render
  // path) decodes a GIF to exactly one static frame — there is no animated-raster concept in SVG
  // at all — so an animated GIF used as an 'image' element never moves no matter how often the
  // overlay PNG is re-rendered. Fix mirrors the equalizer: ffmpeg decodes and loops the GIF
  // natively as an extra persistent input, entirely bypassing Satori/resvg for that element.
  it('adds an extra file input and a loop/fps/scale/overlay chain for each gifOverlays entry', () => {
    const args = buildPersistentEncoderArgs({
      ...base,
      gifOverlays: [{ x: 900, y: 40, width: 150, height: 150, filePath: '/data/templates/t1/cover.gif', frameCount: 10 }],
    });

    expect(args).toEqual(expect.arrayContaining(['-i', '/data/templates/t1/cover.gif']));
    const filterArg = args[args.indexOf('-filter_complex') + 1];
    // input index 3: pipe:3 is 0, pipe:4 is 1, the looped background is 2, so the first extra
    // gif file input is 3.
    // `loop`'s own `size=<frameCount>` (not `-stream_loop` on the input) is required — verified
    // against a real ffmpeg binary: `-stream_loop -1` on a GIF input left the composited output
    // frozen on the first frame indefinitely, while `loop=loop=-1:size=<frameCount>` inside the
    // filter graph genuinely cycled through all of the GIF's frames.
    expect(filterArg).toContain('[3:v]loop=loop=-1:size=10,fps=30,scale=150:150[gif0]');
    // :format=rgb — exact placement at odd coordinates, see the 'odd overlay coordinates' tests.
    expect(filterArg).toContain('[vbg][gif0]overlay=900:40:format=rgb[vgif0]');
  });

  it('chains multiple gifOverlays entries, one file input and one loop/overlay stage per entry, in array order', () => {
    const args = buildPersistentEncoderArgs({
      ...base,
      gifOverlays: [
        { x: 10, y: 10, width: 100, height: 100, filePath: '/a.gif', frameCount: 5 },
        { x: 20, y: 20, width: 200, height: 200, filePath: '/b.gif', frameCount: 8 },
      ],
    });

    const filterArg = args[args.indexOf('-filter_complex') + 1];
    expect(filterArg).toContain('[3:v]loop=loop=-1:size=5,fps=30,scale=100:100[gif0]');
    expect(filterArg).toContain('[vbg][gif0]overlay=10:10:format=rgb[vgif0]');
    expect(filterArg).toContain('[4:v]loop=loop=-1:size=8,fps=30,scale=200:200[gif1]');
    // second gif overlays on top of the first gif's own output pad, not back on [vbg].
    expect(filterArg).toContain('[vgif0][gif1]overlay=20:20:format=rgb[vgif1]');
    // the canvas composites on top of the LAST gif stage.
    expect(filterArg).toContain('[vgif1][vcanvas]overlay=0:0[vcanvas_top]');
    expect(args).toEqual(expect.arrayContaining(['-map', '[vcanvas_top]']));
  });

  // The canvas (every Satori-baked element — cover/title/playlist/text/static image) must always
  // render on top of the background AND every gif overlay, exactly like it did back when Satori
  // was the only renderer and simply painted every element in one pass. Pulling an animated gif
  // element out into a native ffmpeg overlay branch must not change where non-gif elements land
  // in the stack — verified against a real ffmpeg binary: without this, a full-frame background
  // gif visually hid title/playlist text that should have stayed on top of it.
  it('places the pulse input after every gif input, so adding an equalizer never renumbers the gif inputs', () => {
    const args = buildPersistentEncoderArgs({
      ...base,
      equalizer: { x: 40, y: 500, width: 400, height: 150 },
      gifOverlays: [{ x: 900, y: 40, width: 150, height: 150, filePath: '/cover.gif', frameCount: 10 }],
    });

    const filterArg = args[args.indexOf('-filter_complex') + 1];
    // gif input is still index 3 (unchanged from the no-equalizer gif test above) — the pulse
    // input is appended after it, at index 4, not inserted before it.
    expect(filterArg).toContain('[3:v]loop=loop=-1:size=10,fps=30,scale=150:150[gif0]');
    expect(filterArg).toContain('[vbg][gif0]overlay=900:40:format=rgb[vgif0]');
    expect(filterArg).toContain('[vgif0][vcanvas]overlay=0:0[vcanvas_top]');
    expect(filterArg).toContain('[4:v]format=yuva420p[pulse]');
    expect(filterArg).toContain('[vcanvas_top][pulse]overlay=40:500[vout]');
    expect(args).toEqual(expect.arrayContaining(['-i', '/cover.gif', '-i', 'pipe:5']));
  });

  // ffmpeg's overlay filter composites in yuv420 by default and silently rounds an odd x/y DOWN
  // to even, displacing the whole overlay one pixel up/left — verified against a real ffmpeg
  // binary: a white box at overlay=141:501 lit rows 500-501 and left its own last row/column
  // unpainted. A gif is opaque to its edge, so at an odd position it painted one row/column
  // OUTSIDE its declared box; `format=rgb` composites in packed RGB, where placement is exact.
  describe('odd overlay coordinates', () => {
    it('composites gif overlays in rgb mode so an odd position lands exactly where the template put it', () => {
      const args = buildPersistentEncoderArgs({
        ...base,
        gifOverlays: [
          { x: 901, y: 41, width: 150, height: 150, filePath: '/a.gif', frameCount: 10 },
          { x: 20, y: 20, width: 100, height: 100, filePath: '/b.gif', frameCount: 5 },
        ],
      });

      const filterArg = args[args.indexOf('-filter_complex') + 1];
      expect(filterArg).toContain('[3:v]loop=loop=-1:size=10,fps=30,scale=150:150[gif0]');
      expect(filterArg).toContain('[vbg][gif0]overlay=901:41:format=rgb[vgif0]');
      // Uniformly, not just for odd coordinates — one code path, same conversion count either way.
      expect(filterArg).toContain('[vgif0][gif1]overlay=20:20:format=rgb[vgif1]');
      expect(filterArg).not.toContain('pad=');
    });

    it('keeps the equalizer overlay in the default yuv420 mode at its exact template coordinates, odd or not', () => {
      // The pulse frame is inset from every edge by its own stroke margin (layoutPulsePoints), so
      // the <=1px rounding stays inside the box, and rgb-mode compositing here would cost an RGB
      // round trip of the whole frame — see buildPersistentEncoderArgs.
      const args = buildPersistentEncoderArgs({ ...base, equalizer: { x: 141, y: 501, width: 601, height: 151 } });

      const filterArg = args[args.indexOf('-filter_complex') + 1];
      expect(filterArg).toContain('[3:v]format=yuva420p[pulse]');
      expect(filterArg).toContain('[vcanvas_top][pulse]overlay=141:501[vout]');
    });
  });

  // The canvas being ONE flat layer always composited on top of every gif is only right when the
  // template's gif elements are listed before everything else. A full-frame opaque element listed
  // BEFORE a gif (a static image, a cover, or a per-track overlayOverride background) hid the gif
  // completely — reproduced against a real ffmpeg binary: the gif's region showed zero
  // frame-to-frame change at a flat luma matching the canvas background. buildStreamScene() (see
  // src/stream/streamScene.ts) now splits the baked elements around the first gif's position and
  // tells this builder where the canvas (or canvases) belong.
  describe('canvasPlacement', () => {
    const gifs = [
      { x: 10, y: 10, width: 100, height: 100, filePath: '/a.gif', frameCount: 5 },
      { x: 20, y: 20, width: 200, height: 200, filePath: '/b.gif', frameCount: 8 },
    ];

    it("defaults to 'top' — byte-for-byte the pre-split behaviour, canvas over every gif", () => {
      const omitted = buildPersistentEncoderArgs({ ...base, gifOverlays: gifs });
      const explicit = buildPersistentEncoderArgs({ ...base, gifOverlays: gifs, canvasPlacement: 'top' });
      expect(explicit).toEqual(omitted);
      const filterArg = omitted[omitted.indexOf('-filter_complex') + 1];
      expect(filterArg).toContain('[vgif1][vcanvas]overlay=0:0[vcanvas_top]');
      expect(omitted).not.toEqual(expect.arrayContaining(['pipe:6']));
    });

    it("'bottom' composites the one canvas under every gif, with no second canvas input", () => {
      const args = buildPersistentEncoderArgs({ ...base, gifOverlays: gifs, canvasPlacement: 'bottom' });

      const filterArg = args[args.indexOf('-filter_complex') + 1];
      // The canvas lands on the background first; the gifs then chain on top of THAT, not on [vbg].
      expect(filterArg).toContain('[vbg][vcanvas]overlay=0:0[vcanvas_below]');
      expect(filterArg).toContain('[vcanvas_below][gif0]overlay=10:10:format=rgb[vgif0]');
      expect(filterArg).toContain('[vgif0][gif1]overlay=20:20:format=rgb[vgif1]');
      expect(filterArg).not.toContain('[vcanvas_top]');
      expect(args).toEqual(expect.arrayContaining(['-map', '[vgif1]']));
      expect(args).not.toEqual(expect.arrayContaining(['pipe:6']));
    });

    it("'split' adds a second canvas pipe and composites the gifs between the two canvas layers", () => {
      const args = buildPersistentEncoderArgs({ ...base, gifOverlays: gifs, canvasPlacement: 'split' });

      // Same declaration as pipe:3 — it carries the same kind of frame, from the same CanvasFeeder.
      expect(args).toEqual(expect.arrayContaining([
        '-f', 'rawvideo', '-pix_fmt', 'yuva420p', '-s', '1280x720', '-r', '5', '-i', 'pipe:6',
      ]));
      const filterArg = args[args.indexOf('-filter_complex') + 1];
      // background -> below canvas -> gifs in order -> above canvas
      expect(filterArg).toContain('[vbg][vcanvas]overlay=0:0[vcanvas_below]');
      expect(filterArg).toContain('[vcanvas_below][gif0]overlay=10:10:format=rgb[vgif0]');
      expect(filterArg).toContain('[vgif0][gif1]overlay=20:20:format=rgb[vgif1]');
      expect(filterArg).toContain('[5:v]fps=30,format=yuva420p[vcanvas2]');
      expect(filterArg).toContain('[vgif1][vcanvas2]overlay=0:0[vcanvas_top]');
      expect(args).toEqual(expect.arrayContaining(['-map', '[vcanvas_top]']));
    });

    it("keeps the equalizer on top of both canvas layers, and gives the second canvas an input index that doesn't renumber the gif or pulse inputs", () => {
      const args = buildPersistentEncoderArgs({
        ...base,
        gifOverlays: gifs,
        equalizer: { x: 40, y: 500, width: 400, height: 150 },
        canvasPlacement: 'split',
      });

      const filterArg = args[args.indexOf('-filter_complex') + 1];
      // gif inputs still 3 and 4, pulse still 5 (3 + gifCount) — the second canvas is appended
      // last, at 6, so neither of the existing index formulas moves.
      expect(filterArg).toContain('[3:v]loop=loop=-1:size=5,fps=30,scale=100:100[gif0]');
      expect(filterArg).toContain('[4:v]loop=loop=-1:size=8,fps=30,scale=200:200[gif1]');
      expect(filterArg).toContain('[5:v]format=yuva420p[pulse]');
      expect(filterArg).toContain('[6:v]fps=30,format=yuva420p[vcanvas2]');
      expect(filterArg).toContain('[vgif1][vcanvas2]overlay=0:0[vcanvas_top]');
      expect(filterArg).toContain('[vcanvas_top][pulse]overlay=40:500[vout]');
      expect(args).toEqual(expect.arrayContaining(['-map', '[vout]', '-map', '1:a']));
      // pipe:5 still comes before pipe:6 in the input list.
      expect(args.indexOf('pipe:5')).toBeLessThan(args.indexOf('pipe:6'));
    });
  });

  it('is byte-for-byte identical to the no-equalizer output when equalizer is omitted vs. explicitly undefined', () => {
    const omitted = buildPersistentEncoderArgs(base);
    const explicitUndefined = buildPersistentEncoderArgs({ ...base, equalizer: undefined });
    expect(explicitUndefined).toEqual(omitted);
  });

  it('is byte-for-byte identical to the no-gif output when gifOverlays is omitted or empty', () => {
    const omitted = buildPersistentEncoderArgs(base);
    const empty = buildPersistentEncoderArgs({ ...base, gifOverlays: [] });
    expect(empty).toEqual(omitted);
  });

  describe('playlist window burst layer (pipe:7)', () => {
    const base = { width: 1280, height: 720, fps: 30, heartbeatFps: 5, rtmpUrl: 'rtmp://h/live', streamKey: 'k', backgroundPath: '/bg.png' };
    const PW = { x: 510, y: 158, width: 704, height: 342, fps: 30, layer: 'top' as const };
    const graphOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1];
    const GIF = { x: 0, y: 0, width: 10, height: 10, filePath: '/g.gif', frameCount: 3 };

    it('absent unless configured: args byte-identical to today (C11)', () => {
      expect(buildPersistentEncoderArgs({ ...base })).toEqual(buildPersistentEncoderArgs({ ...base, playlistWindow: undefined }));
      expect(buildPersistentEncoderArgs({ ...base }).join(' ')).not.toContain('pipe:7');
    });

    it('declares pipe:7 as yuva420p at its own fps, last among inputs', () => {
      const args = buildPersistentEncoderArgs({ ...base, playlistWindow: PW });
      const i = args.indexOf('pipe:7');
      expect(args.slice(i - 9, i + 1)).toEqual(['-f', 'rawvideo', '-pix_fmt', 'yuva420p', '-s', '704x342', '-r', '30', '-i', 'pipe:7']);
      expect(args.lastIndexOf('-i')).toBe(i - 1);
    });

    it("layer 'top': right after the top canvas, before the equalizer", () => {
      const g = graphOf(buildPersistentEncoderArgs({ ...base, playlistWindow: PW, equalizer: { x: 0, y: 600, width: 400, height: 100 } }));
      // inputs: 0 canvas, 1 audio, 2 bg, 3 pulse, 4 playlist window
      expect(g).toContain('[4:v]format=yuva420p[plwin]');
      expect(g).toContain('[vcanvas_top][plwin]overlay=510:158[vplwin]');
      expect(g).toContain('[vplwin][pulse]overlay=0:600[vout]');
    });

    it("layer 'below' (bottom placement): right after the below canvas, UNDER the gifs", () => {
      const g = graphOf(buildPersistentEncoderArgs({ ...base, canvasPlacement: 'bottom', gifOverlays: [GIF], playlistWindow: { ...PW, layer: 'below' } }));
      // inputs: 0 canvas, 1 audio, 2 bg, 3 gif, 4 playlist window
      expect(g).toContain('[vcanvas_below][plwin]overlay=510:158[vplwin]');
      expect(g).toContain('[vplwin][gif0]overlay=0:0:format=rgb[vgif0]');
    });

    it("split: index follows the above-canvas input; 'top' sits after the above layer", () => {
      const g = graphOf(buildPersistentEncoderArgs({ ...base, canvasPlacement: 'split', gifOverlays: [GIF], playlistWindow: PW }));
      // 0 canvas, 1 audio, 2 bg, 3 gif, 4 above canvas, 5 playlist window
      expect(g).toContain('[5:v]format=yuva420p[plwin]');
      expect(g).toContain('[vcanvas_top][plwin]overlay=510:158[vplwin]');
    });
  });

  describe('current-track marquee layer (pipe:8)', () => {
    const base = { width: 1280, height: 720, fps: 30, heartbeatFps: 5, rtmpUrl: 'rtmp://h/live', streamKey: 'k', backgroundPath: '/bg.png' };
    const PW = { x: 510, y: 158, width: 704, height: 342, fps: 30, layer: 'top' as const };
    const MQ = { x: 510, y: 158, width: 704, height: 342, fps: 30 };
    const graphOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1];

    it('absent unless configured: args byte-identical to today', () => {
      expect(buildPersistentEncoderArgs({ ...base, playlistWindow: PW })).toEqual(buildPersistentEncoderArgs({ ...base, playlistWindow: PW, marquee: undefined }));
      expect(buildPersistentEncoderArgs({ ...base, playlistWindow: PW }).join(' ')).not.toContain('pipe:8');
    });

    it('declares pipe:8 as yuva420p at its own fps, right after pipe:7', () => {
      const args = buildPersistentEncoderArgs({ ...base, playlistWindow: PW, marquee: MQ });
      const i7 = args.indexOf('pipe:7');
      const i8 = args.indexOf('pipe:8');
      expect(args.slice(i8 - 9, i8 + 1)).toEqual(['-f', 'rawvideo', '-pix_fmt', 'yuva420p', '-s', '704x342', '-r', '30', '-i', 'pipe:8']);
      expect(i8).toBeGreaterThan(i7);
      expect(args.lastIndexOf('-i')).toBe(i8 - 1);
    });

    it('composites right after the playlist window stage, before the equalizer', () => {
      const g = graphOf(buildPersistentEncoderArgs({ ...base, playlistWindow: PW, marquee: MQ, equalizer: { x: 0, y: 600, width: 400, height: 100 } }));
      // inputs: 0 canvas, 1 audio, 2 bg, 3 pulse, 4 playlist window, 5 marquee
      expect(g).toContain('[4:v]format=yuva420p[plwin]');
      expect(g).toContain('[vcanvas_top][plwin]overlay=510:158[vplwin]');
      expect(g).toContain('[5:v]format=yuva420p[mqwin]');
      expect(g).toContain('[vplwin][mqwin]overlay=510:158[vmqwin]');
      expect(g).toContain('[vmqwin][pulse]overlay=0:600[vout]');
    });

    it('is absent when playlistWindow itself is absent, even if marquee were somehow passed', () => {
      const withoutPW = buildPersistentEncoderArgs({ ...base, marquee: MQ });
      expect(withoutPW.join(' ')).not.toContain('pipe:8');
      expect(withoutPW).toEqual(buildPersistentEncoderArgs({ ...base }));
    });
  });
});
