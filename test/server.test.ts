import { PassThrough } from 'stream';
import request from 'supertest';
import { buildServer, createSpawner } from '../src/server';
import { AppConfig } from '../src/config/env';
import { Spawner, ChildProcessLike } from '../src/ffmpeg/types';

function fakeSpawner(): Spawner {
  return jest.fn().mockImplementation((): ChildProcessLike => ({
    pid: 1,
    stdout: new PassThrough(),
    stderr: null,
    kill: jest.fn(),
    once: jest.fn(),
  }));
}

const config: AppConfig = {
  port: 3000,
  rtmpUrl: 'rtmp://example.com/live',
  streamKey: 'key',
  audioDir: '/music',
  defaultCoverPath: '/assets/default-cover.png',
  backgroundImagePath: '/assets/background.png',
  fifoPath: '/tmp/test.fifo',
  databaseUrl: 'postgresql://u:p@localhost:5432/db',
  sessionTtlDays: 30,
  uploadsDir: '/uploads',
  streamKeyEncryptionKey: 'a'.repeat(64),
  fifoDir: '/tmp',
};

describe('buildServer', () => {
  it('wires an app that reports idle status before any track is loaded', async () => {
    const { app } = buildServer(config, fakeSpawner());
    const res = await request(app).get('/stream/status');

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('idle');
  });

  it('start() fails with 409 until the library has tracks', async () => {
    const { app } = buildServer(config, fakeSpawner());
    const res = await request(app).post('/stream/start');

    expect(res.status).toBe(409);
  });
});

describe('createSpawner', () => {
  it('drains the spawned child stderr and forwards it to process.stderr', async () => {
    const writeSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const child = createSpawner()(process.execPath, ['-e', 'console.error("ffmpeg-banner")']);
      await new Promise<void>((resolve) => {
        // Wait for stderr EOF, not exit: exit can fire before stdio is flushed.
        child.stderr?.on('end', () => resolve());
      });
      const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('ffmpeg-banner');
    } finally {
      writeSpy.mockRestore();
    }
  });
});
