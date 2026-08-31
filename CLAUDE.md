# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Project overview

**super-dj** — an autonomous YouTube streamer. A Node.js/TypeScript service that runs in Docker
on Linux, continuously streams a local library of audio files to YouTube Live over one
never-interrupted RTMP connection, and is controlled externally via a REST API (start/stop/pause/
resume/next/previous/play-by-name).

## Architecture (as built)

The concat-demuxer MVP was skipped; the implementation is the FIFO + MPEG-TS design.

- **Two-process ffmpeg pipeline.** A short-lived *producer* ffmpeg per segment (one track, or a
  silence/background "pause" segment) encodes to MPEG-TS on stdout; Node pipes that stdout into a
  named pipe (FIFO). A single long-lived *pusher* ffmpeg reads the FIFO and `-c copy`s it to RTMP,
  so the YouTube connection survives every track change, skip, pause and seek.
- **Codec pinning matters.** Because the pusher uses `-c copy`, every segment must share identical
  codec parameters (H.264/yuv420p, fixed fps + GOP, AAC 44.1kHz stereo). These are pinned in
  `src/ffmpeg/segmentArgs.ts` — do not let a new segment builder diverge.
- **Auto-advance.** `StreamController` listens for the producer child's `exit` and advances the
  queue. A `segmentGeneration` counter distinguishes a natural end-of-track from a segment that was
  deliberately superseded (next/previous/pause/stop/start), preventing double-advance.
- **Async duration probe.** `buildOverlay`/`getAudioDurationSeconds` run `ffprobe` asynchronously
  (never `execFileSync` — that used to block Node's entire event loop on every start/resume/next/
  previous, freezing the whole server for the probe's duration). Because feeding a track now has an
  `await` point, `feedCurrentTrack` re-checks `segmentGeneration` *and* `state === 'streaming'`
  right after the probe resolves, before calling `feedTrack` — otherwise a command that arrived
  during the probe (next/previous/pause/stop, or the pusher dying) could feed a stale/superseded
  track.
- **Overlay.** Each track segment composites background + cover art + drawtext (title, elapsed/
  total, a playlist window) via `-filter_complex`.
- **Session states:** `idle` → `streaming` ⇄ `paused` → `idle`; an unexpected pusher exit sets
  `error`, from which `start()` recovers (it cleans up leftovers and recreates the FIFO).

## Layout

```
src/
  main.ts                  entrypoint: config, library scan, listen, SIGTERM/SIGINT shutdown
  server.ts                composition root (buildServer) + createSpawner (drains ffmpeg stderr)
  errors.ts                ApiError (status + message)
  config/env.ts            loadConfig() from environment
  api/                     app.ts, streamRoutes.ts, libraryRoutes.ts, errorHandler.ts, openapi.ts
  playlist/                library.ts (disk scan), queue.ts (cursor + insertNext), types.ts
  ffmpeg/                  segmentArgs.ts / segmentFeeder.ts (producer), rtmpPusherArgs.ts /
                           rtmpPusher.ts (pusher), fifo.ts (mkfifo/unlink), duration.ts (ffprobe),
                           overlayText.ts (drawtext escaping), types.ts (Spawner, ChildProcessLike)
  stream/streamController.ts   session state machine, wires feeder + pusher + queue
test/                      mirrors src/; unit tests only
assets/                    default cover + background images
```

**Testing strategy:** everything touching ffmpeg is injected as a `Spawner` /
`ChildProcessLike` fake — unit tests never spawn real ffmpeg (`test/server.test.ts` spawns a plain
`node -e` only to prove stderr is drained). Follow the existing fake-child pattern rather than
introducing a new mocking style.

## HTTP API

`POST /stream/{start,stop,pause,resume,next,previous,play}`, `GET /stream/status`,
`GET /library`, `POST /library/rescan`, `GET /openapi.json`, `GET /docs` (Swagger UI).

## Development commands

```
npm install
npm run build          # tsc -p tsconfig.json
npm test               # jest (or npx jest)
npm start              # node dist/main.js
docker compose up --build
```

## Configuration

Required env vars: `RTMP_URL`, `STREAM_KEY` (never commit these).
Optional: `PORT` (3000), `AUDIO_DIR` (`/data/audio`), `FIFO_PATH` (`/tmp/super-dj-stream.fifo`),
`DEFAULT_COVER_PATH`, `BACKGROUND_IMAGE_PATH`.

## Known follow-ups (deliberately deferred)

Duplicate track names by basename; `Library.list()` returns a mutable reference; `PORT` parsing is
unvalidated; overlay elapsed time drifts from true playout position; `stopCurrent()` SIGTERMs
mid-TS-packet; the Docker image runs as root; `assets/` holds 1×1 placeholder PNGs. Real-ffmpeg
smoke testing of segment concatenation has not been run in CI.

## Tooling

Developed with help from the [wshobson/agents](https://github.com/wshobson/agents) Claude Code
plugin marketplace. No repo-specific plugin is pinned.
