import { getImageFrameCount } from '../../src/ffmpeg/imageFrameCount';

describe('getImageFrameCount', () => {
  it('runs ffprobe with a decode-based frame count (not container metadata, which GIFs don\'t always declare) and parses the result', async () => {
    const execFileFn = jest.fn().mockResolvedValue({ stdout: '10\n', stderr: '' });

    const frames = await getImageFrameCount('/templates/cover.gif', execFileFn as any);

    expect(execFileFn).toHaveBeenCalledWith('ffprobe', [
      '-v', 'error',
      '-count_frames',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames',
      '-of', 'csv=p=0',
      '/templates/cover.gif',
    ]);
    expect(frames).toBe(10);
  });

  it('reports 1 frame for a static image', async () => {
    const execFileFn = jest.fn().mockResolvedValue({ stdout: '1\n', stderr: '' });
    expect(await getImageFrameCount('/templates/cover.png', execFileFn as any)).toBe(1);
  });

  // A corrupt/unreadable file, or ffprobe output that doesn't parse to a number, must not crash
  // the caller — treated as "1 frame" (static), the same as any ordinary image, rather than
  // throwing and taking down the whole stream-start flow over one bad asset.
  it('treats unparseable ffprobe output as a single static frame rather than throwing', async () => {
    const execFileFn = jest.fn().mockResolvedValue({ stdout: 'N/A\n', stderr: '' });
    expect(await getImageFrameCount('/templates/broken.png', execFileFn as any)).toBe(1);
  });
});
