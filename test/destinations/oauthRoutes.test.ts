import express from 'express';
import request from 'supertest';
import { createOAuthRouter } from '../../src/destinations/oauthRoutes';
import { errorHandler } from '../../src/api/errorHandler';
import { decrypt } from '../../src/crypto/streamKeyCipher';

const KEY = 'a'.repeat(64);

function buildDeps() {
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: 'user-1', email: 'a@example.com' }) };
  const adapter: any = {
    provider: 'youtube',
    buildAuthUrl: jest.fn().mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?mock=1'),
    exchangeCode: jest.fn().mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 }),
    fetchAccountIdentity: jest.fn().mockResolvedValue({ externalAccountId: 'chan-1', externalAccountName: 'My Channel' }),
    revoke: jest.fn(),
  };
  const oauthStateRepository: any = {
    create: jest.fn().mockResolvedValue({ id: 'state-1', userId: 'user-1', provider: 'youtube', expiresAt: new Date(Date.now() + 60000) }),
    findValid: jest.fn().mockResolvedValue({ id: 'state-1', userId: 'user-1', provider: 'youtube', expiresAt: new Date(Date.now() + 60000) }),
    deleteById: jest.fn(),
  };
  const oauthConnectionRepository: any = { create: jest.fn().mockResolvedValue({ id: 'conn-1' }) };
  const destinationRepository: any = { create: jest.fn().mockResolvedValue({ id: 'dest-1', userId: 'user-1', name: 'My Channel', provider: 'youtube' }) };
  return { authService, adapter, oauthStateRepository, oauthConnectionRepository, destinationRepository };
}

function buildApp(deps: ReturnType<typeof buildDeps>) {
  const app = express();
  app.use(express.json());
  app.use('/destinations', createOAuthRouter(
    deps.authService, { youtube: deps.adapter }, deps.oauthStateRepository, deps.oauthConnectionRepository, deps.destinationRepository, KEY,
  ));
  app.use(errorHandler);
  return app;
}

describe('oauth connect routes', () => {
  it('GET /destinations/:provider/oauth/start requires auth and returns an authUrl', async () => {
    const deps = buildDeps();
    const res = await request(buildApp(deps)).get('/destinations/youtube/oauth/start');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?mock=1' });
    expect(deps.oauthStateRepository.create).toHaveBeenCalledWith('user-1', 'youtube', expect.any(Date));
  });

  it('GET /destinations/:provider/oauth/start 404s for an unregistered provider', async () => {
    const deps = buildDeps();
    const res = await request(buildApp(deps)).get('/destinations/twitch/oauth/start');
    expect(res.status).toBe(404);
  });

  it('GET /destinations/:provider/oauth/callback exchanges the code and creates a destination + connection', async () => {
    const deps = buildDeps();
    const res = await request(buildApp(deps)).get('/destinations/youtube/oauth/callback?code=abc&state=state-1');

    expect(res.status).toBe(200);
    expect(deps.adapter.exchangeCode).toHaveBeenCalledWith('abc');
    expect(deps.destinationRepository.create).toHaveBeenCalledWith({
      userId: 'user-1', name: 'My Channel', provider: 'youtube', rtmpUrl: null, streamKeyEncrypted: null,
    });
    const connectionArgs = deps.oauthConnectionRepository.create.mock.calls[0][0];
    expect(connectionArgs).toMatchObject({ destinationId: 'dest-1', provider: 'youtube', externalAccountId: 'chan-1', externalAccountName: 'My Channel' });
    expect(decrypt(connectionArgs.refreshTokenEncrypted, KEY)).toBe('rt');
    expect(deps.oauthStateRepository.deleteById).toHaveBeenCalledWith('state-1');
  });

  it('GET /destinations/:provider/oauth/callback response tells the opener it connected and closes itself', async () => {
    const deps = buildDeps();
    const res = await request(buildApp(deps)).get('/destinations/youtube/oauth/callback?code=abc&state=state-1');
    expect(res.status).toBe(200);
    expect(res.text).toContain("window.opener.postMessage('super-dj-oauth-connected', '*')");
    expect(res.text).toContain('window.close()');
  });

  it('GET /destinations/:provider/oauth/callback rejects an invalid/expired state', async () => {
    const deps = buildDeps();
    deps.oauthStateRepository.findValid.mockResolvedValue(null);
    const res = await request(buildApp(deps)).get('/destinations/youtube/oauth/callback?code=abc&state=bad');
    expect(res.status).toBe(400);
    expect(deps.adapter.exchangeCode).not.toHaveBeenCalled();
  });

  it('GET /destinations/:provider/oauth/callback requires code and state query params', async () => {
    const deps = buildDeps();
    const res = await request(buildApp(deps)).get('/destinations/youtube/oauth/callback');
    expect(res.status).toBe(400);
    expect(deps.oauthStateRepository.findValid).not.toHaveBeenCalled();
  });

  it('GET /destinations/:provider/oauth/callback 404s for an unregistered provider', async () => {
    const deps = buildDeps();
    const res = await request(buildApp(deps)).get('/destinations/twitch/oauth/callback?code=abc&state=s1');
    expect(res.status).toBe(404);
  });
});
