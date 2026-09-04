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
});
