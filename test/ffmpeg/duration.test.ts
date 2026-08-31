import { getAudioDurationSeconds } from '../../src/ffmpeg/duration';

describe('getAudioDurationSeconds', () => {
  it('runs ffprobe and parses the duration from its output', () => {
    const execFileFn = jest.fn().mockReturnValue(Buffer.from('225.500000\n'));

    const seconds = getAudioDurationSeconds('/music/a.mp3', execFileFn as any);

    expect(execFileFn).toHaveBeenCalledWith('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      '/music/a.mp3',
    ]);
    expect(seconds).toBeCloseTo(225.5);
  });
});
