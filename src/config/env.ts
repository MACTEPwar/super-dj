import { posix as path } from 'path';

// Guards two dangerous silent failure modes an unvalidated parseInt would let through: a
// non-numeric MAX_CONCURRENT_LOCAL_STREAMS becomes NaN and `size >= NaN` is always false, silently
// DISABLING the concurrency cap entirely; a non-numeric MAX_LOCAL_STREAM_HOURS becomes NaN and
// setTimeout(fn, NaN * 3600000) fires on the very next tick, auto-stopping every local stream the
// instant it starts.
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface AppConfig {
  port: number;
  defaultCoverPath: string;
  backgroundImagePath: string;
  databaseUrl: string;
  sessionTtlDays: number;
  uploadsDir: string;
  streamKeyEncryptionKey: string;
  fifoDir: string;
  googleOAuthClientId: string;
  googleOAuthClientSecret: string;
  appBaseUrl: string;
  frontendOrigin: string;
  // Where the local encode publishes and where the HLS preview proxy reads, on the compose
  // network. MediaMTX publishes no ports, so these are only ever reachable from inside it.
  mediaMtxRtmpUrl: string;
  mediaMtxHlsUrl: string;
  // Guards the unpublished authHTTP endpoint MediaMTX calls. Travels as a path segment of
  // MTX_AUTHHTTPADDRESS because MediaMTX sets no custom headers on that request.
  mediaMtxAuthSecret: string;
  mediaMtxAuthPort: number;
  maxConcurrentLocalStreams: number;
  maxLocalStreamDurationMs: number;
  // Shared secret Donatello sends back as the `X-Key` header on every donation callback
  // (their "Колбеки" tab), so we can tell a real donation from a forged request. Required,
  // never defaulted, for the same reason MEDIAMTX_AUTH_SECRET is: a defaulted shared secret
  // is a backdoor, and this is the only thing standing between a real donation and anyone
  // who can guess our webhook URL triggering stream actions for free.
  donatelloCallbackKey: string;
  // MVP stopgap: exactly one account uses this feature, so the webhook's target user is a fixed
  // id rather than a per-user token in the URL. Tracked as a known follow-up in the design spec —
  // replace with real per-user webhook routing the moment a second user exists.
  donationTargetUserId: string;
  // Base URL of the streamer's own media-search microservice (GET {url}/download/audio?query=).
  // Never hardcode this — it points at a specific internal host that will differ per deployment.
  mediaSearchServiceUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  const streamKeyEncryptionKey = env.STREAM_KEY_ENCRYPTION_KEY;
  const googleOAuthClientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const googleOAuthClientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  const appBaseUrl = env.APP_BASE_URL;
  const frontendOrigin = env.FRONTEND_ORIGIN;
  const mediaMtxAuthSecret = env.MEDIAMTX_AUTH_SECRET;
  const donatelloCallbackKey = env.DONATELLO_CALLBACK_KEY;
  const donationTargetUserId = env.DONATION_TARGET_USER_ID;
  const mediaSearchServiceUrl = env.MEDIA_SEARCH_SERVICE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  if (!streamKeyEncryptionKey) {
    throw new Error('STREAM_KEY_ENCRYPTION_KEY environment variable is required');
  }
  if (!googleOAuthClientId) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID environment variable is required');
  }
  if (!googleOAuthClientSecret) {
    throw new Error('GOOGLE_OAUTH_CLIENT_SECRET environment variable is required');
  }
  if (!appBaseUrl) {
    throw new Error('APP_BASE_URL environment variable is required');
  }
  if (!frontendOrigin) {
    throw new Error('FRONTEND_ORIGIN environment variable is required');
  }
  // Required, never defaulted: a defaulted shared secret is a backdoor, and MediaMTX's auth
  // callback is the only thing standing between one tenant's stream and another's.
  if (!mediaMtxAuthSecret) {
    throw new Error('MEDIAMTX_AUTH_SECRET environment variable is required');
  }
  if (!donatelloCallbackKey) {
    throw new Error('DONATELLO_CALLBACK_KEY environment variable is required');
  }
  if (!donationTargetUserId) {
    throw new Error('DONATION_TARGET_USER_ID environment variable is required');
  }
  if (!mediaSearchServiceUrl) {
    throw new Error('MEDIA_SEARCH_SERVICE_URL environment variable is required');
  }

  return {
    port: env.PORT ? parseInt(env.PORT, 10) : 3000,
    defaultCoverPath: env.DEFAULT_COVER_PATH ?? path.join(process.cwd(), 'assets', 'default-cover.png'),
    backgroundImagePath: env.BACKGROUND_IMAGE_PATH ?? path.join(process.cwd(), 'assets', 'background.png'),
    databaseUrl,
    sessionTtlDays: env.SESSION_TTL_DAYS ? parseInt(env.SESSION_TTL_DAYS, 10) : 30,
    uploadsDir: env.UPLOADS_DIR ?? '/data/uploads',
    streamKeyEncryptionKey,
    fifoDir: env.FIFO_DIR ?? '/tmp',
    googleOAuthClientId,
    googleOAuthClientSecret,
    appBaseUrl,
    frontendOrigin,
    mediaMtxRtmpUrl: env.MEDIAMTX_RTMP_URL ?? 'rtmp://mediamtx:1935',
    mediaMtxHlsUrl: env.MEDIAMTX_HLS_URL ?? 'http://mediamtx:8888',
    mediaMtxAuthSecret,
    mediaMtxAuthPort: parsePositiveInt(env.MEDIAMTX_AUTH_PORT, 3001),
    donatelloCallbackKey,
    donationTargetUserId,
    mediaSearchServiceUrl,
    // Spec open question #8. Sized against one libx264 720p30 ultrafast encode per stream.
    maxConcurrentLocalStreams: parsePositiveInt(env.MAX_CONCURRENT_LOCAL_STREAMS, 10),
    // Spec open question #7. A local stream can now run with zero destinations and zero viewers,
    // still paying for a full encode — this is the ceiling on that.
    maxLocalStreamDurationMs: parsePositiveInt(env.MAX_LOCAL_STREAM_HOURS, 12) * 60 * 60 * 1000,
  };
}
