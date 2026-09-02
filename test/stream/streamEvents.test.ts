import express from 'express';
import request from 'supertest';
import { AddressInfo } from 'net';
import { createStreamRouter } from '../../src/stream/streamRoutes';
import { errorHandler } from '../../src/api/errorHandler';
import { StreamManager } from '../../src/stream/streamManager';
import { DestinationStreamStatus } from '../../src/stream/types';

function buildApp(streamManager: any, userId = 'user-1') {
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: userId, email: 'a@example.com' }) };
  const destinationRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'dest-1', userId: 'user-1' }) };
  const app = express();
  app.use(express.json());
  app.use('/destinations/:destinationId/stream', createStreamRouter(authService, streamManager, destinationRepository));
  app.use(errorHandler);
  return app;
}

describe('GET .../stream/events (SSE)', () => {
  it('sends the current status immediately on connect', async () => {
    const streamManager = new StreamManager({} as any);
    jest.spyOn(streamManager, 'status').mockReturnValue({ state: 'idle', currentTrack: null, nextTrack: null });
    const app = buildApp(streamManager);
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/destinations/dest-1/stream/events`, { signal: controller.signal });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const text = Buffer.from(value!).toString('utf8');
      expect(text).toBe('data: {"state":"idle","currentTrack":null,"nextTrack":null}\n\n');
    } finally {
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('sends a new frame when the manager emits statusChanged for this destination, and ignores other destinations', async () => {
    const streamManager = new StreamManager({} as any);
    const statuses: DestinationStreamStatus[] = [
      { state: 'idle', currentTrack: null, nextTrack: null },
      { state: 'streaming', currentTrack: 'a', nextTrack: 'b' },
    ];
    jest.spyOn(streamManager, 'status').mockImplementation(() => statuses.shift() ?? statuses[0]);
    const app = buildApp(streamManager);
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/destinations/dest-1/stream/events`, { signal: controller.signal });
      const reader = res.body!.getReader();
      await reader.read(); // initial frame

      streamManager.emit('statusChanged', 'some-other-destination');
      streamManager.emit('statusChanged', 'dest-1');
      const { value } = await reader.read();
      const text = Buffer.from(value!).toString('utf8');
      expect(text).toBe('data: {"state":"streaming","currentTrack":"a","nextTrack":"b"}\n\n');
    } finally {
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns 403 before opening the stream for a destination owned by someone else', async () => {
    const streamManager = new StreamManager({} as any);
    const app = buildApp(streamManager, 'user-1');
    const destinationRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'dest-1', userId: 'someone-else' }) };
    const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: 'user-1', email: 'a@example.com' }) };
    const app2 = express();
    app2.use('/destinations/:destinationId/stream', createStreamRouter(authService, streamManager, destinationRepository));
    app2.use(errorHandler);
    const res = await request(app2).get('/destinations/dest-1/stream/events');
    expect(res.status).toBe(403);
  });
});
