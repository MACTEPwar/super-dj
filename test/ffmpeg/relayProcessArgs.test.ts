import { buildRelayProcessArgs } from '../../src/ffmpeg/relayProcessArgs';

const INPUT = 'rtmp://mediamtx:1935/live/abcdef0123456789abcdef0123456789?user=sub&pass=readsecret';
const OUTPUT = 'rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl';

describe('buildRelayProcessArgs', () => {
  it('reads the MediaMTX read URL and writes FLV to the destination', () => {
    const args = buildRelayProcessArgs({ inputUrl: INPUT, outputUrl: OUTPUT });
    expect(args).toContain('-i');
    expect(args[args.indexOf('-i') + 1]).toBe(INPUT);
    expect(args.slice(-3)).toEqual(['-f', 'flv', OUTPUT]);
  });

  // THE rule of this whole design: every forward is -c copy, full stop. Per-destination
  // transcoding would reintroduce one full encode per destination and destroy the entire
  // CPU-sharing premise of the local-first rework.
  it('remuxes only — no encoder, scaler, bitrate or filter option anywhere', () => {
    const args = buildRelayProcessArgs({ inputUrl: INPUT, outputUrl: OUTPUT });
    expect(args).toContain('-c');
    expect(args[args.indexOf('-c') + 1]).toBe('copy');
    for (const banned of ['-c:v', '-c:a', '-b:v', '-b:a', '-s', '-r', '-vf', '-af', '-filter_complex', '-preset']) {
      expect(args).not.toContain(banned);
    }
  });

  // ffmpeg's -reconnect/-reconnect_streamed/-reconnect_delay_max apply to HTTP(S) inputs only.
  // Input-side recovery here is a Node-level respawn owned by DestinationForward; a flag that
  // silently does nothing would be worse than no flag, because it reads as if it worked.
  it('uses no -reconnect* flags, which do not apply to an RTMP input', () => {
    const args = buildRelayProcessArgs({ inputUrl: INPUT, outputUrl: OUTPUT });
    expect(args.some((arg) => arg.startsWith('-reconnect'))).toBe(false);
  });

  it('normalises the output timeline so a relay joining an hours-old session does not emit huge timestamps', () => {
    const args = buildRelayProcessArgs({ inputUrl: INPUT, outputUrl: OUTPUT });
    expect(args).toContain('-avoid_negative_ts');
    expect(args[args.indexOf('-avoid_negative_ts') + 1]).toBe('make_zero');
  });
});
