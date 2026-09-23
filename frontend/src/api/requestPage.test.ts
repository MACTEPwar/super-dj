import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRequestCommand, fetchPublicRequestPage } from './requestPage';

const ID = '3f2b9c1e-8d4a-4e2b-9a7c-1b2c3d4e5f60';

describe('buildRequestCommand', () => {
  it('keyword, 20-char prefix, space, full uuid', () => {
    expect(buildRequestCommand('track', 'Imagine Dragons - Believer (Live)', ID))
      .toBe(`!track:Imagine Dragons - Be ${ID}`);
  });
  it('collapses whitespace and newlines and trims', () => {
    expect(buildRequestCommand('t', '  Two\n\nlines\t here ', ID)).toBe(`!t:Two lines here ${ID}`);
  });
  it('truncates by code point, never splitting an emoji', () => {
    const name = '🎵'.repeat(25);
    const command = buildRequestCommand('t', name, ID);
    expect(command).toBe(`!t:${'🎵'.repeat(20)} ${ID}`);
    expect(command).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
  it('keeps short names whole', () => {
    expect(buildRequestCommand('t', 'Short', ID)).toBe(`!t:Short ${ID}`);
  });
});

describe('fetchPublicRequestPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps 404 to notFound and sends no credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 404, ok: false, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchPublicRequestPage('abc')).toEqual({ kind: 'notFound' });
    expect(fetchMock.mock.calls[0][1]?.credentials ?? 'omit').toBe('omit');
  });
  it('maps {live:false} to offline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ live: false }) }));
    expect(await fetchPublicRequestPage('abc')).toEqual({ kind: 'offline' });
  });
  it('maps a live body', async () => {
    const body = { live: true, playlistName: 'P', tracks: [{ id: ID, name: 'x', durationSeconds: 1 }], request: null };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => body }));
    expect(await fetchPublicRequestPage('abc')).toEqual({ kind: 'live', playlistName: 'P', tracks: body.tracks, request: null });
  });
  it('throws on other failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 500, ok: false, json: async () => ({}) }));
    await expect(fetchPublicRequestPage('abc')).rejects.toThrow();
  });
});
