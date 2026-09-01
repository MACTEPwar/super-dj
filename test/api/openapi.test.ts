import request from 'supertest';
import { createApp } from '../../src/api/app';

function buildApp() {
  const authService: any = { register: jest.fn(), login: jest.fn(), logout: jest.fn(), getCurrentUser: jest.fn() };
  const trackRepository: any = {};
  const trackUploadService: any = {};
  const playlistRepository: any = {};
  const destinationRepository: any = {};
  const streamManager: any = {};
  return createApp({
    authService,
    trackRepository,
    trackUploadService,
    playlistRepository,
    destinationRepository,
    destinationEncryptionKey: 'a'.repeat(64),
    streamManager,
  });
}

describe('API docs', () => {
  it('serves the raw OpenAPI document', async () => {
    const res = await request(buildApp()).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.paths).toHaveProperty('/tracks');
    expect(res.body.paths).toHaveProperty('/auth/register');
  });

  it('serves Swagger UI at /docs', async () => {
    const res = await request(buildApp()).get('/docs/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });
});
