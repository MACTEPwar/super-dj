import express from 'express';
import request from 'supertest';
import { createStreamSessionRouter } from '../../src/stream/streamSessionRoutes';
import { errorHandler } from '../../src/api/errorHandler';
import { ApiError } from '../../src/errors';

function buildApp(streamSessionManager: any, streamManager: any = {}, userId = 'user-1') {
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: userId, email: 'a@example.com' }) };
  const app = express();
  app.use(express.json());
  app.use('/stream-sessions', createStreamSessionRouter(authService, streamSessionManager, streamManager));
  app.use(errorHandler);
  return app;
}

describe('stream session routes', () => {
  it('POST / requires playlistId and destinationIds', async () => {
    const streamSessionManager: any = { create: jest.fn() };
    const res = await request(buildApp(streamSessionManager)).post('/stream-sessions').send({});
    expect(res.status).toBe(400);
    expect(streamSessionManager.create).not.toHaveBeenCalled();
  });

  it('POST / rejects a destinationIds that is not an array of strings', async () => {
    const streamSessionManager: any = { create: jest.fn() };
    const res = await request(buildApp(streamSessionManager)).post('/stream-sessions').send({ playlistId: 'p1', destinationIds: 'not-an-array' });
    expect(res.status).toBe(400);
    expect(streamSessionManager.create).not.toHaveBeenCalled();
  });

  it('POST / rejects an invalid privacyStatus', async () => {
    const streamSessionManager: any = { create: jest.fn() };
    const res = await request(buildApp(streamSessionManager)).post('/stream-sessions').send({ playlistId: 'p1', destinationIds: ['d1'], privacyStatus: 'sortof' });
    expect(res.status).toBe(400);
    expect(streamSessionManager.create).not.toHaveBeenCalled();
  });

  it('POST / rejects an invalid latencyPreference', async () => {
    const streamSessionManager: any = { create: jest.fn() };
    const res = await request(buildApp(streamSessionManager)).post('/stream-sessions').send({ playlistId: 'p1', destinationIds: ['d1'], latencyPreference: 'sortof' });
    expect(res.status).toBe(400);
    expect(streamSessionManager.create).not.toHaveBeenCalled();
  });

  it('POST / creates a session and returns its status', async () => {
    const streamSessionManager: any = {
      create: jest.fn().mockResolvedValue({ id: 's1', playlistId: 'p1', templateId: null, destinations: [{ destinationId: 'd1', status: { state: 'streaming', currentTrack: 'a', nextTrack: null } }] }),
    };
    const res = await request(buildApp(streamSessionManager))
      .post('/stream-sessions')
      .send({ playlistId: 'p1', destinationIds: ['d1'], title: 'My Stream' });
    expect(res.status).toBe(200);
    expect(streamSessionManager.create).toHaveBeenCalledWith('user-1', 'p1', undefined, ['d1'], { title: 'My Stream', description: undefined, privacyStatus: undefined, latencyPreference: undefined });
    expect(res.body.id).toBe('s1');
  });

  it('POST / rejects an empty-string templateId', async () => {
    const streamSessionManager: any = { create: jest.fn() };
    const res = await request(buildApp(streamSessionManager)).post('/stream-sessions').send({ playlistId: 'p1', destinationIds: ['d1'], templateId: '' });
    expect(res.status).toBe(400);
    expect(streamSessionManager.create).not.toHaveBeenCalled();
  });

  it('POST / passes a templateId through when given', async () => {
    const streamSessionManager: any = {
      create: jest.fn().mockResolvedValue({ id: 's1', playlistId: 'p1', templateId: 'tpl-1', destinations: [] }),
    };
    const res = await request(buildApp(streamSessionManager))
      .post('/stream-sessions')
      .send({ playlistId: 'p1', destinationIds: ['d1'], templateId: 'tpl-1' });
    expect(res.status).toBe(200);
    expect(streamSessionManager.create).toHaveBeenCalledWith('user-1', 'p1', 'tpl-1', ['d1'], expect.anything());
  });

  it('POST / passes a valid latencyPreference through', async () => {
    const streamSessionManager: any = {
      create: jest.fn().mockResolvedValue({ id: 's1', playlistId: 'p1', templateId: null, destinations: [] }),
    };
    const res = await request(buildApp(streamSessionManager))
      .post('/stream-sessions')
      .send({ playlistId: 'p1', destinationIds: ['d1'], latencyPreference: 'low' });
    expect(res.status).toBe(200);
    expect(streamSessionManager.create).toHaveBeenCalledWith('user-1', 'p1', undefined, ['d1'], expect.objectContaining({ latencyPreference: 'low' }));
  });

  it('GET / lists sessions for the authenticated user', async () => {
    const streamSessionManager: any = { list: jest.fn().mockResolvedValue([]) };
    const res = await request(buildApp(streamSessionManager)).get('/stream-sessions');
    expect(res.status).toBe(200);
    expect(streamSessionManager.list).toHaveBeenCalledWith('user-1');
  });

  it('GET /:id/status maps a 404 ApiError from the manager', async () => {
    const streamSessionManager: any = { status: jest.fn().mockRejectedValue(new ApiError(404, 'stream session not found')) };
    const res = await request(buildApp(streamSessionManager)).get('/stream-sessions/s1/status');
    expect(res.status).toBe(404);
  });

  it.each(['pause', 'resume', 'next', 'previous', 'stop'] as const)('POST /:id/%s calls the matching manager method', async (action) => {
    const streamSessionManager: any = { [action]: jest.fn().mockResolvedValue({ id: 's1', playlistId: 'p1', destinations: [] }) };
    const res = await request(buildApp(streamSessionManager)).post(`/stream-sessions/s1/${action}`);
    expect(res.status).toBe(200);
    expect(streamSessionManager[action]).toHaveBeenCalledWith('user-1', 's1');
  });

  it('DELETE /:id deletes the session', async () => {
    const streamSessionManager: any = { deleteById: jest.fn().mockResolvedValue(undefined) };
    const res = await request(buildApp(streamSessionManager)).delete('/stream-sessions/s1');
    expect(res.status).toBe(200);
    expect(streamSessionManager.deleteById).toHaveBeenCalledWith('user-1', 's1');
  });

  it('DELETE /:id returns 403 when the session belongs to someone else', async () => {
    const streamSessionManager: any = { deleteById: jest.fn().mockRejectedValue(new ApiError(403, 'not your stream session')) };
    const res = await request(buildApp(streamSessionManager)).delete('/stream-sessions/s1');
    expect(res.status).toBe(403);
  });
});
