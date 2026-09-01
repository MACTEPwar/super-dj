import request from 'supertest';
import { buildServer } from '../src/server';
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
