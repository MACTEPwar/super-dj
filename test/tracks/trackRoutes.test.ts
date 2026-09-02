import express from 'express';
import request from 'supertest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createTrackRouter } from '../../src/tracks/trackRoutes';
import { errorHandler } from '../../src/api/errorHandler';

function buildApp(overrides: { getCurrentUser?: any; uploadService?: any; trackRepository?: any } = {}) {
  const authService: any = {
    getCurrentUser: overrides.getCurrentUser ?? jest.fn().mockResolvedValue({ id: 'user-1', email: 'a@example.com' }),
  };
  const uploadService: any = overrides.uploadService ?? { upload: jest.fn() };
  const trackRepository: any = overrides.trackRepository ?? { listByUser: jest.fn(), findById: jest.fn(), deleteById: jest.fn() };
  const app = express();
  app.use(express.json());
  app.use('/tracks', createTrackRouter(authService, uploadService, trackRepository));
  app.use(errorHandler);
  return { app, uploadService, trackRepository };
}

describe('track routes', () => {
  it('GET /tracks requires authentication', async () => {
    const { app } = buildApp({ getCurrentUser: jest.fn().mockResolvedValue(null) });
    const res = await request(app).get('/tracks');
    expect(res.status).toBe(401);
  });

  it('GET /tracks lists the current user\'s tracks', async () => {
    const trackRepository: any = {
      listByUser: jest.fn().mockResolvedValue([
        { id: 't1', name: 'a', durationSeconds: 10, coverPath: null },
        { id: 't2', name: 'b', durationSeconds: 20, coverPath: '/x/cover.png' },
      ]),
    };
    const { app } = buildApp({ trackRepository });
    const res = await request(app).get('/tracks');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: 't1', name: 'a', durationSeconds: 10, hasCover: false },
      { id: 't2', name: 'b', durationSeconds: 20, hasCover: true },
    ]);
    expect(trackRepository.listByUser).toHaveBeenCalledWith('user-1');
  });

  it('DELETE /tracks/:id returns 403 for a track owned by someone else', async () => {
    const trackRepository: any = { findById: jest.fn().mockResolvedValue({ id: 't1', userId: 'someone-else' }), deleteById: jest.fn() };
    const { app } = buildApp({ trackRepository });
    const res = await request(app).delete('/tracks/t1');
    expect(res.status).toBe(403);
    expect(trackRepository.deleteById).not.toHaveBeenCalled();
  });

  it('DELETE /tracks/:id returns 404 for a track that does not exist', async () => {
    const trackRepository: any = { findById: jest.fn().mockResolvedValue(null), deleteById: jest.fn() };
    const { app } = buildApp({ trackRepository });
    const res = await request(app).delete('/tracks/missing');
    expect(res.status).toBe(404);
  });

  it('DELETE /tracks/:id deletes an owned track', async () => {
    const trackRepository: any = { findById: jest.fn().mockResolvedValue({ id: 't1', userId: 'user-1' }), deleteById: jest.fn() };
    const { app } = buildApp({ trackRepository });
    const res = await request(app).delete('/tracks/t1');
    expect(res.status).toBe(200);
    expect(trackRepository.deleteById).toHaveBeenCalledWith('t1');
  });

  it('POST /tracks rejects a request with no audio file', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/tracks').field('name', 'test');
    expect(res.status).toBe(400);
  });

  it('POST /tracks accepts an audio file and calls the upload service', async () => {
    const uploadService: any = { upload: jest.fn().mockResolvedValue({ id: 't1', name: 'song', durationSeconds: 5, hasCover: false }) };
    const { app } = buildApp({ uploadService });
    const res = await request(app).post('/tracks').attach('audio', Buffer.from('fake-mp3-bytes'), 'song.mp3');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 't1', name: 'song', durationSeconds: 5, hasCover: false });
    expect(uploadService.upload).toHaveBeenCalledWith('user-1', undefined, expect.objectContaining({ originalname: 'song.mp3' }), undefined);
  });

  it('POST /tracks rejects an unsupported audio extension', async () => {
    const uploadService: any = { upload: jest.fn() };
    const { app } = buildApp({ uploadService });
    const res = await request(app).post('/tracks').attach('audio', Buffer.from('data'), 'song.exe');
    expect(res.status).toBe(400);
    expect(uploadService.upload).not.toHaveBeenCalled();
  });

  it('GET /tracks/:id/cover streams the cover file for an owned track', async () => {
    const coverPath = path.join(os.tmpdir(), `cover-test-${Date.now()}.png`);
    await fs.writeFile(coverPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic bytes, minimal
    const trackRepository: any = {
      findById: jest.fn().mockResolvedValue({ id: 't1', userId: 'user-1', coverPath }),
    };
    const { app } = buildApp({ trackRepository });
    const res = await request(app).get('/tracks/t1/cover');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\//);
    await fs.unlink(coverPath);
  });

  it('GET /tracks/:id/cover 404s when the track has no cover', async () => {
    const trackRepository: any = {
      findById: jest.fn().mockResolvedValue({ id: 't1', userId: 'user-1', coverPath: null }),
    };
    const { app } = buildApp({ trackRepository });
    const res = await request(app).get('/tracks/t1/cover');
    expect(res.status).toBe(404);
  });

  it('GET /tracks/:id/cover returns 403 for another user\'s track', async () => {
    const trackRepository: any = {
      findById: jest.fn().mockResolvedValue({ id: 't1', userId: 'someone-else', coverPath: '/x.png' }),
    };
    const { app } = buildApp({ trackRepository });
    const res = await request(app).get('/tracks/t1/cover');
    expect(res.status).toBe(403);
  });
});
