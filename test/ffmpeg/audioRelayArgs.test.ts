import { buildDecodeTrackArgs, buildSilenceArgs } from '../../src/ffmpeg/audioRelayArgs';

describe('buildDecodeTrackArgs', () => {
  it('decodes a track file to raw PCM on stdout, no seek by default', () => {
    const args = buildDecodeTrackArgs({ audioPath: '/music/a.mp3' });

    expect(args).toEqual(['-i', '/music/a.mp3', '-f', 's16le', '-ar', '44100', '-ac', '2', '-']);
  });

  it('adds a -ss seek before the input when resuming mid-track', () => {
    const args = buildDecodeTrackArgs({ audioPath: '/music/a.mp3', startOffsetSeconds: 42 });

    expect(args).toEqual(['-ss', '42', '-i', '/music/a.mp3', '-f', 's16le', '-ar', '44100', '-ac', '2', '-']);
  });

  it('omits -ss when startOffsetSeconds is 0', () => {
    const args = buildDecodeTrackArgs({ audioPath: '/music/a.mp3', startOffsetSeconds: 0 });

    expect(args).not.toEqual(expect.arrayContaining(['-ss']));
  });
});

describe('buildSilenceArgs', () => {
  it('generates raw PCM silence matching the same format as a decoded track', () => {
    const args = buildSilenceArgs();

    expect(args).toEqual(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-f', 's16le', '-ar', '44100', '-ac', '2', '-']);
  });
});
