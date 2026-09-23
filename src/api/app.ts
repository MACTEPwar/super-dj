import express, { Express } from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { AuthService } from '../auth/authService';
import { createAuthRouter } from '../auth/authRoutes';
import { UserRepository } from '../auth/userRepository';
import { TrackRepository } from '../tracks/trackRepository';
import { TrackUploadService } from '../tracks/trackUploadService';
import { createTrackRouter } from '../tracks/trackRoutes';
import { TrackPreviewService } from '../tracks/trackPreviewService';
import { PlaylistRepository } from '../playlists/playlistRepository';
import { createPlaylistRouter } from '../playlists/playlistRoutes';
import { DestinationRepository } from '../destinations/destinationRepository';
import { createDestinationRouter } from '../destinations/destinationRoutes';
import { createOAuthRouter } from '../destinations/oauthRoutes';
import { OAuthProviderAdapter } from '../destinations/oauthProviderAdapter';
import { OAuthStateRepository } from '../destinations/oauthStateRepository';
import { OAuthConnectionRepository } from '../destinations/oauthConnectionRepository';
import { LocalStreamManager } from '../stream/localStreamManager';
import { createLocalStreamRouter } from '../stream/localStreamRoutes';
import { PreviewFetch } from '../stream/localStreamPreviewRoutes';
import { TemplateRepository } from '../templates/templateRepository';
import { createTemplateRouter, TemplateRendererDeps } from '../templates/templateRoutes';
import { TemplateImageService } from '../templates/templateImageService';
import { StreamPresetRepository } from '../stream/streamPresetRepository';
import { createStreamPresetRouter } from '../stream/streamPresetRoutes';
import { InteractionRuleRepository } from '../donations/interactionRuleRepository';
import { createInteractionRuleRouter } from '../donations/interactionRuleRoutes';
import { createDonatelloWebhookRouter, DonatelloWebhookDeps } from '../donations/donatelloWebhookRoutes';
import { createRequestPageRouter } from '../requestPage/requestPageRoutes';
import { errorHandler } from './errorHandler';
import { openApiSpec } from './openapi';

export interface AppDeps {
  authService: AuthService;
  userRepository: UserRepository;
  trackRepository: TrackRepository;
  trackUploadService: TrackUploadService;
  trackPreviewService: TrackPreviewService;
  playlistRepository: PlaylistRepository;
  destinationRepository: DestinationRepository;
  destinationEncryptionKey: string;
  localStreamManager: LocalStreamManager;
  previewFetch: PreviewFetch;
  oauthProviderAdapters: Record<string, OAuthProviderAdapter>;
  oauthStateRepository: OAuthStateRepository;
  oauthConnectionRepository: OAuthConnectionRepository;
  templateRepository: TemplateRepository;
  templateRendererDeps: TemplateRendererDeps;
  templateImageService: TemplateImageService;
  streamPresetRepository: StreamPresetRepository;
  interactionRuleRepository: InteractionRuleRepository;
  donatelloWebhookDeps: Omit<DonatelloWebhookDeps, 'ruleRepository'>;
  frontendOrigin: string;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(cors({ origin: deps.frontendOrigin, credentials: true }));
  app.use(express.json());
  app.use('/auth', createAuthRouter(deps.authService));
  app.use('/tracks', createTrackRouter(deps.authService, deps.trackUploadService, deps.trackRepository, deps.trackPreviewService));
  app.use('/playlists', createPlaylistRouter(deps.authService, deps.playlistRepository, deps.trackRepository));
  // Both routers share this prefix safely today because createDestinationRouter has no GET /:id —
  // adding one would shadow createOAuthRouter's GET /:provider/oauth/{start,callback}. Keep that
  // in mind if that route is ever added.
  app.use('/destinations', createDestinationRouter(deps.authService, deps.destinationRepository, deps.destinationEncryptionKey, deps.localStreamManager, deps.oauthProviderAdapters, deps.oauthConnectionRepository));
  app.use('/destinations', createOAuthRouter(deps.authService, deps.oauthProviderAdapters, deps.oauthStateRepository, deps.oauthConnectionRepository, deps.destinationRepository, deps.destinationEncryptionKey));
  app.use('/local-stream', createLocalStreamRouter(deps.authService, deps.localStreamManager, deps.previewFetch));
  app.use('/stream-presets', createStreamPresetRouter(deps.authService, deps.streamPresetRepository, deps.playlistRepository, deps.templateRepository, deps.destinationRepository));
  app.use('/interaction-rules', createInteractionRuleRouter(deps.authService, deps.interactionRuleRepository, {
    converter: deps.donatelloWebhookDeps.converter,
    executeSongRequest: deps.donatelloWebhookDeps.executeSongRequest,
  }));
  app.use('/webhooks/donatello', createDonatelloWebhookRouter({ ...deps.donatelloWebhookDeps, ruleRepository: deps.interactionRuleRepository }));
  app.use('/templates', createTemplateRouter(deps.authService, deps.templateRepository, deps.trackRepository, deps.templateRendererDeps, deps.templateImageService));
  app.use('/request-page', createRequestPageRouter(deps.authService, deps.userRepository));
  app.get('/openapi.json', (_req, res) => res.json(openApiSpec));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
  app.use(errorHandler);
  return app;
}
