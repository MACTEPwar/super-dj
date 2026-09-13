import { readFileSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';

const repoRoot = join(__dirname, '..', '..');

function loadYaml<T>(...parts: string[]): T {
  return load(readFileSync(join(repoRoot, ...parts), 'utf8')) as T;
}

interface ComposeFile {
  services: Record<string, { image?: string; ports?: unknown; volumes?: string[]; environment?: Record<string, string>; depends_on?: unknown; restart?: string; mem_limit?: string }>;
}

interface MediaMtxConfig {
  api: boolean; metrics: boolean; pprof: boolean; playback: boolean;
  rtsp: boolean; webrtc: boolean; srt: boolean; rtmp: boolean; hls: boolean;
  authMethod: string; authHTTPExclude: unknown[];
  hlsVariant: string; hlsAlwaysRemux: boolean;
  paths: Record<string, unknown>;
}

describe('MediaMTX deployment invariants', () => {
  const compose = loadYaml<ComposeFile>('docker-compose.yml');
  const mediamtx = compose.services.mediamtx;
  const config = loadYaml<MediaMtxConfig>('docker', 'mediamtx.yml');

  // THE security boundary (spec "Layer 0"): MediaMTX is reachable only by service name on the
  // compose network. This test exists because publishing a port here is a one-line change that
  // silently exposes every tenant's stream and the RTMP ingest to the whole host/network.
  it('publishes no ports at all', () => {
    expect(mediamtx).toBeDefined();
    expect(mediamtx.ports).toBeUndefined();
  });

  it('pins an exact image version rather than a moving tag', () => {
    expect(mediamtx.image).toBe('bluenviron/mediamtx:1.21.0');
  });

  it('mounts its config read-only and bounds its memory', () => {
    expect(mediamtx.volumes).toContain('./docker/mediamtx.yml:/mediamtx.yml:ro');
    expect(mediamtx.mem_limit).toBe('512m');
    expect(mediamtx.restart).toBe('unless-stopped');
  });

  it('points authHTTPAddress at the backend through an env override carrying the shared secret', () => {
    expect(mediamtx.environment?.MTX_AUTHHTTPADDRESS)
      .toBe('http://super-dj:3001/internal/mediamtx-auth/${MEDIAMTX_AUTH_SECRET}');
  });

  it('disables every control and extra-protocol surface, leaving only RTMP ingest and HLS read', () => {
    expect(config.api).toBe(false);
    expect(config.metrics).toBe(false);
    expect(config.pprof).toBe(false);
    expect(config.playback).toBe(false);
    expect(config.rtsp).toBe(false);
    expect(config.webrtc).toBe(false);
    expect(config.srt).toBe(false);
    expect(config.rtmp).toBe(true);
    expect(config.hls).toBe(true);
  });

  it('authenticates every action against our own HTTP endpoint, excluding nothing', () => {
    expect(config.authMethod).toBe('http');
    expect(config.authHTTPExclude).toEqual([]);
  });

  it('serves plain (not low-latency) HLS, muxed on demand', () => {
    expect(config.hlsVariant).toBe('mpegts');
    expect(config.hlsAlwaysRemux).toBe(false);
  });

  // A single regex path and NO all_others catch-all: a path that is not a 32-hex-char live token
  // is rejected by MediaMTX before authHTTP is ever consulted, and no runtime config reload is
  // needed to add or revoke a session.
  it('declares exactly one regex path and no catch-all', () => {
    expect(Object.keys(config.paths)).toEqual(['~^live/[0-9a-f]{32}$']);
    expect(config.paths).not.toHaveProperty('all_others');
  });

  it('gives the backend the MediaMTX endpoints, auth secret and caps it needs', () => {
    const env = compose.services['super-dj'].environment ?? {};
    expect(env.MEDIAMTX_RTMP_URL).toBe('rtmp://mediamtx:1935');
    expect(env.MEDIAMTX_HLS_URL).toBe('http://mediamtx:8888');
    expect(env.MEDIAMTX_AUTH_SECRET).toBe('${MEDIAMTX_AUTH_SECRET}');
    expect(env.MEDIAMTX_AUTH_PORT).toBe('3001');
  });
});
