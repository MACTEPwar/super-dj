import { buildTrackSegmentArgs, buildPauseSegmentArgs } from '../../src/ffmpeg/segmentArgs';

describe('buildTrackSegmentArgs', () => {
  const base = {
    audioPath: '/music/a.mp3',
    backgroundPath: '/assets/background.png',
    overlayPngPath: '/tmp/super-dj-overlay-dest-1.png',
    width: 1280,
    height: 720,
    fps: 30,
  };

  it('builds ffmpeg args compositing the background and the overlay PNG, with no seek by default', () => {
    const args = buildTrackSegmentArgs(base);

    expect(args.slice(0, 8)).toEqual([
      '-loop', '1', '-i', '/assets/background.png',
      '-loop', '1', '-i', '/tmp/super-dj-overlay-dest-1.png',
    ]);
    expect(args).toEqual(expect.arrayContaining(['-i', '/music/a.mp3']));
    expect(args).not.toEqual(expect.arrayContaining(['-ss']));

    const filterComplexIndex = args.indexOf('-filter_complex');
    const filterComplex = args[filterComplexIndex + 1];
    expect(filterComplex).toBe('[0:v]scale=1280:720[bg];[1:v]scale=1280:720[ov];[bg][ov]overlay=0:0[outv]');

    // Assert the encoder tail exactly so a missing pin cannot slip through.
    expect(args.slice(filterComplexIndex + 2)).toEqual([
      '-map', '[outv]',
      '-map', '2:a',
      '-c:v', 'libx264',
      '-tune', 'stillimage',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '44100',
      '-ac', '2',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-g', '60',
      '-shortest',
      '-f', 'mpegts',
      'pipe:1',
    ]);
  });

  it('adds a -ss seek before the audio input when resuming mid-track', () => {
    const args = buildTrackSegmentArgs({ ...base, startOffsetSeconds: 42 });
    const audioInputIndex = args.indexOf('/music/a.mp3');

    expect(args[audioInputIndex - 3]).toBe('-ss');
    expect(args[audioInputIndex - 2]).toBe('42');
  });

  it('adds -output_ts_offset before the mpegts output when carrying the session clock forward', () => {
    const args = buildTrackSegmentArgs({ ...base, outputTsOffsetSeconds: 137.5 });

    const offsetIndex = args.indexOf('-output_ts_offset');
    expect(offsetIndex).toBeGreaterThan(-1);
    expect(args[offsetIndex + 1]).toBe('137.5');
    expect(args.slice(offsetIndex + 2)).toEqual(['-f', 'mpegts', 'pipe:1']);
  });

  it('omits -output_ts_offset when not given (e.g. the very first segment of a session)', () => {
    const args = buildTrackSegmentArgs(base);

    expect(args).not.toEqual(expect.arrayContaining(['-output_ts_offset']));
  });
});

describe('buildPauseSegmentArgs', () => {
  const base = {
    backgroundPath: '/assets/background.png',
    overlayPngPath: '/tmp/super-dj-overlay-dest-1.png',
    width: 1280,
    height: 720,
    fps: 30,
  };

  it('builds ffmpeg args compositing the background, the reused overlay PNG, and silence', () => {
    const args = buildPauseSegmentArgs(base);

    expect(args).toEqual([
      '-loop', '1', '-i', '/assets/background.png',
      '-loop', '1', '-i', '/tmp/super-dj-overlay-dest-1.png',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-filter_complex', '[0:v]scale=1280:720[bg];[1:v]scale=1280:720[ov];[bg][ov]overlay=0:0[outv]',
      '-map', '[outv]',
      '-map', '2:a',
      '-c:v', 'libx264',
      '-tune', 'stillimage',
      '-c:a', 'aac',
      '-ar', '44100',
      '-ac', '2',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-g', '60',
      '-f', 'mpegts',
      'pipe:1',
    ]);
  });

  it('adds -output_ts_offset before the mpegts output when carrying the session clock forward', () => {
    const args = buildPauseSegmentArgs({ ...base, outputTsOffsetSeconds: 42 });

    expect(args.slice(-5)).toEqual(['-output_ts_offset', '42', '-f', 'mpegts', 'pipe:1']);
  });
});
