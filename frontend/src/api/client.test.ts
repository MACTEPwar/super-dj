import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './client';

describe('api client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetchOnce(status: number, body: unknown) {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
  }

  it('get() sends credentials and parses a JSON response', async () => {
    mockFetchOnce(200, { id: 'x' });
    const result = await api.get<{ id: string }>('/tracks');
    expect(result).toEqual({ id: 'x' });
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/tracks');
    expect(init.credentials).toBe('include');
  });

  it('post() sends a JSON body with the right content-type', async () => {
    mockFetchOnce(200, {});
    await api.post('/playlists', { name: 'Mix' });
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ name: 'Mix' }));
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('postForm() sends FormData without forcing a JSON content-type', async () => {
    mockFetchOnce(200, {});
    const form = new FormData();
    form.append('name', 'x');
    await api.postForm('/tracks', form);
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.body).toBe(form);
    expect(init.headers).toBeUndefined();
  });

  it('throws a typed ApiError with the backend\'s error message on a non-2xx response', async () => {
    mockFetchOnce(403, { error: 'not your playlist' });
    await expect(api.get('/playlists/p1')).rejects.toMatchObject(
      new ApiError(403, 'not your playlist'),
    );
  });

  it('falls back to a generic message if the error body has no error field', async () => {
    mockFetchOnce(500, {});
    await expect(api.get('/tracks')).rejects.toMatchObject({ status: 500 });
  });
});
