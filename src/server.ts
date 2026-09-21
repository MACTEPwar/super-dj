import { spawn } from 'child_process';
import { Readable } from 'stream';
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
import { LocalRelayTarget } from './stream/localRelayTarget';
import { MediaMtxAuthRegistry, createMediaMtxAuthApp } from './stream/mediaMtxAuth';
import { LocalStreamManager } from './stream/localStreamManager';
import { StreamSceneDeps } from './stream/streamScene';
import { PreviewFetch } from './stream/localStreamPreviewRoutes';
import { TemplateRepository } from './templates/templateRepository';
import { TemplateImageService } from './templates/templateImageService';
import { StreamPresetRepository } from './stream/streamPresetRepository';
import { InteractionRuleRepository } from './donations/interactionRuleRepository';
import { StubCurrencyConverter } from './donations/currencyConverter';
import { HttpMediaSearchClient } from './donations/mediaSearchClient';
import { executeSongRequest } from './donations/songRequestAction';
import { startTempFileCleanupSweep } from './donations/tempFileCleanup';
import * as os from 'os';
import * as path from 'path';
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
      // Timestamped so a real incident's ffmpeg output (which arrives in irregular, often large
      // \r-joined progress chunks with no timestamp of its own) can be lined up against the app's
      // own timestamped logs below — found missing while investigating a real dropped stream.
      process.stderr.write(`[${new Date().toISOString()}] `);
      process.stderr.write(chunk);
    });
    return child as unknown as ChildProcessLike;
  };
}

export function createPipeSpawner(): PipeSpawner {
  return (command: string, args: string[]): ChildProcessWithPipes => {
    // fd0 (stdin) unused, fd1 (stdout) unused — this process's real output is the RTMP push, not
    // anything on stdout. fd2 (stderr) drained the same way createSpawner() does. fd3/fd4/fd5/fd6
    // are the video/audio/pulse/above-canvas pipes ffmpeg's own args reference as
    // pipe:3/pipe:4/pipe:5/pipe:6. The slots are always opened; whether ffmpeg is told to read
    // pipe:5 or pipe:6 depends on the template (see buildPersistentEncoderArgs).
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
    child.on('error', (err) => {
      console.error('persistent encoder process failed to spawn', err);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[${new Date().toISOString()}] `);
      process.stderr.write(chunk);
    });
    // @types/node's ChildProcess.stdio is a fixed 5-element tuple type — it has no index 5 to
    // type-check against, even though Node itself creates as many stdio streams as the `stdio`
    // option array requested. Cast the whole array once rather than each individual index.
    const stdio = child.stdio as unknown as NodeJS.WritableStream[];
    const videoPipe = stdio[3];
    const audioPipe = stdio[4];
    const pulsePipe = stdio[5];
    const aboveCanvasPipe = stdio[6];
    // An 'error' event with no listener is an uncaught exception in Node, which would crash the
    // whole process (every tenant's active stream, not just this one) — the same hazard the
    // earlier per-segment pipeline's FIFO write-stream guard existed for. Writes fail with EPIPE
    // once the encoder process has died or exited, which can race a still-writing
    // CanvasFeeder/AudioRelay/PulseVisualizer.
    videoPipe.on('error', (err) => { console.error('video pipe write error', err); });
    audioPipe.on('error', (err) => { console.error('audio pipe write error', err); });
    pulsePipe.on('error', (err) => { console.error('pulse pipe write error', err); });
    aboveCanvasPipe.on('error', (err) => { console.error('above-canvas pipe write error', err); });
    return Object.assign(child as unknown as ChildProcessLike, { videoPipe, audioPipe, pulsePipe, aboveCanvasPipe }) as ChildProcessWithPipes;
  };
}

/**
 * Adapts Node 20's global fetch to the PreviewFetch seam the HLS proxy takes. The conversion from
 * a WHATWG ReadableStream to a Node readable happens here, once, so the route can pipe straight
 * through and its tests can hand it a plain Readable without touching global fetch.
 */
export function createPreviewFetch(): PreviewFetch {
  return async (url, init) => {
    // MediaMTX answers a fresh HLS session's first request with a 302 cookie-probe redirect before
    // the real content — verified against a real binary. Node's global fetch follows redirects by
    // default, but that's an implicit default this depends on, not a documented contract; say so.
    const res = await fetch(url, { headers: init.headers, redirect: 'follow' });
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      body: res.body ? Readable.fromWeb(res.body as import('stream/web').ReadableStream) : null,
    };
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
    youtube: new YoutubeProvider({ client: youtubeApiClient, encryptionKey: config.streamKeyEncryptionKey, oauthConnectionRepository, destinationRepository }),
  };

  const templateRepository = new TemplateRepository(prisma);
  const streamPresetRepository = new StreamPresetRepository(prisma);
  const interactionRuleRepository = new InteractionRuleRepository(prisma);
  const donationTempDir = path.join(os.tmpdir(), 'super-dj-donation-songs');
  const mediaSearchClient = new HttpMediaSearchClient(config.mediaSearchServiceUrl);
  const currencyConverter = new StubCurrencyConverter();

  // 30-minute staleness threshold, swept every 10 minutes — a defense-in-depth fallback for the
  // direct cleanup hook in songRequestAction.ts (see that file and the design spec). NOTE: this
  // value must stay comfortably longer than any realistic time a donation-requested track can sit
  // queued-but-unplayed — the sweep reaps by file age with no liveness/in-queue check, so a track
  // still waiting in a long queue past this threshold would be deleted before it ever plays (see
  // the design spec's carried-forward note from the Task 5 review).
  const tempFileCleanupSweep = startTempFileCleanupSweep(donationTempDir, 30 * 60 * 1000, 10 * 60 * 1000);

  // The destination-free half of the pipeline — everything a stream needs that has no destination
  // concept in it. LocalStreamManager below is constructed by spreading this same value, not a
  // second hand-written literal, so it can never drift on fonts, dimensions, uploads or
  // repositories: there is only one literal to edit.
  const sceneDeps: StreamSceneDeps = {
    spawner,
    pipeSpawner: createPipeSpawner(),
    fifoDir: config.fifoDir,
    defaultCoverPath: config.defaultCoverPath,
    backgroundImagePath: config.backgroundImagePath,
    fontFile: FONT_FILE,
    fontFamily: OVERLAY_FONT_FAMILY,
    playlistRepository,
    trackRepository,
    templateRepository,
    templateImageService,
  };

  const mediaMtxAuthRegistry = new MediaMtxAuthRegistry();
  const localStreamManager = new LocalStreamManager({
    sceneDeps,
    relayTarget: new LocalRelayTarget({ rtmpBaseUrl: config.mediaMtxRtmpUrl, hlsBaseUrl: config.mediaMtxHlsUrl }),
    authRegistry: mediaMtxAuthRegistry,
    destinationRepository,
    providers: streamDestinationProviders,
    maxConcurrentStreams: config.maxConcurrentLocalStreams,
    maxSessionDurationMs: config.maxLocalStreamDurationMs,
  });

  // A SEPARATE app on a SEPARATE, unpublished port: MediaMTX is not a browser and cannot present
  // the session cookie requireAuth needs, so this must never be mounted on the public API.
  const mediaMtxAuthApp = createMediaMtxAuthApp(mediaMtxAuthRegistry, config.mediaMtxAuthSecret);

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
    localStreamManager,
    previewFetch: createPreviewFetch(),
    oauthProviderAdapters,
    oauthStateRepository,
    oauthConnectionRepository,
    templateRepository,
    templateRendererDeps,
    templateImageService,
    streamPresetRepository,
    interactionRuleRepository,
    donatelloWebhookDeps: {
      callbackKey: config.donatelloCallbackKey,
      converter: currencyConverter,
      targetUserId: config.donationTargetUserId,
      executeSongRequest: (query: string) => executeSongRequest(
        { mediaSearchClient, streamInserter: localStreamManager, tempDir: donationTempDir, targetUserId: config.donationTargetUserId },
        query,
      ),
    },
    frontendOrigin: config.frontendOrigin,
  });

  return { app, prisma, mediaMtxAuthApp, mediaMtxAuthPort: config.mediaMtxAuthPort, tempFileCleanupSweep };
}
