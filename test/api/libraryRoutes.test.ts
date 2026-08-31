import express from 'express';
import request from 'supertest';
import { createLibraryRouter } from '../../src/api/libraryRoutes';
import { errorHandler } from '../../src/api/errorHandler';

function buildApp(library: any, queue: any) {
  const app = express();
  app.use(express.json());
  app.use('/library', createLibraryRouter(library, queue));
  app.use(errorHandler);
  return app;
}

describe('library routes', () => {
  it('GET /library returns the current track list', async () => {
    const library = { list: jest.fn().mockReturnValue([{ name: 'a' }]) };
    const res = await request(buildApp(library, { setTracks: jest.fn() })).get('/library');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ name: 'a' }]);
  });

  it('POST /library/rescan rescans and syncs the queue', async () => {
    const tracks = [{ name: 'a' }, { name: 'b' }];
    const library = { scan: jest.fn().mockResolvedValue(tracks) };
    const queue = { setTracks: jest.fn() };
    const res = await request(buildApp(library, queue)).post('/library/rescan');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(tracks);
    expect(queue.setTracks).toHaveBeenCalledWith(tracks);
  });
});
