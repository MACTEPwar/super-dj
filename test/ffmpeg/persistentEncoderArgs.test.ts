import { buildPersistentEncoderArgs } from '../../src/ffmpeg/persistentEncoderArgs';

describe('buildPersistentEncoderArgs', () => {
  it('reads raw video from pipe:3 and raw PCM audio from pipe:4, encodes and muxes to the rtmp url + stream key', () => {
    const args = buildPersistentEncoderArgs({
      width: 1280, height: 720, fps: 30, heartbeatFps: 5,
      rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2', streamKey: 'abcd-1234',
    });

    expect(args).toEqual([
      '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', '1280x720', '-r', '5', '-i', 'pipe:3',
      '-re', '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:4',
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', '30', '-g', '60',
      '-c:a', 'aac', '-b:a', '192k',
      '-f', 'flv', 'rtmp://a.rtmp.youtube.com/live2/abcd-1234',
    ]);
  });

  it('-re is on the audio input only, not the video input (video timing is governed by the caller\'s own heartbeat)', () => {
    const args = buildPersistentEncoderArgs({
      width: 1280, height: 720, fps: 30, heartbeatFps: 5, rtmpUrl: 'rtmp://x', streamKey: 'k',
    });

    const reIndex = args.indexOf('-re');
    const pipe4Index = args.indexOf('pipe:4');
    const pipe3Index = args.indexOf('pipe:3');
    expect(reIndex).toBeGreaterThan(pipe3Index);
    expect(reIndex).toBeLessThan(pipe4Index);
  });

  it('is byte-for-byte identical to the no-equalizer output when equalizer is omitted', () => {
    const withoutField = buildPersistentEncoderArgs({
      width: 1280, height: 720, fps: 30, heartbeatFps: 5, rtmpUrl: 'rtmp://x', streamKey: 'k',
    });
    const withUndefined = buildPersistentEncoderArgs({
      width: 1280, height: 720, fps: 30, heartbeatFps: 5, rtmpUrl: 'rtmp://x', streamKey: 'k', equalizer: undefined,
    });
    expect(withUndefined).toEqual(withoutField);
  });

  it('adds a filter_complex with asplit/showfreqs/overlay and maps [vout]/[a_out] when equalizer is present', () => {
    const args = buildPersistentEncoderArgs({
      width: 1280, height: 720, fps: 30, heartbeatFps: 5, rtmpUrl: 'rtmp://x', streamKey: 'k',
      equalizer: { x: 40, y: 500, width: 400, height: 150, color: '#ff6600' },
    });
    const filterIndex = args.indexOf('-filter_complex');
    expect(filterIndex).toBeGreaterThan(-1);
    const filterArg = args[filterIndex + 1];
    expect(filterArg).toContain('[1:a]asplit=2[a_out][a_viz]');
    // colors= is a pipe-separated list, one entry per input audio channel — pipe:4 is always
    // declared stereo (-ac 2), so a single color must be repeated once per channel or showfreqs
    // renders the un-colored channel(s) in its own built-in defaults, desaturating the combined
    // (overlaid) output. Verified against a real ffmpeg binary: a single `colors=#ff6600` against
    // 2-channel input produced SATAVG=0 (fully achromatic); `colors=#ff6600|#ff6600` restored
    // SATAVG≈44 (matching the mono/1-channel baseline).
    // rate=<fps> and the [0:v]fps=<fps>[vfast] stage upsampling the main input before overlay
    // are both required for the same reason — see the "smooth, un-bottlenecked equalizer motion"
    // test below for the full story.
    expect(filterArg).toContain('showfreqs=s=400x150:mode=bar:rate=30:colors=#ff6600|#ff6600');
    expect(filterArg).toContain('[0:v]fps=30[vfast]');
    expect(filterArg).toContain('[vfast][eq]overlay=40:500');
    expect(args).toEqual(expect.arrayContaining(['-map', '[vout]', '-map', '[a_out]']));
    expect(args).not.toEqual(expect.arrayContaining(['-map', '0:v']));
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
  it('upsamples the canvas video to the target fps before overlay, so the equalizer isn\'t bottlenecked by the canvas heartbeat rate', () => {
    const args = buildPersistentEncoderArgs({
      width: 1280, height: 720, fps: 30, heartbeatFps: 5, rtmpUrl: 'rtmp://x', streamKey: 'k',
      equalizer: { x: 40, y: 500, width: 400, height: 150, color: '#ffffff' },
    });
    const filterArg = args[args.indexOf('-filter_complex') + 1];
    expect(filterArg).toContain('[0:v]fps=30[vfast]');
    expect(filterArg).toContain('showfreqs=s=400x150:mode=bar:rate=30');
    // overlay must read the upsampled [vfast] pad, not the raw 5fps [0:v] pad directly.
    expect(filterArg).toContain('[vfast][eq]overlay=');
    expect(filterArg).not.toContain('[0:v][eq]overlay=');
  });

  // Root cause (verified against a real ffmpeg binary): resvg (the Satori/image-element render
  // path) decodes a GIF to exactly one static frame — there is no animated-raster concept in SVG
  // at all — so an animated GIF used as an 'image' element never moves no matter how often the
  // overlay PNG is re-rendered. Fix mirrors the equalizer: ffmpeg decodes and loops the GIF
  // natively as an extra persistent input, entirely bypassing Satori/resvg for that element.
  it('adds an extra file input and a loop/fps/scale/overlay chain for each gifOverlays entry', () => {
    const args = buildPersistentEncoderArgs({
      width: 1280, height: 720, fps: 30, heartbeatFps: 5, rtmpUrl: 'rtmp://x', streamKey: 'k',
      gifOverlays: [{ x: 900, y: 40, width: 150, height: 150, filePath: '/data/templates/t1/cover.gif', frameCount: 10 }],
    });

    expect(args).toEqual(expect.arrayContaining(['-i', '/data/templates/t1/cover.gif']));
    const filterArg = args[args.indexOf('-filter_complex') + 1];
    expect(filterArg).toContain('[0:v]fps=30[vfast]');
    // input index 2: pipe:3 is 0, pipe:4 is 1, so the first extra file input is 2.
    // `loop`'s own `size=<frameCount>` (not `-stream_loop` on the input) is required — verified
    // against a real ffmpeg binary: `-stream_loop -1` on a GIF input left the composited output
    // frozen on the first frame indefinitely, while `loop=loop=-1:size=<frameCount>` inside the
    // filter graph genuinely cycled through all of the GIF's frames.
    expect(filterArg).toContain('[2:v]loop=loop=-1:size=10,fps=30,scale=150:150[gif0]');
    expect(filterArg).toContain('[vfast][gif0]overlay=900:40[vgif0]');
    // No equalizer in this test — the gif chain's own last pad is the final video map target,
    // there's no reason to force a [vout] relabel just to have a fixed name.
    expect(args).toEqual(expect.arrayContaining(['-map', '[vgif0]', '-map', '1:a']));
  });

  it('chains multiple gifOverlays entries, one file input and one loop/overlay stage per entry, in array order', () => {
    const args = buildPersistentEncoderArgs({
      width: 1280, height: 720, fps: 30, heartbeatFps: 5, rtmpUrl: 'rtmp://x', streamKey: 'k',
      gifOverlays: [
        { x: 10, y: 10, width: 100, height: 100, filePath: '/a.gif', frameCount: 5 },
        { x: 20, y: 20, width: 200, height: 200, filePath: '/b.gif', frameCount: 8 },
      ],
    });

    const filterArg = args[args.indexOf('-filter_complex') + 1];
    expect(filterArg).toContain('[2:v]loop=loop=-1:size=5,fps=30,scale=100:100[gif0]');
    expect(filterArg).toContain('[vfast][gif0]overlay=10:10[vgif0]');
    expect(filterArg).toContain('[3:v]loop=loop=-1:size=8,fps=30,scale=200:200[gif1]');
    // second gif overlays on top of the first gif's own output pad, not back on [vfast].
    expect(filterArg).toContain('[vgif0][gif1]overlay=20:20[vgif1]');
    expect(args).toEqual(expect.arrayContaining(['-map', '[vgif1]', '-map', '1:a']));
  });

  // The equalizer is documented (CLAUDE.md) as always topmost, composited after the canvas is
  // already flattened — that invariant must hold over gif overlays too, not just over Satori's
  // own baked elements, so the equalizer's overlay stage must be the LAST one in the chain.
  it('composites gif overlays first and the equalizer last (on top), when both are present', () => {
    const args = buildPersistentEncoderArgs({
      width: 1280, height: 720, fps: 30, heartbeatFps: 5, rtmpUrl: 'rtmp://x', streamKey: 'k',
      equalizer: { x: 40, y: 500, width: 400, height: 150, color: '#ff6600' },
      gifOverlays: [{ x: 900, y: 40, width: 150, height: 150, filePath: '/cover.gif', frameCount: 10 }],
    });

    const filterArg = args[args.indexOf('-filter_complex') + 1];
    expect(filterArg).toContain('[vfast][gif0]overlay=900:40[vgif0]');
    // the equalizer's overlay reads the gif chain's own output pad, not [vfast] directly, and
    // its own output is the fixed [vout] label the encoder always maps as the final video pad.
    expect(filterArg).toContain('[vgif0][eq]overlay=40:500[vout]');
    expect(args).toEqual(expect.arrayContaining(['-map', '[vout]', '-map', '[a_out]']));
  });

  it('is byte-for-byte identical to the no-gif output when gifOverlays is omitted or empty', () => {
    const omitted = buildPersistentEncoderArgs({
      width: 1280, height: 720, fps: 30, heartbeatFps: 5, rtmpUrl: 'rtmp://x', streamKey: 'k',
    });
    const empty = buildPersistentEncoderArgs({
      width: 1280, height: 720, fps: 30, heartbeatFps: 5, rtmpUrl: 'rtmp://x', streamKey: 'k', gifOverlays: [],
    });
    expect(empty).toEqual(omitted);
  });
});
