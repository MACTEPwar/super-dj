import express from 'express';
import { AddressInfo } from 'net';
import { createLocalStreamRouter } from '../../src/stream/localStreamRoutes';
import { errorHandler } from '../../src/api/errorHandler';
import { LocalStreamManager, LocalStreamStatus } from '../../src/stream/localStreamManager';

function buildApp(localStreamManager: LocalStreamManager, userId = 'user-1') {
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: userId, email: 'a@example.com' }) };
  const app = express();
  app.use(express.json());
  app.use('/local-stream', createLocalStreamRouter(authService, localStreamManager, jest.fn()));
  app.use(errorHandler);
  return app;
}

const IDLE: LocalStreamStatus = {
  state: 'idle', currentTrack: null, nextTrack: null,
  previewReady: false, playlistId: null, templateId: null, startedAt: null,
};

describe('GET /local-stream/events (SSE)', () => {
  it('sends the current status immediately on connect', async () => {
    const manager = new LocalStreamManager({} as never);
    jest.spyOn(manager, 'status').mockReturnValue(IDLE);
    const server = buildApp(manager).listen(0);
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/local-stream/events`, { signal: controller.signal });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const { value } = await res.body!.getReader().read();
      expect(Buffer.from(value!).toString('utf8')).toBe(`data: ${JSON.stringify(IDLE)}\n\n`);
    } finally {
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('pushes a frame for this user\'s own events only', async () => {
    const manager = new LocalStreamManager({} as never);
    const live: LocalStreamStatus = {
      state: 'streaming', currentTrack: 'a', nextTrack: 'b',
      previewReady: true, playlistId: 'p1', templateId: null, startedAt: '2026-09-14T10:00:00.000Z',
    };
    const statuses = [IDLE, live];
    jest.spyOn(manager, 'status').mockImplementation(() => statuses.shift() ?? live);
    const server = buildApp(manager, 'user-1').listen(0);
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/local-stream/events`, { signal: controller.signal });
      const reader = res.body!.getReader();
      await reader.read(); // initial frame

      manager.emit('statusChanged', 'someone-else');
      manager.emit('statusChanged', 'user-1');
      const { value } = await reader.read();
      expect(Buffer.from(value!).toString('utf8')).toBe(`data: ${JSON.stringify(live)}\n\n`);
    } finally {
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('removes its listener when the client disconnects', async () => {
    const manager = new LocalStreamManager({} as never);
    jest.spyOn(manager, 'status').mockReturnValue(IDLE);
    const server = buildApp(manager).listen(0);
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/local-stream/events`, { signal: controller.signal });
      await res.body!.getReader().read();
      expect(manager.listenerCount('statusChanged')).toBe(1);
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(manager.listenerCount('statusChanged')).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
