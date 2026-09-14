import { ApiError } from '../errors';

export interface YoutubeTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface YoutubeChannel {
  id: string;
  title: string;
}

export interface YoutubeBroadcast {
  id: string;
}

export interface YoutubeStream {
  id: string;
  ingestionAddress: string;
  streamName: string;
}

export interface YoutubeApiClient {
  exchangeCode(code: string, redirectUri: string): Promise<YoutubeTokens>;
  refreshAccessToken(refreshToken: string): Promise<string>;
  revoke(refreshToken: string): Promise<void>;
  getChannel(accessToken: string): Promise<YoutubeChannel>;
  createBroadcast(accessToken: string, meta: { title: string; description: string; privacyStatus: 'public' | 'unlisted' | 'private'; latencyPreference: 'normal' | 'low' | 'ultraLow' }): Promise<YoutubeBroadcast>;
  createStream(accessToken: string, meta: { title: string }): Promise<YoutubeStream>;
  // Null when YouTube no longer has this stream (deleted in Studio, or by another app) — which it
  // reports as an empty items array with a 200, not a 404.
  getStream(accessToken: string, streamId: string): Promise<YoutubeStream | null>;
  bind(accessToken: string, broadcastId: string, streamId: string): Promise<void>;
  transition(accessToken: string, broadcastId: string, status: 'live' | 'complete'): Promise<void>;
  getStreamStatus(accessToken: string, streamId: string): Promise<string>;
  // Unused by the streaming path since the liveStream became reusable; kept for future
  // account-teardown cleanup.
  deleteStream(accessToken: string, streamId: string): Promise<void>;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';

// A machine-inspectable version of the generic 502 ApiError readJsonOrThrow used to throw —
// carries the real upstream HTTP status and Google's own error/reason string, instead of just
// stringifying both into the message. Needed so both the health-check poll and the reconnect
// policy can reliably detect an auth-class failure (a revoked/expired OAuth grant) without
// parsing message strings.
export class YoutubeApiError extends ApiError {
  constructor(
    public readonly upstreamStatus: number,
    public readonly reason: string | null,
    context: string,
    body: unknown,
  ) {
    super(502, `YouTube API error (${context}): ${upstreamStatus} ${JSON.stringify(body)}`);
  }
}

// Google shapes an error body differently depending on the endpoint:
//  - the OAuth token endpoint (refreshAccessToken/exchangeCode): { error: 'invalid_grant', error_description }
//  - the Data API v3 (everything else): { error: { code, message, errors: [{ reason }], status } }
function extractReason(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const errorField = (body as Record<string, unknown>).error;
  if (typeof errorField === 'string') return errorField;
  if (errorField && typeof errorField === 'object') {
    const errors = (errorField as Record<string, unknown>).errors;
    const firstReason = Array.isArray(errors) ? (errors[0] as Record<string, unknown> | undefined)?.reason : undefined;
    if (typeof firstReason === 'string') return firstReason;
    const status = (errorField as Record<string, unknown>).status;
    if (typeof status === 'string') return status;
  }
  return null;
}

async function readJsonOrThrow(res: Response, context: string): Promise<any> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new YoutubeApiError(res.status, extractReason(body), context, body);
  return body;
}

// 401/403 always mean the credentials themselves are no good; invalid_grant (a revoked/expired
// refresh token, from the OAuth token endpoint) and forbidden/insufficientPermissions/
// unauthorized (from the Data API's own error.errors[].reason) are the reason strings actually
// observed for the same underlying problem. Anything else (rate limiting, a transient 5xx, a
// malformed request) is NOT auth-class — those are worth retrying.
export function isAuthClassError(err: unknown): boolean {
  if (!(err instanceof YoutubeApiError)) return false;
  if (err.upstreamStatus === 401 || err.upstreamStatus === 403) return true;
  const reason = (err.reason ?? '').toLowerCase();
  return reason === 'invalid_grant' || reason === 'forbidden' || reason === 'insufficientpermissions' || reason === 'unauthorized';
}

function authHeader(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

export function createYoutubeApiClient(config: { clientId: string; clientSecret: string }): YoutubeApiClient {
  return {
    async exchangeCode(code, redirectUri) {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: config.clientId, client_secret: config.clientSecret,
          redirect_uri: redirectUri, grant_type: 'authorization_code',
        }).toString(),
      });
      const body = await readJsonOrThrow(res, 'exchangeCode');
      return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresIn: body.expires_in };
    },

    async refreshAccessToken(refreshToken) {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          refresh_token: refreshToken, client_id: config.clientId, client_secret: config.clientSecret,
          grant_type: 'refresh_token',
        }).toString(),
      });
      const body = await readJsonOrThrow(res, 'refreshAccessToken');
      return body.access_token;
    },

    async revoke(refreshToken) {
      const res = await fetch(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken }).toString(),
      });
      if (!res.ok) throw new ApiError(502, `YouTube API error (revoke): ${res.status}`);
    },

    async getChannel(accessToken) {
      const res = await fetch(`${YOUTUBE_API}/channels?part=snippet&mine=true`, { headers: authHeader(accessToken) });
      const body = await readJsonOrThrow(res, 'getChannel');
      const channel = body.items?.[0];
      if (!channel) throw new ApiError(502, 'YouTube account has no channel');
      return { id: channel.id, title: channel.snippet.title };
    },

    async createBroadcast(accessToken, meta) {
      const res = await fetch(`${YOUTUBE_API}/liveBroadcasts?part=snippet,status,contentDetails`, {
        method: 'POST',
        headers: { ...authHeader(accessToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          snippet: { title: meta.title, description: meta.description, scheduledStartTime: new Date().toISOString() },
          status: { privacyStatus: meta.privacyStatus },
          // YouTube defaults to 'normal' latency (its own ingest→transcode→CDN pipeline adds
          // ~20-40s end to end) when this is omitted — surfaced as a user-facing choice since
          // 'low'/'ultraLow' trade some playback-buffering resilience for a much snappier feel.
          contentDetails: { enableAutoStart: false, enableAutoStop: false, monitorStream: { enableMonitorStream: false }, latencyPreference: meta.latencyPreference },
        }),
      });
      const body = await readJsonOrThrow(res, 'createBroadcast');
      return { id: body.id };
    },

    async createStream(accessToken, meta) {
      const res = await fetch(`${YOUTUBE_API}/liveStreams?part=snippet,cdn`, {
        method: 'POST',
        headers: { ...authHeader(accessToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          snippet: { title: meta.title },
          // Must match the pinned video params in src/stream/streamManager.ts (VIDEO_WIDTH/
          // VIDEO_HEIGHT/VIDEO_FPS) and src/ffmpeg/segmentArgs.ts — the RTMP pusher uses -c copy,
          // so YouTube's declared ingest resolution/framerate must agree with what's actually
          // being pushed.
          cdn: { frameRate: '30fps', resolution: '720p', ingestionType: 'rtmp' },
        }),
      });
      const body = await readJsonOrThrow(res, 'createStream');
      return { id: body.id, ingestionAddress: body.cdn.ingestionInfo.ingestionAddress, streamName: body.cdn.ingestionInfo.streamName };
    },

    async getStream(accessToken, streamId) {
      const res = await fetch(`${YOUTUBE_API}/liveStreams?part=cdn&id=${streamId}`, { headers: authHeader(accessToken) });
      const body = await readJsonOrThrow(res, 'getStream');
      const item = body.items?.[0];
      if (!item) return null;
      return { id: item.id, ingestionAddress: item.cdn.ingestionInfo.ingestionAddress, streamName: item.cdn.ingestionInfo.streamName };
    },

    async bind(accessToken, broadcastId, streamId) {
      const res = await fetch(`${YOUTUBE_API}/liveBroadcasts/bind?id=${broadcastId}&streamId=${streamId}&part=id`, {
        method: 'POST',
        headers: authHeader(accessToken),
      });
      await readJsonOrThrow(res, 'bind');
    },

    async transition(accessToken, broadcastId, status) {
      const res = await fetch(`${YOUTUBE_API}/liveBroadcasts/transition?broadcastStatus=${status}&id=${broadcastId}&part=id`, {
        method: 'POST',
        headers: authHeader(accessToken),
      });
      await readJsonOrThrow(res, 'transition');
    },

    async getStreamStatus(accessToken, streamId) {
      const res = await fetch(`${YOUTUBE_API}/liveStreams?part=status&id=${streamId}`, { headers: authHeader(accessToken) });
      const body = await readJsonOrThrow(res, 'getStreamStatus');
      return body.items?.[0]?.status?.streamStatus ?? 'unknown';
    },

    async deleteStream(accessToken, streamId) {
      const res = await fetch(`${YOUTUBE_API}/liveStreams?id=${streamId}`, { method: 'DELETE', headers: authHeader(accessToken) });
      if (!res.ok && res.status !== 404) throw new ApiError(502, `YouTube API error (deleteStream): ${res.status}`);
    },
  };
}
