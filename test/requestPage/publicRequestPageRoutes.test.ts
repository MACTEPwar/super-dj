import express from 'express';
import request from 'supertest';
import { createPublicRequestPageRouter } from '../../src/requestPage/publicRequestPageRoutes';
import { errorHandler } from '../../src/api/errorHandler';

const TOKEN = '0123456789abcdef0123456789abcdef';

function buildApp(opts: { state?: string; rules?: any[]; userFound?: boolean } = {}) {
  const deps = {
    users: { findByRequestPageToken: jest.fn(async (t: string) => (opts.userFound !== false && t === TOKEN ? { id: 'u1' } : null)) },
    streams: { status: jest.fn(() => ({ local: { state: opts.state ?? 'streaming', playlistId: 'p1' }, destinations: [] })) },
    playlists: {
      findById: jest.fn(async () => ({ id: 'p1', userId: 'u1', name: 'Evening set' })),
      listTracks: jest.fn(async () => [
        { id: '11111111-1111-1111-1111-111111111111', name: 'First', audioPath: '/secret/a.mp3', coverPath: '/secret/a.png', overlayOverride: null, durationSeconds: 180 },
        { id: '22222222-2222-2222-2222-222222222222', name: 'Second', audioPath: '/secret/b.mp3', coverPath: null, overlayOverride: null, durationSeconds: null },
      ]),
    },
    rules: { listEnabledByUser: jest.fn(async () => opts.rules ?? []) },
  };
  const app = express();
  app.use('/public/request-page', createPublicRequestPageRouter(deps as any));
  app.use(errorHandler);
  return { app, deps };
}

describe('GET /public/request-page/:token', () => {
  it('404s a malformed token without touching the database', async () => {
    const { app, deps } = buildApp();
    const res = await request(app).get('/public/request-page/not-a-token');
    expect(res.status).toBe(404);
    expect(deps.users.findByRequestPageToken).not.toHaveBeenCalled();
  });

  it('404s an unknown token with the same body as a malformed one', async () => {
    const { app } = buildApp({ userFound: false });
    const unknown = await request(app).get(`/public/request-page/${TOKEN}`);
    const malformed = await request(app).get('/public/request-page/zz');
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(malformed.body);
  });

  it.each(['idle', 'starting', 'error'])('reports not live for state %s', async (state) => {
    const { app, deps } = buildApp({ state });
    const res = await request(app).get(`/public/request-page/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ live: false });
    expect(deps.playlists.listTracks).not.toHaveBeenCalled();
  });

  it.each(['streaming', 'paused', 'reconnecting'])('reports live for state %s with only public fields', async (state) => {
    const { app } = buildApp({ state });
    const res = await request(app).get(`/public/request-page/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      live: true,
      playlistName: 'Evening set',
      tracks: [
        { id: '11111111-1111-1111-1111-111111111111', name: 'First', durationSeconds: 180 },
        { id: '22222222-2222-2222-2222-222222222222', name: 'Second', durationSeconds: null },
      ],
      request: null,
    });
    expect(JSON.stringify(res.body)).not.toContain('/secret/');
  });

  it('advertises the cheapest enabled libraryTrackRequest rule and ignores other types', async () => {
    const { app } = buildApp({ rules: [
      { actionType: 'songRequest', commandKeyword: 'song', minAmount: 10 },
      { actionType: 'libraryTrackRequest', commandKeyword: 'pick', minAmount: 100 },
      { actionType: 'libraryTrackRequest', commandKeyword: 'cheap', minAmount: 50 },
    ] });
    const res = await request(app).get(`/public/request-page/${TOKEN}`);
    expect(res.body.request).toEqual({ keyword: 'cheap', minAmount: 50 });
  });

  it('sets no-store and no-referrer on every response, including 404', async () => {
    const { app } = buildApp();
    for (const path of [`/public/request-page/${TOKEN}`, '/public/request-page/bad']) {
      const res = await request(app).get(path);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    }
  });
});
