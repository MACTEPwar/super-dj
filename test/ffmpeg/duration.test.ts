import { getAudioDurationSeconds } from '../../src/ffmpeg/duration';

describe('getAudioDurationSeconds', () => {
  it('runs ffprobe asynchronously and parses the duration from its output', async () => {
    const execFileFn = jest.fn().mockResolvedValue({ stdout: '225.500000\n', stderr: '' });

    const seconds = await getAudioDurationSeconds('/music/a.mp3', execFileFn as any);

    expect(execFileFn).toHaveBeenCalledWith('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      '/music/a.mp3',
    ]);
    expect(seconds).toBeCloseTo(225.5);
  });

  it('does not resolve before the injected exec function does (stays async, never blocks synchronously)', async () => {
    let resolveExec!: (value: { stdout: string; stderr: string }) => void;
    const execFileFn = jest.fn().mockReturnValue(new Promise((resolve) => { resolveExec = resolve; }));

    let resolved = false;
    const durationPromise = getAudioDurationSeconds('/music/a.mp3', execFileFn as any).then((seconds) => {
      resolved = true;
      return seconds;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    resolveExec({ stdout: '10.0\n', stderr: '' });
    const seconds = await durationPromise;
    expect(resolved).toBe(true);
    expect(seconds).toBeCloseTo(10.0);
  });
});
