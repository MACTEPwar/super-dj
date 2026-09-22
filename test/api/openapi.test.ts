import request from 'supertest';
import { createApp } from '../../src/api/app';

function buildApp() {
  const authService: any = { register: jest.fn(), login: jest.fn(), logout: jest.fn(), getCurrentUser: jest.fn() };
  const trackRepository: any = {};
  const trackUploadService: any = {};
  const trackPreviewService: any = {};
  const playlistRepository: any = {};
  const destinationRepository: any = {};
  return createApp({
    authService,
    trackRepository,
    trackUploadService,
    trackPreviewService,
    playlistRepository,
    destinationRepository,
    destinationEncryptionKey: 'a'.repeat(64),
    localStreamManager: {} as any,
    previewFetch: jest.fn() as any,
    oauthProviderAdapters: {},
    oauthStateRepository: {} as any,
    oauthConnectionRepository: {} as any,
    templateRepository: {} as any,
    templateRendererDeps: { fontPath: '/fonts/test.ttf', fontFamily: 'Test', defaultCoverPath: '/assets/default-cover.png' },
    templateImageService: {} as any,
    streamPresetRepository: {} as any,
    interactionRuleRepository: {} as any,
    donatelloWebhookDeps: { callbackKey: 'test-key', converter: { toUah: jest.fn() }, targetUserId: 'user-1', executeSongRequest: jest.fn() },
    frontendOrigin: 'https://web.example.com',
  });
}

describe('API docs', () => {
  it('serves the raw OpenAPI document', async () => {
    const res = await request(buildApp()).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.paths).toHaveProperty('/tracks');
    expect(res.body.paths).toHaveProperty('/auth/register');
  });

  it('documents the local-stream routes', async () => {
    const res = await request(buildApp()).get('/openapi.json');
    expect(res.body.paths).toHaveProperty('/local-stream/start');
    expect(res.body.paths).toHaveProperty('/local-stream/status');
    // Array form, not a dot-separated string: Jest's toHaveProperty parses a STRING keyPath as a
    // deep path, so '/local-stream/preview/index.m3u8' would look up
    // paths['/local-stream/preview/index']['m3u8'] (undefined) instead of the literal key — a
    // false failure this repo's other assertions here (`'/tracks'`, `'/auth/register'`) never hit
    // only because those keys happen to contain no dots.
    expect(res.body.paths).toHaveProperty(['/local-stream/preview/index.m3u8']);
    expect(res.body.paths).toHaveProperty(['/local-stream/destinations/{destinationId}']);
  });

  it('documents the track-preview routes', async () => {
    const res = await request(buildApp()).get('/openapi.json');
    expect(res.body.paths).toHaveProperty(['/tracks/search-preview']);
    expect(res.body.paths).toHaveProperty(['/tracks/preview/{previewId}']);
    expect(res.body.paths).toHaveProperty(['/tracks/from-preview/{previewId}']);
  });

  // Full cutover: leaving these reachable would let a caller start a destination-bound encode that
  // bypasses the local stream, which is exactly the invariant the local-first rework establishes.
  it('no longer documents the removed per-destination and session stream APIs', async () => {
    const res = await request(buildApp()).get('/openapi.json');
    expect(res.body.paths).not.toHaveProperty(['/destinations/{destinationId}/stream/start']);
    expect(res.body.paths).not.toHaveProperty('/stream-sessions');
  });

  it('serves Swagger UI at /docs', async () => {
    const res = await request(buildApp()).get('/docs/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('allows credentialed cross-origin requests from the configured frontend origin', async () => {
    const app = buildApp();
    const res = await request(app).options('/auth/me').set('Origin', 'https://web.example.com').set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBe('https://web.example.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
});
