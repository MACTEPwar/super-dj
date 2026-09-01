# YouTube Data API Integration — Design

**Phase:** 4 of the super-dj roadmap (see project memory `project-super-dj-roadmap`).

**Goal:** `POST /destinations/:id/stream/start` and `.../stop` should create/transition an
actual YouTube live broadcast via the YouTube Data API (OAuth2), instead of requiring the user
to hand-create a broadcast in YouTube Studio and paste its RTMP URL + stream key into
`POST /destinations`. Architecture is a pluggable `StreamDestinationProvider` interface —
YouTube is the first real implementation; the existing manual-RTMP path becomes the second
("custom") implementation of the same interface, not a special case.

**Non-goals (deferred, YAGNI):** any streaming platform besides YouTube; per-user Google OAuth
apps ("bring your own client"); a persistent/reusable YouTube ingestion endpoint; a frontend
(phase 5) — the OAuth consent step is completed by a human in a browser hitting backend routes
directly, same as every other API endpoint in this project today.

---

## 1. Data model

Two changes to `prisma/schema.prisma`:

```prisma
model StreamDestination {
  id                 String   @id @default(uuid())
  userId             String
  user               User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  name               String
  rtmpUrl            String?           // now optional: null for provider = 'youtube'
  streamKeyEncrypted String?           // now optional: null for provider = 'youtube'
  provider           String   @default("custom")   // 'custom' | 'youtube' — default changes from 'youtube' to 'custom'
  createdAt          DateTime @default(now())
  youtubeConnection  YoutubeConnection?
}

model YoutubeConnection {
  id                     String            @id @default(uuid())
  destinationId          String            @unique
  destination            StreamDestination @relation(fields: [destinationId], references: [id], onDelete: Cascade)
  channelId              String
  channelTitle           String
  refreshTokenEncrypted  String
  createdAt              DateTime          @default(now())
}
```

- `rtmpUrl`/`streamKeyEncrypted` go from required to optional. `provider = 'custom'` keeps them
  populated exactly as today. `provider = 'youtube'` leaves them `null` forever — the real RTMP
  ingestion URL/key are minted fresh from the YouTube API on every `/stream/start` and never
  persisted (see §3).
- `YoutubeConnection` is 1:1 with a `StreamDestination`, cascade-deleted with it. It holds the
  encrypted OAuth refresh token and the channel identity (for display / sanity-checking during
  connect).
- Migration generated the usual way (temporary Postgres on `192.168.14.26`, per `CLAUDE.md`).

## 2. Config additions

`src/config/env.ts` gains:

```ts
googleOAuthClientId: string;      // GOOGLE_OAUTH_CLIENT_ID
googleOAuthClientSecret: string;  // GOOGLE_OAUTH_CLIENT_SECRET
appBaseUrl: string;               // APP_BASE_URL — used to build the OAuth redirect_uri, e.g. `${appBaseUrl}/destinations/youtube/oauth/callback`
```

These three are operator-level, set once via env vars (same pattern as `DATABASE_URL`,
`STREAM_KEY_ENCRYPTION_KEY`). They identify the super-dj application to Google — not any
individual user's channel. `APP_BASE_URL` must match a redirect URI registered in the Google
Cloud Console OAuth client (a one-time manual step the user does outside this codebase). Whether
`loadConfig()` requires all three eagerly (boot fails without them) or only validates them lazily
when a YouTube route is first hit is left to the plan — see Open Questions.

## 3. OAuth connect flow

New router mounted at `/destinations/youtube`:

- **`GET /destinations/youtube/oauth/start`** (`requireAuth`) — generates a random `state` value,
  stores it server-side keyed to `userId` with a short TTL (reuse the `Session` table's pattern,
  or a small new table/in-memory map — decide in plan), and returns
  `{ authUrl: "https://accounts.google.com/o/oauth2/v2/auth?...&scope=...&state=..." }`. Requested
  scopes: `https://www.googleapis.com/auth/youtube` (manage broadcasts/streams) and
  `https://www.googleapis.com/auth/youtube.readonly` (read channel identity) — or just the single
  broader scope if Google's granularity doesn't split them usefully; confirm exact scope string in
  the plan. The caller (a human, since there's no frontend yet) opens `authUrl` in a real browser.

- **`GET /destinations/youtube/oauth/callback`** — public (Google redirects the user's browser
  here directly, no session cookie available in that request in general, hence keying `state` to
  `userId` server-side rather than trusting a client-supplied userId). Steps:
  1. Validate `state`, look up the pending `userId`, consume it (single use).
  2. Exchange the `code` query param for `{ access_token, refresh_token, expires_in }` via
     Google's token endpoint, using `googleOAuthClientId`/`googleOAuthClientSecret`.
  3. Call `channels.list(mine=true)` with the fresh access token to get `channelId`/`channelTitle`.
  4. `destinationRepository.create({ userId, name: channelTitle, provider: 'youtube' })` then
     create the linked `YoutubeConnection` row with the encrypted refresh token.
  5. Respond with a minimal static HTML page ("Connected — you can close this tab"). No redirect
     to a frontend (doesn't exist yet).

  If `code` exchange fails, or the account has no channel, respond with a plain error page — no
  destination is created.

## 4. `StreamDestinationProvider` interface

```ts
interface PreparedSession {
  rtmpUrl: string;
  streamKey: string;
  lifecycle?: DestinationLifecycle;   // absent for 'custom'
}

interface DestinationLifecycle {
  // Called by StreamManager once the producer/pusher pipeline has actually begun writing
  // into the FIFO (i.e. ffmpeg is pushing bytes at the RTMP url), so the provider can start
  // polling for stream health and transition the broadcast to 'live'.
  onPushStarted(): void;
  // Current provider-specific phase, surfaced through GET .../stream/status.
  phase(): 'creating' | 'waitingForYoutube' | 'live' | 'complete' | 'error';
  watchUrl(): string | null;
  // Best-effort teardown: transitions the broadcast to 'complete' and deletes the ephemeral
  // liveStream. Called on /stop, and on an unexpected pusher exit.
  finalize(): Promise<void>;
}

interface StreamDestinationProvider {
  prepareSession(destination: StreamDestinationRecord, meta: BroadcastMeta): Promise<PreparedSession>;
}
```

`BroadcastMeta` (`title`, `description?`, `privacyStatus?`) comes from the body of
`POST /destinations/:id/stream/start` — optional fields, defaulting `title` to the playlist's
name and `privacyStatus` to `'private'` when omitted. Ignored entirely by `CustomRtmpProvider`.

- **`CustomRtmpProvider`**: `prepareSession` just decrypts `destination.streamKeyEncrypted` and
  returns `{ rtmpUrl: destination.rtmpUrl, streamKey }` synchronously — no `lifecycle`. This is a
  small refactor of the decrypt call already inline in `StreamManager.start()` today.

- **`YoutubeProvider`**: `prepareSession`
  1. Refreshes the access token from the stored (decrypted) refresh token.
  2. Creates a `liveBroadcast` (title/description/privacyStatus from `meta`, `enableAutoStart:
     false`, `enableAutoStop: false` — we drive transitions ourselves).
  3. Creates a `liveStream` (fixed resolution/frame-rate/ingestion type matching the pinned codec
     params in `src/ffmpeg/segmentArgs.ts`).
  4. Binds them (`liveBroadcasts.bind`).
  5. Returns `{ rtmpUrl, streamKey }` parsed from the `liveStream`'s `cdn.ingestionInfo`
     (`ingestionAddress` + `streamName`), plus a `lifecycle` object closing over the created
     `broadcastId`/`streamId`.
  6. `lifecycle.onPushStarted()` kicks off a polling loop (`liveStreams.list` →
     `status.streamStatus`) until `active` or a timeout (propose 90s, confirm in plan), then calls
     `liveBroadcasts.transition(status: 'live')`. On timeout, sets internal phase to `'error'` and
     calls `finalize()` itself.
  7. `lifecycle.finalize()` is idempotent: best-effort `liveBroadcasts.transition(status:
     'complete')` (skipped if never reached `live`/`testing`) then `liveStreams.delete`. Errors
     from Google here are logged, not thrown — cleanup must not block `/stream/stop` from
     succeeding locally.

## 5. `StreamManager` integration

`StreamManager.start()` (`src/stream/streamManager.ts:49`) changes shape:

- Look up `destination.provider`, pick `CustomRtmpProvider` or `YoutubeProvider` (injected into
  `StreamManagerDeps` as a small `{ custom, youtube }` map or a `resolveProvider(provider)` fn —
  decide exact shape in plan).
- Replace the current inline `decrypt(destination.streamKeyEncrypted, ...)` + `rtmpUrl` read with
  `await provider.prepareSession(destination, meta)`.
- Store the returned `lifecycle` (if any) alongside the `StreamController` in the registry (the
  `Map<destinationId, StreamController>` becomes `Map<destinationId, { controller, lifecycle? }>`,
  or a small wrapper type — decide in plan).
- Call `lifecycle.onPushStarted()` right after `controller.start()` resolves (that's the point the
  first segment has been hooked up to the FIFO and the pusher is running).
- `StreamManager.stop()` calls `lifecycle?.finalize()` (awaited, errors swallowed/logged) after
  `controller.stop()`.
- An unexpected pusher exit (already surfaces as controller state `'error'`) must also trigger
  `lifecycle?.finalize()` — needs a hook from `StreamController`'s existing exit-handling path
  into `StreamManager` (currently `StreamController` doesn't call back into `StreamManager` at
  all; smallest change is `StreamManager` passing an `onError` callback into the controller, or
  polling controller state — pick the smaller diff in plan).
- `meta` (`title`/`description`/`privacyStatus`) is threaded through from the route handler
  (`POST /destinations/:id/stream/start` body) down to `StreamManager.start(destinationId,
  playlistId, meta)`.

`StreamController` itself is untouched — it already only knows about `rtmpUrl`/`streamKey`
strings via `createRtmpPusher`, never about where they came from.

## 6. Status API

`GET /destinations/:id/stream/status` response gains an optional `provider` field:

```json
{
  "state": "streaming",
  "currentTrack": "Track Name",
  "nextTrack": "Next Track",
  "provider": { "type": "youtube", "phase": "waitingForYoutube", "watchUrl": "https://youtube.com/watch?v=..." }
}
```

`provider` is omitted entirely for `custom` destinations. `StreamManager.status()` merges
`controller.status()` with `lifecycle?.phase()`/`lifecycle?.watchUrl()` when present.

## 7. Error handling

- `prepareSession` failing (bad/expired refresh token, Google API error, no available broadcast
  quota) → `/stream/start` returns the underlying error mapped to a 502/503 (exact mapping: plan
  decides), same as today's `ApiError` pattern. No `StreamController` is created in this case (the
  existing `try { controller.start() } catch { delete }` pattern extends naturally — `prepareSession`
  is called before the controller is even constructed).
- Health-check timeout while `waitingForYoutube`, or pusher dying at any point after
  `onPushStarted()` → best-effort `finalize()`, phase becomes `'error'`, visible via status;
  `StreamController`'s own state already goes to `'error'` through its existing path — the two
  errors are reported together but are otherwise independent.
- `DELETE /destinations/:id` for a `youtube` destination: after the existing "stop any running
  stream" step, also revoke the OAuth refresh token
  (`https://oauth2.googleapis.com/revoke`, best-effort, errors logged not thrown) before deleting
  the `YoutubeConnection` row via cascade.

## 8. Testing strategy

Follows the existing fake-dependency pattern (`CLAUDE.md` → Testing strategy):

- New `YoutubeApiClient` interface (thin wrapper: `createBroadcast`, `createStream`, `bind`,
  `transition`, `getStreamStatus`, `deleteStream`, `refreshAccessToken`, `getChannel`, `revoke`) —
  injected into `YoutubeProvider`, faked in unit tests exactly like `Spawner` is faked for ffmpeg.
  Real HTTP calls to Google never happen in `npm test`.
- `YoutubeProvider`, `CustomRtmpProvider`, the OAuth routes, and the `StreamManager` provider-
  selection logic are all unit-testable with fakes/plain objects, matching the
  `Pick<...>`-structural-subset pattern already used for `PlaylistRepository`/
  `DestinationRepository`/`TrackRepository`.
- `YoutubeConnection`'s repository (thin Prisma wrapper) is NOT unit-tested, matching
  `UserRepository`/`SessionRepository`/`DestinationRepository` — verified by manual smoke test
  with a real Postgres + real Google OAuth app (the user's own credentials) instead.
- End-to-end real-YouTube smoke testing (registering a live broadcast against a real channel) is
  manual/deferred, same status as the "real-ffmpeg smoke testing" already listed as a known
  follow-up in `CLAUDE.md`.

## Open questions for the implementation plan

These are intentionally left for `writing-plans` to pin down precisely rather than guessed here:

- Exact shape of the `state`-token store for the OAuth `start`→`callback` round trip (new table
  vs in-memory map vs reusing `Session`).
- Whether `googleOAuthClientId`/`googleOAuthClientSecret`/`appBaseUrl` are required at
  `loadConfig()` time (boot fails without them) or only validated when a YouTube route is first
  hit (lets `custom`-only deployments skip Google setup entirely).
- Exact Google OAuth scope string(s).
- Exact health-check polling interval/timeout for `waitingForYoutube`.
- Exact wiring for "pusher died unexpectedly" → `lifecycle.finalize()` (callback vs poll).
- HTTP status code mapping for `prepareSession` failures.
