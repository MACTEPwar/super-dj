# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Project overview

**super-dj** — a multi-tenant YouTube streamer. A Node.js/TypeScript service, running in Docker
on Linux, where each user uploads audio tracks, arranges them into playlists, registers one or
more stream destinations (RTMP URL + stream key), and starts/controls an independent live stream
per destination — all via a REST API, gated behind email/password auth.

## Architecture (as built)

**Backend streaming pipeline.** The FIFO + MPEG-TS pipeline (not the concat-demuxer MVP) is used per active stream, one
independent pipeline per destination:

- **Two-process ffmpeg pipeline per destination.** A short-lived *producer* ffmpeg per segment
  (one track, or a silence/background "pause" segment) encodes to MPEG-TS on stdout; Node pipes
  that stdout into a named pipe (FIFO) unique to the destination
  (`{FIFO_DIR}/super-dj-stream-{destinationId}.fifo`). A single long-lived *pusher* ffmpeg reads
  the FIFO and `-c copy`s it to that destination's RTMP URL, so the YouTube connection survives
  every track change, skip, pause and seek.
- **Codec pinning matters.** Because the pusher uses `-c copy`, every segment must share identical
  codec parameters (H.264/yuv420p, fixed fps + GOP, AAC 44.1kHz stereo). These are pinned in
  `src/ffmpeg/segmentArgs.ts` — do not let a new segment builder diverge.
- **`StreamManager` owns one `StreamController` per active destination** (keyed by
  `destinationId`, in an in-memory `Map`). `StreamManager.start()` loads the playlist's track
  snapshot (used for playback and the overlay window — deliberately *not* re-read live, so
  editing a playlist mid-stream doesn't affect the running session) plus the destination-owning
  user's full track list (for `play`-by-name lookup, via the `LibraryLike` adapter in
  `streamController.ts`), decrypts the destination's stream key, and wires a fresh
  `StreamController`.
- **Auto-advance.** `StreamController` listens for the producer child's `exit` and advances the
  queue. A `segmentGeneration` counter distinguishes a natural end-of-track from a segment that was
  deliberately superseded (next/previous/pause/stop/start), preventing double-advance.
- **Async duration probe.** `buildOverlay`/`getAudioDurationSeconds` run `ffprobe` asynchronously
  (never `execFileSync`, which would block Node's entire event loop). Because feeding a track has
  an `await` point, `feedCurrentTrack` re-checks `segmentGeneration` *and* `state === 'streaming'`
  right after the probe resolves, before calling `feedTrack` — otherwise a command that arrived
  during the probe (next/previous/pause/stop, or the pusher dying) could feed a stale/superseded
  track. A track's `durationSeconds` is also probed once at upload time and cached on the `Track`
  row, so playlist listings don't need to re-probe.
- **Overlay.** Each track segment composites background + cover art + drawtext (title, elapsed/
  total, a playlist window) via `-filter_complex`.
- **Session states:** `idle` → `streaming` ⇄ `paused` → `idle`; an unexpected pusher exit sets
  `error`, from which `start()` recovers (it cleans up leftovers and recreates the FIFO).
- **Stream keys at rest.** `StreamDestination.streamKeyEncrypted` is AES-256-GCM-encrypted
  (`src/crypto/streamKeyCipher.ts`) with `STREAM_KEY_ENCRYPTION_KEY`; the plaintext key is never
  echoed back by the API (`toPublicDestination` omits it) and is only decrypted in-memory when a
  stream starts.
- **`StreamDestinationProvider` / `OAuthProviderAdapter` split.** How a destination is *connected*
  (OAuth2 authorization code flow, provider-generic via `OAuthProviderAdapter` — currently just
  `YoutubeOAuthAdapter`) is a separate concern from how a *stream session* is prepared for it
  (`StreamDestinationProvider` — `CustomRtmpProvider` for a manually-entered RTMP URL/key,
  `YoutubeProvider` for an OAuth-connected YouTube channel). `StreamManager` picks a
  `StreamDestinationProvider` by `destination.provider` and calls `prepareSession()`, which for
  YouTube creates an ephemeral `liveBroadcast` + `liveStream` *per streaming session* (not
  persisted — created fresh on `start()`, transitioned to `live` once the pusher's RTMP push is
  healthy, and torn down/deleted on `stop()` or an unexpected pusher exit) and returns the RTMP
  ingest URL/key StreamManager needs, plus a `DestinationLifecycle` handle for that polling/
  teardown. `OAuthConnection` (refresh token, external account id/name) is itself
  provider-generic — keyed by `destinationId` and a `provider` string — so a future OAuth-based
  provider doesn't need its own connection table.
- **Ownership checks.** Every track/playlist/destination/stream route verifies the resource
  belongs to the authenticated user: 404 if the resource doesn't exist, 403 if it exists but
  belongs to someone else. `StreamManager.start()` additionally checks the *playlist* belongs
  to the destination's owner. Ids referenced from a request **body** into the caller's own
  resource (`PUT /playlists/{id}/tracks`'s `trackIds`) are instead validated against the
  caller's own tracks and rejected with 400 — not 403/404 — so playlist membership can't leak
  which ids exist for other users.

**Frontend.** A separately-deployed React + Vite SPA (`frontend/`) served to browsers, talking to
the same backend API over CORS with credentialed cross-origin requests. Live stream status updates
(`StreamManager` emits `statusChanged` events) are delivered to the client via Server-Sent Events
(`GET /destinations/{destinationId}/stream/events`), eliminating polling overhead.

## Layout

```
src/
  main.ts                  entrypoint: config, listen, prisma.$connect(), SIGTERM/SIGINT shutdown
  server.ts                composition root (buildServer) + createSpawner (drains ffmpeg stderr)
  errors.ts                ApiError (status + message)
  config/env.ts             loadConfig() from environment
  api/                      app.ts (mounts all routers), errorHandler.ts, openapi.ts
  auth/                     authService.ts, authRoutes.ts, authMiddleware.ts (requireAuth),
                            userRepository.ts / sessionRepository.ts (Prisma), sessionCookie.ts,
                            passwordHash.ts (bcrypt hash/verify)
  tracks/                   trackRepository.ts (Prisma), trackUploadService.ts (multer file ->
                            {UPLOADS_DIR}/{userId}/{trackId}/, ffprobe duration cached on create),
                            trackRoutes.ts
  playlists/                playlistRepository.ts (Prisma, ordered PlaylistTrack join),
                            playlistRoutes.ts
  destinations/             destinationRepository.ts (Prisma), destinationRoutes.ts,
                            oauthConnectionRepository.ts / oauthStateRepository.ts (Prisma),
                            oauthProviderAdapter.ts (interface), oauthRoutes.ts (mounted at
                            /destinations/:provider/oauth), youtubeApiClient.ts (thin Google/
                            YouTube Data API v3 HTTP wrapper), youtubeOAuthAdapter.ts
                            (OAuthProviderAdapter for YouTube), streamDestinationProvider.ts
                            (interface + DestinationLifecyclePhase), customRtmpProvider.ts /
                            youtubeProvider.ts (StreamDestinationProvider impls)
  crypto/streamKeyCipher.ts AES-256-GCM encrypt/decrypt for stream keys at rest
  stream/                   streamManager.ts (per-destination StreamController registry),
                            streamController.ts (session state machine; LibraryLike adapter),
                            streamRoutes.ts (mounted at /destinations/:destinationId/stream),
                            types.ts
  playlist/                 queue.ts (cursor + insertNext), types.ts — shared by streamController
  ffmpeg/                   segmentArgs.ts / segmentFeeder.ts (producer), rtmpPusherArgs.ts /
                            rtmpPusher.ts (pusher), fifo.ts (mkfifo/unlink), duration.ts (ffprobe),
                            overlayText.ts (drawtext escaping), types.ts (Spawner, ChildProcessLike)
prisma/                     schema.prisma (User, Session, Track, Playlist, PlaylistTrack,
                            StreamDestination, OAuthConnection, OAuthState) + migrations/
test/                       mirrors src/; unit tests only
assets/                     default cover + background images
frontend/                   React + Vite SPA
  src/
    api/                    typed API client (fetch wrappers + type definitions)
    pages/                  route page components
    components/             shared UI components
    hooks/                  custom React hooks
```

**Persistence:** PostgreSQL via Prisma. `main.ts` calls `prisma.$connect()` at boot (fail fast)
and `$disconnect()` on shutdown. Sessions are opaque UUIDs stored in the `Session` table and
carried in an httpOnly cookie. Schema changes need a migration (`npx prisma migrate dev`) —
`prisma/migrations/` is committed and must stay in sync with `schema.prisma`. No local Docker
daemon is available in this dev environment, so migrations are generated against a temporary
Postgres on the remote host at `192.168.14.26` (passwordless SSH): stage `prisma/schema.prisma`,
the **existing** `prisma/migrations/` directory, and `package.json`/`package-lock.json` in a temp
dir on the remote host; spin up a throwaway `postgres:16-alpine` container on an isolated docker
network; run `npm ci && npx prisma migrate dev --name <name> --skip-generate` in a throwaway
`node:20-bookworm-slim` container on the same network (mounting the staged dir, `DATABASE_URL`
pointing at the postgres container by its container name) — `apt-get install -y openssl` first,
or Prisma's engine can't detect libssl in that image and errors out; copy the generated
`prisma/migrations/<timestamp>_<name>/` directory back into the repo; then tear down every
temporary container/network/temp-file on the remote host. Staging only `schema.prisma` without
the existing `migrations/` directory makes Prisma treat the throwaway database as historyless and
regenerate *every* table (including ones a real database already has) instead of an incremental
diff — always include the migration history. Never hand-write migration SQL.

**Testing strategy:** everything touching ffmpeg is injected as a `Spawner` /
`ChildProcessLike` fake — unit tests never spawn real ffmpeg (`test/server.test.ts` spawns a plain
`node -e` only to prove stderr is drained). Prisma-backed repositories (`userRepository.ts`,
`sessionRepository.ts`, `trackRepository.ts`, `playlistRepository.ts`,
`destinationRepository.ts`, `oauthConnectionRepository.ts`, `oauthStateRepository.ts`) are thin
wrappers verified by manual smoke test with a real Postgres
(`docker compose up`), not unit tests — services that consume them (`StreamManager`,
`TrackUploadService`, route handlers) take `Pick<...>` structural subsets so they can be
unit-tested with plain-object fakes instead. Follow the existing fake-child / fake-repository
pattern rather than introducing a new mocking style.

## HTTP API

`POST /auth/{register,login,logout}`, `GET /auth/me`.

`POST /tracks` (multipart: `audio` file required, `cover` file optional, `name` optional),
`GET /tracks`, `GET /tracks/{id}/cover`, `DELETE /tracks/{id}`.

`POST /playlists`, `GET /playlists`, `GET /playlists/{id}`, `PUT /playlists/{id}/tracks`
(replaces the ordered track list), `DELETE /playlists/{id}`.

`POST /destinations` (`name`, `rtmpUrl`, `streamKey` — key is encrypted at rest and never
returned), `GET /destinations`, `DELETE /destinations/{id}`.

`GET /destinations/{provider}/oauth/start` (returns an `authUrl` to open in a browser),
`GET /destinations/{provider}/oauth/callback` (the OAuth2 redirect target — exchanges the code
and creates the destination) — the OAuth2 connect flow for a provider-backed destination (e.g.
`youtube`), as an alternative to `POST /destinations` for manually-entered RTMP destinations.

`POST /destinations/{id}/stream/{start,stop,pause,resume,next,previous,play}`,
`GET /destinations/{id}/stream/status`, `GET /destinations/{id}/stream/events` — all scoped to the
destination's owner.
`POST .../stream/start` also accepts optional `title`/`description`/`privacyStatus` fields, used
by providers that create a live broadcast (e.g. YouTube) — ignored by `custom` destinations; it
400s on a missing/invalid `body.playlistId` as well as a non-string `title`/`description` or a
`privacyStatus` outside `'public'`/`'unlisted'`/`'private'`.

`GET /openapi.json`, `GET /docs` (Swagger UI).

## Development commands

Backend:
```
npm install
npm run build          # tsc -p tsconfig.json
npm test               # jest (or npx jest)
npm start              # node dist/main.js
docker compose up --build
```

Frontend:
```
cd frontend && npm install
npm run dev            # Vite dev server
npm test               # vitest
npm run build          # Vite build
```

## Configuration

Required env vars: `DATABASE_URL`, `STREAM_KEY_ENCRYPTION_KEY` (32-byte hex key for AES-256-GCM;
never commit these), `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `APP_BASE_URL`
(the app's own externally-reachable base URL, used to build the YouTube OAuth redirect URI —
`GOOGLE_OAUTH_CLIENT_ID`/`_SECRET` come from a Google Cloud Console OAuth client with the YouTube
Data API v3 enabled, an external, manual, one-time setup step), `FRONTEND_ORIGIN` (the frontend's
externally-reachable origin, used for CORS policy).
Optional: `PORT` (3000), `SESSION_TTL_DAYS` (30), `UPLOADS_DIR` (`/data/uploads`), `FIFO_DIR`
(`/tmp`), `DEFAULT_COVER_PATH`, `BACKGROUND_IMAGE_PATH`.

RTMP URL and stream key are no longer global config — they're per-`StreamDestination`, supplied
by each user via `POST /destinations`. The frontend's `VITE_API_BASE_URL` is a build-time
environment variable documented in `frontend/.env.example` (not a runtime env var — the frontend
is statically served after build).

## Known follow-ups (deliberately deferred)

`PORT` parsing is unvalidated; overlay elapsed time drifts from true playout position;
`stopCurrent()` SIGTERMs mid-TS-packet; the Docker image runs as root; `assets/` holds 1×1
placeholder PNGs; uploaded files are never cleaned up on track deletion (`DELETE /tracks/{id}`
removes the DB row but not `{UPLOADS_DIR}/{userId}/{trackId}/`); no per-user storage quota. Real-
ffmpeg smoke testing of segment concatenation has not been run in CI. A YouTube-connected
destination's access token is refreshed on every API call rather than cached against its
`expiresIn` (deliberate — avoids a whole class of expiry-timing bugs for streams that can run far
longer than a token's ~1 hour lifetime, at the cost of a few extra token-endpoint calls). Real
end-to-end YouTube API smoke testing (an actual channel going live via this app) has not been run,
matching the real-ffmpeg-smoke-testing caveat above. A YouTube destination's health-check timeout
(in `youtubeProvider.ts`) stops the YouTube-side broadcast but doesn't stop the local ffmpeg
pipeline, which keeps pushing to a dead ingest endpoint until the user calls `/stream/stop`
manually. A persistently failing `refreshAccessToken` (e.g. a revoked Google grant) makes the
health-check poll loop retry silently for the full 90s timeout instead of short-circuiting on an
auth-class error, and — since `finalize()` also needs a working token — can leave the ephemeral
YouTube `liveStream` undeleted. `OAuthState` rows for an abandoned `/oauth/start` (the user never
completes the consent flow) are never swept — they just sit until their `expiresAt` passes,
matching the pre-existing `Session` table's same lack of a sweep job. The OAuth callback's
state-row lookup-then-delete (`oauthStateRepository.findValid` then `deleteById`) isn't atomic —
two concurrent callbacks presenting the same valid `state` value could both pass and create two
destinations before either delete lands. Narrow (requires already holding a valid single-use
state), but a compare-and-delete-returning-count check would close it. `OAuthConnection` has no
uniqueness constraint on `(provider, externalAccountId)` — a user can connect the same YouTube
channel to multiple `StreamDestination`s, which would then compete over the same channel's
broadcasts if both were streamed to at once. `onError` (the pusher-crash-triggers-finalize hook)
resolves the destination's lifecycle to finalize by `destinationId` alone. In the narrow case where
a crashed session's exit event is processed after a subsequent `start()` for the same destination
has already completed and registered a new lifecycle, this could finalize the new (healthy)
session's YouTube broadcast instead of the crashed one's. `RtmpPusher.stop()`'s existing
`stopRequested` guard makes the ordinary stop path safe; this only matters for a genuine crash
racing a fast restart. The OAuth-connect popup's `postMessage` fallback (polling `popup.closed`) means a connect can take up to 500ms to be detected if the message itself is lost — a timing-dependent edge case. The playlist editor's drag-and-drop reordering has no automated test coverage (documented test-scope decision — see Task 11 brief). No e2e/Playwright coverage exists for any frontend flow.

## Tooling

Developed with help from the [wshobson/agents](https://github.com/wshobson/agents) Claude Code
plugin marketplace. No repo-specific plugin is pinned.
