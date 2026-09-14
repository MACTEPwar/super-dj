import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { localStreamApi } from './localStream';

const fetchMock = vi.fn();

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

const STATUS = {
  state: 'streaming', currentTrack: 'a', nextTrack: 'b',
  previewReady: true, playlistId: 'p1', templateId: null, startedAt: '2026-09-14T10:00:00.000Z',
};

describe('localStreamApi', () => {
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(jsonResponse(STATUS));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('starts a stream with the playlist and optional template', async () => {
    await localStreamApi.start({ playlistId: 'p1', templateId: 'tpl-1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/local-stream/start');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ playlistId: 'p1', templateId: 'tpl-1' });
  });

  it.each(['stop', 'pause', 'resume', 'next', 'previous'] as const)('posts to /local-stream/%s with no body', async (command) => {
    await localStreamApi[command]();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(`/local-stream/${command}`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('queues a track by name', async () => {
    await localStreamApi.play('Track A');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ name: 'Track A' });
  });

  // Every request carries the session cookie — the preview player depends on the same behaviour.
  it('sends credentials with every request', async () => {
    await localStreamApi.status();
    expect(fetchMock.mock.calls[0][1].credentials).toBe('include');
  });

  it('builds absolute SSE and preview URLs against the API base', async () => {
    expect(localStreamApi.eventsUrl()).toMatch(/\/local-stream\/events$/);
    expect(localStreamApi.previewUrl()).toMatch(/\/local-stream\/preview\/index\.m3u8$/);
  });
});
