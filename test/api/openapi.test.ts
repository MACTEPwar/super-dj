import request from 'supertest';
import { createApp } from '../../src/api/app';

function buildApp() {
  const streamController: any = { status: jest.fn().mockReturnValue({ state: 'idle' }) };
  const library: any = { list: jest.fn().mockReturnValue([]) };
  const queue: any = { setTracks: jest.fn() };
  const authService: any = { register: jest.fn(), login: jest.fn(), logout: jest.fn(), getCurrentUser: jest.fn() };
  return createApp({ streamController, library, queue, authService });
}

describe('API docs', () => {
  it('serves the raw OpenAPI document', async () => {
    const res = await request(buildApp()).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.paths).toHaveProperty('/stream/start');
  });

  it('serves Swagger UI at /docs', async () => {
    const res = await request(buildApp()).get('/docs/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });
});
