import express from 'express';
import request from 'supertest';
import { createDestinationRouter } from '../../src/destinations/destinationRoutes';
import { errorHandler } from '../../src/api/errorHandler';
import { ApiError } from '../../src/errors';

const KEY = 'a'.repeat(64);

function buildApp(destinationRepository: any, streamManager: any = { stop: jest.fn().mockResolvedValue(undefined) }, userId = 'user-1') {
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: userId, email: 'a@example.com' }) };
  const app = express();
  app.use(express.json());
  app.use('/destinations', createDestinationRouter(authService, destinationRepository, KEY, streamManager));
  app.use(errorHandler);
  return app;
}

describe('destination routes', () => {
  it('POST /destinations creates a destination with the stream key encrypted, and never echoes it back', async () => {
    const destinationRepository: any = {
      create: jest.fn(async (data: any) => ({ id: 'd1', ...data, provider: 'youtube', createdAt: new Date() })),
    };
    const res = await request(buildApp(destinationRepository)).post('/destinations').send({
      name: 'My YouTube', rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2', streamKey: 'abcd-1234',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'd1', name: 'My YouTube', rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2', provider: 'youtube' });
    expect(res.body.streamKey).toBeUndefined();
    expect(res.body.streamKeyEncrypted).toBeUndefined();

    const createArgs = destinationRepository.create.mock.calls[0][0];
    expect(createArgs.streamKeyEncrypted).not.toBe('abcd-1234');
    expect(createArgs.userId).toBe('user-1');
  });

  it('POST /destinations requires name, rtmpUrl, and streamKey', async () => {
    const destinationRepository: any = { create: jest.fn() };
    const res = await request(buildApp(destinationRepository)).post('/destinations').send({ name: 'X' });
    expect(res.status).toBe(400);
    expect(destinationRepository.create).not.toHaveBeenCalled();
  });

  it('GET /destinations never includes the encrypted key', async () => {
    const destinationRepository: any = {
      listByUser: jest.fn().mockResolvedValue([
        { id: 'd1', name: 'X', rtmpUrl: 'rtmp://x', provider: 'youtube', streamKeyEncrypted: 'secret-blob' },
      ]),
    };
    const res = await request(buildApp(destinationRepository)).get('/destinations');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'd1', name: 'X', rtmpUrl: 'rtmp://x', provider: 'youtube' }]);
  });

  it('DELETE /destinations/:id returns 403 for someone else\'s destination', async () => {
    const destinationRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'd1', userId: 'someone-else' }), deleteById: jest.fn() };
    const res = await request(buildApp(destinationRepository)).delete('/destinations/d1');
    expect(res.status).toBe(403);
    expect(destinationRepository.deleteById).not.toHaveBeenCalled();
  });

  it('DELETE /destinations/:id deletes an owned destination', async () => {
    const destinationRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'd1', userId: 'user-1' }), deleteById: jest.fn() };
    const res = await request(buildApp(destinationRepository)).delete('/destinations/d1');
    expect(res.status).toBe(200);
    expect(destinationRepository.deleteById).toHaveBeenCalledWith('d1');
  });

  it('DELETE /destinations/:id stops the running stream before deleting the row', async () => {
    const destinationRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'd1', userId: 'user-1' }), deleteById: jest.fn() };
    const streamManager: any = { stop: jest.fn().mockResolvedValue(undefined) };
    const res = await request(buildApp(destinationRepository, streamManager)).delete('/destinations/d1');
    expect(res.status).toBe(200);
    expect(streamManager.stop).toHaveBeenCalledWith('d1');
    expect(destinationRepository.deleteById).toHaveBeenCalledWith('d1');
  });

  it('DELETE /destinations/:id still deletes when stop() reports 409 (no active stream)', async () => {
    const destinationRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'd1', userId: 'user-1' }), deleteById: jest.fn() };
    const streamManager: any = { stop: jest.fn().mockRejectedValue(new ApiError(409, 'stream is not active')) };
    const res = await request(buildApp(destinationRepository, streamManager)).delete('/destinations/d1');
    expect(res.status).toBe(200);
    expect(destinationRepository.deleteById).toHaveBeenCalledWith('d1');
  });

  it('DELETE /destinations/:id propagates a non-409 stop() failure and does not delete', async () => {
    const destinationRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'd1', userId: 'user-1' }), deleteById: jest.fn() };
    const streamManager: any = { stop: jest.fn().mockRejectedValue(new ApiError(500, 'teardown failed')) };
    const res = await request(buildApp(destinationRepository, streamManager)).delete('/destinations/d1');
    expect(res.status).toBe(500);
    expect(destinationRepository.deleteById).not.toHaveBeenCalled();
  });
});
