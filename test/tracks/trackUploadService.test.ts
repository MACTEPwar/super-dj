import { TrackUploadService } from '../../src/tracks/trackUploadService';

function buildDeps() {
  const trackRepository = { create: jest.fn(async (data: any) => ({ ...data, createdAt: new Date() })) };
  const moveFile = jest.fn(async (_from: string, _to: string) => {});
  const probeDuration = jest.fn(async () => 123.45);
  const generateId = jest.fn(() => 'track-1');
  return { trackRepository, moveFile, probeDuration, generateId };
}

describe('TrackUploadService', () => {
  it('moves the audio (and cover) file into the uploads dir and creates a Track row', async () => {
    const { trackRepository, moveFile, probeDuration, generateId } = buildDeps();
    const service = new TrackUploadService({
      trackRepository, uploadsDir: '/uploads', moveFile, probeDuration, generateId,
    });

    const result = await service.upload(
      'user-1',
      undefined,
      { originalname: 'My Song.mp3', path: '/tmp/upload-a', size: 1000 },
      { originalname: 'cover.png', path: '/tmp/upload-b', size: 500 },
    );

    expect(moveFile).toHaveBeenCalledWith('/tmp/upload-a', '/uploads/user-1/track-1/audio.mp3');
    expect(moveFile).toHaveBeenCalledWith('/tmp/upload-b', '/uploads/user-1/track-1/cover.png');
    expect(probeDuration).toHaveBeenCalledWith('/uploads/user-1/track-1/audio.mp3');
    expect(trackRepository.create).toHaveBeenCalledWith({
      id: 'track-1', userId: 'user-1', name: 'My Song', audioPath: '/uploads/user-1/track-1/audio.mp3',
      coverPath: '/uploads/user-1/track-1/cover.png', durationSeconds: 123.45,
    });
    expect(result).toEqual({ id: 'track-1', name: 'My Song', durationSeconds: 123.45, hasCover: true });
  });

  it('uses the provided name over the filename, and omits the cover when none is given', async () => {
    const { trackRepository, moveFile, probeDuration, generateId } = buildDeps();
    const service = new TrackUploadService({ trackRepository, uploadsDir: '/uploads', moveFile, probeDuration, generateId });

    const result = await service.upload('user-1', 'Custom Name', { originalname: 'track.wav', path: '/tmp/x', size: 1 }, undefined);

    expect(trackRepository.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Custom Name', coverPath: null }));
    expect(result.hasCover).toBe(false);
    expect(moveFile).toHaveBeenCalledTimes(1);
  });
});
