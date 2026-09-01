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
