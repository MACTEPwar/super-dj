import { YoutubeOAuthAdapter } from '../../src/destinations/youtubeOAuthAdapter';
import { YoutubeApiClient } from '../../src/destinations/youtubeApiClient';

function fakeClient(): jest.Mocked<YoutubeApiClient> {
  return {
    exchangeCode: jest.fn().mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 }),
    refreshAccessToken: jest.fn(),
    revoke: jest.fn().mockResolvedValue(undefined),
    getChannel: jest.fn().mockResolvedValue({ id: 'chan-1', title: 'My Channel' }),
    createBroadcast: jest.fn(), createStream: jest.fn(), bind: jest.fn(), transition: jest.fn(), getStreamStatus: jest.fn(), deleteStream: jest.fn(),
  } as any;
}

function buildAdapter(client = fakeClient()) {
  return new YoutubeOAuthAdapter({
    client, clientId: 'client-123', redirectUri: 'https://app.example.com/destinations/youtube/oauth/callback', scope: 'https://www.googleapis.com/auth/youtube',
  });
}

describe('YoutubeOAuthAdapter', () => {
  it('exposes provider = "youtube"', () => {
    expect(buildAdapter().provider).toBe('youtube');
  });

  it('builds an auth URL with the configured client id, redirect uri, scope, and state', () => {
    const url = new URL(buildAdapter().buildAuthUrl('state-abc'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/destinations/youtube/oauth/callback');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/youtube');
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('delegates exchangeCode to the client with the configured redirect uri', async () => {
    const client = fakeClient();
    const tokens = await buildAdapter(client).exchangeCode('code-1');
    expect(client.exchangeCode).toHaveBeenCalledWith('code-1', 'https://app.example.com/destinations/youtube/oauth/callback');
    expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });
  });

  it('fetchAccountIdentity maps the client channel shape to the generic identity shape', async () => {
    const identity = await buildAdapter().fetchAccountIdentity('at');
    expect(identity).toEqual({ externalAccountId: 'chan-1', externalAccountName: 'My Channel' });
  });

  it('delegates revoke to the client', async () => {
    const client = fakeClient();
    await buildAdapter(client).revoke('rt');
    expect(client.revoke).toHaveBeenCalledWith('rt');
  });
});
