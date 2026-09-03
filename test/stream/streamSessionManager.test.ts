import { StreamSessionManager } from '../../src/stream/streamSessionManager';
import { SessionOverlayCache } from '../../src/stream/sessionOverlayCache';
import { ApiError } from '../../src/errors';

function buildDeps() {
  const streamManager = {
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn(),
    resume: jest.fn().mockResolvedValue(undefined),
    next: jest.fn().mockResolvedValue(undefined),
    previous: jest.fn().mockResolvedValue(undefined),
    status: jest.fn().mockReturnValue({ state: 'streaming', currentTrack: 'a', nextTrack: 'b' }),
  };
  const streamSessionRepository = {
    create: jest.fn(async (data: any) => ({ ...data, id: 'session-1', createdAt: new Date() })),
    findById: jest.fn(),
    listByUser: jest.fn(),
    deleteById: jest.fn().mockResolvedValue(undefined),
  };
  const destinationRepository = {
    findById: jest.fn(async (id: string) => ({ id, userId: 'user-1', name: id, provider: 'custom' })),
  };
  const playlistRepository = {
    findById: jest.fn().mockResolvedValue({ id: 'playlist-1', userId: 'user-1', name: 'Mix' }),
  };
  const templateRepository = {
    findById: jest.fn().mockResolvedValue({ id: 'template-1', userId: 'user-1', name: 'Theme', elements: [] }),
  };
  return { streamManager, streamSessionRepository, destinationRepository, playlistRepository, templateRepository };
}

function build() {
  const deps = buildDeps();
  const manager = new StreamSessionManager(deps as any);
  return { manager, ...deps };
}

describe('StreamSessionManager', () => {
  describe('create', () => {
    it('rejects an empty destinationIds array', async () => {
      const { manager, streamSessionRepository } = build();
      await expect(manager.create('user-1', 'playlist-1', undefined, [])).rejects.toThrow(ApiError);
      expect(streamSessionRepository.create).not.toHaveBeenCalled();
    });

    it('rejects duplicate destinationIds', async () => {
      const { manager, streamSessionRepository } = build();
      await expect(manager.create('user-1', 'playlist-1', undefined, ['dest-a', 'dest-a'])).rejects.toThrow(ApiError);
      expect(streamSessionRepository.create).not.toHaveBeenCalled();
    });

    it('404s when the playlist does not exist', async () => {
      const { manager, playlistRepository } = build();
      playlistRepository.findById.mockResolvedValue(null);
      await expect(manager.create('user-1', 'playlist-1', undefined, ['dest-a'])).rejects.toMatchObject({ status: 404 });
    });

    it('403s when the playlist belongs to someone else', async () => {
      const { manager, playlistRepository } = build();
      playlistRepository.findById.mockResolvedValue({ id: 'playlist-1', userId: 'someone-else', name: 'Mix' });
      await expect(manager.create('user-1', 'playlist-1', undefined, ['dest-a'])).rejects.toMatchObject({ status: 403 });
    });

    it('404s when a destination does not exist', async () => {
      const { manager, destinationRepository } = build();
      (destinationRepository.findById as jest.Mock).mockResolvedValue(null);
      await expect(manager.create('user-1', 'playlist-1', undefined, ['dest-a'])).rejects.toMatchObject({ status: 404 });
    });

    it('403s when a destination belongs to someone else', async () => {
      const { manager, destinationRepository } = build();
      (destinationRepository.findById as jest.Mock).mockResolvedValue({ id: 'dest-a', userId: 'someone-else', name: 'dest-a', provider: 'custom' });
      await expect(manager.create('user-1', 'playlist-1', undefined, ['dest-a'])).rejects.toMatchObject({ status: 403 });
    });

    it('404s when the template does not exist', async () => {
      const { manager, templateRepository } = build();
      templateRepository.findById.mockResolvedValue(null);
      await expect(manager.create('user-1', 'playlist-1', 'template-1', ['dest-a'])).rejects.toMatchObject({ status: 404, message: 'template not found' });
    });

    it('403s when the template belongs to someone else', async () => {
      const { manager, templateRepository } = build();
      templateRepository.findById.mockResolvedValue({ id: 'template-1', userId: 'someone-else', name: 'Theme', elements: [] });
      await expect(manager.create('user-1', 'playlist-1', 'template-1', ['dest-a'])).rejects.toMatchObject({ status: 403, message: 'not your template' });
    });

    it('skips the template lookup entirely when no templateId is given', async () => {
      const { manager, templateRepository } = build();
      await manager.create('user-1', 'playlist-1', undefined, ['dest-a']);
      expect(templateRepository.findById).not.toHaveBeenCalled();
    });

    it('persists the session and starts every destination with a shared overlay cache', async () => {
      const { manager, streamSessionRepository, streamManager } = build();
      const result = await manager.create('user-1', 'playlist-1', 'template-1', ['dest-a', 'dest-b'], { title: 'My Stream' });

      expect(streamSessionRepository.create).toHaveBeenCalledWith({
        userId: 'user-1', playlistId: 'playlist-1', templateId: 'template-1', destinationIds: ['dest-a', 'dest-b'],
        title: 'My Stream', description: null, privacyStatus: null,
      });
      expect(streamManager.start).toHaveBeenCalledWith(
        'dest-a', 'playlist-1', { title: 'My Stream' },
        { templateId: 'template-1', overlayCache: expect.any(SessionOverlayCache), sessionId: 'session-1' },
      );
      expect(streamManager.start).toHaveBeenCalledWith(
        'dest-b', 'playlist-1', { title: 'My Stream' },
        { templateId: 'template-1', overlayCache: expect.any(SessionOverlayCache), sessionId: 'session-1' },
      );
      // Both destinations share the exact same cache instance, not one each.
      const [firstCall, secondCall] = streamManager.start.mock.calls;
      expect(firstCall[3].overlayCache).toBe(secondCall[3].overlayCache);

      expect(result).toEqual({
        id: 'session-1', playlistId: 'playlist-1', templateId: 'template-1',
        destinations: [
          { destinationId: 'dest-a', status: { state: 'streaming', currentTrack: 'a', nextTrack: 'b' } },
          { destinationId: 'dest-b', status: { state: 'streaming', currentTrack: 'a', nextTrack: 'b' } },
        ],
      });
    });

    it('reports one destination failing to start without failing the others', async () => {
      const { manager, streamManager } = build();
      streamManager.start.mockImplementation(async (destinationId: string) => {
        if (destinationId === 'dest-a') throw new Error('youtube api hiccup');
      });

      const result = await manager.create('user-1', 'playlist-1', undefined, ['dest-a', 'dest-b']);

      expect(result.destinations).toEqual([
        { destinationId: 'dest-a', status: { state: 'streaming', currentTrack: 'a', nextTrack: 'b' }, error: 'youtube api hiccup' },
        { destinationId: 'dest-b', status: { state: 'streaming', currentTrack: 'a', nextTrack: 'b' } },
      ]);
    });
  });

  describe('ownership on existing sessions', () => {
    it('404s when the session does not exist', async () => {
      const { manager, streamSessionRepository } = build();
      streamSessionRepository.findById.mockResolvedValue(null);
      await expect(manager.status('user-1', 'session-1')).rejects.toMatchObject({ status: 404 });
    });

    it('403s when the session belongs to someone else', async () => {
      const { manager, streamSessionRepository } = build();
      streamSessionRepository.findById.mockResolvedValue({ id: 'session-1', userId: 'someone-else', playlistId: 'playlist-1', templateId: null, destinationIds: ['dest-a'] });
      await expect(manager.status('user-1', 'session-1')).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('command fan-out', () => {
    function existingSession() {
      return { id: 'session-1', userId: 'user-1', playlistId: 'playlist-1', templateId: null, title: null, description: null, privacyStatus: null, createdAt: new Date(), destinationIds: ['dest-a', 'dest-b'] };
    }

    it('pause fans out to every destination in the session', async () => {
      const { manager, streamSessionRepository, streamManager } = build();
      streamSessionRepository.findById.mockResolvedValue(existingSession());

      const result = await manager.pause('user-1', 'session-1');

      expect(streamManager.pause).toHaveBeenCalledWith('dest-a');
      expect(streamManager.pause).toHaveBeenCalledWith('dest-b');
      expect(result.destinations).toHaveLength(2);
    });

    it('one destination throwing on stop does not stop the fan-out to the others', async () => {
      const { manager, streamSessionRepository, streamManager } = build();
      streamSessionRepository.findById.mockResolvedValue(existingSession());
      streamManager.stop.mockImplementation(async (destinationId: string) => {
        if (destinationId === 'dest-a') throw new ApiError(409, 'stream is not active');
      });

      const result = await manager.stop('user-1', 'session-1');

      expect(streamManager.stop).toHaveBeenCalledWith('dest-a');
      expect(streamManager.stop).toHaveBeenCalledWith('dest-b');
      expect(result.destinations.find((d) => d.destinationId === 'dest-a')?.error).toBe('stream is not active');
      expect(result.destinations.find((d) => d.destinationId === 'dest-b')?.error).toBeUndefined();
    });
  });

  describe('deleteById', () => {
    it('stops every destination (ignoring "not active") and deletes the session', async () => {
      const { manager, streamSessionRepository, streamManager } = build();
      streamSessionRepository.findById.mockResolvedValue({
        id: 'session-1', userId: 'user-1', playlistId: 'playlist-1', templateId: null, title: null, description: null, privacyStatus: null, createdAt: new Date(), destinationIds: ['dest-a', 'dest-b'],
      });
      streamManager.stop.mockImplementation(async (destinationId: string) => {
        if (destinationId === 'dest-a') throw new ApiError(409, 'stream is not active');
      });

      await manager.deleteById('user-1', 'session-1');

      expect(streamManager.stop).toHaveBeenCalledWith('dest-a');
      expect(streamManager.stop).toHaveBeenCalledWith('dest-b');
      expect(streamSessionRepository.deleteById).toHaveBeenCalledWith('session-1');
    });

    it('propagates a non-409 error from stop without deleting the session', async () => {
      const { manager, streamSessionRepository, streamManager } = build();
      streamSessionRepository.findById.mockResolvedValue({
        id: 'session-1', userId: 'user-1', playlistId: 'playlist-1', templateId: null, title: null, description: null, privacyStatus: null, createdAt: new Date(), destinationIds: ['dest-a'],
      });
      streamManager.stop.mockRejectedValue(new Error('boom'));

      await expect(manager.deleteById('user-1', 'session-1')).rejects.toThrow('boom');
      expect(streamSessionRepository.deleteById).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('returns every session with live per-destination status', async () => {
      const { manager, streamSessionRepository } = build();
      streamSessionRepository.listByUser.mockResolvedValue([
        { id: 'session-1', userId: 'user-1', playlistId: 'playlist-1', templateId: null, title: null, description: null, privacyStatus: null, createdAt: new Date(), destinationIds: ['dest-a'] },
      ]);

      const result = await manager.list('user-1');

      expect(result).toEqual([
        { id: 'session-1', playlistId: 'playlist-1', templateId: null, destinations: [{ destinationId: 'dest-a', status: { state: 'streaming', currentTrack: 'a', nextTrack: 'b' } }] },
      ]);
    });
  });
});
