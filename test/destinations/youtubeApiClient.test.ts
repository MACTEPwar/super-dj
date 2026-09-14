import { createYoutubeApiClient, YoutubeApiError, isAuthClassError } from '../../src/destinations/youtubeApiClient';

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

  it('getStream returns the persisted stream\'s ingest details when YouTube still has it', async () => {
    mockFetchOnce(200, { items: [{ id: 'S1', cdn: { ingestionInfo: { ingestionAddress: 'rtmp://a/live2', streamName: 'key-1' } } }] });
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    await expect(client.getStream('at', 'S1')).resolves.toEqual({
      id: 'S1', ingestionAddress: 'rtmp://a/live2', streamName: 'key-1',
    });
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('/liveStreams?part=cdn&id=S1');
  });

  // A liveStream the user deleted in YouTube Studio comes back as an EMPTY items array with a 200,
  // not a 404 — so "no items" has to mean "gone", or the provider would happily bind a broadcast to
  // a stream that does not exist.
  it('getStream returns null when YouTube no longer has that stream', async () => {
    mockFetchOnce(200, { items: [] });
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    await expect(client.getStream('at', 'S1')).resolves.toBeNull();
  });

  it('createBroadcast returns just the created id, and disables the monitor stream', async () => {
    mockFetchOnce(200, { id: 'broadcast-1' });
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    expect(await client.createBroadcast('at', { title: 'T', description: 'D', privacyStatus: 'private', latencyPreference: 'low' })).toEqual({ id: 'broadcast-1' });

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body);
    // A monitor-enabled broadcast (YouTube's default) may require transitioning through
    // 'testing' before 'live', but youtubeProvider.ts transitions straight to 'live' — so
    // the monitor stream must be explicitly disabled here.
    expect(body.contentDetails).toEqual({ enableAutoStart: false, enableAutoStop: false, monitorStream: { enableMonitorStream: false }, latencyPreference: 'low' });
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

  describe('YoutubeApiError / isAuthClassError (typed, inspectable upstream failures)', () => {
    it('wraps a non-ok response as a YoutubeApiError carrying the real upstream status and reason', async () => {
      mockFetchOnce(403, { error: { code: 403, errors: [{ reason: 'forbidden' }], status: 'PERMISSION_DENIED' } });
      const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

      try {
        await client.getChannel('at');
        throw new Error('expected getChannel to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(YoutubeApiError);
        expect((err as YoutubeApiError).upstreamStatus).toBe(403);
        expect((err as YoutubeApiError).reason).toBe('forbidden');
      }
    });

    it('extracts the OAuth token endpoint\'s bare error string (e.g. invalid_grant) as the reason', async () => {
      mockFetchOnce(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

      try {
        await client.refreshAccessToken('rt');
        throw new Error('expected refreshAccessToken to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(YoutubeApiError);
        expect((err as YoutubeApiError).reason).toBe('invalid_grant');
        expect((err as YoutubeApiError).upstreamStatus).toBe(400);
      }
    });

    it('isAuthClassError recognizes 401/403 and known auth-related reason strings', () => {
      expect(isAuthClassError(new YoutubeApiError(401, null, 'ctx', {}))).toBe(true);
      expect(isAuthClassError(new YoutubeApiError(403, null, 'ctx', {}))).toBe(true);
      expect(isAuthClassError(new YoutubeApiError(400, 'invalid_grant', 'ctx', {}))).toBe(true);
      expect(isAuthClassError(new YoutubeApiError(403, 'forbidden', 'ctx', {}))).toBe(true);
      expect(isAuthClassError(new YoutubeApiError(403, 'insufficientPermissions', 'ctx', {}))).toBe(true);
    });

    it('isAuthClassError returns false for a non-auth failure (e.g. a transient 5xx or rate limiting) and for a non-YoutubeApiError', () => {
      expect(isAuthClassError(new YoutubeApiError(500, null, 'ctx', {}))).toBe(false);
      expect(isAuthClassError(new YoutubeApiError(429, 'rateLimitExceeded', 'ctx', {}))).toBe(false);
      expect(isAuthClassError(new Error('boom'))).toBe(false);
      expect(isAuthClassError(null)).toBe(false);
    });
  });
});
