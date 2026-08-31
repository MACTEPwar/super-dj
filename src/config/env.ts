import { posix as path } from 'path';

export interface AppConfig {
  port: number;
  rtmpUrl: string;
  streamKey: string;
  audioDir: string;
  defaultCoverPath: string;
  backgroundImagePath: string;
  fifoPath: string;
  databaseUrl: string;
  sessionTtlDays: number;
  uploadsDir: string;
  streamKeyEncryptionKey: string;
  fifoDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rtmpUrl = env.RTMP_URL;
  const streamKey = env.STREAM_KEY;
  const databaseUrl = env.DATABASE_URL;
  const streamKeyEncryptionKey = env.STREAM_KEY_ENCRYPTION_KEY;

  if (!rtmpUrl) {
    throw new Error('RTMP_URL environment variable is required');
  }
  if (!streamKey) {
    throw new Error('STREAM_KEY environment variable is required');
  }
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  if (!streamKeyEncryptionKey) {
    throw new Error('STREAM_KEY_ENCRYPTION_KEY environment variable is required');
  }

  return {
    port: env.PORT ? parseInt(env.PORT, 10) : 3000,
    rtmpUrl,
    streamKey,
    audioDir: env.AUDIO_DIR ?? '/data/audio',
    defaultCoverPath: env.DEFAULT_COVER_PATH ?? path.join(process.cwd(), 'assets', 'default-cover.png'),
    backgroundImagePath: env.BACKGROUND_IMAGE_PATH ?? path.join(process.cwd(), 'assets', 'background.png'),
    fifoPath: env.FIFO_PATH ?? '/tmp/super-dj-stream.fifo',
    databaseUrl,
    sessionTtlDays: env.SESSION_TTL_DAYS ? parseInt(env.SESSION_TTL_DAYS, 10) : 30,
    uploadsDir: env.UPLOADS_DIR ?? '/data/uploads',
    streamKeyEncryptionKey,
    fifoDir: env.FIFO_DIR ?? '/tmp',
  };
}
