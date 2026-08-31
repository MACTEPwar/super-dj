import { Router } from 'express';
import { Library } from '../playlist/library';
import { PlaylistQueue } from '../playlist/queue';
import { wrapAsync } from './errorHandler';

export function createLibraryRouter(library: Library, queue: PlaylistQueue): Router {
  const router = Router();

  router.get('/', wrapAsync(async (_req, res) => {
    res.status(200).json(library.list());
  }));

  router.post('/rescan', wrapAsync(async (_req, res) => {
    const tracks = await library.scan();
    queue.setTracks(tracks);
    res.status(200).json(tracks);
  }));

  return router;
}
