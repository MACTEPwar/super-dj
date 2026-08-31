import { buildTrackSegmentArgs, buildPauseSegmentArgs } from '../../src/ffmpeg/segmentArgs';

describe('buildTrackSegmentArgs', () => {
  const base = {
    audioPath: '/music/a.mp3',
    coverPath: '/music/a.png',
    backgroundPath: '/assets/background.png',
    fontFile: '/fonts/DejaVuSans-Bold.ttf',
    width: 1280,
    height: 720,
    fps: 30,
    overlay: { title: 'Song A', playlistLines: ['▶ Song A', '  Song B'], durationSeconds: 65 },
  };

  it('builds ffmpeg args with the composited filter graph and no seek by default', () => {
    const args = buildTrackSegmentArgs(base);

    expect(args.slice(0, 4)).toEqual(['-loop', '1', '-i', '/assets/background.png']);
    expect(args).toEqual(expect.arrayContaining(['-loop', '1', '-i', '/music/a.png']));
    expect(args).toEqual(expect.arrayContaining(['-i', '/music/a.mp3']));
    expect(args).not.toEqual(expect.arrayContaining(['-ss']));

    const filterComplexIndex = args.indexOf('-filter_complex');
    const filterComplex = args[filterComplexIndex + 1];
    expect(filterComplex).toContain("drawtext=fontfile=/fonts/DejaVuSans-Bold.ttf:text='Song A'");
    expect(filterComplex).toContain('%{pts\\:hms} / 1\\:05');
    expect(filterComplex).toContain('▶ Song A\n  Song B');

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
});

describe('buildPauseSegmentArgs', () => {
  it('builds ffmpeg args for an unbounded silence + background segment', () => {
    const args = buildPauseSegmentArgs({ backgroundPath: '/assets/background.png', width: 1280, height: 720, fps: 30 });

    expect(args).toEqual([
      '-loop', '1',
      '-i', '/assets/background.png',
      '-f', 'lavfi',
      '-i', 'anullsrc=r=44100:cl=stereo',
      '-c:v', 'libx264',
      '-tune', 'stillimage',
      '-c:a', 'aac',
      '-ar', '44100',
      '-ac', '2',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-g', '60',
      '-vf', 'scale=1280:720',
      '-f', 'mpegts',
      'pipe:1',
    ]);
  });
});
