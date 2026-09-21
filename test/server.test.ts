import request from 'supertest';
import { buildServer, createSpawner } from '../src/server';
import { AppConfig } from '../src/config/env';
import { Spawner, ChildProcessLike } from '../src/ffmpeg/types';
import { PassThrough } from 'stream';

function fakeSpawner(): Spawner {
  return jest.fn().mockImplementation((): ChildProcessLike => ({
    pid: 1, stdout: new PassThrough(), stderr: null, kill: jest.fn(), once: jest.fn(),
  }));
}

const config: AppConfig = {
  port: 3000,
  defaultCoverPath: '/assets/default-cover.png',
  backgroundImagePath: '/assets/background.png',
  databaseUrl: 'postgresql://u:p@localhost:5432/db',
  sessionTtlDays: 30,
  uploadsDir: '/uploads',
  streamKeyEncryptionKey: 'a'.repeat(64),
  fifoDir: '/tmp',
  googleOAuthClientId: 'client-id',
  googleOAuthClientSecret: 'client-secret',
  appBaseUrl: 'https://app.example.com',
  frontendOrigin: 'https://web.example.com',
  mediaMtxRtmpUrl: 'rtmp://mediamtx:1935',
  mediaMtxHlsUrl: 'http://mediamtx:8888',
  mediaMtxAuthSecret: 'shared-secret',
  mediaMtxAuthPort: 3001,
  maxConcurrentLocalStreams: 10,
  maxLocalStreamDurationMs: 12 * 60 * 60 * 1000,
  donatelloCallbackKey: 'donatello-key',
};

describe('buildServer', () => {
  it('wires an app that responds to a request without touching the database (no live Postgres needed for this check)', async () => {
    const { app } = buildServer(config, fakeSpawner());
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);
  });

  it('requires authentication for the new resource routes', async () => {
    const { app } = buildServer(config, fakeSpawner());
    const res = await request(app).get('/tracks');
    expect(res.status).toBe(401);
  });

  it('builds a separate MediaMTX auth app that answers 401 for a wrong shared secret and 404 for anything else', async () => {
    const { mediaMtxAuthApp, mediaMtxAuthPort } = buildServer(config, fakeSpawner());
    expect(mediaMtxAuthPort).toBe(3001);
    expect((await request(mediaMtxAuthApp).post('/internal/mediamtx-auth/wrong').send({})).status).toBe(401);
    expect((await request(mediaMtxAuthApp).get('/openapi.json')).status).toBe(404);
  });

  it('requires authentication for the local-stream routes', async () => {
    const { app } = buildServer(config, fakeSpawner());
    expect((await request(app).get('/local-stream/status')).status).toBe(401);
    expect((await request(app).get('/local-stream/preview/index.m3u8')).status).toBe(401);
  });

  it('does not serve the removed per-destination or session stream routes', async () => {
    const { app } = buildServer(config, fakeSpawner());
    expect((await request(app).post('/destinations/d1/stream/start').send({ playlistId: 'p1' })).status).toBe(404);
    expect((await request(app).get('/stream-sessions')).status).toBe(404);
  });
});

describe('createSpawner', () => {
  // The only test in this repo that spawns a real child process: it proves the
  // reason createSpawner exists — an undrained stderr fills the ~64KB OS pipe
  // buffer and the child blocks on write forever.
  it('drains a child process stderr so it does not deadlock on a full pipe', async () => {
    // Don't echo 500KB of noise into the jest output; the forwarding itself is what drains.
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const spawner = createSpawner();
      const child: ChildProcessLike = spawner(process.execPath, [
        '-e', "process.stderr.write('x'.repeat(500000)); process.exit(0);",
      ]);

      const exitCode = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('child did not exit — stderr likely not drained')), 5000);
        child.once('exit', (code) => {
          clearTimeout(timer);
          resolve(code as number);
        });
        child.once('error', (err) => {
          clearTimeout(timer);
          reject(err as Error);
        });
      });

      expect(exitCode).toBe(0);
      expect(stderrSpy).toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  }, 10000);
});
