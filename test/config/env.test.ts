import { loadConfig } from '../../src/config/env';

describe('loadConfig', () => {
  const base = { RTMP_URL: 'rtmp://example.com/live', STREAM_KEY: 'key123' } as NodeJS.ProcessEnv;

  it('throws when RTMP_URL is missing', () => {
    expect(() => loadConfig({ STREAM_KEY: 'key123' } as NodeJS.ProcessEnv))
      .toThrow('RTMP_URL environment variable is required');
  });

  it('throws when STREAM_KEY is missing', () => {
    expect(() => loadConfig({ RTMP_URL: 'rtmp://example.com/live' } as NodeJS.ProcessEnv))
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
