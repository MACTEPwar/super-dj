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
    expect(filterArg).toContain('showfreqs=s=400x150:mode=bar:colors=#ff6600|#ff6600');
    expect(filterArg).toContain('overlay=40:500');
    expect(args).toEqual(expect.arrayContaining(['-map', '[vout]', '-map', '[a_out]']));
    expect(args).not.toEqual(expect.arrayContaining(['-map', '0:v']));
  });
});
