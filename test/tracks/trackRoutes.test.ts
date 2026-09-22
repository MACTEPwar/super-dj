import express from 'express';
import request from 'supertest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createTrackRouter } from '../../src/tracks/trackRoutes';
import { errorHandler } from '../../src/api/errorHandler';
import { MediaSearchError } from '../../src/media/mediaSearchClient';
import { ApiError } from '../../src/errors';

function buildApp(overrides: { getCurrentUser?: any; uploadService?: any; trackRepository?: any; trackPreviewService?: any } = {}) {
  const authService: any = {
    getCurrentUser: overrides.getCurrentUser ?? jest.fn().mockResolvedValue({ id: 'user-1', email: 'a@example.com' }),
  };
  const uploadService: any = overrides.uploadService ?? { upload: jest.fn() };
  const trackRepository: any = overrides.trackRepository ?? { listByUser: jest.fn(), findById: jest.fn(), deleteById: jest.fn() };
  const trackPreviewService: any = overrides.trackPreviewService ?? { search: jest.fn(), getPreviewPath: jest.fn(), confirm: jest.fn(), discard: jest.fn() };
  const app = express();
  app.use(express.json());
  app.use('/tracks', createTrackRouter(authService, uploadService, trackRepository, trackPreviewService));
  app.use(errorHandler);
  return { app, uploadService, trackRepository, trackPreviewService };
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
        { id: 't1', name: 'a', durationSeconds: 10, coverPath: null, overlayOverride: null },
        { id: 't2', name: 'b', durationSeconds: 20, coverPath: '/x/cover.png', overlayOverride: { color: { mode: 'solid', color: '#ff0000' } } },
      ]),
    };
    const { app } = buildApp({ trackRepository });
    const res = await request(app).get('/tracks');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: 't1', name: 'a', durationSeconds: 10, hasCover: false, overlayOverride: null },
      { id: 't2', name: 'b', durationSeconds: 20, hasCover: true, overlayOverride: { color: { mode: 'solid', color: '#ff0000' } } },
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

  it('POST /tracks decodes a non-ASCII (e.g. Cyrillic) filename correctly', async () => {
    const uploadService: any = { upload: jest.fn().mockResolvedValue({ id: 't1', name: 'Ммм', durationSeconds: 5, hasCover: false }) };
    const { app } = buildApp({ uploadService });
    const res = await request(app).post('/tracks').attach('audio', Buffer.from('fake-mp3-bytes'), 'Ммм...mp3');
    expect(res.status).toBe(200);
    expect(uploadService.upload).toHaveBeenCalledWith('user-1', undefined, expect.objectContaining({ originalname: 'Ммм...mp3' }), undefined);
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

  it('PATCH /tracks/:id sets overlayOverride for the owner', async () => {
    const trackRepository: any = {
      findById: jest.fn().mockResolvedValue({ id: 't1', userId: 'user-1' }),
      updateOverlayOverride: jest.fn().mockResolvedValue(undefined),
    };
    const { app } = buildApp({ trackRepository });
    const res = await request(app).patch('/tracks/t1').send({ overlayOverride: { color: { mode: 'solid', color: '#ff0000' } } });
    expect(res.status).toBe(200);
    expect(trackRepository.updateOverlayOverride).toHaveBeenCalledWith('t1', { color: { mode: 'solid', color: '#ff0000' } });
  });

  it('PATCH /tracks/:id 400s on an invalid overlayOverride shape', async () => {
    const trackRepository: any = {
      findById: jest.fn().mockResolvedValue({ id: 't1', userId: 'user-1' }),
      updateOverlayOverride: jest.fn().mockResolvedValue(undefined),
    };
    const { app } = buildApp({ trackRepository });
    const res = await request(app).patch('/tracks/t1').send({ overlayOverride: { color: { mode: 'solid', color: 'not-a-hex-color' } } });
    expect(res.status).toBe(400);
    expect(trackRepository.updateOverlayOverride).not.toHaveBeenCalled();
  });

  it('PATCH /tracks/:id 403s for a track owned by someone else', async () => {
    const trackRepository: any = {
      findById: jest.fn().mockResolvedValue({ id: 't1', userId: 'someone-else' }),
      updateOverlayOverride: jest.fn().mockResolvedValue(undefined),
    };
    const { app } = buildApp({ trackRepository });
    const res = await request(app).patch('/tracks/t1').send({ overlayOverride: null });
    expect(res.status).toBe(403);
    expect(trackRepository.updateOverlayOverride).not.toHaveBeenCalled();
  });

  it('PATCH /tracks/:id 404s for a track that does not exist', async () => {
    const trackRepository: any = {
      findById: jest.fn().mockResolvedValue(null),
      updateOverlayOverride: jest.fn().mockResolvedValue(undefined),
    };
    const { app } = buildApp({ trackRepository });
    const res = await request(app).patch('/tracks/missing').send({ overlayOverride: null });
    expect(res.status).toBe(404);
  });

  it('PATCH /tracks/:id with overlayOverride: null clears it', async () => {
    const trackRepository: any = {
      findById: jest.fn().mockResolvedValue({ id: 't1', userId: 'user-1' }),
      updateOverlayOverride: jest.fn().mockResolvedValue(undefined),
    };
    const { app } = buildApp({ trackRepository });
    const res = await request(app).patch('/tracks/t1').send({ overlayOverride: null });
    expect(res.status).toBe(200);
    expect(trackRepository.updateOverlayOverride).toHaveBeenCalledWith('t1', null);
  });

  it('PATCH /tracks/:id 400s when overlayOverride is missing from the body', async () => {
    const trackRepository: any = {
      findById: jest.fn().mockResolvedValue({ id: 't1', userId: 'user-1' }),
      updateOverlayOverride: jest.fn().mockResolvedValue(undefined),
    };
    const { app } = buildApp({ trackRepository });
    const res = await request(app).patch('/tracks/t1').send({});
    expect(res.status).toBe(400);
    expect(trackRepository.updateOverlayOverride).not.toHaveBeenCalled();
  });
});

describe('POST /tracks/search-preview', () => {
  it('400s when query is missing or not a string', async () => {
    const { app, trackPreviewService } = buildApp();
    const res = await request(app).post('/tracks/search-preview').send({});
    expect(res.status).toBe(400);
    expect(trackPreviewService.search).not.toHaveBeenCalled();
  });

  it('400s when query is an empty string', async () => {
    const { app, trackPreviewService } = buildApp();
    const res = await request(app).post('/tracks/search-preview').send({ query: '   ' });
    expect(res.status).toBe(400);
    expect(trackPreviewService.search).not.toHaveBeenCalled();
  });

  it('200s with the previewId on success', async () => {
    const trackPreviewService: any = { search: jest.fn().mockResolvedValue({ previewId: 'p1' }) };
    const { app } = buildApp({ trackPreviewService });
    const res = await request(app).post('/tracks/search-preview').send({ query: 'Blur - Song 2' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ previewId: 'p1' });
    expect(trackPreviewService.search).toHaveBeenCalledWith('user-1', 'Blur - Song 2');
  });

  it('maps a MediaSearchError from the service to 502 with its message', async () => {
    const trackPreviewService: any = { search: jest.fn().mockRejectedValue(new MediaSearchError('media search service returned 502: not found')) };
    const { app } = buildApp({ trackPreviewService });
    const res = await request(app).post('/tracks/search-preview').send({ query: 'nonexistent' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('media search service returned 502: not found');
  });
});

describe('GET /tracks/preview/:previewId', () => {
  it('streams the preview file for its owner', async () => {
    const trackPreviewService: any = { getPreviewPath: jest.fn().mockResolvedValue(__filename) };
    const { app } = buildApp({ trackPreviewService });
    const res = await request(app).get('/tracks/preview/p1');
    expect(res.status).toBe(200);
    expect(trackPreviewService.getPreviewPath).toHaveBeenCalledWith('user-1', 'p1');
  });

  it('404s when the service throws 404', async () => {
    const trackPreviewService: any = { getPreviewPath: jest.fn().mockRejectedValue(new ApiError(404, 'preview not found or expired')) };
    const { app } = buildApp({ trackPreviewService });
    const res = await request(app).get('/tracks/preview/missing');
    expect(res.status).toBe(404);
  });
});

describe('POST /tracks/from-preview/:previewId', () => {
  it('confirms the preview and returns the resulting track summary', async () => {
    const trackPreviewService: any = { confirm: jest.fn().mockResolvedValue({ id: 't1', name: 'My Song', durationSeconds: 10, hasCover: false }) };
    const { app } = buildApp({ trackPreviewService });
    const res = await request(app).post('/tracks/from-preview/p1').field('name', 'My Song');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 't1', name: 'My Song', durationSeconds: 10, hasCover: false });
    expect(trackPreviewService.confirm).toHaveBeenCalledWith('user-1', 'p1', 'My Song', undefined);
  });

  it('passes an attached cover file through', async () => {
    const trackPreviewService: any = { confirm: jest.fn().mockResolvedValue({ id: 't1', name: 'x', durationSeconds: 1, hasCover: true }) };
    const { app } = buildApp({ trackPreviewService });
    await request(app).post('/tracks/from-preview/p1').attach('cover', Buffer.from('fake-png'), 'cover.png');
    expect(trackPreviewService.confirm).toHaveBeenCalledWith('user-1', 'p1', undefined, expect.objectContaining({ originalname: 'cover.png' }));
  });

  it('rejects an unsupported cover format', async () => {
    const { app, trackPreviewService } = buildApp();
    const res = await request(app).post('/tracks/from-preview/p1').attach('cover', Buffer.from('data'), 'cover.gif');
    expect(res.status).toBe(400);
    expect(trackPreviewService.confirm).not.toHaveBeenCalled();
  });

  it('404s when the service throws 404', async () => {
    const trackPreviewService: any = { confirm: jest.fn().mockRejectedValue(new ApiError(404, 'preview not found or expired')) };
    const { app } = buildApp({ trackPreviewService });
    const res = await request(app).post('/tracks/from-preview/missing');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /tracks/preview/:previewId', () => {
  it('discards an owned preview', async () => {
    const trackPreviewService: any = { discard: jest.fn().mockResolvedValue(undefined) };
    const { app } = buildApp({ trackPreviewService });
    const res = await request(app).delete('/tracks/preview/p1');
    expect(res.status).toBe(200);
    expect(trackPreviewService.discard).toHaveBeenCalledWith('user-1', 'p1');
  });

  it('404s when the service throws 404', async () => {
    const trackPreviewService: any = { discard: jest.fn().mockRejectedValue(new ApiError(404, 'preview not found or expired')) };
    const { app } = buildApp({ trackPreviewService });
    const res = await request(app).delete('/tracks/preview/missing');
    expect(res.status).toBe(404);
  });
});
