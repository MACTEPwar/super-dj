import { spawn } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { AppConfig } from './config/env';
import { UserRepository } from './auth/userRepository';
import { SessionRepository } from './auth/sessionRepository';
import { AuthService } from './auth/authService';
import { TrackRepository } from './tracks/trackRepository';
import { TrackUploadService } from './tracks/trackUploadService';
import { PlaylistRepository } from './playlists/playlistRepository';
import { DestinationRepository } from './destinations/destinationRepository';
import { OAuthConnectionRepository } from './destinations/oauthConnectionRepository';
import { OAuthStateRepository } from './destinations/oauthStateRepository';
import { createYoutubeApiClient } from './destinations/youtubeApiClient';
import { YoutubeOAuthAdapter } from './destinations/youtubeOAuthAdapter';
import { OAuthProviderAdapter } from './destinations/oauthProviderAdapter';
import { CustomRtmpProvider } from './destinations/customRtmpProvider';
import { YoutubeProvider } from './destinations/youtubeProvider';
import { StreamDestinationProvider } from './destinations/streamDestinationProvider';
import { StreamManager } from './stream/streamManager';
import { StreamSessionRepository } from './stream/streamSessionRepository';
import { StreamSessionManager } from './stream/streamSessionManager';
import { TemplateRepository } from './templates/templateRepository';
import { TemplateImageService } from './templates/templateImageService';
import { Spawner, ChildProcessLike, ChildProcessWithPipes, PipeSpawner } from './ffmpeg/types';
import { createApp } from './api/app';

const FONT_FILE = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const OVERLAY_FONT_FAMILY = 'DejaVu Sans';
const YOUTUBE_OAUTH_SCOPE = 'https://www.googleapis.com/auth/youtube';

/**
 * Wraps child_process.spawn so every spawned ffmpeg has its stderr drained.
 * ffmpeg writes a banner plus continuous progress to stderr; if nothing reads
 * it the OS pipe buffer (~64KB) fills and ffmpeg blocks on write, stalling the
 * whole pipeline. Forwarding it to our own stderr also surfaces ffmpeg errors
 * in the container logs.
 */
export function createSpawner(): Spawner {
  return (command: string, args: string[]): ChildProcessLike => {
    const child = spawn(command, args);
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    return child as unknown as ChildProcessLike;
  };
}

export function createPipeSpawner(): PipeSpawner {
  return (command: string, args: string[]): ChildProcessWithPipes => {
    // fd0 (stdin) unused, fd1 (stdout) unused — this process's real output is the RTMP push, not
    // anything on stdout. fd2 (stderr) drained the same way createSpawner() does. fd3/fd4/fd5 are
    // the video/audio/pulse pipes ffmpeg's own args reference as pipe:3/pipe:4/pipe:5.
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
    child.on('error', (err) => {
      console.error('persistent encoder process failed to spawn', err);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    // @types/node's ChildProcess.stdio is a fixed 5-element tuple type — it has no index 5 to
    // type-check against, even though Node itself creates as many stdio streams as the `stdio`
    // option array requested. Cast the whole array once rather than each individual index.
    const stdio = child.stdio as unknown as NodeJS.WritableStream[];
    const videoPipe = stdio[3];
    const audioPipe = stdio[4];
    const pulsePipe = stdio[5];
    // An 'error' event with no listener is an uncaught exception in Node, which would crash the
    // whole process (every tenant's active stream, not just this one) — the same hazard the
    // earlier per-segment pipeline's FIFO write-stream guard existed for. Writes fail with EPIPE
    // once the encoder process has died or exited, which can race a still-writing
    // CanvasFeeder/AudioRelay/PulseVisualizer.
    videoPipe.on('error', (err) => { console.error('video pipe write error', err); });
    audioPipe.on('error', (err) => { console.error('audio pipe write error', err); });
    pulsePipe.on('error', (err) => { console.error('pulse pipe write error', err); });
    return Object.assign(child as unknown as ChildProcessLike, { videoPipe, audioPipe, pulsePipe }) as ChildProcessWithPipes;
  };
}

export function buildServer(config: AppConfig, spawner: Spawner = createSpawner()) {
  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });

  const userRepository = new UserRepository(prisma);
  const sessionRepository = new SessionRepository(prisma);
  const authService = new AuthService({ userRepository, sessionRepository, sessionTtlDays: config.sessionTtlDays });

  const trackRepository = new TrackRepository(prisma);
  const trackUploadService = new TrackUploadService({ trackRepository, uploadsDir: config.uploadsDir });
  const templateImageService = new TemplateImageService({ uploadsDir: config.uploadsDir });
  const playlistRepository = new PlaylistRepository(prisma);
  const destinationRepository = new DestinationRepository(prisma);
  const oauthConnectionRepository = new OAuthConnectionRepository(prisma);
  const oauthStateRepository = new OAuthStateRepository(prisma);

  const youtubeApiClient = createYoutubeApiClient({ clientId: config.googleOAuthClientId, clientSecret: config.googleOAuthClientSecret });
  const youtubeOAuthAdapter = new YoutubeOAuthAdapter({
    client: youtubeApiClient,
    clientId: config.googleOAuthClientId,
    redirectUri: `${config.appBaseUrl}/destinations/youtube/oauth/callback`,
    scope: YOUTUBE_OAUTH_SCOPE,
  });
  const oauthProviderAdapters: Record<string, OAuthProviderAdapter> = { youtube: youtubeOAuthAdapter };

  const streamDestinationProviders: Record<string, StreamDestinationProvider> = {
    custom: new CustomRtmpProvider(config.streamKeyEncryptionKey),
    youtube: new YoutubeProvider({ client: youtubeApiClient, encryptionKey: config.streamKeyEncryptionKey, oauthConnectionRepository }),
  };

  const templateRepository = new TemplateRepository(prisma);

  const streamManager = new StreamManager({
    spawner,
    pipeSpawner: createPipeSpawner(),
    fifoDir: config.fifoDir,
    defaultCoverPath: config.defaultCoverPath,
    backgroundImagePath: config.backgroundImagePath,
    fontFile: FONT_FILE,
    fontFamily: OVERLAY_FONT_FAMILY,
    playlistRepository,
    destinationRepository,
    trackRepository,
    templateRepository,
    templateImageService,
    providers: streamDestinationProviders,
  });

  const streamSessionRepository = new StreamSessionRepository(prisma);
  const streamSessionManager = new StreamSessionManager({
    streamManager,
    streamSessionRepository,
    destinationRepository,
    playlistRepository,
    templateRepository,
  });

  const templateRendererDeps = {
    fontPath: FONT_FILE,
    fontFamily: OVERLAY_FONT_FAMILY,
    defaultCoverPath: config.defaultCoverPath,
  };

  const app = createApp({
    authService,
    trackRepository,
    trackUploadService,
    playlistRepository,
    destinationRepository,
    destinationEncryptionKey: config.streamKeyEncryptionKey,
    streamManager,
    streamSessionManager,
    oauthProviderAdapters,
    oauthStateRepository,
    oauthConnectionRepository,
    templateRepository,
    templateRendererDeps,
    templateImageService,
    frontendOrigin: config.frontendOrigin,
  });

  return { app, prisma };
}
