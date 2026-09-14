import express from 'express';
import request from 'supertest';
import { createLocalStreamRouter } from '../../src/stream/localStreamRoutes';
import { errorHandler } from '../../src/api/errorHandler';
import { ApiError } from '../../src/errors';

const STATUS = {
  local: {
    state: 'streaming', currentTrack: 'a', nextTrack: 'b',
    previewReady: true, playlistId: 'p1', templateId: null, startedAt: '2026-09-14T10:00:00.000Z',
  },
  destinations: [],
};

function buildApp(localStreamManager: any, userId = 'user-1') {
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: userId, email: 'a@example.com' }) };
  const previewFetch = jest.fn();
  const app = express();
  app.use(express.json());
  app.use('/local-stream', createLocalStreamRouter(authService, localStreamManager, previewFetch));
  app.use(errorHandler);
  return app;
}

describe('local stream control routes', () => {
  it('POST /start requires playlistId in the body', async () => {
    const manager: any = { start: jest.fn() };
    const res = await request(buildApp(manager)).post('/local-stream/start').send({});
    expect(res.status).toBe(400);
    expect(manager.start).not.toHaveBeenCalled();
  });

  it('POST /start passes the authenticated user, the playlist and no template by default', async () => {
    const manager: any = { start: jest.fn().mockResolvedValue(undefined), status: jest.fn().mockReturnValue(STATUS) };
    const res = await request(buildApp(manager, 'user-9')).post('/local-stream/start').send({ playlistId: 'p1' });
    expect(res.status).toBe(200);
    expect(manager.start).toHaveBeenCalledWith('user-9', 'p1', {
      templateId: undefined,
      destinationIds: undefined,
      meta: { title: undefined, description: undefined, privacyStatus: undefined, latencyPreference: undefined },
    });
    expect(res.body).toEqual(STATUS);
  });

  it('POST /start passes a templateId through and rejects an empty-string one', async () => {
    const manager: any = { start: jest.fn().mockResolvedValue(undefined), status: jest.fn().mockReturnValue(STATUS) };
    const app = buildApp(manager);
    expect((await request(app).post('/local-stream/start').send({ playlistId: 'p1', templateId: '' })).status).toBe(400);
    expect((await request(app).post('/local-stream/start').send({ playlistId: 'p1', templateId: 'tpl-1' })).status).toBe(200);
    expect(manager.start).toHaveBeenCalledWith('user-1', 'p1', {
      templateId: 'tpl-1',
      destinationIds: undefined,
      meta: { title: undefined, description: undefined, privacyStatus: undefined, latencyPreference: undefined },
    });
  });

  it.each([
    ['stop', 'stop'], ['pause', 'pause'], ['resume', 'resume'], ['next', 'next'], ['previous', 'previous'],
  ])('POST /%s delegates to the manager for the authenticated user and returns the new status', async (route, method) => {
    const manager: any = { [method]: jest.fn().mockResolvedValue(undefined), status: jest.fn().mockReturnValue(STATUS) };
    // .send({}) (not a bare .post()) so supertest sets Content-Type: application/json — required
    // by requireJsonRequest below, which exists specifically so these no-id control routes aren't
    // a one-click cross-site POST target (see requireJsonRequest's doc comment in the route file).
    const res = await request(buildApp(manager, 'user-3')).post(`/local-stream/${route}`).send({});
    expect(res.status).toBe(200);
    expect(manager[method]).toHaveBeenCalledWith('user-3');
    expect(res.body).toEqual(STATUS);
  });

  it.each(['stop', 'pause', 'resume', 'next', 'previous', 'play'])(
    'POST /%s rejects a request that is not application/json, so a plain cross-site form POST cannot trigger it',
    async (route) => {
      const manager: any = { [route]: jest.fn(), playByName: jest.fn(), status: jest.fn().mockReturnValue(STATUS) };
      const res = await request(buildApp(manager))
        .post(`/local-stream/${route}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('x=1');
      expect(res.status).toBe(400);
      expect(manager[route]).not.toHaveBeenCalled();
      expect(manager.playByName).not.toHaveBeenCalled();
    },
  );

  it('POST /play requires name in the body', async () => {
    const manager: any = { playByName: jest.fn() };
    const res = await request(buildApp(manager)).post('/local-stream/play').send({});
    expect(res.status).toBe(400);
    expect(manager.playByName).not.toHaveBeenCalled();
  });

  it('POST /play inserts the named track next', async () => {
    const manager: any = { playByName: jest.fn(), status: jest.fn().mockReturnValue(STATUS) };
    const res = await request(buildApp(manager)).post('/local-stream/play').send({ name: 'a' });
    expect(res.status).toBe(200);
    expect(manager.playByName).toHaveBeenCalledWith('user-1', 'a');
  });

  it('maps a 409 from the manager (nothing active) straight through', async () => {
    const manager: any = { next: jest.fn().mockRejectedValue(new ApiError(409, 'local stream is not active')) };
    const res = await request(buildApp(manager)).post('/local-stream/next').send({});
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'local stream is not active' });
  });

  it('maps a 429 from the per-host cap straight through', async () => {
    const manager: any = { start: jest.fn().mockRejectedValue(new ApiError(429, 'too many local streams are running on this host; try again later')) };
    const res = await request(buildApp(manager)).post('/local-stream/start').send({ playlistId: 'p1' });
    expect(res.status).toBe(429);
  });

  it('GET /status returns this user\'s own status', async () => {
    const manager: any = { status: jest.fn().mockReturnValue(STATUS) };
    const res = await request(buildApp(manager, 'user-4')).get('/local-stream/status');
    expect(res.status).toBe(200);
    expect(manager.status).toHaveBeenCalledWith('user-4');
    expect(res.body).toEqual(STATUS);
  });

  it('requires authentication on every route', async () => {
    const authService: any = { getCurrentUser: jest.fn().mockResolvedValue(null) };
    const app = express();
    app.use(express.json());
    app.use('/local-stream', createLocalStreamRouter(authService, { status: jest.fn() } as any, jest.fn()));
    app.use(errorHandler);
    for (const path of ['/local-stream/status', '/local-stream/preview/index.m3u8']) {
      expect((await request(app).get(path)).status).toBe(401);
    }
    expect((await request(app).post('/local-stream/stop')).status).toBe(401);
  });
});

describe('local stream destination toggles', () => {
  it('PUT /destinations/:id turns a forward on for the authenticated user', async () => {
    const manager: any = { setDestinationDesired: jest.fn().mockResolvedValue(STATUS) };
    const res = await request(buildApp(manager, 'user-7'))
      .put('/local-stream/destinations/dest-1').send({ desired: 'on' });
    expect(res.status).toBe(200);
    expect(manager.setDestinationDesired).toHaveBeenCalledWith('user-7', 'dest-1', 'on');
    expect(res.body).toEqual(STATUS);
  });

  it('PUT /destinations/:id rejects a body that is not on/off', async () => {
    const manager: any = { setDestinationDesired: jest.fn() };
    const app = buildApp(manager);
    for (const desired of [undefined, '', 'yes', true, 1]) {
      const res = await request(app).put('/local-stream/destinations/dest-1').send({ desired });
      expect(res.status).toBe(400);
    }
    expect(manager.setDestinationDesired).not.toHaveBeenCalled();
  });

  // Same reasoning as the POST routes: these no-id-in-the-URL routes have no accidental CSRF token,
  // so requiring JSON is what forces a preflight the CORS policy has to approve.
  it('PUT /destinations/:id rejects a request that is not application/json', async () => {
    const manager: any = { setDestinationDesired: jest.fn() };
    const res = await request(buildApp(manager))
      .put('/local-stream/destinations/dest-1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('desired=on');
    expect(res.status).toBe(400);
    expect(manager.setDestinationDesired).not.toHaveBeenCalled();
  });

  it('passes a 404/403 from the manager straight through', async () => {
    const manager: any = { setDestinationDesired: jest.fn().mockRejectedValue(new ApiError(403, 'not your destination')) };
    const res = await request(buildApp(manager)).put('/local-stream/destinations/dest-1').send({ desired: 'on' });
    expect(res.status).toBe(403);
  });
});

describe('POST /local-stream/start options', () => {
  it('passes pre-checked destinations and broadcast metadata through', async () => {
    const manager: any = { start: jest.fn().mockResolvedValue(undefined), status: jest.fn().mockReturnValue(STATUS) };
    const res = await request(buildApp(manager, 'user-2')).post('/local-stream/start').send({
      playlistId: 'p1', templateId: 'tpl-1', destinationIds: ['d1', 'd2'],
      title: 'Late night', description: 'chill', privacyStatus: 'unlisted', latencyPreference: 'low',
    });
    expect(res.status).toBe(200);
    expect(manager.start).toHaveBeenCalledWith('user-2', 'p1', {
      templateId: 'tpl-1',
      destinationIds: ['d1', 'd2'],
      meta: { title: 'Late night', description: 'chill', privacyStatus: 'unlisted', latencyPreference: 'low' },
    });
  });

  it('starts with no destinations at all — a fully valid running state', async () => {
    const manager: any = { start: jest.fn().mockResolvedValue(undefined), status: jest.fn().mockReturnValue(STATUS) };
    const res = await request(buildApp(manager)).post('/local-stream/start').send({ playlistId: 'p1' });
    expect(res.status).toBe(200);
    expect(manager.start).toHaveBeenCalledWith('user-1', 'p1', {
      templateId: undefined, destinationIds: undefined,
      meta: { title: undefined, description: undefined, privacyStatus: undefined, latencyPreference: undefined },
    });
  });

  it.each([
    [{ destinationIds: 'd1' }],
    [{ destinationIds: [1] }],
    [{ destinationIds: ['d1', 'd1'] }],
    [{ title: 5 }],
    [{ description: {} }],
    [{ privacyStatus: 'semi-public' }],
    [{ latencyPreference: 'instant' }],
  ])('rejects invalid start option %j', async (bad) => {
    const manager: any = { start: jest.fn() };
    const res = await request(buildApp(manager)).post('/local-stream/start').send({ playlistId: 'p1', ...bad });
    expect(res.status).toBe(400);
    expect(manager.start).not.toHaveBeenCalled();
  });
});
