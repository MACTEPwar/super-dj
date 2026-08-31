import express from 'express';
import request from 'supertest';
import { createStreamRouter } from '../../src/api/streamRoutes';
import { errorHandler } from '../../src/api/errorHandler';
import { ApiError } from '../../src/errors';

function buildApp(controller: any) {
  const app = express();
  app.use(express.json());
  app.use('/stream', createStreamRouter(controller));
  app.use(errorHandler);
  return app;
}

describe('stream routes', () => {
  it('POST /stream/start calls controller.start and returns status', async () => {
    const controller = { start: jest.fn(), status: jest.fn().mockReturnValue({ state: 'streaming' }) };
    const res = await request(buildApp(controller)).post('/stream/start');

    expect(controller.start).toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: 'streaming' });
  });

  it('maps ApiError thrown by the controller to the right status code', async () => {
    const controller = {
      start: jest.fn(() => { throw new ApiError(409, 'already active'); }),
      status: jest.fn(),
    };
    const res = await request(buildApp(controller)).post('/stream/start');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'already active' });
  });

  it('POST /stream/play requires a name in the body', async () => {
    const controller = { playByName: jest.fn(), status: jest.fn() };
    const res = await request(buildApp(controller)).post('/stream/play').send({});

    expect(res.status).toBe(400);
    expect(controller.playByName).not.toHaveBeenCalled();
  });

  it('POST /stream/play passes the name through', async () => {
    const controller = { playByName: jest.fn(), status: jest.fn().mockReturnValue({ state: 'streaming' }) };
    const res = await request(buildApp(controller)).post('/stream/play').send({ name: 'track-a' });

    expect(controller.playByName).toHaveBeenCalledWith('track-a');
    expect(res.status).toBe(200);
  });

  it('GET /stream/status returns the controller status', async () => {
    const controller = { status: jest.fn().mockReturnValue({ state: 'idle' }) };
    const res = await request(buildApp(controller)).get('/stream/status');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: 'idle' });
  });
});
