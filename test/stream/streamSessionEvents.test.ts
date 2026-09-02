import express from 'express';
import { AddressInfo } from 'net';
import { createStreamSessionRouter } from '../../src/stream/streamSessionRoutes';
import { errorHandler } from '../../src/api/errorHandler';
import { StreamManager } from '../../src/stream/streamManager';
import { DestinationStreamStatus } from '../../src/stream/types';

function buildApp(streamSessionManager: any, streamManager: StreamManager, userId = 'user-1') {
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: userId, email: 'a@example.com' }) };
  const app = express();
  app.use(express.json());
  app.use('/stream-sessions', createStreamSessionRouter(authService, streamSessionManager, streamManager));
  app.use(errorHandler);
  return app;
}

describe('GET /stream-sessions/:id/events (SSE)', () => {
  it('sends the combined status of every destination in the session immediately on connect', async () => {
    const streamManager = new StreamManager({} as any);
    jest.spyOn(streamManager, 'status').mockImplementation((destinationId: string) => ({
      state: 'idle', currentTrack: null, nextTrack: null,
    } as DestinationStreamStatus));
    const streamSessionManager: any = {
      status: jest.fn().mockResolvedValue({
        id: 's1', playlistId: 'p1',
        destinations: [
          { destinationId: 'dest-a', status: { state: 'idle', currentTrack: null, nextTrack: null } },
          { destinationId: 'dest-b', status: { state: 'idle', currentTrack: null, nextTrack: null } },
        ],
      }),
    };
    const app = buildApp(streamSessionManager, streamManager);
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/stream-sessions/s1/events`, { signal: controller.signal });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const text = Buffer.from(value!).toString('utf8');
      const payload = JSON.parse(text.replace(/^data: /, '').trim());
      expect(payload.destinations.map((d: any) => d.destinationId)).toEqual(['dest-a', 'dest-b']);
    } finally {
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('sends a new frame when any member destination changes, and ignores destinations outside the session', async () => {
    const streamManager = new StreamManager({} as any);
    jest.spyOn(streamManager, 'status').mockReturnValue({ state: 'streaming', currentTrack: 'a', nextTrack: 'b' });
    const streamSessionManager: any = {
      status: jest.fn().mockResolvedValue({
        id: 's1', playlistId: 'p1',
        destinations: [{ destinationId: 'dest-a', status: { state: 'idle', currentTrack: null, nextTrack: null } }],
      }),
    };
    const app = buildApp(streamSessionManager, streamManager);
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/stream-sessions/s1/events`, { signal: controller.signal });
      const reader = res.body!.getReader();
      await reader.read(); // initial frame

      streamManager.emit('statusChanged', 'dest-not-in-session');
      streamManager.emit('statusChanged', 'dest-a');
      const { value } = await reader.read();
      const text = Buffer.from(value!).toString('utf8');
      const payload = JSON.parse(text.replace(/^data: /, '').trim());
      expect(payload.destinations).toEqual([{ destinationId: 'dest-a', status: { state: 'streaming', currentTrack: 'a', nextTrack: 'b' } }]);
    } finally {
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
