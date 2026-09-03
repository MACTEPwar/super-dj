import { buildRtmpPusherArgs } from '../../src/ffmpeg/rtmpPusherArgs';

describe('buildRtmpPusherArgs', () => {
  it('builds ffmpeg args that continuously mux both raw-ES fifos into the rtmp url + stream key', () => {
    const args = buildRtmpPusherArgs({
      videoFifoPath: '/tmp/x-video.fifo',
      audioFifoPath: '/tmp/x-audio.fifo',
      fps: 30,
      rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',
      streamKey: 'abcd-1234',
    });

    expect(args).toEqual([
      '-err_detect', 'ignore_err',
      '-re',
      '-f', 'h264', '-r', '30', '-i', '/tmp/x-video.fifo',
      '-f', 'aac', '-i', '/tmp/x-audio.fifo',
      '-c', 'copy',
      '-f', 'flv',
      'rtmp://a.rtmp.youtube.com/live2/abcd-1234',
    ]);
  });
});
