import { randomBytes } from 'crypto';

// The two fixed MediaMTX usernames. They carry no authority of their own — the secret does — but
// keeping publish and read on DIFFERENT usernames as well as different secrets makes an accidental
// swap (handing a reader the publish credential) fail loudly instead of silently working.
export const LOCAL_RELAY_PUBLISH_USER = 'pub';
export const LOCAL_RELAY_READ_USER = 'sub';

// One local stream's MediaMTX identity. Minted fresh on every START (never per user, never
// persisted, never returned by any API): a path or secret leaked from an earlier session must not
// stay valid once that session ends.
export interface LocalRelaySession {
  userId: string;
  // 128 random bits, lowercase hex — matches docker/mediamtx.yml's `~^live/[0-9a-f]{32}$` path.
  pathToken: string;
  // Exactly the string MediaMTX reports as `path` in its authHTTP request body (no leading slash).
  path: string;
  publishSecret: string;
  readSecret: string;
  // Split so buildPersistentEncoderArgs's existing `${rtmpUrl}/${streamKey}` concatenation
  // produces a fully credentialed URL with NO change to its signature. MediaMTX v1.21.0 reads RTMP
  // credentials from the query string (internal/servers/rtmp/conn.go), not from URL userinfo —
  // which is why the credentials ride on the stream key rather than on the host part.
  publishRtmpUrl: string;
  publishStreamKey: string;
  // Not consumed in Phase A. Phase B's RelayProcess uses it as its `-i` input; minted here so that
  // is a consumer of this factory rather than a reason to redesign it. The same reason a
  // longer-lived read credential for an external player (OBS/VLC) would be a second method here.
  readRtmpUrl: string;
  // No trailing slash — the preview proxy appends `/index.m3u8` / `/<file>`.
  hlsBaseUrl: string;
  // HLS/HTTP-based protocols take credentials as an Authorization header, not a query string.
  readAuthorization: string;
}

export interface LocalRelayTargetDeps {
  // e.g. 'rtmp://mediamtx:1935'
  rtmpBaseUrl: string;
  // e.g. 'http://mediamtx:8888'
  hlsBaseUrl: string;
  generateToken?: () => string;
  generateSecret?: () => string;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export class LocalRelayTarget {
  private readonly rtmpBaseUrl: string;
  private readonly hlsBaseUrl: string;
  private readonly generateToken: () => string;
  private readonly generateSecret: () => string;

  constructor(deps: LocalRelayTargetDeps) {
    this.rtmpBaseUrl = stripTrailingSlash(deps.rtmpBaseUrl);
    this.hlsBaseUrl = stripTrailingSlash(deps.hlsBaseUrl);
    this.generateToken = deps.generateToken ?? (() => randomBytes(16).toString('hex'));
    // Hex, not base64url: these secrets travel inside an RTMP URL's query string, through ffmpeg's
    // own URL parsing, and through a Basic auth header. Hex has nothing in it that any of those
    // layers could percent-encode, split on, or mangle.
    this.generateSecret = deps.generateSecret ?? (() => randomBytes(24).toString('hex'));
  }

  create(userId: string): LocalRelaySession {
    const pathToken = this.generateToken();
    const publishSecret = this.generateSecret();
    const readSecret = this.generateSecret();
    return {
      userId,
      pathToken,
      path: `live/${pathToken}`,
      publishSecret,
      readSecret,
      publishRtmpUrl: `${this.rtmpBaseUrl}/live`,
      publishStreamKey: `${pathToken}?user=${LOCAL_RELAY_PUBLISH_USER}&pass=${publishSecret}`,
      readRtmpUrl: `${this.rtmpBaseUrl}/live/${pathToken}?user=${LOCAL_RELAY_READ_USER}&pass=${readSecret}`,
      hlsBaseUrl: `${this.hlsBaseUrl}/live/${pathToken}`,
      readAuthorization: `Basic ${Buffer.from(`${LOCAL_RELAY_READ_USER}:${readSecret}`).toString('base64')}`,
    };
  }
}
