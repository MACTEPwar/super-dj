import { posix as path } from 'path';

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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  const streamKeyEncryptionKey = env.STREAM_KEY_ENCRYPTION_KEY;
  const googleOAuthClientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const googleOAuthClientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  const appBaseUrl = env.APP_BASE_URL;

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
  };
}
