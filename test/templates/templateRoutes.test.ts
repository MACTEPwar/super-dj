jest.mock('../../src/render/renderOverlay', () => ({ renderTemplatePng: jest.fn().mockResolvedValue(Buffer.from('fake-png')) }));

import express from 'express';
import request from 'supertest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createTemplateRouter } from '../../src/templates/templateRoutes';
import { errorHandler } from '../../src/api/errorHandler';
import { renderTemplatePng } from '../../src/render/renderOverlay';
import { TemplateImageService } from '../../src/templates/templateImageService';

const rendererDeps = { fontPath: '/fonts/test.ttf', fontFamily: 'Test', defaultCoverPath: '/assets/default-cover.png' };
const validElements = [{ type: 'cover', x: 0, y: 0, width: 100, height: 100 }];

function buildApp(
  templateRepository: any,
  trackRepository: any = { findById: jest.fn() },
  userId = 'user-1',
  templateImageService: any = { upload: jest.fn(), resolvePath: jest.fn() },
) {
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: userId, email: 'a@example.com' }) };
  const app = express();
  app.use(express.json());
  app.use('/templates', createTemplateRouter(authService, templateRepository, trackRepository, rendererDeps, templateImageService));
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
      expect(renderTemplatePng).toHaveBeenCalledWith({
        elements: validElements,
        title: 'Sample Track',
        playlistLines: ['▶ Sample Track', '  Next Track'],
        coverPath: '/assets/default-cover.png',
        width: 1280,
        height: 720,
        fontPath: '/fonts/test.ttf',
        fontFamily: 'Test',
      });
    });

    it('uses a draft elements array from the body instead of the saved one, without persisting it', async () => {
      const templateRepository: any = ownedTemplateRepo();
      const draftElements = [{
        type: 'title', x: 5, y: 5, width: 50, fontSize: 10,
        color: { mode: 'solid', color: '#000000' },
        style: { fontFamily: 'Test', bold: false, italic: false },
      }];
      const res = await request(buildApp(templateRepository)).post('/templates/t1/preview').send({ elements: draftElements });

      expect(res.status).toBe(200);
      expect(renderTemplatePng).toHaveBeenCalledWith(expect.objectContaining({ elements: draftElements }));
    });

    it('looks up a track\'s own cover when trackId is given, enforcing ownership', async () => {
      const templateRepository: any = ownedTemplateRepo();
      const trackRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'tr1', userId: 'user-1', coverPath: '/uploads/u1/tr1/cover.png' }) };
      const res = await request(buildApp(templateRepository, trackRepository)).post('/templates/t1/preview').send({ trackId: 'tr1' });

      expect(res.status).toBe(200);
      expect(renderTemplatePng).toHaveBeenCalledWith(expect.objectContaining({ coverPath: '/uploads/u1/tr1/cover.png' }));
    });

    it('403s when trackId belongs to another user', async () => {
      const templateRepository: any = ownedTemplateRepo();
      const trackRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'tr1', userId: 'someone-else', coverPath: null }) };
      const res = await request(buildApp(templateRepository, trackRepository)).post('/templates/t1/preview').send({ trackId: 'tr1' });

      expect(res.status).toBe(403);
      expect(renderTemplatePng).not.toHaveBeenCalled();
    });

    it('rejects invalid draft elements', async () => {
      const templateRepository: any = ownedTemplateRepo();
      const res = await request(buildApp(templateRepository)).post('/templates/t1/preview').send({ elements: [{ type: 'cover' }] });

      expect(res.status).toBe(400);
      expect(renderTemplatePng).not.toHaveBeenCalled();
    });

    it('propagates a render failure as a real HTTP error instead of silently falling back', async () => {
      const templateRepository: any = ownedTemplateRepo();
      (renderTemplatePng as jest.Mock).mockRejectedValueOnce(new Error('render pipeline unavailable'));

      const res = await request(buildApp(templateRepository)).post('/templates/t1/preview').send({});

      expect(res.status).toBe(500);
    });
  });

  describe('POST /templates/:id/images', () => {
    function ownedTemplateRepo() {
      return { findById: jest.fn().mockResolvedValue({ id: 't1', userId: 'user-1', name: 'My Theme', elements: validElements }) };
    }

    it('uploads an image for the template owner and returns the assetId', async () => {
      const templateRepository: any = ownedTemplateRepo();
      const templateImageService: any = { upload: jest.fn().mockResolvedValue({ assetId: 'asset-1' }), resolvePath: jest.fn() };
      const res = await request(buildApp(templateRepository, undefined, 'user-1', templateImageService))
        .post('/templates/t1/images')
        .attach('image', Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: 'logo.png', contentType: 'image/png' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ assetId: 'asset-1' });
      expect(templateImageService.upload).toHaveBeenCalledWith('user-1', 't1', expect.objectContaining({ originalname: 'logo.png' }));
    });

    it('404s when the template does not exist', async () => {
      const templateRepository: any = { findById: jest.fn().mockResolvedValue(null) };
      const templateImageService: any = { upload: jest.fn(), resolvePath: jest.fn() };
      const res = await request(buildApp(templateRepository, undefined, 'user-1', templateImageService))
        .post('/templates/missing/images')
        .attach('image', Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: 'logo.png', contentType: 'image/png' });

      expect(res.status).toBe(404);
      expect(templateImageService.upload).not.toHaveBeenCalled();
    });

    it('403s for another user\'s template', async () => {
      const templateRepository: any = { findById: jest.fn().mockResolvedValue({ id: 't1', userId: 'someone-else' }) };
      const templateImageService: any = { upload: jest.fn(), resolvePath: jest.fn() };
      const res = await request(buildApp(templateRepository, undefined, 'user-1', templateImageService))
        .post('/templates/t1/images')
        .attach('image', Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: 'logo.png', contentType: 'image/png' });

      expect(res.status).toBe(403);
      expect(templateImageService.upload).not.toHaveBeenCalled();
    });

    it('400s when no file is attached', async () => {
      const templateRepository: any = ownedTemplateRepo();
      const templateImageService: any = { upload: jest.fn(), resolvePath: jest.fn() };
      const res = await request(buildApp(templateRepository, undefined, 'user-1', templateImageService))
        .post('/templates/t1/images');

      expect(res.status).toBe(400);
      expect(templateImageService.upload).not.toHaveBeenCalled();
    });

    it('400s on a disallowed mimetype', async () => {
      const templateRepository: any = ownedTemplateRepo();
      const templateImageService: any = { upload: jest.fn(), resolvePath: jest.fn() };
      const res = await request(buildApp(templateRepository, undefined, 'user-1', templateImageService))
        .post('/templates/t1/images')
        .attach('image', Buffer.from('<svg></svg>'), { filename: 'logo.svg', contentType: 'image/svg+xml' });

      expect(res.status).toBe(400);
      expect(templateImageService.upload).not.toHaveBeenCalled();
    });
  });

  describe('GET /templates/:id/images/:assetId', () => {
    function ownedTemplateRepo() {
      return { findById: jest.fn().mockResolvedValue({ id: 't1', userId: 'user-1', name: 'My Theme', elements: validElements }) };
    }

    it('returns the file for the owner', async () => {
      const filePath = path.join(os.tmpdir(), `template-image-test-${Date.now()}.png`);
      await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const templateRepository: any = ownedTemplateRepo();
      const templateImageService: any = { upload: jest.fn(), resolvePath: jest.fn().mockReturnValue(filePath) };

      const res = await request(buildApp(templateRepository, undefined, 'user-1', templateImageService))
        .get('/templates/t1/images/asset-1');

      expect(res.status).toBe(200);
      expect(templateImageService.resolvePath).toHaveBeenCalledWith('user-1', 't1', 'asset-1');
      await fs.unlink(filePath);
    });

    it('404s for a nonexistent assetId', async () => {
      const templateRepository: any = ownedTemplateRepo();
      const templateImageService: any = {
        upload: jest.fn(),
        resolvePath: jest.fn().mockReturnValue(path.join(os.tmpdir(), 'definitely-does-not-exist-asset.png')),
      };

      const res = await request(buildApp(templateRepository, undefined, 'user-1', templateImageService))
        .get('/templates/t1/images/missing-asset');

      expect(res.status).toBe(404);
    });

    it('403s for another user\'s template', async () => {
      const templateRepository: any = { findById: jest.fn().mockResolvedValue({ id: 't1', userId: 'someone-else' }) };
      const templateImageService: any = { upload: jest.fn(), resolvePath: jest.fn() };

      const res = await request(buildApp(templateRepository, undefined, 'user-1', templateImageService))
        .get('/templates/t1/images/asset-1');

      expect(res.status).toBe(403);
      expect(templateImageService.resolvePath).not.toHaveBeenCalled();
    });

    it('404s a path-traversal-shaped assetId instead of serving a file outside the template images directory', async () => {
      // Uses the real TemplateImageService (not a resolvePath fake) so this exercises the actual
      // traversal guard end to end, not just that the route calls resolvePath.
      const templateRepository: any = ownedTemplateRepo();
      const templateImageService = new TemplateImageService({ uploadsDir: os.tmpdir() });

      const res = await request(buildApp(templateRepository, undefined, 'user-1', templateImageService as any))
        .get('/templates/t1/images/' + encodeURIComponent('../../other-user/templates/other-template/images/x'));

      expect(res.status).toBe(404);
    });
  });
});
