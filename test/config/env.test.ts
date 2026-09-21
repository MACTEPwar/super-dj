import { loadConfig } from '../../src/config/env';

describe('loadConfig', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    STREAM_KEY_ENCRYPTION_KEY: 'a'.repeat(64),
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    APP_BASE_URL: 'https://app.example.com',
    FRONTEND_ORIGIN: 'https://web.example.com',
    MEDIAMTX_AUTH_SECRET: 'shared',
    DONATELLO_CALLBACK_KEY: 'donatello-key',
    DONATION_TARGET_USER_ID: 'user-123',
    MEDIA_SEARCH_SERVICE_URL: 'http://192.168.14.26:8010',
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
    FRONTEND_ORIGIN: 'https://web.example.com',
    MEDIAMTX_AUTH_SECRET: 'shared',
    DONATELLO_CALLBACK_KEY: 'donatello-key',
    DONATION_TARGET_USER_ID: 'user-123',
    MEDIA_SEARCH_SERVICE_URL: 'http://192.168.14.26:8010',
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
    FRONTEND_ORIGIN: 'https://web.example.com',
    MEDIAMTX_AUTH_SECRET: 'shared',
    DONATELLO_CALLBACK_KEY: 'donatello-key',
    DONATION_TARGET_USER_ID: 'user-123',
    MEDIA_SEARCH_SERVICE_URL: 'http://192.168.14.26:8010',
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
    FRONTEND_ORIGIN: 'https://web.example.com',
    MEDIAMTX_AUTH_SECRET: 'shared',
    DONATELLO_CALLBACK_KEY: 'donatello-key',
    DONATION_TARGET_USER_ID: 'user-123',
    MEDIA_SEARCH_SERVICE_URL: 'http://192.168.14.26:8010',
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

describe('loadConfig — frontend origin', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db', STREAM_KEY_ENCRYPTION_KEY: 'a'.repeat(64),
    GOOGLE_OAUTH_CLIENT_ID: 'x', GOOGLE_OAUTH_CLIENT_SECRET: 'y', APP_BASE_URL: 'https://app.example.com',
    MEDIAMTX_AUTH_SECRET: 'shared',
    DONATELLO_CALLBACK_KEY: 'donatello-key',
    DONATION_TARGET_USER_ID: 'user-123',
    MEDIA_SEARCH_SERVICE_URL: 'http://192.168.14.26:8010',
  } as NodeJS.ProcessEnv;

  it('applies FRONTEND_ORIGIN', () => {
    const config = loadConfig({ ...base, FRONTEND_ORIGIN: 'https://web.example.com' } as NodeJS.ProcessEnv);
    expect(config.frontendOrigin).toBe('https://web.example.com');
  });

  it('throws when FRONTEND_ORIGIN is missing', () => {
    expect(() => loadConfig(base)).toThrow('FRONTEND_ORIGIN environment variable is required');
  });
});

describe('loadConfig — local-first streaming additions', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    STREAM_KEY_ENCRYPTION_KEY: 'a'.repeat(64),
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    APP_BASE_URL: 'https://app.example.com',
    FRONTEND_ORIGIN: 'https://web.example.com',
    DONATION_TARGET_USER_ID: 'user-123',
    MEDIA_SEARCH_SERVICE_URL: 'http://192.168.14.26:8010',
  } as NodeJS.ProcessEnv;

  it('applies compose-network defaults for the MediaMTX endpoints and the caps', () => {
    const config = loadConfig({
      ...base, MEDIAMTX_AUTH_SECRET: 'shared', DONATELLO_CALLBACK_KEY: 'donatello-key',
    } as NodeJS.ProcessEnv);
    expect(config.mediaMtxRtmpUrl).toBe('rtmp://mediamtx:1935');
    expect(config.mediaMtxHlsUrl).toBe('http://mediamtx:8888');
    expect(config.mediaMtxAuthPort).toBe(3001);
    expect(config.maxConcurrentLocalStreams).toBe(10);
    expect(config.maxLocalStreamDurationMs).toBe(12 * 60 * 60 * 1000);
  });

  // Required, never defaulted: a defaulted shared secret is a backdoor, and MediaMTX's auth
  // callback is the only thing standing between one tenant's stream and another's.
  it('throws when MEDIAMTX_AUTH_SECRET is missing', () => {
    expect(() => loadConfig(base)).toThrow('MEDIAMTX_AUTH_SECRET environment variable is required');
  });

  it('honors overrides', () => {
    const config = loadConfig({
      ...base,
      MEDIAMTX_AUTH_SECRET: 'shared',
      DONATELLO_CALLBACK_KEY: 'donatello-key',
      MEDIAMTX_RTMP_URL: 'rtmp://relay.internal:1935',
      MEDIAMTX_HLS_URL: 'http://relay.internal:8888',
      MEDIAMTX_AUTH_PORT: '4100',
      MAX_CONCURRENT_LOCAL_STREAMS: '3',
      MAX_LOCAL_STREAM_HOURS: '4',
    } as NodeJS.ProcessEnv);
    expect(config.mediaMtxRtmpUrl).toBe('rtmp://relay.internal:1935');
    expect(config.mediaMtxHlsUrl).toBe('http://relay.internal:8888');
    expect(config.mediaMtxAuthPort).toBe(4100);
    expect(config.maxConcurrentLocalStreams).toBe(3);
    expect(config.maxLocalStreamDurationMs).toBe(4 * 60 * 60 * 1000);
  });
});

describe('loadConfig — Donatello donation callback', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    STREAM_KEY_ENCRYPTION_KEY: 'a'.repeat(64),
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    APP_BASE_URL: 'https://app.example.com',
    FRONTEND_ORIGIN: 'https://web.example.com',
    MEDIAMTX_AUTH_SECRET: 'shared',
    DONATION_TARGET_USER_ID: 'user-123',
    MEDIA_SEARCH_SERVICE_URL: 'http://192.168.14.26:8010',
  } as NodeJS.ProcessEnv;

  it('applies DONATELLO_CALLBACK_KEY', () => {
    const config = loadConfig({ ...base, DONATELLO_CALLBACK_KEY: 'donatello-key' } as NodeJS.ProcessEnv);
    expect(config.donatelloCallbackKey).toBe('donatello-key');
  });

  // Required, never defaulted: this is the only thing that tells a real Donatello callback
  // apart from anyone who guesses the webhook URL and forges a "donation" to trigger stream
  // actions for free.
  it('throws when DONATELLO_CALLBACK_KEY is missing', () => {
    expect(() => loadConfig(base)).toThrow('DONATELLO_CALLBACK_KEY environment variable is required');
  });
});

describe('loadConfig — donation song request', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    STREAM_KEY_ENCRYPTION_KEY: 'a'.repeat(64),
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    APP_BASE_URL: 'https://app.example.com',
    FRONTEND_ORIGIN: 'https://web.example.com',
    MEDIAMTX_AUTH_SECRET: 'shared',
    DONATELLO_CALLBACK_KEY: 'donatello-key',
  } as NodeJS.ProcessEnv;

  it('applies DONATION_TARGET_USER_ID and MEDIA_SEARCH_SERVICE_URL', () => {
    const config = loadConfig({
      ...base,
      DONATION_TARGET_USER_ID: 'user-123',
      MEDIA_SEARCH_SERVICE_URL: 'http://192.168.14.26:8010',
    } as NodeJS.ProcessEnv);
    expect(config.donationTargetUserId).toBe('user-123');
    expect(config.mediaSearchServiceUrl).toBe('http://192.168.14.26:8010');
  });

  it('throws when DONATION_TARGET_USER_ID is missing', () => {
    expect(() => loadConfig({ ...base, MEDIA_SEARCH_SERVICE_URL: 'http://x' } as NodeJS.ProcessEnv))
      .toThrow('DONATION_TARGET_USER_ID environment variable is required');
  });

  it('throws when MEDIA_SEARCH_SERVICE_URL is missing', () => {
    expect(() => loadConfig({ ...base, DONATION_TARGET_USER_ID: 'user-123' } as NodeJS.ProcessEnv))
      .toThrow('MEDIA_SEARCH_SERVICE_URL environment variable is required');
  });
});
