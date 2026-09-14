# Local-First Streaming — Phase A (local stream + preview) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a logged-in user start ONE local stream (playlist + overlay template) that encodes into a
private MediaMTX container and watch it back in the browser through an authenticated HLS proxy — with
zero destinations involved anywhere in the path.

**Architecture:** A new `mediamtx` compose service with **no published ports** receives the existing
`PersistentEncoder`'s RTMP push at a per-session random path, and gates every publish/read attempt
through an `authHTTP` callback into a second, unpublished Express app owned by this backend
(in-memory path→secrets map, fail-closed). Scene resolution (playlist/template/tracks/gif probing/
canvas placement/overlay rendering) is extracted out of `StreamManager.start()` into a reusable
`buildStreamScene()`; a new `LocalStreamManager` keyed by `userId` composes that scene with a
`StreamController` whose encoder points at the minted MediaMTX publish URL. The browser never names a
MediaMTX path: `GET /local-stream/preview/index.m3u8` resolves the authenticated user's own path
server-side and streams MediaMTX's HLS back through the backend. The existing
`/destinations/{id}/stream/*` and `/stream-sessions/*` APIs and their frontend keep working untouched.

**Tech Stack:** TypeScript/Node 20, Express 4, Prisma/Postgres (no schema change in this phase),
Jest + supertest (backend), React 18 + Vite + Vitest + Testing Library (frontend), Docker Compose,
MediaMTX `bluenviron/mediamtx:1.21.0`, `hls.js` (new frontend dependency), `js-yaml` (new backend
devDependency, config-invariant tests only).

**Spec:** `docs/superpowers/specs/2026-09-14-local-first-streaming-design.md` — read it in full before
starting. This plan implements **only** its "Phase A — local stream + preview, zero destinations"
checkpoint. `DestinationForward`, `RelayProcess`, destination toggles (Phase B) and the deletion of
`streamRoutes.ts`/`StreamSessionManager`/`SessionOverlayCache` plus the frontend migration (Phase C)
are explicitly **out of scope** — do not build them, but do not build anything that forecloses them
either (see Global Constraints).

## Global Constraints

- **The `mediamtx` service must never get a `ports:` entry.** This is the spec's "Layer 0" — the
  actual trust boundary; everything else is defense in depth. Task 1 adds an automated test that
  fails if anyone adds one. Do not delete or weaken that test.
- **MediaMTX image is pinned to an exact version: `bluenviron/mediamtx:1.21.0`** (released
  2026-09-05, the latest release at the time of writing). Never use `:latest`. The behaviours this
  plan depends on were read out of the v1.21.0 source tree; re-verify them if the pin ever moves.
- **Verified against MediaMTX v1.21.0 source, overriding the spec's assumption:** RTMP credentials
  are read from **query parameters only** (`internal/servers/rtmp/conn.go` does
  `query := c.rconn.URL.Query()` then `User: query.Get("user"), Pass: query.Get("pass")` in both
  `runPublish()` and `runRead()`). URL *userinfo* form (`rtmp://user:pass@host/...`) is documented
  for RTSP, **not** RTMP. The spec's "zero signature change to `buildPersistentEncoderArgs`" still
  holds, but via the query-string form: `rtmpUrl = rtmp://mediamtx:1935/live`,
  `streamKey = <pathToken>?user=pub&pass=<publishSecret>`, so the existing
  `` `${rtmpUrl}/${streamKey}` `` concatenation produces
  `rtmp://mediamtx:1935/live/<token>?user=pub&pass=<secret>`.
  **`src/ffmpeg/persistentEncoderArgs.ts` and `src/ffmpeg/persistentEncoder.ts` are not modified by
  this plan at all.**
- **Verified against MediaMTX v1.21.0 source, filling a spec gap:** `internal/auth/manager.go` does
  `httpClient.Post(m.HTTPAddress, "application/json", ...)` — **it sets no custom headers and
  substitutes no placeholders in `authHTTPAddress`.** The spec's "shared-secret header" is therefore
  impossible; this plan carries the shared secret as a path segment of `authHTTPAddress` instead
  (`http://super-dj:3001/internal/mediamtx-auth/<secret>`), compared with `timingSafeEqual`. Same
  threat model, different carrier — document it in code comments wherever it appears.
- **`authHTTP` is fail-closed.** MediaMTX allows only on a 2xx (`if res.StatusCode < 200 ||
  res.StatusCode > 299` → failure). Every non-allow path in our endpoint must answer 401, and an
  unreachable/crashed backend must therefore deny by default — never add a bypass.
- **The browser never supplies a MediaMTX path, token, or credential.** The preview route resolves
  the path from `req.user.id` server-side. A route that accepts a path/token parameter is an IDOR —
  this is the single most important rule in the security section of the spec.
- **`authHTTPExclude: []`** — exclude nothing. (MediaMTX v1.20.1 changed this default to empty; set
  it explicitly anyway so a future default change cannot silently open a hole.)
- **One local stream per user, keyed by `userId`.** Not per destination, not per session row.
- **Phase A has no destination concept anywhere in the new code.** No `StreamDestinationProvider`,
  no `prepareSession()`, no `DestinationLifecycle`, no `BroadcastMeta`
  (`title`/`description`/`privacyStatus`/`latencyPreference`) in any new route or manager.
- **Phase B compatibility (do not paint into a corner):** `LocalRelayTarget.create()` must mint the
  **read** credential and read RTMP URL now even though nothing consumes them in Phase A —
  `RelayProcess` will. `LocalStreamManager` must key its registry by `userId` and keep its
  per-user entry a struct (not a bare `StreamController`) so a `forwards: Map<destinationId,
  DestinationForward>` field can be added without a rewrite. Publish and read secrets must be
  **different values**, so a leaked read credential can never publish over the path.
- **`ffmpeg -reconnect*` flags do not apply to RTMP inputs** (HTTP(S) only). Nothing in Phase A
  relies on them; do not add them.
- **Testing style:** never spawn real ffmpeg or a real MediaMTX in unit tests. Follow the existing
  fake-`Spawner`/fake-child/fake-repository patterns (`test/stream/streamController.test.ts`,
  `test/stream/streamManager.test.ts`, `test/stream/streamRoutes.test.ts`,
  `test/stream/streamEvents.test.ts`). Inject the HTTP client for the HLS proxy as a fake rather
  than adding a mocking library.
- **Locale files stay key-identical** across `en.json` / `ru.json` / `uk.json`, same key order.
- **Commit trailer:** end every commit message with the `Co-Authored-By:` line your own session's
  instructions specify. The trailer shown in the commit steps below is a placeholder.

### Decisions this plan makes that the spec deferred to it

| Spec open question | Decision made here |
| --- | --- |
| #7 idle-stream cost control | A hard **12-hour** max session duration (`MAX_LOCAL_STREAM_HOURS`, default 12), auto-stopping the stream. No viewer-count idle timeout: MediaMTX's control API is the only viewer-count signal and it is disabled by Layer 0 — enabling it to save CPU would trade the security boundary for an optimisation. Revisit in a later phase if needed. |
| #8 per-host concurrency cap | **10** simultaneous local streams per host (`MAX_CONCURRENT_LOCAL_STREAMS`, default 10); an 11th `start()` gets `429`. Each stream is one libx264 720p30 `ultrafast` encode, which is what the number is sized against. |
| #5 preview latency | `hlsVariant: mpegts`, `hlsSegmentCount: 7`, `hlsSegmentDuration: 1s`, `hlsAlwaysRemux: no`. Plain HLS, widest client support, on-demand muxing so an unwatched stream costs no HLS work. Low-latency HLS would need the proxy to forward `_HLS_msn`/`_HLS_part` blocking-request query parameters — deliberately not built. |

### Where the new frontend UI lives, and why

The local stream gets its **own page at `/local-stream` with its own sidebar entry**, rather than
being folded into `StreamSessionPanel.tsx` or `StartStreamDrawer.tsx`. For the length of Phase A the
two things are genuinely different objects: a `StreamSession` is a persisted row fanning one
playlist out to N destinations and carrying YouTube broadcast metadata, while a local stream is a
single in-memory per-account encode with no destination, no broadcast and no id in any of its URLs.
Merging them now would produce one component rendering two mutually exclusive shapes behind
conditionals — in files Phase C is going to rewrite anyway — and would drag the old
`/stream-sessions/*` flow into this phase's blast radius, which the spec's phasing explicitly rules
out ("Existing `/stream-sessions/*` and `/destinations/{id}/stream/*` keep working, untouched,
throughout this phase"). Keeping them apart also preserves the revert story: back Phase A out and
only new files disappear. Phase C then deletes `Streams.tsx`/`StreamSessionPanel.tsx` and promotes
this page — with destination toggles added by Phase B — to being the single stream UI.

### Noted while researching, for Phase B only — not actionable here

MediaMTX **v1.20.0 added native stream forwarding** (`forward destinations` per path config), which
post-dates the spec's "Why not let MediaMTX itself forward to destinations" section. Every other
argument in that section still stands unchanged (plaintext stream keys in MediaMTX's config, no
in-process push-started/died callbacks, orphaned pushes resurrected on a MediaMTX restart, testability).
Flagging it so Phase B's author knows the option exists and why it is still being declined — **do not
act on it in Phase A.**

---

## File Structure

### Backend — created

| File | Single responsibility |
| --- | --- |
| `docker/mediamtx.yml` | The MediaMTX config: every non-RTMP/HLS surface off, `authMethod: http`, one regex path, no `all_others`. |
| `src/stream/localRelayTarget.ts` | Mint one local-stream's MediaMTX path token + publish/read credentials and every URL derived from them. The only place the credential/path scheme lives. |
| `src/stream/mediaMtxAuth.ts` | `MediaMtxAuthRegistry` (in-memory path→secrets map + the allow/deny decision) and `createMediaMtxAuthApp` (the unpublished Express app MediaMTX POSTs to). |
| `src/stream/streamScene.ts` | `buildStreamScene()` — everything a stream needs that has no destination concept: playlist/template/track resolution, gif probing, canvas placement, the `buildOverlay` closure, and the CanvasFeeder/AudioRelay/PersistentEncoder/PulseVisualizer factories. |
| `src/stream/localStreamManager.ts` | One `StreamController` + one minted relay session per `userId`; concurrency cap, duration cap, auth-registry lifecycle, `statusChanged` events. |
| `src/stream/localStreamPreviewRoutes.ts` | The authenticated HLS proxy (`index.m3u8` + `:file`), filename sanitising, and the injectable `PreviewFetch` seam. |
| `src/stream/localStreamRoutes.ts` | `/local-stream/*` control + status + SSE routes; mounts the preview router. |
| `test/infra/mediamtxConfig.test.ts` | Asserts the compose/MediaMTX security invariants (no published ports, control surfaces off, regex path, no catch-all). |
| `test/stream/localRelayTarget.test.ts` | URL/credential shapes minted by `LocalRelayTarget`. |
| `test/stream/mediaMtxAuth.test.ts` | Allow/deny matrix of the auth registry and endpoint. |
| `test/stream/streamScene.test.ts` | The extraction's own contract (ownership errors, template defaulting, canvas placement, overlay fallback). |
| `test/stream/localStreamManager.test.ts` | Per-user lifecycle, caps, registry register/unregister, encoder target. |
| `test/stream/localStreamPreviewRoutes.test.ts` | Proxy auth, sanitising, header/status pass-through. |
| `test/stream/localStreamRoutes.test.ts` | Control-route validation and manager delegation. |
| `test/stream/localStreamEvents.test.ts` | The `/local-stream/events` SSE stream. |

### Backend — modified

| File | Change |
| --- | --- |
| `docker-compose.yml` | Add the `mediamtx` service; add the new env vars + `depends_on` to `super-dj`. |
| `package.json` | Add `js-yaml` + `@types/js-yaml` devDependencies. |
| `src/config/env.ts` | Four new MediaMTX settings + two new cap settings. |
| `src/stream/streamManager.ts` | Delegate scene resolution to `buildStreamScene()` (behaviour-preserving); the destination half stays. |
| `src/server.ts` | Construct `LocalRelayTarget`/`MediaMtxAuthRegistry`/`LocalStreamManager`, `createPreviewFetch()`, and return the MediaMTX auth app. |
| `src/main.ts` | Listen on the MediaMTX auth port; close it on shutdown. |
| `src/api/app.ts` | Mount `/local-stream`. |
| `src/api/openapi.ts` | Document the `/local-stream/*` paths. |
| `test/api/openapi.test.ts` | New `createApp` deps in the test helper. |
| `test/server.test.ts` | New `AppConfig` fields in the fixture. |
| `test/config/env.test.ts` | Coverage for the new settings. |
| `CLAUDE.md` | Architecture/HTTP-API/Configuration/known-follow-up updates. |

### Frontend — created

| File | Single responsibility |
| --- | --- |
| `frontend/src/api/localStream.ts` | Typed client for `/local-stream/*` plus the preview and SSE URLs. |
| `frontend/src/hooks/useLocalStreamStatus.ts` | Initial fetch + SSE-driven query cache updates. |
| `frontend/src/components/HlsPlayer.tsx` | `<video>` + hls.js, credentialed requests, native-HLS fallback, network-error retry. |
| `frontend/src/pages/LocalStream.tsx` | The page: start form, transport controls, embedded preview. |
| `frontend/src/api/localStream.test.ts`, `frontend/src/hooks/useLocalStreamStatus.test.tsx`, `frontend/src/components/HlsPlayer.test.tsx`, `frontend/src/pages/LocalStream.test.tsx` | Tests for each of the above. |

### Frontend — modified

| File | Change |
| --- | --- |
| `frontend/package.json` | Add `hls.js`. |
| `frontend/src/App.tsx` | Route `/local-stream`. |
| `frontend/src/components/Sidebar.tsx` | Nav link. |
| `frontend/src/i18n/locales/{en,ru,uk}.json` | New `localStream` section. |

---
### Task 1: MediaMTX container and its security invariants

**Files:**
- Create: `docker/mediamtx.yml`
- Create: `test/infra/mediamtxConfig.test.ts`
- Modify: `docker-compose.yml:7-25` (the `super-dj` service — new env vars and `depends_on`) and
  insert a new `mediamtx` service before `postgres:` (currently line 26)
- Modify: `package.json:23-38` (devDependencies)

**Interfaces:**
- Consumes: nothing.
- Produces: a compose service named `mediamtx` reachable on the compose network as
  `rtmp://mediamtx:1935` and `http://mediamtx:8888`, authenticating every publish/read against
  `$MTX_AUTHHTTPADDRESS`; and the env contract the backend reads in Task 8
  (`MEDIAMTX_RTMP_URL`, `MEDIAMTX_HLS_URL`, `MEDIAMTX_AUTH_SECRET`, `MEDIAMTX_AUTH_PORT`,
  `MAX_CONCURRENT_LOCAL_STREAMS`, `MAX_LOCAL_STREAM_HOURS`).

- [ ] **Step 1: Add the YAML parser used only by the invariant test**

```bash
npm install --save-dev js-yaml@^4.1.0 @types/js-yaml@^4.0.9
```

- [ ] **Step 2: Write the failing test**

Create `test/infra/mediamtxConfig.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest test/infra/mediamtxConfig.test.ts`
Expected: FAIL — `ENOENT ... docker/mediamtx.yml`.

- [ ] **Step 4: Write `docker/mediamtx.yml`**

```yaml
# MediaMTX configuration for super-dj's local-first streaming pipeline.
#
# SECURITY — this file plus docker-compose.yml's `mediamtx` service ARE the multi-tenancy boundary.
# See docs/superpowers/specs/2026-09-14-local-first-streaming-design.md, "Security model".
#   Layer 0: the service publishes NO ports (docker-compose.yml) and every control/extra surface is
#            off below. Never add a `ports:` entry "just to check if it's reachable" —
#            test/infra/mediamtxConfig.test.ts fails if you do.
#   Layer 1: exactly one regex path, minted fresh per local-stream start, and no all_others.
#   Layer 2: authMethod http — the backend decides every publish/read from an in-memory map, so a
#            stopped session is revoked instantly with no config reload.
logLevel: info
logDestinations: [stdout]

# --- Layer 0 -----------------------------------------------------------------------------------
# NOTE: `false`/`true`, not `no`/`yes` — js-yaml (this repo's config-invariant test, and MediaMTX's
# own Go YAML decoder) only resolves booleans from true/false forms; `no`/`yes` parse as the plain
# strings 'no'/'yes', which MediaMTX's typed config would reject at startup as a type mismatch.
api: false
metrics: false
pprof: false
playback: false
rtsp: false
webrtc: false
srt: false
rtmp: true
hls: true

rtmpAddress: :1935
rtmpEncryption: "no"

# --- HLS ---------------------------------------------------------------------------------------
# mpegts (not the lowLatency default): plain HLS, widest client support, no _HLS_msn/_HLS_part
# blocking-request query parameters for the backend proxy to forward. Real glass-to-glass latency
# is governed by keyframe interval, not hlsSegmentDuration: buildPersistentEncoderArgs emits
# `-g fps*2` (an IDR every 2s — see persistentEncoderArgs.ts), and HLS can only cut a segment on a
# keyframe, so segments come out ~2s regardless of the 1s value below. ~4-6s glass-to-glass is
# 2-3 segments of buffering at that real ~2s size. Changing hlsSegmentDuration alone will not move
# this number — the encoder's `-g` is the actual latency knob.
# hlsAlwaysRemux: false -> the muxer only exists while someone is actually previewing.
# hlsAllowOrigin: '' -> nothing talks to this server from a browser; only the backend proxy does,
# server-to-server, so no cross-origin access is ever needed here (MediaMTX's parameter is
# singular and a string, not the list shape `hlsAllowOrigins: []` might suggest).
hlsAddress: :8888
hlsVariant: mpegts
hlsSegmentCount: 7
hlsSegmentDuration: 1s
hlsAlwaysRemux: false
hlsAllowOrigin: ''
hlsMuxerCloseAfter: 60s

# --- Layer 2 -----------------------------------------------------------------------------------
# authHTTPAddress is deliberately EMPTY here: it carries a shared secret as a path segment and is
# supplied at runtime via the MTX_AUTHHTTPADDRESS environment variable (docker-compose.yml), so the
# secret never lands in a committed file. MediaMTX refuses to start with authMethod: http and no
# address — which is the correct fail-closed behaviour if the variable is ever missing.
authMethod: http
authHTTPAddress:
authHTTPExclude: []

# --- Paths -------------------------------------------------------------------------------------
# sourceOnDemand/record: `false`/`false`, not `no`/`no` — same js-yaml/MediaMTX boolean pitfall as
# the Layer 0 block above (this exact key pair was missed in an earlier pass and is exactly the
# kind of inconsistency that pitfall predicts: fixed at the top of this file, missed further down).
pathDefaults:
  source: publisher
  sourceOnDemand: false
  record: false

paths:
  # One local stream per user; the token is 128 random bits minted per START (not per user), so a
  # leaked path from an earlier session is worthless once that session ends. No all_others entry:
  # anything that is not this shape is rejected outright.
  "~^live/[0-9a-f]{32}$": {}
```

- [ ] **Step 5: Add the `mediamtx` service and the backend's new env to `docker-compose.yml`**

Insert this block between the `super-dj` service (ends at line 25, `restart: unless-stopped`) and
`postgres:` (line 26):

```yaml
  # SECURITY: no `ports:` entry, ever — see docker/mediamtx.yml's header and
  # test/infra/mediamtxConfig.test.ts. Reachable only as `mediamtx` on the compose network.
  # Pinned to an exact version: a moving tag could change auth or HLS behaviour under us, and this
  # one container is a shared single point of failure for every tenant's local stream.
  mediamtx:
    image: bluenviron/mediamtx:1.21.0
    environment:
      # Carries the shared secret as a path segment: MediaMTX sets no custom headers on its auth
      # POST (verified in internal/auth/manager.go), so a header-borne secret is not possible.
      MTX_AUTHHTTPADDRESS: http://super-dj:3001/internal/mediamtx-auth/${MEDIAMTX_AUTH_SECRET}
    volumes:
      - ./docker/mediamtx.yml:/mediamtx.yml:ro
    mem_limit: 512m
    restart: unless-stopped
```

Then, inside the existing `super-dj` service's `environment:` map (lines 12-19), append:

```yaml
      MEDIAMTX_RTMP_URL: rtmp://mediamtx:1935
      MEDIAMTX_HLS_URL: http://mediamtx:8888
      MEDIAMTX_AUTH_SECRET: ${MEDIAMTX_AUTH_SECRET}
      MEDIAMTX_AUTH_PORT: "3001"
```

`MEDIAMTX_AUTH_PORT` is quoted deliberately: unquoted, YAML resolves `3001` as a number, and every
consumer of `process.env.MEDIAMTX_AUTH_PORT` (including the test right below) expects a string, as
every other env var does.

and add `mediamtx` to its `depends_on` (currently lines 22-24), so the block reads:

```yaml
    depends_on:
      postgres:
        condition: service_healthy
      mediamtx:
        condition: service_started
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx jest test/infra/mediamtxConfig.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 7: Commit**

```bash
git add docker/mediamtx.yml docker-compose.yml test/infra/mediamtxConfig.test.ts package.json package-lock.json
git commit -m "$(cat <<'EOF'
feat: add a locked-down MediaMTX container for local-first streaming

No published ports, every control/extra surface disabled, one regex path with
no catch-all, and authHTTP pointed at the backend. The invariant test fails if
any of that is ever silently undone.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `LocalRelayTarget` — minting a session's MediaMTX path and credentials

**Files:**
- Create: `src/stream/localRelayTarget.ts`
- Test: `test/stream/localRelayTarget.test.ts`

**Interfaces:**
- Consumes: nothing (pure, `crypto.randomBytes` only, both generators injectable).
- Produces:
  ```typescript
  export const LOCAL_RELAY_PUBLISH_USER = 'pub';
  export const LOCAL_RELAY_READ_USER = 'sub';

  export interface LocalRelaySession {
    userId: string;
    pathToken: string;          // 32 lowercase hex chars
    path: string;               // `live/${pathToken}` — exactly what MediaMTX reports as `path`
    publishSecret: string;
    readSecret: string;
    publishRtmpUrl: string;     // `${rtmpBaseUrl}/live`      -> PersistentEncoder's `rtmpUrl`
    publishStreamKey: string;   // `${pathToken}?user=pub&pass=${publishSecret}` -> its `streamKey`
    readRtmpUrl: string;        // full URL for Phase B's RelayProcess input
    hlsBaseUrl: string;         // `${hlsBaseUrl}/live/${pathToken}` (no trailing slash)
    readAuthorization: string;  // `Basic base64('sub:<readSecret>')` for the HLS proxy
  }

  export interface LocalRelayTargetDeps {
    rtmpBaseUrl: string;
    hlsBaseUrl: string;
    generateToken?: () => string;
    generateSecret?: () => string;
  }

  export class LocalRelayTarget {
    constructor(deps: LocalRelayTargetDeps);
    create(userId: string): LocalRelaySession;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `test/stream/localRelayTarget.test.ts`:

```typescript
import { LocalRelayTarget, LOCAL_RELAY_PUBLISH_USER, LOCAL_RELAY_READ_USER } from '../../src/stream/localRelayTarget';

function fixed(base: Partial<{ token: string; secrets: string[] }> = {}) {
  const secrets = [...(base.secrets ?? ['pubsecret', 'readsecret'])];
  return new LocalRelayTarget({
    rtmpBaseUrl: 'rtmp://mediamtx:1935',
    hlsBaseUrl: 'http://mediamtx:8888',
    generateToken: () => base.token ?? 'a'.repeat(32),
    generateSecret: () => secrets.shift() ?? 'exhausted',
  });
}

describe('LocalRelayTarget', () => {
  it('mints a path of the exact shape MediaMTX\'s regex path accepts', () => {
    const session = new LocalRelayTarget({ rtmpBaseUrl: 'rtmp://mediamtx:1935', hlsBaseUrl: 'http://mediamtx:8888' }).create('user-1');
    expect(session.pathToken).toMatch(/^[0-9a-f]{32}$/);
    expect(session.path).toBe(`live/${session.pathToken}`);
  });

  // The whole point of the "zero signature change" claim: buildPersistentEncoderArgs concatenates
  // `${rtmpUrl}/${streamKey}`, and MediaMTX v1.21.0 reads RTMP credentials from the QUERY STRING
  // (internal/servers/rtmp/conn.go: query.Get("user")/query.Get("pass")), not from URL userinfo.
  it('splits the publish URL so the existing rtmpUrl/streamKey concatenation yields a credentialed URL', () => {
    const session = fixed().create('user-1');
    expect(session.publishRtmpUrl).toBe('rtmp://mediamtx:1935/live');
    expect(session.publishStreamKey).toBe(`${'a'.repeat(32)}?user=pub&pass=pubsecret`);
    expect(`${session.publishRtmpUrl}/${session.publishStreamKey}`)
      .toBe(`rtmp://mediamtx:1935/live/${'a'.repeat(32)}?user=pub&pass=pubsecret`);
  });

  it('mints a read credential that differs from the publish one, so a leaked reader can never publish', () => {
    const session = fixed().create('user-1');
    expect(session.publishSecret).toBe('pubsecret');
    expect(session.readSecret).toBe('readsecret');
    expect(session.readSecret).not.toBe(session.publishSecret);
    expect(session.readRtmpUrl).toBe(`rtmp://mediamtx:1935/live/${'a'.repeat(32)}?user=sub&pass=readsecret`);
  });

  it('exposes the HLS base URL and a Basic credential for the backend-side preview proxy', () => {
    const session = fixed().create('user-1');
    expect(session.hlsBaseUrl).toBe(`http://mediamtx:8888/live/${'a'.repeat(32)}`);
    expect(session.readAuthorization).toBe(`Basic ${Buffer.from('sub:readsecret').toString('base64')}`);
  });

  it('normalises trailing slashes on both base URLs', () => {
    const target = new LocalRelayTarget({
      rtmpBaseUrl: 'rtmp://mediamtx:1935/', hlsBaseUrl: 'http://mediamtx:8888/',
      generateToken: () => 'b'.repeat(32), generateSecret: () => 's',
    });
    const session = target.create('user-1');
    expect(session.publishRtmpUrl).toBe('rtmp://mediamtx:1935/live');
    expect(session.hlsBaseUrl).toBe(`http://mediamtx:8888/live/${'b'.repeat(32)}`);
  });

  it('carries the owning userId and uses the agreed usernames', () => {
    const session = fixed().create('user-42');
    expect(session.userId).toBe('user-42');
    expect(LOCAL_RELAY_PUBLISH_USER).toBe('pub');
    expect(LOCAL_RELAY_READ_USER).toBe('sub');
  });

  it('mints a different token on every create, so a path never outlives its session', () => {
    const target = new LocalRelayTarget({ rtmpBaseUrl: 'rtmp://mediamtx:1935', hlsBaseUrl: 'http://mediamtx:8888' });
    expect(target.create('user-1').pathToken).not.toBe(target.create('user-1').pathToken);
  });

  it('mints secrets containing only URL-safe characters (they travel in an RTMP query string)', () => {
    const target = new LocalRelayTarget({ rtmpBaseUrl: 'rtmp://mediamtx:1935', hlsBaseUrl: 'http://mediamtx:8888' });
    const session = target.create('user-1');
    expect(session.publishSecret).toMatch(/^[0-9a-f]{48}$/);
    expect(session.readSecret).toMatch(/^[0-9a-f]{48}$/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest test/stream/localRelayTarget.test.ts`
Expected: FAIL — `Cannot find module '../../src/stream/localRelayTarget'`.

- [ ] **Step 3: Write the implementation**

Create `src/stream/localRelayTarget.ts`:

```typescript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest test/stream/localRelayTarget.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stream/localRelayTarget.ts test/stream/localRelayTarget.test.ts
git commit -m "$(cat <<'EOF'
feat: mint per-session MediaMTX paths and publish/read credentials

Publish credentials ride the stream key as a query string, so
buildPersistentEncoderArgs needs no signature change. The read credential is
minted now (different secret, different user) for Phase B's relay and for the
HLS preview proxy.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 3: The `authHTTP` endpoint MediaMTX calls on every publish and read

**Files:**
- Create: `src/stream/mediaMtxAuth.ts`
- Test: `test/stream/mediaMtxAuth.test.ts`

**Interfaces:**
- Consumes: `LocalRelaySession`, `LOCAL_RELAY_PUBLISH_USER`, `LOCAL_RELAY_READ_USER` from
  `src/stream/localRelayTarget.ts` (Task 2).
- Produces:
  ```typescript
  export interface MediaMtxAuthRequestBody {
    user?: unknown; password?: unknown; token?: unknown; ip?: unknown;
    action?: unknown; path?: unknown; protocol?: unknown; id?: unknown;
    query?: unknown; userAgent?: unknown;
  }

  export class MediaMtxAuthRegistry {
    register(session: LocalRelaySession): void;
    unregister(path: string): void;
    authorize(body: MediaMtxAuthRequestBody): boolean;
  }

  export function createMediaMtxAuthApp(
    registry: Pick<MediaMtxAuthRegistry, 'authorize'>,
    sharedSecret: string,
  ): Express;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/stream/mediaMtxAuth.test.ts`:

```typescript
import request from 'supertest';
import { MediaMtxAuthRegistry, createMediaMtxAuthApp } from '../../src/stream/mediaMtxAuth';
import { LocalRelaySession } from '../../src/stream/localRelayTarget';

const TOKEN = 'f'.repeat(32);

function session(overrides: Partial<LocalRelaySession> = {}): LocalRelaySession {
  return {
    userId: 'user-1',
    pathToken: TOKEN,
    path: `live/${TOKEN}`,
    publishSecret: 'publish-secret',
    readSecret: 'read-secret',
    publishRtmpUrl: 'rtmp://mediamtx:1935/live',
    publishStreamKey: `${TOKEN}?user=pub&pass=publish-secret`,
    readRtmpUrl: `rtmp://mediamtx:1935/live/${TOKEN}?user=sub&pass=read-secret`,
    hlsBaseUrl: `http://mediamtx:8888/live/${TOKEN}`,
    readAuthorization: `Basic ${Buffer.from('sub:read-secret').toString('base64')}`,
    ...overrides,
  };
}

function registryWithSession() {
  const registry = new MediaMtxAuthRegistry();
  registry.register(session());
  return registry;
}

describe('MediaMtxAuthRegistry', () => {
  it('allows the encoder to publish with the session publish credential', () => {
    expect(registryWithSession().authorize({
      action: 'publish', path: `live/${TOKEN}`, user: 'pub', password: 'publish-secret', protocol: 'rtmp',
    })).toBe(true);
  });

  it('allows a reader with the session read credential', () => {
    expect(registryWithSession().authorize({
      action: 'read', path: `live/${TOKEN}`, user: 'sub', password: 'read-secret', protocol: 'hls',
    })).toBe(true);
  });

  // The reason publish and read carry different secrets at all: a leaked read credential must not
  // be usable to publish over the path and hijack the stream.
  it('refuses to let the read credential publish', () => {
    expect(registryWithSession().authorize({
      action: 'publish', path: `live/${TOKEN}`, user: 'sub', password: 'read-secret', protocol: 'rtmp',
    })).toBe(false);
  });

  it('refuses the publish credential for reading', () => {
    expect(registryWithSession().authorize({
      action: 'read', path: `live/${TOKEN}`, user: 'pub', password: 'publish-secret', protocol: 'hls',
    })).toBe(false);
  });

  it('refuses a wrong password, a wrong username and a wrong-length password', () => {
    const registry = registryWithSession();
    expect(registry.authorize({ action: 'publish', path: `live/${TOKEN}`, user: 'pub', password: 'nope' })).toBe(false);
    expect(registry.authorize({ action: 'publish', path: `live/${TOKEN}`, user: 'admin', password: 'publish-secret' })).toBe(false);
    expect(registry.authorize({ action: 'publish', path: `live/${TOKEN}`, user: 'pub', password: 'publish-secretX' })).toBe(false);
  });

  it('refuses an unregistered path — including one that differs only in its token', () => {
    const registry = registryWithSession();
    expect(registry.authorize({ action: 'read', path: `live/${'e'.repeat(32)}`, user: 'sub', password: 'read-secret' })).toBe(false);
    expect(registry.authorize({ action: 'read', path: 'live', user: 'sub', password: 'read-secret' })).toBe(false);
  });

  // Instant revocation on stop is the whole reason this is an in-memory map rather than a JWT.
  it('refuses everything for a path that has been unregistered', () => {
    const registry = registryWithSession();
    registry.unregister(`live/${TOKEN}`);
    expect(registry.authorize({ action: 'read', path: `live/${TOKEN}`, user: 'sub', password: 'read-secret' })).toBe(false);
    expect(registry.authorize({ action: 'publish', path: `live/${TOKEN}`, user: 'pub', password: 'publish-secret' })).toBe(false);
  });

  it('refuses every action other than publish and read', () => {
    const registry = registryWithSession();
    for (const action of ['playback', 'api', 'metrics', 'pprof', '', undefined]) {
      expect(registry.authorize({ action, path: `live/${TOKEN}`, user: 'sub', password: 'read-secret' })).toBe(false);
    }
  });

  it('refuses a body with non-string or missing fields instead of throwing', () => {
    const registry = registryWithSession();
    expect(registry.authorize({})).toBe(false);
    expect(registry.authorize({ action: 'read', path: 42, user: 'sub', password: 'read-secret' })).toBe(false);
    expect(registry.authorize({ action: 'read', path: `live/${TOKEN}`, user: null, password: ['read-secret'] })).toBe(false);
  });

  it('keeps two concurrent users\' sessions apart', () => {
    const registry = new MediaMtxAuthRegistry();
    const other = 'a'.repeat(32);
    registry.register(session());
    registry.register(session({ userId: 'user-2', pathToken: other, path: `live/${other}`, readSecret: 'other-read' }));
    expect(registry.authorize({ action: 'read', path: `live/${other}`, user: 'sub', password: 'other-read' })).toBe(true);
    // user-1's credential must not open user-2's path.
    expect(registry.authorize({ action: 'read', path: `live/${other}`, user: 'sub', password: 'read-secret' })).toBe(false);
  });
});

describe('createMediaMtxAuthApp', () => {
  const SECRET = 'shared-secret-value';

  it('answers 200 when the registry allows the request', async () => {
    const app = createMediaMtxAuthApp(registryWithSession(), SECRET);
    const res = await request(app).post(`/internal/mediamtx-auth/${SECRET}`)
      .send({ action: 'publish', path: `live/${TOKEN}`, user: 'pub', password: 'publish-secret' });
    expect(res.status).toBe(200);
  });

  // MediaMTX allows on 2xx only (internal/auth/manager.go), so every other outcome MUST be 401.
  it('answers 401 when the registry denies the request', async () => {
    const app = createMediaMtxAuthApp(registryWithSession(), SECRET);
    const res = await request(app).post(`/internal/mediamtx-auth/${SECRET}`)
      .send({ action: 'publish', path: `live/${TOKEN}`, user: 'pub', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('answers 401 for a wrong shared secret without ever consulting the registry', async () => {
    const registry = { authorize: jest.fn().mockReturnValue(true) };
    const app = createMediaMtxAuthApp(registry, SECRET);
    const res = await request(app).post('/internal/mediamtx-auth/guessed')
      .send({ action: 'publish', path: `live/${TOKEN}`, user: 'pub', password: 'publish-secret' });
    expect(res.status).toBe(401);
    expect(registry.authorize).not.toHaveBeenCalled();
  });

  it('answers 401 for a malformed JSON body (fail closed, never 2xx)', async () => {
    const app = createMediaMtxAuthApp(registryWithSession(), SECRET);
    const res = await request(app).post(`/internal/mediamtx-auth/${SECRET}`)
      .set('Content-Type', 'application/json').send('{not json');
    expect(res.status).toBe(401);
  });

  it('exposes nothing else at all', async () => {
    const app = createMediaMtxAuthApp(registryWithSession(), SECRET);
    expect((await request(app).get('/')).status).toBe(404);
    expect((await request(app).get(`/internal/mediamtx-auth/${SECRET}`)).status).toBe(404);
    expect((await request(app).get('/openapi.json')).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest test/stream/mediaMtxAuth.test.ts`
Expected: FAIL — `Cannot find module '../../src/stream/mediaMtxAuth'`.

- [ ] **Step 3: Write the implementation**

Create `src/stream/mediaMtxAuth.ts`:

```typescript
import express, { Express, NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { LocalRelaySession, LOCAL_RELAY_PUBLISH_USER, LOCAL_RELAY_READ_USER } from './localRelayTarget';

// The JSON body MediaMTX POSTs for every publish/read attempt. Field names copied from
// internal/auth/manager.go in the pinned v1.21.0 source. Everything is `unknown` because this is
// the untrusted edge of the system: MediaMTX is the only expected caller, but the endpoint must
// behave correctly for any body at all.
export interface MediaMtxAuthRequestBody {
  user?: unknown;
  password?: unknown;
  token?: unknown;
  ip?: unknown;
  action?: unknown;
  path?: unknown;
  protocol?: unknown;
  id?: unknown;
  query?: unknown;
  userAgent?: unknown;
}

interface RegisteredPath {
  userId: string;
  publishSecret: string;
  readSecret: string;
}

// Constant-time compare that never throws and never leaks length through an early return path
// other than the unavoidable length check itself (secrets here are fixed-length hex, so a length
// mismatch already means "not our secret").
function secretEquals(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * The policy half of the spec's "Layer 2". MediaMTX has no idea this app has users; this map is
 * the entire trust decision, held in memory so that stopping a stream revokes its credentials
 * instantly (unlike a JWT, which stays valid until it expires) and so that adding or removing a
 * session never requires a MediaMTX config reload.
 *
 * Fail-closed by construction: an unregistered path, an unknown action, or a body that isn't the
 * shape we expect all return false.
 */
export class MediaMtxAuthRegistry {
  private readonly paths = new Map<string, RegisteredPath>();

  register(session: LocalRelaySession): void {
    this.paths.set(session.path, {
      userId: session.userId,
      publishSecret: session.publishSecret,
      readSecret: session.readSecret,
    });
  }

  unregister(path: string): void {
    this.paths.delete(path);
  }

  authorize(body: MediaMtxAuthRequestBody): boolean {
    const path = asString(body.path);
    if (path === null) return false;
    const entry = this.paths.get(path);
    if (!entry) return false;

    const user = asString(body.user);
    const password = asString(body.password);
    if (user === null || password === null) return false;

    // Only these two actions exist for this app. 'playback', 'api', 'metrics' and 'pprof' are
    // denied here as well as being disabled in docker/mediamtx.yml — two independent locks.
    if (body.action === 'publish') {
      return user === LOCAL_RELAY_PUBLISH_USER && secretEquals(password, entry.publishSecret);
    }
    if (body.action === 'read') {
      return user === LOCAL_RELAY_READ_USER && secretEquals(password, entry.readSecret);
    }
    return false;
  }
}

/**
 * The HTTP half of Layer 2, deliberately a SEPARATE Express app from the public API: it listens on
 * its own unpublished port (see docker-compose.yml — MediaMTX reaches it by service name only) and
 * has no cookie/session middleware, because MediaMTX is not a browser and cannot use requireAuth.
 *
 * The shared secret travels as a PATH SEGMENT rather than a header: MediaMTX sets no custom
 * headers on its auth POST and substitutes no placeholders in authHTTPAddress (verified in
 * internal/auth/manager.go), so a header-borne secret is not possible. It is supplied via
 * MTX_AUTHHTTPADDRESS so it never lands in a committed config file.
 */
export function createMediaMtxAuthApp(
  registry: Pick<MediaMtxAuthRegistry, 'authorize'>,
  sharedSecret: string,
): Express {
  const app = express();
  app.use(express.json());

  app.post('/internal/mediamtx-auth/:secret', (req: Request, res: Response) => {
    if (!secretEquals(req.params.secret, sharedSecret)) {
      res.status(401).end();
      return;
    }
    res.status(registry.authorize((req.body ?? {}) as MediaMtxAuthRequestBody) ? 200 : 401).end();
  });

  app.use((_req: Request, res: Response) => { res.status(404).end(); });

  // MediaMTX allows only on 2xx, so ANY failure here (a malformed body reaching express.json(),
  // an unexpected throw) must answer 401 rather than Express's default 400/500 — and must never
  // leak a stack trace to a caller we do not control.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[mediamtx-auth] rejecting a request that failed to parse or handle', err);
    res.status(401).end();
  });

  return app;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest test/stream/mediaMtxAuth.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stream/mediaMtxAuth.ts test/stream/mediaMtxAuth.test.ts
git commit -m "$(cat <<'EOF'
feat: add the fail-closed MediaMTX authHTTP endpoint

An in-memory path->secrets map decides every publish/read, on its own
unpublished Express app guarded by a shared secret in the URL (MediaMTX cannot
send custom headers). Anything that is not an explicit allow answers 401.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 4: Extract `buildStreamScene()` out of `StreamManager.start()`

This is a **behaviour-preserving refactor** of the working single-destination path. `StreamManager`
keeps everything destination-shaped (provider lookup, `prepareSession()`, lifecycle registration,
the `starting` guard, the controller registry) and delegates everything else. The existing
`test/stream/streamManager.test.ts` suite is the regression net — it must stay green **unchanged**.

Why extract rather than copy: without it, `LocalStreamManager` (Task 5) would carry a second copy of
~130 lines of subtle logic (animated-gif probing, the canvas-placement split, equalizer
normalisation, the blank-overlay fallback) that would silently drift from this one for the whole
lifetime of Phases A and B. Phase C deletes the caller, not the extraction.

One deliberate ordering change: `provider.prepareSession()` now runs **after** scene resolution
instead of between template loading and track loading. Nothing in the scene depends on the prepared
session, and every error in the scene half (404/403/409) still fires before any YouTube broadcast is
created — which is the ordering property that actually matters.

**Files:**
- Create: `src/stream/streamScene.ts`
- Modify: `src/stream/streamManager.ts` — delete lines 30-40 (constants), lines 72-105 (the two
  helpers) and lines 173-345 (the scene half of `start()`), and rewrite the surrounding imports and
  controller construction as shown below
- Test: `test/stream/streamScene.test.ts` (new); `test/stream/streamManager.test.ts` (existing, runs
  unchanged)

**Interfaces:**
- Consumes: `LibraryLike` from `src/stream/streamController.ts`; `Track` from
  `src/playlist/types.ts`; `NowPlayingOverlay` from `src/ffmpeg/segmentArgs.ts`; `CanvasPlacement`
  and `GifOverlayConfig` from `src/ffmpeg/persistentEncoderArgs.ts`; `SessionOverlayCache` from
  `src/stream/sessionOverlayCache.ts`.
- Produces:
  ```typescript
  export const VIDEO_WIDTH: number;        // 1280
  export const VIDEO_HEIGHT: number;       // 720
  export const VIDEO_FPS: number;          // 30
  export const CANVAS_HEARTBEAT_MS: number;  // 200
  export const CANVAS_HEARTBEAT_FPS: number; // 5

  export interface RtmpTarget { rtmpUrl: string; streamKey: string; }

  export interface StreamSceneDeps {
    spawner: Spawner;
    pipeSpawner: PipeSpawner;
    fifoDir: string;
    defaultCoverPath: string;
    backgroundImagePath: string;
    fontFile: string;
    fontFamily: string;
    playlistRepository: Pick<PlaylistRepository, 'listTracks' | 'findById'>;
    trackRepository: Pick<TrackRepository, 'listByUser'>;
    templateRepository: Pick<TemplateRepository, 'findById'>;
    templateImageService: Pick<TemplateImageService, 'resolvePath' | 'resolveOriginalPath'>;
  }

  export interface BuildStreamSceneParams {
    userId: string;
    playlistId: string;
    templateId?: string;
    sceneId: string;
    overlayCache?: SessionOverlayCache;
    sessionId?: string;
  }

  export interface StreamScene {
    playlistName: string;
    tracks: Track[];
    library: LibraryLike;
    buildOverlay: (track: Track) => Promise<NowPlayingOverlay>;
    createCanvasFeeder: () => CanvasFeeder;
    createAudioRelay: () => AudioRelay;
    createPersistentEncoder: (target: RtmpTarget) => PersistentEncoder;
    createPulseVisualizer?: () => PulseVisualizer;
  }

  export function buildStreamScene(
    deps: StreamSceneDeps, params: BuildStreamSceneParams,
  ): Promise<StreamScene>;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/stream/streamScene.test.ts`:

```typescript
jest.mock('../../src/ffmpeg/duration', () => ({ getAudioDurationSeconds: jest.fn().mockResolvedValue(100) }));
jest.mock('../../src/ffmpeg/imageFrameCount', () => ({ getImageFrameCount: jest.fn().mockResolvedValue(1) }));
jest.mock('../../src/render/renderOverlay', () => ({ renderTemplatePng: jest.fn().mockResolvedValue(Buffer.from('fake-png')) }));

import { buildStreamScene, StreamSceneDeps } from '../../src/stream/streamScene';
import { ApiError } from '../../src/errors';
import { renderTemplatePng } from '../../src/render/renderOverlay';
import { getImageFrameCount } from '../../src/ffmpeg/imageFrameCount';
import { BLANK_OVERLAY_PNG } from '../../src/render/blankOverlay';
import { DEFAULT_TEMPLATE_ELEMENTS } from '../../src/templates/templateTypes';
import { SessionOverlayCache } from '../../src/stream/sessionOverlayCache';

function buildDeps() {
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
      { name: 'c', audioPath: '/music/c.mp3', coverPath: null },
    ]),
  };
  const templateRepository = { findById: jest.fn() };
  const templateImageService = {
    resolvePath: jest.fn().mockReturnValue('/uploads/user-1/templates/tpl-1/images/asset-1.png'),
    resolveOriginalPath: jest.fn().mockResolvedValue(null),
  };
  const deps: StreamSceneDeps = {
    spawner: jest.fn(), pipeSpawner: jest.fn(),
    fifoDir: '/tmp', defaultCoverPath: '/assets/default.png', backgroundImagePath: '/assets/bg.png',
    fontFile: '/fonts/x.ttf', fontFamily: 'DejaVu Sans',
    playlistRepository, trackRepository, templateRepository, templateImageService,
  } as unknown as StreamSceneDeps;
  return { deps, playlistRepository, trackRepository, templateRepository, templateImageService };
}

const params = { userId: 'user-1', playlistId: 'playlist-1', sceneId: 'scene-1' };

describe('buildStreamScene — resolution and ownership', () => {
  beforeEach(() => {
    (renderTemplatePng as jest.Mock).mockResolvedValue(Buffer.from('fake-png'));
    (getImageFrameCount as jest.Mock).mockResolvedValue(1);
  });

  it('returns the playlist name, its ordered tracks, and a library that also finds the user\'s other tracks by name', async () => {
    const { deps } = buildDeps();
    const scene = await buildStreamScene(deps, params);
    expect(scene.playlistName).toBe('Mix');
    expect(scene.tracks.map((t) => t.name)).toEqual(['a', 'b']);
    expect(scene.library.list().map((t) => t.name)).toEqual(['a', 'b']);
    // 'c' is in the user's library but not in this playlist — playByName must still find it.
    expect(scene.library.findByName('c')?.audioPath).toBe('/music/c.mp3');
    expect(scene.library.findByName('nope')).toBeUndefined();
  });

  it('throws 404 for a playlist that does not exist', async () => {
    const { deps, playlistRepository } = buildDeps();
    playlistRepository.findById.mockResolvedValue(null);
    await expect(buildStreamScene(deps, params)).rejects.toThrow('playlist not found');
  });

  it('throws 403 for a playlist owned by someone else', async () => {
    const { deps, playlistRepository } = buildDeps();
    playlistRepository.findById.mockResolvedValue({ id: 'playlist-1', userId: 'someone-else', name: 'Mix' });
    await expect(buildStreamScene(deps, params)).rejects.toThrow('not your playlist');
  });

  it('throws 409 for an empty playlist', async () => {
    const { deps, playlistRepository } = buildDeps();
    playlistRepository.listTracks.mockResolvedValue([]);
    await expect(buildStreamScene(deps, params)).rejects.toThrow('playlist is empty');
  });

  it('throws 404/403 for a template that is missing or owned by someone else', async () => {
    const { deps, templateRepository } = buildDeps();
    templateRepository.findById.mockResolvedValue(null);
    await expect(buildStreamScene(deps, { ...params, templateId: 'tpl-1' })).rejects.toThrow('template not found');
    templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'someone-else', elements: [] });
    await expect(buildStreamScene(deps, { ...params, templateId: 'tpl-1' })).rejects.toThrow('not your template');
  });

  it('falls back to DEFAULT_TEMPLATE_ELEMENTS when no templateId is given, without hitting the repository', async () => {
    const { deps, templateRepository } = buildDeps();
    const scene = await buildStreamScene(deps, params);
    await scene.buildOverlay({ name: 'a', audioPath: '/music/a.mp3', coverPath: null });
    expect(templateRepository.findById).not.toHaveBeenCalled();
    expect(renderTemplatePng).toHaveBeenCalledWith(expect.objectContaining({ elements: DEFAULT_TEMPLATE_ELEMENTS }));
  });
});

describe('buildStreamScene — overlay building', () => {
  beforeEach(() => {
    (renderTemplatePng as jest.Mock).mockResolvedValue(Buffer.from('fake-png'));
    (getImageFrameCount as jest.Mock).mockResolvedValue(1);
  });

  it('renders the overlay at 1280x720 with the configured font and the track\'s own cover', async () => {
    const { deps } = buildDeps();
    const scene = await buildStreamScene(deps, params);
    await scene.buildOverlay({ name: 'a', audioPath: '/music/a.mp3', coverPath: '/covers/a.png' });
    expect(renderTemplatePng).toHaveBeenCalledWith(expect.objectContaining({
      title: 'a', width: 1280, height: 720, fontPath: '/fonts/x.ttf', fontFamily: 'DejaVu Sans', coverPath: '/covers/a.png',
    }));
  });

  it('falls back to the default cover when the track has none', async () => {
    const { deps } = buildDeps();
    const scene = await buildStreamScene(deps, params);
    await scene.buildOverlay({ name: 'a', audioPath: '/music/a.mp3', coverPath: null });
    expect(renderTemplatePng).toHaveBeenCalledWith(expect.objectContaining({ coverPath: '/assets/default.png' }));
  });

  // Keeping the pipeline alive matters more than one frame's picture — unlike the preview endpoint,
  // which deliberately lets a render error become a real 500.
  it('falls back to a blank overlay instead of throwing when the render fails', async () => {
    const { deps } = buildDeps();
    (renderTemplatePng as jest.Mock).mockRejectedValue(new Error('satori exploded'));
    const scene = await buildStreamScene(deps, params);
    const overlay = await scene.buildOverlay({ name: 'a', audioPath: '/music/a.mp3', coverPath: null });
    expect(overlay.overlayPng).toBe(BLANK_OVERLAY_PNG);
    expect(overlay.overlayPngAbove).toBeUndefined();
  });

  it('splits a timer element out of the baked picture and returns its position instead', async () => {
    const { deps, templateRepository } = buildDeps();
    templateRepository.findById.mockResolvedValue({
      id: 'tpl-1', userId: 'user-1',
      elements: [
        { type: 'cover', x: 0, y: 0, width: 100, height: 100 },
        { type: 'timer', x: 10, y: 660, fontSize: 20, color: '#ffffff', style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } },
      ],
    });
    const scene = await buildStreamScene(deps, { ...params, templateId: 'tpl-1' });
    const overlay = await scene.buildOverlay({ name: 'a', audioPath: '/music/a.mp3', coverPath: null });
    expect(overlay.timer).toEqual(expect.objectContaining({ x: 10, y: 660, fontSize: 20, color: '#ffffff' }));
    const rendered = (renderTemplatePng as jest.Mock).mock.calls[0][0].elements;
    expect(rendered.some((e: { type: string }) => e.type === 'timer')).toBe(false);
  });

  it('applies a track\'s overlayOverride colour to title/text elements and its background to the lower layer only', async () => {
    const { deps, templateRepository } = buildDeps();
    templateRepository.findById.mockResolvedValue({
      id: 'tpl-1', userId: 'user-1',
      elements: [{ type: 'title', x: 0, y: 0, width: 400, fontSize: 24, color: { mode: 'solid', color: '#ffffff' }, style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } }],
    });
    const scene = await buildStreamScene(deps, { ...params, templateId: 'tpl-1' });
    await scene.buildOverlay({
      name: 'a', audioPath: '/music/a.mp3', coverPath: null,
      overlayOverride: { color: { mode: 'solid', color: '#ff0000' }, backgroundColor: { mode: 'solid', color: '#000000' } },
    });
    const call = (renderTemplatePng as jest.Mock).mock.calls[0][0];
    expect(call.elements[0].color).toEqual({ mode: 'solid', color: '#ff0000' });
    expect(call.background).toEqual({ mode: 'solid', color: '#000000' });
  });
});

describe('buildStreamScene — encoder wiring', () => {
  beforeEach(() => {
    (renderTemplatePng as jest.Mock).mockResolvedValue(Buffer.from('fake-png'));
    (getImageFrameCount as jest.Mock).mockResolvedValue(1);
  });

  it('builds an encoder pointed at whatever RTMP target the caller supplies', async () => {
    const { deps } = buildDeps();
    const pipeSpawner = jest.fn().mockReturnValue({ once: jest.fn(), kill: jest.fn(), pid: 1, stdout: null, stderr: null });
    const scene = await buildStreamScene({ ...deps, pipeSpawner } as unknown as StreamSceneDeps, params);
    scene.createPersistentEncoder({ rtmpUrl: 'rtmp://mediamtx:1935/live', streamKey: 'token?user=pub&pass=s' }).start(() => {});
    const args: string[] = pipeSpawner.mock.calls[0][1];
    expect(args[args.length - 1]).toBe('rtmp://mediamtx:1935/live/token?user=pub&pass=s');
  });

  it('creates no pulse visualizer factory when the template has no equalizer element', async () => {
    const { deps } = buildDeps();
    const scene = await buildStreamScene(deps, params);
    expect(scene.createPulseVisualizer).toBeUndefined();
  });

  // The canvas is only pinned on top when there are no gifs; with a gif present, elements listed
  // before it must be able to land underneath it. See CanvasPlacement.
  it('places the canvas below the gifs when every baked element is listed before the first gif', async () => {
    const { deps, templateRepository, templateImageService } = buildDeps();
    templateImageService.resolveOriginalPath.mockResolvedValue('/uploads/user-1/templates/tpl-1/images/asset-1.original.gif');
    (getImageFrameCount as jest.Mock).mockResolvedValue(12);
    templateRepository.findById.mockResolvedValue({
      id: 'tpl-1', userId: 'user-1',
      elements: [
        { type: 'cover', x: 0, y: 0, width: 100, height: 100 },
        { type: 'image', x: 0, y: 0, width: 1280, height: 720, assetId: 'asset-1' },
      ],
    });
    const pipeSpawner = jest.fn().mockReturnValue({ once: jest.fn(), kill: jest.fn(), pid: 1, stdout: null, stderr: null });
    const scene = await buildStreamScene({ ...deps, pipeSpawner } as unknown as StreamSceneDeps, { ...params, templateId: 'tpl-1' });
    scene.createPersistentEncoder({ rtmpUrl: 'rtmp://x/live', streamKey: 'k' }).start(() => {});
    const filter: string = pipeSpawner.mock.calls[0][1][pipeSpawner.mock.calls[0][1].indexOf('-filter_complex') + 1];
    expect(filter).toContain('[vcanvas_below]');
    expect(filter).not.toContain('[vcanvas_top]');
  });
});

// The extraction moves renderShared's four-part cache key (sessionId/trackName/templateId/layer)
// out of streamManager.ts along with everything else — nothing in the EXISTING suite exercises it:
// streamManager.test.ts never passes overlayCache/sessionId at all, and
// streamSessionManager.test.ts only asserts a SessionOverlayCache instance was constructed,
// against a fully faked StreamManager. Without these, dropping `layer` from the key (the subtle
// bit — see SessionOverlayCache's own doc comment: "must never be served for each other") would be
// caught by nothing, on the blast radius of the still-live /stream-sessions/* path.
describe('buildStreamScene — overlay cache integration (SessionOverlayCache)', () => {
  beforeEach(() => {
    (renderTemplatePng as jest.Mock).mockResolvedValue(Buffer.from('fake-png'));
    (getImageFrameCount as jest.Mock).mockResolvedValue(1);
  });

  it('renders once and reuses the cached buffer for a second buildOverlay call sharing the same session, track and template', async () => {
    const { deps } = buildDeps();
    const overlayCache = new SessionOverlayCache();
    const scene = await buildStreamScene(deps, { ...params, sessionId: 'session-1', overlayCache });
    const track = { name: 'a', audioPath: '/music/a.mp3', coverPath: null };

    await scene.buildOverlay(track);
    await scene.buildOverlay(track);

    expect(renderTemplatePng).toHaveBeenCalledTimes(1);
  });

  // Asserts the KEY itself, not just the end-to-end caching behaviour above — a fake standing in
  // for SessionOverlayCache so the exact argument getOrRender receives is inspectable.
  it('includes sessionId, the track name, the templateId and the layer in every cache key', async () => {
    const { deps } = buildDeps();
    const getOrRender = jest.fn((_key: unknown, render: () => Promise<Buffer>) => render());
    const overlayCache = { getOrRender } as unknown as SessionOverlayCache;
    const scene = await buildStreamScene(deps, { ...params, sessionId: 'session-1', overlayCache });
    await scene.buildOverlay({ name: 'a', audioPath: '/music/a.mp3', coverPath: null });

    expect(getOrRender).toHaveBeenCalledWith(
      { sessionId: 'session-1', trackName: 'a', templateId: null, layer: 'below' },
      expect.any(Function),
    );
  });

  it('never shares a cache entry between two destinations that have drifted onto different tracks or templates', async () => {
    const { deps, templateRepository } = buildDeps();
    templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [] });
    const overlayCache = new SessionOverlayCache();
    const sceneA = await buildStreamScene(deps, { ...params, sessionId: 'session-1', overlayCache });
    const sceneB = await buildStreamScene(deps, { ...params, sessionId: 'session-1', overlayCache, templateId: 'tpl-1' });

    await sceneA.buildOverlay({ name: 'a', audioPath: '/music/a.mp3', coverPath: null });
    await sceneB.buildOverlay({ name: 'b', audioPath: '/music/b.mp3', coverPath: null });

    expect(renderTemplatePng).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest test/stream/streamScene.test.ts`
Expected: FAIL — `Cannot find module '../../src/stream/streamScene'`.

- [ ] **Step 3: Create `src/stream/streamScene.ts`**

```typescript
import { posix as path } from 'path';
import { Track } from '../playlist/types';
import { CanvasFeeder } from '../ffmpeg/canvasFeeder';
import { AudioRelay } from '../ffmpeg/audioRelay';
import { PersistentEncoder } from '../ffmpeg/persistentEncoder';
import { PulseVisualizer } from '../ffmpeg/pulseVisualizer';
import { CanvasPlacement, GifOverlayConfig } from '../ffmpeg/persistentEncoderArgs';
import { NowPlayingOverlay } from '../ffmpeg/segmentArgs';
import { getAudioDurationSeconds } from '../ffmpeg/duration';
import { getImageFrameCount } from '../ffmpeg/imageFrameCount';
import { buildPlaylistWindowLines } from '../ffmpeg/overlayText';
import { Spawner, PipeSpawner } from '../ffmpeg/types';
import { ApiError } from '../errors';
import { PlaylistRepository } from '../playlists/playlistRepository';
import { TrackRepository, TrackOverlayOverride } from '../tracks/trackRepository';
import { TemplateRepository } from '../templates/templateRepository';
import { TemplateImageService, InvalidAssetIdError } from '../templates/templateImageService';
import {
  TemplateElement, TimerElement, EqualizerElement, DEFAULT_TEMPLATE_ELEMENTS,
  normalizeEqualizerElement, globalPulseStrength,
} from '../templates/templateTypes';
import { renderTemplatePng } from '../render/renderOverlay';
import { BLANK_OVERLAY_PNG } from '../render/blankOverlay';
import { SessionOverlayCache } from './sessionOverlayCache';
import { LibraryLike } from './streamController';

// Also declared (as '1280x720'/'30fps'-shaped strings) in src/destinations/youtubeApiClient.ts's
// createStream — keep both in sync if this ever changes.
export const VIDEO_WIDTH = 1280;
export const VIDEO_HEIGHT = 720;
export const VIDEO_FPS = 30;
// How often CanvasFeeder resends its last-rendered frame — see canvasFeeder.ts and
// persistentEncoderArgs.ts's heartbeatFps for why these two must always match.
export const CANVAS_HEARTBEAT_MS = 200;
export const CANVAS_HEARTBEAT_FPS = 1000 / CANVAS_HEARTBEAT_MS;
const PLAYLIST_WINDOW_BEFORE = 2;
const PLAYLIST_WINDOW_AFTER = 7;

// Where the encoder pushes. Supplied by the caller because that is the ONE thing this module
// deliberately knows nothing about: StreamManager passes a destination's real ingest URL,
// LocalStreamManager passes a minted MediaMTX publish URL, and a Phase B forward pushes from
// MediaMTX rather than through here at all.
export interface RtmpTarget {
  rtmpUrl: string;
  streamKey: string;
}

export interface StreamSceneDeps {
  spawner: Spawner;
  pipeSpawner: PipeSpawner;
  fifoDir: string;
  defaultCoverPath: string;
  backgroundImagePath: string;
  fontFile: string;
  fontFamily: string;
  playlistRepository: Pick<PlaylistRepository, 'listTracks' | 'findById'>;
  trackRepository: Pick<TrackRepository, 'listByUser'>;
  templateRepository: Pick<TemplateRepository, 'findById'>;
  templateImageService: Pick<TemplateImageService, 'resolvePath' | 'resolveOriginalPath'>;
}

export interface BuildStreamSceneParams {
  // The owner every resource below must belong to. StreamManager passes the destination's owner;
  // LocalStreamManager passes the authenticated caller.
  userId: string;
  playlistId: string;
  // Absent -> DEFAULT_TEMPLATE_ELEMENTS, not an error. See CLAUDE.md's overlay-templates notes.
  templateId?: string;
  // Namespaces this scene's on-disk overlay PNGs. A destinationId for StreamManager, a userId for
  // LocalStreamManager — both are unique per concurrently-running pipeline, which is all this
  // needs to be.
  sceneId: string;
  // Legacy multi-destination session sharing. Only StreamSessionManager-driven starts pass these;
  // Phase C deletes SessionOverlayCache and both of these parameters with it, since one queue
  // driving one encode makes the drift this cache guards against structurally impossible.
  overlayCache?: SessionOverlayCache;
  sessionId?: string;
}

export interface StreamScene {
  playlistName: string;
  tracks: Track[];
  library: LibraryLike;
  buildOverlay: (track: Track) => Promise<NowPlayingOverlay>;
  createCanvasFeeder: () => CanvasFeeder;
  createAudioRelay: () => AudioRelay;
  createPersistentEncoder: (target: RtmpTarget) => PersistentEncoder;
  createPulseVisualizer?: () => PulseVisualizer;
}

// Applies a track's overlayOverride.color to every title/text element's own color — playlist/
// timer/cover/image elements are left untouched. A missing/null override (or an override with
// no `color` set) is a no-op, leaving the template's own elements exactly as authored.
function applyOverlayOverride(elements: TemplateElement[], override: TrackOverlayOverride | null | undefined): TemplateElement[] {
  if (!override?.color) return elements;
  return elements.map((el) => ((el.type === 'title' || el.type === 'text') ? { ...el, color: override.color! } : el));
}

// Resolves every 'image' element's assetId to the on-disk PNG path renderTemplatePng needs to
// read (see TemplateImageService.resolvePath) — one entry per image element actually present.
function resolveImageAssets(
  elements: TemplateElement[],
  templateImageService: Pick<TemplateImageService, 'resolvePath'>,
  userId: string,
  templateId: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const el of elements) {
    if (el.type !== 'image') continue;
    // Defense in depth: isValidTemplateElement now constrains assetId's shape at save time, so
    // InvalidAssetIdError should be unreachable here — but a template saved BEFORE that
    // validation landed could still carry a malformed id. Skipping just that element keeps
    // renderTemplatePng's per-element black-rect fallback reachable; letting the throw escape
    // would instead blank the ENTIRE overlay (via buildOverlay's blank-overlay catch) for the
    // whole session.
    try {
      result[el.assetId] = templateImageService.resolvePath(userId, templateId, el.assetId);
    } catch (err) {
      if (!(err instanceof InvalidAssetIdError)) throw err;
      console.warn(`[stream] skipping template image element with invalid assetId: ${el.assetId}`);
    }
  }
  return result;
}

/**
 * Everything a stream needs that has no destination concept in it: which tracks play, what the
 * picture looks like, and how to build the three/four ffmpeg-facing collaborators. Extracted out
 * of StreamManager.start(), which used to interleave all of this with provider lookup,
 * prepareSession() and lifecycle wiring — see the Phase A plan for why that separation is the
 * point rather than a side effect.
 */
export async function buildStreamScene(deps: StreamSceneDeps, params: BuildStreamSceneParams): Promise<StreamScene> {
  const { userId, playlistId, templateId, sceneId } = params;

  const playlist = await deps.playlistRepository.findById(playlistId);
  if (!playlist) throw new ApiError(404, 'playlist not found');
  if (playlist.userId !== userId) throw new ApiError(403, 'not your playlist');

  // Same ownership rule as the playlist above. No templateId at all is valid — it just means the
  // built-in default layout is used instead of a user-authored one.
  let templateElements: TemplateElement[] = DEFAULT_TEMPLATE_ELEMENTS;
  if (templateId) {
    const template = await deps.templateRepository.findById(templateId);
    if (!template) throw new ApiError(404, 'template not found');
    if (template.userId !== userId) throw new ApiError(403, 'not your template');
    templateElements = template.elements as unknown as TemplateElement[];
  }

  const tracks: Track[] = await deps.playlistRepository.listTracks(playlistId);
  if (tracks.length === 0) throw new ApiError(409, 'playlist is empty');

  const allUserTracksRaw = await deps.trackRepository.listByUser(userId);
  const allUserTracks: Track[] = allUserTracksRaw.map((t) => ({
    name: t.name, audioPath: t.audioPath, coverPath: t.coverPath,
    overlayOverride: t.overlayOverride as TrackOverlayOverride | null,
  }));

  const overlayImagePath = path.join(deps.fifoDir, `super-dj-overlay-${sceneId}.png`);

  const timerElement = templateElements.find((e): e is TimerElement => e.type === 'timer') ?? null;
  const rawEqualizerElement = templateElements.find((e): e is EqualizerElement => e.type === 'equalizer') ?? null;
  // A template saved before colors[]/glowLayers/glowRadius/coreWidth existed can still carry the
  // old {color: string} shape in the database — nothing re-validates a stored template's elements
  // on read, only on write. Used as-is this crashes the whole process on the element's first
  // render tick; normalizeEqualizerElement patches in the default style (or drops the element)
  // instead. See its own doc comment in templateTypes.ts.
  const equalizerElement = rawEqualizerElement ? normalizeEqualizerElement(rawEqualizerElement) : null;

  // A multi-frame (animated) image can't be rendered by Satori/resvg — resvg decodes a GIF to
  // exactly one static frame, since SVG has no concept of an animated raster embed (see
  // GifOverlayConfig's doc comment in persistentEncoderArgs.ts). Detected once here, same "fixed
  // for the life of this session" treatment as timer/equalizer, and excluded from the Satori bake
  // below so it isn't rendered twice (once, wrongly, as a static Satori image; once, correctly, as
  // a native ffmpeg overlay).
  // Probed (and, if animated, played) from templateImageService.resolveOriginalPath() — NOT
  // resolvePath()'s `${assetId}.png`, which TemplateImageService.upload() already flattened to a
  // single frame via `ffmpeg -frames:v 1` at upload time.
  const animatedImageAssetIds = new Set<string>();
  const gifOverlays: GifOverlayConfig[] = [];
  for (const el of templateElements) {
    if (el.type !== 'image') continue;
    const originalPath = await deps.templateImageService.resolveOriginalPath(userId, templateId ?? '', el.assetId);
    if (!originalPath) continue; // no original on disk — stays static
    let frameCount: number;
    try {
      frameCount = await getImageFrameCount(originalPath);
    } catch (err) {
      console.warn(`[stream] failed to probe image element "${el.assetId}" for animation, treating as a static image`, err);
      continue;
    }
    if (frameCount > 1) {
      animatedImageAssetIds.add(el.assetId);
      gifOverlays.push({
        x: Math.round(el.x), y: Math.round(el.y),
        width: Math.round(el.width), height: Math.round(el.height),
        filePath: originalPath, frameCount,
      });
    }
  }

  // A timer isn't baked into the rendered PNG (see TimerElement's doc comment) — split it out once
  // here, since the template is fixed for the life of this session, rather than on every
  // buildOverlay() call.
  const isBaked = (e: TemplateElement) =>
    e.type !== 'timer' && e.type !== 'equalizer' && !(e.type === 'image' && animatedImageAssetIds.has(e.assetId));

  // Every baked element is flattened into ONE picture by Satori, so the canvas can only be
  // composited as a whole — but the template's element order says which of those elements belong
  // behind a gif and which in front of it. Split them at the first gif's position: a full-frame
  // opaque element listed before a gif used to hide it completely (reproduced against a real
  // ffmpeg binary). See CanvasPlacement. This is a two-layer approximation, not a full per-element
  // z-order: with gifs on both sides of a baked element, that element lands above BOTH.
  const firstGifIndex = templateElements.findIndex((e) => e.type === 'image' && animatedImageAssetIds.has(e.assetId));
  const hasGifs = gifOverlays.length > 0;
  const belowElements = hasGifs ? templateElements.slice(0, firstGifIndex).filter(isBaked) : templateElements.filter(isBaked);
  const aboveElements = hasGifs ? templateElements.slice(firstGifIndex + 1).filter(isBaked) : [];
  // The timer is a native drawtext rather than part of either baked picture, and has always
  // rendered above everything else — so it needs an upper layer to sit on even when no baked
  // element does, instead of being drawn under a gif that could then cover it.
  const splitCanvas = hasGifs && (aboveElements.length > 0 || timerElement !== null);
  // With gifs present the canvas is never pinned on top: a track's own overlayOverride background
  // is the bottom-most thing in the scene and has to be able to go UNDER them, and whether any
  // given track carries one isn't knowable when the encoder's args are built.
  const canvasPlacement: CanvasPlacement = !hasGifs ? 'top' : splitCanvas ? 'split' : 'bottom';
  const aboveOverlayImagePath = splitCanvas
    ? path.join(deps.fifoDir, `super-dj-overlay-above-${sceneId}.png`)
    : undefined;

  const buildOverlay = async (track: Track): Promise<NowPlayingOverlay> => {
    const currentIndex = tracks.findIndex((t) => t.name === track.name);
    const playlistLines = buildPlaylistWindowLines(tracks, currentIndex, PLAYLIST_WINDOW_BEFORE, PLAYLIST_WINDOW_AFTER);
    const durationSeconds = await getAudioDurationSeconds(track.audioPath);

    const renderLayer = (elements: TemplateElement[], layer: 'below' | 'above') => renderTemplatePng({
      elements: applyOverlayOverride(elements, track.overlayOverride),
      title: track.name,
      playlistLines,
      coverPath: track.coverPath ?? deps.defaultCoverPath,
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      fontPath: deps.fontFile,
      fontFamily: deps.fontFamily,
      imageAssets: resolveImageAssets(elements, deps.templateImageService, userId, templateId ?? ''),
      // The track's own background override is the bottom-most thing in the scene, so it only ever
      // belongs on the lower layer — painted on the upper one it would cover every gif.
      background: layer === 'below' ? track.overlayOverride?.backgroundColor : undefined,
    });

    // The cache key carries the layer too: the two layers of one (track, template) are different
    // pictures and must never be served for each other.
    const renderShared = (elements: TemplateElement[], layer: 'below' | 'above') =>
      (params.overlayCache && params.sessionId
        ? params.overlayCache.getOrRender(
          { sessionId: params.sessionId, trackName: track.name, templateId: templateId ?? null, layer },
          () => renderLayer(elements, layer),
        )
        : renderLayer(elements, layer));

    let overlayPng: Buffer;
    let overlayPngAbove: Buffer | undefined;
    try {
      [overlayPng, overlayPngAbove] = await Promise.all([
        renderShared(belowElements, 'below'),
        splitCanvas ? renderShared(aboveElements, 'above') : Promise.resolve(undefined),
      ]);
    } catch (err) {
      // The RTMP connection staying up matters more than any one segment's picture — see
      // CLAUDE.md's overlay-templates notes. /templates/{id}/preview (an interactive, synchronous
      // request) deliberately does NOT catch the same failure. Both layers go blank together: a
      // declared canvas pipe that never receives a frame would stall the encoder's whole filter
      // graph, so the upper layer always gets SOMETHING when the template has one.
      console.error('template render failed for a live segment, falling back to a blank overlay', err);
      overlayPng = BLANK_OVERLAY_PNG;
      overlayPngAbove = splitCanvas ? BLANK_OVERLAY_PNG : undefined;
    }

    return {
      durationSeconds,
      overlayPng,
      overlayPngAbove,
      timer: timerElement
        ? { x: timerElement.x, y: timerElement.y, fontSize: timerElement.fontSize, color: timerElement.color, style: timerElement.style }
        : null,
    };
  };

  return {
    playlistName: playlist.name,
    tracks,
    library: {
      list: () => tracks,
      findByName: (name: string) => allUserTracks.find((t) => t.name === name),
    },
    buildOverlay,
    createCanvasFeeder: () => new CanvasFeeder({
      spawner: deps.spawner,
      overlayImagePath,
      aboveOverlayImagePath,
      fontFile: deps.fontFile,
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      heartbeatMs: CANVAS_HEARTBEAT_MS,
    }),
    createAudioRelay: () => new AudioRelay({ spawner: deps.spawner }),
    createPersistentEncoder: (target: RtmpTarget) => new PersistentEncoder({
      spawner: deps.pipeSpawner,
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      fps: VIDEO_FPS,
      heartbeatFps: CANVAS_HEARTBEAT_FPS,
      rtmpUrl: target.rtmpUrl,
      streamKey: target.streamKey,
      backgroundPath: deps.backgroundImagePath,
      // Rounded to integers: PulseVisualizer's raw video pipe declares `-s <width>x<height>` to
      // ffmpeg, which requires integer dimensions and errors out (exit -22) on a fractional value —
      // isValidSize doesn't enforce that, so a saved template could still carry one.
      equalizer: equalizerElement
        ? {
            x: Math.round(equalizerElement.x), y: Math.round(equalizerElement.y),
            width: Math.round(equalizerElement.width), height: Math.round(equalizerElement.height),
          }
        : undefined,
      gifOverlays,
      canvasPlacement,
    }),
    createPulseVisualizer: equalizerElement
      ? () => new PulseVisualizer({
          width: Math.round(equalizerElement.width),
          height: Math.round(equalizerElement.height),
          fps: VIDEO_FPS,
          colors: equalizerElement.colors,
          glowLayers: equalizerElement.glowLayers,
          glowRadius: equalizerElement.glowRadius,
          coreWidth: equalizerElement.coreWidth,
          sensitivity: equalizerElement.sensitivity,
          smoothing: equalizerElement.smoothing,
          beatBoost: equalizerElement.beatBoost,
          bandCount: equalizerElement.bandCount,
          // The template field is a 0-20 knob; the engine wants its own strength scale.
          globalPulse: globalPulseStrength(equalizerElement.globalPulse),
        })
      : undefined,
  };
}
```

- [ ] **Step 4: Run the new test to verify it passes**

Run: `npx jest test/stream/streamScene.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 5: Make `StreamManager` delegate to the extraction**

In `src/stream/streamManager.ts`:

1. **Delete** lines 30-40 (the `VIDEO_*`/`CANVAS_HEARTBEAT_*`/`PLAYLIST_WINDOW_*` constants) and
   lines 72-105 (`applyOverlayOverride` and `resolveImageAssets`). They now live in
   `streamScene.ts`.
2. **Replace the import block** (lines 1-28) with:

```typescript
import { EventEmitter } from 'events';
import { PlaylistQueue } from '../playlist/queue';
import { StreamController } from './streamController';
import { DestinationStreamStatus, StreamStatus } from './types';
import { Spawner, PipeSpawner } from '../ffmpeg/types';
import { ApiError } from '../errors';
import { PlaylistRepository } from '../playlists/playlistRepository';
import { DestinationRepository } from '../destinations/destinationRepository';
import { TrackRepository } from '../tracks/trackRepository';
import { TemplateRepository } from '../templates/templateRepository';
import { TemplateImageService } from '../templates/templateImageService';
import { SessionOverlayCache } from './sessionOverlayCache';
import { BroadcastMeta, DestinationLifecycle, StreamDestinationProvider } from '../destinations/streamDestinationProvider';
import { createReconnectPolicy } from './reconnectPolicy';
import { buildStreamScene, StreamSceneDeps } from './streamScene';
```

3. **Replace `StreamManagerDeps`** (lines 56-70) with a shape that reuses `StreamSceneDeps`
   verbatim, so the two can never drift:

```typescript
export interface StreamManagerDeps extends StreamSceneDeps {
  destinationRepository: Pick<DestinationRepository, 'findById'>;
  providers: Record<string, StreamDestinationProvider>;
}
```

   (`StreamSceneDeps` already declares `spawner`, `pipeSpawner`, `fifoDir`, `defaultCoverPath`,
   `backgroundImagePath`, `fontFile`, `fontFamily`, `playlistRepository`, `trackRepository`,
   `templateRepository`, `templateImageService` — the exact set `StreamManagerDeps` listed before,
   minus `destinationRepository`/`providers`. TypeScript resolves each inherited member's type
   through `StreamSceneDeps` itself, not through a re-import of `Spawner`/`PipeSpawner`/
   `PlaylistRepository`/`TrackRepository`/`TemplateRepository`/`TemplateImageService` at this call
   site — if this file no longer references those type names directly anywhere else, delete their
   now-unused imports rather than keeping them; `tsconfig.json` has no `noUnusedLocals`, so nothing
   else will catch a dead one.)

4. **Replace lines 172-345** (the comment `// The playlist must belong to the same user who owns
   the destination, otherwise` through the end of the `buildOverlay` closure, i.e. up to and
   including the `};` that closes it — this range already contains the old provider/prepareSession
   block and the old `const queue = ...`/`const overlayImagePath = ...` lines; they are replaced,
   not separately deleted, by this single substitution) with:

```typescript
      // Scene resolution (playlist/template/track ownership, gif probing, canvas placement, the
      // overlay renderer) has no destination concept in it and lives in streamScene.ts. The
      // playlist and template must belong to the same user who owns the destination, otherwise any
      // user owning a destination could stream another user's private playlist — buildStreamScene
      // enforces that against the userId passed here.
      const scene = await buildStreamScene(this.deps, {
        userId: destination.userId,
        playlistId,
        templateId: options?.templateId,
        sceneId: destinationId,
        overlayCache: options?.overlayCache,
        sessionId: options?.sessionId,
      });

      const provider = this.deps.providers[destination.provider];
      if (!provider) throw new ApiError(400, `unsupported destination provider: ${destination.provider}`);
      const resolvedMeta: BroadcastMeta = {
        title: meta?.title ?? scene.playlistName,
        description: meta?.description,
        privacyStatus: meta?.privacyStatus,
        latencyPreference: meta?.latencyPreference,
      };
      const session = await provider.prepareSession(destination, resolvedMeta);

      const queue = new PlaylistQueue(scene.tracks);
```

5. **Replace the `new StreamController({ ... })` deps** (old lines 348-405, i.e. from `library: {`
   down to the end of the `createPulseVisualizer` property — the constructor call itself,
   `const controller = new StreamController({`, is line 347 and is unchanged) with:

```typescript
        library: scene.library,
        queue,
        buildOverlay: scene.buildOverlay,
        createCanvasFeeder: scene.createCanvasFeeder,
        createAudioRelay: scene.createAudioRelay,
        createPersistentEncoder: () => scene.createPersistentEncoder({ rtmpUrl: session.rtmpUrl, streamKey: session.streamKey }),
        createPulseVisualizer: scene.createPulseVisualizer,
```

   Everything below it (`reconnectPolicy`, `onError`, `onStatusChanged`) is unchanged.

- [ ] **Step 6: Run the whole backend suite to verify nothing regressed**

Run: `npx jest`
Expected: PASS — in particular `test/stream/streamManager.test.ts` green with **no edits**, plus
`test/stream/streamScene.test.ts`. Also run `npm run build` and expect a clean `tsc`.

- [ ] **Step 7: Commit**

```bash
git add src/stream/streamScene.ts src/stream/streamManager.ts test/stream/streamScene.test.ts
git commit -m "$(cat <<'EOF'
refactor: extract buildStreamScene out of StreamManager.start()

Scene resolution (playlist/template/tracks, gif probing, canvas placement, the
overlay renderer and the ffmpeg collaborator factories) has no destination
concept in it; StreamManager keeps only the destination half and delegates the
rest. Behaviour-preserving — the existing streamManager suite runs unchanged.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 5: `LocalStreamManager` — one local stream per user

**No new controller class.** `StreamController` already contains **zero** destination-specific code
(read it: no provider, no lifecycle, no destinationId — all of that lives in `StreamManager`'s
*construction* of its deps). The spec's `LocalStream` is therefore a rename, not a fork, and
renaming it now would churn a 600-line test file for no behavioural gain. Phase C does the rename
when `StreamManager` dies; Phase A constructs a `StreamController` directly.

**Files:**
- Create: `src/stream/localStreamManager.ts`
- Test: `test/stream/localStreamManager.test.ts`

**Interfaces:**
- Consumes: `buildStreamScene`, `StreamSceneDeps` (Task 4); `LocalRelayTarget`, `LocalRelaySession`
  (Task 2); `MediaMtxAuthRegistry` (Task 3); `StreamController` (`src/stream/streamController.ts`);
  `PlaylistQueue` (`src/playlist/queue.ts`); `createReconnectPolicy` (`src/stream/reconnectPolicy.ts`);
  `StreamStatus`/`SessionState` (`src/stream/types.ts`); `ApiError` (`src/errors.ts`).
- Produces:
  ```typescript
  export interface LocalStreamStatus extends StreamStatus {
    previewReady: boolean;
    playlistId: string | null;
    templateId: string | null;
    startedAt: string | null;   // ISO-8601, or null when idle
  }

  export interface LocalPreviewTarget {
    hlsBaseUrl: string;
    authorization: string;
  }

  export interface LocalStreamManagerDeps {
    sceneDeps: StreamSceneDeps;
    relayTarget: Pick<LocalRelayTarget, 'create'>;
    authRegistry: Pick<MediaMtxAuthRegistry, 'register' | 'unregister'>;
    maxConcurrentStreams: number;
    maxSessionDurationMs: number;
    buildScene?: typeof buildStreamScene;
  }

  export class LocalStreamManager extends EventEmitter {
    start(userId: string, playlistId: string, options?: { templateId?: string }): Promise<void>;
    stop(userId: string): void;
    pause(userId: string): void;
    resume(userId: string): Promise<void>;
    next(userId: string): Promise<void>;
    previous(userId: string): Promise<void>;
    playByName(userId: string, name: string): void;
    status(userId: string): LocalStreamStatus;
    previewTarget(userId: string): LocalPreviewTarget | null;
  }
  ```
  Emits `'statusChanged'` with the `userId` as its only argument.

- [ ] **Step 1: Write the failing test**

Create `test/stream/localStreamManager.test.ts`:

```typescript
import { LocalStreamManager } from '../../src/stream/localStreamManager';
import { LocalRelaySession } from '../../src/stream/localRelayTarget';
import { ApiError } from '../../src/errors';

const TOKEN = 'c'.repeat(32);

function relaySession(userId: string, token = TOKEN): LocalRelaySession {
  return {
    userId,
    pathToken: token,
    path: `live/${token}`,
    publishSecret: 'pub-secret',
    readSecret: 'read-secret',
    publishRtmpUrl: 'rtmp://mediamtx:1935/live',
    publishStreamKey: `${token}?user=pub&pass=pub-secret`,
    readRtmpUrl: `rtmp://mediamtx:1935/live/${token}?user=sub&pass=read-secret`,
    hlsBaseUrl: `http://mediamtx:8888/live/${token}`,
    readAuthorization: 'Basic c3ViOnJlYWQtc2VjcmV0',
  };
}

function fakeScene() {
  const encoderChild = { videoPipe: {}, audioPipe: {}, pulsePipe: {}, aboveCanvasPipe: {} };
  const encoder = { start: jest.fn().mockReturnValue(encoderChild), stop: jest.fn() };
  const canvasFeeder = { attach: jest.fn(), render: jest.fn().mockResolvedValue(undefined), close: jest.fn() };
  const audioRelay = {
    attach: jest.fn(), attachTap: jest.fn(), close: jest.fn(), stopCurrent: jest.fn(),
    switchToSilence: jest.fn(() => ({ once: jest.fn() })),
    switchTrack: jest.fn(() => ({ once: jest.fn() })),
  };
  const tracks = [
    { name: 'a', audioPath: '/music/a.mp3', coverPath: null },
    { name: 'b', audioPath: '/music/b.mp3', coverPath: null },
  ];
  const createPersistentEncoder = jest.fn().mockReturnValue(encoder);
  const scene = {
    playlistName: 'Mix',
    tracks,
    library: { list: () => tracks, findByName: (n: string) => tracks.find((t) => t.name === n) },
    buildOverlay: jest.fn().mockResolvedValue({ durationSeconds: 100, overlayPng: Buffer.from('png'), timer: null }),
    createCanvasFeeder: () => canvasFeeder,
    createAudioRelay: () => audioRelay,
    createPersistentEncoder,
    createPulseVisualizer: undefined,
  };
  return { scene, encoder, canvasFeeder, audioRelay, createPersistentEncoder };
}

function buildManager(overrides: Partial<Record<string, unknown>> = {}) {
  const parts = fakeScene();
  const buildScene = jest.fn().mockResolvedValue(parts.scene);
  const relayTarget = { create: jest.fn((userId: string) => relaySession(userId)) };
  const authRegistry = { register: jest.fn(), unregister: jest.fn() };
  const manager = new LocalStreamManager({
    sceneDeps: {} as never,
    relayTarget,
    authRegistry,
    maxConcurrentStreams: 10,
    maxSessionDurationMs: 12 * 60 * 60 * 1000,
    buildScene,
    ...overrides,
  } as never);
  return { manager, buildScene, relayTarget, authRegistry, ...parts };
}

describe('LocalStreamManager.start', () => {
  it('builds the scene for the calling user and starts a controller in the streaming state', async () => {
    const { manager, buildScene } = buildManager();
    await manager.start('user-1', 'playlist-1', { templateId: 'tpl-1' });
    expect(buildScene).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: 'user-1', playlistId: 'playlist-1', templateId: 'tpl-1', sceneId: 'user-1',
    }));
    expect(manager.status('user-1').state).toBe('streaming');
  });

  // The whole premise of the rework: the encoder pushes into MediaMTX, never at a real platform.
  it('points the encoder at the minted MediaMTX publish URL', async () => {
    const { manager, createPersistentEncoder } = buildManager();
    await manager.start('user-1', 'playlist-1');
    expect(createPersistentEncoder).toHaveBeenCalledWith({
      rtmpUrl: 'rtmp://mediamtx:1935/live',
      streamKey: `${TOKEN}?user=pub&pass=pub-secret`,
    });
  });

  it('registers the session credentials before the encoder can connect', async () => {
    const { manager, authRegistry, encoder } = buildManager();
    await manager.start('user-1', 'playlist-1');
    expect(authRegistry.register).toHaveBeenCalledWith(expect.objectContaining({ path: `live/${TOKEN}` }));
    expect(authRegistry.register.mock.invocationCallOrder[0]).toBeLessThan(encoder.start.mock.invocationCallOrder[0]);
  });

  it('passes no overlay cache or session id — one queue drives one encode, so there is nothing to share', async () => {
    const { manager, buildScene } = buildManager();
    await manager.start('user-1', 'playlist-1');
    const params = buildScene.mock.calls[0][1];
    expect(params.overlayCache).toBeUndefined();
    expect(params.sessionId).toBeUndefined();
  });

  it('rejects with 409 when this user already has an active stream', async () => {
    const { manager } = buildManager();
    await manager.start('user-1', 'playlist-1');
    await expect(manager.start('user-1', 'playlist-2')).rejects.toThrow(ApiError);
    await expect(manager.start('user-1', 'playlist-2')).rejects.toThrow('a local stream is already active');
  });

  it('rejects a second concurrent start for the same user before either registers, without leaking a pipeline', async () => {
    const { manager, buildScene } = buildManager();
    let resolveScene!: (scene: unknown) => void;
    buildScene.mockImplementation(() => new Promise((resolve) => { resolveScene = resolve; }));
    const first = manager.start('user-1', 'playlist-1');
    await expect(manager.start('user-1', 'playlist-1')).rejects.toThrow('a local stream is already starting');
    resolveScene(fakeScene().scene);
    await first;
  });

  it('rejects with 429 once the per-host cap is reached, and frees a slot again on stop', async () => {
    const { manager } = buildManager({ maxConcurrentStreams: 2 });
    await manager.start('user-1', 'playlist-1');
    await manager.start('user-2', 'playlist-1');
    await expect(manager.start('user-3', 'playlist-1')).rejects.toThrow('too many local streams');
    manager.stop('user-1');
    await expect(manager.start('user-3', 'playlist-1')).resolves.toBeUndefined();
  });

  it('does not hold a slot or register credentials when the scene fails to build', async () => {
    const { manager, buildScene, authRegistry } = buildManager({ maxConcurrentStreams: 1 });
    buildScene.mockRejectedValueOnce(new ApiError(404, 'playlist not found'));
    await expect(manager.start('user-1', 'playlist-1')).rejects.toThrow('playlist not found');
    expect(authRegistry.register).not.toHaveBeenCalled();
    await expect(manager.start('user-2', 'playlist-1')).resolves.toBeUndefined();
  });

  // StreamController.start() rejects an empty library before spawning anything at all (an early
  // guard) — nothing was ever running, so there is nothing to stop().
  it('unregisters the path when the controller rejects before spawning anything (empty library)', async () => {
    const { manager, authRegistry, scene } = buildManager();
    scene.library.list = () => [];
    await expect(manager.start('user-1', 'playlist-1')).rejects.toThrow('library is empty');
    expect(authRegistry.unregister).toHaveBeenCalledWith(`live/${TOKEN}`);
    expect(manager.status('user-1').state).toBe('idle');
  });

  // Distinct from the case above: here the library is non-empty, so StreamController.start()
  // spawns the encoder/CanvasFeeder/AudioRelay pipeline BEFORE the first track's overlay build
  // rejects (buildOverlay is only awaited after the pipeline is already running). Without an
  // explicit controller.stop() in this catch, the ffmpeg encoder and CanvasFeeder's 200ms
  // heartbeat would keep running forever as a genuine orphan — its MediaMTX credentials get
  // revoked by discard() right below while it is still connected and publishing.
  it('stops an already-spawned pipeline when the first track fails to build its overlay', async () => {
    const { manager, authRegistry, encoder, canvasFeeder, scene } = buildManager();
    (scene.buildOverlay as jest.Mock).mockRejectedValue(new Error('boom'));
    await expect(manager.start('user-1', 'playlist-1')).rejects.toThrow('boom');
    expect(encoder.stop).toHaveBeenCalled();
    expect(canvasFeeder.close).toHaveBeenCalled();
    expect(authRegistry.unregister).toHaveBeenCalledWith(`live/${TOKEN}`);
    expect(manager.status('user-1').state).toBe('idle');
  });
});

describe('LocalStreamManager lifecycle and status', () => {
  it('reports idle with nulls for a user who has never streamed', () => {
    const { manager } = buildManager();
    expect(manager.status('nobody')).toEqual({
      state: 'idle', currentTrack: null, nextTrack: null,
      previewReady: false, playlistId: null, templateId: null, startedAt: null,
    });
  });

  it('reports the playlist, template and start time of a running stream, and marks the preview ready', async () => {
    const { manager } = buildManager();
    await manager.start('user-1', 'playlist-1', { templateId: 'tpl-1' });
    const status = manager.status('user-1');
    expect(status).toEqual(expect.objectContaining({
      state: 'streaming', currentTrack: 'a', nextTrack: 'b',
      previewReady: true, playlistId: 'playlist-1', templateId: 'tpl-1',
    }));
    expect(Date.parse(status.startedAt!)).not.toBeNaN();
  });

  // Pause never stops the local publish — only the audio changes — so the preview stays watchable.
  it('keeps the preview ready while paused', async () => {
    const { manager } = buildManager();
    await manager.start('user-1', 'playlist-1');
    manager.pause('user-1');
    expect(manager.status('user-1')).toEqual(expect.objectContaining({ state: 'paused', previewReady: true }));
  });

  it('exposes the preview target only while a stream is running', async () => {
    const { manager } = buildManager();
    expect(manager.previewTarget('user-1')).toBeNull();
    await manager.start('user-1', 'playlist-1');
    expect(manager.previewTarget('user-1')).toEqual({
      hlsBaseUrl: `http://mediamtx:8888/live/${TOKEN}`,
      authorization: 'Basic c3ViOnJlYWQtc2VjcmV0',
    });
    manager.stop('user-1');
    expect(manager.previewTarget('user-1')).toBeNull();
  });

  it('revokes the MediaMTX credentials on stop', async () => {
    const { manager, authRegistry, encoder } = buildManager();
    await manager.start('user-1', 'playlist-1');
    manager.stop('user-1');
    expect(encoder.stop).toHaveBeenCalled();
    expect(authRegistry.unregister).toHaveBeenCalledWith(`live/${TOKEN}`);
    expect(manager.status('user-1').state).toBe('idle');
  });

  it('throws 409 for every command when the user has no active stream', async () => {
    const { manager } = buildManager();
    expect(() => manager.stop('user-1')).toThrow('local stream is not active');
    expect(() => manager.pause('user-1')).toThrow('local stream is not active');
    await expect(manager.resume('user-1')).rejects.toThrow('local stream is not active');
    await expect(manager.next('user-1')).rejects.toThrow('local stream is not active');
    await expect(manager.previous('user-1')).rejects.toThrow('local stream is not active');
    expect(() => manager.playByName('user-1', 'a')).toThrow('local stream is not active');
  });

  it('delegates pause/resume/next/previous/playByName to this user\'s own controller', async () => {
    const { manager, audioRelay, scene } = buildManager();
    await manager.start('user-1', 'playlist-1');
    manager.pause('user-1');
    expect(audioRelay.switchToSilence).toHaveBeenCalled();
    await manager.resume('user-1');
    await manager.next('user-1');
    expect(audioRelay.switchTrack).toHaveBeenLastCalledWith('/music/b.mp3', 0);
    manager.playByName('user-1', 'a');
    expect(scene.buildOverlay).toHaveBeenCalled();
  });

  it('emits statusChanged with the userId whenever that user\'s controller changes state', async () => {
    const { manager } = buildManager();
    const listener = jest.fn();
    manager.on('statusChanged', listener);
    await manager.start('user-1', 'playlist-1');
    expect(listener).toHaveBeenCalledWith('user-1');
  });

  // Spec open question #7: an unwatched local stream still costs a full encode, so it cannot run
  // forever. No viewer-based idle timeout — MediaMTX's control API is the only viewer signal and
  // Layer 0 keeps it disabled.
  it('stops a stream that has run past the maximum session duration', async () => {
    jest.useFakeTimers();
    try {
      const { manager, authRegistry, encoder } = buildManager({ maxSessionDurationMs: 60_000 });
      await manager.start('user-1', 'playlist-1');
      await jest.advanceTimersByTimeAsync(60_000);
      expect(encoder.stop).toHaveBeenCalled();
      expect(authRegistry.unregister).toHaveBeenCalledWith(`live/${TOKEN}`);
      expect(manager.status('user-1').state).toBe('idle');
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels the duration timer when the stream is stopped first', async () => {
    jest.useFakeTimers();
    try {
      const { manager, encoder } = buildManager({ maxSessionDurationMs: 60_000 });
      await manager.start('user-1', 'playlist-1');
      manager.stop('user-1');
      encoder.stop.mockClear();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(encoder.stop).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  // createReconnectPolicy() only gives up after CRASH_LOOP_THRESHOLD (2) CONSECUTIVE short-lived
  // (<10s uptime) failures — a single exit schedules a respawn ('reconnecting'), it does not go
  // straight to 'error'. See reconnectPolicy.ts and test/stream/streamManager.test.ts's own
  // "an unexpected pusher exit ... also schedules a reconnect" test for the same mechanism this
  // one relies on: LocalStreamManager passes no isRetryableDestination veto (there is no
  // destination at this layer), so the decision is purely this uptime/crash-loop bookkeeping.
  it('revokes credentials only once two consecutive short-lived failures exhaust the reconnect budget, and lets start() recover from that state', async () => {
    jest.useFakeTimers();
    try {
      const { manager, authRegistry, encoder } = buildManager();
      await manager.start('user-1', 'playlist-1');

      const firstExit = encoder.start.mock.calls[0][0] as (code: number | null) => void;
      firstExit(1);
      expect(manager.status('user-1').state).toBe('reconnecting');
      expect(authRegistry.unregister).not.toHaveBeenCalled();
      // A pending respawn still needs the credentials it's about to reconnect with.
      expect(manager.previewTarget('user-1')).not.toBeNull();

      // Let the scheduled respawn fire (backoff is 2s +/- 20% jitter; 3s clears the jittered max).
      await jest.advanceTimersByTimeAsync(3000);
      expect(encoder.start).toHaveBeenCalledTimes(2);

      // A second consecutive short-lived exit hits CRASH_LOOP_THRESHOLD: the policy gives up.
      const secondExit = encoder.start.mock.calls[1][0] as (code: number | null) => void;
      secondExit(1);
      expect(manager.status('user-1').state).toBe('error');
      expect(manager.previewTarget('user-1')).toBeNull();
      expect(authRegistry.unregister).toHaveBeenCalledWith(`live/${TOKEN}`);

      await expect(manager.start('user-1', 'playlist-1')).resolves.toBeUndefined();
      expect(manager.status('user-1').state).toBe('streaming');
    } finally {
      jest.useRealTimers();
    }
  });

  // The capacity check reads `streams.size`, which only grows AFTER buildScene's await — so two
  // concurrent start() calls for two DIFFERENT users must not both slip through it. Guards against
  // the race in LocalStreamManager.start()'s "Synchronous check-and-reserve" comment.
  it('does not let two concurrent starts from different users both slip past the concurrency cap', async () => {
    const { manager, buildScene } = buildManager({ maxConcurrentStreams: 1 });
    let releaseFirst!: () => void;
    buildScene.mockImplementationOnce(() => new Promise((resolve) => {
      releaseFirst = () => resolve(fakeScene().scene);
    }));
    const first = manager.start('user-1', 'playlist-1');
    // user-1's start() is now suspended inside buildScene's await, having already reserved its
    // slot in `starting` synchronously before that await — user-2 must see that reservation.
    await expect(manager.start('user-2', 'playlist-1')).rejects.toThrow('too many local streams');
    releaseFirst();
    await first;
    expect(manager.status('user-1').state).toBe('streaming');
  });

  // A stream stuck in 'error' has already stopped costing real CPU (its encoder is dead), so it
  // must not permanently pin a concurrency slot with no way to evict it — Layer 0 disables the
  // control API that a viewer-count-based eviction would otherwise use. Reaches 'error' via the
  // same two-consecutive-short-lived-failures path as the reconnect test above.
  it('does not let a stream stuck in the error state pin a concurrency slot forever', async () => {
    jest.useFakeTimers();
    try {
      const { manager, encoder } = buildManager({ maxConcurrentStreams: 1 });
      await manager.start('user-1', 'playlist-1');

      (encoder.start.mock.calls[0][0] as (code: number | null) => void)(1);
      await jest.advanceTimersByTimeAsync(3000);
      (encoder.start.mock.calls[1][0] as (code: number | null) => void)(1);
      expect(manager.status('user-1').state).toBe('error');

      await expect(manager.start('user-2', 'playlist-1')).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest test/stream/localStreamManager.test.ts`
Expected: FAIL — `Cannot find module '../../src/stream/localStreamManager'`.

- [ ] **Step 3: Write the implementation**

Create `src/stream/localStreamManager.ts`:

```typescript
import { EventEmitter } from 'events';
import { PlaylistQueue } from '../playlist/queue';
import { StreamController } from './streamController';
import { StreamStatus } from './types';
import { ApiError } from '../errors';
import { createReconnectPolicy } from './reconnectPolicy';
import { buildStreamScene, StreamSceneDeps } from './streamScene';
import { LocalRelaySession, LocalRelayTarget } from './localRelayTarget';
import { MediaMtxAuthRegistry } from './mediaMtxAuth';

export interface LocalStreamStatus extends StreamStatus {
  // True once the encoder is publishing into MediaMTX — including while paused, because pausing
  // only swaps the audio to silence and never interrupts the local publish. This is exactly the
  // condition under which the HLS preview can produce a playlist.
  previewReady: boolean;
  playlistId: string | null;
  templateId: string | null;
  startedAt: string | null;
}

export interface LocalPreviewTarget {
  hlsBaseUrl: string;
  authorization: string;
}

export interface LocalStreamManagerDeps {
  sceneDeps: StreamSceneDeps;
  relayTarget: Pick<LocalRelayTarget, 'create'>;
  authRegistry: Pick<MediaMtxAuthRegistry, 'register' | 'unregister'>;
  // Spec open question #8: every logged-in user can now start an encode without owning any
  // destination at all, so a per-host ceiling is required rather than optional.
  maxConcurrentStreams: number;
  // Spec open question #7: a local stream with nothing forwarded and nobody watching still costs
  // a full libx264 encode, so it cannot run forever.
  maxSessionDurationMs: number;
  // Injected for tests; production always uses the real buildStreamScene.
  buildScene?: typeof buildStreamScene;
}

// Everything one user's local stream owns. Deliberately a struct rather than a bare
// StreamController: Phase B adds `forwards: Map<string, DestinationForward>` here, and nothing else
// about this class has to change for that.
interface LocalStreamEntry {
  controller: StreamController;
  relay: LocalRelaySession;
  playlistId: string;
  templateId: string | null;
  startedAt: number;
  expiryTimer: NodeJS.Timeout;
}

const IDLE_STATUS: LocalStreamStatus = {
  state: 'idle', currentTrack: null, nextTrack: null,
  previewReady: false, playlistId: null, templateId: null, startedAt: null,
};

/**
 * Owns exactly one local stream per user account, keyed by userId — the replacement for
 * StreamManager's destinationId-keyed registry. Phase A has no destination concept at all: the
 * encoder pushes into MediaMTX and nothing pulls from it except the preview proxy.
 */
export class LocalStreamManager extends EventEmitter {
  private readonly streams = new Map<string, LocalStreamEntry>();
  private readonly starting = new Set<string>();
  private readonly buildScene: typeof buildStreamScene;

  constructor(private readonly deps: LocalStreamManagerDeps) {
    super();
    // Every open SSE connection adds a 'statusChanged' listener to this one shared instance —
    // legitimately unbounded by design, not a leak. Same reasoning as StreamManager's.
    this.setMaxListeners(0);
    this.buildScene = deps.buildScene ?? buildStreamScene;
  }

  async start(userId: string, playlistId: string, options?: { templateId?: string }): Promise<void> {
    // Synchronous, id-keyed re-entrancy guard: two overlapping starts for the same user must not
    // both pass the "already active" check below before either has registered an entry — that race
    // would leak the loser's whole pipeline (an orphaned ffmpeg pushing into a path nothing will
    // ever unregister). Reject the second call before ANY async work.
    if (this.starting.has(userId)) throw new ApiError(409, 'a local stream is already starting for this account');

    const existing = this.streams.get(userId);
    if (existing) {
      const state = existing.controller.status().state;
      if (state === 'streaming' || state === 'paused') {
        throw new ApiError(409, 'a local stream is already active for this account');
      }
      // 'error' (gave up after an unexpected encoder exit) or 'reconnecting' (a respawn is
      // pending): the collaborators may still be alive, so tear them down before starting fresh.
      // 'idle' has nothing left to tear down and stop() would throw for it.
      if (state !== 'idle') existing.controller.stop();
      this.discard(userId, existing);
    }

    // Synchronous check-and-reserve, with no `await` between reading these counts and reserving a
    // slot: N concurrent start() calls for N *different* users would otherwise all observe
    // `streams.size` before any of them incremented it (that only happens after buildScene's
    // await, well below), and all pass the cap. `starting.size` closes that window because it is
    // incremented right here, synchronously — whichever call's synchronous prologue runs first
    // necessarily finishes reserving before the next one's prologue starts (JS never interleaves
    // two synchronous stretches). A stream stuck in `error` also no longer pins a slot forever:
    // `active` excludes it, since an errored encoder has already stopped costing real CPU.
    const active = [...this.streams.values()].filter((e) => e.controller.status().state !== 'error').length;
    if (active + this.starting.size >= this.deps.maxConcurrentStreams) {
      throw new ApiError(429, 'too many local streams are running on this host; try again later');
    }

    this.starting.add(userId);
    try {
      const scene = await this.buildScene(this.deps.sceneDeps, {
        userId,
        playlistId,
        templateId: options?.templateId,
        // One pipeline per user in this phase, so the user's own id is a sufficient namespace for
        // the on-disk overlay PNGs.
        sceneId: userId,
      });

      // Minted AFTER the scene resolves, so a 404/403/409 never burns a token, and registered
      // BEFORE the encoder starts, so the publish attempt can never lose a race with its own
      // authorisation.
      const relay = this.deps.relayTarget.create(userId);
      this.deps.authRegistry.register(relay);

      const controller = new StreamController({
        library: scene.library,
        queue: new PlaylistQueue(scene.tracks),
        buildOverlay: scene.buildOverlay,
        createCanvasFeeder: scene.createCanvasFeeder,
        createAudioRelay: scene.createAudioRelay,
        createPersistentEncoder: () => scene.createPersistentEncoder({
          rtmpUrl: relay.publishRtmpUrl,
          streamKey: relay.publishStreamKey,
        }),
        createPulseVisualizer: scene.createPulseVisualizer,
        // No isRetryableDestination veto: there is no destination at this layer. This push is a
        // container-network hop that essentially never drops for network reasons, so reconnect
        // here fires only on a genuine ffmpeg crash/OOM — and then a respawn against the SAME
        // still-registered relay session is exactly the right thing to do.
        reconnectPolicy: createReconnectPolicy(),
        onError: (exitCode) => {
          console.error(
            `[${new Date().toISOString()}] user ${userId}: local encoder exited unexpectedly (code=${exitCode}) and reconnect gave up; revoking its MediaMTX credentials`,
          );
          // Revoke immediately, but keep the entry so status() can keep reporting 'error' until the
          // user restarts or stops. Only fires once reconnect has given up — a pending respawn
          // still needs these credentials.
          const entry = this.streams.get(userId);
          if (entry && entry.relay.path === relay.path) {
            clearTimeout(entry.expiryTimer);
            this.deps.authRegistry.unregister(relay.path);
          }
        },
        onStatusChanged: () => { this.emit('statusChanged', userId); },
      });

      const expiryTimer = setTimeout(() => {
        console.warn(`[stream] user ${userId}: local stream hit the maximum session duration, stopping it`);
        try {
          this.stop(userId);
        } catch (err) {
          console.error('failed to stop a local stream that hit its maximum duration', err);
        }
      }, this.deps.maxSessionDurationMs);
      // Never let an idle 12-hour timer hold the process open on shutdown — same discipline as
      // CanvasFeeder's heartbeat interval.
      expiryTimer.unref();

      const entry: LocalStreamEntry = {
        controller, relay, playlistId, templateId: options?.templateId ?? null,
        startedAt: Date.now(), expiryTimer,
      };
      this.streams.set(userId, entry);

      try {
        await controller.start();
      } catch (err) {
        // controller.start() can throw AFTER already spawning the encoder/CanvasFeeder/AudioRelay
        // (it awaits getAudioDurationSeconds/buildOverlay for the first track only after setting
        // state to 'streaming' and starting the pipeline) — e.g. a missing/corrupt first track's
        // audio file. Without this stop(), the ffmpeg process and its 200ms CanvasFeeder heartbeat
        // keep running as a genuine orphan: its MediaMTX credentials are revoked by discard() below
        // while it is still connected and publishing (MediaMTX does not re-authorise an
        // already-established RTMP connection), the concurrency slot is freed while the CPU cost
        // is not, and nothing will ever reap it.
        if (controller.status().state !== 'idle') controller.stop();
        this.discard(userId, entry);
        throw err;
      }
    } finally {
      this.starting.delete(userId);
    }
  }

  stop(userId: string): void {
    const entry = this.require(userId);
    if (entry.controller.status().state !== 'idle') entry.controller.stop();
    this.discard(userId, entry);
    this.emit('statusChanged', userId);
  }

  pause(userId: string): void {
    this.require(userId).controller.pause();
  }

  async resume(userId: string): Promise<void> {
    return this.require(userId).controller.resume();
  }

  async next(userId: string): Promise<void> {
    return this.require(userId).controller.next();
  }

  async previous(userId: string): Promise<void> {
    return this.require(userId).controller.previous();
  }

  playByName(userId: string, name: string): void {
    this.require(userId).controller.playByName(name);
  }

  status(userId: string): LocalStreamStatus {
    const entry = this.streams.get(userId);
    if (!entry) return { ...IDLE_STATUS };
    const base = entry.controller.status();
    return {
      ...base,
      previewReady: base.state === 'streaming' || base.state === 'paused',
      playlistId: entry.playlistId,
      templateId: entry.templateId,
      startedAt: new Date(entry.startedAt).toISOString(),
    };
  }

  // The ONLY way the preview route learns which MediaMTX path to read: resolved server-side from
  // the authenticated user. Never accept a path or token from the client — see the spec's security
  // section. Returns null only once the session is genuinely gone ('idle'/'error'), so a dead
  // session's credential is never handed out — but 'reconnecting' still returns the target: the
  // MediaMTX credentials are still registered during a pending respawn (see the encoder's onError
  // handler above — revocation only happens once reconnect gives up), so there is a real, valid
  // target for the browser's HLS player to keep polling while the encoder respawns, not nothing.
  previewTarget(userId: string): LocalPreviewTarget | null {
    const entry = this.streams.get(userId);
    if (!entry) return null;
    const state = entry.controller.status().state;
    if (state !== 'streaming' && state !== 'paused' && state !== 'reconnecting') return null;
    return { hlsBaseUrl: entry.relay.hlsBaseUrl, authorization: entry.relay.readAuthorization };
  }

  private require(userId: string): LocalStreamEntry {
    const entry = this.streams.get(userId);
    if (!entry) throw new ApiError(409, 'local stream is not active');
    return entry;
  }

  // Drops every trace of a session: its expiry timer, its MediaMTX credentials, and its registry
  // slot (which is what frees capacity under maxConcurrentStreams).
  private discard(userId: string, entry: LocalStreamEntry): void {
    clearTimeout(entry.expiryTimer);
    this.deps.authRegistry.unregister(entry.relay.path);
    if (this.streams.get(userId) === entry) this.streams.delete(userId);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest test/stream/localStreamManager.test.ts`
Expected: PASS (20 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stream/localStreamManager.ts test/stream/localStreamManager.test.ts
git commit -m "$(cat <<'EOF'
feat: add LocalStreamManager — one local stream per user account

Composes buildStreamScene with a StreamController whose encoder pushes into a
freshly minted MediaMTX path, registers/revokes that path's credentials around
the session, and enforces the per-host concurrency cap and maximum session
duration. No destination concept anywhere.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 6: The authenticated HLS preview proxy

**Files:**
- Create: `src/stream/localStreamPreviewRoutes.ts`
- Test: `test/stream/localStreamPreviewRoutes.test.ts`

**Interfaces:**
- Consumes: `LocalStreamManager.previewTarget` (Task 5); `requireAuth`/`AuthenticatedRequest`
  (`src/auth/authMiddleware.ts`); `AuthService` (`src/auth/authService.ts`); `wrapAsync`
  (`src/api/errorHandler.ts`); `ApiError` (`src/errors.ts`).
- Produces:
  ```typescript
  export interface PreviewFetchResponse {
    status: number;
    contentType: string | null;
    body: NodeJS.ReadableStream | null;
  }

  export type PreviewFetch = (
    url: string, init: { headers: Record<string, string> },
  ) => Promise<PreviewFetchResponse>;

  export function createLocalStreamPreviewRouter(
    authService: AuthService,
    localStreamManager: Pick<LocalStreamManager, 'previewTarget'>,
    previewFetch: PreviewFetch,
  ): Router;
  ```
  Routes (relative to its mount point): `GET /index.m3u8`, `GET /:file`.

- [ ] **Step 1: Write the failing test**

Create `test/stream/localStreamPreviewRoutes.test.ts`:

```typescript
import express from 'express';
import request from 'supertest';
import { Readable } from 'stream';
import { createLocalStreamPreviewRouter, PreviewFetch } from '../../src/stream/localStreamPreviewRoutes';
import { errorHandler } from '../../src/api/errorHandler';

const TOKEN = 'd'.repeat(32);

function buildApp(opts: {
  previewTarget?: unknown;
  previewFetch?: PreviewFetch;
  userId?: string | null;
} = {}) {
  const authService: any = {
    getCurrentUser: jest.fn().mockResolvedValue(
      opts.userId === null ? null : { id: opts.userId ?? 'user-1', email: 'a@example.com' },
    ),
  };
  const localStreamManager: any = {
    previewTarget: jest.fn().mockReturnValue(
      opts.previewTarget === undefined
        ? { hlsBaseUrl: `http://mediamtx:8888/live/${TOKEN}`, authorization: 'Basic c3ViOnM=' }
        : opts.previewTarget,
    ),
  };
  const previewFetch: PreviewFetch = opts.previewFetch ?? jest.fn().mockResolvedValue({
    status: 200,
    contentType: 'application/vnd.apple.mpegurl',
    body: Readable.from(['#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nstream.m3u8\n']),
  });
  const app = express();
  app.use('/local-stream/preview', createLocalStreamPreviewRouter(authService, localStreamManager, previewFetch));
  app.use(errorHandler);
  return { app, previewFetch: previewFetch as jest.Mock, localStreamManager, authService };
}

describe('GET /local-stream/preview', () => {
  it('requires authentication', async () => {
    const { app, previewFetch } = buildApp({ userId: null });
    const res = await request(app).get('/local-stream/preview/index.m3u8');
    expect(res.status).toBe(401);
    expect(previewFetch).not.toHaveBeenCalled();
  });

  // The single most important rule in the spec's security section: the client never names a path.
  // The token is resolved from the authenticated user's own stream, server-side.
  it('resolves the MediaMTX path from the authenticated user and presents the read credential', async () => {
    const { app, previewFetch, localStreamManager } = buildApp({ userId: 'user-7' });
    const res = await request(app).get('/local-stream/preview/index.m3u8');
    expect(res.status).toBe(200);
    expect(localStreamManager.previewTarget).toHaveBeenCalledWith('user-7');
    expect(previewFetch).toHaveBeenCalledWith(
      `http://mediamtx:8888/live/${TOKEN}/index.m3u8`,
      { headers: { Authorization: 'Basic c3ViOnM=' } },
    );
  });

  it('streams the playlist body back with the upstream content type and no caching', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/local-stream/preview/index.m3u8');
    expect(res.text).toContain('#EXTM3U');
    expect(res.headers['content-type']).toContain('application/vnd.apple.mpegurl');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('proxies a media playlist and a segment by name', async () => {
    const { app, previewFetch } = buildApp();
    await request(app).get('/local-stream/preview/stream.m3u8');
    expect(previewFetch).toHaveBeenLastCalledWith(`http://mediamtx:8888/live/${TOKEN}/stream.m3u8`, expect.anything());
    await request(app).get('/local-stream/preview/segment7.ts');
    expect(previewFetch).toHaveBeenLastCalledWith(`http://mediamtx:8888/live/${TOKEN}/segment7.ts`, expect.anything());
  });

  it('falls back to a content type derived from the extension when upstream sends none', async () => {
    const previewFetch = jest.fn().mockResolvedValue({ status: 200, contentType: null, body: Readable.from(['x']) });
    const { app } = buildApp({ previewFetch });
    const res = await request(app).get('/local-stream/preview/segment0.ts');
    expect(res.headers['content-type']).toContain('video/mp2t');
  });

  it('returns 409 when this user has no active local stream', async () => {
    const { app, previewFetch } = buildApp({ previewTarget: null });
    const res = await request(app).get('/local-stream/preview/index.m3u8');
    expect(res.status).toBe(409);
    expect(previewFetch).not.toHaveBeenCalled();
  });

  it('rejects any file name that is not a plain HLS artefact', async () => {
    const { app, previewFetch } = buildApp();
    for (const name of ['..', '..%2Fmediamtx.yml', 'evil.sh', 'stream.m3u8.bak', '.env', 'seg ment.ts']) {
      const res = await request(app).get(`/local-stream/preview/${name}`);
      expect([400, 404]).toContain(res.status);
    }
    expect(previewFetch).not.toHaveBeenCalled();
  });

  // MediaMTX muxes HLS on demand (hlsAlwaysRemux: no), so the first playlist request after a start
  // can legitimately 404 for a moment. Pass it through so the player can retry, rather than
  // dressing it up as a 500.
  it('mirrors a non-2xx upstream status without a body', async () => {
    const previewFetch = jest.fn().mockResolvedValue({ status: 404, contentType: null, body: null });
    const { app } = buildApp({ previewFetch });
    const res = await request(app).get('/local-stream/preview/index.m3u8');
    expect(res.status).toBe(404);
    expect(res.text).toBe('');
  });

  // A real HTTP client typically supplies a body even for an error response (e.g. a 404's error
  // page) — and this is the EXPECTED, frequent branch (MediaMTX's on-demand muxer 404ing right
  // after a fresh publish, polled every second or two). An undestroyed body here would leak a
  // socket to MediaMTX on every such poll over a long session.
  it('destroys the upstream body on a non-2xx response that still has one, instead of leaking it', async () => {
    const body = new Readable({ read() {} });
    const destroy = jest.spyOn(body, 'destroy');
    const previewFetch = jest.fn().mockResolvedValue({ status: 404, contentType: null, body });
    const { app } = buildApp({ previewFetch });
    const res = await request(app).get('/local-stream/preview/index.m3u8');
    expect(res.status).toBe(404);
    expect(destroy).toHaveBeenCalled();
  });

  it('never echoes the upstream URL or the read credential to the client', async () => {
    const previewFetch = jest.fn().mockRejectedValue(new Error(`connect ECONNREFUSED http://mediamtx:8888/live/${TOKEN}`));
    const { app } = buildApp({ previewFetch });
    const res = await request(app).get('/local-stream/preview/index.m3u8');
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    expect(JSON.stringify(res.body)).not.toContain('Basic');
  });

  // Plain `.pipe()` leaves the upstream Readable with no 'error' listener — an unhandled 'error'
  // event is an uncaught exception in Node, which crashes the WHOLE process (every tenant's
  // active stream, not just this request). A body that errors mid-stream (MediaMTX restarts, the
  // muxer closes after hlsMuxerCloseAfter, a socket reset) must not be able to do that.
  it('does not crash the process when the upstream body errors mid-stream', async () => {
    const body = new Readable({ read() {} });
    const previewFetch = jest.fn().mockResolvedValue({ status: 200, contentType: 'video/mp2t', body });
    const { app } = buildApp({ previewFetch });
    // supertest's request(app).get(...) is a lazy thenable (superagent Request) — nothing is sent
    // over the socket until something calls .then()/.catch()/.end() on it. Manipulating `body`
    // synchronously, before that dispatch, would fire body's 'error' event with ZERO listeners
    // attached (pipeline() — which attaches one — hasn't run yet, since the route hasn't been
    // invoked yet), which is a synchronous throw inside THIS TEST rather than anything exercising
    // the route at all. Explicitly kick off dispatch first (the `.catch(() => {})` is what
    // superagent's lazy `.then()` needs to actually call `.end()`), then wait for the real loopback
    // round trip to reach the route and let pipeline() wire up `body` before touching it.
    const reqPromise = request(app).get('/local-stream/preview/segment0.ts');
    reqPromise.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    body.push('partial-segment-bytes');
    body.emit('error', new Error('ECONNRESET'));
    body.push(null);
    // Once pipeline() correctly destroys the now-broken response (there's no valid way to finish
    // an aborted mid-stream response gracefully), the client legitimately sees its own connection
    // reset — superagent rejects with "socket hang up". That's expected (a real HLS player losing
    // one segment fetch and retrying), not a process crash, so tolerate it here. The actual
    // assertion is implicit but load-bearing: if the 'error' event above had no listener, THIS
    // process would crash and no later test in this file (or this Jest worker) could run at all —
    // reaching the end of this test file is the proof.
    await reqPromise.catch(() => {});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest test/stream/localStreamPreviewRoutes.test.ts`
Expected: FAIL — `Cannot find module '../../src/stream/localStreamPreviewRoutes'`.

- [ ] **Step 3: Write the implementation**

Create `src/stream/localStreamPreviewRoutes.ts`:

```typescript
import { Request, Response, Router } from 'express';
import { pipeline, Readable } from 'stream';
import { ApiError } from '../errors';
import { wrapAsync } from '../api/errorHandler';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { AuthService } from '../auth/authService';
import { LocalStreamManager } from './localStreamManager';

// A deliberately tiny HTTP-client seam, injected rather than mocked: matches this repo's existing
// fake-injection testing style (Spawner, repositories) instead of pulling in a mocking library.
// The default implementation (createPreviewFetch in server.ts) adapts global fetch to it.
export interface PreviewFetchResponse {
  status: number;
  contentType: string | null;
  // A Node readable so the route can pipe it straight through without buffering a whole segment.
  body: NodeJS.ReadableStream | null;
}

export type PreviewFetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<PreviewFetchResponse>;

// Exactly the artefacts MediaMTX's HLS muxer serves: a playlist, an MPEG-TS segment, or an fMP4
// init/segment/part (kept for a future hlsVariant change). Anchored, no dots beyond the single
// extension, no path separators, no spaces — so nothing here can walk out of the stream's own
// directory or address a MediaMTX endpoint that is not part of this path's HLS output.
const ALLOWED_FILE = /^[A-Za-z0-9][A-Za-z0-9_-]*\.(m3u8|ts|mp4|m4s)$/;

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
  mp4: 'video/mp4',
  m4s: 'video/iso.segment',
};

/**
 * The preview leg of the spec's "Layer 3": the browser's only route to the stream, and the one leg
 * with no MediaMTX-native enforcement the browser could satisfy on its own.
 *
 * Two rules make it safe, and both must survive any future edit:
 *  1. The client NEVER names a MediaMTX path or token. The path is resolved from req.user.id. A
 *     variant that took a path/token parameter would be one IDOR away from cross-tenant viewing.
 *  2. The proxy still presents the session's read credential upstream, so authHTTP applies even to
 *     our own traffic — defense in depth against a misconfiguration here.
 *
 * Known limitation, documented rather than solved in this iteration: iOS Safari plays HLS with its
 * native player, which fetches the playlist itself and will not attach a cross-site cookie, so the
 * preview silently fails there. A short-lived signed query token would fix it later.
 */
export function createLocalStreamPreviewRouter(
  authService: AuthService,
  localStreamManager: Pick<LocalStreamManager, 'previewTarget'>,
  previewFetch: PreviewFetch,
): Router {
  const router = Router();
  const auth = requireAuth(authService);

  async function proxy(req: Request, res: Response, fileName: string): Promise<void> {
    if (!ALLOWED_FILE.test(fileName)) throw new ApiError(400, 'invalid preview file name');

    const userId = (req as AuthenticatedRequest).user!.id;
    const target = localStreamManager.previewTarget(userId);
    if (!target) throw new ApiError(409, 'local stream is not active');

    let upstream: PreviewFetchResponse;
    try {
      upstream = await previewFetch(`${target.hlsBaseUrl}/${fileName}`, {
        headers: { Authorization: target.authorization },
      });
    } catch (err) {
      // Never surface the upstream error verbatim: its message carries the MediaMTX host and the
      // session's path token.
      console.error('[local-stream] preview upstream request failed', err);
      throw new ApiError(502, 'preview is temporarily unavailable');
    }

    // MediaMTX muxes HLS on demand, so a 404 right after a start just means "the muxer has not
    // produced a playlist yet" — pass the status through and let the player retry rather than
    // inventing a different one.
    if (upstream.status < 200 || upstream.status > 299 || !upstream.body) {
      // A real HTTP client typically supplies a body even for an error status (e.g. a 404's error
      // page) — and this branch is the EXPECTED, frequent one (MediaMTX's on-demand HLS muxer
      // 404ing right after a fresh publish, presumably polled every second or two by the player).
      // Leaving that body undrained/undestroyed on every such poll risks leaking sockets/
      // connections to MediaMTX over a long session. Destroy it before responding; harmless no-op
      // when body is already null.
      (upstream.body as Readable | null)?.destroy?.();
      res.status(upstream.status).end();
      return;
    }

    const extension = fileName.slice(fileName.lastIndexOf('.') + 1);
    res.status(200);
    res.setHeader('Content-Type', upstream.contentType ?? CONTENT_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream');
    // Live playlists and segments are session-scoped and short-lived; nothing in this response may
    // ever be cached by a browser or an intermediary and replayed for a different user.
    res.setHeader('Cache-Control', 'no-store');

    // Plain `.pipe()` attaches no 'error' listener to the SOURCE — an 'error' event with no
    // listener is an uncaught exception in Node, which would crash the whole process (every
    // tenant's active stream, not just this preview request). See server.ts's own stderr-forwarder
    // comment for the same hazard already documented in this codebase. `pipeline` wires that
    // listener for us. Also destroy the upstream body on client disconnect (closing the preview
    // tab) so we don't leak a socket to MediaMTX and keep an on-demand muxer alive forever.
    const body = upstream.body;
    // Cast needed: PreviewFetchResponse.body is typed NodeJS.ReadableStream (that interface only
    // extends EventEmitter, no destroy() in this repo's @types/node) — same runtime object either
    // way, since the real implementation always hands back a real Node Readable.
    res.on('close', () => { if (!res.writableEnded) (body as Readable).destroy(); });
    pipeline(body, res, (err) => {
      if (err) console.error('[local-stream] preview pipe failed', err);
    });
  }

  // The multivariant playlist, and the only URL the frontend ever constructs itself. Declared
  // before /:file so the intent is explicit; both go through the same handler.
  router.get('/index.m3u8', auth, wrapAsync(async (req, res) => proxy(req, res, 'index.m3u8')));

  // Everything the playlists reference. MediaMTX emits RELATIVE references (stream.m3u8,
  // segment0.ts), so mounting this route as a sibling of index.m3u8 makes them resolve correctly
  // with no playlist rewriting at all.
  router.get('/:file', auth, wrapAsync(async (req, res) => proxy(req, res, req.params.file)));

  return router;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest test/stream/localStreamPreviewRoutes.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stream/localStreamPreviewRoutes.ts test/stream/localStreamPreviewRoutes.test.ts
git commit -m "$(cat <<'EOF'
feat: proxy MediaMTX HLS to the browser behind requireAuth

The client never names a MediaMTX path — it is resolved from the authenticated
user's own stream — and the proxy still presents the session read credential
upstream so authHTTP applies to our own traffic too.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `/local-stream/*` control, status and SSE routes

**Files:**
- Create: `src/stream/localStreamRoutes.ts`
- Test: `test/stream/localStreamRoutes.test.ts`, `test/stream/localStreamEvents.test.ts`

**Interfaces:**
- Consumes: `LocalStreamManager` (Task 5); `createLocalStreamPreviewRouter`, `PreviewFetch`
  (Task 6); `requireAuth`/`AuthenticatedRequest`; `AuthService`; `wrapAsync`; `ApiError`.
- Produces:
  ```typescript
  export function createLocalStreamRouter(
    authService: AuthService,
    localStreamManager: LocalStreamManager,
    previewFetch: PreviewFetch,
  ): Router;
  ```
  Routes (mounted at `/local-stream`): `POST /start`, `POST /stop`, `POST /pause`,
  `POST /resume`, `POST /next`, `POST /previous`, `POST /play`, `GET /status`, `GET /events`,
  and the preview router at `/preview`.

- [ ] **Step 1: Write the failing control-route test**

Create `test/stream/localStreamRoutes.test.ts`:

```typescript
import express from 'express';
import request from 'supertest';
import { createLocalStreamRouter } from '../../src/stream/localStreamRoutes';
import { errorHandler } from '../../src/api/errorHandler';
import { ApiError } from '../../src/errors';

const STATUS = {
  state: 'streaming', currentTrack: 'a', nextTrack: 'b',
  previewReady: true, playlistId: 'p1', templateId: null, startedAt: '2026-09-14T10:00:00.000Z',
};

function buildApp(localStreamManager: any, userId = 'user-1') {
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: userId, email: 'a@example.com' }) };
  const previewFetch = jest.fn();
  const app = express();
  app.use(express.json());
  app.use('/local-stream', createLocalStreamRouter(authService, localStreamManager, previewFetch));
  app.use(errorHandler);
  return app;
}

describe('local stream control routes', () => {
  it('POST /start requires playlistId in the body', async () => {
    const manager: any = { start: jest.fn() };
    const res = await request(buildApp(manager)).post('/local-stream/start').send({});
    expect(res.status).toBe(400);
    expect(manager.start).not.toHaveBeenCalled();
  });

  it('POST /start passes the authenticated user, the playlist and no template by default', async () => {
    const manager: any = { start: jest.fn().mockResolvedValue(undefined), status: jest.fn().mockReturnValue(STATUS) };
    const res = await request(buildApp(manager, 'user-9')).post('/local-stream/start').send({ playlistId: 'p1' });
    expect(res.status).toBe(200);
    expect(manager.start).toHaveBeenCalledWith('user-9', 'p1', { templateId: undefined });
    expect(res.body).toEqual(STATUS);
  });

  it('POST /start passes a templateId through and rejects an empty-string one', async () => {
    const manager: any = { start: jest.fn().mockResolvedValue(undefined), status: jest.fn().mockReturnValue(STATUS) };
    const app = buildApp(manager);
    expect((await request(app).post('/local-stream/start').send({ playlistId: 'p1', templateId: '' })).status).toBe(400);
    expect((await request(app).post('/local-stream/start').send({ playlistId: 'p1', templateId: 'tpl-1' })).status).toBe(200);
    expect(manager.start).toHaveBeenCalledWith('user-1', 'p1', { templateId: 'tpl-1' });
  });

  // Phase A has no destination, so there is no broadcast to title or set privacy on. These fields
  // are silently ignored rather than accepted, so a client copied from the old API cannot believe
  // it configured something that does not exist here.
  it('POST /start ignores destination-only broadcast fields entirely', async () => {
    const manager: any = { start: jest.fn().mockResolvedValue(undefined), status: jest.fn().mockReturnValue(STATUS) };
    const res = await request(buildApp(manager)).post('/local-stream/start')
      .send({ playlistId: 'p1', title: 'x', privacyStatus: 'nonsense', latencyPreference: 'nonsense' });
    expect(res.status).toBe(200);
    expect(manager.start).toHaveBeenCalledWith('user-1', 'p1', { templateId: undefined });
  });

  it.each([
    ['stop', 'stop'], ['pause', 'pause'], ['resume', 'resume'], ['next', 'next'], ['previous', 'previous'],
  ])('POST /%s delegates to the manager for the authenticated user and returns the new status', async (route, method) => {
    const manager: any = { [method]: jest.fn().mockResolvedValue(undefined), status: jest.fn().mockReturnValue(STATUS) };
    // .send({}) (not a bare .post()) so supertest sets Content-Type: application/json — required
    // by requireJsonRequest below, which exists specifically so these no-id control routes aren't
    // a one-click cross-site POST target (see requireJsonRequest's doc comment in the route file).
    const res = await request(buildApp(manager, 'user-3')).post(`/local-stream/${route}`).send({});
    expect(res.status).toBe(200);
    expect(manager[method]).toHaveBeenCalledWith('user-3');
    expect(res.body).toEqual(STATUS);
  });

  it.each(['stop', 'pause', 'resume', 'next', 'previous', 'play'])(
    'POST /%s rejects a request that is not application/json, so a plain cross-site form POST cannot trigger it',
    async (route) => {
      const manager: any = { [route]: jest.fn(), playByName: jest.fn(), status: jest.fn().mockReturnValue(STATUS) };
      const res = await request(buildApp(manager))
        .post(`/local-stream/${route}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('x=1');
      expect(res.status).toBe(400);
      expect(manager[route]).not.toHaveBeenCalled();
      expect(manager.playByName).not.toHaveBeenCalled();
    },
  );

  it('POST /play requires name in the body', async () => {
    const manager: any = { playByName: jest.fn() };
    const res = await request(buildApp(manager)).post('/local-stream/play').send({});
    expect(res.status).toBe(400);
    expect(manager.playByName).not.toHaveBeenCalled();
  });

  it('POST /play inserts the named track next', async () => {
    const manager: any = { playByName: jest.fn(), status: jest.fn().mockReturnValue(STATUS) };
    const res = await request(buildApp(manager)).post('/local-stream/play').send({ name: 'a' });
    expect(res.status).toBe(200);
    expect(manager.playByName).toHaveBeenCalledWith('user-1', 'a');
  });

  it('maps a 409 from the manager (nothing active) straight through', async () => {
    const manager: any = { next: jest.fn().mockRejectedValue(new ApiError(409, 'local stream is not active')) };
    const res = await request(buildApp(manager)).post('/local-stream/next').send({});
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'local stream is not active' });
  });

  it('maps a 429 from the per-host cap straight through', async () => {
    const manager: any = { start: jest.fn().mockRejectedValue(new ApiError(429, 'too many local streams are running on this host; try again later')) };
    const res = await request(buildApp(manager)).post('/local-stream/start').send({ playlistId: 'p1' });
    expect(res.status).toBe(429);
  });

  it('GET /status returns this user\'s own status', async () => {
    const manager: any = { status: jest.fn().mockReturnValue(STATUS) };
    const res = await request(buildApp(manager, 'user-4')).get('/local-stream/status');
    expect(res.status).toBe(200);
    expect(manager.status).toHaveBeenCalledWith('user-4');
    expect(res.body).toEqual(STATUS);
  });

  it('requires authentication on every route', async () => {
    const authService: any = { getCurrentUser: jest.fn().mockResolvedValue(null) };
    const app = express();
    app.use(express.json());
    app.use('/local-stream', createLocalStreamRouter(authService, { status: jest.fn() } as any, jest.fn()));
    app.use(errorHandler);
    for (const path of ['/local-stream/status', '/local-stream/preview/index.m3u8']) {
      expect((await request(app).get(path)).status).toBe(401);
    }
    expect((await request(app).post('/local-stream/stop')).status).toBe(401);
  });
});
```

- [ ] **Step 2: Write the failing SSE test**

Create `test/stream/localStreamEvents.test.ts`:

```typescript
import express from 'express';
import { AddressInfo } from 'net';
import { createLocalStreamRouter } from '../../src/stream/localStreamRoutes';
import { errorHandler } from '../../src/api/errorHandler';
import { LocalStreamManager, LocalStreamStatus } from '../../src/stream/localStreamManager';

function buildApp(localStreamManager: LocalStreamManager, userId = 'user-1') {
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: userId, email: 'a@example.com' }) };
  const app = express();
  app.use(express.json());
  app.use('/local-stream', createLocalStreamRouter(authService, localStreamManager, jest.fn()));
  app.use(errorHandler);
  return app;
}

const IDLE: LocalStreamStatus = {
  state: 'idle', currentTrack: null, nextTrack: null,
  previewReady: false, playlistId: null, templateId: null, startedAt: null,
};

describe('GET /local-stream/events (SSE)', () => {
  it('sends the current status immediately on connect', async () => {
    const manager = new LocalStreamManager({} as never);
    jest.spyOn(manager, 'status').mockReturnValue(IDLE);
    const server = buildApp(manager).listen(0);
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/local-stream/events`, { signal: controller.signal });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const { value } = await res.body!.getReader().read();
      expect(Buffer.from(value!).toString('utf8')).toBe(`data: ${JSON.stringify(IDLE)}\n\n`);
    } finally {
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('pushes a frame for this user\'s own events only', async () => {
    const manager = new LocalStreamManager({} as never);
    const live: LocalStreamStatus = {
      state: 'streaming', currentTrack: 'a', nextTrack: 'b',
      previewReady: true, playlistId: 'p1', templateId: null, startedAt: '2026-09-14T10:00:00.000Z',
    };
    const statuses = [IDLE, live];
    jest.spyOn(manager, 'status').mockImplementation(() => statuses.shift() ?? live);
    const server = buildApp(manager, 'user-1').listen(0);
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/local-stream/events`, { signal: controller.signal });
      const reader = res.body!.getReader();
      await reader.read(); // initial frame

      manager.emit('statusChanged', 'someone-else');
      manager.emit('statusChanged', 'user-1');
      const { value } = await reader.read();
      expect(Buffer.from(value!).toString('utf8')).toBe(`data: ${JSON.stringify(live)}\n\n`);
    } finally {
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('removes its listener when the client disconnects', async () => {
    const manager = new LocalStreamManager({} as never);
    jest.spyOn(manager, 'status').mockReturnValue(IDLE);
    const server = buildApp(manager).listen(0);
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/local-stream/events`, { signal: controller.signal });
      await res.body!.getReader().read();
      expect(manager.listenerCount('statusChanged')).toBe(1);
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(manager.listenerCount('statusChanged')).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `npx jest test/stream/localStreamRoutes.test.ts test/stream/localStreamEvents.test.ts`
Expected: FAIL — `Cannot find module '../../src/stream/localStreamRoutes'`.

- [ ] **Step 4: Write the implementation**

Create `src/stream/localStreamRoutes.ts`:

```typescript
import { Router } from 'express';
import { LocalStreamManager } from './localStreamManager';
import { createLocalStreamPreviewRouter, PreviewFetch } from './localStreamPreviewRoutes';
import { ApiError } from '../errors';
import { wrapAsync } from '../api/errorHandler';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { AuthService } from '../auth/authService';

/**
 * The whole local-stream API surface. Every route is scoped to the authenticated user and takes no
 * id of any kind: there is exactly one local stream per account (see LocalStreamManager), so there
 * is nothing to address and therefore no ownership check to get wrong.
 *
 * Deliberately absent: title/description/privacyStatus/latencyPreference. Those configure a
 * provider's live broadcast, and Phase A has no destinations at all — accepting them here would
 * tell a caller it had configured something that does not exist.
 */
// The session cookie is `SameSite=None; Secure` in production (sessionCookie.ts), so it rides on
// cross-site requests. A route with no id and no ownership check to get wrong (see doc comment
// above) also has no accidental CSRF token — unlike /destinations/{id}/... or /stream-sessions/
// {id}/..., which at least require an unguessable id an attacker's page wouldn't know. A plain
// cross-origin HTML form POST is a CORS "simple request" (no preflight; only the RESPONSE is
// blocked by CORS, not the side effect) unless the request either carries a body Express won't
// parse as one of the three form-safelisted content types, or triggers a preflight some other way.
// Requiring JSON does both: `express.json()` only populates `req.body` for
// `application/json`, and a JSON content-type is not one of the three CORS-safelisted form types,
// so the browser preflights it — which our CORS config then has to actually approve.
function requireJsonRequest(req: AuthenticatedRequest, _res: unknown, next: (err?: unknown) => void) {
  if (!req.is('application/json')) {
    next(new ApiError(400, 'Content-Type: application/json is required'));
    return;
  }
  next();
}

export function createLocalStreamRouter(
  authService: AuthService,
  localStreamManager: LocalStreamManager,
  previewFetch: PreviewFetch,
): Router {
  const router = Router();
  const auth = requireAuth(authService);
  const userId = (req: AuthenticatedRequest) => req.user!.id;

  router.post('/start', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const { playlistId, templateId } = req.body ?? {};
    if (typeof playlistId !== 'string' || playlistId.length === 0) throw new ApiError(400, 'body.playlistId is required');
    if (templateId !== undefined && (typeof templateId !== 'string' || templateId.length === 0)) {
      throw new ApiError(400, 'body.templateId must be a non-empty string');
    }
    const id = userId(req as AuthenticatedRequest);
    await localStreamManager.start(id, playlistId, { templateId });
    res.status(200).json(localStreamManager.status(id));
  }));

  router.post('/stop', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const id = userId(req as AuthenticatedRequest);
    localStreamManager.stop(id);
    res.status(200).json(localStreamManager.status(id));
  }));

  router.post('/pause', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const id = userId(req as AuthenticatedRequest);
    localStreamManager.pause(id);
    res.status(200).json(localStreamManager.status(id));
  }));

  router.post('/resume', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const id = userId(req as AuthenticatedRequest);
    await localStreamManager.resume(id);
    res.status(200).json(localStreamManager.status(id));
  }));

  router.post('/next', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const id = userId(req as AuthenticatedRequest);
    await localStreamManager.next(id);
    res.status(200).json(localStreamManager.status(id));
  }));

  router.post('/previous', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const id = userId(req as AuthenticatedRequest);
    await localStreamManager.previous(id);
    res.status(200).json(localStreamManager.status(id));
  }));

  router.post('/play', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const { name } = req.body ?? {};
    if (typeof name !== 'string' || name.length === 0) throw new ApiError(400, 'body.name is required');
    const id = userId(req as AuthenticatedRequest);
    localStreamManager.playByName(id, name);
    res.status(200).json(localStreamManager.status(id));
  }));

  router.get('/status', auth, wrapAsync(async (req, res) => {
    res.status(200).json(localStreamManager.status(userId(req as AuthenticatedRequest)));
  }));

  router.get('/events', auth, wrapAsync(async (req, res) => {
    const id = userId(req as AuthenticatedRequest);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (): void => { res.write(`data: ${JSON.stringify(localStreamManager.status(id))}\n\n`); };
    send();

    const listener = (changedUserId: string): void => {
      if (changedUserId === id) send();
    };
    localStreamManager.on('statusChanged', listener);

    // Keeps intermediary proxies/load balancers from timing out an otherwise-idle connection.
    const heartbeat = setInterval(() => { res.write(':heartbeat\n\n'); }, 20000);

    req.on('close', () => {
      localStreamManager.off('statusChanged', listener);
      clearInterval(heartbeat);
    });
  }));

  router.use('/preview', createLocalStreamPreviewRouter(authService, localStreamManager, previewFetch));

  return router;
}
```

- [ ] **Step 5: Run both tests to verify they pass**

Run: `npx jest test/stream/localStreamRoutes.test.ts test/stream/localStreamEvents.test.ts`
Expected: PASS (15 + 3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/stream/localStreamRoutes.ts test/stream/localStreamRoutes.test.ts test/stream/localStreamEvents.test.ts
git commit -m "$(cat <<'EOF'
feat: add the /local-stream control, status and SSE routes

Every route is scoped to the authenticated user and takes no id — there is one
local stream per account. Mounts the HLS preview proxy at /local-stream/preview.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 8: Wire it into the composition root, config and OpenAPI

**Files:**
- Modify: `src/config/env.ts:3-16` (the `AppConfig` interface) and `src/config/env.ts:18-59`
  (`loadConfig`)
- Modify: `src/server.ts:1-26` (imports), `:88-169` (`buildServer`)
- Modify: `src/main.ts:4-28`
- Modify: `src/api/app.ts:17-23` (imports), `:27-43` (`AppDeps`), `:45-64` (`createApp`)
- Modify: `src/api/openapi.ts` — insert a new path group between the `'/stream-sessions/{id}/stop'`
  block (ends line 480) and `'/templates'` (line 481)
- Modify: `test/config/env.test.ts` (append a new describe block), `test/server.test.ts:13-26`
  (the config fixture), `test/api/openapi.test.ts:4-29` (the `buildApp` helper)

**Interfaces:**
- Consumes: `LocalRelayTarget` (Task 2), `MediaMtxAuthRegistry`/`createMediaMtxAuthApp` (Task 3),
  `StreamSceneDeps` (Task 4), `LocalStreamManager` (Task 5), `PreviewFetch` (Task 6),
  `createLocalStreamRouter` (Task 7).
- Produces:
  ```typescript
  // src/config/env.ts — added to AppConfig
  mediaMtxRtmpUrl: string;
  mediaMtxHlsUrl: string;
  mediaMtxAuthSecret: string;
  mediaMtxAuthPort: number;
  maxConcurrentLocalStreams: number;
  maxLocalStreamDurationMs: number;

  // src/server.ts
  export function createPreviewFetch(): PreviewFetch;
  export function buildServer(config: AppConfig, spawner?: Spawner):
    { app: Express; prisma: PrismaClient; mediaMtxAuthApp: Express; mediaMtxAuthPort: number };

  // src/api/app.ts — added to AppDeps
  localStreamManager: LocalStreamManager;
  previewFetch: PreviewFetch;
  ```

- [ ] **Step 1: Write the failing config test**

Append to `test/config/env.test.ts`:

```typescript
describe('loadConfig — local-first streaming additions', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    STREAM_KEY_ENCRYPTION_KEY: 'a'.repeat(64),
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    APP_BASE_URL: 'https://app.example.com',
    FRONTEND_ORIGIN: 'https://web.example.com',
  } as NodeJS.ProcessEnv;

  it('applies compose-network defaults for the MediaMTX endpoints and the caps', () => {
    const config = loadConfig({ ...base, MEDIAMTX_AUTH_SECRET: 'shared' } as NodeJS.ProcessEnv);
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/config/env.test.ts`
Expected: FAIL — `mediaMtxRtmpUrl` is `undefined` and no `MEDIAMTX_AUTH_SECRET` error is thrown.

- [ ] **Step 2b: Add `MEDIAMTX_AUTH_SECRET` to every PRE-EXISTING `base` fixture in this file**

`test/config/env.test.ts` already has five other `base`/`process.env`-shaped fixture objects, one
per existing `describe` block, each feeding several `it(...)` blocks that call `loadConfig(...)`
expecting it to *succeed*. Making `MEDIAMTX_AUTH_SECRET` required in Step 3 below is a hard throw
in `loadConfig` for every one of them unless they also carry it — this step exists so that
requirement doesn't silently break eight passing tests that have nothing to do with this feature.

Open the file and, for each existing fixture object literal that is passed into a `loadConfig(...)`
call expected to succeed elsewhere in the describe blocks above the one just added (the ones
covering the app's other defaults — session TTL, uploads/FIFO dirs, Google OAuth/App base URL,
frontend origin, and the plain "applies defaults"/"honors overrides" pair), add one line:

```typescript
    MEDIAMTX_AUTH_SECRET: 'shared',
```

Add it to the object literal itself (not as a spread override at each call site) so every `it(...)`
that reuses that fixture picks it up. Do **not** add it to `base` in the new "local-first streaming
additions" describe block above — that block deliberately tests both the missing-secret error and
the success path, and already threads it in per-test where needed.

- [ ] **Step 3: Extend `src/config/env.ts`**

Add these fields to the `AppConfig` interface (after `frontendOrigin: string;` on line 15):

```typescript
  // Where the local encode publishes and where the HLS preview proxy reads, on the compose
  // network. MediaMTX publishes no ports, so these are only ever reachable from inside it.
  mediaMtxRtmpUrl: string;
  mediaMtxHlsUrl: string;
  // Guards the unpublished authHTTP endpoint MediaMTX calls. Travels as a path segment of
  // MTX_AUTHHTTPADDRESS because MediaMTX sets no custom headers on that request.
  mediaMtxAuthSecret: string;
  mediaMtxAuthPort: number;
  maxConcurrentLocalStreams: number;
  maxLocalStreamDurationMs: number;
```

Inside `loadConfig`, read and validate the secret alongside the other required values (after
`const frontendOrigin = env.FRONTEND_ORIGIN;` on line 24):

```typescript
  const mediaMtxAuthSecret = env.MEDIAMTX_AUTH_SECRET;
```

and after the `FRONTEND_ORIGIN` guard (line 43):

```typescript
  if (!mediaMtxAuthSecret) {
    throw new Error('MEDIAMTX_AUTH_SECRET environment variable is required');
  }
```

and add to the returned object (after `frontendOrigin,` on line 57):

```typescript
    mediaMtxRtmpUrl: env.MEDIAMTX_RTMP_URL ?? 'rtmp://mediamtx:1935',
    mediaMtxHlsUrl: env.MEDIAMTX_HLS_URL ?? 'http://mediamtx:8888',
    mediaMtxAuthSecret,
    mediaMtxAuthPort: parsePositiveInt(env.MEDIAMTX_AUTH_PORT, 3001),
    // Spec open question #8. Sized against one libx264 720p30 ultrafast encode per stream.
    maxConcurrentLocalStreams: parsePositiveInt(env.MAX_CONCURRENT_LOCAL_STREAMS, 10),
    // Spec open question #7. A local stream can now run with zero destinations and zero viewers,
    // still paying for a full encode — this is the ceiling on that.
    maxLocalStreamDurationMs: parsePositiveInt(env.MAX_LOCAL_STREAM_HOURS, 12) * 60 * 60 * 1000,
```

Add this helper near the top of `src/config/env.ts` (it guards against two dangerous silent
failure modes an unvalidated `parseInt` would let through: a non-numeric
`MAX_CONCURRENT_LOCAL_STREAMS` becomes `NaN`, and `size >= NaN` is always `false` — silently
**disabling the concurrency cap entirely**; a non-numeric `MAX_LOCAL_STREAM_HOURS` becomes `NaN`,
and `setTimeout(fn, NaN * 3600000)` fires on the **very next tick** — auto-stopping every local
stream the instant it starts):

```typescript
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
```

- [ ] **Step 4: Run the config test to verify it passes**

Run: `npx jest test/config/env.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the `test/server.test.ts` fixture and add a wiring assertion**

Add the six new fields to the `config` literal at `test/server.test.ts:13-26` (after
`frontendOrigin: 'https://web.example.com',`):

```typescript
  mediaMtxRtmpUrl: 'rtmp://mediamtx:1935',
  mediaMtxHlsUrl: 'http://mediamtx:8888',
  mediaMtxAuthSecret: 'shared-secret',
  mediaMtxAuthPort: 3001,
  maxConcurrentLocalStreams: 10,
  maxLocalStreamDurationMs: 12 * 60 * 60 * 1000,
```

and add this test inside the existing `describe('buildServer', ...)` block:

```typescript
  it('builds a separate MediaMTX auth app that answers 401 for a wrong shared secret and 404 for anything else', async () => {
    const { mediaMtxAuthApp, mediaMtxAuthPort } = buildServer(config, fakeSpawner());
    expect(mediaMtxAuthPort).toBe(3001);
    expect((await request(mediaMtxAuthApp).post('/internal/mediamtx-auth/wrong').send({})).status).toBe(401);
    expect((await request(mediaMtxAuthApp).get('/openapi.json')).status).toBe(404);
  });

  it('requires authentication for the local-stream routes', async () => {
    const { app } = buildServer(config, fakeSpawner());
    expect((await request(app).get('/local-stream/status')).status).toBe(401);
    expect((await request(app).get('/local-stream/preview/index.m3u8')).status).toBe(401);
  });
```

- [ ] **Step 6: Run it to verify it fails, then wire `src/server.ts`**

Run: `npx jest test/server.test.ts` — Expected: FAIL (`mediaMtxAuthApp` is undefined, `/local-stream/status` 404s).

In `src/server.ts`, add to the imports (after line 21's `StreamSessionManager` import):

```typescript
import { LocalRelayTarget } from './stream/localRelayTarget';
import { MediaMtxAuthRegistry, createMediaMtxAuthApp } from './stream/mediaMtxAuth';
import { LocalStreamManager } from './stream/localStreamManager';
import { StreamSceneDeps } from './stream/streamScene';
import { PreviewFetch } from './stream/localStreamPreviewRoutes';
```

and, alongside `createPipeSpawner`, add the real HTTP client for the preview proxy:

```typescript
/**
 * Adapts Node 20's global fetch to the PreviewFetch seam the HLS proxy takes. The conversion from
 * a WHATWG ReadableStream to a Node readable happens here, once, so the route can pipe straight
 * through and its tests can hand it a plain Readable without touching global fetch.
 */
export function createPreviewFetch(): PreviewFetch {
  return async (url, init) => {
    const res = await fetch(url, { headers: init.headers });
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      body: res.body ? Readable.fromWeb(res.body as import('stream/web').ReadableStream) : null,
    };
  };
}
```

(add `import { Readable } from 'stream';` at the top of the file).

Inside `buildServer`, after the `streamSessionManager` block (line 142), build the local-stream
half from the scene deps the existing `StreamManager` already receives:

```typescript
  // The destination-free half of the pipeline. sceneDeps is deliberately the SAME object shape
  // StreamManager takes (StreamManagerDeps extends StreamSceneDeps), so the two paths can never
  // drift on fonts, dimensions, uploads or repositories.
  const sceneDeps: StreamSceneDeps = {
    spawner,
    pipeSpawner: createPipeSpawner(),
    fifoDir: config.fifoDir,
    defaultCoverPath: config.defaultCoverPath,
    backgroundImagePath: config.backgroundImagePath,
    fontFile: FONT_FILE,
    fontFamily: OVERLAY_FONT_FAMILY,
    playlistRepository,
    trackRepository,
    templateRepository,
    templateImageService,
  };

  const mediaMtxAuthRegistry = new MediaMtxAuthRegistry();
  const localStreamManager = new LocalStreamManager({
    sceneDeps,
    relayTarget: new LocalRelayTarget({ rtmpBaseUrl: config.mediaMtxRtmpUrl, hlsBaseUrl: config.mediaMtxHlsUrl }),
    authRegistry: mediaMtxAuthRegistry,
    maxConcurrentStreams: config.maxConcurrentLocalStreams,
    maxSessionDurationMs: config.maxLocalStreamDurationMs,
  });

  // A SEPARATE app on a SEPARATE, unpublished port: MediaMTX is not a browser and cannot present
  // the session cookie requireAuth needs, so this must never be mounted on the public API.
  const mediaMtxAuthApp = createMediaMtxAuthApp(mediaMtxAuthRegistry, config.mediaMtxAuthSecret);
```

Pass the two new deps into `createApp({ ... })` (add after `streamSessionManager,` on line 158):

```typescript
    localStreamManager,
    previewFetch: createPreviewFetch(),
```

and widen the return (line 168):

```typescript
  return { app, prisma, mediaMtxAuthApp, mediaMtxAuthPort: config.mediaMtxAuthPort };
```

- [ ] **Step 7: Mount the router in `src/api/app.ts`**

Add to the imports (after line 20):

```typescript
import { LocalStreamManager } from '../stream/localStreamManager';
import { createLocalStreamRouter } from '../stream/localStreamRoutes';
import { PreviewFetch } from '../stream/localStreamPreviewRoutes';
```

Add to `AppDeps` (after `streamSessionManager: StreamSessionManager;` on line 35):

```typescript
  localStreamManager: LocalStreamManager;
  previewFetch: PreviewFetch;
```

Add the mount inside `createApp` (after line 58's `/stream-sessions` mount):

```typescript
  app.use('/local-stream', createLocalStreamRouter(deps.authService, deps.localStreamManager, deps.previewFetch));
```

- [ ] **Step 8: Start the auth app in `src/main.ts`**

Replace the body of `main()` so both servers are started and shut down together:

```typescript
async function main(): Promise<void> {
  const config = loadConfig();
  const { app, prisma, mediaMtxAuthApp, mediaMtxAuthPort } = buildServer(config);

  await prisma.$connect();

  const server = app.listen(config.port, () => {
    console.log(`super-dj listening on port ${config.port}`);
  });

  // Deliberately a second listener on its own port, which docker-compose never publishes: only
  // MediaMTX (by compose service name) can reach it. See src/stream/mediaMtxAuth.ts.
  const authServer = mediaMtxAuthApp.listen(mediaMtxAuthPort, () => {
    console.log(`super-dj mediamtx auth endpoint listening on port ${mediaMtxAuthPort}`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await prisma.$disconnect();
    } catch (err) {
      console.error('error disconnecting from the database during shutdown', err);
    }
    authServer.close();
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', () => shutdown());
  process.on('SIGINT', () => shutdown());
}
```

- [ ] **Step 9: Update the OpenAPI test helper, then document the routes**

In `test/api/openapi.test.ts`, add to the `createApp({...})` call (after `streamSessionManager,` on
line 20):

```typescript
    localStreamManager: {} as any,
    previewFetch: jest.fn() as any,
```

and add this assertion inside `describe('API docs', ...)`:

```typescript
  it('documents the local-stream routes', async () => {
    const res = await request(buildApp()).get('/openapi.json');
    expect(res.body.paths).toHaveProperty('/local-stream/start');
    expect(res.body.paths).toHaveProperty('/local-stream/status');
    // Array form, not a dot-separated string: Jest's toHaveProperty parses a STRING keyPath as a
    // deep path, so '/local-stream/preview/index.m3u8' would look up
    // paths['/local-stream/preview/index']['m3u8'] (undefined) instead of the literal key — a
    // false failure this repo's other assertions here (`'/tracks'`, `'/auth/register'`) never hit
    // only because those keys happen to contain no dots.
    expect(res.body.paths).toHaveProperty(['/local-stream/preview/index.m3u8']);
  });
```

Then insert this block into `src/api/openapi.ts` between line 480 (`},` closing
`'/stream-sessions/{id}/stop'`) and line 481 (`'/templates': {`):

```typescript
    '/local-stream/start': {
      post: {
        summary: 'Start this account\'s single local stream — encoded once and published to the internal relay, with no destination receiving it',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['playlistId'],
                properties: {
                  playlistId: { type: 'string' },
                  templateId: { type: 'string', description: 'Optional overlay template id (see /templates). Omitted -> the built-in default layout.' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Started', content: { 'application/json': { schema: { $ref: '#/components/schemas/LocalStreamStatus' } } } },
          '400': { description: 'Missing playlistId, or an empty-string templateId' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your playlist or not your template' },
          '404': { description: 'Playlist not found, or templateId given but not found' },
          '409': { description: 'A local stream is already active (or starting) for this account, or the playlist is empty' },
          '429': { description: 'Too many local streams are running on this host' },
        },
      },
    },
    '/local-stream/stop': {
      post: { summary: 'Stop this account\'s local stream', responses: { '200': { description: 'Stopped', content: { 'application/json': { schema: { $ref: '#/components/schemas/LocalStreamStatus' } } } }, '401': { description: 'Not authenticated' }, '409': { description: 'No local stream is active' } } },
    },
    '/local-stream/pause': {
      post: { summary: 'Pause playback (the local publish itself never stops, so the preview keeps working)', responses: { '200': { description: 'Paused', content: { 'application/json': { schema: { $ref: '#/components/schemas/LocalStreamStatus' } } } }, '401': { description: 'Not authenticated' }, '409': { description: 'No local stream is active, or it is not currently streaming' } } },
    },
    '/local-stream/resume': {
      post: { summary: 'Resume playback from the paused position', responses: { '200': { description: 'Resumed', content: { 'application/json': { schema: { $ref: '#/components/schemas/LocalStreamStatus' } } } }, '401': { description: 'Not authenticated' }, '409': { description: 'No local stream is active, or it is not paused' } } },
    },
    '/local-stream/next': {
      post: { summary: 'Skip to the next track', responses: { '200': { description: 'Skipped', content: { 'application/json': { schema: { $ref: '#/components/schemas/LocalStreamStatus' } } } }, '401': { description: 'Not authenticated' }, '409': { description: 'No local stream is active' } } },
    },
    '/local-stream/previous': {
      post: { summary: 'Go back to the previous track', responses: { '200': { description: 'Moved back', content: { 'application/json': { schema: { $ref: '#/components/schemas/LocalStreamStatus' } } } }, '401': { description: 'Not authenticated' }, '409': { description: 'No local stream is active' } } },
    },
    '/local-stream/play': {
      post: {
        summary: 'Queue one of this user\'s tracks to play next',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } },
        responses: { '200': { description: 'Queued', content: { 'application/json': { schema: { $ref: '#/components/schemas/LocalStreamStatus' } } } }, '400': { description: 'Missing name' }, '401': { description: 'Not authenticated' }, '404': { description: 'Track not found in this user\'s library' }, '409': { description: 'No local stream is active' } },
      },
    },
    '/local-stream/status': {
      get: { summary: 'Current state of this account\'s local stream', responses: { '200': { description: 'Current status', content: { 'application/json': { schema: { $ref: '#/components/schemas/LocalStreamStatus' } } } }, '401': { description: 'Not authenticated' } } },
    },
    '/local-stream/events': {
      get: { summary: 'Server-Sent Events stream of this account\'s local stream status', responses: { '200': { description: 'text/event-stream — each event is a LocalStreamStatus JSON payload' }, '401': { description: 'Not authenticated' } } },
    },
    '/local-stream/preview/index.m3u8': {
      get: {
        summary: 'HLS multivariant playlist for this account\'s own local stream, proxied from the internal relay',
        description: 'The caller never names a stream or path: it is resolved server-side from the authenticated session. Responses are never cacheable. A 404 shortly after starting is normal — the relay muxes HLS on demand; retry.',
        responses: { '200': { description: 'application/vnd.apple.mpegurl' }, '401': { description: 'Not authenticated' }, '404': { description: 'The relay has not produced a playlist yet' }, '409': { description: 'No local stream is active' }, '502': { description: 'The relay could not be reached' } },
      },
    },
    '/local-stream/preview/{file}': {
      get: {
        summary: 'One HLS artefact (media playlist or segment) referenced by the multivariant playlist above',
        parameters: [{ name: 'file', in: 'path', required: true, schema: { type: 'string' }, description: 'A plain HLS file name such as stream.m3u8 or segment0.ts — anything else is rejected' }],
        responses: { '200': { description: 'The playlist or segment' }, '400': { description: 'Invalid preview file name' }, '401': { description: 'Not authenticated' }, '404': { description: 'Not produced by the relay' }, '409': { description: 'No local stream is active' }, '502': { description: 'The relay could not be reached' } },
      },
    },
```

Finally add the schema. In the `components.schemas` object (`paths` closes at line 681;
`components:` is 682, `schemas:` 683 — add inside that block), add:

```typescript
      LocalStreamStatus: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['idle', 'streaming', 'paused', 'error', 'reconnecting'] },
          currentTrack: { type: 'string', nullable: true },
          nextTrack: { type: 'string', nullable: true },
          previewReady: { type: 'boolean', description: 'True while the encoder is publishing — including while paused, since pausing only swaps the audio' },
          playlistId: { type: 'string', nullable: true },
          templateId: { type: 'string', nullable: true },
          startedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
```

- [ ] **Step 10: Run the whole backend suite and the build**

Run: `npx jest && npm run build`
Expected: PASS, clean `tsc`.

- [ ] **Step 11: Commit**

```bash
git add src/config/env.ts src/server.ts src/main.ts src/api/app.ts src/api/openapi.ts test/config/env.test.ts test/server.test.ts test/api/openapi.test.ts
git commit -m "$(cat <<'EOF'
feat: wire the local-stream pipeline into the composition root

Adds the MediaMTX endpoints, auth secret and the two new caps to AppConfig,
builds LocalStreamManager from the same scene deps StreamManager already takes,
starts the MediaMTX auth app on its own unpublished port, mounts /local-stream
and documents it in the OpenAPI spec.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 9: Frontend API client and status hook

**Files:**
- Create: `frontend/src/api/localStream.ts`
- Create: `frontend/src/api/localStream.test.ts`
- Create: `frontend/src/hooks/useLocalStreamStatus.ts`
- Create: `frontend/src/hooks/useLocalStreamStatus.test.tsx`

**Interfaces:**
- Consumes: `api`, `API_BASE_URL` from `frontend/src/api/client.ts`; `SessionState` from
  `frontend/src/api/streamSessions.ts` (already exported there — reuse it rather than declaring a
  second copy of the same union).
- Produces:
  ```typescript
  export interface LocalStreamStatus {
    state: SessionState;
    currentTrack: string | null;
    nextTrack: string | null;
    previewReady: boolean;
    playlistId: string | null;
    templateId: string | null;
    startedAt: string | null;
  }

  export const localStreamApi: {
    status(): Promise<LocalStreamStatus>;
    start(opts: { playlistId: string; templateId?: string }): Promise<LocalStreamStatus>;
    stop(): Promise<LocalStreamStatus>;
    pause(): Promise<LocalStreamStatus>;
    resume(): Promise<LocalStreamStatus>;
    next(): Promise<LocalStreamStatus>;
    previous(): Promise<LocalStreamStatus>;
    play(name: string): Promise<LocalStreamStatus>;
    eventsUrl(): string;
    previewUrl(): string;
  };

  export function useLocalStreamStatus(): UseQueryResult<LocalStreamStatus>;
  export const LOCAL_STREAM_STATUS_QUERY_KEY: readonly ['local-stream-status'];
  ```

- [ ] **Step 1: Write the failing API-client test**

Create `frontend/src/api/localStream.test.ts`:

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { localStreamApi } from './localStream';

const fetchMock = vi.fn();

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

const STATUS = {
  state: 'streaming', currentTrack: 'a', nextTrack: 'b',
  previewReady: true, playlistId: 'p1', templateId: null, startedAt: '2026-09-14T10:00:00.000Z',
};

describe('localStreamApi', () => {
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(jsonResponse(STATUS));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('starts a stream with the playlist and optional template', async () => {
    await localStreamApi.start({ playlistId: 'p1', templateId: 'tpl-1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/local-stream/start');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ playlistId: 'p1', templateId: 'tpl-1' });
  });

  it.each(['stop', 'pause', 'resume', 'next', 'previous'] as const)('posts to /local-stream/%s with no body', async (command) => {
    await localStreamApi[command]();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(`/local-stream/${command}`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('queues a track by name', async () => {
    await localStreamApi.play('Track A');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ name: 'Track A' });
  });

  // Every request carries the session cookie — the preview player depends on the same behaviour.
  it('sends credentials with every request', async () => {
    await localStreamApi.status();
    expect(fetchMock.mock.calls[0][1].credentials).toBe('include');
  });

  it('builds absolute SSE and preview URLs against the API base', async () => {
    expect(localStreamApi.eventsUrl()).toMatch(/\/local-stream\/events$/);
    expect(localStreamApi.previewUrl()).toMatch(/\/local-stream\/preview\/index\.m3u8$/);
  });
});
```

- [ ] **Step 2: Write the failing hook test**

Create `frontend/src/hooks/useLocalStreamStatus.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { useLocalStreamStatus } from './useLocalStreamStatus';
import { localStreamApi } from '../api/localStream';

vi.mock('../api/localStream');

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;
  constructor(public url: string, public opts?: EventSourceInit) { FakeEventSource.instances.push(this); }
  close() { this.closed = true; }
  emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

const IDLE = {
  state: 'idle', currentTrack: null, nextTrack: null,
  previewReady: false, playlistId: null, templateId: null, startedAt: null,
};

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('useLocalStreamStatus', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
    vi.mocked(localStreamApi.status).mockResolvedValue(IDLE as never);
    vi.mocked(localStreamApi.eventsUrl).mockReturnValue('http://api/local-stream/events');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('fetches the initial status and opens a credentialed SSE connection', async () => {
    const { result } = renderHook(() => useLocalStreamStatus(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(IDLE));
    expect(FakeEventSource.instances[0].url).toBe('http://api/local-stream/events');
    expect(FakeEventSource.instances[0].opts).toEqual({ withCredentials: true });
  });

  it('replaces the cached status when an SSE frame arrives', async () => {
    const { result } = renderHook(() => useLocalStreamStatus(), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    FakeEventSource.instances[0].emit({ ...IDLE, state: 'streaming', currentTrack: 'a', previewReady: true });
    await waitFor(() => expect(result.current.data?.state).toBe('streaming'));
    expect(result.current.data?.previewReady).toBe(true);
  });

  it('closes the EventSource on unmount', async () => {
    const { unmount } = renderHook(() => useLocalStreamStatus(), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    unmount();
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd frontend && npx vitest run src/api/localStream.test.ts src/hooks/useLocalStreamStatus.test.tsx`
Expected: FAIL — `Failed to resolve import "./localStream"`.

- [ ] **Step 4: Write `frontend/src/api/localStream.ts`**

```typescript
import { api, API_BASE_URL } from './client';
import { SessionState } from './streamSessions';

// Mirrors LocalStreamStatus in src/stream/localStreamManager.ts — kept in sync by hand, the way
// every other backend/frontend type pair in this project is.
export interface LocalStreamStatus {
  state: SessionState;
  currentTrack: string | null;
  nextTrack: string | null;
  // True while the encoder is publishing, INCLUDING while paused — pausing swaps the audio to
  // silence and never interrupts the local publish, so the preview stays watchable.
  previewReady: boolean;
  playlistId: string | null;
  templateId: string | null;
  startedAt: string | null;
}

export interface StartLocalStreamOptions {
  playlistId: string;
  templateId?: string;
}

// No destination, title, privacy or latency options: a local stream is not connected to any
// platform in this phase. Toggling destinations arrives with Phase B.
export const localStreamApi = {
  status: () => api.get<LocalStreamStatus>('/local-stream/status'),
  start: (opts: StartLocalStreamOptions) => api.post<LocalStreamStatus>('/local-stream/start', opts),
  stop: () => api.post<LocalStreamStatus>('/local-stream/stop'),
  pause: () => api.post<LocalStreamStatus>('/local-stream/pause'),
  resume: () => api.post<LocalStreamStatus>('/local-stream/resume'),
  next: () => api.post<LocalStreamStatus>('/local-stream/next'),
  previous: () => api.post<LocalStreamStatus>('/local-stream/previous'),
  play: (name: string) => api.post<LocalStreamStatus>('/local-stream/play', { name }),
  eventsUrl: () => `${API_BASE_URL}/local-stream/events`,
  // Absolute, because hls.js loads it itself rather than going through the `api` wrapper. The
  // backend resolves which stream this is from the session cookie — there is no id in this URL by
  // design.
  previewUrl: () => `${API_BASE_URL}/local-stream/preview/index.m3u8`,
};
```

- [ ] **Step 5: Write `frontend/src/hooks/useLocalStreamStatus.ts`**

```typescript
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { localStreamApi, LocalStreamStatus } from '../api/localStream';

// Exported so pages can seed this cache from a mutation response instead of refetching.
export const LOCAL_STREAM_STATUS_QUERY_KEY = ['local-stream-status'] as const;

export function useLocalStreamStatus() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: LOCAL_STREAM_STATUS_QUERY_KEY,
    queryFn: () => localStreamApi.status(),
  });

  useEffect(() => {
    const source = new EventSource(localStreamApi.eventsUrl(), { withCredentials: true });
    source.onmessage = (event) => {
      const status: LocalStreamStatus = JSON.parse(event.data);
      queryClient.setQueryData(LOCAL_STREAM_STATUS_QUERY_KEY, status);
    };
    return () => source.close();
  }, [queryClient]);

  return query;
}
```

- [ ] **Step 6: Run both to verify they pass**

Run: `cd frontend && npx vitest run src/api/localStream.test.ts src/hooks/useLocalStreamStatus.test.tsx`
Expected: PASS (10 + 3 tests).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/localStream.ts frontend/src/api/localStream.test.ts frontend/src/hooks/useLocalStreamStatus.ts frontend/src/hooks/useLocalStreamStatus.test.tsx
git commit -m "$(cat <<'EOF'
feat(frontend): add the local-stream API client and SSE status hook

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `HlsPlayer` — the embedded preview

**Files:**
- Create: `frontend/src/components/HlsPlayer.tsx`
- Create: `frontend/src/components/HlsPlayer.test.tsx`
- Modify: `frontend/package.json:12-28` (dependencies)

**Interfaces:**
- Consumes: `hls.js` (new dependency).
- Produces:
  ```typescript
  export interface HlsPlayerProps {
    src: string;
    className?: string;
    // Rendered in place of the <video> when the browser can play neither MSE- nor native HLS.
    unsupportedMessage: string;
  }
  export function HlsPlayer(props: HlsPlayerProps): JSX.Element;
  ```

- [ ] **Step 1: Add the dependency**

```bash
cd frontend && npm install hls.js@^1.5.17
```

- [ ] **Step 2: Write the failing test**

Create `frontend/src/components/HlsPlayer.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HlsPlayer } from './HlsPlayer';

const attachMedia = vi.fn();
const loadSource = vi.fn();
const destroy = vi.fn();
const on = vi.fn();
const startLoad = vi.fn();
const constructorSpy = vi.fn();

vi.mock('hls.js', () => {
  class FakeHls {
    static Events = { ERROR: 'hlsError' };
    static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
    static isSupported = vi.fn(() => true);
    constructor(config: unknown) { constructorSpy(config); }
    attachMedia = attachMedia;
    loadSource = loadSource;
    destroy = destroy;
    on = on;
    startLoad = startLoad;
    recoverMediaError = vi.fn();
  }
  return { default: FakeHls };
});

import Hls from 'hls.js';

describe('HlsPlayer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (Hls.isSupported as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  it('attaches hls.js to the video element and loads the source', () => {
    render(<HlsPlayer src="http://api/local-stream/preview/index.m3u8" unsupportedMessage="no hls" />);
    expect(attachMedia).toHaveBeenCalledWith(screen.getByTestId('hls-video'));
    expect(loadSource).toHaveBeenCalledWith('http://api/local-stream/preview/index.m3u8');
  });

  // Without this the session cookie is never sent and every playlist/segment request 401s. This is
  // the single most load-bearing line in the component.
  it('configures hls.js to send credentials on every playlist and segment request', () => {
    render(<HlsPlayer src="http://api/x.m3u8" unsupportedMessage="no hls" />);
    const config = constructorSpy.mock.calls[0][0];
    const xhr = { withCredentials: false } as XMLHttpRequest;
    config.xhrSetup(xhr, 'http://api/x.m3u8');
    expect(xhr.withCredentials).toBe(true);
  });

  // MediaMTX muxes HLS on demand, so the first request after a start can legitimately 404.
  it('retries loading on a fatal network error instead of giving up', () => {
    render(<HlsPlayer src="http://api/x.m3u8" unsupportedMessage="no hls" />);
    const handler = on.mock.calls.find(([event]) => event === 'hlsError')![1];
    handler('hlsError', { type: 'networkError', fatal: true });
    expect(startLoad).toHaveBeenCalled();
  });

  it('destroys the hls instance on unmount so a hidden player stops fetching segments', () => {
    const { unmount } = render(<HlsPlayer src="http://api/x.m3u8" unsupportedMessage="no hls" />);
    unmount();
    expect(destroy).toHaveBeenCalled();
  });

  it('rebuilds the player when the source changes', () => {
    const { rerender } = render(<HlsPlayer src="http://api/a.m3u8" unsupportedMessage="no hls" />);
    rerender(<HlsPlayer src="http://api/b.m3u8" unsupportedMessage="no hls" />);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(loadSource).toHaveBeenLastCalledWith('http://api/b.m3u8');
  });

  it('falls back to the browser\'s native player when MSE-based hls.js is unsupported', () => {
    (Hls.isSupported as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const canPlayType = vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe');
    render(<HlsPlayer src="http://api/native.m3u8" unsupportedMessage="no hls" />);
    expect(screen.getByTestId('hls-video')).toHaveAttribute('src', 'http://api/native.m3u8');
    expect(attachMedia).not.toHaveBeenCalled();
    canPlayType.mockRestore();
  });

  it('shows the unsupported message when neither path is available', () => {
    (Hls.isSupported as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const canPlayType = vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');
    render(<HlsPlayer src="http://api/x.m3u8" unsupportedMessage="Your browser cannot play this preview." />);
    expect(screen.getByText('Your browser cannot play this preview.')).toBeInTheDocument();
    canPlayType.mockRestore();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/components/HlsPlayer.test.tsx`
Expected: FAIL — `Failed to resolve import "./HlsPlayer"`.

- [ ] **Step 4: Write the component**

Create `frontend/src/components/HlsPlayer.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

export interface HlsPlayerProps {
  src: string;
  className?: string;
  unsupportedMessage: string;
}

/**
 * Plays the backend's proxied HLS preview.
 *
 * Two things here are load-bearing and must not be "simplified" away:
 *  - `xhrSetup` sets `withCredentials`. The playlist and every segment are cross-origin requests to
 *    the API, and the backend resolves WHICH stream to serve from the session cookie — without
 *    this, every request 401s and the player just shows an error with no obvious cause.
 *  - A fatal network error calls `startLoad()` again rather than surfacing a failure. The relay
 *    muxes HLS on demand, so the first playlist request after a start legitimately 404s for a
 *    moment.
 *
 * Known limitation (documented in the design spec, not solved here): on iOS Safari `Hls.isSupported()`
 * is false and the native fallback below fetches the playlist itself, which will not attach a
 * cross-site cookie — the preview silently fails there.
 */
export function HlsPlayer({ src, className, unsupportedMessage }: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;

    if (Hls.isSupported()) {
      setSupported(true);
      const hls = new Hls({
        xhrSetup: (xhr: XMLHttpRequest) => { xhr.withCredentials = true; },
        // The relay keeps 7 short segments; there is no long back-buffer worth holding on to for a
        // live monitor view.
        backBufferLength: 30,
      });
      hls.on(Hls.Events.ERROR, (_event: unknown, data: { type: string; fatal: boolean }) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        }
      });
      hls.attachMedia(video);
      hls.loadSource(src);
      return () => hls.destroy();
    }

    // Safari and other native-HLS browsers: no MSE needed, the element plays the playlist itself.
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      setSupported(true);
      video.src = src;
      return undefined;
    }

    setSupported(false);
    return undefined;
  }, [src]);

  return (
    <div className={className}>
      <video
        ref={videoRef}
        data-testid="hls-video"
        controls
        muted
        playsInline
        autoPlay
        className="w-full rounded bg-black"
      />
      {!supported && <p className="mt-2 text-sm text-red-600">{unsupportedMessage}</p>}
    </div>
  );
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd frontend && npx vitest run src/components/HlsPlayer.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/components/HlsPlayer.tsx frontend/src/components/HlsPlayer.test.tsx
git commit -m "$(cat <<'EOF'
feat(frontend): add an hls.js preview player

Sends credentials on every playlist and segment request (the backend resolves
the stream from the session cookie) and retries fatal network errors, since the
relay muxes HLS on demand and can legitimately 404 right after a start.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 11: The `/local-stream` page, its route, nav link and copy

**Where this lives, and why (the architectural call this task makes explicit):** the local stream
gets its **own page at `/local-stream` and its own sidebar entry**, sitting alongside the existing
`/streams` session UI rather than being folded into `StreamSessionPanel.tsx`. The two models are
genuinely different objects for the length of Phase A — a `StreamSession` is a persisted row
fanning one playlist out to N destinations, while a local stream is a single in-memory per-account
encode with no destination at all — and merging them would mean a component that renders two
mutually exclusive shapes behind conditionals, in a file that Phase C is going to rewrite anyway.
Keeping them apart also preserves the phase's revert story: nothing in the existing streams flow is
touched, so if Phase A has to be backed out, only new files disappear. Phase C then deletes
`Streams.tsx`/`StreamSessionPanel.tsx` and promotes this page (plus its destination toggles) to the
single stream UI.

**Files:**
- Create: `frontend/src/pages/LocalStream.tsx`
- Create: `frontend/src/pages/LocalStream.test.tsx`
- Modify: `frontend/src/App.tsx:1-16` (imports) and `:29-41` (routes)
- Modify: `frontend/src/components/Sidebar.tsx:9-15` (the `links` array)
- Modify: `frontend/src/i18n/locales/en.json`, `ru.json`, `uk.json` — insert a `localStream`
  section between the existing `streamState` block and the final `drawer` block, and add one
  `sidebar.localStream` key

**Interfaces:**
- Consumes: `localStreamApi`, `LocalStreamStatus` (Task 9); `useLocalStreamStatus`,
  `LOCAL_STREAM_STATUS_QUERY_KEY` (Task 9); `HlsPlayer` (Task 10); `playlistsApi`
  (`frontend/src/api/playlists.ts`); `templatesApi` (`frontend/src/api/templates.ts`); `ApiError`
  (`frontend/src/api/client.ts`); `usePageTitle` (`frontend/src/hooks/usePageTitle.ts`).
- Produces: a default-exported `LocalStream` page component, routed at `/local-stream`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/pages/LocalStream.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LocalStream from './LocalStream';
import { useLocalStreamStatus } from '../hooks/useLocalStreamStatus';
import { localStreamApi } from '../api/localStream';
import { playlistsApi } from '../api/playlists';
import { templatesApi } from '../api/templates';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../hooks/useLocalStreamStatus');
vi.mock('../api/localStream');
vi.mock('../api/playlists');
vi.mock('../api/templates');
vi.mock('../components/HlsPlayer', () => ({
  HlsPlayer: ({ src }: { src: string }) => <div data-testid="hls-player">{src}</div>,
}));

const IDLE = {
  state: 'idle', currentTrack: null, nextTrack: null,
  previewReady: false, playlistId: null, templateId: null, startedAt: null,
} as const;

const LIVE = {
  state: 'streaming', currentTrack: 'Track A', nextTrack: 'Track B',
  previewReady: true, playlistId: 'p1', templateId: null, startedAt: '2026-09-14T10:00:00.000Z',
} as const;

function mockStatus(data: unknown) {
  vi.mocked(useLocalStreamStatus).mockReturnValue({ data } as never);
}

describe('LocalStream page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(playlistsApi.list).mockResolvedValue([{ id: 'p1', name: 'Friday Mix' }]);
    vi.mocked(templatesApi.list).mockResolvedValue([{ id: 'tpl-1', name: 'Neon' }] as never);
    vi.mocked(localStreamApi.previewUrl).mockReturnValue('http://api/local-stream/preview/index.m3u8');
  });

  it('shows the start form and no player when nothing is running', async () => {
    mockStatus(IDLE);
    renderWithProviders(<LocalStream />);
    expect(await screen.findByLabelText('Playlist')).toBeInTheDocument();
    expect(screen.queryByTestId('hls-player')).not.toBeInTheDocument();
  });

  it('starts a stream with the chosen playlist and template', async () => {
    mockStatus(IDLE);
    vi.mocked(localStreamApi.start).mockResolvedValue(LIVE as never);
    renderWithProviders(<LocalStream />);
    await userEvent.selectOptions(await screen.findByLabelText('Playlist'), 'p1');
    await userEvent.selectOptions(screen.getByLabelText('Overlay template'), 'tpl-1');
    await userEvent.click(screen.getByRole('button', { name: 'Start local stream' }));
    await waitFor(() => expect(localStreamApi.start).toHaveBeenCalledWith({ playlistId: 'p1', templateId: 'tpl-1' }));
  });

  it('sends no templateId when none is chosen', async () => {
    mockStatus(IDLE);
    vi.mocked(localStreamApi.start).mockResolvedValue(LIVE as never);
    renderWithProviders(<LocalStream />);
    await userEvent.selectOptions(await screen.findByLabelText('Playlist'), 'p1');
    await userEvent.click(screen.getByRole('button', { name: 'Start local stream' }));
    await waitFor(() => expect(localStreamApi.start).toHaveBeenCalledWith({ playlistId: 'p1', templateId: undefined }));
  });

  it('renders the player and the transport controls once the preview is ready', async () => {
    mockStatus(LIVE);
    renderWithProviders(<LocalStream />);
    expect(await screen.findByTestId('hls-player')).toHaveTextContent('http://api/local-stream/preview/index.m3u8');
    expect(screen.getByText('Now playing: Track A · Next: Track B')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '⏹ Stop' })).toBeInTheDocument();
  });

  it('shows a placeholder instead of the player while the stream is starting but not yet publishing', async () => {
    mockStatus({ ...LIVE, previewReady: false });
    renderWithProviders(<LocalStream />);
    expect(await screen.findByText('Preview is starting…')).toBeInTheDocument();
    expect(screen.queryByTestId('hls-player')).not.toBeInTheDocument();
  });

  it.each([
    ['⏮ Previous', 'previous'], ['⏸ Pause', 'pause'], ['⏭ Next', 'next'], ['⏹ Stop', 'stop'],
  ] as const)('sends %s to the backend', async (label, method) => {
    mockStatus(LIVE);
    vi.mocked(localStreamApi[method]).mockResolvedValue(LIVE as never);
    renderWithProviders(<LocalStream />);
    await userEvent.click(await screen.findByRole('button', { name: label }));
    await waitFor(() => expect(localStreamApi[method]).toHaveBeenCalled());
  });

  it('offers Resume instead of Pause while paused', async () => {
    mockStatus({ ...LIVE, state: 'paused' });
    vi.mocked(localStreamApi.resume).mockResolvedValue(LIVE as never);
    renderWithProviders(<LocalStream />);
    await userEvent.click(await screen.findByRole('button', { name: '▶ Resume' }));
    await waitFor(() => expect(localStreamApi.resume).toHaveBeenCalled());
  });

  // Zero destinations is a fully valid running state in this model, not a degenerate one — the UI
  // has to say so out loud or it reads as "something is missing".
  it('states plainly that nothing is being forwarded anywhere', async () => {
    mockStatus(LIVE);
    renderWithProviders(<LocalStream />);
    expect(await screen.findByText('This stream is local only — nothing is being sent to any platform.')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/pages/LocalStream.test.tsx`
Expected: FAIL — `Failed to resolve import "./LocalStream"`.

- [ ] **Step 3: Add the copy to all three locale files**

In `frontend/src/i18n/locales/en.json`, add `"localStream": "Local stream",` to the `sidebar`
object (after `"streams": "Streams",` on line 9), and insert this block between the `streamState`
block's closing `},` (line 293) and `"drawer": {` (line 294):

```json
  "localStream": {
    "title": "Local stream",
    "subtitle": "One encode, running on this server. Watch it here before sending it anywhere.",
    "playlistLabel": "Playlist",
    "selectPlaylist": "Select a playlist…",
    "templateLabel": "Overlay template",
    "noTemplate": "No template (default look)",
    "startButton": "Start local stream",
    "starting": "Starting…",
    "startFailed": "Failed to start the local stream",
    "commandFailed": "The command failed",
    "previous": "⏮ Previous",
    "pause": "⏸ Pause",
    "resume": "▶ Resume",
    "next": "⏭ Next",
    "stop": "⏹ Stop",
    "nowPlayingNext": "Now playing: {{track}} · Next: {{next}}",
    "previewStarting": "Preview is starting…",
    "previewUnsupported": "Your browser cannot play this preview.",
    "localOnlyNotice": "This stream is local only — nothing is being sent to any platform."
  },
```

Add the same keys, in the same order, to `ru.json` and `uk.json` with Russian and Ukrainian text
(match the tone of the neighbouring `streams`/`streamSessionPanel` sections; keep the emoji
prefixes on the transport labels identical to `streamSessionPanel`'s).

- [ ] **Step 4: Write `frontend/src/pages/LocalStream.tsx`**

```tsx
import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { localStreamApi, LocalStreamStatus } from '../api/localStream';
import { useLocalStreamStatus, LOCAL_STREAM_STATUS_QUERY_KEY } from '../hooks/useLocalStreamStatus';
import { playlistsApi } from '../api/playlists';
import { templatesApi } from '../api/templates';
import { ApiError } from '../api/client';
import { HlsPlayer } from '../components/HlsPlayer';
import { usePageTitle } from '../hooks/usePageTitle';

export default function LocalStream() {
  const { t } = useTranslation();
  usePageTitle(t('localStream.title'));
  const queryClient = useQueryClient();
  const statusQuery = useLocalStreamStatus();
  const playlistsQuery = useQuery({ queryKey: ['playlists'], queryFn: playlistsApi.list });
  const templatesQuery = useQuery({ queryKey: ['templates'], queryFn: templatesApi.list });

  const [playlistId, setPlaylistId] = useState('');
  const [templateId, setTemplateId] = useState('');

  // Every command returns the fresh status, so seed the cache from it directly rather than
  // refetching — the SSE stream will keep it current from there.
  const applyStatus = (status: LocalStreamStatus) => queryClient.setQueryData(LOCAL_STREAM_STATUS_QUERY_KEY, status);

  const startMutation = useMutation({
    mutationFn: () => localStreamApi.start({ playlistId, templateId: templateId || undefined }),
    onSuccess: applyStatus,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('localStream.startFailed')),
  });

  function useCommand(fn: () => Promise<LocalStreamStatus>) {
    return useMutation({
      mutationFn: fn,
      onSuccess: applyStatus,
      onError: (err) => toast.error(err instanceof ApiError ? err.message : t('localStream.commandFailed')),
    });
  }

  const previousMutation = useCommand(localStreamApi.previous);
  const pauseMutation = useCommand(localStreamApi.pause);
  const resumeMutation = useCommand(localStreamApi.resume);
  const nextMutation = useCommand(localStreamApi.next);
  const stopMutation = useCommand(localStreamApi.stop);

  const status = statusQuery.data;
  // 'idle' and 'error' both mean "nothing is running" from the user's point of view — both should
  // show the start form rather than dead transport controls.
  const isRunning = status !== undefined && status.state !== 'idle' && status.state !== 'error';

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!playlistId) return;
    startMutation.mutate();
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('localStream.title')}</h1>
        <p className="mt-1 text-sm text-gray-500">{t('localStream.subtitle')}</p>
      </div>

      {!isRunning && (
        <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border p-4">
          <div>
            <label htmlFor="local-playlist" className="block text-sm font-medium">{t('localStream.playlistLabel')}</label>
            <select
              id="local-playlist"
              className="mt-1 w-full rounded border px-3 py-2"
              value={playlistId}
              onChange={(e) => setPlaylistId(e.target.value)}
              required
            >
              <option value="">{t('localStream.selectPlaylist')}</option>
              {playlistsQuery.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>

          <div>
            <label htmlFor="local-template" className="block text-sm font-medium">{t('localStream.templateLabel')}</label>
            <select
              id="local-template"
              className="mt-1 w-full rounded border px-3 py-2"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              <option value="">{t('localStream.noTemplate')}</option>
              {templatesQuery.data?.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              <Link to="/templates" className="underline">{t('startStreamDrawer.manageTemplates')}</Link>
            </p>
          </div>

          <button
            type="submit"
            disabled={!playlistId || startMutation.isPending}
            className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50"
          >
            {startMutation.isPending ? t('localStream.starting') : t('localStream.startButton')}
          </button>
        </form>
      )}

      {isRunning && status && (
        <>
          <div className="rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">
                {t('localStream.nowPlayingNext', { track: status.currentTrack ?? '—', next: status.nextTrack ?? '—' })}
              </span>
              <span className="text-xs text-gray-500">{t(`streamState.${status.state}`)}</span>
            </div>
            {/* Zero destinations is a normal, fully valid running state in this model — say so
                rather than letting the page read as if something failed to connect. */}
            <p className="mt-2 text-xs text-gray-500">{t('localStream.localOnlyNotice')}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={() => previousMutation.mutate()} className="rounded border px-3 py-2">{t('localStream.previous')}</button>
              {status.state === 'paused'
                ? <button onClick={() => resumeMutation.mutate()} className="rounded border px-3 py-2">{t('localStream.resume')}</button>
                : <button onClick={() => pauseMutation.mutate()} className="rounded border px-3 py-2">{t('localStream.pause')}</button>}
              <button onClick={() => nextMutation.mutate()} className="rounded border px-3 py-2">{t('localStream.next')}</button>
              <button onClick={() => stopMutation.mutate()} className="rounded border px-3 py-2 text-red-600">{t('localStream.stop')}</button>
            </div>
          </div>

          {/* Mounting the player only once previewReady is true keeps it from hammering the proxy
              with 404s while the relay is still spinning its on-demand HLS muxer up. */}
          {status.previewReady
            ? <HlsPlayer src={localStreamApi.previewUrl()} unsupportedMessage={t('localStream.previewUnsupported')} />
            : <p className="rounded-lg border p-4 text-sm text-gray-500">{t('localStream.previewStarting')}</p>}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Add the route and the nav link**

In `frontend/src/App.tsx`, add the import after line 16 (`import TemplateEditor ...`):

```tsx
import LocalStream from './pages/LocalStream';
```

and the route after line 37 (`<Route path="/streams/:id" ... />`):

```tsx
                <Route path="/local-stream" element={<LocalStream />} />
```

In `frontend/src/components/Sidebar.tsx`, add an entry to the `links` array after
`{ to: '/streams', label: t('sidebar.streams') },` (line 14):

```tsx
    { to: '/local-stream', label: t('sidebar.localStream') },
```

- [ ] **Step 6: Run the whole frontend suite**

Run: `cd frontend && npm test`
Expected: PASS, including the pre-existing `Sidebar.test.tsx` (it asserts on the rendered links —
if it asserts an exact link count or list, update it to include the new entry) and
`src/pages/LocalStream.test.tsx` (10 tests). Then run `npm run build` for a clean `tsc -b`.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/LocalStream.tsx frontend/src/pages/LocalStream.test.tsx frontend/src/App.tsx frontend/src/components/Sidebar.tsx frontend/src/i18n/locales frontend/src/components/Sidebar.test.tsx
git commit -m "$(cat <<'EOF'
feat(frontend): add the local stream page with an embedded preview

Its own page and nav entry alongside the existing sessions UI, which stays
untouched until Phase C. Says plainly that nothing is being forwarded — zero
destinations is a valid running state in this model, not a failure.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 12: Real-binary smoke test against a real MediaMTX, and the docs

Every unit test above fakes ffmpeg and MediaMTX. This project's track record says that is exactly
where the bugs hide (the two-FIFO deadlock, the `Buffer`/`Uint8Array` piscina corruption, the
odd-coordinate overlay displacement, the `-stream_loop` gif freeze — all found against real
binaries, none by reasoning about code). Three Phase A assumptions **cannot** be verified any other
way:

1. **ffmpeg accepts a query string on an RTMP output URL** and hands MediaMTX `app=live`,
   `playpath=<token>`, `query=user=pub&pass=<secret>`. The whole "zero signature change" design
   rests on this.
2. **MediaMTX's `authHTTP` request body matches what `MediaMtxAuthRegistry.authorize` expects** —
   in particular that `path` arrives as `live/<token>` with no leading slash, and that `action` is
   the literal `publish`/`read`.
3. **A late-joining HLS reader gets a playable stream**, and the first `index.m3u8` request after a
   start behaves the way the proxy and player assume (on-demand muxing, brief 404, then 200).

Run this on the remote docker host `192.168.14.26` (passwordless SSH). **Touch nothing that is
already running there**: everything below is created with a `superdj-smoke-` prefix on its own
isolated network, publishes no ports at all, and is torn down at the end.

**Files:**
- Modify: `CLAUDE.md` (architecture, HTTP API, configuration, known follow-ups)

**Interfaces:**
- Consumes: everything from Tasks 1-11.
- Produces: no code — a verified pipeline plus the documentation update.

- [ ] **Step 1: Stage the config and a throwaway auth stub on the remote host**

```bash
ssh 192.168.14.26 'mkdir -p /tmp/superdj-smoke'
scp docker/mediamtx.yml 192.168.14.26:/tmp/superdj-smoke/mediamtx.yml
ssh 192.168.14.26 'cat > /tmp/superdj-smoke/auth.js' <<'EOF'
// Stands in for createMediaMtxAuthApp with one hard-coded session, so this smoke test exercises
// the REAL MediaMTX -> HTTP -> allow/deny path without needing Postgres or the whole backend.
const http = require('http');
const TOKEN = 'abcdef0123456789abcdef0123456789';
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* fall through to deny */ }
    console.log('AUTH', req.url, JSON.stringify(parsed));
    const ok = req.url === '/internal/mediamtx-auth/smoke-secret'
      && parsed.path === `live/${TOKEN}`
      && ((parsed.action === 'publish' && parsed.user === 'pub' && parsed.password === 'pubsecret')
        || (parsed.action === 'read' && parsed.user === 'sub' && parsed.password === 'readsecret'));
    res.writeHead(ok ? 200 : 401).end();
  });
}).listen(3001, () => console.log('auth stub listening'));
EOF
```

- [ ] **Step 2: Bring up an isolated network, the auth stub and MediaMTX**

```bash
ssh 192.168.14.26 '
  docker network create superdj-smoke-net &&
  docker run -d --rm --name superdj-smoke-auth --network superdj-smoke-net \
    --network-alias super-dj -v /tmp/superdj-smoke:/app:ro node:20-bookworm-slim node /app/auth.js &&
  docker run -d --rm --name superdj-smoke-mtx --network superdj-smoke-net \
    -e MTX_AUTHHTTPADDRESS=http://super-dj:3001/internal/mediamtx-auth/smoke-secret \
    -v /tmp/superdj-smoke/mediamtx.yml:/mediamtx.yml:ro bluenviron/mediamtx:1.21.0 &&
  sleep 3 && docker logs superdj-smoke-mtx'
```

Expected: MediaMTX starts and logs `[RTMP] listener opened on :1935` and
`[HLS] listener opened on :8888`. If it exits complaining about `authHTTPAddress`, the env override
is not reaching it — fix that before going further (it is the fail-closed behaviour working).

- [ ] **Step 2b: Build the project's own image — the smoke test must use the SAME ffmpeg the app ships**

The whole point of this task is verifying how a real ffmpeg parses
`rtmp://.../live/<token>?user=pub&pass=<secret>` into `app`/`playpath`/query — a generic
third-party ffmpeg image (e.g. `linuxserver/ffmpeg`) is very likely built against a different RTMP
implementation (e.g. linked against librtmp) than Debian bookworm's `ffmpeg` this app's own
`Dockerfile` installs and actually runs in production. Verifying the wrong binary defeats the
purpose this task exists for.

```bash
ssh 192.168.14.26 'cd ~/repos/super-dj && docker build -t superdj-smoke .'
```

- [ ] **Step 3: Verify assumption 1 and 2 — publish with the query-string credential**

```bash
ssh 192.168.14.26 '
  docker run -d --rm --name superdj-smoke-pub --network superdj-smoke-net \
    --entrypoint ffmpeg superdj-smoke \
    -re -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440:sample_rate=44100 \
    -c:v libx264 -preset ultrafast -tune stillimage -pix_fmt yuv420p -g 60 -c:a aac -b:a 192k \
    -f flv "rtmp://superdj-smoke-mtx:1935/live/abcdef0123456789abcdef0123456789?user=pub&pass=pubsecret" &&
  sleep 8 && docker logs superdj-smoke-auth && docker logs superdj-smoke-mtx | tail -20'
```

Expected, and **record the exact `AUTH` line in the CLAUDE.md note**: the stub logs
`AUTH /internal/mediamtx-auth/smoke-secret {"ip":...,"user":"pub","password":"pubsecret","action":"publish","path":"live/abcdef0123456789abcdef0123456789","protocol":"rtmp",...}`
and MediaMTX logs `is publishing to path 'live/abcdef...'`. If `path` carries a leading slash, or
the credentials arrive empty, **stop and fix `LocalRelayTarget`/`MediaMtxAuthRegistry` before going
on** — this is precisely the class of assumption unit tests cannot check.

- [ ] **Step 4: Verify the deny path really denies**

```bash
ssh 192.168.14.26 '
  docker run --rm --network superdj-smoke-net --entrypoint ffmpeg superdj-smoke \
    -re -f lavfi -i testsrc2=size=320x240:rate=15 -c:v libx264 -preset ultrafast -t 3 \
    -f flv "rtmp://superdj-smoke-mtx:1935/live/abcdef0123456789abcdef0123456789?user=pub&pass=WRONG" ; echo "exit=$?"'
```

Expected: ffmpeg fails to publish (non-zero exit), and MediaMTX logs an authentication failure.
Repeat once with a path that does not match the regex (e.g. `live/short`) and confirm MediaMTX
rejects it **without** the auth stub logging anything at all — that proves Layer 1 short-circuits
ahead of Layer 2.

- [ ] **Step 5: Verify assumption 3 — the HLS read leg, with credentials**

```bash
ssh 192.168.14.26 '
  docker run --rm --network superdj-smoke-net curlimages/curl:8.10.1 -sv -o /dev/null \
    "http://superdj-smoke-mtx:8888/live/abcdef0123456789abcdef0123456789/index.m3u8" ;
  echo "--- with credentials ---" ;
  docker run --rm --network superdj-smoke-net curlimages/curl:8.10.1 -s -u sub:readsecret \
    "http://superdj-smoke-mtx:8888/live/abcdef0123456789abcdef0123456789/index.m3u8"'
```

Expected: the unauthenticated request is refused (401); the credentialed one returns an `#EXTM3U`
multivariant playlist. **Record the exact file names it references** (expected `stream.m3u8`, whose
own playlist references `segment*.ts`) and confirm every reference is **relative** — the proxy does
no playlist rewriting, so an absolute reference would break the preview and would need fixing in
`localStreamPreviewRoutes.ts`. Then fetch the media playlist and one segment the same way and
confirm both return 200 with non-empty bodies. Finally, note whether the FIRST `index.m3u8` request
after a fresh publish 404s before succeeding — that is the behaviour `HlsPlayer`'s network-error
retry exists for.

- [ ] **Step 6: Tear everything down**

```bash
ssh 192.168.14.26 '
  docker rm -f superdj-smoke-pub superdj-smoke-mtx superdj-smoke-auth 2>/dev/null;
  docker network rm superdj-smoke-net 2>/dev/null;
  rm -rf /tmp/superdj-smoke; echo "cleaned"'
```

Verify with `ssh 192.168.14.26 'docker ps --format "{{.Names}}" | grep superdj-smoke; echo done'`
that nothing remains, and that **no pre-existing container or network was touched**.

- [ ] **Step 7: Update `CLAUDE.md`**

Make these edits, each in the section named:

1. **Architecture — "Backend streaming pipeline"**: after the `StreamManager` bullet, add a
   `LocalStreamManager` bullet describing the local-first path — one `StreamController` per
   `userId`, `buildStreamScene()` as the shared destination-free scene resolver, the encoder
   pushing into MediaMTX instead of a real destination, and the per-host concurrency cap (10) and
   maximum session duration (12h) with the reasons from the decisions table above. Say explicitly
   that `/destinations/{id}/stream/*` and `/stream-sessions/*` are unchanged and still the only
   way to reach a real platform until Phase B.
2. **Architecture — a new "Local relay (MediaMTX)" paragraph**: the three security layers, the
   pinned image, the no-published-ports rule *with its reason and a pointer to
   `test/infra/mediamtxConfig.test.ts`*, the query-string (not userinfo) RTMP credential form, the
   shared secret travelling as a URL path segment because MediaMTX sets no custom headers, and the
   exact `AUTH` request body recorded in Step 3.
3. **Layout**: add `docker/mediamtx.yml` and the five new `src/stream/*` files with one-line
   descriptions, plus the new frontend files.
4. **HTTP API**: add the `/local-stream/*` block, including the preview routes and the note that
   the client never names a path.
5. **Configuration**: add `MEDIAMTX_AUTH_SECRET` to the required list and
   `MEDIAMTX_RTMP_URL`/`MEDIAMTX_HLS_URL`/`MEDIAMTX_AUTH_PORT`/`MAX_CONCURRENT_LOCAL_STREAMS`/
   `MAX_LOCAL_STREAM_HOURS` to the optional list with their defaults.
6. **Known follow-ups**: add — (a) MediaMTX is now a shared single point of failure: its crash
   takes down every tenant's local stream at once, mitigated only by `restart: unless-stopped`, a
   memory limit and the pinned version; (b) iOS Safari cannot play the preview (native HLS will not
   attach the cross-site cookie); a short-lived signed query token would fix it; (c) a publisher
   that survives a Node *crash* (not a container restart) keeps its connection, because revocation
   is in-memory and MediaMTX's control API is deliberately disabled, so nothing can kick it —
   mitigate later with MediaMTX read/write timeouts; (d) local-stream state is in-memory, so a
   backend restart drops every local stream, matching this app's existing choice for stream state;
   (e) `buildStreamScene`'s `overlayCache`/`sessionId` parameters exist only for the legacy
   multi-destination path and are deleted with `SessionOverlayCache` in Phase C; (f) the per-session
   publish secret lands in plaintext in `docker logs` for the backend container, because
   `createPipeSpawner` forwards ffmpeg's stderr verbatim and ffmpeg logs its own output URL
   (`Output #0, flv, to 'rtmp://mediamtx:1935/live/<token>?user=pub&pass=<secret>'`) on startup —
   the same class of leak the design's "why not let MediaMTX forward" section rejected `runOnReady`
   for, now happening one hop over; (g) the shared `MEDIAMTX_AUTH_SECRET`, carried as a path segment
   of `authHTTPAddress` rather than a header (MediaMTX sets no custom headers on its auth callback —
   see Global Constraints), lands in MediaMTX's own logs on any connection failure to that endpoint
   (`Post "http://super-dj:3001/internal/mediamtx-auth/<SECRET>": dial tcp ... connection refused`),
   which routine backend restarts will trigger. Neither (f) nor (g) is fixed in Phase A; both are
   acceptable for now on the same footing as this app's existing secrets-in-process-args tolerance
   (destination stream keys are already visible to `ps` inside their own container), but should be
   revisited — e.g. redacting the trailing URL in the stderr forwarder — before this leaves a single
   trusted deployment.

- [ ] **Step 8: Full verification**

Run, and confirm each passes before claiming the phase is done:

```bash
npx jest && npm run build
cd frontend && npm test && npm run build
```

- [ ] **Step 9: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: record the local-first streaming pipeline and its smoke-test findings

Covers the MediaMTX trust boundary, the query-string RTMP credential form
verified against a real binary, the new /local-stream API, the new env vars, and
the follow-ups this phase knowingly leaves open.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Fix the HLS read leg — forward the child-request query string

> Added after the rest of this plan was implemented, reviewed, and merged: Task 12's real-binary
> smoke test (run against a real MediaMTX 1.21.0, not a stub) found that assumption 3 — "on-demand
> HLS muxing yields a playable multivariant playlist" — only half held. The multivariant playlist
> *is* playable and *does* use relative child references, exactly as Tasks 6/8 assumed. But every
> child reference carries a **required** `?session=<uuid>` query string
> (`main_stream.m3u8?session=3c8ce9c0-...`), and `localStreamPreviewRoutes.ts` builds its upstream
> URL from `req.params.file` alone — Express's route param never includes the query — so every
> media-playlist/segment request after the very first `index.m3u8` reaches MediaMTX with no session
> id and 401s. Confirmed against the real backend's own `createPreviewFetch()` logic, inside the
> project's own Docker image: identical requests succeed with the query and fail without it. The
> `Authorization` header the proxy so carefully forwards only authenticates the entry point (which
> *mints* the session) — it is irrelevant for every request after that. **Symptom in production:
> the preview's playlist loads, then every subsequent request 401s, hls.js raises a fatal network
> error, `HlsPlayer` retries forever, and the preview never actually plays.** This is why the
> "Real-binary verification" step exists — no unit test could have caught this, since every existing
> preview test fakes `PreviewFetch` and none of them can see a query string Express never gave the
> route in the first place.
>
> Same smoke test also found two smaller, non-blocking gaps worth closing in the same pass since
> they touch the same two files: (a) `createPreviewFetch()` silently depends on Node's global
> `fetch` following MediaMTX's pre-auth `cookieCheck` 302 redirect by default and re-sending
> `Authorization` on the same-origin hop — undocumented, untested, and one client swap away from
> breaking; make it an explicit `redirect: 'follow'` rather than an implicit default. (b) MediaMTX
> 1.21.0 starts a MoQ listener (`:8892`/`:8893`) by default that `docker/mediamtx.yml`'s Layer-0
> surface list never mentions — not currently exploitable (no ports are published either way), but
> Layer 0 is explicitly a denylist, and a version bump already outran it once; add `moq: false` so
> the list stays complete. Also fixes the config comment that (incorrectly, as of 1.21.0) asserts
> `hlsAllowOrigin` is the "real" singular form — MediaMTX 1.21.0 logs a deprecation warning for it
> in favour of `hlsAllowOrigins` (a list); switch to the plural form with an empty list (same "no
> browser talks to this directly" intent).

**Files:**
- Modify: `src/stream/localStreamPreviewRoutes.ts` (forward the query string to the upstream URL)
- Modify: `src/server.ts` (`createPreviewFetch`: explicit `redirect: 'follow'`)
- Modify: `docker/mediamtx.yml` (`moq: false`; `hlsAllowOrigin` → `hlsAllowOrigins: []`)
- Modify: `test/stream/localStreamPreviewRoutes.test.ts` (query-forwarding coverage)
- Modify: `test/infra/mediamtxConfig.test.ts` (`moq`/`hlsAllowOrigins` invariants)
- Test: same two files above (no new test files — extending existing ones)

**Interfaces:**
- Consumes: `PreviewFetch` (Task 6, unchanged signature — `(url, init) => Promise<PreviewFetchResponse>`); `Request.url`/`Request.params.file` (Express, unchanged).
- Produces: nothing new consumed elsewhere — this is a same-shape bugfix, not a new interface.

- [ ] **Step 1: Write the failing test for query forwarding**

Add to `test/stream/localStreamPreviewRoutes.test.ts`, inside the existing `describe` block (reuse
the file's existing `buildApp`/`TOKEN` helpers):

```typescript
it('forwards the request\'s query string to the upstream URL verbatim', async () => {
  const { app, previewFetch } = buildApp();
  await request(app).get('/local-stream/preview/main_stream.m3u8?session=3c8ce9c0-9a53-4c1c-8893-15c93c904906');
  expect(previewFetch).toHaveBeenLastCalledWith(
    `http://mediamtx:8888/live/${TOKEN}/main_stream.m3u8?session=3c8ce9c0-9a53-4c1c-8893-15c93c904906`,
    expect.anything(),
  );
});

it('does not append a query string when the request has none', async () => {
  const { app, previewFetch } = buildApp();
  await request(app).get('/local-stream/preview/index.m3u8');
  expect(previewFetch).toHaveBeenLastCalledWith(
    `http://mediamtx:8888/live/${TOKEN}/index.m3u8`,
    expect.anything(),
  );
});

// The ALLOWED_FILE allowlist must keep guarding only the file NAME — a query string is forwarded
// verbatim, never validated against it. Confirms a query can't be used to sneak a traversal-like
// value past the filename check (it never reaches that check at all — Express's :file param
// already excludes the query, this just proves appending it back on afterwards doesn't reopen it).
it('still rejects a disallowed file name even when a query string is present', async () => {
  const { app, previewFetch } = buildApp();
  const res = await request(app).get('/local-stream/preview/..%2Fmediamtx.yml?session=x');
  expect([400, 404]).toContain(res.status);
  expect(previewFetch).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/stream/localStreamPreviewRoutes.test.ts`
Expected: FAIL — the first two new tests see the upstream URL called *without* the query string
(current code drops it); the third passes already (unrelated to this fix) but keep it, it's the
regression guard for the fix below.

- [ ] **Step 3: Fix `proxy()` to forward the query string**

In `src/stream/localStreamPreviewRoutes.ts`, inside `proxy()`, right after the `ALLOWED_FILE` check
(so validation still runs against the file name alone, never the query):

```typescript
    // Express's :file route param — and the literal 'index.m3u8' the other route passes — never
    // include a query string; MediaMTX's HLS muxer appends a REQUIRED ?session=<uuid> to every
    // child reference in the multivariant playlist (confirmed against a real MediaMTX 1.21.0 — see
    // CLAUDE.md's known follow-ups). Forward it verbatim: it's an opaque per-session token MediaMTX
    // itself minted and put in the playlist we already served, not something a client can forge
    // usefully, and it never influences which file name gets validated above.
    const queryStart = req.url.indexOf('?');
    const queryString = queryStart === -1 ? '' : req.url.slice(queryStart);
```

Then change the `previewFetch` call from:
```typescript
      upstream = await previewFetch(`${target.hlsBaseUrl}/${fileName}`, {
```
to:
```typescript
      upstream = await previewFetch(`${target.hlsBaseUrl}/${fileName}${queryString}`, {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest test/stream/localStreamPreviewRoutes.test.ts`
Expected: PASS (13 tests — the original 10, the fix-round non-2xx-body test, and these 3 new ones).

- [ ] **Step 5: Make the redirect-following explicit in `createPreviewFetch`**

In `src/server.ts`, change:
```typescript
    const res = await fetch(url, { headers: init.headers });
```
to:
```typescript
    // MediaMTX answers a fresh HLS session's first request with a 302 cookie-probe redirect before
    // the real content — verified against a real binary. Node's global fetch follows redirects by
    // default, but that's an implicit default this depends on, not a documented contract; say so.
    const res = await fetch(url, { headers: init.headers, redirect: 'follow' });
```

This has no unit-testable behavior change (the default was already 'follow'), so no new test —
`test/server.test.ts`'s existing coverage of `createPreviewFetch` is unaffected. Run
`npx jest test/server.test.ts` to confirm it still passes unchanged.

- [ ] **Step 6: Close the MediaMTX config denylist gap and the deprecated key**

Edit `docker/mediamtx.yml`:

```yaml
# --- Layer 0 -----------------------------------------------------------------------------------
# NOTE: `false`/`true`, not `no`/`yes` — js-yaml (this repo's config-invariant test, and MediaMTX's
# own Go YAML decoder) only resolves booleans from true/false forms; `no`/`yes` parse as the plain
# strings 'no'/'yes', which MediaMTX's typed config would reject at startup as a type mismatch.
# This list is a DENYLIST, not an exhaustive inventory of MediaMTX's features — verified against a
# real MediaMTX 1.21.0 that it also starts a MoQ listener (:8892/:8893) unless explicitly disabled,
# which this file didn't account for until a real-binary smoke test caught it. Re-check this list
# against MediaMTX's actual startup log (`INF [...] started with listener on ...` lines) whenever
# the pinned version changes — a new default-on feature can silently outrun this file again.
api: false
metrics: false
pprof: false
playback: false
rtsp: false
webrtc: false
srt: false
moq: false
rtmp: true
hls: true
```

and:

```yaml
# hlsAllowOrigins: [] -> nothing talks to this server from a browser; only the backend proxy does,
# server-to-server, so no cross-origin access is ever needed here. (Not the older singular
# `hlsAllowOrigin` — MediaMTX 1.21.0 logs a deprecation warning for that key in favour of this
# plural, list-shaped one; confirmed against a real binary.)
hlsAddress: :8888
hlsVariant: mpegts
hlsSegmentCount: 7
hlsSegmentDuration: 1s
hlsAlwaysRemux: false
hlsAllowOrigins: []
hlsMuxerCloseAfter: 60s
```

- [ ] **Step 7: Update the config-invariant test to match**

In `test/infra/mediamtxConfig.test.ts`, add `moq: boolean;` to the `MediaMtxConfig` interface and
`hlsAllowOrigins: unknown[];` (drop the old `hlsAllowOrigin` reference if the interface ever added
one — it didn't, the file only typed the fields it asserted on). Update the two affected tests:

```typescript
  it('disables every control and extra-protocol surface, leaving only RTMP ingest and HLS read', () => {
    expect(config.api).toBe(false);
    expect(config.metrics).toBe(false);
    expect(config.pprof).toBe(false);
    expect(config.playback).toBe(false);
    expect(config.rtsp).toBe(false);
    expect(config.webrtc).toBe(false);
    expect(config.srt).toBe(false);
    expect(config.moq).toBe(false);
    expect(config.rtmp).toBe(true);
    expect(config.hls).toBe(true);
  });
```

```typescript
  it('serves plain (not low-latency) HLS, muxed on demand, with no cross-origin browser access', () => {
    expect(config.hlsVariant).toBe('mpegts');
    expect(config.hlsAlwaysRemux).toBe(false);
    expect(config.hlsAllowOrigins).toEqual([]);
  });
```

(This second test is a rename+extension of the existing `'serves plain (not low-latency) HLS, muxed
on demand'` test — replace it in place, don't add a duplicate.)

- [ ] **Step 8: Run the full test suite and build**

Run: `npx jest test/infra/mediamtxConfig.test.ts`
Expected: PASS (9 tests — same count as before, two of them extended in place).

Run: `npx jest && npm run build`
Expected: full suite green, clean `tsc`.

- [ ] **Step 9: Re-verify against the real MediaMTX from Task 12's smoke-test environment**

This fix exists *because* a real-binary test caught what unit tests couldn't — closing it with only
unit tests would repeat the same blind spot. Re-run the specific check from Task 12's Part 2,
section 2.4 ("What did not — the bug") against a real MediaMTX: build the project's image, bring up
the same isolated network + MediaMTX + a real published stream, and confirm a media-playlist/segment
request **with** the query string now succeeds through the actual `localStreamPreviewRoutes.ts`
code path (not the standalone Node repro script Task 12 used) — i.e. drive it through a real HTTP
request to the running backend's `/local-stream/preview/*` route, not just the isolated
`createPreviewFetch()` logic. Full teardown afterward, same rules as Task 12 (isolated network, no
published ports, remove every container/network/temp file, never touch the host's other services).
If this still fails, STOP and report — don't paper over a second failure the same way the first was
correctly not papered over.

- [ ] **Step 10: Update `CLAUDE.md`**

Task 12's own doc commit (`a9bf37d`) already recorded this as an open bug with its fix shape under
known follow-up (h). Update that entry to reflect that it's now fixed: replace the "open bug" framing
with a short note that the query string is now forwarded (cite this task), and fold the MoQ/
`hlsAllowOrigin` findings ((j)/(k) in that commit) into simple "fixed" mentions rather than open
follow-ups, if Task 12 tracked them there.

- [ ] **Step 11: Commit**

```bash
git add src/stream/localStreamPreviewRoutes.ts src/server.ts docker/mediamtx.yml \
  test/stream/localStreamPreviewRoutes.test.ts test/infra/mediamtxConfig.test.ts CLAUDE.md
git commit -m "$(cat <<'EOF'
fix: forward the HLS child-request query string through the preview proxy

A real MediaMTX 1.21.0 requires a ?session=<uuid> query on every playlist/
segment request after the entry point, which Express's :file route param
never carries. Confirmed against a real binary (Task 12's smoke test) that
this broke the preview entirely past the first playlist load. Also makes
createPreviewFetch's redirect-following explicit and closes two smaller
config gaps (MoQ default-on, the deprecated hlsAllowOrigin key) the same
smoke test surfaced.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

Performed against the spec's Phase A scope after the plan was complete. Findings were fixed inline
above; recorded here so a reviewer can check the same things.

**1. Spec coverage (Phase A scope only).**

| Spec requirement | Task |
| --- | --- |
| MediaMTX container in `docker-compose.yml`, no published ports | 1 |
| `api/metrics/pprof/playback/webrtc/rtsp/srt: no` | 1 |
| Single regex path `~^live/[0-9a-f]{32}$`, no `all_others` | 1 |
| Pinned image, read-only config mount, memory limit, `restart: unless-stopped` | 1 |
| `LocalRelayTarget` factory minting path + publish/read credentials | 2 |
| `persistentEncoderArgs.ts` unchanged (userinfo → query-string correction) | 2 + Global Constraints |
| Read credential minted now for Phase B's relay | 2 |
| `authHTTP` endpoint: in-memory map, own port, shared secret, fail-closed | 3 |
| Publish and read secrets distinct | 2, 3 |
| `buildStreamScene(userId, playlistId, templateId)` extraction | 4 |
| `LocalStream` keyed by `userId`, destination code removed | 5 (documented: `StreamController` already has none) |
| Local reconnect without the `isRetryableDestination` veto | 5 |
| Exactly one local stream per user | 5 |
| Concurrency cap (open question #8) | 5, 8 |
| Max session duration (open question #7) | 5, 8 |
| HLS proxy: no client-supplied path, sanitised `:file`, streamed, `no-store`, injected HTTP client, upstream credential | 6 |
| iOS Safari limitation documented, not solved | 6, 10, 12 |
| Control + status + SSE routes | 7 |
| Embedded hls.js player | 10 |
| Existing `/stream-sessions/*` and `/destinations/{id}/stream/*` untouched | 4 (behaviour-preserving), 11 (separate page) |
| Real-binary verification of three Phase A-specific assumptions (query-string RTMP credentials, `authHTTP` request body shape, on-demand HLS muxing) | 12 |
| The spec's three `RelayProcess` hazards (timestamp origin on `-c copy`, late-joining-reader keyframes, `-reconnect` not applying to RTMP inputs) | **deferred to Phase B** — nothing in Phase A exercises a `-c copy` relay, so none of the three is actually exercisable here. Task 12's "late-joining HLS reader" check tests a different mechanism (MediaMTX's HLS muxer always cuts on an IDR) and says nothing about whether an RTMP *read* gets a keyframe-first stream, which is what Phase B's relay depends on. Carry all three forward explicitly into the Phase B plan. |
| `-reconnect` flags not applicable to RTMP inputs | Global Constraints |

Gaps found and closed while reviewing: the spec's "shared-secret **header**" is impossible against
real MediaMTX (no custom headers) — replaced with a URL path segment and called out in Global
Constraints and Task 3; the spec's userinfo-form RTMP credential is likewise not supported —
replaced with the query-string form in Task 2 and made a Step-3 assertion of the Task 12 smoke test.
Deliberately **not** covered, because they are Phase B/C: `DestinationForward`, `RelayProcess`,
destination toggles, `StreamDestination.youtubeLiveStreamId`, the `StreamSession`-as-preset
repurposing, deleting `streamRoutes.ts`/`StreamSessionManager`/`SessionOverlayCache`, the
`DELETE /destinations/{id}`-while-forwarded rule, and `watchUrl()` returning a stable channel link.

**2. Placeholder scan.** No `TBD`, `TODO`, `implement later`, `add error handling`, `similar to
Task N`, or code step without real code. Task 11's locale step is the one place that names
translations without spelling them out — it gives the full English block, the exact insertion point
in all three files, and the tone to match, which is actionable in isolation. Task 12's CLAUDE.md
step enumerates each edit by section and content rather than saying "update the docs".

**3. Type and signature consistency.** Checked every cross-task reference:

- `LocalRelaySession` field names are identical in Task 2 (definition), Task 3 (registry + test
  fixture), and Task 5 (test fixture + `previewTarget`).
- `MediaMtxAuthRegistry.register` takes a whole `LocalRelaySession` in Task 3 and is called with one
  in Task 5; `unregister` takes `session.path` in both.
- `LocalStreamManagerDeps.authRegistry` is `Pick<MediaMtxAuthRegistry, 'register' | 'unregister'>`,
  which the Task 3 class satisfies.
- `StreamScene.createPersistentEncoder(target: RtmpTarget)` — same one-argument shape in Task 4's
  definition, Task 4's `StreamManager` call site, Task 5's call site, and both tasks' tests.
- `StreamSceneDeps` is defined once (Task 4), extended by `StreamManagerDeps` (Task 4) and reused
  verbatim by `LocalStreamManagerDeps.sceneDeps` (Task 5) and `buildServer` (Task 8) — so the
  repository/`Pick<>` shapes cannot drift.
- `PreviewFetch`/`PreviewFetchResponse` (`{ status, contentType, body }`) is identical in Task 6's
  definition, Task 6's fakes, Task 7's router signature, and `createPreviewFetch()` in Task 8.
- `LocalStreamStatus` has the same seven fields in Task 5 (backend), Task 7/8 (routes, OpenAPI
  schema) and Task 9 (frontend mirror); `previewReady` is spelled the same everywhere.
- `LocalStreamManager.previewTarget` returns `{ hlsBaseUrl, authorization }` in Task 5 and is
  destructured with exactly those names in Task 6.
- `LOCAL_STREAM_STATUS_QUERY_KEY` is defined in the hook (Task 9) and imported by the page (Task
  11) — not re-declared.
- `localStreamApi` method names (`status/start/stop/pause/resume/next/previous/play/eventsUrl/
  previewUrl`) match between Task 9's definition, its test, and Task 11's page and test.
- `HlsPlayerProps` (`src`, `className?`, `unsupportedMessage`) matches between Task 10 and Task 11's
  call site and its mock.
- Route paths agree between Task 7 (`/preview` mount), Task 6 (`/index.m3u8`, `/:file`), Task 8
  (OpenAPI `/local-stream/preview/index.m3u8`) and Task 9 (`previewUrl()`).

One inconsistency found and fixed during this pass: an earlier draft had `LocalRelayTarget.create`
returning `publishUrl`/`readUrl` (the spec's names) while `LocalStreamManager` consumed
`publishRtmpUrl`/`publishStreamKey`; the split-URL names are now used consistently everywhere,
because the split is what keeps `buildPersistentEncoderArgs`'s signature untouched.

**4. Independent adversarial review (separate pass, after this self-review).** A second reviewer,
with no memory of writing this plan, read it against the spec and the real codebase looking
specifically for logical holes and implementation problems rather than re-confirming the above.
Findings and the fixes now folded into the plan above:

| # | Finding | Fixed by |
| --- | --- | --- |
| 1 | `hlsAllowOrigins: []` isn't a real MediaMTX key (it's `hlsAllowOrigin`, singular, a string) — the container would fail to start | Task 1: corrected key/value, `no`/`yes` → real YAML `false`/`true` throughout (js-yaml/MediaMTX both only resolve booleans from `true`/`false` forms) |
| 2 | Plain `.pipe()` in the HLS proxy leaves the upstream Readable with no `'error'` listener — an unhandled `'error'` event is an uncaught exception that crashes the **whole backend**, every tenant, on any MediaMTX hiccup | Task 6: `pipeline()` + client-disconnect cleanup, plus a test that emits `'error'` on the fake body |
| 3 | The id-less `/local-stream/{stop,pause,resume,next,previous}` routes have no ownership check to get wrong *and* no accidental CSRF token — a plain cross-site form POST is a CORS "simple request" and lands | Task 7: `requireJsonRequest` guard (forces a preflight) on every mutating route + a rejection test |
| 4 | `LocalStreamManager.start()`'s catch didn't stop the controller before `discard()` — a track whose overlay build rejects after the pipeline already spawned orphans a live encoder whose credentials get revoked out from under it; the existing test for this couldn't actually fail (it hit an earlier, pre-spawn throw instead) | `start()`: `controller.stop()` before `discard()`; test split into the true pre-spawn case and a new post-spawn case asserting `encoder.stop`/`canvasFeeder.close` |
| 5 | Concurrency cap race (checked `streams.size`, which only grows after an `await`, so N concurrent starts from different users could all pass) and wedge (an `'error'` entry pinned its slot forever, with no eviction path since the control API is deliberately disabled) | `start()`: cap now checked against `active + starting.size`, computed and reserved synchronously before any `await`; `active` excludes `'error'` entries; two new tests |
| 6 | Making `MEDIAMTX_AUTH_SECRET` required breaks 8 pre-existing, unrelated tests in `test/config/env.test.ts` that the plan never mentioned updating | New Step 2b: add the var to every pre-existing fixture in that file |
| 7 | The reconnect test asserted `'error'` after a single encoder exit, but `createReconnectPolicy()`'s `CRASH_LOOP_THRESHOLD` is 2 — one exit actually yields `'reconnecting'`, matching `streamManager.test.ts`'s own existing behaviour for this exact policy | Test rewritten with fake timers to drive two consecutive short-lived failures, plus assertions for the `'reconnecting'` window (credentials still registered, preview not ready) |
| 8 | Same YAML boolean issue as #1 inside the config-invariant test itself, plus an unquoted numeric compose env var whose test expected a string, plus a stale test count | Fixed alongside #1; `MEDIAMTX_AUTH_PORT: "3001"` quoted; count corrected to 9 |
| 9 | `toHaveProperty('/local-stream/preview/index.m3u8')` — Jest parses a string keyPath containing dots as a deep path, so this assertion can never pass regardless of the real OpenAPI output | Array-form `toHaveProperty(['/local-stream/preview/index.m3u8'])` |
| 10 | The publish secret (via ffmpeg's own stderr logging its output URL) and the MediaMTX shared secret (via MediaMTX logging a failed connection to `authHTTPAddress`) both land in plaintext container logs — undocumented | Two new CLAUDE.md known-follow-up entries in Task 12 |
| 11 | Nothing in the existing suite exercises `renderShared`'s cache key at all (`streamManager.test.ts` never passes `overlayCache`; `streamSessionManager.test.ts` only asserts a cache instance was constructed against a fully faked manager) — dropping `layer` from the key would be caught by nothing | Task 4: three new tests against a real `SessionOverlayCache` plus a key-shape spy |
| 12 | Task 12's smoke test published with a third-party ffmpeg image (`linuxserver/ffmpeg`), not the Debian-bookworm build this app's own `Dockerfile` actually ships — verifying the wrong RTMP implementation defeats the task's own purpose | Publishes via `--entrypoint ffmpeg` against the project's own built image; `curl` image pinned to a real version too |
| 13 | The self-review's own spec-coverage table claimed Task 12 verified "the three flagged hazards," but all three (`RelayProcess`'s timestamp origin, late-joining-reader keyframes, `-reconnect` on RTMP inputs) are Phase B properties nothing in Phase A can exercise | Table row corrected; hazards explicitly carried forward as a Phase B input |
| 14 | Task 4's line-range instructions were off by one in two places and included a third, redundant "also delete" bullet for lines already inside the range being wholesale-replaced — an agent applying them literally produces a syntax error | Ranges corrected (172-345, 348-405); redundant bullet removed |
| 15 | Smaller items: `hlsSegmentDuration` doesn't actually control real latency (the encoder's `-g` does); unvalidated numeric env parsing turns a typo into either "the cap is silently disabled" or "every stream self-destructs on the next tick"; a stale test count in Task 4; an off-by-one file-line citation in Task 8; a "keep these imports, they're still used" comment that was simply wrong | All fixed inline; added `parsePositiveInt` guard for the three new numeric env vars |

Every fix above is already reflected in the task bodies earlier in this document — this table is a
changelog, not a to-do list.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-14-local-first-streaming-phase-a.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**

