# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Project overview

**super-dj** — a multi-tenant YouTube streamer. A Node.js/TypeScript service, running in Docker
on Linux, where each user uploads audio tracks, arranges them into playlists, registers one or
more stream destinations (RTMP URL + stream key), and starts/controls an independent live stream
per destination — all via a REST API, gated behind email/password auth.

## Architecture (as built)

The FIFO + MPEG-TS pipeline (not the concat-demuxer MVP) is used per active stream, one
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
- **Ownership checks.** Every track/playlist/destination/stream route verifies the resource
  belongs to the authenticated user: 404 if the resource doesn't exist, 403 if it exists but
  belongs to someone else. `StreamManager.start()` additionally checks the *playlist* belongs
  to the destination's owner. Ids referenced from a request **body** into the caller's own
  resource (`PUT /playlists/{id}/tracks`'s `trackIds`) are instead validated against the
  caller's own tracks and rejected with 400 — not 403/404 — so playlist membership can't leak
  which ids exist for other users.

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
  destinations/             destinationRepository.ts (Prisma), destinationRoutes.ts
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
                            StreamDestination) + migrations/
test/                       mirrors src/; unit tests only
assets/                     default cover + background images
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
`destinationRepository.ts`) are thin wrappers verified by manual smoke test with a real Postgres
(`docker compose up`), not unit tests — services that consume them (`StreamManager`,
`TrackUploadService`, route handlers) take `Pick<...>` structural subsets so they can be
unit-tested with plain-object fakes instead. Follow the existing fake-child / fake-repository
pattern rather than introducing a new mocking style.

## HTTP API

`POST /auth/{register,login,logout}`, `GET /auth/me`.

`POST /tracks` (multipart: `audio` file required, `cover` file optional, `name` optional),
`GET /tracks`, `DELETE /tracks/{id}`.

`POST /playlists`, `GET /playlists`, `GET /playlists/{id}`, `PUT /playlists/{id}/tracks`
(replaces the ordered track list), `DELETE /playlists/{id}`.

`POST /destinations` (`name`, `rtmpUrl`, `streamKey` — key is encrypted at rest and never
returned), `GET /destinations`, `DELETE /destinations/{id}`.

`POST /destinations/{id}/stream/{start,stop,pause,resume,next,previous,play}`,
`GET /destinations/{id}/stream/status` — all scoped to the destination's owner.

`GET /openapi.json`, `GET /docs` (Swagger UI).

## Development commands

```
npm install
npm run build          # tsc -p tsconfig.json
npm test               # jest (or npx jest)
npm start              # node dist/main.js
docker compose up --build
```

## Configuration

Required env vars: `DATABASE_URL`, `STREAM_KEY_ENCRYPTION_KEY` (32-byte hex key for AES-256-GCM;
never commit these).
Optional: `PORT` (3000), `SESSION_TTL_DAYS` (30), `UPLOADS_DIR` (`/data/uploads`), `FIFO_DIR`
(`/tmp`), `DEFAULT_COVER_PATH`, `BACKGROUND_IMAGE_PATH`.

RTMP URL and stream key are no longer global config — they're per-`StreamDestination`, supplied
by each user via `POST /destinations`.

## Known follow-ups (deliberately deferred)

`PORT` parsing is unvalidated; overlay elapsed time drifts from true playout position;
`stopCurrent()` SIGTERMs mid-TS-packet; the Docker image runs as root; `assets/` holds 1×1
placeholder PNGs; uploaded files are never cleaned up on track deletion (`DELETE /tracks/{id}`
removes the DB row but not `{UPLOADS_DIR}/{userId}/{trackId}/`); no per-user storage quota. Real-
ffmpeg smoke testing of segment concatenation has not been run in CI.

## Tooling

Developed with help from the [wshobson/agents](https://github.com/wshobson/agents) Claude Code
plugin marketplace. No repo-specific plugin is pinned.
