import express, { Express } from 'express';
import { StreamController } from '../stream/streamController';
import { Library } from '../playlist/library';
import { PlaylistQueue } from '../playlist/queue';
import { createStreamRouter } from './streamRoutes';
import { createLibraryRouter } from './libraryRoutes';
import { errorHandler } from './errorHandler';

export interface AppDeps {
  streamController: StreamController;
  library: Library;
  queue: PlaylistQueue;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json());
  app.use('/stream', createStreamRouter(deps.streamController));
  app.use('/library', createLibraryRouter(deps.library, deps.queue));
  app.use(errorHandler);
  return app;
}
