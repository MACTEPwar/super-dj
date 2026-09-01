import { loadConfig } from '../../src/config/env';

describe('loadConfig', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    STREAM_KEY_ENCRYPTION_KEY: 'a'.repeat(64),
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    APP_BASE_URL: 'https://app.example.com',
  } as NodeJS.ProcessEnv;

  it('applies defaults for optional values', () => {
    const config = loadConfig(base);
    expect(config.port).toBe(3000);
    expect(config.backgroundImagePath.endsWith('background.png')).toBe(true);
  });

  it('honors overrides', () => {
    const config = loadConfig({
      ...base, PORT: '8080', BACKGROUND_IMAGE_PATH: '/assets/bg.png',
    } as NodeJS.ProcessEnv);
    expect(config.port).toBe(8080);
    expect(config.backgroundImagePath).toBe('/assets/bg.png');
  });
});

describe('loadConfig — database', () => {
  const base = {
    STREAM_KEY_ENCRYPTION_KEY: 'a'.repeat(64),
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    APP_BASE_URL: 'https://app.example.com',
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
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    APP_BASE_URL: 'https://app.example.com',
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

describe('loadConfig — YouTube OAuth additions', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    STREAM_KEY_ENCRYPTION_KEY: 'a'.repeat(64),
  } as NodeJS.ProcessEnv;

  it('applies GOOGLE_OAUTH_CLIENT_ID/SECRET and APP_BASE_URL', () => {
    const config = loadConfig({
      ...base, GOOGLE_OAUTH_CLIENT_ID: 'client-id', GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret', APP_BASE_URL: 'https://app.example.com',
    } as NodeJS.ProcessEnv);
    expect(config.googleOAuthClientId).toBe('client-id');
    expect(config.googleOAuthClientSecret).toBe('client-secret');
    expect(config.appBaseUrl).toBe('https://app.example.com');
  });

  it('throws when GOOGLE_OAUTH_CLIENT_ID is missing', () => {
    expect(() => loadConfig({ ...base, GOOGLE_OAUTH_CLIENT_SECRET: 'x', APP_BASE_URL: 'https://app.example.com' } as NodeJS.ProcessEnv))
      .toThrow('GOOGLE_OAUTH_CLIENT_ID environment variable is required');
  });

  it('throws when GOOGLE_OAUTH_CLIENT_SECRET is missing', () => {
    expect(() => loadConfig({ ...base, GOOGLE_OAUTH_CLIENT_ID: 'x', APP_BASE_URL: 'https://app.example.com' } as NodeJS.ProcessEnv))
      .toThrow('GOOGLE_OAUTH_CLIENT_SECRET environment variable is required');
  });

  it('throws when APP_BASE_URL is missing', () => {
    expect(() => loadConfig({ ...base, GOOGLE_OAUTH_CLIENT_ID: 'x', GOOGLE_OAUTH_CLIENT_SECRET: 'y' } as NodeJS.ProcessEnv))
      .toThrow('APP_BASE_URL environment variable is required');
  });
});
