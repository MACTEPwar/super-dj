import { PassThrough } from 'stream';
import request from 'supertest';
import { buildServer } from '../src/server';
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
