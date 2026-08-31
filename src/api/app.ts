import express, { Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import { StreamController } from '../stream/streamController';
import { Library } from '../playlist/library';
import { PlaylistQueue } from '../playlist/queue';
import { AuthService } from '../auth/authService';
import { createStreamRouter } from './streamRoutes';
import { createLibraryRouter } from './libraryRoutes';
import { createAuthRouter } from '../auth/authRoutes';
import { errorHandler } from './errorHandler';
import { openApiSpec } from './openapi';

export interface AppDeps {
  streamController: StreamController;
  library: Library;
  queue: PlaylistQueue;
  authService: AuthService;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json());
  app.use('/stream', createStreamRouter(deps.streamController));
  app.use('/library', createLibraryRouter(deps.library, deps.queue));
  app.use('/auth', createAuthRouter(deps.authService));
  app.get('/openapi.json', (_req, res) => res.json(openApiSpec));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
  app.use(errorHandler);
  return app;
}
