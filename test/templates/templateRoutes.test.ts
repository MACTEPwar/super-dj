jest.mock('../../src/render/sceneRenderer', () => ({ renderScene: jest.fn().mockResolvedValue(Buffer.from('fake-png')) }));
jest.mock('../../src/render/imageDataUri', () => ({ readImageAsDataUri: jest.fn().mockResolvedValue('data:image/png;base64,ZmFrZQ==') }));
jest.mock('fs/promises', () => ({ readFile: jest.fn().mockResolvedValue(Buffer.from('fake-font-bytes')) }));

import express from 'express';
import request from 'supertest';
import { createTemplateRouter } from '../../src/templates/templateRoutes';
import { errorHandler } from '../../src/api/errorHandler';
import { renderScene } from '../../src/render/sceneRenderer';
import { readImageAsDataUri } from '../../src/render/imageDataUri';

const rendererDeps = { fontPath: '/fonts/test.ttf', fontFamily: 'Test', defaultCoverPath: '/assets/default-cover.png' };
const validElements = [{ type: 'cover', x: 0, y: 0, width: 100, height: 100 }];

function buildApp(templateRepository: any, trackRepository: any = { findById: jest.fn() }, userId = 'user-1') {
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: userId, email: 'a@example.com' }) };
  const app = express();
  app.use(express.json());
  app.use('/templates', createTemplateRouter(authService, templateRepository, trackRepository, rendererDeps));
  app.use(errorHandler);
  return app;
}

describe('template routes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POST /templates creates a template for the current user', async () => {
    const templateRepository: any = {
      create: jest.fn().mockResolvedValue({ id: 't1', name: 'My Theme', elements: validElements, createdAt: new Date(), updatedAt: new Date() }),
    };
    const res = await request(buildApp(templateRepository)).post('/templates').send({ name: 'My Theme', elements: validElements });
    expect(res.status).toBe(200);
    expect(templateRepository.create).toHaveBeenCalledWith({ userId: 'user-1', name: 'My Theme', elements: validElements });
    expect(res.body.name).toBe('My Theme');
  });

  it('POST /templates requires a non-empty name', async () => {
    const templateRepository: any = { create: jest.fn() };
    const res = await request(buildApp(templateRepository)).post('/templates').send({ elements: validElements });
    expect(res.status).toBe(400);
    expect(templateRepository.create).not.toHaveBeenCalled();
  });

  it('POST /templates rejects invalid elements', async () => {
    const templateRepository: any = { create: jest.fn() };
    const res = await request(buildApp(templateRepository)).post('/templates').send({ name: 'X', elements: [{ type: 'cover' }] });
    expect(res.status).toBe(400);
    expect(templateRepository.create).not.toHaveBeenCalled();
  });

  it('GET /templates lists the current user\'s templates', async () => {
    const templateRepository: any = { listByUser: jest.fn().mockResolvedValue([]) };
    const res = await request(buildApp(templateRepository)).get('/templates');
    expect(res.status).toBe(200);
    expect(templateRepository.listByUser).toHaveBeenCalledWith('user-1');
  });

  it('GET /templates/:id returns 403 for a template owned by someone else', async () => {
    const templateRepository: any = { findById: jest.fn().mockResolvedValue({ id: 't1', userId: 'someone-else' }) };
    const res = await request(buildApp(templateRepository)).get('/templates/t1');
    expect(res.status).toBe(403);
  });

  it('GET /templates/:id returns 404 when missing', async () => {
    const templateRepository: any = { findById: jest.fn().mockResolvedValue(null) };
    const res = await request(buildApp(templateRepository)).get('/templates/missing');
    expect(res.status).toBe(404);
  });

  it('PUT /templates/:id updates an owned template', async () => {
    const templateRepository: any = {
      findById: jest.fn().mockResolvedValue({ id: 't1', userId: 'user-1', name: 'Old', elements: [] }),
      update: jest.fn().mockResolvedValue({ id: 't1', name: 'New', elements: validElements, createdAt: new Date(), updatedAt: new Date() }),
    };
    const res = await request(buildApp(templateRepository)).put('/templates/t1').send({ name: 'New', elements: validElements });
    expect(res.status).toBe(200);
    expect(templateRepository.update).toHaveBeenCalledWith('t1', { name: 'New', elements: validElements });
  });

  it('DELETE /templates/:id deletes an owned template', async () => {
    const templateRepository: any = {
      findById: jest.fn().mockResolvedValue({ id: 't1', userId: 'user-1' }),
      deleteById: jest.fn().mockResolvedValue(undefined),
    };
    const res = await request(buildApp(templateRepository)).delete('/templates/t1');
    expect(res.status).toBe(200);
    expect(templateRepository.deleteById).toHaveBeenCalledWith('t1');
  });

  describe('POST /templates/:id/preview', () => {
    function ownedTemplateRepo() {
      return { findById: jest.fn().mockResolvedValue({ id: 't1', userId: 'user-1', name: 'My Theme', elements: validElements }) };
    }

    it('renders the saved template with default sample scene data and the default cover', async () => {
      const templateRepository: any = ownedTemplateRepo();
      const res = await request(buildApp(templateRepository)).post('/templates/t1/preview').send({});

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('image/png');
      expect(readImageAsDataUri).toHaveBeenCalledWith('/assets/default-cover.png');
      expect(renderScene).toHaveBeenCalledWith(
        validElements,
        { title: 'Sample Track', playlistLines: ['▶ Sample Track', '  Next Track'], coverDataUri: 'data:image/png;base64,ZmFrZQ==' },
        { width: 1280, height: 720, fontData: expect.any(Buffer), fontFamily: 'Test' },
      );
    });

    it('uses a draft elements array from the body instead of the saved one, without persisting it', async () => {
      const templateRepository: any = ownedTemplateRepo();
      const draftElements = [{ type: 'title', x: 5, y: 5, width: 50, fontSize: 10, color: '#000' }];
      const res = await request(buildApp(templateRepository)).post('/templates/t1/preview').send({ elements: draftElements });

      expect(res.status).toBe(200);
      expect(renderScene).toHaveBeenCalledWith(draftElements, expect.anything(), expect.anything());
    });

    it('looks up a track\'s own cover when trackId is given, enforcing ownership', async () => {
      const templateRepository: any = ownedTemplateRepo();
      const trackRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'tr1', userId: 'user-1', coverPath: '/uploads/u1/tr1/cover.png' }) };
      const res = await request(buildApp(templateRepository, trackRepository)).post('/templates/t1/preview').send({ trackId: 'tr1' });

      expect(res.status).toBe(200);
      expect(readImageAsDataUri).toHaveBeenCalledWith('/uploads/u1/tr1/cover.png');
    });

    it('403s when trackId belongs to another user', async () => {
      const templateRepository: any = ownedTemplateRepo();
      const trackRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'tr1', userId: 'someone-else', coverPath: null }) };
      const res = await request(buildApp(templateRepository, trackRepository)).post('/templates/t1/preview').send({ trackId: 'tr1' });

      expect(res.status).toBe(403);
      expect(renderScene).not.toHaveBeenCalled();
    });

    it('rejects invalid draft elements', async () => {
      const templateRepository: any = ownedTemplateRepo();
      const res = await request(buildApp(templateRepository)).post('/templates/t1/preview').send({ elements: [{ type: 'cover' }] });

      expect(res.status).toBe(400);
      expect(renderScene).not.toHaveBeenCalled();
    });
  });
});
