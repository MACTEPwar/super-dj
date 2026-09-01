# YouTube Data API Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /destinations/:id/stream/start` and `.../stop` create/transition a real YouTube
live broadcast via the YouTube Data API (OAuth2), and a second streaming platform can be added
later as a new adapter/provider pair without a schema or route rework.

**Architecture:** A pluggable `StreamDestinationProvider` interface resolves, per
`StreamDestination.provider`, either the existing manual-RTMP path (`CustomRtmpProvider`) or a
YouTube-API-backed path (`YoutubeProvider`) that creates an ephemeral `liveBroadcast`+`liveStream`
per session, polls for stream health in the background, and transitions the broadcast through
its lifecycle. A parallel, provider-generic `OAuthProviderAdapter` interface backs a generic
`GET /destinations/:provider/oauth/{start,callback}` connect flow (only `youtube` registered
today) that creates the `StreamDestination` + an `OAuthConnection` row holding the encrypted
refresh token. `StreamController`/the ffmpeg pipeline are untouched except for one new optional
error hook.

**Tech Stack:** Same as the rest of the repo (Prisma, Express, Jest/supertest) plus Node 20's
built-in global `fetch` for all Google HTTP calls — no new HTTP client dependency.

**Spec:** [docs/superpowers/specs/2026-09-02-youtube-api-integration-design.md](../specs/2026-09-02-youtube-api-integration-design.md)

## Global Constraints

- `StreamDestination.rtmpUrl`/`streamKeyEncrypted` are optional; populated only for
  `provider = 'custom'`. `provider` defaults to `'custom'` (was `'youtube'`).
- `OAuthConnection` (1:1 with `StreamDestination`, cascade-deleted) is provider-generic:
  `provider`, `externalAccountId`, `externalAccountName`, `refreshTokenEncrypted` — never
  YouTube-specific field names, so a second platform reuses this table.
- The OAuth `state`-token round trip is stored in a new `OAuthState` Prisma model, mirroring
  `Session` exactly (`id @default(uuid())`, `expiresAt`, a `findValid(id, provider, now)` query),
  10-minute TTL.
- A YouTube `liveStream` (the RTMP ingestion credentials) is created fresh on every
  `/stream/start` and deleted on `/stream/stop` or on an unexpected pusher exit — never persisted.
- `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET`/`APP_BASE_URL` are required at
  `loadConfig()` time, same as `DATABASE_URL`/`STREAM_KEY_ENCRYPTION_KEY` — no lazy/optional path.
- OAuth scope: `https://www.googleapis.com/auth/youtube` (single scope, covers broadcast/stream
  management and channel read).
- Health-check polling for "has YouTube seen a healthy stream yet": 3000ms interval, 90000ms
  timeout, both overridable on `YoutubeProvider` for tests.
- An unexpected pusher exit is wired to the destination's lifecycle via a new optional
  `onError?: () => void` field on `StreamControllerDeps`, invoked from the same callback that
  already sets `state = 'error'` — the smallest possible diff to `StreamController`.
- Any `StreamDestinationProvider.prepareSession` failure (bad refresh token, Google API error,
  etc.) maps to `ApiError(502, ...)` — a Bad Gateway, since it's an upstream failure, not a
  client mistake or an ownership/not-found case.
- Everything touching the YouTube API is injected as a `YoutubeApiClient` fake in unit tests —
  no real HTTP calls to Google ever happen in `npm test`. `OAuthConnectionRepository`/
  `OAuthStateRepository` (thin Prisma wrappers) are NOT unit-tested, matching every other
  repository in this codebase — verified by manual smoke test with a real Postgres + a real
  Google OAuth app instead.
- `/stream/start` stays fire-and-return; the YouTube "become live" transition runs in the
  background, with progress surfaced through `GET .../stream/status`'s new `provider` field.
- The `OAuthProviderAdapter` registry and the `StreamDestinationProvider` registry are both
  constructed in `server.ts`'s `buildServer()` composition root, alongside every other dependency.

---

### Task 1: Prisma schema and config additions

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/config/env.ts`
- Modify: `test/config/env.test.ts`

**Interfaces:**
- Produces: Prisma models `OAuthConnection`, `OAuthState`; `StreamDestination.provider` default
  changes to `'custom'`, `rtmpUrl`/`streamKeyEncrypted` become optional. `AppConfig` gains
  `googleOAuthClientId: string`, `googleOAuthClientSecret: string`, `appBaseUrl: string`.

This task's Prisma/config additions are themselves additive, but Step 3 below narrows
`DestinationRepository.create()`'s signature, which the still-untouched `destinationRoutes.ts`
depends on — so `npm run build` is expected to show a `tsc` error at that one call site starting
here, not before. That is deliberate and self-contained: no test suite depends on a clean build
until each task's own steps say so, and the compile error's exact scope is called out in Step 4
below. The full build and test suite only return to green at Task 10's cutover; Task 9 fixes this
specific call site along the way but does not itself restore a fully green build (it still leaves
`server.ts` red until Task 10, per Task 8/9's own text).

- [ ] **Step 1: Modify `prisma/schema.prisma`**

Change `StreamDestination` and add two new models, plus one relation field on `User`:

```prisma
model User {
  id                 String              @id @default(uuid())
  email              String              @unique
  passwordHash       String
  createdAt          DateTime            @default(now())
  sessions           Session[]
  tracks             Track[]
  playlists          Playlist[]
  streamDestinations StreamDestination[]
  oauthStates        OAuthState[]
}
```

```prisma
model StreamDestination {
  id                 String            @id @default(uuid())
  userId             String
  user               User              @relation(fields: [userId], references: [id], onDelete: Cascade)
  name               String
  rtmpUrl            String?
  streamKeyEncrypted String?
  provider           String            @default("custom")
  createdAt          DateTime          @default(now())
  oauthConnection    OAuthConnection?
}

model OAuthConnection {
  id                    String            @id @default(uuid())
  destinationId         String            @unique
  destination           StreamDestination @relation(fields: [destinationId], references: [id], onDelete: Cascade)
  provider              String
  externalAccountId     String
  externalAccountName   String
  refreshTokenEncrypted String
  createdAt             DateTime          @default(now())
}

model OAuthState {
  id        String   @id @default(uuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  provider  String
  expiresAt DateTime
  createdAt DateTime @default(now())
}
```

- [ ] **Step 2: Regenerate the Prisma client**

Run (with a placeholder `DATABASE_URL` if not already set in your shell): `npx prisma generate`

- [ ] **Step 3: Write the failing config tests**

Add to `test/config/env.test.ts` (new `describe` block; do not touch the existing ones):

```ts
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
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx jest test/config/env.test.ts`
Expected: FAIL — `googleOAuthClientId`/`googleOAuthClientSecret`/`appBaseUrl` don't exist yet, and
the three new env vars aren't validated.

- [ ] **Step 5: Implement the `AppConfig` additions in `src/config/env.ts`**

Read the current file first (`src/config/env.ts`). Add three fields to the `AppConfig` interface
and three required-var checks + return fields to `loadConfig`, following the exact style already
used for `databaseUrl`/`streamKeyEncryptionKey`:

```ts
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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest test/config/env.test.ts`
Expected: PASS (all tests, old and new)

- [ ] **Step 7: Fix every other test that constructs a literal `AppConfig` or calls `loadConfig`**

Run: `npx jest 2>&1 | grep -B5 "googleOAuthClientId\|appBaseUrl"` (or just run the full suite and
read the failures) — every test file building a literal `AppConfig` object (at minimum
`test/server.test.ts`) needs the three new fields added (e.g. `googleOAuthClientId: 'client-id'`,
`googleOAuthClientSecret: 'client-secret'`, `appBaseUrl: 'https://app.example.com'`), and every
call to `loadConfig(env)` with a hand-built `env` fixture needs the three new env vars added to
that fixture.

- [ ] **Step 8: Run the full suite and build**

Run: `npx jest && npm run build`
Expected: all suites PASS, `tsc` clean

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma src/config/env.ts test/config/env.test.ts test/server.test.ts
git commit -m "feat: add OAuthConnection/OAuthState Prisma models and Google OAuth config"
```

---

### Task 2: OAuthConnection/OAuthState repositories, DestinationRepository update

**Files:**
- Create: `src/destinations/oauthConnectionRepository.ts`
- Create: `src/destinations/oauthStateRepository.ts`
- Modify: `src/destinations/destinationRepository.ts`

**Interfaces:**
- Consumes: `OAuthConnection`, `OAuthState`, `StreamDestination` from `@prisma/client` (Task 1).
- Produces:
  - `class OAuthConnectionRepository { constructor(prisma: PrismaClient); create(data: {destinationId: string; provider: string; externalAccountId: string; externalAccountName: string; refreshTokenEncrypted: string}): Promise<OAuthConnection>; findByDestinationId(destinationId: string): Promise<OAuthConnection | null>; }`
  - `class OAuthStateRepository { constructor(prisma: PrismaClient); create(userId: string, provider: string, expiresAt: Date): Promise<OAuthState>; findValid(id: string, provider: string, now: Date): Promise<OAuthState | null>; deleteById(id: string): Promise<void>; }`
  - `class DestinationRepository { ...; create(data: {userId: string; name: string; provider: string; rtmpUrl: string | null; streamKeyEncrypted: string | null}): Promise<StreamDestination>; ... }` (signature change: `provider` is now required and explicit, `rtmpUrl`/`streamKeyEncrypted` are nullable)

No test files for the two new repositories — per Global Constraints, these thin Prisma wrappers
are verified by manual smoke test, not unit tests (matching `UserRepository`/`SessionRepository`).
`DestinationRepository`'s signature change has no dedicated test file either (it never had one),
but Task 9 updates `destinationRoutes.ts`'s call site and its tests.

- [ ] **Step 1: Implement `src/destinations/oauthConnectionRepository.ts`**

```ts
import { PrismaClient, OAuthConnection } from '@prisma/client';

export class OAuthConnectionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(data: {
    destinationId: string; provider: string; externalAccountId: string; externalAccountName: string; refreshTokenEncrypted: string;
  }): Promise<OAuthConnection> {
    return this.prisma.oAuthConnection.create({ data });
  }

  findByDestinationId(destinationId: string): Promise<OAuthConnection | null> {
    return this.prisma.oAuthConnection.findUnique({ where: { destinationId } });
  }
}
```

- [ ] **Step 2: Implement `src/destinations/oauthStateRepository.ts`**

```ts
import { PrismaClient, OAuthState } from '@prisma/client';

export class OAuthStateRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(userId: string, provider: string, expiresAt: Date): Promise<OAuthState> {
    return this.prisma.oAuthState.create({ data: { userId, provider, expiresAt } });
  }

  findValid(id: string, provider: string, now: Date): Promise<OAuthState | null> {
    return this.prisma.oAuthState.findFirst({ where: { id, provider, expiresAt: { gt: now } } });
  }

  async deleteById(id: string): Promise<void> {
    await this.prisma.oAuthState.deleteMany({ where: { id } });
  }
}
```

- [ ] **Step 3: Update `src/destinations/destinationRepository.ts`'s `create` method**

Read the current file first. Replace the `create` method's signature (leave `listByUser`,
`findById`, `deleteById` untouched):

```ts
  create(data: {
    userId: string; name: string; provider: string; rtmpUrl: string | null; streamKeyEncrypted: string | null;
  }): Promise<StreamDestination> {
    return this.prisma.streamDestination.create({ data });
  }
```

- [ ] **Step 4: Verify the build compiles**

Run: `npm run build`
Expected: `tsc` errors at every existing call site of `destinationRepository.create(...)` that
doesn't yet pass `provider`/nullable fields (there is currently exactly one, in
`src/destinations/destinationRoutes.ts`) — this is expected; Task 9 fixes it. Confirm the *only*
errors are in `destinationRoutes.ts` and its test file, not elsewhere.

- [ ] **Step 5: Commit**

```bash
git add src/destinations/oauthConnectionRepository.ts src/destinations/oauthStateRepository.ts src/destinations/destinationRepository.ts
git commit -m "feat: OAuthConnection/OAuthState repositories, generalize DestinationRepository.create"
```

---

### Task 3: `YoutubeApiClient` — Google API HTTP wrapper

**Files:**
- Create: `src/destinations/youtubeApiClient.ts`
- Test: `test/destinations/youtubeApiClient.test.ts`

**Interfaces:**
- Produces: `interface YoutubeTokens { accessToken: string; refreshToken: string; expiresIn: number }`,
  `interface YoutubeChannel { id: string; title: string }`,
  `interface YoutubeBroadcast { id: string }`,
  `interface YoutubeStream { id: string; ingestionAddress: string; streamName: string }`,
  `interface YoutubeApiClient { exchangeCode(code: string, redirectUri: string): Promise<YoutubeTokens>; refreshAccessToken(refreshToken: string): Promise<string>; revoke(refreshToken: string): Promise<void>; getChannel(accessToken: string): Promise<YoutubeChannel>; createBroadcast(accessToken: string, meta: {title: string; description: string; privacyStatus: 'public' | 'unlisted' | 'private'}): Promise<YoutubeBroadcast>; createStream(accessToken: string, meta: {title: string}): Promise<YoutubeStream>; bind(accessToken: string, broadcastId: string, streamId: string): Promise<void>; transition(accessToken: string, broadcastId: string, status: 'live' | 'complete'): Promise<void>; getStreamStatus(accessToken: string, streamId: string): Promise<string>; deleteStream(accessToken: string, streamId: string): Promise<void> }`,
  `function createYoutubeApiClient(config: {clientId: string; clientSecret: string}): YoutubeApiClient`

This is the only file in the whole feature that makes real HTTP calls to Google — every other
new file consumes `YoutubeApiClient` as an injected interface.

- [ ] **Step 1: Write the failing tests**

```ts
// test/destinations/youtubeApiClient.test.ts
import { createYoutubeApiClient } from '../../src/destinations/youtubeApiClient';

function mockFetchOnce(status: number, body: unknown) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe('createYoutubeApiClient', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('exchangeCode posts to the Google token endpoint and maps the response', async () => {
    mockFetchOnce(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    const tokens = await client.exchangeCode('code-1', 'https://app.example.com/destinations/youtube/oauth/callback');

    expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.body).toContain('code=code-1');
    expect(init.body).toContain('grant_type=authorization_code');
    expect(init.body).toContain('client_id=id');
  });

  it('refreshAccessToken returns just the access token', async () => {
    mockFetchOnce(200, { access_token: 'at2', expires_in: 3600 });
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    const accessToken = await client.refreshAccessToken('rt');

    expect(accessToken).toBe('at2');
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.body).toContain('grant_type=refresh_token');
  });

  it('revoke posts the refresh token to the Google revoke endpoint', async () => {
    mockFetchOnce(200, {});
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    await client.revoke('rt');

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/revoke');
    expect(init.body).toContain('token=rt');
  });

  it('getChannel maps the first channel item to {id, title}', async () => {
    mockFetchOnce(200, { items: [{ id: 'chan-1', snippet: { title: 'My Channel' } }] });
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    expect(await client.getChannel('at')).toEqual({ id: 'chan-1', title: 'My Channel' });
  });

  it('getChannel throws a 502 ApiError when the account has no channel', async () => {
    mockFetchOnce(200, { items: [] });
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    await expect(client.getChannel('at')).rejects.toMatchObject({ status: 502 });
  });

  it('createStream parses ingestionAddress/streamName from cdn.ingestionInfo', async () => {
    mockFetchOnce(200, { id: 'stream-1', cdn: { ingestionInfo: { ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2', streamName: 'abcd-1234' } } });
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    const stream = await client.createStream('at', { title: 'My Stream' });

    expect(stream).toEqual({ id: 'stream-1', ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2', streamName: 'abcd-1234' });
  });

  it('createBroadcast returns just the created id', async () => {
    mockFetchOnce(200, { id: 'broadcast-1' });
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    expect(await client.createBroadcast('at', { title: 'T', description: 'D', privacyStatus: 'private' })).toEqual({ id: 'broadcast-1' });
  });

  it('getStreamStatus reads status.streamStatus from the first item', async () => {
    mockFetchOnce(200, { items: [{ status: { streamStatus: 'active' } }] });
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    expect(await client.getStreamStatus('at', 'stream-1')).toBe('active');
  });

  it('getStreamStatus returns "unknown" when the stream has no items', async () => {
    mockFetchOnce(200, { items: [] });
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    expect(await client.getStreamStatus('at', 'stream-1')).toBe('unknown');
  });

  it('deleteStream tolerates a 404 (already gone)', async () => {
    mockFetchOnce(404, {});
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    await expect(client.deleteStream('at', 'stream-1')).resolves.toBeUndefined();
  });

  it('wraps a non-ok, non-404 response as a 502 ApiError', async () => {
    mockFetchOnce(403, { error: 'forbidden' });
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    await expect(client.getChannel('at')).rejects.toMatchObject({ status: 502 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/destinations/youtubeApiClient.test.ts`
Expected: FAIL — `Cannot find module '../../src/destinations/youtubeApiClient'`

- [ ] **Step 3: Implement `src/destinations/youtubeApiClient.ts`**

```ts
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
  createBroadcast(accessToken: string, meta: { title: string; description: string; privacyStatus: 'public' | 'unlisted' | 'private' }): Promise<YoutubeBroadcast>;
  createStream(accessToken: string, meta: { title: string }): Promise<YoutubeStream>;
  bind(accessToken: string, broadcastId: string, streamId: string): Promise<void>;
  transition(accessToken: string, broadcastId: string, status: 'live' | 'complete'): Promise<void>;
  getStreamStatus(accessToken: string, streamId: string): Promise<string>;
  deleteStream(accessToken: string, streamId: string): Promise<void>;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';

async function readJsonOrThrow(res: Response, context: string): Promise<any> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(502, `YouTube API error (${context}): ${res.status} ${JSON.stringify(body)}`);
  return body;
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
          contentDetails: { enableAutoStart: false, enableAutoStop: false },
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
          cdn: { frameRate: '30fps', resolution: '720p', ingestionType: 'rtmp' },
        }),
      });
      const body = await readJsonOrThrow(res, 'createStream');
      return { id: body.id, ingestionAddress: body.cdn.ingestionInfo.ingestionAddress, streamName: body.cdn.ingestionInfo.streamName };
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/destinations/youtubeApiClient.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Run the build**

Run: `npm run build`
Expected: `tsc` clean (confirms `@types/node`'s global `fetch`/`Response`/`URLSearchParams` types
resolve under this project's `tsconfig.json`)

- [ ] **Step 6: Commit**

```bash
git add src/destinations/youtubeApiClient.ts test/destinations/youtubeApiClient.test.ts
git commit -m "feat: YoutubeApiClient — fetch-based YouTube Data API v3 + OAuth token wrapper"
```

---

### Task 4: `OAuthProviderAdapter` interface + `YoutubeOAuthAdapter`

**Files:**
- Create: `src/destinations/oauthProviderAdapter.ts`
- Create: `src/destinations/youtubeOAuthAdapter.ts`
- Test: `test/destinations/youtubeOAuthAdapter.test.ts`

**Interfaces:**
- Consumes: `YoutubeApiClient` (Task 3).
- Produces:
  - `interface OAuthProviderAdapter { readonly provider: string; buildAuthUrl(state: string): string; exchangeCode(code: string): Promise<{accessToken: string; refreshToken: string; expiresIn: number}>; fetchAccountIdentity(accessToken: string): Promise<{externalAccountId: string; externalAccountName: string}>; revoke(refreshToken: string): Promise<void> }`
  - `class YoutubeOAuthAdapter implements OAuthProviderAdapter { constructor(deps: {client: YoutubeApiClient; clientId: string; redirectUri: string; scope: string}); provider: 'youtube'; ... }`

- [ ] **Step 1: Implement `src/destinations/oauthProviderAdapter.ts`**

```ts
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface OAuthAccountIdentity {
  externalAccountId: string;
  externalAccountName: string;
}

export interface OAuthProviderAdapter {
  readonly provider: string;
  buildAuthUrl(state: string): string;
  exchangeCode(code: string): Promise<OAuthTokens>;
  fetchAccountIdentity(accessToken: string): Promise<OAuthAccountIdentity>;
  revoke(refreshToken: string): Promise<void>;
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// test/destinations/youtubeOAuthAdapter.test.ts
import { YoutubeOAuthAdapter } from '../../src/destinations/youtubeOAuthAdapter';
import { YoutubeApiClient } from '../../src/destinations/youtubeApiClient';

function fakeClient(): jest.Mocked<YoutubeApiClient> {
  return {
    exchangeCode: jest.fn().mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 }),
    refreshAccessToken: jest.fn(),
    revoke: jest.fn().mockResolvedValue(undefined),
    getChannel: jest.fn().mockResolvedValue({ id: 'chan-1', title: 'My Channel' }),
    createBroadcast: jest.fn(), createStream: jest.fn(), bind: jest.fn(), transition: jest.fn(), getStreamStatus: jest.fn(), deleteStream: jest.fn(),
  } as any;
}

function buildAdapter(client = fakeClient()) {
  return new YoutubeOAuthAdapter({
    client, clientId: 'client-123', redirectUri: 'https://app.example.com/destinations/youtube/oauth/callback', scope: 'https://www.googleapis.com/auth/youtube',
  });
}

describe('YoutubeOAuthAdapter', () => {
  it('exposes provider = "youtube"', () => {
    expect(buildAdapter().provider).toBe('youtube');
  });

  it('builds an auth URL with the configured client id, redirect uri, scope, and state', () => {
    const url = new URL(buildAdapter().buildAuthUrl('state-abc'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/destinations/youtube/oauth/callback');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/youtube');
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('delegates exchangeCode to the client with the configured redirect uri', async () => {
    const client = fakeClient();
    const tokens = await buildAdapter(client).exchangeCode('code-1');
    expect(client.exchangeCode).toHaveBeenCalledWith('code-1', 'https://app.example.com/destinations/youtube/oauth/callback');
    expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });
  });

  it('fetchAccountIdentity maps the client channel shape to the generic identity shape', async () => {
    const identity = await buildAdapter().fetchAccountIdentity('at');
    expect(identity).toEqual({ externalAccountId: 'chan-1', externalAccountName: 'My Channel' });
  });

  it('delegates revoke to the client', async () => {
    const client = fakeClient();
    await buildAdapter(client).revoke('rt');
    expect(client.revoke).toHaveBeenCalledWith('rt');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest test/destinations/youtubeOAuthAdapter.test.ts`
Expected: FAIL — `Cannot find module '../../src/destinations/youtubeOAuthAdapter'`

- [ ] **Step 4: Implement `src/destinations/youtubeOAuthAdapter.ts`**

```ts
import { YoutubeApiClient } from './youtubeApiClient';
import { OAuthAccountIdentity, OAuthProviderAdapter, OAuthTokens } from './oauthProviderAdapter';

export interface YoutubeOAuthAdapterDeps {
  client: YoutubeApiClient;
  clientId: string;
  redirectUri: string;
  scope: string;
}

export class YoutubeOAuthAdapter implements OAuthProviderAdapter {
  readonly provider = 'youtube';

  constructor(private readonly deps: YoutubeOAuthAdapterDeps) {}

  buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.deps.clientId,
      redirect_uri: this.deps.redirectUri,
      response_type: 'code',
      scope: this.deps.scope,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  exchangeCode(code: string): Promise<OAuthTokens> {
    return this.deps.client.exchangeCode(code, this.deps.redirectUri);
  }

  async fetchAccountIdentity(accessToken: string): Promise<OAuthAccountIdentity> {
    const channel = await this.deps.client.getChannel(accessToken);
    return { externalAccountId: channel.id, externalAccountName: channel.title };
  }

  revoke(refreshToken: string): Promise<void> {
    return this.deps.client.revoke(refreshToken);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest test/destinations/youtubeOAuthAdapter.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add src/destinations/oauthProviderAdapter.ts src/destinations/youtubeOAuthAdapter.ts test/destinations/youtubeOAuthAdapter.test.ts
git commit -m "feat: OAuthProviderAdapter interface + YoutubeOAuthAdapter"
```

---

### Task 5: OAuth connect routes

**Files:**
- Create: `src/destinations/oauthRoutes.ts`
- Test: `test/destinations/oauthRoutes.test.ts`

**Interfaces:**
- Consumes: `OAuthProviderAdapter` (Task 4), `OAuthStateRepository`, `OAuthConnectionRepository`
  (Task 2), `DestinationRepository.create` (Task 2), `encrypt` from `../crypto/streamKeyCipher`.
- Produces: `function createOAuthRouter(authService: AuthService, adapters: Record<string, OAuthProviderAdapter>, oauthStateRepository: Pick<OAuthStateRepository, 'create' | 'findValid' | 'deleteById'>, oauthConnectionRepository: Pick<OAuthConnectionRepository, 'create'>, destinationRepository: Pick<DestinationRepository, 'create'>, encryptionKey: string): Router`
  Mounted at `/destinations` in Task 10, exposing `GET /destinations/:provider/oauth/start` and
  `GET /destinations/:provider/oauth/callback`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/destinations/oauthRoutes.test.ts
import express from 'express';
import request from 'supertest';
import { createOAuthRouter } from '../../src/destinations/oauthRoutes';
import { errorHandler } from '../../src/api/errorHandler';
import { decrypt } from '../../src/crypto/streamKeyCipher';

const KEY = 'a'.repeat(64);

function buildDeps() {
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: 'user-1', email: 'a@example.com' }) };
  const adapter: any = {
    provider: 'youtube',
    buildAuthUrl: jest.fn().mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?mock=1'),
    exchangeCode: jest.fn().mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 }),
    fetchAccountIdentity: jest.fn().mockResolvedValue({ externalAccountId: 'chan-1', externalAccountName: 'My Channel' }),
    revoke: jest.fn(),
  };
  const oauthStateRepository: any = {
    create: jest.fn().mockResolvedValue({ id: 'state-1', userId: 'user-1', provider: 'youtube', expiresAt: new Date(Date.now() + 60000) }),
    findValid: jest.fn().mockResolvedValue({ id: 'state-1', userId: 'user-1', provider: 'youtube', expiresAt: new Date(Date.now() + 60000) }),
    deleteById: jest.fn(),
  };
  const oauthConnectionRepository: any = { create: jest.fn().mockResolvedValue({ id: 'conn-1' }) };
  const destinationRepository: any = { create: jest.fn().mockResolvedValue({ id: 'dest-1', userId: 'user-1', name: 'My Channel', provider: 'youtube' }) };
  return { authService, adapter, oauthStateRepository, oauthConnectionRepository, destinationRepository };
}

function buildApp(deps: ReturnType<typeof buildDeps>) {
  const app = express();
  app.use(express.json());
  app.use('/destinations', createOAuthRouter(
    deps.authService, { youtube: deps.adapter }, deps.oauthStateRepository, deps.oauthConnectionRepository, deps.destinationRepository, KEY,
  ));
  app.use(errorHandler);
  return app;
}

describe('oauth connect routes', () => {
  it('GET /destinations/:provider/oauth/start requires auth and returns an authUrl', async () => {
    const deps = buildDeps();
    const res = await request(buildApp(deps)).get('/destinations/youtube/oauth/start');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?mock=1' });
    expect(deps.oauthStateRepository.create).toHaveBeenCalledWith('user-1', 'youtube', expect.any(Date));
  });

  it('GET /destinations/:provider/oauth/start 404s for an unregistered provider', async () => {
    const deps = buildDeps();
    const res = await request(buildApp(deps)).get('/destinations/twitch/oauth/start');
    expect(res.status).toBe(404);
  });

  it('GET /destinations/:provider/oauth/callback exchanges the code and creates a destination + connection', async () => {
    const deps = buildDeps();
    const res = await request(buildApp(deps)).get('/destinations/youtube/oauth/callback?code=abc&state=state-1');

    expect(res.status).toBe(200);
    expect(deps.adapter.exchangeCode).toHaveBeenCalledWith('abc');
    expect(deps.destinationRepository.create).toHaveBeenCalledWith({
      userId: 'user-1', name: 'My Channel', provider: 'youtube', rtmpUrl: null, streamKeyEncrypted: null,
    });
    const connectionArgs = deps.oauthConnectionRepository.create.mock.calls[0][0];
    expect(connectionArgs).toMatchObject({ destinationId: 'dest-1', provider: 'youtube', externalAccountId: 'chan-1', externalAccountName: 'My Channel' });
    expect(decrypt(connectionArgs.refreshTokenEncrypted, KEY)).toBe('rt');
    expect(deps.oauthStateRepository.deleteById).toHaveBeenCalledWith('state-1');
  });

  it('GET /destinations/:provider/oauth/callback rejects an invalid/expired state', async () => {
    const deps = buildDeps();
    deps.oauthStateRepository.findValid.mockResolvedValue(null);
    const res = await request(buildApp(deps)).get('/destinations/youtube/oauth/callback?code=abc&state=bad');
    expect(res.status).toBe(400);
    expect(deps.adapter.exchangeCode).not.toHaveBeenCalled();
  });

  it('GET /destinations/:provider/oauth/callback requires code and state query params', async () => {
    const deps = buildDeps();
    const res = await request(buildApp(deps)).get('/destinations/youtube/oauth/callback');
    expect(res.status).toBe(400);
    expect(deps.oauthStateRepository.findValid).not.toHaveBeenCalled();
  });

  it('GET /destinations/:provider/oauth/callback 404s for an unregistered provider', async () => {
    const deps = buildDeps();
    const res = await request(buildApp(deps)).get('/destinations/twitch/oauth/callback?code=abc&state=s1');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/destinations/oauthRoutes.test.ts`
Expected: FAIL — `Cannot find module '../../src/destinations/oauthRoutes'`

- [ ] **Step 3: Implement `src/destinations/oauthRoutes.ts`**

```ts
import { Router } from 'express';
import { ApiError } from '../errors';
import { wrapAsync } from '../api/errorHandler';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { AuthService } from '../auth/authService';
import { OAuthProviderAdapter } from './oauthProviderAdapter';
import { OAuthStateRepository } from './oauthStateRepository';
import { OAuthConnectionRepository } from './oauthConnectionRepository';
import { DestinationRepository } from './destinationRepository';
import { encrypt } from '../crypto/streamKeyCipher';

const STATE_TTL_MINUTES = 10;

export function createOAuthRouter(
  authService: AuthService,
  adapters: Record<string, OAuthProviderAdapter>,
  oauthStateRepository: Pick<OAuthStateRepository, 'create' | 'findValid' | 'deleteById'>,
  oauthConnectionRepository: Pick<OAuthConnectionRepository, 'create'>,
  destinationRepository: Pick<DestinationRepository, 'create'>,
  encryptionKey: string,
): Router {
  const router = Router();
  const auth = requireAuth(authService);

  router.get('/:provider/oauth/start', auth, wrapAsync(async (req, res) => {
    const adapter = adapters[req.params.provider];
    if (!adapter) throw new ApiError(404, `unknown provider: ${req.params.provider}`);

    const expiresAt = new Date(Date.now() + STATE_TTL_MINUTES * 60 * 1000);
    const state = await oauthStateRepository.create((req as AuthenticatedRequest).user!.id, adapter.provider, expiresAt);
    res.status(200).json({ authUrl: adapter.buildAuthUrl(state.id) });
  }));

  router.get('/:provider/oauth/callback', wrapAsync(async (req, res) => {
    const adapter = adapters[req.params.provider];
    if (!adapter) throw new ApiError(404, `unknown provider: ${req.params.provider}`);

    const { code, state: stateId } = req.query;
    if (typeof code !== 'string' || code.length === 0) throw new ApiError(400, 'query.code is required');
    if (typeof stateId !== 'string' || stateId.length === 0) throw new ApiError(400, 'query.state is required');

    const state = await oauthStateRepository.findValid(stateId, adapter.provider, new Date());
    if (!state) throw new ApiError(400, 'invalid or expired oauth state');
    await oauthStateRepository.deleteById(state.id);

    const tokens = await adapter.exchangeCode(code);
    const identity = await adapter.fetchAccountIdentity(tokens.accessToken);

    const destination = await destinationRepository.create({
      userId: state.userId, name: identity.externalAccountName, provider: adapter.provider, rtmpUrl: null, streamKeyEncrypted: null,
    });
    await oauthConnectionRepository.create({
      destinationId: destination.id,
      provider: adapter.provider,
      externalAccountId: identity.externalAccountId,
      externalAccountName: identity.externalAccountName,
      refreshTokenEncrypted: encrypt(tokens.refreshToken, encryptionKey),
    });

    res.status(200).send('<html><body>Connected — you can close this tab.</body></html>');
  }));

  return router;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/destinations/oauthRoutes.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/destinations/oauthRoutes.ts test/destinations/oauthRoutes.test.ts
git commit -m "feat: generic OAuth connect routes (GET /destinations/:provider/oauth/{start,callback})"
```

---

### Task 6: `StreamDestinationProvider` interface + `CustomRtmpProvider`

**Files:**
- Create: `src/destinations/streamDestinationProvider.ts`
- Create: `src/destinations/customRtmpProvider.ts`
- Test: `test/destinations/customRtmpProvider.test.ts`

**Interfaces:**
- Consumes: `StreamDestination` from `@prisma/client`, `decrypt` from `../crypto/streamKeyCipher`.
- Produces:
  - `interface BroadcastMeta { title: string; description?: string; privacyStatus?: 'public' | 'unlisted' | 'private' }`
  - `type DestinationLifecyclePhase = 'creating' | 'waitingForYoutube' | 'live' | 'complete' | 'error'`
  - `interface DestinationLifecycle { onPushStarted(): void; phase(): DestinationLifecyclePhase; watchUrl(): string | null; finalize(): Promise<void> }`
  - `interface PreparedSession { rtmpUrl: string; streamKey: string; lifecycle?: DestinationLifecycle }`
  - `interface StreamDestinationProvider { prepareSession(destination: StreamDestination, meta: BroadcastMeta): Promise<PreparedSession> }`
  - `class CustomRtmpProvider implements StreamDestinationProvider { constructor(encryptionKey: string); prepareSession(...): Promise<PreparedSession> }`

`DestinationLifecyclePhase` is deliberately a plain string union, not YouTube-specific naming, so
a future provider (e.g. Twitch, which has no broadcast/testing concept) can reuse `'creating'`/
`'live'`/`'complete'`/`'error'` and simply never emit `'waitingForYoutube'`.

- [ ] **Step 1: Implement `src/destinations/streamDestinationProvider.ts`**

```ts
import { StreamDestination } from '@prisma/client';

export interface BroadcastMeta {
  title: string;
  description?: string;
  privacyStatus?: 'public' | 'unlisted' | 'private';
}

export type DestinationLifecyclePhase = 'creating' | 'waitingForYoutube' | 'live' | 'complete' | 'error';

export interface DestinationLifecycle {
  onPushStarted(): void;
  phase(): DestinationLifecyclePhase;
  watchUrl(): string | null;
  finalize(): Promise<void>;
}

export interface PreparedSession {
  rtmpUrl: string;
  streamKey: string;
  lifecycle?: DestinationLifecycle;
}

export interface StreamDestinationProvider {
  prepareSession(destination: StreamDestination, meta: BroadcastMeta): Promise<PreparedSession>;
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// test/destinations/customRtmpProvider.test.ts
import { CustomRtmpProvider } from '../../src/destinations/customRtmpProvider';
import { encrypt } from '../../src/crypto/streamKeyCipher';

const KEY = 'a'.repeat(64);

describe('CustomRtmpProvider', () => {
  it('decrypts the stored stream key and returns it alongside rtmpUrl, with no lifecycle', async () => {
    const provider = new CustomRtmpProvider(KEY);
    const destination: any = { rtmpUrl: 'rtmp://example.com/live', streamKeyEncrypted: encrypt('secret-key', KEY) };

    const session = await provider.prepareSession(destination, { title: 'ignored' });

    expect(session).toEqual({ rtmpUrl: 'rtmp://example.com/live', streamKey: 'secret-key' });
    expect(session.lifecycle).toBeUndefined();
  });

  it('throws if the destination is missing rtmpUrl/streamKeyEncrypted', async () => {
    const provider = new CustomRtmpProvider(KEY);
    const destination: any = { rtmpUrl: null, streamKeyEncrypted: null };

    await expect(provider.prepareSession(destination, { title: 'x' })).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest test/destinations/customRtmpProvider.test.ts`
Expected: FAIL — `Cannot find module '../../src/destinations/customRtmpProvider'`

- [ ] **Step 4: Implement `src/destinations/customRtmpProvider.ts`**

```ts
import { StreamDestination } from '@prisma/client';
import { ApiError } from '../errors';
import { decrypt } from '../crypto/streamKeyCipher';
import { BroadcastMeta, PreparedSession, StreamDestinationProvider } from './streamDestinationProvider';

export class CustomRtmpProvider implements StreamDestinationProvider {
  constructor(private readonly encryptionKey: string) {}

  async prepareSession(destination: StreamDestination, _meta: BroadcastMeta): Promise<PreparedSession> {
    if (!destination.rtmpUrl || !destination.streamKeyEncrypted) {
      throw new ApiError(500, 'custom destination is missing rtmpUrl/streamKey');
    }
    return {
      rtmpUrl: destination.rtmpUrl,
      streamKey: decrypt(destination.streamKeyEncrypted, this.encryptionKey),
    };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest test/destinations/customRtmpProvider.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/destinations/streamDestinationProvider.ts src/destinations/customRtmpProvider.ts test/destinations/customRtmpProvider.test.ts
git commit -m "feat: StreamDestinationProvider interface + CustomRtmpProvider"
```

---

### Task 7: `YoutubeProvider` — broadcast/stream lifecycle + health-check polling

**Files:**
- Create: `src/destinations/youtubeProvider.ts`
- Test: `test/destinations/youtubeProvider.test.ts`

**Interfaces:**
- Consumes: `YoutubeApiClient` (Task 3), `StreamDestinationProvider`/`BroadcastMeta`/
  `PreparedSession`/`DestinationLifecycle` (Task 6), `OAuthConnectionRepository.findByDestinationId`
  (Task 2), `decrypt` from `../crypto/streamKeyCipher`.
- Produces: `class YoutubeProvider implements StreamDestinationProvider { constructor(deps: {client: YoutubeApiClient; encryptionKey: string; oauthConnectionRepository: Pick<OAuthConnectionRepository, 'findByDestinationId'>; pollIntervalMs?: number; healthTimeoutMs?: number; scheduleNextPoll?: (fn: () => void | Promise<void>, delayMs: number) => void; clock?: () => number}); prepareSession(destination, meta): Promise<PreparedSession> }`

- [ ] **Step 1: Write the failing tests**

```ts
// test/destinations/youtubeProvider.test.ts
import { YoutubeProvider } from '../../src/destinations/youtubeProvider';
import { encrypt } from '../../src/crypto/streamKeyCipher';

const KEY = 'a'.repeat(64);

function fakeClient(overrides: Record<string, jest.Mock> = {}) {
  return {
    refreshAccessToken: jest.fn().mockResolvedValue('at'),
    createBroadcast: jest.fn().mockResolvedValue({ id: 'broadcast-1' }),
    createStream: jest.fn().mockResolvedValue({ id: 'stream-1', ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2', streamName: 'key-1' }),
    bind: jest.fn().mockResolvedValue(undefined),
    transition: jest.fn().mockResolvedValue(undefined),
    getStreamStatus: jest.fn().mockResolvedValue('active'),
    deleteStream: jest.fn().mockResolvedValue(undefined),
    exchangeCode: jest.fn(), revoke: jest.fn(), getChannel: jest.fn(),
    ...overrides,
  };
}

function buildProvider(client = fakeClient(), extra: Record<string, unknown> = {}) {
  const oauthConnectionRepository = {
    findByDestinationId: jest.fn().mockResolvedValue({ refreshTokenEncrypted: encrypt('refresh-token', KEY) }),
  };
  // Drives the poll loop deterministically instead of waiting on real timers.
  const scheduled: Array<() => void | Promise<void>> = [];
  const scheduleNextPoll = jest.fn((fn: () => void | Promise<void>) => { scheduled.push(fn); });
  const provider = new YoutubeProvider({ client: client as any, encryptionKey: KEY, oauthConnectionRepository, scheduleNextPoll, ...extra });
  const runNextScheduledPoll = async () => {
    const fn = scheduled.shift();
    if (fn) await fn();
  };
  return { provider, client, oauthConnectionRepository, runNextScheduledPoll, scheduled };
}

const destination = { id: 'dest-1' } as any;
const meta = { title: 'My Stream', description: 'desc', privacyStatus: 'private' as const };

describe('YoutubeProvider', () => {
  it('prepareSession creates and binds a broadcast+stream, returning the ingestion rtmpUrl/streamKey', async () => {
    const { provider, client } = buildProvider();

    const session = await provider.prepareSession(destination, meta);

    expect(session.rtmpUrl).toBe('rtmp://a.rtmp.youtube.com/live2');
    expect(session.streamKey).toBe('key-1');
    expect(client.createBroadcast).toHaveBeenCalledWith('at', { title: 'My Stream', description: 'desc', privacyStatus: 'private' });
    expect(client.createStream).toHaveBeenCalledWith('at', { title: 'My Stream' });
    expect(client.bind).toHaveBeenCalledWith('at', 'broadcast-1', 'stream-1');
    expect(session.lifecycle).toBeDefined();
  });

  it('prepareSession throws a 502 if the destination has no OAuthConnection', async () => {
    const { provider, oauthConnectionRepository } = buildProvider();
    oauthConnectionRepository.findByDestinationId.mockResolvedValue(null);

    await expect(provider.prepareSession(destination, meta)).rejects.toMatchObject({ status: 502 });
  });

  it('lifecycle starts in "creating" and moves to "waitingForYoutube" once onPushStarted() is called', async () => {
    const { provider } = buildProvider();
    const session = await provider.prepareSession(destination, meta);

    expect(session.lifecycle!.phase()).toBe('creating');
    session.lifecycle!.onPushStarted();
    expect(session.lifecycle!.phase()).toBe('waitingForYoutube');
  });

  it('exposes a watchUrl built from the broadcast id', async () => {
    const { provider } = buildProvider();
    const session = await provider.prepareSession(destination, meta);
    expect(session.lifecycle!.watchUrl()).toBe('https://www.youtube.com/watch?v=broadcast-1');
  });

  it('transitions to "live" once a poll sees the stream become active', async () => {
    const client = fakeClient({ getStreamStatus: jest.fn().mockResolvedValue('active') } as any);
    const { provider, runNextScheduledPoll } = buildProvider(client as any);
    const session = await provider.prepareSession(destination, meta);
    session.lifecycle!.onPushStarted();

    await runNextScheduledPoll();

    expect(client.transition).toHaveBeenCalledWith('at', 'broadcast-1', 'live');
    expect(session.lifecycle!.phase()).toBe('live');
  });

  it('keeps polling while the stream is not yet active', async () => {
    const client = fakeClient({ getStreamStatus: jest.fn().mockResolvedValue('inactive') } as any);
    const { provider, runNextScheduledPoll, scheduled } = buildProvider(client as any);
    const session = await provider.prepareSession(destination, meta);
    session.lifecycle!.onPushStarted();

    await runNextScheduledPoll();

    expect(session.lifecycle!.phase()).toBe('waitingForYoutube');
    expect(client.transition).not.toHaveBeenCalled();
    expect(scheduled.length).toBe(1);
  });

  it('gives up after the health-check timeout, finalizing and setting phase to "error"', async () => {
    const client = fakeClient({ getStreamStatus: jest.fn().mockResolvedValue('inactive') } as any);
    let now = 0;
    const { provider, runNextScheduledPoll } = buildProvider(client as any, { clock: () => now, healthTimeoutMs: 1000, pollIntervalMs: 1000 });
    const session = await provider.prepareSession(destination, meta);
    session.lifecycle!.onPushStarted();

    now = 2000;
    await runNextScheduledPoll();

    expect(session.lifecycle!.phase()).toBe('error');
    expect(client.deleteStream).toHaveBeenCalledWith('at', 'stream-1');
  });

  it('finalize() transitions the broadcast to complete and deletes the ephemeral stream', async () => {
    const { provider, client } = buildProvider();
    const session = await provider.prepareSession(destination, meta);
    session.lifecycle!.onPushStarted();

    await session.lifecycle!.finalize();

    expect(client.transition).toHaveBeenCalledWith('at', 'broadcast-1', 'complete');
    expect(client.deleteStream).toHaveBeenCalledWith('at', 'stream-1');
    expect(session.lifecycle!.phase()).toBe('complete');
  });

  it('finalize() is idempotent — a second call makes no further API calls', async () => {
    const { provider, client } = buildProvider();
    const session = await provider.prepareSession(destination, meta);
    await session.lifecycle!.finalize();
    client.transition.mockClear();
    client.deleteStream.mockClear();

    await session.lifecycle!.finalize();

    expect(client.transition).not.toHaveBeenCalled();
    expect(client.deleteStream).not.toHaveBeenCalled();
  });

  it('finalize() skips the "complete" transition when the broadcast never left "creating"', async () => {
    const { provider, client } = buildProvider();
    const session = await provider.prepareSession(destination, meta);

    await session.lifecycle!.finalize();

    expect(client.transition).not.toHaveBeenCalled();
    expect(client.deleteStream).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/destinations/youtubeProvider.test.ts`
Expected: FAIL — `Cannot find module '../../src/destinations/youtubeProvider'`

- [ ] **Step 3: Implement `src/destinations/youtubeProvider.ts`**

```ts
import { StreamDestination } from '@prisma/client';
import { ApiError } from '../errors';
import { decrypt } from '../crypto/streamKeyCipher';
import { YoutubeApiClient } from './youtubeApiClient';
import { OAuthConnectionRepository } from './oauthConnectionRepository';
import { BroadcastMeta, DestinationLifecycle, DestinationLifecyclePhase, PreparedSession, StreamDestinationProvider } from './streamDestinationProvider';

export interface YoutubeProviderDeps {
  client: YoutubeApiClient;
  encryptionKey: string;
  oauthConnectionRepository: Pick<OAuthConnectionRepository, 'findByDestinationId'>;
  pollIntervalMs?: number;
  healthTimeoutMs?: number;
  scheduleNextPoll?: (fn: () => void | Promise<void>, delayMs: number) => void;
  clock?: () => number;
}

export class YoutubeProvider implements StreamDestinationProvider {
  private readonly pollIntervalMs: number;
  private readonly healthTimeoutMs: number;
  private readonly scheduleNextPoll: (fn: () => void | Promise<void>, delayMs: number) => void;
  private readonly clock: () => number;

  constructor(private readonly deps: YoutubeProviderDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? 3000;
    this.healthTimeoutMs = deps.healthTimeoutMs ?? 90000;
    this.scheduleNextPoll = deps.scheduleNextPoll ?? ((fn, delayMs) => { setTimeout(fn, delayMs); });
    this.clock = deps.clock ?? Date.now;
  }

  async prepareSession(destination: StreamDestination, meta: BroadcastMeta): Promise<PreparedSession> {
    const connection = await this.deps.oauthConnectionRepository.findByDestinationId(destination.id);
    if (!connection) throw new ApiError(502, 'no YouTube connection for this destination');
    const refreshToken = decrypt(connection.refreshTokenEncrypted, this.deps.encryptionKey);

    const accessToken = await this.deps.client.refreshAccessToken(refreshToken);
    const broadcast = await this.deps.client.createBroadcast(accessToken, {
      title: meta.title, description: meta.description ?? '', privacyStatus: meta.privacyStatus ?? 'private',
    });
    const stream = await this.deps.client.createStream(accessToken, { title: meta.title });
    await this.deps.client.bind(accessToken, broadcast.id, stream.id);

    let phase: DestinationLifecyclePhase = 'creating';
    let pushStarted = false;
    let finalized = false;

    const lifecycle: DestinationLifecycle = {
      onPushStarted: () => {
        if (pushStarted) return;
        pushStarted = true;
        phase = 'waitingForYoutube';
        const deadline = this.clock() + this.healthTimeoutMs;

        const poll = async (): Promise<void> => {
          if (finalized) return;
          try {
            const freshAccessToken = await this.deps.client.refreshAccessToken(refreshToken);
            const status = await this.deps.client.getStreamStatus(freshAccessToken, stream.id);
            if (status === 'active') {
              await this.deps.client.transition(freshAccessToken, broadcast.id, 'live');
              phase = 'live';
              return;
            }
          } catch (err) {
            console.error('YouTube health-check poll failed', err);
          }
          if (this.clock() >= deadline) {
            await lifecycle.finalize();
            phase = 'error';
            return;
          }
          this.scheduleNextPoll(() => poll(), this.pollIntervalMs);
        };
        this.scheduleNextPoll(() => poll(), this.pollIntervalMs);
      },

      phase: () => phase,
      watchUrl: () => `https://www.youtube.com/watch?v=${broadcast.id}`,

      finalize: async () => {
        if (finalized) return;
        finalized = true;
        if (pushStarted) {
          try {
            const accessToken2 = await this.deps.client.refreshAccessToken(refreshToken);
            await this.deps.client.transition(accessToken2, broadcast.id, 'complete');
          } catch (err) {
            console.error('failed to transition YouTube broadcast to complete', err);
          }
        }
        try {
          const accessToken3 = await this.deps.client.refreshAccessToken(refreshToken);
          await this.deps.client.deleteStream(accessToken3, stream.id);
        } catch (err) {
          console.error('failed to delete ephemeral YouTube liveStream', err);
        }
        phase = 'complete';
      },
    };

    return { rtmpUrl: stream.ingestionAddress, streamKey: stream.streamName, lifecycle };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/destinations/youtubeProvider.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Run the full suite and build**

Run: `npx jest && npm run build`
Expected: all suites PASS, `tsc` clean

- [ ] **Step 6: Commit**

```bash
git add src/destinations/youtubeProvider.ts test/destinations/youtubeProvider.test.ts
git commit -m "feat: YoutubeProvider — ephemeral liveBroadcast/liveStream lifecycle with health-check polling"
```

---

### Task 8: `StreamController` error hook + `StreamManager` provider integration

**Files:**
- Modify: `src/stream/streamController.ts`
- Modify: `src/stream/types.ts`
- Modify: `src/stream/streamManager.ts`
- Modify: `test/stream/streamController.test.ts`
- Modify: `test/stream/streamManager.test.ts`

**Interfaces:**
- Consumes: `StreamDestinationProvider`/`BroadcastMeta`/`DestinationLifecycle` (Tasks 6, 7).
- Produces:
  - `StreamControllerDeps` gains `onError?: () => void`.
  - `interface ProviderStatus { type: string; phase: string; watchUrl: string | null }`,
    `interface DestinationStreamStatus extends StreamStatus { provider?: ProviderStatus }`
  - `StreamManagerDeps` gains `providers: Record<string, StreamDestinationProvider>`; drops the
    encryption-key concern entirely (moved into the providers).
  - `class StreamManager { constructor(deps: StreamManagerDeps); start(destinationId: string, playlistId: string, meta?: Partial<BroadcastMeta>): Promise<void>; status(destinationId: string): DestinationStreamStatus; ... }` (`StreamManager` no longer takes a second `encryptionKey` constructor argument)

This is the integration point: everything built in Tasks 1–7 gets wired together here, but
`server.ts`/`app.ts` (and thus the running app) aren't touched until Task 10 — `StreamManager`'s
tests are the only thing exercising this wiring for now.

- [ ] **Step 1: Add the `onError` hook to `StreamController`**

Read `src/stream/streamController.ts` first. Add one field to `StreamControllerDeps` and one call
in `start()`:

```ts
export interface StreamControllerDeps {
  library: LibraryLike;
  queue: PlaylistQueue;
  fifoPath: string;
  createFifo: (path: string) => void;
  removeFifo: (path: string) => void;
  createSegmentFeeder: () => SegmentFeeder;
  createRtmpPusher: () => RtmpPusher;
  buildOverlay: (track: Track) => Promise<NowPlayingOverlay>;
  onError?: () => void;
}
```

In `start()`, change the pusher's exit callback (currently `this.pusher.start(() => { this.state = 'error'; });`):

```ts
    this.pusher = this.deps.createRtmpPusher();
    this.pusher.start(() => {
      this.state = 'error';
      this.deps.onError?.();
    });
```

- [ ] **Step 2: Write the failing test for the new hook**

Add to `test/stream/streamController.test.ts`, as a sibling of the existing test `'does not feed
a track if the pusher dies while the overlay is still being probed'` (that test already shows the
exact idiom: `buildDeps()` returns `{ deps, ... }`, `pusher.start.mock.calls[0][0]` is the exit
callback `RtmpPusher.start(onExit)` was invoked with, and `deps` is a plain object you can add
fields to before constructing `new StreamController(deps)` — there is no `buildController(...)`
helper in this file, only `buildDeps()`):

```ts
  it('invokes deps.onError when the pusher exits unexpectedly', async () => {
    const { deps, pusher } = buildDeps();
    const onError = jest.fn();
    deps.onError = onError;
    const controller = new StreamController(deps);
    await controller.start();

    const onExit = pusher.start.mock.calls[0][0] as (code: number | null) => void;
    onExit(1);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(controller.status().state).toBe('error');
  });
```

- [ ] **Step 3: Run the new test to verify it fails, then passes**

Run: `npx jest test/stream/streamController.test.ts`
Expected: first FAIL (`onError` not called — the hook doesn't exist yet), then, after Step 1's
change, PASS. (Steps 1 and 2 together are the usual red/green pair; do Step 1 first only if you
verified red beforehand by temporarily commenting it out, or simply confirm the full file's tests
are green after both steps.)

- [ ] **Step 4: Add `ProviderStatus`/`DestinationStreamStatus` to `src/stream/types.ts`**

```ts
export type SessionState = 'idle' | 'streaming' | 'paused' | 'error';

export interface StreamStatus {
  state: SessionState;
  currentTrack: string | null;
  nextTrack: string | null;
}

export interface ProviderStatus {
  type: string;
  phase: string;
  watchUrl: string | null;
}

export interface DestinationStreamStatus extends StreamStatus {
  provider?: ProviderStatus;
}
```

- [ ] **Step 5: Rewrite `src/stream/streamManager.ts`**

Read the current file first. Replace its entire contents:

```ts
import { posix as path } from 'path';
import { PlaylistQueue } from '../playlist/queue';
import { Track } from '../playlist/types';
import { StreamController } from './streamController';
import { DestinationStreamStatus, StreamStatus } from './types';
import { SegmentFeeder } from '../ffmpeg/segmentFeeder';
import { RtmpPusher } from '../ffmpeg/rtmpPusher';
import { NowPlayingOverlay } from '../ffmpeg/segmentArgs';
import { createFifo, removeFifo } from '../ffmpeg/fifo';
import { getAudioDurationSeconds } from '../ffmpeg/duration';
import { buildPlaylistWindowLines } from '../ffmpeg/overlayText';
import { Spawner } from '../ffmpeg/types';
import { ApiError } from '../errors';
import { PlaylistRepository } from '../playlists/playlistRepository';
import { DestinationRepository } from '../destinations/destinationRepository';
import { TrackRepository } from '../tracks/trackRepository';
import { BroadcastMeta, DestinationLifecycle, StreamDestinationProvider } from '../destinations/streamDestinationProvider';

const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 720;
const VIDEO_FPS = 30;
const PLAYLIST_WINDOW_BEFORE = 2;
const PLAYLIST_WINDOW_AFTER = 7;

export interface StreamManagerDeps {
  spawner: Spawner;
  fifoDir: string;
  defaultCoverPath: string;
  backgroundImagePath: string;
  fontFile: string;
  playlistRepository: Pick<PlaylistRepository, 'listTracks' | 'findById'>;
  destinationRepository: Pick<DestinationRepository, 'findById'>;
  trackRepository: Pick<TrackRepository, 'listByUser'>;
  providers: Record<string, StreamDestinationProvider>;
  // Optional seam for tests: SegmentFeeder opens a real fs write stream onto the
  // FIFO by default. Left undefined in production so SegmentFeeder's own default
  // (fs.createWriteStream) applies unchanged.
  createWriteStream?: (path: string) => NodeJS.WritableStream;
}

export class StreamManager {
  private readonly controllers = new Map<string, StreamController>();
  private readonly lifecycles = new Map<string, { providerType: string; lifecycle: DestinationLifecycle }>();

  constructor(private readonly deps: StreamManagerDeps) {}

  get(destinationId: string): StreamController | undefined {
    return this.controllers.get(destinationId);
  }

  async start(destinationId: string, playlistId: string, meta?: Partial<BroadcastMeta>): Promise<void> {
    // A controller left behind in 'error' state (unexpected pusher exit) must not
    // block a restart — only a live streaming/paused session is "already active".
    const existing = this.controllers.get(destinationId);
    if (existing) {
      const state = existing.status().state;
      if (state === 'streaming' || state === 'paused') {
        throw new ApiError(409, 'a stream is already active for this destination');
      }
      this.controllers.delete(destinationId);
      this.lifecycles.delete(destinationId);
    }

    const destination = await this.deps.destinationRepository.findById(destinationId);
    if (!destination) throw new ApiError(404, 'destination not found');

    // The playlist must belong to the same user who owns the destination, otherwise
    // any user owning a destination could stream another user's private playlist.
    const playlist = await this.deps.playlistRepository.findById(playlistId);
    if (!playlist) throw new ApiError(404, 'playlist not found');
    if (playlist.userId !== destination.userId) throw new ApiError(403, 'not your playlist');

    const tracks: Track[] = await this.deps.playlistRepository.listTracks(playlistId);
    if (tracks.length === 0) throw new ApiError(409, 'playlist is empty');

    const allUserTracksRaw = await this.deps.trackRepository.listByUser(destination.userId);
    const allUserTracks: Track[] = allUserTracksRaw.map((t) => ({ name: t.name, audioPath: t.audioPath, coverPath: t.coverPath }));

    const provider = this.deps.providers[destination.provider];
    if (!provider) throw new ApiError(400, `unsupported destination provider: ${destination.provider}`);
    const resolvedMeta: BroadcastMeta = {
      title: meta?.title ?? playlist.name,
      description: meta?.description,
      privacyStatus: meta?.privacyStatus,
    };
    const session = await provider.prepareSession(destination, resolvedMeta);

    const queue = new PlaylistQueue(tracks);
    const fifoPath = path.join(this.deps.fifoDir, `super-dj-stream-${destinationId}.fifo`);

    const buildOverlay = async (track: Track): Promise<NowPlayingOverlay> => {
      const currentIndex = tracks.findIndex((t) => t.name === track.name);
      return {
        title: track.name,
        playlistLines: buildPlaylistWindowLines(tracks, currentIndex, PLAYLIST_WINDOW_BEFORE, PLAYLIST_WINDOW_AFTER),
        durationSeconds: await getAudioDurationSeconds(track.audioPath),
      };
    };

    const controller = new StreamController({
      library: {
        list: () => tracks,
        findByName: (name: string) => allUserTracks.find((t) => t.name === name),
      },
      queue,
      fifoPath,
      createFifo,
      removeFifo,
      buildOverlay,
      createSegmentFeeder: () => new SegmentFeeder({
        spawner: this.deps.spawner,
        fifoPath,
        defaultCoverPath: this.deps.defaultCoverPath,
        backgroundPath: this.deps.backgroundImagePath,
        fontFile: this.deps.fontFile,
        width: VIDEO_WIDTH,
        height: VIDEO_HEIGHT,
        fps: VIDEO_FPS,
        createWriteStream: this.deps.createWriteStream,
      }),
      createRtmpPusher: () => new RtmpPusher(this.deps.spawner, { fifoPath, rtmpUrl: session.rtmpUrl, streamKey: session.streamKey }),
      onError: () => {
        const entry = this.lifecycles.get(destinationId);
        this.lifecycles.delete(destinationId);
        entry?.lifecycle.finalize().catch((err) => {
          console.error('failed to finalize destination lifecycle after an unexpected pusher exit', err);
        });
      },
    });

    this.controllers.set(destinationId, controller);
    try {
      await controller.start();
    } catch (err) {
      this.controllers.delete(destinationId);
      if (session.lifecycle) {
        await session.lifecycle.finalize().catch((finalizeErr) => {
          console.error('failed to finalize destination lifecycle after a failed start()', finalizeErr);
        });
      }
      throw err;
    }

    if (session.lifecycle) {
      this.lifecycles.set(destinationId, { providerType: destination.provider, lifecycle: session.lifecycle });
      session.lifecycle.onPushStarted();
    }
  }

  async stop(destinationId: string): Promise<void> {
    this.requireController(destinationId).stop();
    this.controllers.delete(destinationId);
    const entry = this.lifecycles.get(destinationId);
    this.lifecycles.delete(destinationId);
    if (entry) {
      await entry.lifecycle.finalize().catch((err) => {
        console.error('failed to finalize destination lifecycle on stop', err);
      });
    }
  }

  pause(destinationId: string): void {
    this.requireController(destinationId).pause();
  }

  async resume(destinationId: string): Promise<void> {
    return this.requireController(destinationId).resume();
  }

  async next(destinationId: string): Promise<void> {
    return this.requireController(destinationId).next();
  }

  async previous(destinationId: string): Promise<void> {
    return this.requireController(destinationId).previous();
  }

  playByName(destinationId: string, name: string): void {
    this.requireController(destinationId).playByName(name);
  }

  status(destinationId: string): DestinationStreamStatus {
    const controller = this.controllers.get(destinationId);
    const base: StreamStatus = controller ? controller.status() : { state: 'idle', currentTrack: null, nextTrack: null };
    const entry = this.lifecycles.get(destinationId);
    if (!entry) return base;
    return {
      ...base,
      provider: { type: entry.providerType, phase: entry.lifecycle.phase(), watchUrl: entry.lifecycle.watchUrl() },
    };
  }

  private requireController(destinationId: string): StreamController {
    const controller = this.controllers.get(destinationId);
    if (!controller) throw new ApiError(409, 'stream is not active');
    return controller;
  }
}
```

- [ ] **Step 6: Update `test/stream/streamManager.test.ts`**

Read the current file first. The `buildDeps()` helper's `destinationRepository.findById` fixture
currently returns `rtmpUrl`/`streamKeyEncrypted` directly and the manager decrypts them inline —
that inline decryption is gone now, replaced by a `providers` map. Replace the whole file:

```ts
jest.mock('../../src/ffmpeg/fifo', () => ({
  createFifo: jest.fn(),
  removeFifo: jest.fn(),
}));
jest.mock('../../src/ffmpeg/duration', () => ({
  getAudioDurationSeconds: jest.fn().mockResolvedValue(100),
}));

import { PassThrough } from 'stream';
import { StreamManager } from '../../src/stream/streamManager';
import { ApiError } from '../../src/errors';

function fakeChild() {
  return { pid: 1, stdout: null, stderr: null, kill: jest.fn(), once: jest.fn() };
}

function fakeLifecycle(overrides: Record<string, jest.Mock> = {}) {
  return {
    onPushStarted: jest.fn(),
    phase: jest.fn().mockReturnValue('waitingForYoutube'),
    watchUrl: jest.fn().mockReturnValue('https://www.youtube.com/watch?v=broadcast-1'),
    finalize: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function buildDeps() {
  const spawner = jest.fn().mockReturnValue(fakeChild());
  const destinationRepository = {
    findById: jest.fn().mockResolvedValue({ id: 'dest-1', userId: 'user-1', provider: 'custom' }),
  };
  const playlistRepository = {
    findById: jest.fn().mockResolvedValue({ id: 'playlist-1', userId: 'user-1', name: 'Mix' }),
    listTracks: jest.fn().mockResolvedValue([
      { name: 'a', audioPath: '/music/a.mp3', coverPath: null },
      { name: 'b', audioPath: '/music/b.mp3', coverPath: null },
    ]),
  };
  const trackRepository = {
    listByUser: jest.fn().mockResolvedValue([
      { name: 'a', audioPath: '/music/a.mp3', coverPath: null },
      { name: 'b', audioPath: '/music/b.mp3', coverPath: null },
      { name: 'c', audioPath: '/music/c.mp3', coverPath: null },
    ]),
  };
  const customProvider = { prepareSession: jest.fn().mockResolvedValue({ rtmpUrl: 'rtmp://example.com/live', streamKey: 'real-stream-key' }) };
  const youtubeLifecycle = fakeLifecycle();
  const youtubeProvider = { prepareSession: jest.fn().mockResolvedValue({ rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2', streamKey: 'yt-key', lifecycle: youtubeLifecycle }) };
  // SegmentFeeder opens a real fs.createWriteStream on the fifo path unless overridden;
  // fake it so start()/tests never touch the real filesystem (same rationale as the
  // fifo/duration module mocks above — no real fs/subprocess touches in a unit test).
  const createWriteStream = jest.fn().mockImplementation(() => new PassThrough());
  return {
    deps: {
      spawner, fifoDir: '/tmp', defaultCoverPath: '/assets/default.png', backgroundImagePath: '/assets/bg.png',
      fontFile: '/fonts/x.ttf', playlistRepository, destinationRepository, trackRepository,
      providers: { custom: customProvider, youtube: youtubeProvider }, createWriteStream,
    },
    destinationRepository, playlistRepository, trackRepository, createWriteStream, customProvider, youtubeProvider, youtubeLifecycle,
  };
}

describe('StreamManager', () => {
  it('start() throws 404 for an unknown destination', async () => {
    const { deps, destinationRepository } = buildDeps();
    destinationRepository.findById.mockResolvedValue(null);
    const manager = new StreamManager(deps as any);
    await expect(manager.start('dest-1', 'playlist-1')).rejects.toThrow(ApiError);
  });

  it('start() throws 404 when the playlist does not exist', async () => {
    const { deps, playlistRepository } = buildDeps();
    playlistRepository.findById.mockResolvedValue(null);
    const manager = new StreamManager(deps as any);
    await expect(manager.start('dest-1', 'playlist-1')).rejects.toMatchObject({ status: 404, message: 'playlist not found' });
    expect(playlistRepository.listTracks).not.toHaveBeenCalled();
  });

  it('start() throws 403 when the playlist belongs to another user than the destination owner', async () => {
    const { deps, playlistRepository } = buildDeps();
    playlistRepository.findById.mockResolvedValue({ id: 'playlist-1', userId: 'someone-else', name: 'Theirs' });
    const manager = new StreamManager(deps as any);
    await expect(manager.start('dest-1', 'playlist-1')).rejects.toMatchObject({ status: 403, message: 'not your playlist' });
    expect(playlistRepository.listTracks).not.toHaveBeenCalled();
  });

  it('start() throws 409 for an empty playlist', async () => {
    const { deps, playlistRepository } = buildDeps();
    playlistRepository.listTracks.mockResolvedValue([]);
    const manager = new StreamManager(deps as any);
    await expect(manager.start('dest-1', 'playlist-1')).rejects.toThrow('playlist is empty');
  });

  it('start() throws 400 for a destination with an unregistered provider', async () => {
    const { deps, destinationRepository } = buildDeps();
    destinationRepository.findById.mockResolvedValue({ id: 'dest-1', userId: 'user-1', provider: 'twitch' });
    const manager = new StreamManager(deps as any);
    await expect(manager.start('dest-1', 'playlist-1')).rejects.toMatchObject({ status: 400 });
  });

  it('start() creates a controller reachable via get(), and status() reflects it', async () => {
    const { deps, createWriteStream } = buildDeps();
    const manager = new StreamManager(deps as any);

    await manager.start('dest-1', 'playlist-1');

    expect(manager.get('dest-1')).toBeDefined();
    expect(manager.status('dest-1').state).toBe('streaming');
    expect(manager.status('dest-1').currentTrack).toBe('a');
    expect(createWriteStream).toHaveBeenCalledWith('/tmp/super-dj-stream-dest-1.fifo');
  });

  it('start() defaults the broadcast title to the playlist name when no meta is given', async () => {
    const { deps, customProvider } = buildDeps();
    const manager = new StreamManager(deps as any);
    await manager.start('dest-1', 'playlist-1');
    expect(customProvider.prepareSession).toHaveBeenCalledWith(expect.anything(), { title: 'Mix', description: undefined, privacyStatus: undefined });
  });

  it('start() passes through an explicit title/description/privacyStatus', async () => {
    const { deps, customProvider } = buildDeps();
    const manager = new StreamManager(deps as any);
    await manager.start('dest-1', 'playlist-1', { title: 'Custom Title', description: 'D', privacyStatus: 'unlisted' });
    expect(customProvider.prepareSession).toHaveBeenCalledWith(expect.anything(), { title: 'Custom Title', description: 'D', privacyStatus: 'unlisted' });
  });

  it('start() throws 409 if a stream is already active for that destination', async () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any);
    await manager.start('dest-1', 'playlist-1');
    await expect(manager.start('dest-1', 'playlist-1')).rejects.toThrow(ApiError);
  });

  it('start() replaces a controller stuck in error state instead of rejecting with 409', async () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any);
    const crashed = { status: () => ({ state: 'error', currentTrack: null, nextTrack: null }) };
    (manager as any).controllers.set('dest-1', crashed);

    await expect(manager.start('dest-1', 'playlist-1')).resolves.toBeUndefined();

    expect(manager.get('dest-1')).toBeDefined();
    expect(manager.get('dest-1')).not.toBe(crashed);
    expect(manager.status('dest-1').state).toBe('streaming');
  });

  it('status() returns a synthetic idle status when no controller exists for a destination', () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any);
    expect(manager.status('never-started')).toEqual({ state: 'idle', currentTrack: null, nextTrack: null });
  });

  it('pause()/next()/etc. throw 409 when no controller exists for a destination', async () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any);
    expect(() => manager.pause('never-started')).toThrow(ApiError);
    await expect(manager.next('never-started')).rejects.toThrow(ApiError);
  });

  it('stop() tears the controller down and removes it from the registry', async () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any);
    await manager.start('dest-1', 'playlist-1');

    await manager.stop('dest-1');

    expect(manager.get('dest-1')).toBeUndefined();
    expect(manager.status('dest-1')).toEqual({ state: 'idle', currentTrack: null, nextTrack: null });
  });

  it('playByName() finds a track across ALL of the owning user\'s tracks, not just the current playlist', async () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any);
    await manager.start('dest-1', 'playlist-1');

    expect(() => manager.playByName('dest-1', 'c')).not.toThrow();
  });

  describe('YouTube-backed destinations (a provider that returns a lifecycle)', () => {
    function withYoutubeDestination(deps: ReturnType<typeof buildDeps>['deps'], destinationRepository: ReturnType<typeof buildDeps>['destinationRepository']) {
      destinationRepository.findById.mockResolvedValue({ id: 'dest-1', userId: 'user-1', provider: 'youtube' });
      return deps;
    }

    it('calls lifecycle.onPushStarted() after the controller starts, and status() includes the provider phase', async () => {
      const { deps, destinationRepository, youtubeLifecycle } = buildDeps();
      const manager = new StreamManager(withYoutubeDestination(deps as any, destinationRepository) as any);

      await manager.start('dest-1', 'playlist-1');

      expect(youtubeLifecycle.onPushStarted).toHaveBeenCalledTimes(1);
      expect(manager.status('dest-1').provider).toEqual({ type: 'youtube', phase: 'waitingForYoutube', watchUrl: 'https://www.youtube.com/watch?v=broadcast-1' });
    });

    it('stop() finalizes the lifecycle', async () => {
      const { deps, destinationRepository, youtubeLifecycle } = buildDeps();
      const manager = new StreamManager(withYoutubeDestination(deps as any, destinationRepository) as any);
      await manager.start('dest-1', 'playlist-1');

      await manager.stop('dest-1');

      expect(youtubeLifecycle.finalize).toHaveBeenCalledTimes(1);
      expect(manager.status('dest-1').provider).toBeUndefined();
    });

    it('an unexpected pusher exit finalizes the lifecycle via the onError hook', async () => {
      const { deps, destinationRepository, youtubeLifecycle, spawner } = buildDeps() as any;
      const manager = new StreamManager(withYoutubeDestination(deps as any, destinationRepository) as any);
      await manager.start('dest-1', 'playlist-1');

      // StreamController.start() calls createRtmpPusher().start(...) — which spawns the pusher's
      // ffmpeg — BEFORE it ever feeds a track (which spawns the segment feeder's producer ffmpeg).
      // So the pusher's child is always the FIRST spawner() call, regardless of how many segments
      // get fed afterward. RtmpPusher.start() registers `child.once('exit', onExitCallback)` — grab
      // that same callback and invoke it directly to simulate the pusher's ffmpeg dying unexpectedly.
      const pusherChild = spawner.mock.results[0].value;
      const onExit = pusherChild.once.mock.calls.find((call: any[]) => call[0] === 'exit')?.[1];
      onExit(1);

      expect(youtubeLifecycle.finalize).toHaveBeenCalledTimes(1);
    });
  });
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx jest test/stream/streamManager.test.ts test/stream/streamController.test.ts`
Expected: PASS (fix any remaining mismatches between the rewritten test file and the actual
`StreamManager` behavior before moving on)

- [ ] **Step 8: Run the full suite and build**

Run: `npx jest && npm run build`
Expected: PASS / clean, except for compile errors in `src/server.ts` (still calling the old
two-argument `new StreamManager(deps, encryptionKey)` and the old `destinationRepository.create`
signature) — expected, fixed in Task 10.

- [ ] **Step 9: Commit**

```bash
git add src/stream/streamController.ts src/stream/types.ts src/stream/streamManager.ts test/stream/streamController.test.ts test/stream/streamManager.test.ts
git commit -m "feat: StreamManager provider integration — resolve StreamDestinationProvider per destination, surface lifecycle phase in status()"
```

---

### Task 9: Route-level wiring — destination provider validation, OAuth revoke on delete, start() meta body

**Files:**
- Modify: `src/destinations/destinationRoutes.ts`
- Modify: `src/stream/streamRoutes.ts`
- Modify: `test/destinations/destinationRoutes.test.ts`
- Modify: `test/stream/streamRoutes.test.ts`

**Interfaces:**
- Consumes: `OAuthProviderAdapter` (Task 4), `OAuthConnectionRepository.findByDestinationId`
  (Task 2), `StreamManager.start(destinationId, playlistId, meta?)` (Task 8).
- Produces: `createDestinationRouter(authService, destinationRepository, encryptionKey, streamManager, oauthProviderAdapters: Record<string, OAuthProviderAdapter>, oauthConnectionRepository: Pick<OAuthConnectionRepository, 'findByDestinationId'>): Router`
  (two new trailing params). `createStreamRouter`'s signature is unchanged; only its `/start`
  handler's body parsing changes.

- [ ] **Step 1: Update `src/destinations/destinationRoutes.ts`**

Read the current file first. Replace its contents:

```ts
import { Router } from 'express';
import { DestinationRepository } from './destinationRepository';
import { OAuthConnectionRepository } from './oauthConnectionRepository';
import { OAuthProviderAdapter } from './oauthProviderAdapter';
import { encrypt, decrypt } from '../crypto/streamKeyCipher';
import { ApiError } from '../errors';
import { wrapAsync } from '../api/errorHandler';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { AuthService } from '../auth/authService';
import { StreamManager } from '../stream/streamManager';

function toPublicDestination(d: { id: string; name: string; rtmpUrl: string | null; provider: string }) {
  return { id: d.id, name: d.name, rtmpUrl: d.rtmpUrl, provider: d.provider };
}

export function createDestinationRouter(
  authService: AuthService,
  destinationRepository: DestinationRepository,
  encryptionKey: string,
  streamManager: Pick<StreamManager, 'stop'>,
  oauthProviderAdapters: Record<string, OAuthProviderAdapter>,
  oauthConnectionRepository: Pick<OAuthConnectionRepository, 'findByDestinationId'>,
): Router {
  const router = Router();
  const auth = requireAuth(authService);

  router.post('/', auth, wrapAsync(async (req, res) => {
    const { name, rtmpUrl, streamKey, provider } = req.body ?? {};
    if (provider !== undefined && provider !== 'custom') {
      throw new ApiError(400, `unsupported provider for manual creation: ${provider}. Use /destinations/${provider}/oauth/start instead.`);
    }
    if (typeof name !== 'string' || name.length === 0) throw new ApiError(400, 'body.name is required');
    if (typeof rtmpUrl !== 'string' || rtmpUrl.length === 0) throw new ApiError(400, 'body.rtmpUrl is required');
    if (typeof streamKey !== 'string' || streamKey.length === 0) throw new ApiError(400, 'body.streamKey is required');

    const destination = await destinationRepository.create({
      userId: (req as AuthenticatedRequest).user!.id,
      name,
      provider: 'custom',
      rtmpUrl,
      streamKeyEncrypted: encrypt(streamKey, encryptionKey),
    });
    res.status(200).json(toPublicDestination(destination));
  }));

  router.get('/', auth, wrapAsync(async (req, res) => {
    const destinations = await destinationRepository.listByUser((req as AuthenticatedRequest).user!.id);
    res.status(200).json(destinations.map(toPublicDestination));
  }));

  router.delete('/:id', auth, wrapAsync(async (req, res) => {
    const destination = await destinationRepository.findById(req.params.id);
    if (!destination) throw new ApiError(404, 'destination not found');
    if (destination.userId !== (req as AuthenticatedRequest).user!.id) throw new ApiError(403, 'not your destination');
    // Tear down any running stream first, otherwise its StreamController/ffmpeg/FIFO
    // is orphaned: /stop would 404 once the destination row is gone.
    try {
      await streamManager.stop(destination.id);
    } catch (err) {
      // 409 from stop() just means "wasn't streaming" — not a failure.
      if (!(err instanceof ApiError && err.status === 409)) throw err;
    }
    if (destination.provider !== 'custom') {
      const adapter = oauthProviderAdapters[destination.provider];
      const connection = adapter ? await oauthConnectionRepository.findByDestinationId(destination.id) : null;
      if (adapter && connection) {
        try {
          await adapter.revoke(decrypt(connection.refreshTokenEncrypted, encryptionKey));
        } catch (err) {
          console.error('failed to revoke OAuth token for destination', destination.id, err);
        }
      }
    }
    await destinationRepository.deleteById(destination.id);
    res.status(200).json({});
  }));

  return router;
}
```

- [ ] **Step 2: Update `test/destinations/destinationRoutes.test.ts`**

Read the current file first. Its `buildApp()` helper needs two more fake deps, and one new test
covers the provider-validation and revoke-on-delete behavior. Update `buildApp`:

```ts
function buildApp(
  destinationRepository: any,
  streamManager: any = { stop: jest.fn().mockResolvedValue(undefined) },
  userId = 'user-1',
  oauthProviderAdapters: any = {},
  oauthConnectionRepository: any = { findByDestinationId: jest.fn().mockResolvedValue(null) },
) {
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: userId, email: 'a@example.com' }) };
  const app = express();
  app.use(express.json());
  app.use('/destinations', createDestinationRouter(authService, destinationRepository, KEY, streamManager, oauthProviderAdapters, oauthConnectionRepository));
  app.use(errorHandler);
  return app;
}
```

Update the two existing tests that assert on the create/list response shape and body, since
`provider: 'youtube'` is no longer the default the repository fixture would realistically return
for a manually-created destination — replace `provider: 'youtube'` with `provider: 'custom'` in
both the `POST /destinations creates a destination...` and `GET /destinations never includes the
encrypted key` tests' fixtures/expectations. Then add:

```ts
  it('POST /destinations rejects a non-custom provider', async () => {
    const destinationRepository: any = { create: jest.fn() };
    const res = await request(buildApp(destinationRepository)).post('/destinations').send({
      name: 'X', rtmpUrl: 'rtmp://x', streamKey: 'k', provider: 'youtube',
    });
    expect(res.status).toBe(400);
    expect(destinationRepository.create).not.toHaveBeenCalled();
  });

  it('DELETE /destinations/:id revokes the OAuth token for a non-custom destination', async () => {
    const destinationRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'd1', userId: 'user-1', provider: 'youtube' }), deleteById: jest.fn() };
    const adapter = { revoke: jest.fn().mockResolvedValue(undefined) };
    const oauthConnectionRepository = { findByDestinationId: jest.fn().mockResolvedValue({ refreshTokenEncrypted: 'blob' }) };
    const res = await request(buildApp(destinationRepository, undefined, 'user-1', { youtube: adapter }, oauthConnectionRepository)).delete('/destinations/d1');
    expect(res.status).toBe(200);
    expect(adapter.revoke).toHaveBeenCalled();
    expect(destinationRepository.deleteById).toHaveBeenCalledWith('d1');
  });

  it('DELETE /destinations/:id still deletes if OAuth revoke fails', async () => {
    const destinationRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'd1', userId: 'user-1', provider: 'youtube' }), deleteById: jest.fn() };
    const adapter = { revoke: jest.fn().mockRejectedValue(new Error('google is down')) };
    const oauthConnectionRepository = { findByDestinationId: jest.fn().mockResolvedValue({ refreshTokenEncrypted: 'blob' }) };
    const res = await request(buildApp(destinationRepository, undefined, 'user-1', { youtube: adapter }, oauthConnectionRepository)).delete('/destinations/d1');
    expect(res.status).toBe(200);
    expect(destinationRepository.deleteById).toHaveBeenCalledWith('d1');
  });
```

(The `decrypt` call inside the route on a fixture value like `'blob'` will throw — since revoke
failures are caught, this exercises that catch path exactly as intended; if it throws before
reaching `adapter.revoke`, adjust the fixture's `refreshTokenEncrypted` to a real
`encrypt('x', KEY)` output instead, matching the style already used elsewhere in this test file.)

- [ ] **Step 3: Update `src/stream/streamRoutes.ts`'s `/start` handler**

Read the current file first. Replace only the `/start` handler body:

```ts
  router.post('/start', auth, wrapAsync(async (req, res) => {
    const destinationId = req.params.destinationId;
    await requireOwnedDestination(destinationRepository, destinationId, userId(req as AuthenticatedRequest));
    const { playlistId, title, description, privacyStatus } = req.body ?? {};
    if (typeof playlistId !== 'string' || playlistId.length === 0) throw new ApiError(400, 'body.playlistId is required');
    if (title !== undefined && typeof title !== 'string') throw new ApiError(400, 'body.title must be a string');
    if (description !== undefined && typeof description !== 'string') throw new ApiError(400, 'body.description must be a string');
    if (privacyStatus !== undefined && !['public', 'unlisted', 'private'].includes(privacyStatus)) {
      throw new ApiError(400, "body.privacyStatus must be 'public', 'unlisted', or 'private'");
    }
    await streamManager.start(destinationId, playlistId, { title, description, privacyStatus });
    res.status(200).json(streamManager.status(destinationId));
  }));
```

- [ ] **Step 4: Update `test/stream/streamRoutes.test.ts`**

Read the current file first. The existing assertion `expect(streamManager.start).toHaveBeenCalledWith('dest-1', 'p1')`
needs a third argument now:

```ts
    expect(streamManager.start).toHaveBeenCalledWith('dest-1', 'p1', { title: undefined, description: undefined, privacyStatus: undefined });
```

Add one new test:

```ts
  it('POST .../start rejects an invalid privacyStatus', async () => {
    const streamManager: any = { start: jest.fn() };
    const res = await request(buildApp(streamManager, ownedDestination())).post('/destinations/dest-1/stream/start').send({ playlistId: 'p1', privacyStatus: 'sortof' });
    expect(res.status).toBe(400);
    expect(streamManager.start).not.toHaveBeenCalled();
  });
```

- [ ] **Step 5: Run the affected test files**

Run: `npx jest test/destinations/destinationRoutes.test.ts test/stream/streamRoutes.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/destinations/destinationRoutes.ts src/stream/streamRoutes.ts test/destinations/destinationRoutes.test.ts test/stream/streamRoutes.test.ts
git commit -m "feat: reject non-custom provider on manual POST /destinations, revoke OAuth token on delete, accept broadcast meta on /stream/start"
```

---

### Task 10: Wire everything into the composition root, docs, and infra

**Files:**
- Modify: `src/server.ts`
- Modify: `src/api/app.ts`
- Modify: `src/api/openapi.ts`
- Modify: `test/api/openapi.test.ts`, `test/server.test.ts`
- Modify: `docker-compose.yml`
- Modify: `CLAUDE.md`
- Create: `prisma/migrations/<timestamp>_youtube_oauth/migration.sql`

**Interfaces:**
- Consumes: everything from Tasks 1–9.

This is the single cutover task — after it, the running app actually serves the new routes.

- [ ] **Step 1: Update `src/server.ts`**

Read the current file first. Add the new imports, construct the adapter/provider registries, and
update `StreamManager`'s and `createApp`'s call sites:

```ts
import { spawn } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { AppConfig } from './config/env';
import { UserRepository } from './auth/userRepository';
import { SessionRepository } from './auth/sessionRepository';
import { AuthService } from './auth/authService';
import { TrackRepository } from './tracks/trackRepository';
import { TrackUploadService } from './tracks/trackUploadService';
import { PlaylistRepository } from './playlists/playlistRepository';
import { DestinationRepository } from './destinations/destinationRepository';
import { OAuthConnectionRepository } from './destinations/oauthConnectionRepository';
import { OAuthStateRepository } from './destinations/oauthStateRepository';
import { createYoutubeApiClient } from './destinations/youtubeApiClient';
import { YoutubeOAuthAdapter } from './destinations/youtubeOAuthAdapter';
import { OAuthProviderAdapter } from './destinations/oauthProviderAdapter';
import { CustomRtmpProvider } from './destinations/customRtmpProvider';
import { YoutubeProvider } from './destinations/youtubeProvider';
import { StreamDestinationProvider } from './destinations/streamDestinationProvider';
import { StreamManager } from './stream/streamManager';
import { Spawner, ChildProcessLike } from './ffmpeg/types';
import { createApp } from './api/app';

const FONT_FILE = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const YOUTUBE_OAUTH_SCOPE = 'https://www.googleapis.com/auth/youtube';

/**
 * Wraps child_process.spawn so every spawned ffmpeg has its stderr drained.
 * ffmpeg writes a banner plus continuous progress to stderr; if nothing reads
 * it the OS pipe buffer (~64KB) fills and ffmpeg blocks on write, stalling the
 * whole pipeline. Forwarding it to our own stderr also surfaces ffmpeg errors
 * in the container logs.
 */
export function createSpawner(): Spawner {
  return (command: string, args: string[]): ChildProcessLike => {
    const child = spawn(command, args);
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    return child as unknown as ChildProcessLike;
  };
}

export function buildServer(config: AppConfig, spawner: Spawner = createSpawner()) {
  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });

  const userRepository = new UserRepository(prisma);
  const sessionRepository = new SessionRepository(prisma);
  const authService = new AuthService({ userRepository, sessionRepository, sessionTtlDays: config.sessionTtlDays });

  const trackRepository = new TrackRepository(prisma);
  const trackUploadService = new TrackUploadService({ trackRepository, uploadsDir: config.uploadsDir });
  const playlistRepository = new PlaylistRepository(prisma);
  const destinationRepository = new DestinationRepository(prisma);
  const oauthConnectionRepository = new OAuthConnectionRepository(prisma);
  const oauthStateRepository = new OAuthStateRepository(prisma);

  const youtubeApiClient = createYoutubeApiClient({ clientId: config.googleOAuthClientId, clientSecret: config.googleOAuthClientSecret });
  const youtubeOAuthAdapter = new YoutubeOAuthAdapter({
    client: youtubeApiClient,
    clientId: config.googleOAuthClientId,
    redirectUri: `${config.appBaseUrl}/destinations/youtube/oauth/callback`,
    scope: YOUTUBE_OAUTH_SCOPE,
  });
  const oauthProviderAdapters: Record<string, OAuthProviderAdapter> = { youtube: youtubeOAuthAdapter };

  const streamDestinationProviders: Record<string, StreamDestinationProvider> = {
    custom: new CustomRtmpProvider(config.streamKeyEncryptionKey),
    youtube: new YoutubeProvider({ client: youtubeApiClient, encryptionKey: config.streamKeyEncryptionKey, oauthConnectionRepository }),
  };

  const streamManager = new StreamManager({
    spawner,
    fifoDir: config.fifoDir,
    defaultCoverPath: config.defaultCoverPath,
    backgroundImagePath: config.backgroundImagePath,
    fontFile: FONT_FILE,
    playlistRepository,
    destinationRepository,
    trackRepository,
    providers: streamDestinationProviders,
  });

  const app = createApp({
    authService,
    trackRepository,
    trackUploadService,
    playlistRepository,
    destinationRepository,
    destinationEncryptionKey: config.streamKeyEncryptionKey,
    streamManager,
    oauthProviderAdapters,
    oauthStateRepository,
    oauthConnectionRepository,
  });

  return { app, prisma };
}
```

- [ ] **Step 2: Update `src/api/app.ts`**

Read the current file first. Add the three new `AppDeps` fields and mount the OAuth router:

```ts
import express, { Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import { AuthService } from '../auth/authService';
import { createAuthRouter } from '../auth/authRoutes';
import { TrackRepository } from '../tracks/trackRepository';
import { TrackUploadService } from '../tracks/trackUploadService';
import { createTrackRouter } from '../tracks/trackRoutes';
import { PlaylistRepository } from '../playlists/playlistRepository';
import { createPlaylistRouter } from '../playlists/playlistRoutes';
import { DestinationRepository } from '../destinations/destinationRepository';
import { createDestinationRouter } from '../destinations/destinationRoutes';
import { createOAuthRouter } from '../destinations/oauthRoutes';
import { OAuthProviderAdapter } from '../destinations/oauthProviderAdapter';
import { OAuthStateRepository } from '../destinations/oauthStateRepository';
import { OAuthConnectionRepository } from '../destinations/oauthConnectionRepository';
import { StreamManager } from '../stream/streamManager';
import { createStreamRouter } from '../stream/streamRoutes';
import { errorHandler } from './errorHandler';
import { openApiSpec } from './openapi';

export interface AppDeps {
  authService: AuthService;
  trackRepository: TrackRepository;
  trackUploadService: TrackUploadService;
  playlistRepository: PlaylistRepository;
  destinationRepository: DestinationRepository;
  destinationEncryptionKey: string;
  streamManager: StreamManager;
  oauthProviderAdapters: Record<string, OAuthProviderAdapter>;
  oauthStateRepository: OAuthStateRepository;
  oauthConnectionRepository: OAuthConnectionRepository;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json());
  app.use('/auth', createAuthRouter(deps.authService));
  app.use('/tracks', createTrackRouter(deps.authService, deps.trackUploadService, deps.trackRepository));
  app.use('/playlists', createPlaylistRouter(deps.authService, deps.playlistRepository, deps.trackRepository));
  app.use('/destinations', createDestinationRouter(deps.authService, deps.destinationRepository, deps.destinationEncryptionKey, deps.streamManager, deps.oauthProviderAdapters, deps.oauthConnectionRepository));
  app.use('/destinations', createOAuthRouter(deps.authService, deps.oauthProviderAdapters, deps.oauthStateRepository, deps.oauthConnectionRepository, deps.destinationRepository, deps.destinationEncryptionKey));
  app.use('/destinations/:destinationId/stream', createStreamRouter(deps.authService, deps.streamManager, deps.destinationRepository));
  app.get('/openapi.json', (_req, res) => res.json(openApiSpec));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
  app.use(errorHandler);
  return app;
}
```

- [ ] **Step 3: Update `test/api/openapi.test.ts` and `test/server.test.ts`**

Read both files first. Their `buildApp()`/`AppConfig` fixtures need the new fields:
`oauthProviderAdapters: {}`, `oauthStateRepository: {} as any`, `oauthConnectionRepository: {} as any`
for the `createApp`/`AppDeps` fixture in `openapi.test.ts`, and `googleOAuthClientId: 'client-id'`,
`googleOAuthClientSecret: 'client-secret'`, `appBaseUrl: 'https://app.example.com'` for the
`AppConfig` fixture in `server.test.ts` (matching Task 1 Step 7's earlier fix, if not already
covering this exact file).

- [ ] **Step 4: Update `src/api/openapi.ts`**

Read the current file first. Update the `Destination` schema's `rtmpUrl` to `nullable: true`:

```ts
      Destination: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          rtmpUrl: { type: 'string', nullable: true },
          provider: { type: 'string' },
        },
      },
```

Add a `provider` field to `StreamStatus`:

```ts
      StreamStatus: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['idle', 'streaming', 'paused', 'error'] },
          currentTrack: { type: 'string', nullable: true },
          nextTrack: { type: 'string', nullable: true },
          provider: {
            type: 'object',
            nullable: true,
            properties: {
              type: { type: 'string' },
              phase: { type: 'string' },
              watchUrl: { type: 'string', nullable: true },
            },
          },
        },
      },
```

Add two new paths, following the file's existing style (insert near the `/destinations/{id}`
entry):

```ts
    '/destinations/{provider}/oauth/start': {
      get: {
        summary: 'Begin connecting a streaming-platform account via OAuth2 (e.g. YouTube)',
        parameters: [{ name: 'provider', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Auth URL to open in a browser', content: { 'application/json': { schema: { type: 'object', properties: { authUrl: { type: 'string' } } } } } },
          '401': { description: 'Not authenticated' },
          '404': { description: 'Unknown provider' },
        },
      },
    },
    '/destinations/{provider}/oauth/callback': {
      get: {
        summary: 'OAuth2 redirect target — exchanges the code and creates the destination',
        parameters: [
          { name: 'provider', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'code', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'state', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Connected — an HTML confirmation page' },
          '400': { description: 'Missing/invalid code or state' },
          '404': { description: 'Unknown provider' },
        },
      },
    },
```

Also update `POST /destinations/{destinationId}/stream/start`'s `requestBody` schema to include
the optional `title`/`description`/`privacyStatus` fields, and its `Destination` POST body
description to mention `provider` must be `'custom'` or omitted (read the existing entries first
and follow their exact style for both).

- [ ] **Step 5: Run the full suite and build**

Run: `npx jest && npm run build`
Expected: all suites PASS, `tsc` clean. This is the single most important checkpoint in this
task — it proves the wiring didn't silently drop or break anything the other 9 tasks built.

- [ ] **Step 6: Update `docker-compose.yml`**

Read the current file first. Add three env vars to the `super-dj` service's `environment` block
(values are placeholders the operator fills in — see Step 7):

```yaml
      GOOGLE_OAUTH_CLIENT_ID: ${GOOGLE_OAUTH_CLIENT_ID}
      GOOGLE_OAUTH_CLIENT_SECRET: ${GOOGLE_OAUTH_CLIENT_SECRET}
      APP_BASE_URL: ${APP_BASE_URL}
```

- [ ] **Step 7: Update `CLAUDE.md`**

Read the current file first. Update:
- **Architecture (as built):** add a short paragraph (near the "Stream keys at rest" bullet)
  describing the `StreamDestinationProvider`/`OAuthProviderAdapter` split, the ephemeral
  liveBroadcast/liveStream-per-session model, and that `OAuthConnection` is provider-generic.
- **HTTP API:** add `GET /destinations/{provider}/oauth/{start,callback}` and note
  `POST .../stream/start` now accepts optional `title`/`description`/`privacyStatus`.
- **Configuration:** add `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `APP_BASE_URL` to
  the Required env vars list, with a one-line note that they come from a Google Cloud Console
  OAuth client with the YouTube Data API v3 enabled (an external, manual, one-time setup step).
- **Known follow-ups:** add a line noting that a long-running stream's access token is refreshed
  per-call rather than cached (deliberate, avoids expiry bugs, costs a few extra token-endpoint
  calls) and that real end-to-end YouTube API smoke testing (an actual channel going live) has
  not been run, matching the existing real-ffmpeg-smoke-testing caveat already in that section.

- [ ] **Step 8: Generate the migration for the new models**

Follow the exact same procedure documented in `CLAUDE.md`'s Persistence section and used for the
DB+auth and multi-tenant-backend phases: no local Docker daemon is available, so use temporary,
self-cleaning Docker resources on the remote host at `192.168.14.26` (passwordless SSH) — stage
`prisma/schema.prisma`, the **existing** `prisma/migrations/` directory, and
`package.json`/`package-lock.json` in a temp dir on that host; spin up a throwaway
`postgres:16-alpine` container on an isolated docker network; run
`npm ci && npx prisma migrate dev --name youtube_oauth --skip-generate` in a throwaway
`node:20-bookworm-slim` container on the same network (`apt-get install -y openssl` first,
`DATABASE_URL` pointing at the postgres container by its container name); copy the generated
`prisma/migrations/<timestamp>_youtube_oauth/` directory back into this repo; tear down every
temporary container/network/temp file on the remote host. Do not touch, stop, or inspect anything
already running on that host (in particular, leave the existing `super-dj` container on port 8088
alone). If this is genuinely blocked, report BLOCKED with specifics rather than hand-writing
migration SQL.

Verify the generated SQL alters `StreamDestination` (nullable `rtmpUrl`/`streamKeyEncrypted`,
`provider` default `'custom'`) and creates `OAuthConnection` and `OAuthState` tables matching
`schema.prisma`, before committing.

- [ ] **Step 9: Commit**

```bash
git add src/server.ts src/api/app.ts src/api/openapi.ts test/api/openapi.test.ts test/server.test.ts docker-compose.yml CLAUDE.md prisma/migrations
git commit -m "feat: wire YouTube OAuth + provider registries into the composition root; docs and migration"
```

---

## Self-Review Notes

- **Spec coverage:** the provider-generic `OAuthConnection`/`OAuthState` data model (§1, §3 of
  the spec), the generic `/destinations/:provider/oauth/{start,callback}` routes backed by an
  `OAuthProviderAdapter` registry (§3), the `StreamDestinationProvider` split between
  `CustomRtmpProvider` and `YoutubeProvider` (§4), ephemeral per-session `liveBroadcast`/
  `liveStream` creation and teardown (§4), `StreamManager` integration including the
  `onPushStarted`/`finalize` wiring and the unexpected-pusher-exit path (§5), the `provider` field
  on `GET .../stream/status` (§6), error handling and OAuth-revoke-on-delete (§7), and the
  fake-`YoutubeApiClient`-based testing strategy (§8) each map to a task above. Every item in the
  spec's "Open questions for the implementation plan" section is resolved in this plan's Global
  Constraints.
- **Sequencing:** Tasks 1–7 are purely additive (new files, no existing route touched) so the
  build and every existing test stay green throughout; Task 8 is a deliberate, self-contained
  rewrite of `StreamController`/`StreamManager` that intentionally leaves `server.ts` red (it
  still calls the old two-argument `StreamManager` constructor) until Task 10's single cutover —
  the same pattern the multi-tenant-backend plan used for its Task 9.
- **Naming-consistency fix during drafting:** an earlier draft of Task 8 kept
  `DestinationLifecyclePhase` values as YouTube-flavored strings scattered across `YoutubeProvider`
  and `StreamManager`; moved the type itself into the provider-agnostic
  `streamDestinationProvider.ts` (Task 6) so `YoutubeProvider` (Task 7) just consumes it, keeping
  the "generic now, YouTube today" principle from the spec intact at the type level too.
- **Cross-task interface check:** `YoutubeProvider` (Task 7) consumes `OAuthConnectionRepository`
  via `Pick<..., 'findByDestinationId'>` (Task 2) and `YoutubeApiClient` (Task 3) — verified the
  method names/signatures used in Task 7's fakes match Task 2/3's real classes exactly.
  `StreamManager` (Task 8) consumes `StreamDestinationProvider` (Task 6/7) via a
  `Record<string, StreamDestinationProvider>`, matching the `Record<string, OAuthProviderAdapter>`
  shape already used for the OAuth side (Task 5) — both registries are constructed the same way
  in `server.ts` (Task 10), for consistency.
- **Correctness fix during drafting:** an earlier draft of `YoutubeProvider`'s health-check
  timeout path set `phase = 'error'` *before* calling `lifecycle.finalize()`, but `finalize()`
  unconditionally sets `phase = 'complete'` at its end — the timeout would have silently reported
  `'complete'` instead of `'error'`. Fixed by finalizing first, then setting `'error'` afterward,
  so `finalize()`'s own phase write is always the one that gets overridden, not the other way
  around.
- **Long-running-stream fix during drafting:** an earlier draft captured a single YouTube access
  token in `prepareSession()` and reused it for the entire session, including inside `finalize()`
  — but access tokens expire in ~1 hour while a stream can run far longer, so a `/stream/stop`
  hours later would fail. Fixed by refreshing the access token again at the start of every poll
  iteration and inside `finalize()`, rather than caching one for the lifecycle's lifetime.
