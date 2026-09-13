import request from 'supertest';
import { MediaMtxAuthRegistry, createMediaMtxAuthApp } from '../../src/stream/mediaMtxAuth';
import { LocalRelaySession } from '../../src/stream/localRelayTarget';

const TOKEN = 'f'.repeat(32);

function session(overrides: Partial<LocalRelaySession> = {}): LocalRelaySession {
  return {
    userId: 'user-1',
    pathToken: TOKEN,
    path: `live/${TOKEN}`,
    publishSecret: 'publish-secret',
    readSecret: 'read-secret',
    publishRtmpUrl: 'rtmp://mediamtx:1935/live',
    publishStreamKey: `${TOKEN}?user=pub&pass=publish-secret`,
    readRtmpUrl: `rtmp://mediamtx:1935/live/${TOKEN}?user=sub&pass=read-secret`,
    hlsBaseUrl: `http://mediamtx:8888/live/${TOKEN}`,
    readAuthorization: `Basic ${Buffer.from('sub:read-secret').toString('base64')}`,
    ...overrides,
  };
}

function registryWithSession() {
  const registry = new MediaMtxAuthRegistry();
  registry.register(session());
  return registry;
}

describe('MediaMtxAuthRegistry', () => {
  it('allows the encoder to publish with the session publish credential', () => {
    expect(registryWithSession().authorize({
      action: 'publish', path: `live/${TOKEN}`, user: 'pub', password: 'publish-secret', protocol: 'rtmp',
    })).toBe(true);
  });

  it('allows a reader with the session read credential', () => {
    expect(registryWithSession().authorize({
      action: 'read', path: `live/${TOKEN}`, user: 'sub', password: 'read-secret', protocol: 'hls',
    })).toBe(true);
  });

  // The reason publish and read carry different secrets at all: a leaked read credential must not
  // be usable to publish over the path and hijack the stream.
  it('refuses to let the read credential publish', () => {
    expect(registryWithSession().authorize({
      action: 'publish', path: `live/${TOKEN}`, user: 'sub', password: 'read-secret', protocol: 'rtmp',
    })).toBe(false);
  });

  it('refuses the publish credential for reading', () => {
    expect(registryWithSession().authorize({
      action: 'read', path: `live/${TOKEN}`, user: 'pub', password: 'publish-secret', protocol: 'hls',
    })).toBe(false);
  });

  it('refuses a wrong password, a wrong username and a wrong-length password', () => {
    const registry = registryWithSession();
    expect(registry.authorize({ action: 'publish', path: `live/${TOKEN}`, user: 'pub', password: 'nope' })).toBe(false);
    expect(registry.authorize({ action: 'publish', path: `live/${TOKEN}`, user: 'admin', password: 'publish-secret' })).toBe(false);
    expect(registry.authorize({ action: 'publish', path: `live/${TOKEN}`, user: 'pub', password: 'publish-secretX' })).toBe(false);
  });

  it('refuses an unregistered path — including one that differs only in its token', () => {
    const registry = registryWithSession();
    expect(registry.authorize({ action: 'read', path: `live/${'e'.repeat(32)}`, user: 'sub', password: 'read-secret' })).toBe(false);
    expect(registry.authorize({ action: 'read', path: 'live', user: 'sub', password: 'read-secret' })).toBe(false);
  });

  // Instant revocation on stop is the whole reason this is an in-memory map rather than a JWT.
  it('refuses everything for a path that has been unregistered', () => {
    const registry = registryWithSession();
    registry.unregister(`live/${TOKEN}`);
    expect(registry.authorize({ action: 'read', path: `live/${TOKEN}`, user: 'sub', password: 'read-secret' })).toBe(false);
    expect(registry.authorize({ action: 'publish', path: `live/${TOKEN}`, user: 'pub', password: 'publish-secret' })).toBe(false);
  });

  it('refuses every action other than publish and read', () => {
    const registry = registryWithSession();
    for (const action of ['playback', 'api', 'metrics', 'pprof', '', undefined]) {
      expect(registry.authorize({ action, path: `live/${TOKEN}`, user: 'sub', password: 'read-secret' })).toBe(false);
    }
  });

  it('refuses a body with non-string or missing fields instead of throwing', () => {
    const registry = registryWithSession();
    expect(registry.authorize({})).toBe(false);
    expect(registry.authorize({ action: 'read', path: 42, user: 'sub', password: 'read-secret' })).toBe(false);
    expect(registry.authorize({ action: 'read', path: `live/${TOKEN}`, user: null, password: ['read-secret'] })).toBe(false);
  });

  it('keeps two concurrent users\' sessions apart', () => {
    const registry = new MediaMtxAuthRegistry();
    const other = 'a'.repeat(32);
    registry.register(session());
    registry.register(session({ userId: 'user-2', pathToken: other, path: `live/${other}`, readSecret: 'other-read' }));
    expect(registry.authorize({ action: 'read', path: `live/${other}`, user: 'sub', password: 'other-read' })).toBe(true);
    // user-1's credential must not open user-2's path.
    expect(registry.authorize({ action: 'read', path: `live/${other}`, user: 'sub', password: 'read-secret' })).toBe(false);
  });
});

describe('createMediaMtxAuthApp', () => {
  const SECRET = 'shared-secret-value';

  it('answers 200 when the registry allows the request', async () => {
    const app = createMediaMtxAuthApp(registryWithSession(), SECRET);
    const res = await request(app).post(`/internal/mediamtx-auth/${SECRET}`)
      .send({ action: 'publish', path: `live/${TOKEN}`, user: 'pub', password: 'publish-secret' });
    expect(res.status).toBe(200);
  });

  // MediaMTX allows on 2xx only (internal/auth/manager.go), so every other outcome MUST be 401.
  it('answers 401 when the registry denies the request', async () => {
    const app = createMediaMtxAuthApp(registryWithSession(), SECRET);
    const res = await request(app).post(`/internal/mediamtx-auth/${SECRET}`)
      .send({ action: 'publish', path: `live/${TOKEN}`, user: 'pub', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('answers 401 for a wrong shared secret without ever consulting the registry', async () => {
    const registry = { authorize: jest.fn().mockReturnValue(true) };
    const app = createMediaMtxAuthApp(registry, SECRET);
    const res = await request(app).post('/internal/mediamtx-auth/guessed')
      .send({ action: 'publish', path: `live/${TOKEN}`, user: 'pub', password: 'publish-secret' });
    expect(res.status).toBe(401);
    expect(registry.authorize).not.toHaveBeenCalled();
  });

  it('answers 401 for a malformed JSON body (fail closed, never 2xx)', async () => {
    const app = createMediaMtxAuthApp(registryWithSession(), SECRET);
    const res = await request(app).post(`/internal/mediamtx-auth/${SECRET}`)
      .set('Content-Type', 'application/json').send('{not json');
    expect(res.status).toBe(401);
  });

  it('exposes nothing else at all', async () => {
    const app = createMediaMtxAuthApp(registryWithSession(), SECRET);
    expect((await request(app).get('/')).status).toBe(404);
    expect((await request(app).get(`/internal/mediamtx-auth/${SECRET}`)).status).toBe(404);
    expect((await request(app).get('/openapi.json')).status).toBe(404);
  });
});
