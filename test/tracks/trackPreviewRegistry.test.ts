import { TrackPreviewRegistry } from '../../src/tracks/trackPreviewRegistry';

describe('TrackPreviewRegistry', () => {
  it('returns undefined for an id that was never registered', () => {
    const registry = new TrackPreviewRegistry();
    expect(registry.get('missing')).toBeUndefined();
  });

  it('returns exactly what was registered under an id', () => {
    const registry = new TrackPreviewRegistry();
    registry.register('p1', { userId: 'user-1', query: 'Blur - Song 2', tempFilePath: '/tmp/p1.mp3', createdAt: 1000 });
    expect(registry.get('p1')).toEqual({ userId: 'user-1', query: 'Blur - Song 2', tempFilePath: '/tmp/p1.mp3', createdAt: 1000 });
  });

  it('delete removes the entry', () => {
    const registry = new TrackPreviewRegistry();
    registry.register('p1', { userId: 'user-1', query: 'x', tempFilePath: '/tmp/p1.mp3', createdAt: 1000 });
    registry.delete('p1');
    expect(registry.get('p1')).toBeUndefined();
  });

  it('delete on a missing id is a harmless no-op', () => {
    const registry = new TrackPreviewRegistry();
    expect(() => registry.delete('missing')).not.toThrow();
  });

  it('keeps entries for different ids independent', () => {
    const registry = new TrackPreviewRegistry();
    registry.register('p1', { userId: 'user-1', query: 'x', tempFilePath: '/tmp/p1.mp3', createdAt: 1000 });
    registry.register('p2', { userId: 'user-2', query: 'y', tempFilePath: '/tmp/p2.mp3', createdAt: 2000 });
    expect(registry.get('p1')?.userId).toBe('user-1');
    expect(registry.get('p2')?.userId).toBe('user-2');
  });

  describe('pruneOlderThan', () => {
    it('removes an entry older than maxAgeMs', () => {
      const registry = new TrackPreviewRegistry();
      registry.register('p1', { userId: 'user-1', query: 'x', tempFilePath: '/tmp/p1.mp3', createdAt: 1000 });

      registry.pruneOlderThan(60 * 60 * 1000, 1000 + 60 * 60 * 1000 + 1);

      expect(registry.get('p1')).toBeUndefined();
    });

    it('keeps an entry younger than maxAgeMs', () => {
      const registry = new TrackPreviewRegistry();
      registry.register('p1', { userId: 'user-1', query: 'x', tempFilePath: '/tmp/p1.mp3', createdAt: 1000 });

      registry.pruneOlderThan(60 * 60 * 1000, 1000 + 60 * 60 * 1000 - 1);

      expect(registry.get('p1')).toEqual({ userId: 'user-1', query: 'x', tempFilePath: '/tmp/p1.mp3', createdAt: 1000 });
    });

    it('is a harmless no-op on an empty registry', () => {
      const registry = new TrackPreviewRegistry();

      expect(() => registry.pruneOlderThan(60 * 60 * 1000, 999999)).not.toThrow();
    });

    it('prunes only the stale entries in a mixed-age registry, leaving fresh ones', () => {
      const registry = new TrackPreviewRegistry();
      registry.register('stale', { userId: 'user-1', query: 'old', tempFilePath: '/tmp/stale.mp3', createdAt: 0 });
      registry.register('fresh', { userId: 'user-1', query: 'new', tempFilePath: '/tmp/fresh.mp3', createdAt: 59 * 60 * 1000 });

      registry.pruneOlderThan(60 * 60 * 1000, 60 * 60 * 1000 + 1);

      expect(registry.get('stale')).toBeUndefined();
      expect(registry.get('fresh')).toBeDefined();
    });
  });
});
