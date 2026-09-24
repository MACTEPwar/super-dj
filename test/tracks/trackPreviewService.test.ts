import * as fsPromises from 'fs/promises';
import { TrackPreviewService } from '../../src/tracks/trackPreviewService';
import { TrackPreviewRegistry } from '../../src/tracks/trackPreviewRegistry';
import { MediaSearchError } from '../../src/media/mediaSearchClient';

jest.mock('fs/promises', () => {
  const actual = jest.requireActual('fs/promises');
  return { ...actual, mkdir: jest.fn(actual.mkdir), writeFile: jest.fn(actual.writeFile), access: jest.fn(actual.access), unlink: jest.fn(actual.unlink), stat: jest.fn(actual.stat) };
});

function buildDeps() {
  const mediaSearchClient = { fetchAudio: jest.fn() };
  const registry = new TrackPreviewRegistry();
  const trackUploadService = { upload: jest.fn() };
  const generateId = jest.fn().mockReturnValue('preview-1');
  return { mediaSearchClient, registry, trackUploadService, generateId };
}

describe('TrackPreviewService', () => {
  const previewTempDir = '/tmp/super-dj-track-previews-test';

  beforeEach(() => jest.clearAllMocks());

  describe('search', () => {
    it('fetches audio, writes it to the temp dir, and registers it under a fresh id', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      (fsPromises.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fsPromises.writeFile as jest.Mock).mockResolvedValue(undefined);
      mediaSearchClient.fetchAudio.mockResolvedValue(Buffer.from([1, 2, 3]));
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      const result = await service.search('user-1', 'Blur - Song 2');

      expect(result).toEqual({ previewId: 'preview-1' });
      expect(mediaSearchClient.fetchAudio).toHaveBeenCalledWith('Blur - Song 2');
      expect(fsPromises.writeFile).toHaveBeenCalledWith(`${previewTempDir}/preview-1.mp3`, Buffer.from([1, 2, 3]));
      const entry = registry.get('preview-1');
      expect(entry?.userId).toBe('user-1');
      expect(entry?.query).toBe('Blur - Song 2');
      expect(entry?.tempFilePath).toBe(`${previewTempDir}/preview-1.mp3`);
    });

    it('lets a MediaSearchError propagate as-is (the route layer maps it to an HTTP status)', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      mediaSearchClient.fetchAudio.mockRejectedValue(new MediaSearchError('media search service returned 502: not found'));
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      await expect(service.search('user-1', 'nonexistent')).rejects.toThrow(MediaSearchError);
    });
  });

  describe('getPreviewPath', () => {
    it('returns the temp path for an owned, still-existing preview', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      registry.register('preview-1', { userId: 'user-1', query: 'My Song', tempFilePath: '/tmp/x/preview-1.mp3', createdAt: Date.now() });
      (fsPromises.access as jest.Mock).mockResolvedValue(undefined);
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      await expect(service.getPreviewPath('user-1', 'preview-1')).resolves.toBe('/tmp/x/preview-1.mp3');
    });

    it('throws 404 for an id that was never registered', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      await expect(service.getPreviewPath('user-1', 'missing')).rejects.toMatchObject({ status: 404 });
    });

    it('throws 403 for a preview owned by someone else', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      registry.register('preview-1', { userId: 'someone-else', query: 'x', tempFilePath: '/tmp/x/preview-1.mp3', createdAt: Date.now() });
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      await expect(service.getPreviewPath('user-1', 'preview-1')).rejects.toMatchObject({ status: 403 });
    });

    it('throws 404 and clears the stale entry when the temp file was already swept', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      registry.register('preview-1', { userId: 'user-1', query: 'My Song', tempFilePath: '/tmp/x/preview-1.mp3', createdAt: Date.now() });
      (fsPromises.access as jest.Mock).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      await expect(service.getPreviewPath('user-1', 'preview-1')).rejects.toMatchObject({ status: 404 });
      expect(registry.get('preview-1')).toBeUndefined();
    });
  });

  describe('confirm', () => {
    it('wraps the temp file as an UploadedFile and delegates to trackUploadService.upload, then clears the registry entry', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      registry.register('preview-1', { userId: 'user-1', query: 'My Song', tempFilePath: '/tmp/x/preview-1.mp3', createdAt: Date.now() });
      (fsPromises.access as jest.Mock).mockResolvedValue(undefined);
      (fsPromises.stat as jest.Mock).mockResolvedValue({ size: 4242 } as never);
      trackUploadService.upload.mockResolvedValue({ id: 't1', name: 'My Song', durationSeconds: 10, hasCover: false });
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      const result = await service.confirm('user-1', 'preview-1', 'My Song', undefined);

      expect(trackUploadService.upload).toHaveBeenCalledWith(
        'user-1', 'My Song',
        { originalname: 'preview-1.mp3', path: '/tmp/x/preview-1.mp3', size: 4242 },
        undefined,
      );
      expect(result).toEqual({ id: 't1', name: 'My Song', durationSeconds: 10, hasCover: false });
      expect(registry.get('preview-1')).toBeUndefined();
    });

    it('passes the cover file through untouched when one is given', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      registry.register('preview-1', { userId: 'user-1', query: 'My Song', tempFilePath: '/tmp/x/preview-1.mp3', createdAt: Date.now() });
      (fsPromises.access as jest.Mock).mockResolvedValue(undefined);
      (fsPromises.stat as jest.Mock).mockResolvedValue({ size: 10 } as never);
      trackUploadService.upload.mockResolvedValue({ id: 't1', name: 'x', durationSeconds: 1, hasCover: true });
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });
      const cover = { originalname: 'cover.png', path: '/tmp/cover', size: 100 };

      await service.confirm('user-1', 'preview-1', 'a chosen name', cover);

      expect(trackUploadService.upload).toHaveBeenCalledWith('user-1', 'a chosen name', expect.anything(), cover);
    });

    // Regression test for the real bug this exact case produced during design review: the temp
    // file's own "originalname" is a synthetic `${previewId}.mp3`, never anything derived from
    // what was actually searched for — falling through to TrackUploadService.upload()'s OWN
    // filename-based default would have named the track after a random UUID instead of the song
    // the streamer actually searched for and listened to.
    it('defaults the name to the original search query when name is omitted (not to the synthetic temp filename)', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      registry.register('preview-1', { userId: 'user-1', query: 'Blur - Song 2', tempFilePath: '/tmp/x/preview-1.mp3', createdAt: Date.now() });
      (fsPromises.access as jest.Mock).mockResolvedValue(undefined);
      (fsPromises.stat as jest.Mock).mockResolvedValue({ size: 10 } as never);
      trackUploadService.upload.mockResolvedValue({ id: 't1', name: 'Blur - Song 2', durationSeconds: 1, hasCover: false });
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      await service.confirm('user-1', 'preview-1', undefined, undefined);

      expect(trackUploadService.upload).toHaveBeenCalledWith('user-1', 'Blur - Song 2', expect.anything(), undefined);
    });

    it('also defaults the name when an empty string is given (a streamer who clears the field, not just omits it)', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      registry.register('preview-1', { userId: 'user-1', query: 'Blur - Song 2', tempFilePath: '/tmp/x/preview-1.mp3', createdAt: Date.now() });
      (fsPromises.access as jest.Mock).mockResolvedValue(undefined);
      (fsPromises.stat as jest.Mock).mockResolvedValue({ size: 10 } as never);
      trackUploadService.upload.mockResolvedValue({ id: 't1', name: 'Blur - Song 2', durationSeconds: 1, hasCover: false });
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      await service.confirm('user-1', 'preview-1', '', undefined);

      expect(trackUploadService.upload).toHaveBeenCalledWith('user-1', 'Blur - Song 2', expect.anything(), undefined);
    });

    it('403s for a preview owned by someone else, without calling upload', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      registry.register('preview-1', { userId: 'someone-else', query: 'x', tempFilePath: '/tmp/x/preview-1.mp3', createdAt: Date.now() });
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      await expect(service.confirm('user-1', 'preview-1', undefined, undefined)).rejects.toMatchObject({ status: 403 });
      expect(trackUploadService.upload).not.toHaveBeenCalled();
    });
  });

  describe('discard', () => {
    it('removes the registry entry and unlinks the temp file', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      registry.register('preview-1', { userId: 'user-1', query: 'My Song', tempFilePath: '/tmp/x/preview-1.mp3', createdAt: Date.now() });
      (fsPromises.unlink as jest.Mock).mockResolvedValue(undefined);
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      await service.discard('user-1', 'preview-1');

      expect(registry.get('preview-1')).toBeUndefined();
      expect(fsPromises.unlink).toHaveBeenCalledWith('/tmp/x/preview-1.mp3');
    });

    it('swallows ENOENT if the file was already gone', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      registry.register('preview-1', { userId: 'user-1', query: 'My Song', tempFilePath: '/tmp/x/preview-1.mp3', createdAt: Date.now() });
      (fsPromises.unlink as jest.Mock).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      await expect(service.discard('user-1', 'preview-1')).resolves.toBeUndefined();
    });

    it('404s for a missing preview', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      await expect(service.discard('user-1', 'missing')).rejects.toMatchObject({ status: 404 });
    });
  });
});
