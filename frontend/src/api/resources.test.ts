import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authApi } from './auth';
import { tracksApi } from './tracks';
import { playlistsApi } from './playlists';
import { destinationsApi } from './destinations';

function mockFetchOnce(body: unknown) {
  (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
}

describe('resource API modules', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('authApi.login posts credentials to /auth/login', async () => {
    mockFetchOnce({ id: 'u1', email: 'a@example.com' });
    await authApi.login('a@example.com', 'pw');
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/auth/login');
    expect(JSON.parse(init.body)).toEqual({ email: 'a@example.com', password: 'pw' });
  });

  it('tracksApi.upload posts multipart form data to /tracks', async () => {
    mockFetchOnce({ id: 't1', name: 'A', durationSeconds: 10, hasCover: false });
    const audio = new File(['x'], 'a.mp3', { type: 'audio/mpeg' });
    await tracksApi.upload(audio, null, undefined);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/tracks');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('playlistsApi.replaceTracks PUTs the ordered id list', async () => {
    mockFetchOnce({});
    await playlistsApi.replaceTracks('p1', ['t2', 't1']);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/playlists/p1/tracks');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ trackIds: ['t2', 't1'] });
  });

  it('destinationsApi.oauthStart GETs the provider-scoped start URL', async () => {
    mockFetchOnce({ authUrl: 'https://accounts.google.com/...' });
    await destinationsApi.oauthStart('youtube');
    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/destinations/youtube/oauth/start');
  });
});
