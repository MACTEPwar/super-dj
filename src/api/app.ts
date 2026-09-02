import express, { Express } from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { AuthService } from '../auth/authService';
import { createAuthRouter } from '../auth/authRoutes';
import { TrackRepository } from '../tracks/trackRepository';
import { TrackUploadService } from '../tracks/trackUploadService';
import { createTrackRouter } from '../tracks/trackRoutes';
import { PlaylistRepository } from '../playlists/playlistRepository';
import { createPlaylistRouter } from '../playlists/playlistRoutes';
import { DestinationRepository } from '../destinations/destinationRepository';
import { createDestinationRouter } from '../destinations/destinationRoutes';
import { createOAuthRouter } from '../destinations/oauthRoutes';
import { OAuthProviderAdapter } from '../destinations/oauthProviderAdapter';
import { OAuthStateRepository } from '../destinations/oauthStateRepository';
import { OAuthConnectionRepository } from '../destinations/oauthConnectionRepository';
import { StreamManager } from '../stream/streamManager';
import { createStreamRouter } from '../stream/streamRoutes';
import { errorHandler } from './errorHandler';
import { openApiSpec } from './openapi';

export interface AppDeps {
  authService: AuthService;
  trackRepository: TrackRepository;
  trackUploadService: TrackUploadService;
  playlistRepository: PlaylistRepository;
  destinationRepository: DestinationRepository;
  destinationEncryptionKey: string;
  streamManager: StreamManager;
  oauthProviderAdapters: Record<string, OAuthProviderAdapter>;
  oauthStateRepository: OAuthStateRepository;
  oauthConnectionRepository: OAuthConnectionRepository;
  frontendOrigin: string;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(cors({ origin: deps.frontendOrigin, credentials: true }));
  app.use(express.json());
  app.use('/auth', createAuthRouter(deps.authService));
  app.use('/tracks', createTrackRouter(deps.authService, deps.trackUploadService, deps.trackRepository));
  app.use('/playlists', createPlaylistRouter(deps.authService, deps.playlistRepository, deps.trackRepository));
  // Both routers share this prefix safely today because createDestinationRouter has no GET /:id —
  // adding one would shadow createOAuthRouter's GET /:provider/oauth/{start,callback}. Keep that
  // in mind if that route is ever added.
  app.use('/destinations', createDestinationRouter(deps.authService, deps.destinationRepository, deps.destinationEncryptionKey, deps.streamManager, deps.oauthProviderAdapters, deps.oauthConnectionRepository));
  app.use('/destinations', createOAuthRouter(deps.authService, deps.oauthProviderAdapters, deps.oauthStateRepository, deps.oauthConnectionRepository, deps.destinationRepository, deps.destinationEncryptionKey));
  app.use('/destinations/:destinationId/stream', createStreamRouter(deps.authService, deps.streamManager, deps.destinationRepository));
  app.get('/openapi.json', (_req, res) => res.json(openApiSpec));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
  app.use(errorHandler);
  return app;
}
