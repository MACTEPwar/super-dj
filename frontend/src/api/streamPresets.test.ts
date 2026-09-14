import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { streamPresetsApi } from './streamPresets';

const fetchMock = vi.fn();
const PRESET = {
  id: 'preset-1', name: 'Friday night', playlistId: 'p1', templateId: null, destinationIds: ['d1'],
  title: null, description: null, privacyStatus: null, latencyPreference: null, createdAt: '2026-09-14T10:00:00.000Z',
};

describe('streamPresetsApi', () => {
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(PRESET) });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists presets', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([PRESET]) });
    await expect(streamPresetsApi.list()).resolves.toEqual([PRESET]);
    expect(fetchMock.mock.calls[0][0]).toContain('/stream-presets');
  });

  it('creates a preset', async () => {
    await streamPresetsApi.create({ name: 'Friday night', playlistId: 'p1', destinationIds: ['d1'] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/stream-presets');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ name: 'Friday night', playlistId: 'p1', destinationIds: ['d1'] });
  });

  it('updates and deletes by id', async () => {
    await streamPresetsApi.update('preset-1', { name: 'x', playlistId: 'p1' });
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
    await streamPresetsApi.remove('preset-1');
    expect(fetchMock.mock.calls[1][0]).toContain('/stream-presets/preset-1');
    expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
  });
});
