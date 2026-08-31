import { loadConfig } from '../../src/config/env';

describe('loadConfig', () => {
  const base = {
    RTMP_URL: 'rtmp://example.com/live',
    STREAM_KEY: 'key123',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    STREAM_KEY_ENCRYPTION_KEY: 'a'.repeat(64),
  } as NodeJS.ProcessEnv;

  it('throws when RTMP_URL is missing', () => {
    expect(() => loadConfig({
      STREAM_KEY: 'key123', DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    } as NodeJS.ProcessEnv))
      .toThrow('RTMP_URL environment variable is required');
  });

  it('throws when STREAM_KEY is missing', () => {
    expect(() => loadConfig({
      RTMP_URL: 'rtmp://example.com/live', DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    } as NodeJS.ProcessEnv))
      .toThrow('STREAM_KEY environment variable is required');
  });

  it('applies defaults for optional values', () => {
    const config = loadConfig(base);
    expect(config.port).toBe(3000);
    expect(config.audioDir).toBe('/data/audio');
    expect(config.fifoPath).toBe('/tmp/super-dj-stream.fifo');
    expect(config.backgroundImagePath.endsWith('background.png')).toBe(true);
  });

  it('honors overrides', () => {
    const config = loadConfig({
      ...base, PORT: '8080', AUDIO_DIR: '/music', FIFO_PATH: '/tmp/x.fifo', BACKGROUND_IMAGE_PATH: '/assets/bg.png',
    } as NodeJS.ProcessEnv);
    expect(config.port).toBe(8080);
    expect(config.audioDir).toBe('/music');
    expect(config.fifoPath).toBe('/tmp/x.fifo');
    expect(config.backgroundImagePath).toBe('/assets/bg.png');
  });
});

describe('loadConfig — database', () => {
  const base = {
    RTMP_URL: 'rtmp://example.com/live', STREAM_KEY: 'key123', STREAM_KEY_ENCRYPTION_KEY: 'a'.repeat(64),
  } as NodeJS.ProcessEnv;

  it('throws when DATABASE_URL is missing', () => {
    expect(() => loadConfig(base)).toThrow('DATABASE_URL environment variable is required');
  });

  it('applies a default sessionTtlDays of 30', () => {
    const config = loadConfig({ ...base, DATABASE_URL: 'postgresql://u:p@localhost:5432/db' } as NodeJS.ProcessEnv);
    expect(config.databaseUrl).toBe('postgresql://u:p@localhost:5432/db');
    expect(config.sessionTtlDays).toBe(30);
  });

  it('honors an overridden SESSION_TTL_DAYS', () => {
    const config = loadConfig({
      ...base, DATABASE_URL: 'postgresql://u:p@localhost:5432/db', SESSION_TTL_DAYS: '7',
    } as NodeJS.ProcessEnv);
    expect(config.sessionTtlDays).toBe(7);
  });
});

describe('loadConfig — multi-tenant additions', () => {
  const base = {
    RTMP_URL: 'rtmp://example.com/live', STREAM_KEY: 'key123', DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  } as NodeJS.ProcessEnv;

  it('applies defaults for uploadsDir, streamKeyEncryptionKey requirement, and fifoDir', () => {
    const config = loadConfig({ ...base, STREAM_KEY_ENCRYPTION_KEY: 'a'.repeat(64) } as NodeJS.ProcessEnv);
    expect(config.uploadsDir).toBe('/data/uploads');
    expect(config.fifoDir).toBe('/tmp');
    expect(config.streamKeyEncryptionKey).toBe('a'.repeat(64));
  });

  it('throws when STREAM_KEY_ENCRYPTION_KEY is missing', () => {
    expect(() => loadConfig(base)).toThrow('STREAM_KEY_ENCRYPTION_KEY environment variable is required');
  });

  it('honors overridden UPLOADS_DIR and FIFO_DIR', () => {
    const config = loadConfig({
      ...base, STREAM_KEY_ENCRYPTION_KEY: 'a'.repeat(64), UPLOADS_DIR: '/srv/uploads', FIFO_DIR: '/var/run/super-dj',
    } as NodeJS.ProcessEnv);
    expect(config.uploadsDir).toBe('/srv/uploads');
    expect(config.fifoDir).toBe('/var/run/super-dj');
  });
});
