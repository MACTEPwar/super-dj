import express from 'express';
import request from 'supertest';
import { createStreamRouter } from '../../src/stream/streamRoutes';
import { errorHandler } from '../../src/api/errorHandler';
import { ApiError } from '../../src/errors';

function buildApp(streamManager: any, destinationRepository: any, userId = 'user-1') {
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: userId, email: 'a@example.com' }) };
  const app = express();
  app.use(express.json());
  app.use('/destinations/:destinationId/stream', createStreamRouter(authService, streamManager, destinationRepository));
  app.use(errorHandler);
  return app;
}

function ownedDestination(userId = 'user-1') {
  return { findById: jest.fn().mockResolvedValue({ id: 'dest-1', userId }) };
}

describe('per-destination stream routes', () => {
  it('POST .../start requires playlistId in the body', async () => {
    const streamManager: any = { start: jest.fn() };
    const res = await request(buildApp(streamManager, ownedDestination())).post('/destinations/dest-1/stream/start').send({});
    expect(res.status).toBe(400);
    expect(streamManager.start).not.toHaveBeenCalled();
  });

  it('POST .../start calls streamManager.start with the destination and playlist ids', async () => {
    const streamManager: any = { start: jest.fn().mockResolvedValue(undefined), status: jest.fn().mockReturnValue({ state: 'streaming', currentTrack: 'a', nextTrack: 'b' }) };
    const res = await request(buildApp(streamManager, ownedDestination())).post('/destinations/dest-1/stream/start').send({ playlistId: 'p1' });
    expect(res.status).toBe(200);
    expect(streamManager.start).toHaveBeenCalledWith('dest-1', 'p1', { title: undefined, description: undefined, privacyStatus: undefined, latencyPreference: undefined });
    expect(res.body).toEqual({ state: 'streaming', currentTrack: 'a', nextTrack: 'b' });
  });

  it('POST .../start rejects an invalid privacyStatus', async () => {
    const streamManager: any = { start: jest.fn() };
    const res = await request(buildApp(streamManager, ownedDestination())).post('/destinations/dest-1/stream/start').send({ playlistId: 'p1', privacyStatus: 'sortof' });
    expect(res.status).toBe(400);
    expect(streamManager.start).not.toHaveBeenCalled();
  });

  it('POST .../start rejects an invalid latencyPreference', async () => {
    const streamManager: any = { start: jest.fn() };
    const res = await request(buildApp(streamManager, ownedDestination())).post('/destinations/dest-1/stream/start').send({ playlistId: 'p1', latencyPreference: 'sortof' });
    expect(res.status).toBe(400);
    expect(streamManager.start).not.toHaveBeenCalled();
  });

  it('POST .../start passes a valid latencyPreference through', async () => {
    const streamManager: any = { start: jest.fn().mockResolvedValue(undefined), status: jest.fn().mockReturnValue({ state: 'streaming', currentTrack: 'a', nextTrack: 'b' }) };
    const res = await request(buildApp(streamManager, ownedDestination())).post('/destinations/dest-1/stream/start').send({ playlistId: 'p1', latencyPreference: 'ultraLow' });
    expect(res.status).toBe(200);
    expect(streamManager.start).toHaveBeenCalledWith('dest-1', 'p1', expect.objectContaining({ latencyPreference: 'ultraLow' }));
  });

  it('returns 403 for a destination owned by someone else', async () => {
    const streamManager: any = { start: jest.fn() };
    const res = await request(buildApp(streamManager, ownedDestination('someone-else'))).post('/destinations/dest-1/stream/start').send({ playlistId: 'p1' });
    expect(res.status).toBe(403);
    expect(streamManager.start).not.toHaveBeenCalled();
  });

  it('returns 404 for a destination that does not exist', async () => {
    const streamManager: any = { start: jest.fn() };
    const destinationRepository: any = { findById: jest.fn().mockResolvedValue(null) };
    const res = await request(buildApp(streamManager, destinationRepository)).post('/destinations/dest-1/stream/start').send({ playlistId: 'p1' });
    expect(res.status).toBe(404);
  });

  it('POST .../next maps a 409 ApiError from the manager', async () => {
    const streamManager: any = { next: jest.fn().mockRejectedValue(new ApiError(409, 'stream is not active')) };
    const res = await request(buildApp(streamManager, ownedDestination())).post('/destinations/dest-1/stream/next');
    expect(res.status).toBe(409);
  });

  it('POST .../play requires name in the body', async () => {
    const streamManager: any = { playByName: jest.fn() };
    const res = await request(buildApp(streamManager, ownedDestination())).post('/destinations/dest-1/stream/play').send({});
    expect(res.status).toBe(400);
    expect(streamManager.playByName).not.toHaveBeenCalled();
  });

  it('GET .../status returns the manager\'s status for this destination', async () => {
    const streamManager: any = { status: jest.fn().mockReturnValue({ state: 'idle', currentTrack: null, nextTrack: null }) };
    const res = await request(buildApp(streamManager, ownedDestination())).get('/destinations/dest-1/stream/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: 'idle', currentTrack: null, nextTrack: null });
    expect(streamManager.status).toHaveBeenCalledWith('dest-1');
  });
});
