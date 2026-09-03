import { buildRtmpPusherArgs } from '../../src/ffmpeg/rtmpPusherArgs';

describe('buildRtmpPusherArgs', () => {
  it('builds ffmpeg args that copy the fifo into the rtmp url + stream key', () => {
    const args = buildRtmpPusherArgs({ fifoPath: '/tmp/x.fifo', rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2', streamKey: 'abcd-1234' });

    expect(args).toEqual(['-err_detect', 'ignore_err', '-re', '-i', '/tmp/x.fifo', '-c', 'copy', '-f', 'flv', 'rtmp://a.rtmp.youtube.com/live2/abcd-1234']);
  });
});
