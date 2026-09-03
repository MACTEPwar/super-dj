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
      '-c:v', 'libx264', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', '30', '-g', '60',
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
});
