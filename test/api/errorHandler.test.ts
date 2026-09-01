import express from 'express';
import request from 'supertest';
import multer from 'multer';
import { errorHandler, wrapAsync } from '../../src/api/errorHandler';
import { ApiError } from '../../src/errors';

function buildApp(err: unknown) {
  const app = express();
  app.get('/boom', wrapAsync(async () => { throw err; }));
  app.use(errorHandler);
  return app;
}

describe('errorHandler', () => {
  it('maps an ApiError to its own status and message', async () => {
    const res = await request(buildApp(new ApiError(403, 'not yours'))).get('/boom');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'not yours' });
  });

  it('maps a MulterError (e.g. an oversized upload) to 400, not 500', async () => {
    const res = await request(buildApp(new multer.MulterError('LIMIT_FILE_SIZE', 'audio'))).get('/boom');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('File too large');
  });

  it('falls back to a generic 500 for an unknown error', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(buildApp(new Error('kaboom'))).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal server error' });
    spy.mockRestore();
  });
});
