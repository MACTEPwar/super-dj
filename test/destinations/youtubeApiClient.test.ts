import { createYoutubeApiClient } from '../../src/destinations/youtubeApiClient';

function mockFetchOnce(status: number, body: unknown) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe('createYoutubeApiClient', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('exchangeCode posts to the Google token endpoint and maps the response', async () => {
    mockFetchOnce(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    const tokens = await client.exchangeCode('code-1', 'https://app.example.com/destinations/youtube/oauth/callback');

    expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.body).toContain('code=code-1');
    expect(init.body).toContain('grant_type=authorization_code');
    expect(init.body).toContain('client_id=id');
  });

  it('refreshAccessToken returns just the access token', async () => {
    mockFetchOnce(200, { access_token: 'at2', expires_in: 3600 });
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    const accessToken = await client.refreshAccessToken('rt');

    expect(accessToken).toBe('at2');
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.body).toContain('grant_type=refresh_token');
  });

  it('revoke posts the refresh token to the Google revoke endpoint', async () => {
    mockFetchOnce(200, {});
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    await client.revoke('rt');

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/revoke');
    expect(init.body).toContain('token=rt');
  });

  it('getChannel maps the first channel item to {id, title}', async () => {
    mockFetchOnce(200, { items: [{ id: 'chan-1', snippet: { title: 'My Channel' } }] });
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    expect(await client.getChannel('at')).toEqual({ id: 'chan-1', title: 'My Channel' });
  });

  it('getChannel throws a 502 ApiError when the account has no channel', async () => {
    mockFetchOnce(200, { items: [] });
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    await expect(client.getChannel('at')).rejects.toMatchObject({ status: 502 });
  });

  it('createStream parses ingestionAddress/streamName from cdn.ingestionInfo', async () => {
    mockFetchOnce(200, { id: 'stream-1', cdn: { ingestionInfo: { ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2', streamName: 'abcd-1234' } } });
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    const stream = await client.createStream('at', { title: 'My Stream' });

    expect(stream).toEqual({ id: 'stream-1', ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2', streamName: 'abcd-1234' });
  });

  it('createBroadcast returns just the created id', async () => {
    mockFetchOnce(200, { id: 'broadcast-1' });
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    expect(await client.createBroadcast('at', { title: 'T', description: 'D', privacyStatus: 'private' })).toEqual({ id: 'broadcast-1' });
  });

  it('getStreamStatus reads status.streamStatus from the first item', async () => {
    mockFetchOnce(200, { items: [{ status: { streamStatus: 'active' } }] });
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    expect(await client.getStreamStatus('at', 'stream-1')).toBe('active');
  });

  it('getStreamStatus returns "unknown" when the stream has no items', async () => {
    mockFetchOnce(200, { items: [] });
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    expect(await client.getStreamStatus('at', 'stream-1')).toBe('unknown');
  });

  it('deleteStream tolerates a 404 (already gone)', async () => {
    mockFetchOnce(404, {});
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    await expect(client.deleteStream('at', 'stream-1')).resolves.toBeUndefined();
  });

  it('wraps a non-ok, non-404 response as a 502 ApiError', async () => {
    mockFetchOnce(403, { error: 'forbidden' });
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    await expect(client.getChannel('at')).rejects.toMatchObject({ status: 502 });
  });
});
