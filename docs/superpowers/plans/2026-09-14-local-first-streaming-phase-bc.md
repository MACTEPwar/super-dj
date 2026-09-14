# Local-First Streaming — Phase B + C (destination forwards, legacy cutover, unified UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase A local stream into the *only* streaming model in the app: one always-on
local encode per account, with 0..N destinations that can be toggled on and off independently while
it runs — and delete the legacy single-destination and multi-destination-session code paths, their
routes and their UI entirely.

**Architecture:** A new `DestinationForward` per (user, destination) owns *policy and lifecycle only*
— a `desired: on|off` intent set by a checkbox and an `actual` sub-state driven by one `reconcile()`
that re-runs on every relevant event (toggle, local-stream state change, relay exit, provider phase
change). The actual bytes are moved by `RelayProcess`, a `Spawner`-injected `ffmpeg -i
<mediamtx-read-url> -c copy -f flv <destination>` structurally identical to `PersistentEncoder`.
`LocalStreamManager` absorbs `StreamManager` + `StreamSessionManager`: it keys one `StreamController`
+ one `Map<destinationId, DestinationForward>` per `userId` and publishes a combined
`{ local, destinations[] }` status over the existing `/local-stream/events` SSE stream.
`StreamDestination.youtubeLiveStreamId` makes a YouTube destination's `liveStream` reusable across
toggles so only the `liveBroadcast` is ephemeral. `StreamSession`/`StreamSessionDestination` stop
representing "the running thing" and become a saved **preset** (`/stream-presets`) that
pre-populates a start. The frontend collapses `Streams.tsx` + `StreamSessionPanel.tsx` +
`StartStreamDrawer.tsx` + `LocalStream.tsx` into one `pages/Stream.tsx` at `/stream`.

**Tech Stack:** TypeScript/Node 20, Express 4, Prisma/Postgres (one migration), Jest + supertest
(backend), React 18 + Vite + Vitest + Testing Library (frontend), Docker Compose, MediaMTX
`bluenviron/mediamtx:1.21.0`, ffmpeg 5.1.9 (Debian bookworm, this repo's own image), hls.js.

**Spec:** `docs/superpowers/specs/2026-09-14-local-first-streaming-design.md` — read it in full,
**including the "Addendum after Phase A shipped" section at the very end**, before starting. This
plan implements its **Phase B** checkpoint plus **all of Phase C**, including the frontend migration
that the addendum's decision (d) pulled forward. `CLAUDE.md` is authoritative over the spec wherever
the two differ about MediaMTX's real behaviour or about what Phase A actually shipped.

## Global Constraints

Copied verbatim from the spec (and from `CLAUDE.md` where Phase A's real-binary findings supersede
it). Every task's requirements implicitly include this section.

- **The `mediamtx` service must never get a `ports:` entry.** Spec Layer 0: "MediaMTX gets no
  `ports:` entry in `docker-compose.yml` at all; reachable only by service name on the compose
  network... This is the actual boundary; everything below is defense in depth, and it's the line
  most likely to be silently undone later by an incautious 'let me just check if it's reachable'
  port publish." `test/infra/mediamtxConfig.test.ts` enforces this. **Do not delete, skip or weaken
  that test**, and do not add a published port for any smoke test — the smoke-test tasks below run
  everything on an isolated docker network instead.
- **MediaMTX image stays pinned to the exact version `bluenviron/mediamtx:1.21.0`.** Never
  `:latest`. Every behaviour this plan depends on was read out of that version. If the pin ever
  moves, re-read MediaMTX's own `started with listener on …` startup lines: the config's disabled
  surface list is a **denylist, not an inventory** (v1.21.0 shipped a MoQ listener that the config
  did not name).
- **Every forward is `-c copy`, full stop.** Spec, "Deliberately deferred": "**Per-destination
  transcoding** (different bitrate/resolution per platform) — would reintroduce per-destination
  encodes and destroy the entire CPU-sharing premise of this design. Every forward is `-c copy`,
  full stop." No `-c:v`, `-c:a`, `-b:v`, `-s`, `-r`, `-vf`, `-af` or filter option may appear in
  `buildRelayProcessArgs`.
- **Zero destinations checked is a fully valid, non-degenerate running state.** Spec: "the stream
  runs and previews with nothing forwarded. This inverts today's model (a stream exists *because*
  something is receiving it) and every status/empty-state UI check needs to be written for it
  deliberately."
- **A forward that errors never touches the encoder or its sibling forwards.** Spec: "Stated as an
  explicit invariant, since it's the entire point of this rework."
- **Forwards hold, they do not finalize, while the local stream is `reconnecting`.** Spec: "do not
  finalize, do not burn their own reconnect budget, wait for the source — and only finalize once
  `LocalStream` gives up and goes `error`." Rationale, verbatim: "eating a few seconds of ingest gap
  (YouTube tolerates this; it only auto-ends after a sustained one) beats burning ~330 quota units
  and three new watch URLs."
- **Hard invariant on `prepareSession()`:** "once `prepareSession()` resolves, always register the
  lifecycle before re-checking desired-state — the next `reconcile()` then finalizes it if desired
  has flipped."
- **`DELETE /destinations/{id}` while forwarded must toggle that forward off and finalize its
  lifecycle *without touching the local stream*.** Spec flags this as an "easy one-line miss that
  orphans a broadcast" — today's code calls `streamManager.stop(destinationId)`, which would be
  wrong here.
- **The browser never supplies a MediaMTX path, token or credential.** The preview route resolves
  the path from `req.user.id` server-side. "A design where the browser supplies a path or token as a
  request parameter is one IDOR away from cross-tenant viewing — this is the single most important
  rule in this section." Nothing in this plan may add such a parameter.
- **`authHTTP` is fail-closed**: MediaMTX allows only on a 2xx, so every non-allow path answers 401
  and an unreachable backend denies by default. Never add a bypass.
- **RTMP credentials are query parameters, not URL userinfo** (MediaMTX v1.21.0
  `internal/servers/rtmp/conn.go`). `LocalRelayTarget.readRtmpUrl` already carries them in that
  form; consume it verbatim and never re-derive it.
- **`ffmpeg -reconnect*` flags do not apply to RTMP inputs** (HTTP(S) only). Spec: "input-side
  recovery for the relay must be a Node-level respawn, not an ffmpeg flag. State this explicitly so
  it isn't assumed away during implementation."
- **`persistentEncoder.ts`, `persistentEncoderArgs.ts`, `canvasFeeder.ts` and `audioRelay.ts` do not
  change in this plan at all.** Spec, "Explicit reassurance for the next implementer": "No new code
  path restarts the encoder. The `unpipe()`-before-`kill()` discipline is unaffected because no new
  component shares a pipe with an existing one — each `RelayProcess` owns its own stdio end to end,
  independent of the encoder's pipes."
- **Carry Phase A's two caps forward; do not add a third.** `MAX_CONCURRENT_LOCAL_STREAMS` (default
  10) and `MAX_LOCAL_STREAM_HOURS` (default 12) already ship in `src/config/env.ts` and
  `src/stream/localStreamManager.ts`. Spec addendum point 3: "Nothing to decide here for B/C; carry
  the same env vars forward, don't reintroduce a second cap."
- **One local stream per user, keyed by `userId`.** Not per destination, not per preset row.
- **Toggle-off leaves the archived YouTube VOD alone** (spec open question #4) — `finalize()` must
  not delete a broadcast.
- **Testing style:** never spawn real ffmpeg or a real MediaMTX in unit tests. Follow the existing
  fake-`Spawner` / fake-child / fake-repository patterns
  (`test/ffmpeg/persistentEncoder.test.ts`, `test/stream/localStreamManager.test.ts`,
  `test/stream/localStreamRoutes.test.ts`, `test/stream/localStreamEvents.test.ts`). Inject HTTP and
  timer seams as fakes rather than adding a mocking library.
- **Locale files stay key-identical** across `en.json` / `ru.json` / `uk.json`, in the same key
  order.
- **Commit trailer:** end every commit message with the `Co-Authored-By:` line your own session's
  instructions specify. The trailer shown in the commit steps below is the one in force at the time
  this plan was written; use whatever your session specifies if it differs.
- **Migrations are never hand-written.** `prisma/migrations/` is generated on the remote Postgres
  host per `CLAUDE.md`'s documented procedure (Task 4 restates it in full).

### Already true in the code — consume it, do not re-derive it

The spec was written before Phase A shipped. These four things exist **now** and several tasks below
would otherwise waste effort rebuilding them:

| Spec says | Reality in the code today |
| --- | --- |
| `LocalRelayTarget.create(userId) → {publishUrl, publishSecret, readUrl, readSecret, pathToken}` | `src/stream/localRelayTarget.ts` already mints **`readRtmpUrl`** (`rtmp://mediamtx:1935/live/<token>?user=sub&pass=<readSecret>`) **specifically for Phase B's `RelayProcess` to use as its `-i` input** — built in Phase A, unused until now. `RelayProcess` consumes it directly; **no new credential-minting work is needed**, and the publish/read secrets are already different values. |
| `buildStreamScene(userId, playlistId, templateId)` | The real signature is `buildStreamScene(deps: StreamSceneDeps, params: {userId, playlistId, templateId?, sceneId, overlayCache?, sessionId?})` (`src/stream/streamScene.ts`). Task 8 deletes the `overlayCache`/`sessionId` params together with `SessionOverlayCache` — not just the class. |
| open questions #7 (idle cost) and #8 (concurrency cap) are open | Both shipped in Phase A: `MAX_LOCAL_STREAM_HOURS` (12) and `MAX_CONCURRENT_LOCAL_STREAMS` (10), including the synchronous check-and-reserve that closes the N-concurrent-starts race. Nothing to decide or re-add. |
| the HLS proxy needs playlist rewriting / a shared-secret header | Neither. `localStreamPreviewRoutes.ts` forwards the inbound query verbatim (MediaMTX's required `?session=<uuid>`), `createPreviewFetch()` states `redirect: 'follow'` for MediaMTX's pre-auth `cookieCheck` 302, and the auth shared secret travels as a URL path segment. All verified against a real 1.21.0. **This plan does not touch the preview leg at all.** |

Also already true and worth not re-litigating: `reconnectPolicy.ts` is already parameterised on an
`isRetryableDestination` veto and already exports `SHORT_LIVED_UPTIME_MS`, which Task 3 reuses as
the custom-RTMP "counts as connected" heuristic exactly as the spec prescribes.

**The spec's `LocalStream` rename does not happen and is not a gap.** The spec's component shape
names "`LocalStream` (renamed/slimmed `StreamController`)". Phase A instead reused
`StreamController` unchanged, because the slimming the rename was meant to deliver — removing
everything destination-specific — landed as the `buildStreamScene` extraction rather than as a class
rename, and `StreamController` never had any destination knowledge of its own to begin with (the
provider/lifecycle wiring all lived in `StreamManager`). Renaming it now would touch
`streamController.ts`, its 600-line test file and every call site for zero behavioural change, in a
file this plan otherwise does not modify at all. **Do not rename it.**

**Noted and still declined: MediaMTX ≥ v1.20.0 has native stream forwarding** (`forward
destinations` in a path config), which post-dates the spec's "Why not let MediaMTX itself forward to
destinations" section — that section argues only against `runOnReady`. Every other argument in it
survives the new feature unchanged: a destination's decrypted stream key would have to be written
into MediaMTX's runtime config (a real security regression against today's
decrypt-only-in-memory), there are no in-process push-started/died callbacks to drive
`onPushStarted()`/reconnect/finalize, testability regresses from the fake-`Spawner` pattern to
faking an HTTP config API, and a MediaMTX restart would resurrect a push into a broadcast the
backend already finalized. **Do not use it.**

### Deliberately not built (spec "Deliberately deferred" — stated so it isn't silently reintroduced)

Per-destination transcoding of any kind; a raw RTMP preview URL for OBS/VLC; recording/VOD via
MediaMTX's `record:`; ABR / multi-rendition preview; a MediaMTX path per destination; Twitch (or any
platform) as a first-class OAuth provider — Twitch stays a `custom` destination pointed at
`rtmp://live.twitch.tv/app`; resuming a local stream or its forwards after a backend restart.

### Decisions this plan makes where the spec was silent

| Question | Decision |
| --- | --- |
| Where does a forward's `BroadcastMeta` (title/description/privacy/latency) come from, now that Phase A's `/local-stream/start` rejects those fields? | `POST /local-stream/start` accepts them again (all optional), stored on the running session and used by **every** forward this session prepares. They are the same four fields the deleted `/stream-sessions` accepted, with the same validation and the same defaults (`title` → playlist name, `privacyStatus` → `private`, `latencyPreference` → `normal`). A forward created while nothing is running never calls `prepareSession()`, so it never needs meta. |
| How does "start with these destinations pre-checked" reach the backend? | `POST /local-stream/start` also accepts `destinationIds?: string[]` (may be empty or omitted). Each id is ownership-checked **before** any side effect, then set as `desired: 'on'` intent. Spec: pre-checked and mid-stream toggles must be "the same code path (set intents, then reconcile)". |
| Toggle while the account has no local stream at all | Allowed, not a 409 (spec open question #3). The forward parks at `actual: 'pending'` with **zero** external side effects and survives until the next start. A user whose forwards are all `off` has their forward map pruned. |
| The spec's "`starting` promoted into a real state" | Added as `'starting'` on the **local status payload only** (`LocalSessionState = SessionState \| 'starting'` in `localStreamManager.ts`), derived from the existing `starting: Set<string>` re-entrancy guard. `SessionState` in `src/stream/types.ts` is left alone: `StreamController` never produces `'starting'`, and widening its union would mean a state the controller's own switch logic can never reach. |
| The spec's forward-level "`isSourceAvailable` veto" | Implemented **once**, inside `DestinationForward.pass()`/`handleRelayExit()`, not as a second veto inside `reconnectPolicy.ts`. Reason: the policy can only answer retry/give-up, while the forward needs a *third* outcome — **hold** (don't retry, don't finalize, don't spend budget). Putting the check in the policy would make "source down" indistinguishable from "budget exhausted" at the one call site that must tell them apart, and a scheduled retry re-enters the same `reconcile()` anyway, so a policy-level copy would be dead code. `reconnectPolicy.ts` gains only the spec's *other* forward addition: its own faster backoff schedule. |
| Reusable `liveStream` bookkeeping when YouTube has deleted it out from under us | `YoutubeProvider.prepareSession()` reads `destination.youtubeLiveStreamId`, calls a new `YoutubeApiClient.getStream()`, and falls back to creating (and persisting) a fresh one when that returns null. `finalize()` no longer deletes the `liveStream` at all — which also retires the "ephemeral liveStream orphaned because finalize's token call failed" follow-up in `CLAUDE.md`. |
| `DestinationLifecycle.watchUrl()` shape | Returns the **stable** `https://www.youtube.com/channel/{channelId}/live` link (channelId = `OAuthConnection.externalAccountId`, which `YoutubeOAuthAdapter.fetchAccountIdentity` already stores) **only for a `public` broadcast** — the channel `/live` page never resolves an unlisted or private one, so it would 404 for the owner's own viewers. Falls back to the per-broadcast `watch?v=` URL whenever no channel id is known OR the broadcast isn't public. Spec: "the single best fix for 'my viewers' link keeps dying'" — true for the public case, which the addendum's decision expects to be the common one; a private/unlisted broadcast still gets a fresh URL per toggle, same as before this change. One field, not two. |
| `StreamSession` → preset schema delta | Add **`name String @default("Untitled preset")`** (a preset is picked by name, and `title` already means "the YouTube broadcast title" — overloading it would make the picker show broadcast titles) and **`latencyPreference String?`** (the one `BroadcastMeta` field the table never persisted). The **Prisma model names stay `StreamSession`/`StreamSessionDestination`** so no table is renamed and the migration is two `ADD COLUMN`s; only the TypeScript layer is renamed to `StreamPreset*`, with a comment at each boundary saying why the names differ. |
| Preset API surface | `POST/GET/PUT/DELETE /stream-presets` (+ `GET /stream-presets/{id}`), routes + repository only — no manager class, matching how `playlistRoutes.ts`/`destinationRoutes.ts` do CRUD. `destinationIds` **may be empty** (zero destinations is a valid preset, unlike the old session which required a non-empty list). |
| Frontend route/page naming | One page `frontend/src/pages/Stream.tsx` at **`/stream`**, one sidebar entry. `/streams`, `/streams/:id` and `/local-stream` all `<Navigate replace>` to `/stream` so existing bookmarks and the Phase A link keep working. |
| Where the relay's ffmpeg gets its `Spawner` | `LocalStreamManager` takes the same `Spawner` the scene deps already carry (`sceneDeps.spawner`), so relay stderr is drained and timestamped by `createSpawner()` exactly like every other child. No new spawner type: `RelayProcess` needs one stdout-less child, not the 4-pipe `PipeSpawner`. |

### What this plan deletes outright

`src/stream/streamManager.ts`, `src/stream/streamRoutes.ts`, `src/stream/streamSessionManager.ts`,
`src/stream/streamSessionRoutes.ts`, `src/stream/sessionOverlayCache.ts`, and the tests
`test/stream/streamManager.test.ts`, `test/stream/streamRoutes.test.ts`,
`test/stream/streamEvents.test.ts`, `test/stream/streamSessionManager.test.ts`,
`test/stream/streamSessionRoutes.test.ts`, `test/stream/streamSessionEvents.test.ts`; the OpenAPI
blocks for `/destinations/{destinationId}/stream/*` and `/stream-sessions/*`; and on the frontend
`pages/Streams.tsx`, `pages/StreamSessionPanel.tsx`, `components/StartStreamDrawer.tsx`,
`api/streamSessions.ts`, `hooks/useStreamSessionStatus.ts`, `pages/LocalStream.tsx` and each of
their test files. There is **no staged fallback and no feature flag**: leaving the old routes
reachable would let them bypass the new "no destination forward without an active local stream"
invariant entirely.

---

## File Structure

### Backend — created

| File | Single responsibility |
| --- | --- |
| `src/ffmpeg/relayProcessArgs.ts` | The `ffmpeg` argv for one `-c copy` relay: MediaMTX read URL in, destination FLV out. The one place the "never transcode" rule is enforceable by reading a single function. |
| `src/ffmpeg/relayProcess.ts` | `RelayProcess` — spawn/kill one relay child with the same `stopRequested` guard `PersistentEncoder` uses. |
| `src/stream/destinationForward.ts` | `DestinationForward` — desired/actual state plus the single `reconcile()` that owns every edge case; provider `prepareSession`/`DestinationLifecycle` wiring; the relay's respawn bookkeeping. Zero knowledge of child processes beyond the injected `createRelay` factory. |
| `src/stream/streamPresetRepository.ts` | Prisma-backed CRUD for the repurposed `StreamSession` rows (saved presets). |
| `src/stream/streamPresetRoutes.ts` | `/stream-presets` CRUD + ownership validation. |
| `test/ffmpeg/relayProcessArgs.test.ts` | Argv shape, including the no-transcoding guard. |
| `test/ffmpeg/relayProcess.test.ts` | Spawn/exit/stop semantics (fake-child pattern). |
| `test/stream/destinationForward.test.ts` | The whole desired/actual matrix: pending, double-toggle, toggle-during-prepare, toggle-during-finalize, source loss, relay crash/respawn/give-up, provider phase changes. |
| `test/stream/streamPresetRoutes.test.ts` | Preset CRUD validation and ownership. |

### Backend — modified

| File | Change |
| --- | --- |
| `src/stream/reconnectPolicy.ts` | Configurable backoff schedule + `createForwardReconnectPolicy()`. |
| `prisma/schema.prisma` + a new migration | `StreamDestination.youtubeLiveStreamId`, `StreamSession.name`, `StreamSession.latencyPreference`. |
| `src/destinations/destinationRepository.ts` | `setYoutubeLiveStreamId()`. |
| `src/destinations/youtubeApiClient.ts` | `getStream()`. |
| `src/destinations/youtubeProvider.ts` | Reuse a persisted `liveStream`; stop deleting it in `finalize()`; stable channel watch URL; `isAuthError()`. |
| `src/destinations/streamDestinationProvider.ts` | Optional `isAuthError?(err)` on the provider interface. |
| `src/destinations/destinationRoutes.ts` | `DELETE` calls `localStreamManager.removeDestination()` instead of `streamManager.stop()`. |
| `src/stream/localStreamManager.ts` | Absorbs forwards: per-user forward map, `setDestinationDesired`, `removeDestination`, `start()` with `destinationIds`/meta, combined `{local, destinations}` status, `'starting'` state, async `stop()`. |
| `src/stream/localStreamRoutes.ts` | New `/start` body fields, `PUT /destinations/:destinationId`, awaited `stop`. |
| `src/stream/streamScene.ts` | Drop `overlayCache`/`sessionId` params and the `renderShared` indirection. |
| `src/stream/types.ts` | Drop `ProviderStatus` and `DestinationStreamStatus` (only the deleted managers used them); `SessionState` and `StreamStatus` stay. |
| `src/api/app.ts` | Unmount the two legacy routers, mount `/stream-presets`, new `createDestinationRouter` dep. |
| `src/server.ts` | Drop `StreamManager`/`StreamSessionManager`; give `LocalStreamManager` the destination repository, providers and spawner; construct `StreamPresetRepository`. |
| `src/api/openapi.ts` | Delete the legacy blocks; rewrite `LocalStreamStatus`; add the toggle route and `/stream-presets`. |
| `test/api/openapi.test.ts`, `test/server.test.ts`, `test/destinations/destinationRoutes.test.ts`, `test/destinations/youtubeProvider.test.ts`, `test/stream/streamScene.test.ts`, `test/stream/localStreamManager.test.ts`, `test/stream/localStreamRoutes.test.ts`, `test/stream/localStreamEvents.test.ts`, `test/stream/reconnectPolicy.test.ts` | Updated for the above. |
| `CLAUDE.md` | Architecture / HTTP API / Layout / known-follow-ups rewrite (Task 15). |

### Frontend — created

| File | Single responsibility |
| --- | --- |
| `frontend/src/api/streamPresets.ts` | Typed client for `/stream-presets`. |
| `frontend/src/components/DestinationToggles.tsx` | The destination checklist: one card per destination with its toggle, forward state, provider phase, watch link and error. |
| `frontend/src/pages/Stream.tsx` | The single stream page: preset picker + start form, transport controls, embedded preview, destination toggles. |
| `frontend/src/api/streamPresets.test.ts`, `frontend/src/components/DestinationToggles.test.tsx`, `frontend/src/pages/Stream.test.tsx` | Tests for each. |

### Frontend — modified / deleted

| File | Change |
| --- | --- |
| `frontend/src/api/localStream.ts` (+ test) | New combined status types, `setDestination`, start options; owns `SessionState` now. |
| `frontend/src/hooks/useLocalStreamStatus.ts` (+ test) | Unchanged mechanism, new payload type. |
| `frontend/src/App.tsx` | `/stream` route + three redirects. |
| `frontend/src/components/Sidebar.tsx` (+ test) | One "Stream" entry. |
| `frontend/src/i18n/locales/{en,ru,uk}.json` | New `stream`/`forwardState` sections; delete `streams`, `startStreamDrawer`, `streamSessionPanel`, `destinationPanel`, `localStream`. |
| **Deleted** | `pages/Streams.tsx(.test)`, `pages/StreamSessionPanel.tsx(.test)`, `components/StartStreamDrawer.tsx(.test)`, `api/streamSessions.ts`, `hooks/useStreamSessionStatus.ts(.test)`, `pages/LocalStream.tsx(.test)`. |

---
### Task 1: A faster backoff schedule for forward-level reconnects

The spec: "Most of the *value* of the existing auto-reconnect feature migrates to the forward level,
which needs ... its own, faster backoff schedule (a relay respawn is cheap and should retry
sub-second; the encoder's 2s-start schedule is tuned for rebuilding a whole pipeline, not a
copy-relay)." One policy module, two call sites — not a second policy module.

**Files:**
- Modify: `src/stream/reconnectPolicy.ts:42-77`
- Test: `test/stream/reconnectPolicy.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `createForwardReconnectPolicy(options?: { isRetryableDestination?: () => boolean; random?: () => number }): ReconnectPolicy`
  - `FORWARD_BACKOFF_SCHEDULE_MS: number[]` (`[500, 1000, 2000, 5000, 10000]`), `FORWARD_BACKOFF_CAP_MS: number` (`10000`)
  - `ReconnectPolicyOptions` gains optional `backoffScheduleMs?: number[]` and `backoffCapMs?: number`.
  - Unchanged and still exported: `ReconnectPolicy`, `ReconnectDecision`, `ReconnectAttemptContext`,
    `SHORT_LIVED_UPTIME_MS`, `CRASH_LOOP_THRESHOLD`, `MAX_ATTEMPTS`, `MAX_TOTAL_MS`,
    `createReconnectPolicy`.

- [ ] **Step 1: Write the failing test**

Append to `test/stream/reconnectPolicy.test.ts` (and extend the import list at the top of the file
to `createForwardReconnectPolicy`, `FORWARD_BACKOFF_SCHEDULE_MS`, `FORWARD_BACKOFF_CAP_MS`):

```typescript
describe('createForwardReconnectPolicy (a destination forward\'s own, faster schedule)', () => {
  // A forward relay is one `-c copy` ffmpeg reconnecting to a container-local MediaMTX. It is
  // cheap to respawn and should be back sub-second — unlike the encoder, whose 2s-start schedule
  // is sized for rebuilding a whole render/encode pipeline.
  it('retries sub-second on the first attempt and keeps the same increasing shape', () => {
    const policy = createForwardReconnectPolicy({ random: () => 0.5 }); // random()*2-1 === 0, no jitter
    const delays = [1, 2, 3, 4, 5].map((attempt) => {
      const decision = policy.decide({ attempt, uptimeMs: 20_000, totalElapsedMs: 0, consecutiveShortLivedFailures: 0 });
      return decision.retry ? decision.delayMs : -1;
    });
    expect(delays).toEqual(FORWARD_BACKOFF_SCHEDULE_MS);
    expect(FORWARD_BACKOFF_SCHEDULE_MS[0]).toBeLessThan(1000);
  });

  it('caps at the forward cap rather than the encoder\'s 30s one', () => {
    const policy = createForwardReconnectPolicy({ random: () => 0.5 });
    const decision = policy.decide({
      attempt: FORWARD_BACKOFF_SCHEDULE_MS.length + 1, uptimeMs: 20_000, totalElapsedMs: 0, consecutiveShortLivedFailures: 0,
    });
    expect(decision).toEqual({ retry: true, delayMs: FORWARD_BACKOFF_CAP_MS });
  });

  it('keeps every generic budget the encoder policy has (crash loop, attempts, total time)', () => {
    const policy = createForwardReconnectPolicy();
    expect(policy.decide({ attempt: 2, uptimeMs: 1, totalElapsedMs: 10, consecutiveShortLivedFailures: CRASH_LOOP_THRESHOLD }))
      .toEqual({ retry: false });
    expect(policy.decide({ attempt: MAX_ATTEMPTS + 1, uptimeMs: 20_000, totalElapsedMs: 10, consecutiveShortLivedFailures: 0 }))
      .toEqual({ retry: false });
    expect(policy.decide({ attempt: 2, uptimeMs: 20_000, totalElapsedMs: MAX_TOTAL_MS, consecutiveShortLivedFailures: 0 }))
      .toEqual({ retry: false });
  });

  it('still honours a provider-side veto', () => {
    const policy = createForwardReconnectPolicy({ isRetryableDestination: () => false });
    expect(policy.decide({ attempt: 1, uptimeMs: 20_000, totalElapsedMs: 0, consecutiveShortLivedFailures: 0 }))
      .toEqual({ retry: false });
  });

  it('leaves the encoder-level schedule exactly as it was', () => {
    const policy = createReconnectPolicy({ random: () => 0.5 });
    const first = policy.decide({ attempt: 1, uptimeMs: 20_000, totalElapsedMs: 0, consecutiveShortLivedFailures: 0 });
    expect(first).toEqual({ retry: true, delayMs: 2000 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest test/stream/reconnectPolicy.test.ts`
Expected: FAIL — `createForwardReconnectPolicy is not a function` / `FORWARD_BACKOFF_SCHEDULE_MS` is
not exported.

- [ ] **Step 3: Implement**

In `src/stream/reconnectPolicy.ts`, replace the backoff constants + `backoffDelayMs` (currently
lines 42-53) with:

```typescript
// Capped exponential backoff for the LOCAL ENCODER: 2s, 5s, 10s, 20s, 30s, then 30s forever after.
const BACKOFF_SCHEDULE_MS = [2_000, 5_000, 10_000, 20_000, 30_000];
const BACKOFF_CAP_MS = 30_000;
// A DESTINATION FORWARD's own schedule: 0.5s, 1s, 2s, 5s, 10s, then 10s forever after. A relay is
// one `-c copy` ffmpeg reconnecting to a container-local MediaMTX — cheap to respawn and worth
// retrying sub-second. The encoder's schedule above is deliberately slower because a respawn there
// rebuilds a whole render/encode pipeline.
export const FORWARD_BACKOFF_SCHEDULE_MS = [500, 1_000, 2_000, 5_000, 10_000];
export const FORWARD_BACKOFF_CAP_MS = 10_000;
// +/-20% jitter so several destinations that dropped at the same moment (e.g. a shared network
// blip) don't all hammer their ingest again in lockstep.
const JITTER_RATIO = 0.2;

function backoffDelayMs(attempt: number, random: () => number, schedule: number[], capMs: number): number {
  const base = schedule[attempt - 1] ?? capMs;
  const jitter = base * JITTER_RATIO * (random() * 2 - 1);
  return Math.max(500, Math.round(base + jitter));
}
```

Then replace `ReconnectPolicyOptions` + `createReconnectPolicy` (currently lines 55-77) with:

```typescript
export interface ReconnectPolicyOptions {
  // Provider-specific veto — e.g. YouTube's DestinationLifecycle being in a terminal phase
  // ('error'/'complete') or having seen an auth-class failure. Absent (CustomRtmpProvider has no
  // lifecycle/broadcast concept at all) means "no provider-side objection" — reconnect is then
  // gated purely on the generic uptime/crash-loop/budget signals below. Called fresh on every
  // decide(), since provider state can change between failures.
  isRetryableDestination?: () => boolean;
  // Override the delay schedule. Present so a destination forward can retry on its own, much
  // faster, schedule while sharing every other budget rule in this module — see
  // createForwardReconnectPolicy below. Note there is deliberately NO "is the source available"
  // veto here: a forward whose SOURCE is down must neither retry nor give up but HOLD, and a
  // retry/give-up policy has no way to express that third outcome. DestinationForward checks the
  // source itself, where the distinction can actually be made.
  backoffScheduleMs?: number[];
  backoffCapMs?: number;
  random?: () => number;
}

export function createReconnectPolicy(options: ReconnectPolicyOptions = {}): ReconnectPolicy {
  const isRetryableDestination = options.isRetryableDestination ?? (() => true);
  const random = options.random ?? Math.random;
  const schedule = options.backoffScheduleMs ?? BACKOFF_SCHEDULE_MS;
  const capMs = options.backoffCapMs ?? BACKOFF_CAP_MS;
  return {
    decide(ctx: ReconnectAttemptContext): ReconnectDecision {
      if (!isRetryableDestination()) return { retry: false };
      if (ctx.consecutiveShortLivedFailures >= CRASH_LOOP_THRESHOLD) return { retry: false };
      if (ctx.attempt > MAX_ATTEMPTS) return { retry: false };
      if (ctx.totalElapsedMs >= MAX_TOTAL_MS) return { retry: false };
      return { retry: true, delayMs: backoffDelayMs(ctx.attempt, random, schedule, capMs) };
    },
  };
}

// The same policy with a destination forward's faster schedule. Two call sites, one module — the
// spec is explicit that this is "a genuinely bigger surface", not a pure simplification, so keep
// the budget rules shared rather than forking the module.
export function createForwardReconnectPolicy(
  options: Omit<ReconnectPolicyOptions, 'backoffScheduleMs' | 'backoffCapMs'> = {},
): ReconnectPolicy {
  return createReconnectPolicy({
    ...options,
    backoffScheduleMs: FORWARD_BACKOFF_SCHEDULE_MS,
    backoffCapMs: FORWARD_BACKOFF_CAP_MS,
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest test/stream/reconnectPolicy.test.ts && npm run build`
Expected: PASS, clean build.

- [ ] **Step 5: Commit**

```bash
git add src/stream/reconnectPolicy.ts test/stream/reconnectPolicy.test.ts
git commit -m "$(cat <<'EOF'
feat: give destination forwards their own faster reconnect backoff

A relay respawn is one -c copy ffmpeg reconnecting to a container-local
MediaMTX; it should retry sub-second rather than on the encoder's 2s-start
schedule, which is sized for rebuilding a whole render/encode pipeline. Same
module, same budget rules, one extra schedule.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `RelayProcess` — one `-c copy` push from MediaMTX to one destination

Spec: "a thin `Spawner`-injected class, structurally near-identical to `PersistentEncoder`:
`start(onExit)` / `stop()` around `ffmpeg -i <mediamtx-read-url> -c copy -f flv <destRtmpUrl>`,
including the same `stopRequested` guard that suppresses `onExit` on a deliberate kill (needed here
for the same reason it's needed there). Testable with the existing fake-child pattern, no new
mocking style."

**Files:**
- Create: `src/ffmpeg/relayProcessArgs.ts`
- Create: `src/ffmpeg/relayProcess.ts`
- Test: `test/ffmpeg/relayProcessArgs.test.ts`, `test/ffmpeg/relayProcess.test.ts`

**Interfaces:**
- Consumes: `Spawner`, `ChildProcessLike` from `src/ffmpeg/types.ts` (unchanged).
- Produces:
  - `buildRelayProcessArgs(params: { inputUrl: string; outputUrl: string }): string[]`
  - `class RelayProcess { constructor(params: { spawner: Spawner; inputUrl: string; outputUrl: string }); start(onExit: (code: number | null) => void): ChildProcessLike; stop(): void }`
  - `interface RelayProcessParams { spawner: Spawner; inputUrl: string; outputUrl: string }`

- [ ] **Step 1: Write the failing argv test**

Create `test/ffmpeg/relayProcessArgs.test.ts`:

```typescript
import { buildRelayProcessArgs } from '../../src/ffmpeg/relayProcessArgs';

const INPUT = 'rtmp://mediamtx:1935/live/abcdef0123456789abcdef0123456789?user=sub&pass=readsecret';
const OUTPUT = 'rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl';

describe('buildRelayProcessArgs', () => {
  it('reads the MediaMTX read URL and writes FLV to the destination', () => {
    const args = buildRelayProcessArgs({ inputUrl: INPUT, outputUrl: OUTPUT });
    expect(args).toContain('-i');
    expect(args[args.indexOf('-i') + 1]).toBe(INPUT);
    expect(args.slice(-3)).toEqual(['-f', 'flv', OUTPUT]);
  });

  // THE rule of this whole design: every forward is -c copy, full stop. Per-destination
  // transcoding would reintroduce one full encode per destination and destroy the entire
  // CPU-sharing premise of the local-first rework.
  it('remuxes only — no encoder, scaler, bitrate or filter option anywhere', () => {
    const args = buildRelayProcessArgs({ inputUrl: INPUT, outputUrl: OUTPUT });
    expect(args).toContain('-c');
    expect(args[args.indexOf('-c') + 1]).toBe('copy');
    for (const banned of ['-c:v', '-c:a', '-b:v', '-b:a', '-s', '-r', '-vf', '-af', '-filter_complex', '-preset']) {
      expect(args).not.toContain(banned);
    }
  });

  // ffmpeg's -reconnect/-reconnect_streamed/-reconnect_delay_max apply to HTTP(S) inputs only.
  // Input-side recovery here is a Node-level respawn owned by DestinationForward; a flag that
  // silently does nothing would be worse than no flag, because it reads as if it worked.
  it('uses no -reconnect* flags, which do not apply to an RTMP input', () => {
    const args = buildRelayProcessArgs({ inputUrl: INPUT, outputUrl: OUTPUT });
    expect(args.some((arg) => arg.startsWith('-reconnect'))).toBe(false);
  });

  it('normalises the output timeline so a relay joining an hours-old session does not emit huge timestamps', () => {
    const args = buildRelayProcessArgs({ inputUrl: INPUT, outputUrl: OUTPUT });
    expect(args).toContain('-avoid_negative_ts');
    expect(args[args.indexOf('-avoid_negative_ts') + 1]).toBe('make_zero');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/ffmpeg/relayProcessArgs.test.ts`
Expected: FAIL — cannot find module `relayProcessArgs`.

- [ ] **Step 3: Implement the argv builder**

Create `src/ffmpeg/relayProcessArgs.ts`:

```typescript
export interface RelayProcessArgsParams {
  // The MediaMTX read URL for the publishing local session, credentials already in the query
  // string: LocalRelaySession.readRtmpUrl, minted in Phase A precisely for this consumer. Never
  // re-derive it — MediaMTX v1.21.0 reads RTMP credentials from query parameters, not userinfo.
  inputUrl: string;
  // The destination's own ingest URL with its stream key already appended, i.e.
  // `${preparedSession.rtmpUrl}/${preparedSession.streamKey}`.
  outputUrl: string;
}

/**
 * One destination forward's ffmpeg argv: pull the already-encoded H.264/AAC out of the local relay
 * and hand it to the destination untouched.
 *
 * The `-c copy` here is load-bearing and is the single rule this file exists to make checkable:
 * per-destination transcoding is explicitly out of scope for this design ("would reintroduce
 * per-destination encodes and destroy the entire CPU-sharing premise") — MediaMTX serves one
 * publisher to N readers, so the local encode's cost does not grow with destination count at all.
 * Never add a codec, scaler, bitrate or filter option here.
 *
 * Deliberately absent: `-reconnect`/`-reconnect_streamed`/`-reconnect_delay_max`. Those apply to
 * HTTP(S) inputs only; an RTMP input ignores them. Input-side recovery is a Node-level respawn
 * owned by DestinationForward.
 */
export function buildRelayProcessArgs(params: RelayProcessArgsParams): string[] {
  return [
    '-hide_banner',
    // `createSpawner()` (src/server.ts) spawns with the default stdio (`['pipe','pipe','pipe']`),
    // so this child never actually shares the parent process's stdin — there is no keystroke-
    // stealing hazard to guard against. `-nostdin` is still worth keeping for its actual effect:
    // without it, ffmpeg spawns a thread polling its own stdin pipe for interactive commands (q to
    // quit, etc.) that nothing here will ever send, which is pointless overhead on a process this
    // app starts and stops entirely by signal. Neither this flag nor `-hide_banner` appears in this
    // repo's other ffmpeg arg builders — this one is the first to add them, not restoring a
    // pre-existing convention.
    '-nostdin',
    '-i', params.inputUrl,
    '-c', 'copy',
    // A relay that joins a session already hours in inherits large non-zero input timestamps.
    // ffmpeg's default (`auto`) already shifts them for a muxer that cannot take negatives, but
    // saying `make_zero` outright means the output timeline starts at 0 for every ingest server,
    // not just the ones that happen to tolerate the default. Verified against real binaries in the
    // smoke-test task rather than assumed.
    '-avoid_negative_ts', 'make_zero',
    '-f', 'flv', params.outputUrl,
  ];
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx jest test/ffmpeg/relayProcessArgs.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing process test**

Create `test/ffmpeg/relayProcess.test.ts`:

```typescript
import { RelayProcess } from '../../src/ffmpeg/relayProcess';
import { Spawner, ChildProcessLike } from '../../src/ffmpeg/types';

function fakeChild(): ChildProcessLike & { emitExit: (code: number | null) => void } {
  let exitListener: ((code: number | null) => void) | null = null;
  return {
    pid: 1,
    stdout: null,
    stderr: null,
    kill: jest.fn(),
    once: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'exit') exitListener = listener as (code: number | null) => void;
    }),
    emitExit: (code) => exitListener && exitListener(code),
  };
}

function buildRelay(spawner: Spawner) {
  return new RelayProcess({
    spawner,
    inputUrl: 'rtmp://mediamtx:1935/live/token?user=sub&pass=s',
    outputUrl: 'rtmp://dest.example/app/key',
  });
}

describe('RelayProcess', () => {
  it('spawns ffmpeg with the relay args and returns the child', () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const returned = buildRelay(spawner).start(() => {});
    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-c', 'copy', '-f', 'flv', 'rtmp://dest.example/app/key']));
    expect(returned).toBe(child);
  });

  it('invokes onExit when the relay dies unexpectedly', () => {
    const child = fakeChild();
    const onExit = jest.fn();
    buildRelay(jest.fn().mockReturnValue(child) as Spawner).start(onExit);
    child.emitExit(1);
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('kills the child on stop', () => {
    const child = fakeChild();
    const relay = buildRelay(jest.fn().mockReturnValue(child) as Spawner);
    relay.start(() => {});
    relay.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  // The same guard PersistentEncoder needs, for the same reason: a deliberate kill must not be
  // mistaken for a dropped destination and trigger a respawn (or, worse, finalize a broadcast the
  // caller is in the middle of toggling off).
  it('does not invoke onExit for the exit that follows a deliberate stop', () => {
    const child = fakeChild();
    const onExit = jest.fn();
    const relay = buildRelay(jest.fn().mockReturnValue(child) as Spawner);
    relay.start(onExit);
    relay.stop();
    child.emitExit(null);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('reports unexpected exits again after a stop/start cycle', () => {
    const child = fakeChild();
    const onExit = jest.fn();
    const relay = buildRelay(jest.fn().mockReturnValue(child) as Spawner);
    relay.start(() => {});
    relay.stop();
    relay.start(onExit);
    child.emitExit(1);
    expect(onExit).toHaveBeenCalledWith(1);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx jest test/ffmpeg/relayProcess.test.ts`
Expected: FAIL — cannot find module `relayProcess`.

- [ ] **Step 7: Implement `RelayProcess`**

Create `src/ffmpeg/relayProcess.ts`:

```typescript
import { Spawner, ChildProcessLike } from './types';
import { buildRelayProcessArgs } from './relayProcessArgs';

export interface RelayProcessParams {
  spawner: Spawner;
  inputUrl: string;
  outputUrl: string;
}

/**
 * One destination forward's ffmpeg process: MediaMTX read in, destination RTMP out, `-c copy` all
 * the way through. Structurally identical to PersistentEncoder on purpose — including the
 * `stopRequested` guard, which exists here for exactly the same reason: a deliberate kill
 * (toggling a destination off, stopping the stream) must never look like a dropped destination and
 * trigger a respawn or a broadcast finalize.
 *
 * A plain `Spawner`, not the `PipeSpawner` the encoder needs: a relay owns its own stdio end to
 * end and shares no pipe with anything, so the `unpipe()`-before-`kill()` discipline the audio leg
 * needs simply does not apply here.
 */
export class RelayProcess {
  private process: ChildProcessLike | null = null;
  private stopRequested = false;

  constructor(private readonly params: RelayProcessParams) {}

  start(onExit: (code: number | null) => void): ChildProcessLike {
    this.stopRequested = false;
    const child = this.params.spawner('ffmpeg', buildRelayProcessArgs(this.params));
    child.once('exit', (code) => {
      if (this.stopRequested) return;
      onExit(code as number | null);
    });
    this.process = child;
    return child;
  }

  stop(): void {
    this.stopRequested = true;
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx jest test/ffmpeg/relayProcess.test.ts test/ffmpeg/relayProcessArgs.test.ts && npm run build`
Expected: PASS, clean build.

- [ ] **Step 9: Commit**

```bash
git add src/ffmpeg/relayProcess.ts src/ffmpeg/relayProcessArgs.ts test/ffmpeg/relayProcess.test.ts test/ffmpeg/relayProcessArgs.test.ts
git commit -m "$(cat <<'EOF'
feat: add RelayProcess, one -c copy push from the local relay to a destination

Reads the MediaMTX read URL LocalRelayTarget has been minting since Phase A and
writes FLV to a destination's ingest, never transcoding. Same stopRequested
guard as PersistentEncoder, and deliberately no -reconnect* flags: those are
HTTP-only and input-side recovery is a Node-level respawn.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 3: `DestinationForward` — desired state plus one reconciler

The heart of Phase B. Spec: "Modeled as desired-state + a reconciler, not an imperative transition
function. Every edge case below (double-toggle, toggle-during-finalize, stop-during-prepare,
toggle-before-start) is the same root cause — an async transition in flight when intent changes — so
one `reconcile()`, re-entered on every relevant event, replaces N special-cased handlers."

**Files:**
- Create: `src/stream/destinationForward.ts`
- Modify: `src/destinations/streamDestinationProvider.ts:34-36` (add optional `isAuthError`)
- Test: `test/stream/destinationForward.test.ts`

**Interfaces:**
- Consumes: `RelayProcess` + `RelayProcessParams` (Task 2); `createForwardReconnectPolicy`,
  `ReconnectPolicy`, `ReconnectDecision`, `SHORT_LIVED_UPTIME_MS` (Task 1 /
  `src/stream/reconnectPolicy.ts`); `BroadcastMeta`, `PreparedSession`, `DestinationLifecycle`,
  `StreamDestinationProvider` (`src/destinations/streamDestinationProvider.ts`); Prisma's
  `StreamDestination`.
- Produces:
  - `type ForwardDesiredState = 'on' | 'off'`
  - `type ForwardActualState = 'off' | 'pending' | 'preparing' | 'connecting' | 'live' | 'stopping' | 'error'`
  - `type ForwardErrorReason = 'auth' | 'provider' | 'relay' | 'source'`
  - `interface ForwardProviderStatus { type: string; phase: string; watchUrl: string | null }`
  - `interface ForwardError { reason: ForwardErrorReason; message: string }`
  - `interface DestinationForwardStatus { destinationId: string; name: string; desired: ForwardDesiredState; state: ForwardActualState; provider?: ForwardProviderStatus; error?: ForwardError }`
  - `interface DestinationForwardDeps { destination: StreamDestination; provider: StreamDestinationProvider; meta: () => BroadcastMeta; sourceUrl: () => string | null; isSourcePublishing: () => boolean; createRelay: (p: { inputUrl: string; outputUrl: string }) => RelayProcess; reconnectPolicy: ReconnectPolicy; onStatusChanged: () => void; now?: () => number; setTimer?: (fn: () => void, delayMs: number) => NodeJS.Timeout; clearTimer?: (t: NodeJS.Timeout) => void }`
  - `class DestinationForward { readonly destinationId: string; setDesired(d: ForwardDesiredState): void; reconcile(): Promise<void>; shutdown(): Promise<void>; status(): DestinationForwardStatus; isInactive(): boolean }`
  - `StreamDestinationProvider` gains optional `isAuthError?(err: unknown): boolean`.

- [ ] **Step 1: Add the optional provider-side error classifier**

`DestinationForward` must tell "reconnect your YouTube account" (`auth`) from "the platform
hiccuped" (`provider`) without knowing anything YouTube-specific. The provider is the only layer
that can classify its own errors, so the classification goes on its interface. In
`src/destinations/streamDestinationProvider.ts`, replace the `StreamDestinationProvider` interface
(currently lines 34-36) with:

```typescript
export interface StreamDestinationProvider {
  prepareSession(destination: StreamDestination, meta: BroadcastMeta): Promise<PreparedSession>;
  // Classify a prepareSession() rejection as an auth-class failure — a revoked/expired grant that
  // retrying will never fix — rather than a transient provider error. Absent (CustomRtmpProvider
  // has no account to revoke) means "never auth-class". This lives on the provider because it is
  // the only layer that knows its own API's error shapes; DestinationForward stays free of any
  // YouTube-specific knowledge.
  isAuthError?(err: unknown): boolean;
}
```

- [ ] **Step 2: Write the failing test**

Create `test/stream/destinationForward.test.ts`:

```typescript
import { StreamDestination } from '@prisma/client';
import { DestinationForward, DestinationForwardDeps } from '../../src/stream/destinationForward';
import { createForwardReconnectPolicy, SHORT_LIVED_UPTIME_MS } from '../../src/stream/reconnectPolicy';
import { DestinationLifecycle, PreparedSession } from '../../src/destinations/streamDestinationProvider';

const SOURCE_URL = 'rtmp://mediamtx:1935/live/abcdef0123456789abcdef0123456789?user=sub&pass=r';

function destination(overrides: Partial<StreamDestination> = {}): StreamDestination {
  return {
    id: 'dest-1', userId: 'user-1', name: 'My channel', rtmpUrl: 'rtmp://dest.example/app',
    streamKeyEncrypted: null, provider: 'custom', youtubeLiveStreamId: null, createdAt: new Date(),
    ...overrides,
  } as StreamDestination;
}

function fakeLifecycle(): DestinationLifecycle & { setPhase: (p: string) => void; finalized: jest.Mock } {
  let phase = 'creating';
  let listener: (() => void) | null = null;
  const finalized = jest.fn().mockResolvedValue(undefined);
  return {
    onPushStarted: jest.fn(() => { phase = 'waitingForYoutube'; listener?.(); }),
    phase: () => phase,
    watchUrl: () => 'https://www.youtube.com/channel/UC123/live',
    finalize: finalized,
    onPhaseChange: (cb: () => void) => { listener = cb; },
    isAuthError: () => false,
    setPhase: (p: string) => { phase = p; listener?.(); },
    finalized,
  } as never;
}

function fakeRelay() {
  const relay = {
    start: jest.fn(),
    stop: jest.fn(),
    exit: (code: number | null) => { (relay.start.mock.calls.at(-1)![0] as (c: number | null) => void)(code); },
  };
  return relay;
}

interface Harness {
  forward: DestinationForward;
  prepareSession: jest.Mock;
  relays: ReturnType<typeof fakeRelay>[];
  createRelay: jest.Mock;
  lastRelay: () => ReturnType<typeof fakeRelay>;
  onStatusChanged: jest.Mock;
  setSource: (url: string | null, publishing?: boolean) => void;
  timers: { fn: () => void; delayMs: number }[];
  runTimers: () => void;
  clock: { now: number };
}

function buildForward(options: {
  lifecycle?: DestinationLifecycle | null;
  destination?: StreamDestination;
  isAuthError?: (err: unknown) => boolean;
} = {}): Harness {
  const relays: ReturnType<typeof fakeRelay>[] = [];
  const timers: { fn: () => void; delayMs: number }[] = [];
  const clock = { now: 1_000_000 };
  let sourceUrl: string | null = SOURCE_URL;
  let publishing = true;

  const lifecycle = options.lifecycle === undefined ? null : options.lifecycle;
  const prepareSession = jest.fn(async (): Promise<PreparedSession> => ({
    rtmpUrl: 'rtmp://dest.example/app', streamKey: 'secret-key', lifecycle: lifecycle ?? undefined,
  }));
  const createRelay = jest.fn(() => { const relay = fakeRelay(); relays.push(relay); return relay; });
  const onStatusChanged = jest.fn();

  const deps: DestinationForwardDeps = {
    destination: options.destination ?? destination(),
    provider: { prepareSession, isAuthError: options.isAuthError } as never,
    meta: () => ({ title: 'Friday Mix' }),
    sourceUrl: () => sourceUrl,
    isSourcePublishing: () => publishing && sourceUrl !== null,
    createRelay: createRelay as never,
    reconnectPolicy: createForwardReconnectPolicy({ random: () => 0.5 }),
    onStatusChanged,
    now: () => clock.now,
    // The handle IS the entry, and clearTimer really removes it — load-bearing, not cosmetic: the
    // forward legitimately holds two timers at once (a custom-RTMP promotion timer and a relay
    // respawn timer), and a no-op clearTimer would leave the cancelled one in this array and make
    // every "expect exactly one pending timer" assertion below read the wrong entry.
    setTimer: ((fn: () => void, delayMs: number) => {
      const handle = { fn, delayMs };
      timers.push(handle);
      return handle as never;
    }) as never,
    clearTimer: ((handle: { fn: () => void; delayMs: number }) => {
      const index = timers.indexOf(handle);
      if (index >= 0) timers.splice(index, 1);
    }) as never,
  };

  return {
    forward: new DestinationForward(deps),
    prepareSession, relays, createRelay, onStatusChanged, timers, clock,
    lastRelay: () => relays[relays.length - 1],
    setSource: (url, isPublishing = true) => { sourceUrl = url; publishing = isPublishing; },
    runTimers: () => { const pending = timers.splice(0, timers.length); for (const t of pending) t.fn(); },
  };
}

describe('DestinationForward — pending and toggling', () => {
  it('starts off, with no side effects at all', () => {
    const h = buildForward();
    expect(h.forward.status()).toEqual({ destinationId: 'dest-1', name: 'My channel', desired: 'off', state: 'off' });
    expect(h.prepareSession).not.toHaveBeenCalled();
  });

  // Spec open question #3: toggle-on-while-idle is `pending`, not a 409 — so "start with these
  // three pre-checked" and "check a box mid-stream" are one code path.
  it('parks at pending with zero external side effects when nothing is publishing yet', async () => {
    const h = buildForward();
    h.setSource(null);
    h.forward.setDesired('on');
    await h.forward.reconcile();
    expect(h.forward.status().state).toBe('pending');
    expect(h.prepareSession).not.toHaveBeenCalled();
    expect(h.createRelay).not.toHaveBeenCalled();
  });

  it('prepares the provider session and starts a relay once the source is publishing', async () => {
    const h = buildForward();
    h.forward.setDesired('on');
    await h.forward.reconcile();
    expect(h.prepareSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'dest-1' }), { title: 'Friday Mix' });
    expect(h.createRelay).toHaveBeenCalledWith({ inputUrl: SOURCE_URL, outputUrl: 'rtmp://dest.example/app/secret-key' });
    expect(h.lastRelay().start).toHaveBeenCalled();
    expect(h.forward.status().state).toBe('connecting');
  });

  it('is idempotent: setting the same desired state twice changes nothing', async () => {
    const h = buildForward();
    h.forward.setDesired('on');
    await h.forward.reconcile();
    h.forward.setDesired('on');
    await h.forward.reconcile();
    expect(h.prepareSession).toHaveBeenCalledTimes(1);
    expect(h.createRelay).toHaveBeenCalledTimes(1);
  });

  it('stops the relay and finalizes the broadcast on toggle-off', async () => {
    const lifecycle = fakeLifecycle();
    const h = buildForward({ lifecycle });
    h.forward.setDesired('on');
    await h.forward.reconcile();
    const relay = h.lastRelay();
    h.forward.setDesired('off');
    await h.forward.reconcile();
    expect(relay.stop).toHaveBeenCalled();
    expect(lifecycle.finalize).toHaveBeenCalled();
    expect(h.forward.status()).toEqual({ destinationId: 'dest-1', name: 'My channel', desired: 'off', state: 'off' });
  });

  // Spec, "preparing": a desired->off arriving mid-prepare must not drop the returned lifecycle on
  // the floor — the broadcast is already live on YouTube by then and nothing else can ever end it.
  it('finalizes a broadcast whose prepareSession resolved after the user toggled off', async () => {
    const lifecycle = fakeLifecycle();
    const h = buildForward({ lifecycle });
    let releasePrepare!: () => void;
    h.prepareSession.mockImplementationOnce(() => new Promise<PreparedSession>((resolve) => {
      releasePrepare = () => resolve({ rtmpUrl: 'rtmp://dest.example/app', streamKey: 'secret-key', lifecycle });
    }));
    h.forward.setDesired('on');
    const settling = h.forward.reconcile();
    expect(h.forward.status().state).toBe('preparing');

    h.forward.setDesired('off');
    releasePrepare();
    await settling;
    await h.forward.reconcile();

    expect(lifecycle.finalize).toHaveBeenCalledTimes(1);
    expect(h.createRelay).not.toHaveBeenCalled();
    expect(h.forward.status().state).toBe('off');
  });

  // Spec, "stopping": without this state a re-toggle-on mid-finalize races a second broadcast
  // against the first.
  it('re-toggling on while a finalize is in flight does not start a second broadcast underneath it', async () => {
    const lifecycle = fakeLifecycle();
    const h = buildForward({ lifecycle });
    let releaseFinalize!: () => void;
    (lifecycle.finalize as jest.Mock).mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseFinalize = resolve;
    }));
    h.forward.setDesired('on');
    await h.forward.reconcile();
    h.forward.setDesired('off');
    const stopping = h.forward.reconcile();
    expect(h.forward.status().state).toBe('stopping');

    h.forward.setDesired('on');
    expect(h.prepareSession).toHaveBeenCalledTimes(1);
    releaseFinalize();
    await stopping;
    await h.forward.reconcile();

    expect(lifecycle.finalize).toHaveBeenCalledTimes(1);
    expect(h.prepareSession).toHaveBeenCalledTimes(2);
    expect(h.forward.status().state).toBe('connecting');
  });
});

describe('DestinationForward — source availability', () => {
  // Spec: forwards HOLD while the local stream is reconnecting. Finalizing there would burn ~330
  // quota units and hand viewers a new watch URL for what is a few seconds of ingest gap.
  it('holds without finalizing while the local stream is reconnecting', async () => {
    const lifecycle = fakeLifecycle();
    const h = buildForward({ lifecycle });
    h.forward.setDesired('on');
    await h.forward.reconcile();
    const relay = h.lastRelay();

    h.setSource(SOURCE_URL, false); // encoder died; MediaMTX will drop this reader within ~1s
    relay.exit(1);
    await h.forward.reconcile();

    expect(lifecycle.finalize).not.toHaveBeenCalled();
    expect(h.forward.status().state).toBe('connecting');
    expect(h.timers).toHaveLength(0); // no retry scheduled: not this destination's problem
  });

  it('starts a fresh relay against the same broadcast once the source comes back', async () => {
    const lifecycle = fakeLifecycle();
    const h = buildForward({ lifecycle });
    h.forward.setDesired('on');
    await h.forward.reconcile();
    h.setSource(SOURCE_URL, false);
    h.lastRelay().exit(1);
    await h.forward.reconcile();

    h.setSource(SOURCE_URL, true);
    await h.forward.reconcile();

    expect(h.prepareSession).toHaveBeenCalledTimes(1); // same broadcast, no second one
    expect(h.createRelay).toHaveBeenCalledTimes(2);
  });

  // Only when the local stream is definitively over (idle, or reconnect gave up) does a forward
  // finalize — and it goes back to `pending`, not `off`, because the user still wants it.
  it('finalizes and returns to pending when the local session is gone for good', async () => {
    const lifecycle = fakeLifecycle();
    const h = buildForward({ lifecycle });
    h.forward.setDesired('on');
    await h.forward.reconcile();

    h.setSource(null);
    await h.forward.reconcile();

    expect(lifecycle.finalize).toHaveBeenCalledTimes(1);
    expect(h.forward.status()).toEqual({ destinationId: 'dest-1', name: 'My channel', desired: 'on', state: 'pending' });
  });
});

describe('DestinationForward — relay failure', () => {
  it('schedules a respawn on an unexpected relay exit while the source is healthy', async () => {
    const h = buildForward();
    h.forward.setDesired('on');
    await h.forward.reconcile();
    h.clock.now += 60_000; // a long-lived relay: a real drop, not a startup failure
    h.lastRelay().exit(1);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].delayMs).toBe(500);
    expect(h.forward.status().state).toBe('connecting');

    h.runTimers();
    await h.forward.reconcile();
    expect(h.createRelay).toHaveBeenCalledTimes(2);
  });

  // The terminal-phase check must win even while a respawn is merely SCHEDULED, not yet running —
  // branch 6 (`if (!this.relay) { if (this.retryTimer) return; ... }`) used to return before ever
  // reaching the old single call site of the terminal check (branch 7, `syncProviderPhase()`,
  // reachable only once a relay is actually up). Without the earlier check, the pending timer would
  // fire later and push into a broadcast the provider had already ended.
  it('does not respawn into a broadcast the provider ended while a retry was pending', async () => {
    const lifecycle = fakeLifecycle();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = buildForward({ lifecycle });
      h.forward.setDesired('on');
      await h.forward.reconcile();
      h.clock.now += 60_000; // a long-lived relay: a real drop, not a startup failure
      h.lastRelay().exit(1);
      expect(h.timers).toHaveLength(1); // the respawn timer, scheduled but not yet fired

      // The provider ends the broadcast (YouTube's own health-check timeout, or an auth failure)
      // while that timer is still pending. setPhase() synchronously starts a NEW reconcile loop
      // (branch 3's giveUp() -> again() -> reconcile()), but reaching 'error' takes several more
      // passes after that (branch 2's own setState('stopping') -> await finalizeSession() ->
      // finalize()'s promise -> another pass to setState('error')) — a single microtask hop is not
      // enough to observe the end state, only the first pass's effects. await the forward's own
      // reconcile() (which resolves once its whole run() loop drains, same pattern as the sibling
      // "stays in error" test below) rather than a bare microtask.
      lifecycle.setPhase('error');
      await h.forward.reconcile();

      expect(h.forward.status().state).toBe('error');
      expect(lifecycle.finalize).toHaveBeenCalledTimes(1);
      expect(h.timers).toHaveLength(0); // the now-irrelevant respawn timer was cleared, not left to fire later

      // Even if it somehow still fired, it must not create a second relay into a dead broadcast.
      h.runTimers();
      await h.forward.reconcile();
      expect(h.createRelay).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('gives up with a relay error after two consecutive short-lived failures, and finalizes', async () => {
    const lifecycle = fakeLifecycle();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = buildForward({ lifecycle });
      h.forward.setDesired('on');
      await h.forward.reconcile();
      h.lastRelay().exit(1);        // short-lived #1 -> retry
      h.runTimers();
      await h.forward.reconcile();
      h.lastRelay().exit(1);        // short-lived #2 -> crash-loop threshold
      await h.forward.reconcile();

      const status = h.forward.status();
      expect(status.state).toBe('error');
      expect(status.error?.reason).toBe('relay');
      expect(lifecycle.finalize).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('stays in error until the user toggles it off and on again', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = buildForward();
      h.forward.setDesired('on');
      await h.forward.reconcile();
      h.lastRelay().exit(1);
      h.runTimers();
      await h.forward.reconcile();
      h.lastRelay().exit(1);
      await h.forward.reconcile();
      expect(h.forward.status().state).toBe('error');

      await h.forward.reconcile(); // an unrelated status change must not re-arm it
      expect(h.createRelay).toHaveBeenCalledTimes(2);

      h.forward.setDesired('off');
      await h.forward.reconcile();
      h.forward.setDesired('on');
      await h.forward.reconcile();
      expect(h.createRelay).toHaveBeenCalledTimes(3);
      expect(h.forward.status().error).toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }
  });

  // A custom-RTMP destination has no lifecycle to poll, so surviving SHORT_LIVED_UPTIME_MS is the
  // only "connected" signal there is.
  it('promotes a lifecycle-less destination from connecting to live once the relay has survived', async () => {
    const h = buildForward();
    h.forward.setDesired('on');
    await h.forward.reconcile();
    expect(h.timers[0].delayMs).toBe(SHORT_LIVED_UPTIME_MS);
    h.runTimers();
    expect(h.forward.status().state).toBe('live');
  });
});

describe('DestinationForward — provider lifecycle', () => {
  it('reports the provider phase and watch URL, and goes live when the provider does', async () => {
    const lifecycle = fakeLifecycle();
    const h = buildForward({ lifecycle });
    h.forward.setDesired('on');
    await h.forward.reconcile();
    expect(lifecycle.onPushStarted).toHaveBeenCalled();
    expect(h.forward.status().provider).toEqual({
      type: 'custom', phase: 'waitingForYoutube', watchUrl: 'https://www.youtube.com/channel/UC123/live',
    });

    (lifecycle as never as { setPhase: (p: string) => void }).setPhase('live');
    await h.forward.reconcile();
    expect(h.forward.status().state).toBe('live');
  });

  // The YouTube health-check timeout (or an auth short-circuit) puts the lifecycle in a terminal
  // phase. That must stop THIS forward's relay — which used to keep pushing at a dead ingest until
  // a human intervened — and must never touch the local encode or a sibling forward.
  it('gives up and stops its relay when the provider ends the broadcast on its own', async () => {
    const lifecycle = fakeLifecycle();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = buildForward({ lifecycle });
      h.forward.setDesired('on');
      await h.forward.reconcile();
      const relay = h.lastRelay();

      (lifecycle as never as { setPhase: (p: string) => void }).setPhase('error');
      await h.forward.reconcile();

      expect(relay.stop).toHaveBeenCalled();
      expect(h.forward.status().state).toBe('error');
      expect(h.forward.status().error?.reason).toBe('provider');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('classifies a prepareSession rejection through the provider\'s own isAuthError', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = buildForward({ isAuthError: () => true });
      h.prepareSession.mockRejectedValueOnce(new Error('invalid_grant'));
      h.forward.setDesired('on');
      await h.forward.reconcile();
      expect(h.forward.status()).toEqual(expect.objectContaining({
        state: 'error', error: { reason: 'auth', message: 'invalid_grant' },
      }));
      expect(h.createRelay).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('falls back to a provider error when the provider cannot classify it', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = buildForward();
      h.prepareSession.mockRejectedValueOnce(new Error('503 from YouTube'));
      h.forward.setDesired('on');
      await h.forward.reconcile();
      expect(h.forward.status().error).toEqual({ reason: 'provider', message: '503 from YouTube' });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('DestinationForward — shutdown', () => {
  it('shutdown turns it off, kills the relay and awaits the finalize', async () => {
    const lifecycle = fakeLifecycle();
    const h = buildForward({ lifecycle });
    h.forward.setDesired('on');
    await h.forward.reconcile();
    const relay = h.lastRelay();

    await h.forward.shutdown();

    expect(relay.stop).toHaveBeenCalled();
    expect(lifecycle.finalize).toHaveBeenCalledTimes(1);
    expect(h.forward.isInactive()).toBe(true);
  });

  it('reports inactive only when it wants nothing and holds nothing', async () => {
    const h = buildForward();
    expect(h.forward.isInactive()).toBe(true);
    h.forward.setDesired('on');
    expect(h.forward.isInactive()).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest test/stream/destinationForward.test.ts`
Expected: FAIL — cannot find module `destinationForward`. (It will also fail to type-check
`youtubeLiveStreamId` on `StreamDestination` until Task 4 adds it — that field is cast through
`as StreamDestination` in the fixture above precisely so this task does not depend on the migration.)

- [ ] **Step 4: Implement**

Create `src/stream/destinationForward.ts`:

```typescript
import { StreamDestination } from '@prisma/client';
import { RelayProcess } from '../ffmpeg/relayProcess';
import { BroadcastMeta, PreparedSession, StreamDestinationProvider } from '../destinations/streamDestinationProvider';
import { ReconnectDecision, ReconnectPolicy, SHORT_LIVED_UPTIME_MS } from './reconnectPolicy';

export type ForwardDesiredState = 'on' | 'off';
// 'pending'    — the user wants this destination, but nothing is publishing locally yet. ZERO
//                external side effects: no prepareSession(), no YouTube broadcast, nothing.
// 'preparing'  — prepareSession() is in flight (where YouTube auth errors surface).
// 'connecting' — a relay is running but the destination has not confirmed it yet.
// 'live'       — the destination confirmed it (YouTube phase 'live'; for a lifecycle-less custom
//                RTMP destination, a relay that survived SHORT_LIVED_UPTIME_MS).
// 'stopping'   — finalize() is in flight; without this state a re-toggle-on mid-finalize would
//                race a second broadcast against the first.
// 'error'      — gave up, with a reason. Cleared by EITHER of two things: the user toggling it off
//                and on again (setDesired()), or the local session it was reading from disappearing
//                entirely (pass()'s branch 1, which resets givenUp so a brand-new local session
//                doesn't inherit a stale failure) — not just the toggle alone.
export type ForwardActualState = 'off' | 'pending' | 'preparing' | 'connecting' | 'live' | 'stopping' | 'error';
// 'source' is declared for completeness (the spec names it, and the UI type needs to be able to
// represent it) but is currently UNREACHABLE by construction: a source outage is handled as a
// HOLD (pass()'s branch 4), never an error — finalizing a broadcast every time the local encoder
// hiccups would defeat the entire point of the hold rule. Nothing in this task sets this reason;
// don't add a code path that does without first re-deciding that hold rule.
export type ForwardErrorReason = 'auth' | 'provider' | 'relay' | 'source';

export interface ForwardProviderStatus {
  type: string;
  phase: string;
  watchUrl: string | null;
}

export interface ForwardError {
  reason: ForwardErrorReason;
  message: string;
}

export interface DestinationForwardStatus {
  destinationId: string;
  name: string;
  desired: ForwardDesiredState;
  state: ForwardActualState;
  // Present only while a provider lifecycle exists (i.e. YouTube). A custom RTMP destination has
  // no broadcast concept at all.
  provider?: ForwardProviderStatus;
  error?: ForwardError;
}

export interface DestinationForwardDeps {
  destination: StreamDestination;
  provider: StreamDestinationProvider;
  // Resolved lazily: a forward can exist (desired=on, actual=pending) before any local stream is
  // running, and the broadcast metadata only exists once one is.
  meta: () => BroadcastMeta;
  // The CURRENT local session's MediaMTX read URL, or null when this account has no live session
  // to read from (never started, stopped, or reconnect gave up). Deliberately NON-null while the
  // local stream is merely 'reconnecting' — see the hold rule in pass().
  sourceUrl: () => string | null;
  // True only while the encoder is actually publishing into MediaMTX ('streaming' or 'paused').
  isSourcePublishing: () => boolean;
  createRelay: (params: { inputUrl: string; outputUrl: string }) => RelayProcess;
  reconnectPolicy: ReconnectPolicy;
  onStatusChanged: () => void;
  // Injected so tests can drive time and timers without jest fake timers leaking across the
  // reconcile loop's awaits.
  now?: () => number;
  setTimer?: (fn: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

const defaultSetTimer = (fn: () => void, delayMs: number): NodeJS.Timeout => {
  const timer = setTimeout(fn, delayMs);
  // Never let a pending respawn or promotion timer hold the process open on shutdown — the same
  // discipline CanvasFeeder's heartbeat and LocalStreamManager's expiry timer already follow.
  timer.unref();
  return timer;
};

/**
 * One destination's forward for one user: policy and lifecycle only.
 *
 * Deliberately has ZERO knowledge of child processes beyond the injected `createRelay` factory —
 * the bytes are RelayProcess's problem. Every edge case the spec enumerates (double-toggle,
 * toggle-during-prepare, toggle-during-finalize, toggle-before-start, source loss, relay crash) is
 * the same root cause: an async transition in flight when intent changes. So there is exactly one
 * `reconcile()` loop, re-entered on every relevant event, instead of N special-cased handlers.
 *
 * Hard invariant this class exists to protect: a forward NEVER touches the local encode or any
 * sibling forward, no matter how it fails.
 */
export class DestinationForward {
  private desired: ForwardDesiredState = 'off';
  private actual: ForwardActualState = 'off';
  private session: PreparedSession | null = null;
  private relay: RelayProcess | null = null;
  private relayStartedAt: number | null = null;
  private error: ForwardError | null = null;
  // Sticky "stop trying": set when prepareSession() failed, when the relay's reconnect budget ran
  // out, or when the provider's own lifecycle reached a terminal phase. Only setDesired() and a
  // vanished local session clear it, so a failed forward never silently re-arms itself on an
  // unrelated reconcile() (of which there is one per local status change).
  private givenUp = false;
  private busy = false;
  private running: Promise<void> | null = null;
  private pendingPass = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private promotionTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private firstFailureAt: number | null = null;
  private consecutiveShortLivedFailures = 0;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, delayMs: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;

  constructor(private readonly deps: DestinationForwardDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? defaultSetTimer;
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  get destinationId(): string {
    return this.deps.destination.id;
  }

  /**
   * Re-applies a freshly-read `StreamDestination` row. Called by `LocalStreamManager` on EVERY
   * `getOrCreateForward()` lookup — including for an already-existing forward — never only at
   * construction. This forward object can outlive many `prepareSession()` calls (a respawn, a
   * toggle-off-then-on, a 'pending' forward that finally starts), and `YoutubeProvider
   * .prepareSession()` persists the reusable `youtubeLiveStreamId` to the DATABASE, not back onto
   * whatever row object the caller happened to pass in. Without this method, this forward's own
   * `this.deps.destination` would keep the stale (pre-persist) copy forever, so the NEXT
   * `prepareSession()` on the SAME forward would never see the id it just wrote — defeating the
   * entire liveStream-reuse feature and, since `finalize()` no longer deletes the liveStream,
   * leaking a new one on every call.
   */
  setDestination(destination: StreamDestination): void {
    this.deps.destination = destination;
  }

  /** Set directly and idempotently by the checkbox. Never blocks on the reconcile it triggers. */
  setDesired(desired: ForwardDesiredState): void {
    if (this.desired === desired) return;
    this.desired = desired;
    this.error = null;
    this.givenUp = false;
    this.resetRetryBudget();
    this.deps.onStatusChanged();
    void this.reconcile();
  }

  /** Turn off, tear down and wait for the provider-side finalize to complete. */
  async shutdown(): Promise<void> {
    this.setDesired('off');
    await this.reconcile();
  }

  /**
   * True when this forward wants nothing, holds nothing, AND has finished settling — safe for the
   * manager to drop. `actual === 'off'` is load-bearing, not redundant with the session/relay
   * checks: `finalizeSession()` nulls `this.session` (and `stopRelay()` nulls `this.relay`)
   * BEFORE the finalize `await` resolves, while `this.actual` stays `'stopping'` throughout. A
   * check that only looked at session/relay would call a forward "inactive" while its finalize is
   * still in flight — pruning it out from under itself, so a re-toggle-on arriving during that
   * window builds a BRAND NEW forward via `getOrCreateForward` instead of reaching the surviving
   * object's `stopping` branch, racing a second `prepareSession()` against the first's still-
   * running `finalize()`. That is exactly the hazard the spec names ("without this state, a
   * re-toggle-on mid-finalize races a second broadcast against the first") — this method is the
   * one place that hazard can be silently reopened by a plausible-looking simplification.
   */
  isInactive(): boolean {
    return this.desired === 'off' && this.actual === 'off' && this.session === null && this.relay === null;
  }

  status(): DestinationForwardStatus {
    const status: DestinationForwardStatus = {
      destinationId: this.deps.destination.id,
      name: this.deps.destination.name,
      desired: this.desired,
      state: this.actual,
    };
    const lifecycle = this.session?.lifecycle;
    if (lifecycle) {
      status.provider = {
        type: this.deps.destination.provider,
        phase: lifecycle.phase(),
        watchUrl: lifecycle.watchUrl(),
      };
    }
    if (this.error) status.error = this.error;
    return status;
  }

  /**
   * Drive this forward toward its desired state. Safe to call from anywhere at any time: a call
   * that arrives while a pass is in flight just asks the running loop to go round again, and
   * returns that loop's promise so a caller (shutdown()) can await the whole settle.
   */
  reconcile(): Promise<void> {
    if (this.busy) {
      this.pendingPass = true;
      // `running` is only momentarily null here — for the synchronous stretch between `busy = true`
      // and the assignment below — and a caller in that window still gets its work done via
      // pendingPass; it just cannot await it. The only awaiting caller is shutdown(), which always
      // arrives after the loop has suspended.
      return this.running ?? Promise.resolve();
    }
    this.busy = true;
    this.running = this.run();
    return this.running;
  }

  private async run(): Promise<void> {
    try {
      do {
        this.pendingPass = false;
        await this.pass();
      } while (this.pendingPass);
    } catch (err) {
      // pass() guards every external call itself; anything reaching here is a programming error,
      // and it must never become an unhandled rejection that takes the whole process down — and
      // with it every other tenant's stream.
      console.error(`[stream] destination ${this.destinationId}: reconcile pass failed`, err);
    } finally {
      this.busy = false;
      this.running = null;
    }
  }

  // Ask for another pass. Inside a running loop this just makes it go round again; from a callback
  // (relay exit, provider phase change, retry timer) it starts one.
  private again(): void {
    this.pendingPass = true;
    if (!this.busy) void this.reconcile();
  }

  private async pass(): Promise<void> {
    const sourceUrl = this.deps.sourceUrl();

    // 1. The user doesn't want this destination, or the local session it would read from is gone
    //    for good (never started, stopped, or reconnect gave up). Either way: no relay, no
    //    broadcast, and a clean slate for the next session.
    if (this.desired === 'off' || sourceUrl === null) {
      this.clearRetryTimer();
      this.clearPromotionTimer();
      this.stopRelay();
      if (this.session) {
        this.setState('stopping');
        await this.finalizeSession();
        this.again();
        return;
      }
      this.givenUp = false;
      this.setError(null);
      this.resetRetryBudget();
      // 'pending', not 'off', when the user still wants it: the UI shows "will start with the
      // stream" and the next start() reconciles it into life with no extra orchestration.
      this.setState(this.desired === 'off' ? 'off' : 'pending');
      return;
    }

    // 2. This forward has given up (the provider rejected it, the provider ended the broadcast, or
    //    the relay's reconnect budget ran out). Sticky: never silently re-arm on an unrelated
    //    reconcile. Only a toggle, or the local session ending, clears it.
    if (this.givenUp) {
      this.clearRetryTimer();
      this.clearPromotionTimer();
      this.stopRelay();
      if (this.session) {
        this.setState('stopping');
        await this.finalizeSession();
        this.again();
        return;
      }
      this.setState('error');
      return;
    }

    // 3. The provider already ended this broadcast on its own (YouTube's health-check timeout, or
    //    an auth-class failure short-circuiting it), checked BEFORE the hold/relay branches below —
    //    not only from branch 7 (running). A terminal phase can arrive while a relay respawn is
    //    merely SCHEDULED (branch 6 returns early via `if (this.retryTimer) return;` without ever
    //    reaching the old single call site in branch 7's `syncProviderPhase()`), and without this
    //    check here, the pending timer fires later and pushes into a broadcast the provider has
    //    already completed or errored — the exact standing CLAUDE.md follow-up this whole task
    //    exists to close, reopened by a timing gap rather than a missing check.
    if (this.checkTerminalProviderPhase()) return;

    // 4. HOLD. The encoder is not publishing right now (the local stream is starting, or
    //    reconnecting after a crash). MediaMTX drops every reader within ~1s of the publisher
    //    disconnecting, so this forward's relay is already dead or about to be — but the broadcast
    //    must NOT be finalized and this forward's own reconnect budget must NOT be spent on a
    //    problem that isn't its. The manager re-runs reconcile() when the local stream comes back.
    if (!this.deps.isSourcePublishing()) {
      this.clearRetryTimer();
      this.clearPromotionTimer();
      this.stopRelay();
      this.setState(this.session ? 'connecting' : 'pending');
      return;
    }

    // 5. Nothing prepared yet — ask the provider for this session's ingest target (and, for
    //    YouTube, create and bind the ephemeral broadcast). The FIRST external side effect this
    //    forward ever has.
    if (!this.session) {
      this.setState('preparing');
      let session: PreparedSession;
      try {
        session = await this.deps.provider.prepareSession(this.deps.destination, this.deps.meta());
      } catch (err) {
        this.giveUp(this.deps.provider.isAuthError?.(err) ? 'auth' : 'provider', err);
        return;
      }
      // HARD INVARIANT (spec, "preparing"): register what prepareSession() returned BEFORE any
      // re-check of desired state. A `desired -> off` that arrived while this call was in flight
      // must find a lifecycle to finalize — dropping it here orphans a live YouTube broadcast with
      // nothing left that could ever end it. Branch 1 on the next pass does the finalizing.
      this.session = session;
      session.lifecycle?.onPhaseChange?.(() => this.onProviderPhaseChanged(session));
      this.again();
      return;
    }

    // 6. Prepared and publishing, but no relay running. A scheduled respawn owns the next attempt
    //    when one is pending — starting a second relay here would double-push to the destination.
    if (!this.relay) {
      if (this.retryTimer) return;
      this.startRelay(sourceUrl);
      this.setState('connecting');
      // onPushStarted fires on RELAY spawn, not encoder spawn: the encoder no longer touches any
      // real destination, so this is the only moment that means "bytes are on their way here".
      // It is idempotent in every provider (YoutubeProvider guards with its own pushStarted flag),
      // so a respawn does not restart the health-check poll.
      this.session.lifecycle?.onPushStarted();
      // A lifecycle-less destination (custom RTMP) has nothing to poll, so "the relay survived
      // SHORT_LIVED_UPTIME_MS" is the only "it connected" signal there is — the same heuristic the
      // encoder's reconnect policy uses to tell a startup failure from a later transport break.
      if (!this.session.lifecycle) this.schedulePromotion();
      return;
    }

    // 7. Running. Keep the reported state in step with the provider's own phase.
    this.syncProviderPhase();
  }

  // Returns true if a terminal phase was found and handled (giveUp() already called) — the caller
  // must return immediately rather than fall through to whatever branch it was about to try.
  private checkTerminalProviderPhase(): boolean {
    const lifecycle = this.session?.lifecycle;
    if (!lifecycle) return false;
    const phase = lifecycle.phase();
    if (phase !== 'error' && phase !== 'complete') return false;
    this.giveUp(
      lifecycle.isAuthError?.() ? 'auth' : 'provider',
      new Error(`the destination ended this broadcast (phase: ${phase})`),
    );
    return true;
  }

  private syncProviderPhase(): void {
    // The terminal case is handled earlier in pass() (branch 3, checkTerminalProviderPhase()) —
    // this call is defense in depth for the one phase transition that can arrive while THIS branch
    // is what's running (a relay already up), not a second copy of the same check.
    if (this.checkTerminalProviderPhase()) return;
    const lifecycle = this.session?.lifecycle;
    if (!lifecycle) return;
    const phase = lifecycle.phase();
    if (phase === 'live' && this.actual !== 'live') {
      this.resetRetryBudget();
      this.setState('live');
    }
  }

  private onProviderPhaseChanged(session: PreparedSession): void {
    // A stale callback from a PREVIOUS toggle cycle's lifecycle must never move this forward's
    // state — the same stale-async-result hazard StreamManager's own phase-change hook had.
    if (this.session !== session) return;
    this.deps.onStatusChanged();
    this.again();
  }

  private startRelay(inputUrl: string): void {
    const session = this.session!;
    // The same `${rtmpUrl}/${streamKey}` join buildPersistentEncoderArgs uses for its own output
    // URL: providers return the two halves separately and every consumer concatenates them the
    // same way.
    const outputUrl = `${session.rtmpUrl}/${session.streamKey}`;
    this.relay = this.deps.createRelay({ inputUrl, outputUrl });
    this.relayStartedAt = this.now();
    this.relay.start((code) => this.handleRelayExit(code));
  }

  private stopRelay(): void {
    this.relay?.stop();
    this.relay = null;
    this.relayStartedAt = null;
  }

  private handleRelayExit(exitCode: number | null): void {
    const uptimeMs = this.relayStartedAt !== null ? this.now() - this.relayStartedAt : 0;
    this.relay = null;
    this.relayStartedAt = null;
    this.clearPromotionTimer();

    // Not this destination's fault: the publisher went away (encoder crash, user stop, local
    // reconnect) and MediaMTX drops every reader within ~1s of that. Hold — the next pass parks
    // this forward without finalizing and without spending a retry.
    if (this.desired === 'off' || !this.deps.isSourcePublishing()) {
      this.again();
      return;
    }

    const decision = this.evaluateRetry(uptimeMs);
    if (decision.retry) {
      this.setState('connecting');
      this.retryTimer = this.setTimer(() => {
        this.retryTimer = null;
        this.again();
      }, decision.delayMs);
      return;
    }
    this.giveUp('relay', new Error(`the relay to this destination exited (code=${exitCode ?? 'null'}) and could not be re-established`));
  }

  private evaluateRetry(uptimeMs: number): ReconnectDecision {
    if (uptimeMs < SHORT_LIVED_UPTIME_MS) {
      this.consecutiveShortLivedFailures += 1;
    } else {
      this.consecutiveShortLivedFailures = 0;
    }
    if (this.firstFailureAt === null) this.firstFailureAt = this.now();
    this.attempt += 1;
    return this.deps.reconnectPolicy.decide({
      attempt: this.attempt,
      uptimeMs,
      totalElapsedMs: this.now() - this.firstFailureAt,
      consecutiveShortLivedFailures: this.consecutiveShortLivedFailures,
    });
  }

  private resetRetryBudget(): void {
    this.attempt = 0;
    this.firstFailureAt = null;
    this.consecutiveShortLivedFailures = 0;
  }

  private schedulePromotion(): void {
    this.clearPromotionTimer();
    this.promotionTimer = this.setTimer(() => {
      this.promotionTimer = null;
      if (this.relay && this.actual === 'connecting') {
        this.resetRetryBudget();
        this.setState('live');
      }
    }, SHORT_LIVED_UPTIME_MS);
  }

  private giveUp(reason: ForwardErrorReason, err: unknown): void {
    console.error(`[stream] destination ${this.destinationId}: forward gave up (${reason})`, err);
    this.setError({ reason, message: err instanceof Error ? err.message : String(err) });
    this.givenUp = true;
    this.again();
  }

  private async finalizeSession(): Promise<void> {
    const session = this.session;
    // Null it out BEFORE awaiting so nothing can double-finalize the same lifecycle.
    this.session = null;
    if (!session?.lifecycle) return;
    try {
      await session.lifecycle.finalize();
    } catch (err) {
      console.error(`[stream] destination ${this.destinationId}: failed to finalize the destination lifecycle`, err);
    }
  }

  private setState(state: ForwardActualState): void {
    if (this.actual === state) return;
    this.actual = state;
    this.deps.onStatusChanged();
  }

  private setError(error: ForwardError | null): void {
    if (this.error === null && error === null) return;
    this.error = error;
    this.deps.onStatusChanged();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      this.clearTimer(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private clearPromotionTimer(): void {
    if (this.promotionTimer) {
      this.clearTimer(this.promotionTimer);
      this.promotionTimer = null;
    }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest test/stream/destinationForward.test.ts && npm run build`
Expected: PASS, clean build.

- [ ] **Step 6: Commit**

```bash
git add src/stream/destinationForward.ts src/destinations/streamDestinationProvider.ts test/stream/destinationForward.test.ts
git commit -m "$(cat <<'EOF'
feat: add DestinationForward, a desired-state reconciler per destination

One reconcile() re-entered on every relevant event replaces the N special-cased
handlers a toggle-while-preparing / toggle-while-finalizing / source-dropped
model would otherwise need. Forwards hold rather than finalize while the local
stream is reconnecting, always register a prepared session before re-checking
intent, and can never touch the local encode or a sibling forward.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 4: Schema deltas and the one migration

Two unrelated features need three columns; they share one migration because generating a migration
requires the whole remote-Postgres dance in `CLAUDE.md` and doing it twice buys nothing.

1. `StreamDestination.youtubeLiveStreamId` — spec, YouTube section: "persist `liveStream` per
   destination, reuse it across toggles, only the `liveBroadcast` is ephemeral — removes
   `liveStreams.insert`/`delete` (~30% of the cost) and the entire 'ephemeral liveStream orphaned
   because finalize's token call failed' failure class already in `CLAUDE.md`'s known follow-ups."
2. `StreamSession.name` and `StreamSession.latencyPreference` — the repurposing of `StreamSession`
   into a saved preset (Task 9). **The Prisma model names stay `StreamSession`/
   `StreamSessionDestination`** so no table is renamed; only the TypeScript layer becomes
   `StreamPreset*`.

**Files:**
- Modify: `prisma/schema.prisma:64-75` (`StreamDestination`), `prisma/schema.prisma:97-119`
  (`StreamSession` + its doc comment)
- Create (generated, never hand-written): `prisma/migrations/<timestamp>_local_first_forwards/`
- Modify: `src/destinations/destinationRepository.ts`
- Test: `test/stream/destinationForward.test.ts` (drop the `as StreamDestination` cast now that the
  field is real)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `StreamDestination.youtubeLiveStreamId: string | null` on the generated Prisma client.
  - `StreamSession.name: string`, `StreamSession.latencyPreference: string | null`.
  - `DestinationRepository.setYoutubeLiveStreamId(id: string, youtubeLiveStreamId: string | null): Promise<void>`

- [ ] **Step 1: Edit the schema**

In `prisma/schema.prisma`, add one field to `StreamDestination` (after `provider`):

```prisma
model StreamDestination {
  id                 String            @id @default(uuid())
  userId             String
  user               User              @relation(fields: [userId], references: [id], onDelete: Cascade)
  name               String
  rtmpUrl            String?
  streamKeyEncrypted String?
  provider           String            @default("custom")
  // YouTube only. The liveStream (ingest endpoint) is REUSED across every toggle-on of this
  // destination; only the liveBroadcast is ephemeral. That removes liveStreams.insert/delete from
  // every toggle cycle (~30% of its ~330 Data API units against a shared 10,000/day quota) and
  // removes the "ephemeral liveStream orphaned because finalize's token call failed" failure class
  // entirely. Null until the first successful toggle-on, and re-created automatically if YouTube
  // no longer has it.
  youtubeLiveStreamId String?
  createdAt          DateTime          @default(now())
  oauthConnection    OAuthConnection?
  streamSessionLinks StreamSessionDestination[]
}
```

And replace the `StreamSession` model + its doc comment (currently lines 97-119) with:

```prisma
// A saved PRESET: a name plus the playlist, overlay template, destination checklist and broadcast
// metadata to pre-populate the next local-stream start with. It used to represent "the running
// thing" (a fan-out to N destinations); since the local-first rework the running thing is the one
// in-memory local stream per account, and this row is purely a saved choice.
//
// The model and table names are still StreamSession/StreamSessionDestination so that repurposing
// them costs no table rename and no data migration; the TypeScript layer that reads them is named
// StreamPreset* (see src/stream/streamPresetRepository.ts).
model StreamSession {
  id            String                     @id @default(uuid())
  userId        String
  user          User                       @relation(fields: [userId], references: [id], onDelete: Cascade)
  // What the user picks this preset by. Separate from `title`, which is the YouTube BROADCAST
  // title — overloading one field for both would make the preset picker show broadcast titles.
  name          String                     @default("Untitled preset")
  playlistId    String
  playlist      Playlist                   @relation(fields: [playlistId], references: [id], onDelete: Cascade)
  // Optional — a preset can carry no template (the built-in default layout is used instead).
  // SetNull rather than Cascade: deleting a template should not delete presets that referenced it.
  templateId    String?
  template      StreamTemplate?            @relation(fields: [templateId], references: [id], onDelete: SetNull)
  title         String?
  description   String?
  privacyStatus String?
  latencyPreference String?
  createdAt     DateTime                   @default(now())
  destinations  StreamSessionDestination[]
}
```

- [ ] **Step 2: Generate the migration on the remote Postgres host**

No local Docker daemon is available in this dev environment, so migrations are generated against a
temporary Postgres on `192.168.14.26` (passwordless SSH). **Touch nothing else running on that
host**, and tear every temporary resource down at the end.

```bash
ssh 192.168.14.26 'rm -rf /tmp/superdj-migrate && mkdir -p /tmp/superdj-migrate/prisma'
scp prisma/schema.prisma 192.168.14.26:/tmp/superdj-migrate/prisma/schema.prisma
scp package.json package-lock.json 192.168.14.26:/tmp/superdj-migrate/
# The EXISTING migration history must go too: staging schema.prisma alone makes Prisma treat the
# throwaway database as historyless and regenerate EVERY table instead of an incremental diff.
scp -r prisma/migrations 192.168.14.26:/tmp/superdj-migrate/prisma/migrations
ssh 192.168.14.26 '
  docker network create superdj-migrate-net &&
  docker run -d --rm --name superdj-migrate-db --network superdj-migrate-net \
    -e POSTGRES_USER=superdj -e POSTGRES_PASSWORD=superdj -e POSTGRES_DB=superdj postgres:16-alpine &&
  sleep 5 &&
  docker run --rm --network superdj-migrate-net -v /tmp/superdj-migrate:/app -w /app \
    -e DATABASE_URL=postgresql://superdj:superdj@superdj-migrate-db:5432/superdj \
    node:20-bookworm-slim bash -lc "apt-get update -qq && apt-get install -y -qq openssl >/dev/null && npm ci --ignore-scripts && npx prisma migrate dev --name local_first_forwards --skip-generate"'
```

`apt-get install -y openssl` first, or Prisma's engine cannot detect libssl in that image and errors
out. Then copy the generated directory back and tear everything down:

```bash
ssh 192.168.14.26 'ls /tmp/superdj-migrate/prisma/migrations'   # note the new <timestamp>_local_first_forwards
scp -r 192.168.14.26:/tmp/superdj-migrate/prisma/migrations/<timestamp>_local_first_forwards prisma/migrations/
ssh 192.168.14.26 '
  docker rm -f superdj-migrate-db 2>/dev/null;
  docker network rm superdj-migrate-net 2>/dev/null;
  rm -rf /tmp/superdj-migrate; echo cleaned'
ssh 192.168.14.26 'docker ps --format "{{.Names}}" | grep superdj-migrate; echo done'
```

The generated `migration.sql` should be exactly three `ALTER TABLE ... ADD COLUMN` statements (two
nullable, one `NOT NULL DEFAULT 'Untitled preset'`). **If it contains any `DROP`, `CREATE TABLE` or
`RENAME`, stop**: the migration history was not staged correctly — redo Step 2 with
`prisma/migrations` included.

- [ ] **Step 3: Regenerate the local Prisma client**

```bash
npx prisma generate
```

- [ ] **Step 4: Write the failing repository test**

There is no `test/destinations/destinationRepository.test.ts` and there must not be: Prisma-backed
repositories in this repo are thin wrappers verified by manual smoke test with a real Postgres, not
by unit tests (see `CLAUDE.md`'s testing strategy). The failing check for this step is the type
checker plus the forward test that now uses the real field. Edit
`test/stream/destinationForward.test.ts`'s `destination()` helper to drop the cast:

```typescript
function destination(overrides: Partial<StreamDestination> = {}): StreamDestination {
  return {
    id: 'dest-1', userId: 'user-1', name: 'My channel', rtmpUrl: 'rtmp://dest.example/app',
    streamKeyEncrypted: null, provider: 'custom', youtubeLiveStreamId: null, createdAt: new Date(),
    ...overrides,
  };
}
```

- [ ] **Step 5: Run the build to verify it passes**

Run: `npm run build && npx jest test/stream/destinationForward.test.ts`
Expected: clean build (the field exists on the generated client), tests PASS.

- [ ] **Step 6: Add the repository method**

In `src/destinations/destinationRepository.ts`, add after `findById`:

```typescript
  // Records (or clears) the reusable YouTube liveStream this destination pushes into. Cleared back
  // to null when YouTube no longer has that stream, so the next toggle-on creates a fresh one.
  async setYoutubeLiveStreamId(id: string, youtubeLiveStreamId: string | null): Promise<void> {
    await this.prisma.streamDestination.update({ where: { id }, data: { youtubeLiveStreamId } });
  }
```

- [ ] **Step 7: Run the full suite**

Run: `npx jest && npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/destinations/destinationRepository.ts test/stream/destinationForward.test.ts
git commit -m "$(cat <<'EOF'
feat: persist a reusable YouTube liveStream and the preset fields

StreamDestination.youtubeLiveStreamId lets a destination reuse one ingest
endpoint across every toggle-on, so only the liveBroadcast is ephemeral: ~30%
off each toggle cycle's Data API quota, and no more orphaned ephemeral streams.
StreamSession gains name + latencyPreference for its repurposing as a saved
preset; model and table names stay put so nothing is renamed in the database.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: YouTube — reuse the `liveStream`, keep one stable watch URL

**Files:**
- Modify: `src/destinations/youtubeApiClient.ts:24-35` (interface) and its `createYoutubeApiClient`
  implementation (add `getStream`)
- Modify: `src/destinations/youtubeProvider.ts` (whole file)
- Test: `test/destinations/youtubeApiClient.test.ts`, `test/destinations/youtubeProvider.test.ts`

**Interfaces:**
- Consumes: `DestinationRepository.setYoutubeLiveStreamId` (Task 4);
  `StreamDestination.youtubeLiveStreamId` (Task 4); `StreamDestinationProvider.isAuthError?`
  (Task 3).
- Produces:
  - `YoutubeApiClient.getStream(accessToken: string, streamId: string): Promise<YoutubeStream | null>`
  - `YoutubeProviderDeps` gains `destinationRepository: Pick<DestinationRepository, 'setYoutubeLiveStreamId'>`
  - `YoutubeProvider.isAuthError(err: unknown): boolean` (delegates to `isAuthClassError`)
  - `DestinationLifecycle.watchUrl()` for YouTube now returns
    `https://www.youtube.com/channel/{externalAccountId}/live` when a channel id is known AND the
    broadcast is `public`; falls back to `https://www.youtube.com/watch?v={broadcastId}` otherwise.

- [ ] **Step 1: Write the failing client test**

Add these two cases **inside** the existing `describe('createYoutubeApiClient')` block in
`test/destinations/youtubeApiClient.test.ts`, so they inherit its `beforeEach` (`global.fetch =
jest.fn()`), and use that file's existing `mockFetchOnce(status, body)` helper rather than inventing
a second one:

```typescript
  it('getStream returns the persisted stream\'s ingest details when YouTube still has it', async () => {
    mockFetchOnce(200, { items: [{ id: 'S1', cdn: { ingestionInfo: { ingestionAddress: 'rtmp://a/live2', streamName: 'key-1' } } }] });
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    await expect(client.getStream('at', 'S1')).resolves.toEqual({
      id: 'S1', ingestionAddress: 'rtmp://a/live2', streamName: 'key-1',
    });
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('/liveStreams?part=cdn&id=S1');
  });

  // A liveStream the user deleted in YouTube Studio comes back as an EMPTY items array with a 200,
  // not a 404 — so "no items" has to mean "gone", or the provider would happily bind a broadcast to
  // a stream that does not exist.
  it('getStream returns null when YouTube no longer has that stream', async () => {
    mockFetchOnce(200, { items: [] });
    const client = createYoutubeApiClient({ clientId: 'id', clientSecret: 'secret' });

    await expect(client.getStream('at', 'S1')).resolves.toBeNull();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/destinations/youtubeApiClient.test.ts`
Expected: FAIL — `client.getStream is not a function`.

- [ ] **Step 3: Implement `getStream`**

In `src/destinations/youtubeApiClient.ts`, add to the `YoutubeApiClient` interface (after
`createStream`):

```typescript
  // Null when YouTube no longer has this stream (deleted in Studio, or by another app) — which it
  // reports as an empty items array with a 200, not a 404.
  getStream(accessToken: string, streamId: string): Promise<YoutubeStream | null>;
```

and to `createYoutubeApiClient`'s returned object (after `createStream`):

```typescript
    async getStream(accessToken, streamId) {
      const res = await fetch(`${YOUTUBE_API}/liveStreams?part=cdn&id=${streamId}`, { headers: authHeader(accessToken) });
      const body = await readJsonOrThrow(res, 'getStream');
      const item = body.items?.[0];
      if (!item) return null;
      return { id: item.id, ingestionAddress: item.cdn.ingestionInfo.ingestionAddress, streamName: item.cdn.ingestionInfo.streamName };
    },
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx jest test/destinations/youtubeApiClient.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing provider tests**

First extend that file's existing helpers (they are at the top of the file, lines 7-37):

```typescript
function fakeClient(overrides: Record<string, jest.Mock> = {}) {
  return {
    refreshAccessToken: jest.fn().mockResolvedValue('at'),
    createBroadcast: jest.fn().mockResolvedValue({ id: 'broadcast-1' }),
    createStream: jest.fn().mockResolvedValue({ id: 'stream-1', ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2', streamName: 'key-1' }),
    // Default: the persisted id (when there is one) is still valid on YouTube's side.
    getStream: jest.fn().mockResolvedValue({ id: 'stream-1', ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2', streamName: 'key-1' }),
    bind: jest.fn().mockResolvedValue(undefined),
    transition: jest.fn().mockResolvedValue(undefined),
    getStreamStatus: jest.fn().mockResolvedValue('active'),
    deleteStream: jest.fn().mockResolvedValue(undefined),
    exchangeCode: jest.fn(), revoke: jest.fn(), getChannel: jest.fn(),
    ...overrides,
  };
}

function buildProvider(client = fakeClient(), extra: Record<string, unknown> = {}, externalAccountId = 'UC123') {
  const oauthConnectionRepository = {
    findByDestinationId: jest.fn().mockResolvedValue({
      refreshTokenEncrypted: encrypt('refresh-token', KEY),
      externalAccountId,
    }),
  };
  // The liveStream is reused across toggles, so the provider now writes its id back to the row.
  const destinationRepository = { setYoutubeLiveStreamId: jest.fn().mockResolvedValue(undefined) };
  // Drives the poll loop deterministically instead of waiting on real timers.
  const scheduled: Array<() => void | Promise<void>> = [];
  const scheduleNextPoll = jest.fn((fn: () => void | Promise<void>) => { scheduled.push(fn); });
  const provider = new YoutubeProvider({
    client: client as any, encryptionKey: KEY, oauthConnectionRepository, destinationRepository, scheduleNextPoll, ...extra,
  });
  const runNextScheduledPoll = async () => {
    const fn = scheduled.shift();
    if (fn) await fn();
  };
  return { provider, client, oauthConnectionRepository, destinationRepository, runNextScheduledPoll, scheduled };
}

// The existing module-level fixture gains the new column. Every existing test keeps using `destination`.
const destination = { id: 'dest-1', youtubeLiveStreamId: null } as any;
```

Then append this describe block:

```typescript
describe('YoutubeProvider — reusable liveStream and a stable watch URL', () => {
  it('creates a liveStream on the first toggle and persists its id', async () => {
    const { provider, client, destinationRepository } = buildProvider();

    await provider.prepareSession(destination, meta);

    expect(client.getStream).not.toHaveBeenCalled();
    expect(client.createStream).toHaveBeenCalledTimes(1);
    expect(destinationRepository.setYoutubeLiveStreamId).toHaveBeenCalledWith('dest-1', 'stream-1');
  });

  it('reuses the persisted liveStream on every later toggle instead of creating a new one', async () => {
    const { provider, client, destinationRepository } = buildProvider();

    const session = await provider.prepareSession({ id: 'dest-1', youtubeLiveStreamId: 'stream-1' } as any, meta);

    expect(client.getStream).toHaveBeenCalledWith('at', 'stream-1');
    expect(client.createStream).not.toHaveBeenCalled();
    expect(destinationRepository.setYoutubeLiveStreamId).not.toHaveBeenCalled();
    expect(session.rtmpUrl).toBe('rtmp://a.rtmp.youtube.com/live2');
    expect(session.streamKey).toBe('key-1');
    // Only the BROADCAST is ephemeral.
    expect(client.createBroadcast).toHaveBeenCalledTimes(1);
    expect(client.bind).toHaveBeenCalledWith('at', 'broadcast-1', 'stream-1');
  });

  // A stream the user deleted in YouTube Studio comes back as an empty result, not an error.
  it('creates and re-persists a liveStream when the persisted one is gone from YouTube', async () => {
    const client = fakeClient({ getStream: jest.fn().mockResolvedValue(null) });
    const { provider, destinationRepository } = buildProvider(client);

    await provider.prepareSession({ id: 'dest-1', youtubeLiveStreamId: 'deleted-1' } as any, meta);

    expect(client.createStream).toHaveBeenCalledTimes(1);
    expect(destinationRepository.setYoutubeLiveStreamId).toHaveBeenCalledWith('dest-1', 'stream-1');
  });

  // Deleting the reusable stream on every toggle-off is exactly what this change exists to stop.
  it('finalize completes the broadcast and never deletes the liveStream', async () => {
    const { provider, client } = buildProvider();
    const session = await provider.prepareSession(destination, meta);

    session.lifecycle!.onPushStarted();
    await session.lifecycle!.finalize();

    expect(client.transition).toHaveBeenCalledWith('at', 'broadcast-1', 'complete');
    expect(client.deleteStream).not.toHaveBeenCalled();
  });

  // Spec: "the single best fix for 'my viewers' link keeps dying'" — one link that survives every
  // toggle, instead of a fresh per-broadcast URL each time. Only true for a PUBLIC broadcast: the
  // channel /live page never resolves an unlisted or private one, so this needs its own `meta`
  // (the module-level fixture defaults to 'private' — see the next two tests for that case).
  it('reports the channel\'s stable live URL for a public broadcast', async () => {
    const { provider } = buildProvider();
    const session = await provider.prepareSession(destination, { ...meta, privacyStatus: 'public' });

    expect(session.lifecycle!.watchUrl()).toBe('https://www.youtube.com/channel/UC123/live');
  });

  it('falls back to the per-broadcast URL when the connection has no channel id', async () => {
    const { provider } = buildProvider(fakeClient(), {}, '');
    const session = await provider.prepareSession(destination, { ...meta, privacyStatus: 'public' });

    expect(session.lifecycle!.watchUrl()).toBe('https://www.youtube.com/watch?v=broadcast-1');
  });

  // The module-level `meta` fixture defaults to privacyStatus: 'private' — exercise that default
  // explicitly here so this case is asserted by name, not just incidentally by every other test in
  // this file that doesn't override it. The pre-existing `'exposes a watchUrl built from the
  // broadcast id'` test above already covers this input; this test names WHY that's the right
  // answer (a channel id IS known here, and the fallback still wins on privacy grounds).
  it('falls back to the per-broadcast URL for a private broadcast even when a channel id is known', async () => {
    const { provider } = buildProvider();
    const session = await provider.prepareSession(destination, meta);

    expect(session.lifecycle!.watchUrl()).toBe('https://www.youtube.com/watch?v=broadcast-1');
  });

  it('classifies an auth-class rejection for DestinationForward', () => {
    const { provider } = buildProvider();
    expect(provider.isAuthError(new YoutubeApiError(401, null, 'createBroadcast', {}))).toBe(true);
    expect(provider.isAuthError(new Error('network'))).toBe(false);
  });
});
```

Existing tests in this file that assert `deleteStream` was called on finalize must be **updated, not
deleted**, to assert the opposite, with a comment naming the quota reason. The existing `it('exposes
a watchUrl built from the broadcast id')` test (today's lines 77-81) needs NO change: it uses the
default `meta` fixture (`privacyStatus: 'private'`), and the new privacy-gated `watchUrl()` above
falls back to the same `watch?v=broadcast-1` URL for a private broadcast regardless of whether a
channel id is known — this is not a coincidence to leave undocumented, it's the same case the new
`'falls back to the per-broadcast URL for a private broadcast...'` test names explicitly.

- [ ] **Step 6: Run them to verify they fail**

Run: `npx jest test/destinations/youtubeProvider.test.ts`
Expected: FAIL — the provider still calls `createStream` unconditionally, still deletes the stream
in `finalize()`, and has no `isAuthError`.

- [ ] **Step 7: Implement the provider changes**

In `src/destinations/youtubeProvider.ts`:

(a) extend the deps and add the classifier — replace lines 8-29 with:

```typescript
export interface YoutubeProviderDeps {
  client: YoutubeApiClient;
  encryptionKey: string;
  oauthConnectionRepository: Pick<OAuthConnectionRepository, 'findByDestinationId'>;
  // Needed because the liveStream (the ingest endpoint) is now REUSED across toggles and therefore
  // has to be remembered on the destination row. Only the liveBroadcast stays ephemeral.
  destinationRepository: Pick<DestinationRepository, 'setYoutubeLiveStreamId'>;
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

  // Lets DestinationForward show "reconnect your YouTube account" instead of a generic failure,
  // and stops it retrying a grant that will never come back, without knowing anything about the
  // YouTube API itself.
  isAuthError(err: unknown): boolean {
    return isAuthClassError(err);
  }
```

Add `import { DestinationRepository } from './destinationRepository';` at the top.

(b) replace the `createStream` call inside `prepareSession` (currently line 41) with a
reuse-or-create block, and move it **before** `createBroadcast` so a stream failure never leaves a
broadcast behind:

```typescript
    const accessToken = await this.deps.client.refreshAccessToken(refreshToken);

    // The liveStream is reused across every toggle of this destination; only the broadcast below is
    // ephemeral. A persisted id can still be stale (the user deleted the stream in YouTube Studio),
    // which YouTube reports as an empty result rather than an error — so verify, then fall back to
    // creating a fresh one and re-persisting it.
    let stream: YoutubeStream | null = null;
    if (destination.youtubeLiveStreamId) {
      stream = await this.deps.client.getStream(accessToken, destination.youtubeLiveStreamId);
    }
    if (!stream) {
      stream = await this.deps.client.createStream(accessToken, { title: meta.title });
      await this.deps.destinationRepository.setYoutubeLiveStreamId(destination.id, stream.id);
    }

    const broadcast = await this.deps.client.createBroadcast(accessToken, {
      title: meta.title, description: meta.description ?? '', privacyStatus: meta.privacyStatus ?? 'private',
      latencyPreference: meta.latencyPreference ?? 'normal',
    });
    await this.deps.client.bind(accessToken, broadcast.id, stream.id);
```

Add `YoutubeStream` to the `./youtubeApiClient` import.

(c) replace `watchUrl` (currently line 110) with:

```typescript
      // One link that survives every toggle. A per-broadcast watch?v= URL dies the moment the user
      // toggles this destination off, and nobody following the old link migrates automatically —
      // the channel's own /live page always points at whatever that channel is broadcasting now.
      // BUT the channel /live page only ever resolves to a PUBLIC broadcast — YouTube does not
      // surface an unlisted or private one there at all, so for anything but 'public' the stable
      // link would 404 for the owner's own viewers, replacing a watch?v= URL that worked. Fall
      // back to the per-broadcast URL for exactly that case; this is also why the fallback for "no
      // channel id known" reuses the same expression rather than needing a second one.
      watchUrl: () => (connection.externalAccountId && meta.privacyStatus === 'public'
        ? `https://www.youtube.com/channel/${connection.externalAccountId}/live`
        : `https://www.youtube.com/watch?v=${broadcast.id}`),
```

(d) replace the `deleteStream` block inside `finalize` (currently lines 125-130) with nothing —
delete those six lines entirely, leaving:

```typescript
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
        // The liveStream is deliberately NOT deleted: it is this destination's reusable ingest
        // endpoint, persisted on the row and reused by the next toggle-on. Deleting it here is what
        // used to cost an extra insert+delete per toggle and what used to leave an orphaned stream
        // behind whenever finalize's own token refresh failed.
        phase = 'complete';
        phaseChangeListener?.();
      },
```

`YoutubeApiClient.deleteStream` stays on the interface and in the client — nothing calls it now, but
removing it would mean re-adding it the first time a "disconnect this channel" cleanup is written.
Leave it and say so in the interface comment: `// Unused by the streaming path since the liveStream
became reusable; kept for future account-teardown cleanup.`

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx jest test/destinations && npm run build`
Expected: PASS. The pre-existing provider tests that asserted `deleteStream` was called on finalize
must be updated (not deleted) to assert the opposite, with a comment naming the quota reason.

- [ ] **Step 9: Commit**

```bash
git add src/destinations/youtubeApiClient.ts src/destinations/youtubeProvider.ts test/destinations
git commit -m "$(cat <<'EOF'
feat: reuse a YouTube destination's liveStream across toggles

Only the liveBroadcast is ephemeral now. The reusable ingest endpoint is
persisted on the destination and re-verified each time, so a toggle cycle drops
liveStreams.insert/delete (~30% of its quota cost) and can no longer orphan a
stream when finalize's token refresh fails. watchUrl() now returns the channel's
stable /live link for a public broadcast (falling back to a per-broadcast URL
otherwise, since the channel page never resolves an unlisted/private one).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 6: `LocalStreamManager` absorbs the forwards

Spec: "`LocalStreamManager` (replaces `StreamManager` + `StreamSessionManager`) — keyed by `userId`,
owns one `LocalStream` plus its map of `DestinationForward`s. Exposes start/stop/pause/resume/
next/previous (act on the shared encode) and `setDestinationDesired(destinationId, on|off)`."

Phase A already keyed by `userId` and already kept its per-user value a struct rather than a bare
`StreamController` "so a `forwards: Map<destinationId, DestinationForward>` field can be added
without a rewrite" — this task cashes that in.

**Files:**
- Modify: `src/stream/localStreamManager.ts` (whole file)
- Modify: `src/server.ts:177-184` (new deps)
- Modify: `src/stream/localStreamRoutes.ts` — `stop()` becomes `async` in this same task, and this
  file's existing `localStreamManager.stop(id);` call site (currently line ~58) is unawaited. Add
  the `await` HERE, not in Task 7 (which touches this file too, but later): left unawaited, a
  `POST /local-stream/stop` on an already-inactive stream throws `ApiError(409)` inside a floating
  promise that escapes `wrapAsync` entirely — the client gets a stale 200 AND Node's default
  `--unhandled-rejections=throw` takes the whole process down (every tenant's stream, not just the
  caller's). One keyword, one line; Task 7's own edit to this file later is unaffected.
- Test: `test/stream/localStreamManager.test.ts` (substantial additions + status-shape updates)

**Interfaces:**
- Consumes: `DestinationForward`, `DestinationForwardStatus`, `ForwardDesiredState` (Task 3);
  `RelayProcess` (Task 2); `createForwardReconnectPolicy` (Task 1);
  `StreamDestinationProvider`/`BroadcastMeta` (`src/destinations/streamDestinationProvider.ts`);
  `DestinationRepository.findById`; the unchanged `buildStreamScene`, `LocalRelayTarget.create`,
  `MediaMtxAuthRegistry.register/unregister`, `StreamController`.
- Produces:
  - `type LocalSessionState = SessionState | 'starting'`
  - `interface LocalStreamState { state: LocalSessionState; currentTrack: string | null; nextTrack: string | null; previewReady: boolean; playlistId: string | null; templateId: string | null; startedAt: string | null }`
  - `interface LocalStreamStatus { local: LocalStreamState; destinations: DestinationForwardStatus[] }`
  - `interface StartLocalStreamOptions { templateId?: string; destinationIds?: string[]; meta?: Partial<BroadcastMeta> }`
  - `LocalStreamManagerDeps` gains `destinationRepository: Pick<DestinationRepository, 'findById'>`,
    `providers: Record<string, StreamDestinationProvider>`, and the optional test seam
    `createRelay?: (p: { inputUrl: string; outputUrl: string }) => RelayProcess`.
  - `LocalStreamManager.start(userId, playlistId, options?: StartLocalStreamOptions): Promise<void>`
  - `LocalStreamManager.stop(userId): Promise<void>` (**was synchronous**)
  - `LocalStreamManager.setDestinationDesired(userId, destinationId, desired: ForwardDesiredState): Promise<LocalStreamStatus>`
  - `LocalStreamManager.removeDestination(userId, destinationId): Promise<void>`
  - unchanged: `pause`, `resume`, `next`, `previous`, `playByName`, `status`, `previewTarget`, the
    `'statusChanged'` event carrying a `userId`.

- [ ] **Step 1: Write the failing tests**

Rewrite `test/stream/localStreamManager.test.ts`'s harness and add the forward coverage. Keep every
existing test, changing the status assertions to the nested shape, **plus two `stop()`-specific
edits this task's own signature change forces**: `stop()` becomes `async` (it now has to `await`
every forward's `shutdown()`), so:
- The existing `expect(() => manager.stop('user-1')).toThrow('local stream is not active'))` (today
  at line 213) must become `await expect(manager.stop('user-1')).rejects.toThrow('local stream is
  not active')` — a synchronous `toThrow` around a now-`async` function catches nothing (the thrown
  value is a rejected promise, not a synchronous exception), so left as written this assertion
  passes for the wrong reason and hides both the intended check AND an unhandled rejection.
- Every other unawaited `manager.stop(...)` call in the existing file (today at lines 123, 198, 205,
  266) must gain an `await`. They happen to still pass without one (each stop's synchronous prologue
  — `discard()` — runs before the first `await` inside it), but an unawaited call leaves a floating
  promise that can resolve after its test has already finished, and a later `stop()`-shape change
  that moves work earlier would make that failure surface in a DIFFERENT, unrelated test.

The harness gains three things — a destination repository, a provider map and a relay factory:

```typescript
import { StreamDestination } from '@prisma/client';
import { LocalStreamManager } from '../../src/stream/localStreamManager';
import { LocalRelaySession } from '../../src/stream/localRelayTarget';
import { ApiError } from '../../src/errors';

const TOKEN = 'c'.repeat(32);

// relaySession() and fakeScene() already exist at the top of this file and need no change — leave
// them exactly as they are.
function relaySession(userId: string, token = TOKEN): LocalRelaySession { /* ...as in the file today... */ }
function fakeScene() { /* ...as in the file today... */ }

function destinationRow(overrides: Partial<StreamDestination> = {}): StreamDestination {
  return {
    id: 'dest-1', userId: 'user-1', name: 'Twitch', rtmpUrl: 'rtmp://live.twitch.tv/app',
    streamKeyEncrypted: null, provider: 'custom', youtubeLiveStreamId: null, createdAt: new Date(),
    ...overrides,
  };
}

function buildManager(overrides: Partial<Record<string, unknown>> = {}) {
  const parts = fakeScene();
  const buildScene = jest.fn().mockResolvedValue(parts.scene);
  const relayTarget = { create: jest.fn((userId: string) => relaySession(userId)) };
  const authRegistry = { register: jest.fn(), unregister: jest.fn() };
  const rows = new Map<string, StreamDestination>([['dest-1', destinationRow()]]);
  const destinationRepository = { findById: jest.fn(async (id: string) => rows.get(id) ?? null) };
  const prepareSession = jest.fn().mockResolvedValue({ rtmpUrl: 'rtmp://live.twitch.tv/app', streamKey: 'key' });
  const relays: { start: jest.Mock; stop: jest.Mock }[] = [];
  const createRelay = jest.fn(() => {
    const relay = { start: jest.fn(), stop: jest.fn() };
    relays.push(relay);
    return relay;
  });
  const manager = new LocalStreamManager({
    sceneDeps: { spawner: jest.fn() } as never,
    relayTarget,
    authRegistry,
    destinationRepository,
    providers: { custom: { prepareSession } },
    maxConcurrentStreams: 10,
    maxSessionDurationMs: 12 * 60 * 60 * 1000,
    buildScene,
    createRelay,
    ...overrides,
  } as never);
  return { manager, buildScene, relayTarget, authRegistry, destinationRepository, prepareSession, createRelay, relays, rows, ...parts };
}

// Everything the loop below awaits is already resolved; one macrotask hop lets every queued
// reconcile pass settle without reaching for fake timers.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
```

New tests to add:

```typescript
describe('LocalStreamManager — destination forwards', () => {
  it('reports the local stream and its (empty) destination list as one payload', async () => {
    const { manager } = buildManager();
    await manager.start('user-1', 'playlist-1', { templateId: 'tpl-1' });
    expect(manager.status('user-1')).toEqual({
      local: {
        state: 'streaming', currentTrack: 'a', nextTrack: 'b', previewReady: true,
        playlistId: 'playlist-1', templateId: 'tpl-1', startedAt: expect.any(String),
      },
      destinations: [],
    });
  });

  // Zero destinations is a fully valid running state, not a degenerate one.
  it('runs happily with nothing forwarded', async () => {
    const { manager, createRelay } = buildManager();
    await manager.start('user-1', 'playlist-1');
    await settle();
    expect(createRelay).not.toHaveBeenCalled();
    expect(manager.status('user-1').local.state).toBe('streaming');
  });

  it('starts a relay for a destination pre-checked at start', async () => {
    const { manager, prepareSession, createRelay } = buildManager();
    await manager.start('user-1', 'playlist-1', { destinationIds: ['dest-1'] });
    await settle();
    expect(prepareSession).toHaveBeenCalled();
    expect(createRelay).toHaveBeenCalledWith({
      inputUrl: `rtmp://mediamtx:1935/live/${TOKEN}?user=sub&pass=read-secret`,
      outputUrl: 'rtmp://live.twitch.tv/app/key',
    });
    expect(manager.status('user-1').destinations[0]).toEqual(expect.objectContaining({
      destinationId: 'dest-1', desired: 'on', state: 'connecting',
    }));
  });

  it('rejects an unknown or someone else\'s pre-checked destination before any side effect', async () => {
    const { manager, authRegistry, relayTarget } = buildManager();
    await expect(manager.start('user-1', 'playlist-1', { destinationIds: ['nope'] })).rejects.toThrow('destination not found');
    await expect(manager.start('user-2', 'playlist-1', { destinationIds: ['dest-1'] })).rejects.toThrow('not your destination');
    expect(relayTarget.create).not.toHaveBeenCalled();
    expect(authRegistry.register).not.toHaveBeenCalled();
  });

  it('toggles a destination on and off mid-stream without touching the encode', async () => {
    const { manager, encoder, createRelay, relays } = buildManager();
    await manager.start('user-1', 'playlist-1');
    await manager.setDestinationDesired('user-1', 'dest-1', 'on');
    await settle();
    expect(createRelay).toHaveBeenCalledTimes(1);

    await manager.setDestinationDesired('user-1', 'dest-1', 'off');
    await settle();
    expect(relays[0].stop).toHaveBeenCalled();
    expect(encoder.stop).not.toHaveBeenCalled();
    expect(manager.status('user-1').local.state).toBe('streaming');
  });

  // The hazard the spec names by name: "without this state, a re-toggle-on mid-finalize would race
  // a second broadcast against the first." A forward with a real (YouTube-shaped) lifecycle takes
  // real, controllable time to finalize — long enough for a fast off-then-on to arrive while it's
  // still 'stopping'. If isInactive() (or the pruning it feeds) ever regresses to ignore `actual`,
  // this test starts a SECOND prepareSession() while the first's finalize() is still pending.
  it('does not start a second broadcast when re-toggled on before the first finalize completes', async () => {
    const { manager, prepareSession, createRelay } = buildManager();
    let resolveFinalize!: () => void;
    const finalize = jest.fn(() => new Promise<void>((resolve) => { resolveFinalize = resolve; }));
    prepareSession.mockResolvedValue({
      rtmpUrl: 'rtmp://a.example/live', streamKey: 'key',
      // onPushStarted is REQUIRED on DestinationLifecycle (src/destinations/
      // streamDestinationProvider.ts) — `session.lifecycle?.onPushStarted()` in pass() branch 6
      // guards a null lifecycle, not a missing method, so omitting it throws inside pass(), gets
      // swallowed by run()'s catch, and silently aborts the reconcile loop this test depends on.
      lifecycle: { finalize, phase: () => 'live', watchUrl: () => null, onPushStarted: jest.fn() },
    });
    await manager.start('user-1', 'playlist-1');
    await manager.setDestinationDesired('user-1', 'dest-1', 'on');
    await settle();
    expect(prepareSession).toHaveBeenCalledTimes(1);

    // Toggle off (finalize() starts and hangs on the unresolved promise above), then immediately
    // toggle back on, all before finalize resolves.
    await manager.setDestinationDesired('user-1', 'dest-1', 'off');
    await settle();
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(manager.status('user-1').destinations[0].state).toBe('stopping');

    await manager.setDestinationDesired('user-1', 'dest-1', 'on');
    await settle();
    // Still only ONE prepareSession call — the toggle-on found the SAME still-settling forward
    // (state 'stopping'), not a freshly constructed one, and its own reconcile() will start a new
    // session only once the pending finalize actually resolves.
    expect(prepareSession).toHaveBeenCalledTimes(1);

    resolveFinalize();
    await settle();
    await settle(); // finalize's own .then() plus the reconcile it triggers, two macrotask hops
    expect(prepareSession).toHaveBeenCalledTimes(2);
    expect(createRelay).toHaveBeenCalledTimes(2);
  });

  // A forward object is reused across many prepareSession() calls (respawn, toggle-off-then-on).
  // YoutubeProvider.prepareSession() persists youtubeLiveStreamId to the DATABASE, not back onto
  // whatever row the caller passed in — so the reused forward must be handed a FRESH row on every
  // lookup, or it keeps reading its own stale (pre-persist) copy and reuse never actually happens.
  //
  // This MUST reuse the SAME forward object across the toggle cycle to mean anything — a naive
  // version of this test that lets the off-toggle fully settle (actual: 'off') before toggling
  // back on gets PRUNED by the C1 fix's own onStatusChanged-driven cleanup, so the second toggle-on
  // constructs a brand-new forward from an already-fresh row and passes whether setDestination()
  // exists or not. Borrow the same hanging-finalize trick as the test above to keep this forward's
  // `actual` at 'stopping' (never reaching 'off', so isInactive() stays false and pruning never
  // fires) across the whole toggle-off-then-on sequence.
  it('re-reads the destination row on every toggle, so a later prepareSession sees an earlier one\'s persisted id', async () => {
    const { manager, prepareSession, rows } = buildManager();
    let resolveFinalize!: () => void;
    const finalize = jest.fn(() => new Promise<void>((resolve) => { resolveFinalize = resolve; }));
    prepareSession.mockImplementation(async (destination: StreamDestination) => {
      // Simulate YoutubeProvider persisting the reusable liveStream id to the repository — a real
      // DB write the row object passed in does NOT observe unless the caller re-reads it.
      if (!destination.youtubeLiveStreamId) {
        rows.set(destination.id, { ...destination, youtubeLiveStreamId: 'ls-1' });
      }
      return {
        rtmpUrl: 'rtmp://a.example/live', streamKey: 'key',
        lifecycle: { finalize, phase: () => 'live', watchUrl: () => null, onPushStarted: jest.fn() },
      };
    });

    await manager.start('user-1', 'playlist-1');
    await manager.setDestinationDesired('user-1', 'dest-1', 'on');
    await settle();
    expect(prepareSession.mock.calls[0][0].youtubeLiveStreamId).toBeNull();

    // Toggle off — finalize() starts and hangs, so this forward's actual stays 'stopping', never
    // reaching 'off'. Toggle back on immediately, before finalize resolves.
    await manager.setDestinationDesired('user-1', 'dest-1', 'off');
    await settle();
    expect(manager.status('user-1').destinations[0].state).toBe('stopping');
    await manager.setDestinationDesired('user-1', 'dest-1', 'on');
    await settle();
    expect(prepareSession).toHaveBeenCalledTimes(1); // still the same, still-settling forward

    resolveFinalize();
    await settle();
    await settle(); // finalize's own .then() plus the reconcile it triggers, two macrotask hops
    // The SAME forward object's second prepareSession() must see the id the first call persisted —
    // proving getOrCreateForward() re-applied the freshly-read row rather than reusing the one
    // captured when the forward was first constructed.
    expect(prepareSession).toHaveBeenCalledTimes(2);
    expect(prepareSession.mock.calls[1][0].youtubeLiveStreamId).toBe('ls-1');
  });

  // The same stale-row hazard as the test above, reached from a DIFFERENT path: a forward that
  // SURVIVES a stop/restart (parked at 'pending' by an encoder crash, never pruned since desired
  // is still 'on') without ever going through getOrCreateForward's toggle-route refresh. If the
  // next start() only refreshed the destinations it was explicitly handed, a destination the user
  // checked earlier and never unchecked would keep prepareSession()-ing with a stale row forever.
  it('refreshes a surviving forward\'s row on restart, even when start() is not re-passed that destinationId', async () => {
    const { manager, prepareSession, rows, encoder } = buildManager();
    prepareSession.mockImplementation(async (destination: StreamDestination) => {
      if (!destination.youtubeLiveStreamId) rows.set(destination.id, { ...destination, youtubeLiveStreamId: 'ls-1' });
      return { rtmpUrl: 'rtmp://a.example/live', streamKey: 'key' };
    });

    await manager.start('user-1', 'playlist-1', { destinationIds: ['dest-1'] });
    await settle();
    expect(prepareSession.mock.calls[0][0].youtubeLiveStreamId).toBeNull();

    // The encoder dies for good; the forward parks at 'pending' (still desired: 'on', never
    // pruned) rather than being torn down by a user-initiated stop(). Cross CRASH_LOOP_THRESHOLD
    // by re-invoking the SAME captured onExit callback twice, rather than waiting for a real
    // respawn to capture a second one: this file's settle() is a plain setImmediate hop on REAL
    // timers, and a respawn only happens behind createReconnectPolicy's real 2s±20% backoff —
    // `encoder.start.mock.calls[1]` does not exist after one settle(). Re-entering the exit
    // handler while the first exit's respawn is still merely SCHEDULED is a real shape (the
    // implementation's own teardown() clears that pending timer first, so nothing double-fires),
    // and `evaluateReconnect()` still sees consecutiveShortLivedFailures reach 2.
    (encoder.start.mock.calls[0][0] as (code: number | null) => void)(1);
    await settle();
    (encoder.start.mock.calls[0][0] as (code: number | null) => void)(1);
    await settle();
    expect(manager.status('user-1').local.state).toBe('error');
    expect(manager.status('user-1').destinations[0].desired).toBe('on');

    // Restart with NO destinationIds passed — the surviving forward isn't in this call's
    // `destinations` array at all, only in the manager's own forward map from before.
    await manager.start('user-1', 'playlist-1');
    await settle();
    expect(prepareSession).toHaveBeenCalledTimes(2);
    expect(prepareSession.mock.calls[1][0].youtubeLiveStreamId).toBe('ls-1');
  });

  // Spec open question #3: toggling before anything is running is `pending`, not a 409 — and it has
  // zero external side effects until a stream actually starts.
  it('accepts a toggle while nothing is running and starts that destination with the next start', async () => {
    const { manager, prepareSession, createRelay } = buildManager();
    const status = await manager.setDestinationDesired('user-1', 'dest-1', 'on');
    expect(status.local.state).toBe('idle');
    expect(status.destinations[0]).toEqual(expect.objectContaining({ desired: 'on', state: 'pending' }));
    expect(prepareSession).not.toHaveBeenCalled();

    await manager.start('user-1', 'playlist-1');
    await settle();
    expect(createRelay).toHaveBeenCalledTimes(1);
  });

  it('404s/403s a toggle for an unknown or foreign destination', async () => {
    const { manager } = buildManager();
    await expect(manager.setDestinationDesired('user-1', 'nope', 'on')).rejects.toThrow(ApiError);
    await expect(manager.setDestinationDesired('user-2', 'dest-1', 'on')).rejects.toThrow('not your destination');
  });

  it('reports starting while a start is in flight, so the UI never shows idle mid-start', async () => {
    const { manager, buildScene } = buildManager();
    let release!: (scene: unknown) => void;
    buildScene.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const starting = manager.start('user-1', 'playlist-1');
    expect(manager.status('user-1').local.state).toBe('starting');
    release(fakeScene().scene);
    await starting;
  });

  it('stops every forward and finalizes before reporting the stream stopped', async () => {
    const { manager, relays, encoder } = buildManager();
    await manager.start('user-1', 'playlist-1', { destinationIds: ['dest-1'] });
    await settle();
    await manager.stop('user-1');
    expect(relays[0].stop).toHaveBeenCalled();
    expect(encoder.stop).toHaveBeenCalled();
    expect(manager.status('user-1')).toEqual({
      local: {
        state: 'idle', currentTrack: null, nextTrack: null, previewReady: false,
        playlistId: null, templateId: null, startedAt: null,
      },
      destinations: [],
    });
  });

  // Spec: "DELETE /destinations/{id} while forwarded — must toggle that forward off and finalize
  // its lifecycle WITHOUT touching the local stream."
  it('removeDestination stops only that forward, never the encode', async () => {
    const { manager, relays, encoder } = buildManager();
    await manager.start('user-1', 'playlist-1', { destinationIds: ['dest-1'] });
    await settle();
    await manager.removeDestination('user-1', 'dest-1');
    expect(relays[0].stop).toHaveBeenCalled();
    expect(encoder.stop).not.toHaveBeenCalled();
    expect(manager.status('user-1').local.state).toBe('streaming');
    expect(manager.status('user-1').destinations).toEqual([]);
  });

  it('removeDestination is a no-op for a destination that was never forwarded', async () => {
    const { manager } = buildManager();
    await manager.start('user-1', 'playlist-1');
    await expect(manager.removeDestination('user-1', 'dest-1')).resolves.toBeUndefined();
  });

  it('passes the broadcast metadata from start() to every forward it prepares', async () => {
    const { manager, prepareSession } = buildManager();
    await manager.start('user-1', 'playlist-1', {
      destinationIds: ['dest-1'],
      meta: { title: 'Late night', privacyStatus: 'unlisted', latencyPreference: 'low' },
    });
    await settle();
    expect(prepareSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'dest-1' }), {
      title: 'Late night', description: undefined, privacyStatus: 'unlisted', latencyPreference: 'low',
    });
  });

  it('defaults the broadcast title to the playlist name, as the old session API did', async () => {
    const { manager, prepareSession } = buildManager();
    await manager.start('user-1', 'playlist-1', { destinationIds: ['dest-1'] });
    await settle();
    expect(prepareSession.mock.calls[0][1].title).toBe('Mix');
  });

  it('rejects a pre-checked destination whose provider is not registered', async () => {
    const { manager, rows } = buildManager();
    rows.set('dest-1', destinationRow({ provider: 'nonsense' }));
    await expect(manager.start('user-1', 'playlist-1', { destinationIds: ['dest-1'] }))
      .rejects.toThrow('unsupported destination provider');
  });

  // Spec: "Pause gets strictly safer than today: it no longer needs to keep any destination-facing
  // RTMP connection alive through a silence swap, because the local publish to MediaMTX never stops
  // regardless of pause state." Concretely: pausing must not look like a source outage to a forward,
  // or every destination would drop the moment the user hit pause.
  it('keeps every forward running across a pause and resume', async () => {
    const { manager, relays } = buildManager();
    await manager.start('user-1', 'playlist-1', { destinationIds: ['dest-1'] });
    await settle();

    manager.pause('user-1');
    await settle();
    expect(relays[0].stop).not.toHaveBeenCalled();
    expect(manager.status('user-1').destinations[0].state).not.toBe('pending');

    await manager.resume('user-1');
    await settle();
    expect(relays).toHaveLength(1); // the same relay, never respawned
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/stream/localStreamManager.test.ts`
Expected: FAIL — `setDestinationDesired` / `removeDestination` are not functions, and `status()`
still returns the old flat shape.

- [ ] **Step 3: Implement**

Replace `src/stream/localStreamManager.ts` in full:

```typescript
import { EventEmitter } from 'events';
import { StreamDestination } from '@prisma/client';
import { PlaylistQueue } from '../playlist/queue';
import { StreamController } from './streamController';
import { SessionState } from './types';
import { ApiError } from '../errors';
import { createReconnectPolicy, createForwardReconnectPolicy } from './reconnectPolicy';
import { buildStreamScene, StreamSceneDeps } from './streamScene';
import { LocalRelaySession, LocalRelayTarget } from './localRelayTarget';
import { MediaMtxAuthRegistry } from './mediaMtxAuth';
import { DestinationForward, DestinationForwardStatus, ForwardDesiredState } from './destinationForward';
import { RelayProcess } from '../ffmpeg/relayProcess';
import { DestinationRepository } from '../destinations/destinationRepository';
import { BroadcastMeta, StreamDestinationProvider } from '../destinations/streamDestinationProvider';

// 'starting' is the spec's promotion of the old side-channel `starting` Set into a real reported
// state: a destination toggle can now arrive mid-start and the UI must not read 'idle' while a
// start is in flight. Deliberately a STATUS-layer state only — StreamController never produces it,
// so SessionState itself stays exactly as it is.
export type LocalSessionState = SessionState | 'starting';

export interface LocalStreamState {
  state: LocalSessionState;
  currentTrack: string | null;
  nextTrack: string | null;
  // True once the encoder is publishing into MediaMTX — including while paused, because pausing
  // only swaps the audio to silence and never interrupts the local publish. This is exactly the
  // condition under which the HLS preview can produce a playlist.
  previewReady: boolean;
  playlistId: string | null;
  templateId: string | null;
  startedAt: string | null;
}

// The spec's combined payload: one local stream, and 0..N independently toggleable destinations.
// Zero destinations is a fully valid running state, not a degenerate one.
export interface LocalStreamStatus {
  local: LocalStreamState;
  destinations: DestinationForwardStatus[];
}

export interface StartLocalStreamOptions {
  templateId?: string;
  // Destinations to pre-check. Setting an intent and reconciling is the SAME code path a mid-stream
  // toggle takes — deliberately, so there is no second orchestration path to keep in sync.
  destinationIds?: string[];
  // Broadcast metadata for any destination this session prepares (YouTube and any future
  // broadcast-creating provider). Ignored entirely by custom RTMP destinations.
  meta?: Partial<BroadcastMeta>;
}

export interface LocalPreviewTarget {
  hlsBaseUrl: string;
  authorization: string;
}

export interface LocalStreamManagerDeps {
  sceneDeps: StreamSceneDeps;
  relayTarget: Pick<LocalRelayTarget, 'create'>;
  authRegistry: Pick<MediaMtxAuthRegistry, 'register' | 'unregister'>;
  destinationRepository: Pick<DestinationRepository, 'findById'>;
  providers: Record<string, StreamDestinationProvider>;
  // Spec open question #8: every logged-in user can start an encode without owning any destination
  // at all, so a per-host ceiling is required rather than optional.
  maxConcurrentStreams: number;
  // Spec open question #7: a local stream with nothing forwarded and nobody watching still costs a
  // full libx264 encode, so it cannot run forever.
  maxSessionDurationMs: number;
  // Injected for tests; production always uses the real buildStreamScene.
  buildScene?: typeof buildStreamScene;
  // Injected for tests; production builds a RelayProcess on the SAME Spawner the scene uses, so a
  // relay's ffmpeg stderr is drained and timestamped exactly like the encoder's.
  createRelay?: (params: { inputUrl: string; outputUrl: string }) => RelayProcess;
}

interface LocalStreamEntry {
  controller: StreamController;
  relay: LocalRelaySession;
  playlistId: string;
  templateId: string | null;
  meta: BroadcastMeta;
  startedAt: number;
  expiryTimer: NodeJS.Timeout;
}

const IDLE_LOCAL_STATE: LocalStreamState = {
  state: 'idle', currentTrack: null, nextTrack: null,
  previewReady: false, playlistId: null, templateId: null, startedAt: null,
};

/**
 * Owns exactly one local stream per user account plus that account's destination forwards — the
 * replacement for BOTH StreamManager (destinationId-keyed controllers) and StreamSessionManager
 * (fan-out over N of them). There is one encode now, so there is nothing to fan out: destinations
 * are readers of the same local relay, toggled independently, and none of them can ever
 * desynchronise from another or take the encode down with it.
 */
export class LocalStreamManager extends EventEmitter {
  private readonly streams = new Map<string, LocalStreamEntry>();
  private readonly starting = new Set<string>();
  // userId -> destinationId -> forward. Survives the stream being idle: a forward toggled on with
  // nothing running parks at 'pending' (zero external side effects) and comes to life on the next
  // start.
  private readonly forwards = new Map<string, Map<string, DestinationForward>>();
  private readonly buildScene: typeof buildStreamScene;
  private readonly createRelay: (params: { inputUrl: string; outputUrl: string }) => RelayProcess;

  constructor(private readonly deps: LocalStreamManagerDeps) {
    super();
    // Every open SSE connection adds a 'statusChanged' listener to this one shared instance —
    // legitimately unbounded by design, not a leak.
    this.setMaxListeners(0);
    this.buildScene = deps.buildScene ?? buildStreamScene;
    this.createRelay = deps.createRelay
      ?? ((params) => new RelayProcess({ spawner: deps.sceneDeps.spawner, ...params }));
  }

  async start(userId: string, playlistId: string, options: StartLocalStreamOptions = {}): Promise<void> {
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
    // `streams.size` before any of them incremented it. `starting.size` closes that window because
    // it is incremented right here, synchronously. A stream stuck in `error` also no longer pins a
    // slot forever: `active` excludes it, since an errored encoder has already stopped costing CPU.
    const active = [...this.streams.values()].filter((e) => e.controller.status().state !== 'error').length;
    if (active + this.starting.size >= this.deps.maxConcurrentStreams) {
      throw new ApiError(429, 'too many local streams are running on this host; try again later');
    }

    this.starting.add(userId);
    this.emit('statusChanged', userId);
    try {
      // Resolve every pre-checked destination BEFORE any side effect: a bad or foreign id must
      // 404/403 without minting a relay token, registering credentials or building a scene.
      const destinations: StreamDestination[] = [];
      for (const destinationId of new Set(options.destinationIds ?? [])) {
        const destination = await this.requireOwnedDestination(userId, destinationId);
        this.requireProvider(destination);
        destinations.push(destination);
      }

      const scene = await this.buildScene(this.deps.sceneDeps, {
        userId,
        playlistId,
        templateId: options.templateId,
        // One pipeline per user, so the user's own id is a sufficient namespace for the on-disk
        // overlay PNGs.
        sceneId: userId,
      });

      const meta: BroadcastMeta = {
        title: options.meta?.title ?? scene.playlistName,
        description: options.meta?.description,
        privacyStatus: options.meta?.privacyStatus,
        latencyPreference: options.meta?.latencyPreference,
      };

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
        // No isRetryableDestination veto: there is no destination at THIS layer any more — the
        // encoder pushes into a container-network MediaMTX that essentially never drops for network
        // reasons, so reconnect here fires only on a genuine ffmpeg crash/OOM. Destination-side
        // reconnect is each DestinationForward's own concern, on its own faster schedule.
        reconnectPolicy: createReconnectPolicy(),
        onError: (exitCode) => {
          console.error(
            `[${new Date().toISOString()}] user ${userId}: local encoder exited unexpectedly (code=${exitCode}) and reconnect gave up; revoking its MediaMTX credentials`,
          );
          const entry = this.streams.get(userId);
          if (entry && entry.relay.path === relay.path) {
            clearTimeout(entry.expiryTimer);
            this.deps.authRegistry.unregister(relay.path);
          }
        },
        onStatusChanged: () => {
          this.emit('statusChanged', userId);
          // Every local state change is a forward-relevant event: starting to publish, pausing
          // (still publishing), reconnecting (hold), giving up (finalize).
          this.reconcileForwards(userId);
        },
      });

      const expiryTimer = setTimeout(() => {
        console.warn(`[stream] user ${userId}: local stream hit the maximum session duration, stopping it`);
        void this.stop(userId).catch((err) => {
          console.error('failed to stop a local stream that hit its maximum duration', err);
        });
      }, this.deps.maxSessionDurationMs);
      // Never let an idle 12-hour timer hold the process open on shutdown.
      expiryTimer.unref();

      const entry: LocalStreamEntry = {
        controller, relay, playlistId, templateId: options.templateId ?? null, meta,
        startedAt: Date.now(), expiryTimer,
      };
      this.streams.set(userId, entry);

      try {
        await controller.start();
      } catch (err) {
        // controller.start() can throw AFTER already spawning the encoder/CanvasFeeder/AudioRelay.
        // Without this stop(), they keep running as a genuine orphan whose MediaMTX credentials
        // discard() is about to revoke.
        if (controller.status().state !== 'idle') controller.stop();
        this.discard(userId, entry);
        throw err;
      }

      // Intents first, then one reconcile: "start with these pre-checked" and "check a box
      // mid-stream" are deliberately the same code path.
      for (const destination of destinations) {
        this.getOrCreateForward(userId, destination).setDesired('on');
      }
      // A forward can SURVIVE across stop-and-restart without going through getOrCreateForward at
      // all: an encoder crash finalizes it into 'pending' (branch 1) without pruning it (desired is
      // still 'on'), and this restart's `destinations` array only contains whatever the CALLER
      // passed this time — a destination the user checked earlier and never unchecked isn't in it.
      // Without this, that surviving forward's very next prepareSession() would read the STALE row
      // captured whenever it was originally constructed, missing any youtubeLiveStreamId a prior
      // session persisted — the exact bug setDestination() exists to prevent, just reachable from a
      // different call site than the toggle route. Refresh every surviving forward's row here, not
      // only the ones this call happens to also be (re-)toggling on.
      await this.refreshForwardRows(userId);
      this.reconcileForwards(userId);
    } finally {
      this.starting.delete(userId);
      this.emit('statusChanged', userId);
    }
  }

  async stop(userId: string): Promise<void> {
    const entry = this.require(userId);
    const forwards = [...(this.forwards.get(userId)?.values() ?? [])];
    // Set every intent to off SYNCHRONOUSLY first, so no forward can spawn a new relay or prepare a
    // new broadcast while the teardown below is in flight. Spec: "Stop while a forward is
    // mid-toggle-on — set every desired = off; the in-flight prepare completes, registers, and the
    // next reconcile() finalizes it. No special case needed."
    for (const forward of forwards) forward.setDesired('off');
    if (entry.controller.status().state !== 'idle') entry.controller.stop();
    this.discard(userId, entry);
    await Promise.all(forwards.map((forward) => forward.shutdown()));
    this.forwards.delete(userId);
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

  /**
   * The checkbox. Idempotent, never blocks on the work it triggers, and valid in every local-stream
   * state including idle (spec open question #3: a toggle while nothing runs parks at 'pending'
   * rather than 409ing, so pre-checking and mid-stream toggling are one code path).
   */
  async setDestinationDesired(userId: string, destinationId: string, desired: ForwardDesiredState): Promise<LocalStreamStatus> {
    const destination = await this.requireOwnedDestination(userId, destinationId);
    this.requireProvider(destination);
    const forward = this.getOrCreateForward(userId, destination);
    forward.setDesired(desired);
    // Deliberately NOT pruning here, even for desired === 'off': a toggle-off starts finalize()
    // asynchronously (this call returns before it resolves), and isInactive() correctly reports
    // false while it's 'stopping' — but calling pruneForwards() eagerly right after setDesired()
    // is exactly the pattern that made the earlier (buggy) version of isInactive() dangerous: any
    // future weakening of that check would silently reopen the toggle-off-then-fast-toggle-on race
    // (see isInactive()'s comment). Pruning instead happens from onStatusChanged (below in
    // getOrCreateForward), which fires every time a forward's OWN state actually changes — so a
    // forward is only ever removed once it has genuinely finished settling to off.
    return this.status(userId);
  }

  /**
   * Called when a destination row is deleted. Toggles that forward off and finalizes its lifecycle
   * WITHOUT touching the local stream — the pre-rework code called `streamManager.stop
   * (destinationId)` here, which in this model would tear down the user's whole encode to delete
   * one checkbox (the spec calls this out as an "easy one-line miss that orphans a broadcast").
   */
  async removeDestination(userId: string, destinationId: string): Promise<void> {
    const forward = this.forwards.get(userId)?.get(destinationId);
    if (!forward) return;
    await forward.shutdown();
    this.forwards.get(userId)?.delete(destinationId);
    this.pruneForwards(userId);
  }

  status(userId: string): LocalStreamStatus {
    return { local: this.localState(userId), destinations: this.forwardStatuses(userId) };
  }

  // The ONLY way the preview route learns which MediaMTX path to read: resolved server-side from
  // the authenticated user. Never accept a path or token from the client. Returns null unless this
  // user still owns a LIVE MediaMTX registration, so a dead session's credential is never handed
  // out. 'reconnecting' counts as live (a pending respawn still needs it) and 'error' does not.
  previewTarget(userId: string): LocalPreviewTarget | null {
    const entry = this.streams.get(userId);
    if (!entry) return null;
    const state = entry.controller.status().state;
    if (state !== 'streaming' && state !== 'paused' && state !== 'reconnecting') return null;
    return { hlsBaseUrl: entry.relay.hlsBaseUrl, authorization: entry.relay.readAuthorization };
  }

  private localState(userId: string): LocalStreamState {
    const entry = this.streams.get(userId);
    if (!entry) {
      return this.starting.has(userId) ? { ...IDLE_LOCAL_STATE, state: 'starting' } : { ...IDLE_LOCAL_STATE };
    }
    const base = entry.controller.status();
    return {
      state: base.state,
      currentTrack: base.currentTrack,
      nextTrack: base.nextTrack,
      previewReady: base.state === 'streaming' || base.state === 'paused',
      playlistId: entry.playlistId,
      templateId: entry.templateId,
      startedAt: new Date(entry.startedAt).toISOString(),
    };
  }

  private forwardStatuses(userId: string): DestinationForwardStatus[] {
    return [...(this.forwards.get(userId)?.values() ?? [])].map((forward) => forward.status());
  }

  // `destination` MUST be re-applied on every call, even when an existing forward is returned.
  // A `DestinationForward` is created once and can live across many `prepareSession()` calls
  // (respawn, toggle-off-then-on, a parked 'pending' forward that finally starts) — if it kept
  // using the row captured at CONSTRUCTION time, `YoutubeProvider.prepareSession()`'s persisted
  // `youtubeLiveStreamId` (written to the DB by Task 5, so the NEXT prepareSession reuses the same
  // liveStream) would never be visible to that same forward object: it would keep reading its own
  // stale in-memory copy (still `null`) and create a brand-new liveStream every time, silently
  // defeating the entire point of Task 4/5 and — since `finalize()` no longer deletes the
  // liveStream (Task 5) — leaking one permanently on every such call. `setDestination()` is called
  // with a FRESH row every time (the caller already has one from `requireOwnedDestination`), on
  // both the existing-forward early return and the newly-constructed path.
  private getOrCreateForward(userId: string, destination: StreamDestination): DestinationForward {
    let forwards = this.forwards.get(userId);
    if (!forwards) {
      forwards = new Map<string, DestinationForward>();
      this.forwards.set(userId, forwards);
    }
    const existing = forwards.get(destination.id);
    if (existing) {
      existing.setDestination(destination);
      return existing;
    }

    const forward = new DestinationForward({
      destination,
      provider: this.requireProvider(destination),
      // Resolved lazily so a forward created while nothing is running picks up the metadata of
      // whatever session eventually starts.
      meta: () => this.streams.get(userId)?.meta ?? { title: destination.name },
      sourceUrl: () => this.sourceUrlFor(userId),
      isSourcePublishing: () => this.isSourcePublishing(userId),
      createRelay: this.createRelay,
      reconnectPolicy: createForwardReconnectPolicy(),
      onStatusChanged: () => {
        // Prune from the ONE place a forward's own actual-state transitions flow through, so a
        // forward is only ever dropped once it has genuinely finished settling to 'off' — never
        // eagerly from the synchronous toggle call (see setDestinationDesired()'s comment).
        const forwardsForUser = this.forwards.get(userId);
        if (forwardsForUser?.get(destination.id)?.isInactive()) this.pruneForwards(userId);
        this.emit('statusChanged', userId);
      },
    });
    forwards.set(destination.id, forward);
    return forward;
  }

  private sourceUrlFor(userId: string): string | null {
    const entry = this.streams.get(userId);
    if (!entry) return null;
    const state = entry.controller.status().state;
    // 'error' means reconnect gave up and onError already revoked this session's MediaMTX
    // credentials — the session is over, so forwards must finalize rather than keep holding.
    // 'reconnecting' deliberately still returns the URL: that is what makes forwards HOLD instead
    // of burning a broadcast (and ~330 quota units, and every viewer's link) over a few seconds of
    // encoder downtime.
    if (state === 'idle' || state === 'error') return null;
    return entry.relay.readRtmpUrl;
  }

  private isSourcePublishing(userId: string): boolean {
    const state = this.streams.get(userId)?.controller.status().state;
    return state === 'streaming' || state === 'paused';
  }

  private reconcileForwards(userId: string): void {
    // reconcile() never rejects (DestinationForward.run() catches), so these are fire-and-forget by
    // design: a status change must not wait on a YouTube round-trip.
    for (const forward of this.forwards.get(userId)?.values() ?? []) void forward.reconcile();
  }

  // Called once, from start(), right before reconcileForwards() — NOT from every onStatusChanged
  // (that one stays synchronous/fire-and-forget on purpose; a plain local DB read on every relay
  // exit or pause/resume would be needless load). A local DB lookup, not a provider round-trip, so
  // awaiting it here doesn't reintroduce the "a status change must not wait on YouTube" problem
  // reconcileForwards's own comment guards against.
  private async refreshForwardRows(userId: string): Promise<void> {
    const forwards = [...(this.forwards.get(userId)?.values() ?? [])];
    await Promise.all(forwards.map(async (forward) => {
      const row = await this.deps.destinationRepository.findById(forward.destinationId);
      if (row) forward.setDestination(row);
    }));
  }

  // Drop forwards that want nothing and hold nothing, so a user who ticked and unticked a box does
  // not carry a dead entry in every status payload forever.
  private pruneForwards(userId: string): void {
    const forwards = this.forwards.get(userId);
    if (!forwards) return;
    for (const [destinationId, forward] of forwards) {
      if (forward.isInactive()) forwards.delete(destinationId);
    }
    if (forwards.size === 0) this.forwards.delete(userId);
  }

  private async requireOwnedDestination(userId: string, destinationId: string): Promise<StreamDestination> {
    const destination = await this.deps.destinationRepository.findById(destinationId);
    if (!destination) throw new ApiError(404, 'destination not found');
    if (destination.userId !== userId) throw new ApiError(403, 'not your destination');
    return destination;
  }

  private requireProvider(destination: StreamDestination): StreamDestinationProvider {
    const provider = this.deps.providers[destination.provider];
    if (!provider) throw new ApiError(400, `unsupported destination provider: ${destination.provider}`);
    return provider;
  }

  private require(userId: string): LocalStreamEntry {
    const entry = this.streams.get(userId);
    if (!entry) throw new ApiError(409, 'local stream is not active');
    return entry;
  }

  // Drops every trace of a session: its expiry timer, its MediaMTX credentials, and its registry
  // slot (which is what frees capacity under maxConcurrentStreams). Forwards are handled
  // separately, by stop() itself (which calls this) — a stop is a full stop, not a pause: every
  // forward's desired is forced to 'off' and its lifecycle finalized before the forward map entry
  // is dropped, so a destination a user wants "checked next time" is a frontend-side preference
  // (the idle-mode checklist in Stream.tsx), not something this manager remembers across a
  // stop/start on its own.
  private discard(userId: string, entry: LocalStreamEntry): void {
    clearTimeout(entry.expiryTimer);
    this.deps.authRegistry.unregister(entry.relay.path);
    if (this.streams.get(userId) === entry) this.streams.delete(userId);
  }
}
```

- [ ] **Step 4: Wire the new deps in the composition root**

In `src/server.ts`, extend the `LocalStreamManager` construction (currently lines 178-184):

```typescript
  const localStreamManager = new LocalStreamManager({
    sceneDeps,
    relayTarget: new LocalRelayTarget({ rtmpBaseUrl: config.mediaMtxRtmpUrl, hlsBaseUrl: config.mediaMtxHlsUrl }),
    authRegistry: mediaMtxAuthRegistry,
    destinationRepository,
    providers: streamDestinationProviders,
    maxConcurrentStreams: config.maxConcurrentLocalStreams,
    maxSessionDurationMs: config.maxLocalStreamDurationMs,
  });
```

and give `YoutubeProvider` its new repository dep (currently line 139):

```typescript
    youtube: new YoutubeProvider({
      client: youtubeApiClient,
      encryptionKey: config.streamKeyEncryptionKey,
      oauthConnectionRepository,
      destinationRepository,
    }),
```

(`destinationRepository` is already declared before `streamDestinationProviders` in `src/server.ts`
today — no reordering is actually needed here.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest test/stream/localStreamManager.test.ts && npm run build`
Expected: PASS. `test/stream/localStreamEvents.test.ts` and `test/stream/localStreamRoutes.test.ts`
will still fail on the status shape — Task 7 updates them.

- [ ] **Step 6: Commit**

```bash
git add src/stream/localStreamManager.ts src/server.ts test/stream/localStreamManager.test.ts
git commit -m "$(cat <<'EOF'
feat: give LocalStreamManager its destination forwards

One encode per account plus a map of independently toggleable forwards, replacing
StreamManager's three destinationId-keyed maps and StreamSessionManager's fan-out.
Status becomes {local, destinations[]}; a start can pre-check destinations and
carry broadcast metadata; deleting a destination stops only its own forward.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 7: `/local-stream/*` — start options, the toggle route, the combined payload

**Files:**
- Modify: `src/stream/localStreamRoutes.ts:45-96`
- Modify: `src/destinations/destinationRoutes.ts:16-23,51-62`
- Modify: `src/api/app.ts:60` (the destination router's new dep)
- Modify: `src/api/openapi.ts` (the `/local-stream/*` block and the `LocalStreamStatus` schema)
- Test: `test/stream/localStreamRoutes.test.ts`, `test/stream/localStreamEvents.test.ts`,
  `test/destinations/destinationRoutes.test.ts`, `test/api/openapi.test.ts`

**Interfaces:**
- Consumes: `LocalStreamManager.setDestinationDesired`, `.removeDestination`, `.start(userId,
  playlistId, { templateId?, destinationIds?, meta? })`, the async `.stop`, and the
  `{local, destinations}` `status()` (Task 6); `ForwardDesiredState` (Task 3).
- Produces:
  - `PUT /local-stream/destinations/:destinationId` with body `{ desired: 'on' | 'off' }` → 200
    `LocalStreamStatus`.
  - `POST /local-stream/start` body `{ playlistId, templateId?, destinationIds?, title?,
    description?, privacyStatus?, latencyPreference? }`.
  - `createDestinationRouter(authService, destinationRepository, encryptionKey, localStreamManager:
    Pick<LocalStreamManager, 'removeDestination'>, oauthProviderAdapters, oauthConnectionRepository)`.

- [ ] **Step 1: Write the failing route tests**

In `test/stream/localStreamRoutes.test.ts`, replace the flat `STATUS` constant with the nested one,
add the new cases below, AND fix three existing tests this task's own change silently contradicts
(today at lines 30-55):
- The two existing assertions of `manager.start` being called with `{ templateId: … }` (today at
  lines 34 and 43) must become `{ templateId: …, destinationIds: undefined, meta: { title:
  undefined, description: undefined, privacyStatus: undefined, latencyPreference: undefined } }` —
  matching exactly what the new `'starts with no destinations at all'` test below asserts for the
  same no-options-passed call shape — because the new handler (Step 3) always builds all three top-
  level keys, not just `templateId`, and `meta` itself is always an object with all four fields
  present (as `undefined` when omitted from the body), never `undefined` itself.
- `'POST /start ignores destination-only broadcast fields entirely'` (today at lines 49-55) asserts
  a 200 for `body.privacyStatus: 'nonsense'`. This task makes that 400 (see the `it.each` validation
  cases in Step 3) — the test now asserts the OPPOSITE of the intended behaviour. Delete it; its
  replacement is the new `it.each` validation test added below.

```typescript
const STATUS = {
  local: {
    state: 'streaming', currentTrack: 'a', nextTrack: 'b',
    previewReady: true, playlistId: 'p1', templateId: null, startedAt: '2026-09-14T10:00:00.000Z',
  },
  destinations: [],
};
```

```typescript
describe('local stream destination toggles', () => {
  it('PUT /destinations/:id turns a forward on for the authenticated user', async () => {
    const manager: any = { setDestinationDesired: jest.fn().mockResolvedValue(STATUS) };
    const res = await request(buildApp(manager, 'user-7'))
      .put('/local-stream/destinations/dest-1').send({ desired: 'on' });
    expect(res.status).toBe(200);
    expect(manager.setDestinationDesired).toHaveBeenCalledWith('user-7', 'dest-1', 'on');
    expect(res.body).toEqual(STATUS);
  });

  it('PUT /destinations/:id rejects a body that is not on/off', async () => {
    const manager: any = { setDestinationDesired: jest.fn() };
    const app = buildApp(manager);
    for (const desired of [undefined, '', 'yes', true, 1]) {
      const res = await request(app).put('/local-stream/destinations/dest-1').send({ desired });
      expect(res.status).toBe(400);
    }
    expect(manager.setDestinationDesired).not.toHaveBeenCalled();
  });

  // Same reasoning as the POST routes: these no-id-in-the-URL routes have no accidental CSRF token,
  // so requiring JSON is what forces a preflight the CORS policy has to approve.
  it('PUT /destinations/:id rejects a request that is not application/json', async () => {
    const manager: any = { setDestinationDesired: jest.fn() };
    const res = await request(buildApp(manager))
      .put('/local-stream/destinations/dest-1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('desired=on');
    expect(res.status).toBe(400);
    expect(manager.setDestinationDesired).not.toHaveBeenCalled();
  });

  it('passes a 404/403 from the manager straight through', async () => {
    const manager: any = { setDestinationDesired: jest.fn().mockRejectedValue(new ApiError(403, 'not your destination')) };
    const res = await request(buildApp(manager)).put('/local-stream/destinations/dest-1').send({ desired: 'on' });
    expect(res.status).toBe(403);
  });
});

describe('POST /local-stream/start options', () => {
  it('passes pre-checked destinations and broadcast metadata through', async () => {
    const manager: any = { start: jest.fn().mockResolvedValue(undefined), status: jest.fn().mockReturnValue(STATUS) };
    const res = await request(buildApp(manager, 'user-2')).post('/local-stream/start').send({
      playlistId: 'p1', templateId: 'tpl-1', destinationIds: ['d1', 'd2'],
      title: 'Late night', description: 'chill', privacyStatus: 'unlisted', latencyPreference: 'low',
    });
    expect(res.status).toBe(200);
    expect(manager.start).toHaveBeenCalledWith('user-2', 'p1', {
      templateId: 'tpl-1',
      destinationIds: ['d1', 'd2'],
      meta: { title: 'Late night', description: 'chill', privacyStatus: 'unlisted', latencyPreference: 'low' },
    });
  });

  it('starts with no destinations at all — a fully valid running state', async () => {
    const manager: any = { start: jest.fn().mockResolvedValue(undefined), status: jest.fn().mockReturnValue(STATUS) };
    const res = await request(buildApp(manager)).post('/local-stream/start').send({ playlistId: 'p1' });
    expect(res.status).toBe(200);
    expect(manager.start).toHaveBeenCalledWith('user-1', 'p1', {
      templateId: undefined, destinationIds: undefined,
      meta: { title: undefined, description: undefined, privacyStatus: undefined, latencyPreference: undefined },
    });
  });

  it.each([
    [{ destinationIds: 'd1' }],
    [{ destinationIds: [1] }],
    [{ destinationIds: ['d1', 'd1'] }],
    [{ title: 5 }],
    [{ description: {} }],
    [{ privacyStatus: 'semi-public' }],
    [{ latencyPreference: 'instant' }],
  ])('rejects invalid start option %j', async (bad) => {
    const manager: any = { start: jest.fn() };
    const res = await request(buildApp(manager)).post('/local-stream/start').send({ playlistId: 'p1', ...bad });
    expect(res.status).toBe(400);
    expect(manager.start).not.toHaveBeenCalled();
  });
});
```

Also change the existing `it.each([...])('POST /%s delegates…')` case for `stop` — the manager's
`stop` is now async, which the existing `mockResolvedValue(undefined)` fake already satisfies, so no
change is needed there beyond the `STATUS` shape.

In `test/stream/localStreamEvents.test.ts`, change the `IDLE`/`live` fixtures to the nested shape:

```typescript
const IDLE: LocalStreamStatus = {
  local: {
    state: 'idle', currentTrack: null, nextTrack: null,
    previewReady: false, playlistId: null, templateId: null, startedAt: null,
  },
  destinations: [],
};
```

and the `live` fixture correspondingly (`local: {...}`, plus one destination entry so the test
proves forwards ride the same SSE stream):

```typescript
    const live: LocalStreamStatus = {
      local: {
        state: 'streaming', currentTrack: 'a', nextTrack: 'b',
        previewReady: true, playlistId: 'p1', templateId: null, startedAt: '2026-09-14T10:00:00.000Z',
      },
      destinations: [{ destinationId: 'dest-1', name: 'Twitch', desired: 'on', state: 'live' }],
    };
```

`test/destinations/destinationRoutes.test.ts`'s `buildApp` is **positional**
(`destinationRepository, streamManager = {...}, userId, oauthProviderAdapters,
oauthConnectionRepository` — every existing test in the file already calls it this way; do not
switch it to an options object, that would break every other test alongside this one). Its second
positional argument becomes `localStreamManager` (same slot, new shape — `{ removeDestination }`
instead of `{ stop }`), since the DELETE route no longer calls `streamManager.stop(destinationId)`
at all; it calls `localStreamManager.removeDestination(userId, destinationId)`.

**Three existing tests assert the OLD `streamManager.stop()`-based behaviour this task removes —
today's lines 76-98: `'DELETE /destinations/:id stops the running stream before deleting the
row'`, `'... still deletes when stop() reports 409 ...'`, `'... propagates a non-409 stop()
failure ...'`.** `removeDestination` has no 409/500-passthrough concept to replace them with (per
Task 6's own `localStreamManager.test.ts`, it's a no-op — always resolves — when the destination
was never forwarded) — delete these three tests outright and replace them with the one below,
which is the behaviour that actually exists now:

```typescript
  // Deleting a destination must never take the account's local stream down with it — the whole
  // point of the local-first model is that the encode outlives any individual destination.
  it('stops only that destination\'s forward, not the local stream', async () => {
    const destinationRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'd1', userId: 'user-1' }), deleteById: jest.fn() };
    const localStreamManager = { removeDestination: jest.fn().mockResolvedValue(undefined) };
    const res = await request(buildApp(destinationRepository, localStreamManager)).delete('/destinations/d1');
    expect(res.status).toBe(200);
    expect(localStreamManager.removeDestination).toHaveBeenCalledWith('user-1', 'd1');
    expect(destinationRepository.deleteById).toHaveBeenCalledWith('d1');
  });
```

Every OTHER existing test in the file (the create/list/404/403/OAuth-revoke cases) is unaffected —
none of them touch the second `streamManager`/`localStreamManager` argument at all, and its default
value (`{ stop: jest.fn()... }` today) just needs its shape updated to `{ removeDestination:
jest.fn().mockResolvedValue(undefined) }` so those tests keep passing a valid fake.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest test/stream/localStreamRoutes.test.ts test/stream/localStreamEvents.test.ts test/destinations/destinationRoutes.test.ts`
Expected: FAIL — no PUT route, `start` called with the old options shape, `removeDestination` is not
a function.

- [ ] **Step 3: Implement the route changes**

In `src/stream/localStreamRoutes.ts`, replace the `/start` handler (lines 45-54) with:

```typescript
  // Every field except playlistId is optional. destinationIds pre-checks destinations — exactly the
  // same intents a later PUT /destinations/:id would set, so there is one orchestration path rather
  // than two. title/description/privacyStatus/latencyPreference configure any broadcast a
  // destination provider creates (YouTube); they are accepted again here because, unlike Phase A,
  // this API now has destinations. Custom RTMP destinations ignore them.
  router.post('/start', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const { playlistId, templateId, destinationIds, title, description, privacyStatus, latencyPreference } = req.body ?? {};
    if (typeof playlistId !== 'string' || playlistId.length === 0) throw new ApiError(400, 'body.playlistId is required');
    if (templateId !== undefined && (typeof templateId !== 'string' || templateId.length === 0)) {
      throw new ApiError(400, 'body.templateId must be a non-empty string');
    }
    if (destinationIds !== undefined) {
      if (!Array.isArray(destinationIds) || destinationIds.some((id: unknown) => typeof id !== 'string' || id.length === 0)) {
        throw new ApiError(400, 'body.destinationIds must be an array of non-empty strings');
      }
      if (new Set(destinationIds).size !== destinationIds.length) {
        throw new ApiError(400, 'body.destinationIds must not contain duplicates');
      }
    }
    if (title !== undefined && typeof title !== 'string') throw new ApiError(400, 'body.title must be a string');
    if (description !== undefined && typeof description !== 'string') throw new ApiError(400, 'body.description must be a string');
    if (privacyStatus !== undefined && !['public', 'unlisted', 'private'].includes(privacyStatus)) {
      throw new ApiError(400, "body.privacyStatus must be 'public', 'unlisted', or 'private'");
    }
    if (latencyPreference !== undefined && !['normal', 'low', 'ultraLow'].includes(latencyPreference)) {
      throw new ApiError(400, "body.latencyPreference must be 'normal', 'low', or 'ultraLow'");
    }
    const id = userId(req as AuthenticatedRequest);
    await localStreamManager.start(id, playlistId, {
      templateId,
      destinationIds,
      meta: { title, description, privacyStatus, latencyPreference },
    });
    res.status(200).json(localStreamManager.status(id));
  }));
```

Replace the `/stop` handler (lines 56-60) with the awaited form:

```typescript
  // Awaited: stop() now also shuts every destination forward down and waits for each provider-side
  // finalize (a YouTube transition-to-complete takes seconds), so the response is truthful about
  // what actually stopped.
  router.post('/stop', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const id = userId(req as AuthenticatedRequest);
    await localStreamManager.stop(id);
    res.status(200).json(localStreamManager.status(id));
  }));
```

Add the toggle route immediately after `/play` (i.e. before `GET /status`):

```typescript
  // The checkbox. PUT rather than POST because it sets a value idempotently rather than issuing a
  // command, and it carries the destination id in the URL — but it still goes through
  // requireJsonRequest, because a PUT with a JSON content-type is what forces the browser preflight
  // this app's CORS policy then has to approve.
  router.put('/destinations/:destinationId', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const { desired } = req.body ?? {};
    if (desired !== 'on' && desired !== 'off') throw new ApiError(400, "body.desired must be 'on' or 'off'");
    const id = userId(req as AuthenticatedRequest);
    const status = await localStreamManager.setDestinationDesired(id, req.params.destinationId, desired);
    res.status(200).json(status);
  }));
```

In `src/destinations/destinationRoutes.ts`, change the import and the signature (lines 10, 16-23):

```typescript
import { LocalStreamManager } from '../stream/localStreamManager';
...
export function createDestinationRouter(
  authService: AuthService,
  destinationRepository: DestinationRepository,
  encryptionKey: string,
  localStreamManager: Pick<LocalStreamManager, 'removeDestination'>,
  oauthProviderAdapters: Record<string, OAuthProviderAdapter>,
  oauthConnectionRepository: Pick<OAuthConnectionRepository, 'findByDestinationId'>,
): Router {
```

and replace the teardown block in `DELETE /:id` (lines 55-62) with:

```typescript
    // Toggle this destination's forward off and finalize its provider lifecycle (e.g. transition a
    // YouTube broadcast to complete) — but NEVER touch the account's local stream, which is not
    // this destination's to stop. Idempotent: a destination that was never forwarded is a no-op.
    await localStreamManager.removeDestination(destination.userId, destination.id);
```

In `src/api/app.ts`, change the `createDestinationRouter` call (line 60) to pass
`deps.localStreamManager` in place of `deps.streamManager`.

- [ ] **Step 4: Update the OpenAPI document**

In `src/api/openapi.ts`:

(a) replace `/local-stream/start`'s `requestBody.content['application/json'].schema.properties` and
its `responses` (lines 486-508) with:

```typescript
              schema: {
                type: 'object',
                required: ['playlistId'],
                properties: {
                  playlistId: { type: 'string' },
                  templateId: { type: 'string', description: 'Optional overlay template id (see /templates). Omitted -> the built-in default layout.' },
                  destinationIds: { type: 'array', items: { type: 'string' }, description: 'Optional destinations to switch on as soon as the stream is publishing. May be omitted or empty — a local stream with nothing forwarded is a fully valid running state. No duplicates.' },
                  title: { type: 'string', description: 'Optional broadcast title for any destination that creates a live broadcast (e.g. YouTube); defaults to the playlist name' },
                  description: { type: 'string', description: 'Optional broadcast description (destinations that create a live broadcast)' },
                  privacyStatus: { type: 'string', enum: ['public', 'unlisted', 'private'], description: 'Optional broadcast privacy; defaults to private' },
                  latencyPreference: { type: 'string', enum: ['normal', 'low', 'ultraLow'], description: "Optional YouTube broadcast latency; defaults to 'normal'" },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Started', content: { 'application/json': { schema: { $ref: '#/components/schemas/LocalStreamStatus' } } } },
          '400': { description: 'Missing playlistId, an empty-string templateId, or invalid destinationIds/broadcast fields' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your playlist, template or destination' },
          '404': { description: 'Playlist, template or destination not found' },
          '409': { description: 'A local stream is already active (or starting) for this account, or the playlist is empty' },
          '429': { description: 'Too many local streams are running on this host' },
        },
```

(b) add a new path entry after `/local-stream/play`:

```typescript
    '/local-stream/destinations/{destinationId}': {
      put: {
        summary: 'Switch one destination\'s forward on or off for this account\'s local stream',
        description: 'Idempotent. Valid in every state, including with no local stream running — the forward then sits at `pending` with no external side effects until the next start. Never interrupts the local stream or any other destination.',
        parameters: [{ name: 'destinationId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['desired'], properties: { desired: { type: 'string', enum: ['on', 'off'] } } } } },
        },
        responses: {
          '200': { description: 'Intent recorded', content: { 'application/json': { schema: { $ref: '#/components/schemas/LocalStreamStatus' } } } },
          '400': { description: 'body.desired must be on or off, or the request was not application/json' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your destination' },
          '404': { description: 'Destination not found' },
        },
      },
    },
```

(c) replace the `LocalStreamStatus` schema (lines 755-766) with the combined shape plus a new
`DestinationForwardStatus`:

```typescript
      LocalStreamStatus: {
        type: 'object',
        description: 'One local stream plus its 0..N independently toggleable destination forwards. An empty `destinations` array is a normal running state, not an error.',
        properties: {
          local: {
            type: 'object',
            properties: {
              state: { type: 'string', enum: ['idle', 'starting', 'streaming', 'paused', 'error', 'reconnecting'] },
              currentTrack: { type: 'string', nullable: true },
              nextTrack: { type: 'string', nullable: true },
              previewReady: { type: 'boolean', description: 'True while the encoder is publishing — including while paused, since pausing only swaps the audio' },
              playlistId: { type: 'string', nullable: true },
              templateId: { type: 'string', nullable: true },
              startedAt: { type: 'string', format: 'date-time', nullable: true },
            },
          },
          destinations: { type: 'array', items: { $ref: '#/components/schemas/DestinationForwardStatus' } },
        },
      },
      DestinationForwardStatus: {
        type: 'object',
        properties: {
          destinationId: { type: 'string' },
          name: { type: 'string' },
          desired: { type: 'string', enum: ['on', 'off'], description: 'What the user asked for' },
          state: {
            type: 'string',
            enum: ['off', 'pending', 'preparing', 'connecting', 'live', 'stopping', 'error'],
            description: '`pending` = wanted, but nothing is publishing locally yet (no external side effects have happened). `connecting` = a relay is running but the destination has not confirmed it; for YouTube this legitimately takes 10-40s.',
          },
          provider: {
            type: 'object',
            nullable: true,
            description: 'Present only for a destination with a broadcast lifecycle (YouTube).',
            properties: {
              type: { type: 'string' },
              phase: { type: 'string' },
              watchUrl: { type: 'string', nullable: true, description: "The channel's stable /live link for a public broadcast (survives every toggle); a per-broadcast link, fresh on every toggle, for an unlisted/private one or when no channel id is known" },
            },
          },
          error: {
            type: 'object',
            nullable: true,
            properties: {
              reason: { type: 'string', enum: ['auth', 'provider', 'relay', 'source'] },
              message: { type: 'string' },
            },
          },
        },
      },
```

Add one assertion to `test/api/openapi.test.ts`'s "documents the local-stream routes" case:

```typescript
    expect(res.body.paths).toHaveProperty(['/local-stream/destinations/{destinationId}']);
```

- [ ] **Step 5: Run everything and verify**

Run: `npx jest test/stream test/destinations test/api && npm run build`
Expected: PASS, except `test/stream/streamRoutes.test.ts`, `test/stream/streamEvents.test.ts`,
`test/stream/streamSession*.test.ts` and `test/stream/streamManager.test.ts`, which still exercise
the legacy paths — Task 8 deletes them. If the build fails on `AppDeps.streamManager` still being
required, leave it: Task 8 removes it.

- [ ] **Step 6: Commit**

```bash
git add src/stream/localStreamRoutes.ts src/destinations/destinationRoutes.ts src/api/app.ts src/api/openapi.ts test/stream/localStreamRoutes.test.ts test/stream/localStreamEvents.test.ts test/destinations/destinationRoutes.test.ts test/api/openapi.test.ts
git commit -m "$(cat <<'EOF'
feat: expose destination toggles on the local-stream API

POST /local-stream/start takes pre-checked destinations and broadcast metadata
again, PUT /local-stream/destinations/{id} is the checkbox, and status/events
carry {local, destinations[]}. Deleting a destination now stops only its own
forward instead of the account's whole encode.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 8: Delete the legacy backend paths

Full cutover, no staged fallback. Leaving `/destinations/{id}/stream/*` reachable would let a caller
start a destination-bound encode that bypasses the local stream entirely — the exact invariant
("no destination forward without an active local stream") this rework exists to establish.

> **Expected mid-plan breakage:** between this task and Task 12 the deployed frontend's
> `/stream-sessions/*` calls 404. That is intended — the frontend's own tests mock its API client,
> so the suite stays green — but do not deploy between Task 8 and Task 12.

**Files:**
- Delete: `src/stream/streamManager.ts`, `src/stream/streamRoutes.ts`,
  `src/stream/streamSessionManager.ts`, `src/stream/streamSessionRoutes.ts`,
  `src/stream/sessionOverlayCache.ts`
- Delete: `test/stream/streamManager.test.ts`, `test/stream/streamRoutes.test.ts`,
  `test/stream/streamEvents.test.ts`, `test/stream/streamSessionManager.test.ts`,
  `test/stream/streamSessionRoutes.test.ts`, `test/stream/streamSessionEvents.test.ts`
- Modify: `src/stream/streamScene.ts` (drop `overlayCache`/`sessionId` and `renderShared`),
  `src/api/app.ts`, `src/server.ts`, `src/api/openapi.ts`
- Modify: `test/stream/streamScene.test.ts:10,208-261`, `test/api/openapi.test.ts`,
  `test/server.test.ts`

**Interfaces:**
- Consumes: everything Tasks 6-7 produced.
- Produces:
  - `BuildStreamSceneParams` loses `overlayCache` and `sessionId`; the remaining shape is
    `{ userId: string; playlistId: string; templateId?: string; sceneId: string }`.
  - `AppDeps` loses `streamManager` and `streamSessionManager`.
  - `StreamManager`, `StreamSessionManager`, `StreamStartOptions`, `StreamSessionStatus`,
    `StreamSessionDestinationStatus`, `SessionOverlayCache`, `SessionOverlayCacheKey`,
    `createStreamRouter`, `createStreamSessionRouter` no longer exist.
  - `DestinationStreamStatus` and `ProviderStatus` in `src/stream/types.ts` are removed; `StreamStatus`
    and `SessionState` stay (used by `StreamController` and `LocalStreamManager`).

- [ ] **Step 1: Delete the files**

```bash
git rm src/stream/streamManager.ts src/stream/streamRoutes.ts src/stream/streamSessionManager.ts src/stream/streamSessionRoutes.ts src/stream/sessionOverlayCache.ts
git rm test/stream/streamManager.test.ts test/stream/streamRoutes.test.ts test/stream/streamEvents.test.ts test/stream/streamSessionManager.test.ts test/stream/streamSessionRoutes.test.ts test/stream/streamSessionEvents.test.ts
```

- [ ] **Step 2: Run the build to see exactly what still references them**

Run: `npm run build`
Expected: FAIL, naming `src/stream/streamScene.ts`, `src/api/app.ts` and `src/server.ts`. Fix them in
the next three steps; the compiler is the checklist.

- [ ] **Step 3: Strip the overlay cache out of `buildStreamScene`**

Spec: "Deleting it also removes `StreamStartOptions.overlayCache`/`sessionId` and the `renderShared`
indirection." Its whole reason to exist — "destinations in a session drifting onto different tracks"
— is structurally impossible now: one queue drives one encode.

In `src/stream/streamScene.ts`: delete the `import { SessionOverlayCache } ...` line (line 24),
delete the two trailing fields of `BuildStreamSceneParams` (lines 74-77) so it reads:

```typescript
export interface BuildStreamSceneParams {
  // The owner every resource below must belong to.
  userId: string;
  playlistId: string;
  // Absent -> DEFAULT_TEMPLATE_ELEMENTS, not an error. See CLAUDE.md's overlay-templates notes.
  templateId?: string;
  // Namespaces this scene's on-disk overlay PNGs. The userId today — one pipeline per account —
  // which is all this needs to be.
  sceneId: string;
}
```

and delete the `renderShared` wrapper (lines 258-266), calling `renderLayer` directly:

```typescript
    let overlayPng: Buffer;
    let overlayPngAbove: Buffer | undefined;
    try {
      [overlayPng, overlayPngAbove] = await Promise.all([
        renderLayer(belowElements, 'below'),
        splitCanvas ? renderLayer(aboveElements, 'above') : Promise.resolve(undefined),
      ]);
    } catch (err) {
```

In `test/stream/streamScene.test.ts`, delete the `SessionOverlayCache` import (line 10) and the
whole `describe('buildStreamScene — overlay cache integration (SessionOverlayCache)')` block
(lines 208-261). Nothing replaces it: the behaviour it guarded no longer exists.

Also delete the now-dead assertion in `test/stream/localStreamManager.test.ts`:

```typescript
  it('passes no overlay cache or session id — one queue drives one encode, so there is nothing to share', ...)
```

- [ ] **Step 4: Unwire the routers**

In `src/api/app.ts`: delete the `StreamManager`, `createStreamRouter`, `StreamSessionManager` and
`createStreamSessionRouter` imports; delete `streamManager` and `streamSessionManager` from
`AppDeps`; delete the two `app.use(...)` lines for `/destinations/:destinationId/stream` and
`/stream-sessions`. The mount block becomes:

```typescript
  app.use('/destinations', createDestinationRouter(deps.authService, deps.destinationRepository, deps.destinationEncryptionKey, deps.localStreamManager, deps.oauthProviderAdapters, deps.oauthConnectionRepository));
  app.use('/destinations', createOAuthRouter(deps.authService, deps.oauthProviderAdapters, deps.oauthStateRepository, deps.oauthConnectionRepository, deps.destinationRepository, deps.destinationEncryptionKey));
  app.use('/local-stream', createLocalStreamRouter(deps.authService, deps.localStreamManager, deps.previewFetch));
```

In `src/server.ts`: delete the `StreamManager`, `StreamSessionManager` and `StreamSessionRepository`
imports and their three `const` blocks (lines 20-22, 162-175), and the two now-removed `createApp`
deps. `sceneDeps` stays exactly as it is — it is the only consumer left.

In `src/stream/types.ts`, delete `ProviderStatus` and `DestinationStreamStatus` (lines 14-22);
`SessionState` and `StreamStatus` stay.

- [ ] **Step 5: Delete the legacy OpenAPI blocks**

In `src/api/openapi.ts`, delete every `'/destinations/{destinationId}/stream/...'` path entry
(lines 206-345) and every `'/stream-sessions...'` entry (lines 346-480), and the now-unreferenced
`StreamStatus` and `StreamSessionStatus` component schemas (lines 808-843).

In `test/api/openapi.test.ts`, drop `streamManager`/`streamSessionManager` from the `createApp` call
and add a regression check so nobody reintroduces the legacy surface by accident:

```typescript
  // Full cutover: leaving these reachable would let a caller start a destination-bound encode that
  // bypasses the local stream, which is exactly the invariant the local-first rework establishes.
  it('no longer documents the removed per-destination and session stream APIs', async () => {
    const res = await request(buildApp()).get('/openapi.json');
    expect(res.body.paths).not.toHaveProperty(['/destinations/{destinationId}/stream/start']);
    expect(res.body.paths).not.toHaveProperty('/stream-sessions');
  });
```

In `test/server.test.ts`, add:

```typescript
  it('does not serve the removed per-destination or session stream routes', async () => {
    const { app } = buildServer(config, fakeSpawner());
    expect((await request(app).post('/destinations/d1/stream/start').send({ playlistId: 'p1' })).status).toBe(404);
    expect((await request(app).get('/stream-sessions')).status).toBe(404);
  });
```

- [ ] **Step 6: Rewrite stale comments that name the deleted classes, before the grep gate below**

`StreamManager`/`StreamSessionManager` are referenced in COMMENTS across several files this task
never otherwise touches — leaving them is not merely cosmetic, one of them (`youtubeApiClient.ts`)
is a real cross-reference a future reader would follow into a file that no longer exists. Run
`git grep -n "StreamManager\|StreamSessionManager" src` (excluding `LocalStreamManager` matches by
eye) to find the current set — at the time this task was written it was: `src/templates
/templateTypes.ts`, `src/templates/templateRoutes.ts`, `src/render/renderOverlay.ts`,
`src/ffmpeg/persistentEncoderArgs.ts`, `src/ffmpeg/pulseVisualizer.ts`, `src/audio/pulseEngine.ts`,
`src/destinations/youtubeProvider.ts`, `src/destinations/youtubeApiClient.ts` — but treat that as a
starting point, not an exhaustive list, since exact line numbers will have shifted by the time this
task actually runs (Task 5 already edits `youtubeProvider.ts`). For each match, reword the comment
to name whichever of `buildStreamScene()`, `LocalStreamManager`, or `DestinationForward` it should
actually be pointing at now. `youtubeApiClient.ts`'s comment specifically cites
`src/stream/streamManager.ts` as the file its ingest-resolution logic must match — that file is
gone; the correct pointer is `src/stream/streamScene.ts`.

- [ ] **Step 7: Run everything**

Run: `npx jest && npm run build`
Expected: PASS. `git grep -n "StreamManager\|StreamSessionManager\|SessionOverlayCache\|streamRoutes\|streamSessionRoutes" src test` must return **only** matches for `LocalStreamManager`.

- [ ] **Step 8: Commit**

```bash
git add -A src test
git commit -m "$(cat <<'EOF'
refactor: delete the per-destination and session streaming paths

StreamManager, StreamSessionManager, SessionOverlayCache, their routers, their
OpenAPI blocks and their tests are gone: one local encode with toggleable
destination forwards replaces both. buildStreamScene loses the overlayCache and
sessionId parameters with them — one queue driving one encode makes the drift
that cache guarded against structurally impossible.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `StreamSession` becomes a saved preset at `/stream-presets`

Spec open question #1, which the addendum's decision (b) says to build now: "repurposed as a *saved
preset* (playlist + template + a default destination checklist to pre-populate on next start), not
dropped. No longer represents 'the running thing' — that's `LocalStream` now."

**Files:**
- Delete: `src/stream/streamSessionRepository.ts` (replaced, see below)
- Create: `src/stream/streamPresetRepository.ts`, `src/stream/streamPresetRoutes.ts`
- Create: `test/stream/streamPresetRoutes.test.ts`
- Modify: `src/api/app.ts`, `src/server.ts`, `src/api/openapi.ts`, `test/api/openapi.test.ts`

**Interfaces:**
- Consumes: the `StreamSession.name` / `latencyPreference` columns (Task 4).
- Produces:
  - `interface StreamPresetRecord { id: string; userId: string; name: string; playlistId: string; templateId: string | null; title: string | null; description: string | null; privacyStatus: string | null; latencyPreference: string | null; createdAt: Date; destinationIds: string[] }`
  - `class StreamPresetRepository { create(data): Promise<StreamPresetRecord>; update(id, data): Promise<StreamPresetRecord>; findById(id): Promise<StreamPresetRecord | null>; listByUser(userId): Promise<StreamPresetRecord[]>; deleteById(id): Promise<void> }`
    where `data` is `{ userId?, name, playlistId, templateId, destinationIds, title, description, privacyStatus, latencyPreference }` (`userId` only on `create`).
  - `createStreamPresetRouter(authService, streamPresetRepository, playlistRepository, templateRepository, destinationRepository): Router`, mounted at `/stream-presets`.

- [ ] **Step 1: Write the failing route test**

Create `test/stream/streamPresetRoutes.test.ts`:

```typescript
import express from 'express';
import request from 'supertest';
import { createStreamPresetRouter } from '../../src/stream/streamPresetRoutes';
import { errorHandler } from '../../src/api/errorHandler';

const PRESET = {
  id: 'preset-1', userId: 'user-1', name: 'Friday night', playlistId: 'p1', templateId: 'tpl-1',
  title: null, description: null, privacyStatus: null, latencyPreference: null,
  createdAt: new Date('2026-09-14T10:00:00.000Z'), destinationIds: ['dest-1'],
};

function buildApp(userId = 'user-1') {
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: userId, email: 'a@example.com' }) };
  const repository: any = {
    create: jest.fn().mockResolvedValue(PRESET),
    update: jest.fn().mockResolvedValue(PRESET),
    findById: jest.fn().mockResolvedValue(PRESET),
    listByUser: jest.fn().mockResolvedValue([PRESET]),
    deleteById: jest.fn().mockResolvedValue(undefined),
  };
  const playlistRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'p1', userId: 'user-1', name: 'Mix' }) };
  const templateRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'tpl-1', userId: 'user-1' }) };
  const destinationRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'dest-1', userId: 'user-1' }) };
  const app = express();
  app.use(express.json());
  app.use('/stream-presets', createStreamPresetRouter(authService, repository, playlistRepository, templateRepository, destinationRepository));
  app.use(errorHandler);
  return { app, repository, playlistRepository, templateRepository, destinationRepository };
}

describe('stream preset routes', () => {
  it('creates a preset owned by the caller', async () => {
    const { app, repository } = buildApp();
    const res = await request(app).post('/stream-presets').send({
      name: 'Friday night', playlistId: 'p1', templateId: 'tpl-1', destinationIds: ['dest-1'],
    });
    expect(res.status).toBe(200);
    expect(repository.create).toHaveBeenCalledWith({
      userId: 'user-1', name: 'Friday night', playlistId: 'p1', templateId: 'tpl-1',
      destinationIds: ['dest-1'], title: null, description: null, privacyStatus: null, latencyPreference: null,
    });
    expect(res.body).toEqual(expect.objectContaining({ id: 'preset-1', name: 'Friday night', destinationIds: ['dest-1'] }));
  });

  // The old StreamSession required a non-empty destination list because a session existed only to
  // fan out to destinations. A preset does not: zero destinations is a valid, useful preset now.
  it('accepts a preset with no destinations at all', async () => {
    const { app, repository } = buildApp();
    const res = await request(app).post('/stream-presets').send({ name: 'Just the local stream', playlistId: 'p1' });
    expect(res.status).toBe(200);
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ destinationIds: [] }));
  });

  it.each([
    [{ playlistId: 'p1' }, 'name'],
    [{ name: '', playlistId: 'p1' }, 'empty name'],
    [{ name: 'x' }, 'playlistId'],
    [{ name: 'x', playlistId: 'p1', templateId: '' }, 'empty templateId'],
    [{ name: 'x', playlistId: 'p1', destinationIds: 'dest-1' }, 'non-array destinationIds'],
    [{ name: 'x', playlistId: 'p1', destinationIds: ['a', 'a'] }, 'duplicate destinationIds'],
    [{ name: 'x', playlistId: 'p1', privacyStatus: 'semi' }, 'bad privacyStatus'],
    [{ name: 'x', playlistId: 'p1', latencyPreference: 'instant' }, 'bad latencyPreference'],
  ])('rejects %j (%s)', async (body) => {
    const { app, repository } = buildApp();
    const res = await request(app).post('/stream-presets').send(body);
    expect(res.status).toBe(400);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('404s an unknown playlist and 403s someone else\'s', async () => {
    const { app, playlistRepository } = buildApp();
    playlistRepository.findById.mockResolvedValueOnce(null);
    expect((await request(app).post('/stream-presets').send({ name: 'x', playlistId: 'p1' })).status).toBe(404);
    playlistRepository.findById.mockResolvedValueOnce({ id: 'p1', userId: 'someone-else' });
    expect((await request(app).post('/stream-presets').send({ name: 'x', playlistId: 'p1' })).status).toBe(403);
  });

  it('403s a destination belonging to another user', async () => {
    const { app, destinationRepository } = buildApp();
    destinationRepository.findById.mockResolvedValueOnce({ id: 'dest-1', userId: 'someone-else' });
    const res = await request(app).post('/stream-presets').send({ name: 'x', playlistId: 'p1', destinationIds: ['dest-1'] });
    expect(res.status).toBe(403);
  });

  it('lists only the caller\'s presets', async () => {
    const { app, repository } = buildApp('user-9');
    const res = await request(app).get('/stream-presets');
    expect(res.status).toBe(200);
    expect(repository.listByUser).toHaveBeenCalledWith('user-9');
  });

  it('gets, updates and deletes a preset, refusing another user\'s', async () => {
    const { app, repository } = buildApp();
    expect((await request(app).get('/stream-presets/preset-1')).status).toBe(200);
    expect((await request(app).put('/stream-presets/preset-1').send({ name: 'New name', playlistId: 'p1' })).status).toBe(200);
    expect(repository.update).toHaveBeenCalledWith('preset-1', expect.objectContaining({ name: 'New name' }));
    expect((await request(app).delete('/stream-presets/preset-1')).status).toBe(200);

    repository.findById.mockResolvedValue({ ...PRESET, userId: 'someone-else' });
    expect((await request(app).get('/stream-presets/preset-1')).status).toBe(403);
    expect((await request(app).put('/stream-presets/preset-1').send({ name: 'x', playlistId: 'p1' })).status).toBe(403);
    expect((await request(app).delete('/stream-presets/preset-1')).status).toBe(403);
  });

  it('404s a preset that does not exist', async () => {
    const { app, repository } = buildApp();
    repository.findById.mockResolvedValue(null);
    expect((await request(app).get('/stream-presets/nope')).status).toBe(404);
  });

  it('requires authentication', async () => {
    const authService: any = { getCurrentUser: jest.fn().mockResolvedValue(null) };
    const app = express();
    app.use(express.json());
    app.use('/stream-presets', createStreamPresetRouter(authService, {} as never, {} as never, {} as never, {} as never));
    app.use(errorHandler);
    expect((await request(app).get('/stream-presets')).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/stream/streamPresetRoutes.test.ts`
Expected: FAIL — cannot find module `streamPresetRoutes`.

- [ ] **Step 3: Implement the repository**

```bash
git mv src/stream/streamSessionRepository.ts src/stream/streamPresetRepository.ts
```

Then replace its contents with:

```typescript
import { PrismaClient } from '@prisma/client';

/**
 * A saved PRESET: the playlist, overlay template, destination checklist and broadcast metadata to
 * pre-populate the next local-stream start with. It is not "the running thing" — that is the one
 * in-memory local stream per account (see LocalStreamManager).
 *
 * The Prisma models behind this are still called StreamSession/StreamSessionDestination, so that
 * repurposing them cost no table rename and no data migration. This file is the boundary where the
 * old name stops.
 */
export interface StreamPresetRecord {
  id: string;
  userId: string;
  name: string;
  playlistId: string;
  templateId: string | null;
  title: string | null;
  description: string | null;
  privacyStatus: string | null;
  latencyPreference: string | null;
  createdAt: Date;
  destinationIds: string[];
}

export interface StreamPresetInput {
  name: string;
  playlistId: string;
  templateId: string | null;
  destinationIds: string[];
  title: string | null;
  description: string | null;
  privacyStatus: string | null;
  latencyPreference: string | null;
}

type PrismaStreamPreset = {
  id: string;
  userId: string;
  name: string;
  playlistId: string;
  templateId: string | null;
  title: string | null;
  description: string | null;
  privacyStatus: string | null;
  latencyPreference: string | null;
  createdAt: Date;
  destinations: { destinationId: string }[];
};

function toRecord(row: PrismaStreamPreset): StreamPresetRecord {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    playlistId: row.playlistId,
    templateId: row.templateId,
    title: row.title,
    description: row.description,
    privacyStatus: row.privacyStatus,
    latencyPreference: row.latencyPreference,
    createdAt: row.createdAt,
    destinationIds: row.destinations.map((d) => d.destinationId),
  };
}

export class StreamPresetRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: StreamPresetInput & { userId: string }): Promise<StreamPresetRecord> {
    const row = await this.prisma.streamSession.create({
      data: {
        userId: data.userId,
        name: data.name,
        playlistId: data.playlistId,
        templateId: data.templateId,
        title: data.title,
        description: data.description,
        privacyStatus: data.privacyStatus,
        latencyPreference: data.latencyPreference,
        destinations: { create: data.destinationIds.map((destinationId) => ({ destinationId })) },
      },
      include: { destinations: true },
    });
    return toRecord(row);
  }

  // A full replace, matching PUT semantics: the destination checklist is deleted and rewritten
  // rather than diffed, so a preset never keeps a destination the caller left out.
  async update(id: string, data: StreamPresetInput): Promise<StreamPresetRecord> {
    const row = await this.prisma.streamSession.update({
      where: { id },
      data: {
        name: data.name,
        playlistId: data.playlistId,
        templateId: data.templateId,
        title: data.title,
        description: data.description,
        privacyStatus: data.privacyStatus,
        latencyPreference: data.latencyPreference,
        destinations: {
          deleteMany: {},
          create: data.destinationIds.map((destinationId) => ({ destinationId })),
        },
      },
      include: { destinations: true },
    });
    return toRecord(row);
  }

  async findById(id: string): Promise<StreamPresetRecord | null> {
    const row = await this.prisma.streamSession.findUnique({ where: { id }, include: { destinations: true } });
    return row ? toRecord(row) : null;
  }

  async listByUser(userId: string): Promise<StreamPresetRecord[]> {
    const rows = await this.prisma.streamSession.findMany({
      where: { userId },
      include: { destinations: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toRecord);
  }

  async deleteById(id: string): Promise<void> {
    await this.prisma.streamSession.deleteMany({ where: { id } });
  }
}
```

- [ ] **Step 4: Implement the routes**

Create `src/stream/streamPresetRoutes.ts`:

```typescript
import { Router } from 'express';
import { StreamPresetRecord, StreamPresetRepository, StreamPresetInput } from './streamPresetRepository';
import { PlaylistRepository } from '../playlists/playlistRepository';
import { TemplateRepository } from '../templates/templateRepository';
import { DestinationRepository } from '../destinations/destinationRepository';
import { ApiError } from '../errors';
import { wrapAsync } from '../api/errorHandler';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { AuthService } from '../auth/authService';

const PRIVACY_STATUSES = ['public', 'unlisted', 'private'];
const LATENCY_PREFERENCES = ['normal', 'low', 'ultraLow'];

function toPublicPreset(preset: StreamPresetRecord) {
  return {
    id: preset.id,
    name: preset.name,
    playlistId: preset.playlistId,
    templateId: preset.templateId,
    destinationIds: preset.destinationIds,
    title: preset.title,
    description: preset.description,
    privacyStatus: preset.privacyStatus,
    latencyPreference: preset.latencyPreference,
    createdAt: preset.createdAt,
  };
}

/**
 * CRUD for saved presets. Routes + repository with no manager in between, matching how every other
 * plain resource in this app is built (playlists, destinations, templates) — a preset triggers no
 * side effects at all, so there is nothing for a manager to orchestrate.
 */
export function createStreamPresetRouter(
  authService: AuthService,
  streamPresetRepository: Pick<StreamPresetRepository, 'create' | 'update' | 'findById' | 'listByUser' | 'deleteById'>,
  playlistRepository: Pick<PlaylistRepository, 'findById'>,
  templateRepository: Pick<TemplateRepository, 'findById'>,
  destinationRepository: Pick<DestinationRepository, 'findById'>,
): Router {
  const router = Router();
  const auth = requireAuth(authService);
  const userId = (req: AuthenticatedRequest) => req.user!.id;

  // Every referenced id must belong to the caller. Ids arriving in a request BODY that point at the
  // caller's own resources are validated here and answered 404/403 exactly like a path id would be
  // — a preset is a private object of the caller's, so there is no membership-leak concern of the
  // kind PUT /playlists/{id}/tracks has to 400 for.
  async function validate(body: unknown, callerId: string): Promise<StreamPresetInput> {
    const { name, playlistId, templateId, destinationIds, title, description, privacyStatus, latencyPreference } =
      (body ?? {}) as Record<string, unknown>;

    if (typeof name !== 'string' || name.trim().length === 0) throw new ApiError(400, 'body.name is required');
    if (typeof playlistId !== 'string' || playlistId.length === 0) throw new ApiError(400, 'body.playlistId is required');
    if (templateId !== undefined && templateId !== null && (typeof templateId !== 'string' || templateId.length === 0)) {
      throw new ApiError(400, 'body.templateId must be a non-empty string');
    }
    let ids: string[] = [];
    if (destinationIds !== undefined) {
      if (!Array.isArray(destinationIds) || destinationIds.some((id) => typeof id !== 'string' || id.length === 0)) {
        throw new ApiError(400, 'body.destinationIds must be an array of non-empty strings');
      }
      ids = destinationIds as string[];
      if (new Set(ids).size !== ids.length) throw new ApiError(400, 'body.destinationIds must not contain duplicates');
    }
    if (title !== undefined && title !== null && typeof title !== 'string') throw new ApiError(400, 'body.title must be a string');
    if (description !== undefined && description !== null && typeof description !== 'string') throw new ApiError(400, 'body.description must be a string');
    if (privacyStatus !== undefined && privacyStatus !== null && !PRIVACY_STATUSES.includes(privacyStatus as string)) {
      throw new ApiError(400, "body.privacyStatus must be 'public', 'unlisted', or 'private'");
    }
    if (latencyPreference !== undefined && latencyPreference !== null && !LATENCY_PREFERENCES.includes(latencyPreference as string)) {
      throw new ApiError(400, "body.latencyPreference must be 'normal', 'low', or 'ultraLow'");
    }

    const playlist = await playlistRepository.findById(playlistId);
    if (!playlist) throw new ApiError(404, 'playlist not found');
    if (playlist.userId !== callerId) throw new ApiError(403, 'not your playlist');

    if (typeof templateId === 'string') {
      const template = await templateRepository.findById(templateId);
      if (!template) throw new ApiError(404, 'template not found');
      if (template.userId !== callerId) throw new ApiError(403, 'not your template');
    }

    for (const destinationId of ids) {
      const destination = await destinationRepository.findById(destinationId);
      if (!destination) throw new ApiError(404, `destination not found: ${destinationId}`);
      if (destination.userId !== callerId) throw new ApiError(403, `not your destination: ${destinationId}`);
    }

    return {
      name: name.trim(),
      playlistId,
      templateId: typeof templateId === 'string' ? templateId : null,
      // Zero destinations is a valid preset: a local stream forwarded nowhere is a normal,
      // fully-supported way to run. The old StreamSession required a non-empty list because it only
      // existed to fan out to destinations.
      destinationIds: ids,
      title: typeof title === 'string' ? title : null,
      description: typeof description === 'string' ? description : null,
      privacyStatus: typeof privacyStatus === 'string' ? privacyStatus : null,
      latencyPreference: typeof latencyPreference === 'string' ? latencyPreference : null,
    };
  }

  async function requireOwned(id: string, callerId: string): Promise<StreamPresetRecord> {
    const preset = await streamPresetRepository.findById(id);
    if (!preset) throw new ApiError(404, 'stream preset not found');
    if (preset.userId !== callerId) throw new ApiError(403, 'not your stream preset');
    return preset;
  }

  router.post('/', auth, wrapAsync(async (req, res) => {
    const id = userId(req as AuthenticatedRequest);
    const input = await validate(req.body, id);
    res.status(200).json(toPublicPreset(await streamPresetRepository.create({ ...input, userId: id })));
  }));

  router.get('/', auth, wrapAsync(async (req, res) => {
    const presets = await streamPresetRepository.listByUser(userId(req as AuthenticatedRequest));
    res.status(200).json(presets.map(toPublicPreset));
  }));

  router.get('/:id', auth, wrapAsync(async (req, res) => {
    res.status(200).json(toPublicPreset(await requireOwned(req.params.id, userId(req as AuthenticatedRequest))));
  }));

  router.put('/:id', auth, wrapAsync(async (req, res) => {
    const id = userId(req as AuthenticatedRequest);
    const preset = await requireOwned(req.params.id, id);
    const input = await validate(req.body, id);
    res.status(200).json(toPublicPreset(await streamPresetRepository.update(preset.id, input)));
  }));

  router.delete('/:id', auth, wrapAsync(async (req, res) => {
    const preset = await requireOwned(req.params.id, userId(req as AuthenticatedRequest));
    await streamPresetRepository.deleteById(preset.id);
    res.status(200).json({});
  }));

  return router;
}
```

- [ ] **Step 5: Wire it up**

In `src/api/app.ts`: import `StreamPresetRepository` and `createStreamPresetRouter`, add
`streamPresetRepository: StreamPresetRepository` to `AppDeps`, and mount it after `/local-stream`:

```typescript
  app.use('/stream-presets', createStreamPresetRouter(deps.authService, deps.streamPresetRepository, deps.playlistRepository, deps.templateRepository, deps.destinationRepository));
```

In `src/server.ts`: `const streamPresetRepository = new StreamPresetRepository(prisma);` and pass it
into `createApp`. In `test/api/openapi.test.ts`, add `streamPresetRepository: {} as any` to the deps.

- [ ] **Step 6: Document it in OpenAPI**

Add to `src/api/openapi.ts`'s `paths` (after the `/local-stream/*` block):

```typescript
    '/stream-presets': {
      post: {
        summary: 'Save a named preset — playlist, overlay template, destination checklist and broadcast metadata — to pre-populate a future local-stream start with',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'playlistId'],
                properties: {
                  name: { type: 'string' },
                  playlistId: { type: 'string' },
                  templateId: { type: 'string', nullable: true },
                  destinationIds: { type: 'array', items: { type: 'string' }, description: 'May be empty: a preset that forwards nowhere is valid' },
                  title: { type: 'string', nullable: true },
                  description: { type: 'string', nullable: true },
                  privacyStatus: { type: 'string', enum: ['public', 'unlisted', 'private'], nullable: true },
                  latencyPreference: { type: 'string', enum: ['normal', 'low', 'ultraLow'], nullable: true },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Preset created', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamPreset' } } } },
          '400': { description: 'Missing/invalid name, playlistId, destinationIds or broadcast fields' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your playlist, template or destination' },
          '404': { description: 'Playlist, template or destination not found' },
        },
      },
      get: {
        summary: 'List the authenticated user\'s saved presets',
        responses: {
          '200': { description: 'Preset list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/StreamPreset' } } } } },
          '401': { description: 'Not authenticated' },
        },
      },
    },
    '/stream-presets/{id}': {
      get: {
        summary: 'Get one saved preset',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Preset', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamPreset' } } } },
          '401': { description: 'Not authenticated' }, '403': { description: 'Not your stream preset' }, '404': { description: 'Not found' },
        },
      },
      put: {
        summary: 'Replace a saved preset (the destination checklist is replaced, not merged)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamPreset' } } } },
        responses: {
          '200': { description: 'Preset updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamPreset' } } } },
          '400': { description: 'Missing/invalid fields' }, '401': { description: 'Not authenticated' },
          '403': { description: 'Not your stream preset' }, '404': { description: 'Not found' },
        },
      },
      delete: {
        summary: 'Delete a saved preset',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Preset deleted' }, '401': { description: 'Not authenticated' },
          '403': { description: 'Not your stream preset' }, '404': { description: 'Not found' },
        },
      },
    },
```

and the schema:

```typescript
      StreamPreset: {
        type: 'object',
        description: 'A saved choice, not a running thing: the playlist, template, destination checklist and broadcast metadata to pre-populate a local-stream start with.',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          playlistId: { type: 'string' },
          templateId: { type: 'string', nullable: true },
          destinationIds: { type: 'array', items: { type: 'string' } },
          title: { type: 'string', nullable: true },
          description: { type: 'string', nullable: true },
          privacyStatus: { type: 'string', nullable: true },
          latencyPreference: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
```

- [ ] **Step 7: Run everything**

Run: `npx jest && npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A src test
git commit -m "$(cat <<'EOF'
feat: repurpose StreamSession rows as saved presets at /stream-presets

A preset is a name plus the playlist, overlay template, destination checklist and
broadcast metadata to pre-populate the next local-stream start with — it no
longer represents anything that runs. Zero destinations is now a valid preset.
The Prisma model and table keep their old names so nothing was renamed in the
database; this repository is the boundary where the old name stops.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 10: Frontend API layer — the combined status type, the toggle, and presets

Additive only: nothing is deleted here, so the still-present legacy pages keep compiling until
Task 12 removes them together with their API client.

**Files:**
- Modify: `frontend/src/api/localStream.ts` (whole file), `frontend/src/api/localStream.test.ts`
- Modify: `frontend/src/hooks/useLocalStreamStatus.test.tsx` (fixtures only)
- Create: `frontend/src/api/streamPresets.ts`, `frontend/src/api/streamPresets.test.ts`

**Interfaces:**
- Consumes: the backend shapes from Tasks 6, 7 and 9.
- Produces (all from `frontend/src/api/localStream.ts` — it now **owns** the session-state union,
  which used to live in `api/streamSessions.ts`):
  - `type LocalSessionState = 'idle' | 'starting' | 'streaming' | 'paused' | 'error' | 'reconnecting'`
  - `type ForwardDesiredState = 'on' | 'off'`
  - `type ForwardActualState = 'off' | 'pending' | 'preparing' | 'connecting' | 'live' | 'stopping' | 'error'`
  - `interface ForwardProviderStatus`, `interface ForwardError`, `interface DestinationForwardStatus`
  - `interface LocalStreamState`, `interface LocalStreamStatus { local; destinations }`
  - `interface StartLocalStreamOptions`
  - `localStreamApi.setDestination(destinationId, desired): Promise<LocalStreamStatus>`
- Produces from `frontend/src/api/streamPresets.ts`:
  - `interface StreamPreset`, `interface StreamPresetInput`,
    `streamPresetsApi.{list,create,update,remove}`

- [ ] **Step 1: Write the failing tests**

Update `frontend/src/api/localStream.test.ts`'s `STATUS` fixture to the nested shape and add:

```typescript
const STATUS = {
  local: {
    state: 'streaming', currentTrack: 'a', nextTrack: 'b',
    previewReady: true, playlistId: 'p1', templateId: null, startedAt: '2026-09-14T10:00:00.000Z',
  },
  destinations: [],
};
```

```typescript
  it('starts a stream with pre-checked destinations and broadcast metadata', async () => {
    await localStreamApi.start({
      playlistId: 'p1', destinationIds: ['d1'], title: 'Late night', privacyStatus: 'unlisted',
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      playlistId: 'p1', destinationIds: ['d1'], title: 'Late night', privacyStatus: 'unlisted',
    });
  });

  it('PUTs a destination toggle', async () => {
    await localStreamApi.setDestination('dest-1', 'on');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/local-stream/destinations/dest-1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ desired: 'on' });
  });
```

Create `frontend/src/api/streamPresets.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { streamPresetsApi } from './streamPresets';

const fetchMock = vi.fn();
const PRESET = {
  id: 'preset-1', name: 'Friday night', playlistId: 'p1', templateId: null, destinationIds: ['d1'],
  title: null, description: null, privacyStatus: null, latencyPreference: null, createdAt: '2026-09-14T10:00:00.000Z',
};

describe('streamPresetsApi', () => {
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(PRESET) });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists presets', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([PRESET]) });
    await expect(streamPresetsApi.list()).resolves.toEqual([PRESET]);
    expect(fetchMock.mock.calls[0][0]).toContain('/stream-presets');
  });

  it('creates a preset', async () => {
    await streamPresetsApi.create({ name: 'Friday night', playlistId: 'p1', destinationIds: ['d1'] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/stream-presets');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ name: 'Friday night', playlistId: 'p1', destinationIds: ['d1'] });
  });

  it('updates and deletes by id', async () => {
    await streamPresetsApi.update('preset-1', { name: 'x', playlistId: 'p1' });
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
    await streamPresetsApi.remove('preset-1');
    expect(fetchMock.mock.calls[1][0]).toContain('/stream-presets/preset-1');
    expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/api/localStream.test.ts src/api/streamPresets.test.ts`
Expected: FAIL — `setDestination` is not a function; cannot resolve `./streamPresets`.

- [ ] **Step 3: Implement**

Replace `frontend/src/api/localStream.ts` in full:

```typescript
import { api, API_BASE_URL } from './client';

// Mirrors src/stream/localStreamManager.ts — kept in sync by hand, the way every other
// backend/frontend type pair in this project is. 'starting' exists only on this status payload: it
// means a start is in flight, so the UI never shows "idle" mid-start.
export type LocalSessionState = 'idle' | 'starting' | 'streaming' | 'paused' | 'error' | 'reconnecting';

export type ForwardDesiredState = 'on' | 'off';
// 'pending' = the user wants this destination but nothing is publishing locally yet, so NOTHING has
// happened on the platform's side. 'connecting' = the relay is running but the destination has not
// confirmed it; for YouTube that legitimately takes 10-40s and the UI must say so rather than look
// stuck, or people double-toggle and burn API quota.
export type ForwardActualState = 'off' | 'pending' | 'preparing' | 'connecting' | 'live' | 'stopping' | 'error';
export type ForwardErrorReason = 'auth' | 'provider' | 'relay' | 'source';

export interface ForwardProviderStatus {
  type: string;
  phase: string;
  // The channel's stable /live link — it survives every toggle, unlike a per-broadcast watch URL.
  watchUrl: string | null;
}

export interface ForwardError {
  reason: ForwardErrorReason;
  message: string;
}

export interface DestinationForwardStatus {
  destinationId: string;
  name: string;
  desired: ForwardDesiredState;
  state: ForwardActualState;
  provider?: ForwardProviderStatus;
  error?: ForwardError;
}

export interface LocalStreamState {
  state: LocalSessionState;
  currentTrack: string | null;
  nextTrack: string | null;
  // True while the encoder is publishing, INCLUDING while paused — pausing swaps the audio to
  // silence and never interrupts the local publish, so the preview stays watchable.
  previewReady: boolean;
  playlistId: string | null;
  templateId: string | null;
  startedAt: string | null;
}

// One local stream plus 0..N independently toggleable destinations. An empty `destinations` array
// is a normal running state, not an error — the stream runs and previews with nothing forwarded.
export interface LocalStreamStatus {
  local: LocalStreamState;
  destinations: DestinationForwardStatus[];
}

export interface StartLocalStreamOptions {
  playlistId: string;
  templateId?: string;
  // Destinations to switch on as soon as the stream is publishing. Optional and possibly empty.
  destinationIds?: string[];
  // Broadcast metadata for destinations that create a live broadcast (YouTube). Ignored by custom
  // RTMP destinations.
  title?: string;
  description?: string;
  privacyStatus?: 'public' | 'unlisted' | 'private';
  latencyPreference?: 'normal' | 'low' | 'ultraLow';
}

export const localStreamApi = {
  status: () => api.get<LocalStreamStatus>('/local-stream/status'),
  start: (opts: StartLocalStreamOptions) => api.post<LocalStreamStatus>('/local-stream/start', opts),
  stop: () => api.post<LocalStreamStatus>('/local-stream/stop'),
  pause: () => api.post<LocalStreamStatus>('/local-stream/pause'),
  resume: () => api.post<LocalStreamStatus>('/local-stream/resume'),
  next: () => api.post<LocalStreamStatus>('/local-stream/next'),
  previous: () => api.post<LocalStreamStatus>('/local-stream/previous'),
  play: (name: string) => api.post<LocalStreamStatus>('/local-stream/play', { name }),
  // The checkbox. Idempotent, and valid even with nothing running — the forward then waits at
  // 'pending' for the next start.
  setDestination: (destinationId: string, desired: ForwardDesiredState) =>
    api.put<LocalStreamStatus>(`/local-stream/destinations/${destinationId}`, { desired }),
  eventsUrl: () => `${API_BASE_URL}/local-stream/events`,
  // Absolute, because hls.js loads it itself rather than going through the `api` wrapper. The
  // backend resolves which stream this is from the session cookie — there is no id in this URL by
  // design.
  previewUrl: () => `${API_BASE_URL}/local-stream/preview/index.m3u8`,
};
```

Create `frontend/src/api/streamPresets.ts`:

```typescript
import { api } from './client';

// A saved choice, not a running thing: what to pre-populate the start form with. Mirrors
// src/stream/streamPresetRoutes.ts's toPublicPreset.
export interface StreamPreset {
  id: string;
  name: string;
  playlistId: string;
  templateId: string | null;
  destinationIds: string[];
  title: string | null;
  description: string | null;
  privacyStatus: 'public' | 'unlisted' | 'private' | null;
  latencyPreference: 'normal' | 'low' | 'ultraLow' | null;
  createdAt: string;
}

export interface StreamPresetInput {
  name: string;
  playlistId: string;
  templateId?: string | null;
  destinationIds?: string[];
  title?: string | null;
  description?: string | null;
  privacyStatus?: 'public' | 'unlisted' | 'private' | null;
  latencyPreference?: 'normal' | 'low' | 'ultraLow' | null;
}

export const streamPresetsApi = {
  list: () => api.get<StreamPreset[]>('/stream-presets'),
  create: (input: StreamPresetInput) => api.post<StreamPreset>('/stream-presets', input),
  update: (id: string, input: StreamPresetInput) => api.put<StreamPreset>(`/stream-presets/${id}`, input),
  remove: (id: string) => api.delete<Record<string, never>>(`/stream-presets/${id}`),
};
```

Update `frontend/src/hooks/useLocalStreamStatus.test.tsx`'s status fixtures to the nested shape
(the hook itself needs no change — it already stores whatever `localStreamApi.status()` returns).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/api src/hooks`
Expected: PASS.

**Do NOT run `npm run build` (or any other full `tsc -b`) as this task's gate.** It will fail —
correctly, not as a sign this task did something wrong. `frontend/src/pages/LocalStream.tsx` (not
deleted until Task 12) reads the OLD flat status shape (`status.state`, `.currentTrack`,
`.nextTrack`, `.previewReady`) that `localStream.ts` no longer exports once this task's
`{local, destinations}` shape lands, and `package.json`'s `"build": "tsc -b && vite build"` type-
checks the whole project, `LocalStream.tsx` included. This is a genuinely broken intermediate state
between Task 10 and Task 12's page swap, not a claim that this task is "additive only" all the way
down — the API surface is additive (nothing existing callers relied on is removed), but its own
type shape is not backward-compatible with the ONE remaining consumer of the old shape, and that
consumer is deliberately Task 12's problem to remove, not this task's to patch around. The
project-wide clean-build gate returns in Task 12's own Step 6 ("Run the frontend suite and build"),
once `LocalStream.tsx` is gone.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api frontend/src/hooks
git commit -m "$(cat <<'EOF'
feat(frontend): combined local-stream status, destination toggle and preset APIs

localStream.ts now owns the session-state union and carries the
{local, destinations[]} payload plus setDestination; streamPresets.ts is the
client for the repurposed saved presets.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: `DestinationToggles` — the destination checklist

Spec, decision (d) in the addendum: "destinations appear as toggleable cards/checkboxes with their
own status (state, provider phase, watch URL, error) rather than being a separate 'start a session
against N destinations' flow."

The component renders **one card per destination the user owns** (from `GET /destinations`) and
merges the forward status in by id. A destination with no forward entry is simply off — the backend
prunes inactive forwards, so absence is the normal representation of "not forwarded".

**Files:**
- Create: `frontend/src/components/DestinationToggles.tsx`
- Test: `frontend/src/components/DestinationToggles.test.tsx`
- Modify: `frontend/src/i18n/locales/{en,ru,uk}.json` (new `forwardState` + `stream.destinations*`
  keys — added here, with the rest of the `stream` section landing in Task 12)

**Interfaces:**
- Consumes: `Destination` (`frontend/src/api/destinations.ts`), `DestinationForwardStatus`,
  `ForwardDesiredState` (Task 10).
- Produces:
  - `interface DestinationTogglesProps { destinations: Destination[]; forwards: DestinationForwardStatus[]; onToggle: (destinationId: string, desired: ForwardDesiredState) => void; disabled?: boolean }`
  - `function DestinationToggles(props: DestinationTogglesProps): JSX.Element`

- [ ] **Step 1: Add the locale keys**

In each of `frontend/src/i18n/locales/{en,ru,uk}.json`, add a `forwardState` section (translate the
values for `ru`/`uk`; keys and order identical in all three):

```json
  "forwardState": {
    "off": "not forwarded",
    "pending": "will start with the stream",
    "preparing": "preparing…",
    "connecting": "connecting…",
    "live": "live",
    "stopping": "stopping…",
    "error": "error"
  },
```

No `stream` section exists in any locale file yet at this point in the plan (the nearest today are
`streams`, `localStream`, `startStreamDrawer`) — create a NEW `stream` section now, containing
exactly these keys (Task 12 fills in the rest of that same section later, in the order given
there):

```json
    "destinationsTitle": "Destinations",
    "destinationsHelp": "Toggle a destination on or off at any time. The stream itself never stops.",
    "noDestinations": "No destinations yet.",
    "watchLink": "Open watch page",
    "connectingHelp": "Going live on a platform takes 10-40 seconds. Toggling again will not make it faster.",
    "youtubeToggleWarning": "Each time you switch this on, YouTube starts a brand-new broadcast: chat, viewer count and likes reset, and switching off leaves another recording on your channel. The link above always points at whatever you are broadcasting now.",
```

Russian (`ru.json`), same keys, same order:

```json
    "destinationsTitle": "Площадки",
    "destinationsHelp": "Включайте и выключайте площадки в любой момент. Сам стрим при этом не прерывается.",
    "noDestinations": "Площадок пока нет.",
    "watchLink": "Открыть страницу трансляции",
    "connectingHelp": "Выход в эфир на площадке занимает 10-40 секунд. Повторное переключение это не ускорит.",
    "youtubeToggleWarning": "Каждое включение создаёт на YouTube новую трансляцию: чат, счётчик зрителей и лайки обнуляются, а после выключения на канале остаётся ещё одна запись. Ссылка выше всегда ведёт на то, что вы транслируете сейчас.",
```

Ukrainian (`uk.json`):

```json
    "destinationsTitle": "Майданчики",
    "destinationsHelp": "Вмикайте та вимикайте майданчики будь-коли. Сам стрім при цьому не переривається.",
    "noDestinations": "Майданчиків поки немає.",
    "watchLink": "Відкрити сторінку трансляції",
    "connectingHelp": "Вихід в ефір на майданчику триває 10-40 секунд. Повторне перемикання це не пришвидшить.",
    "youtubeToggleWarning": "Кожне ввімкнення створює на YouTube нову трансляцію: чат, лічильник глядачів і вподобання скидаються, а після вимкнення на каналі лишається ще один запис. Посилання вище завжди веде на те, що ви транслюєте зараз.",
```

And `forwardState` for `ru`/`uk`:

```json
  "forwardState": {
    "off": "не транслируется",
    "pending": "начнётся вместе со стримом",
    "preparing": "подготовка…",
    "connecting": "подключение…",
    "live": "в эфире",
    "stopping": "остановка…",
    "error": "ошибка"
  },
```

```json
  "forwardState": {
    "off": "не транслюється",
    "pending": "почнеться разом зі стрімом",
    "preparing": "підготовка…",
    "connecting": "підключення…",
    "live": "в ефірі",
    "stopping": "зупинка…",
    "error": "помилка"
  },
```

- [ ] **Step 2: Write the failing test**

Create `frontend/src/components/DestinationToggles.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DestinationToggles } from './DestinationToggles';
import { renderWithProviders } from '../test/renderWithProviders';

const DESTINATIONS = [
  { id: 'd1', name: 'My channel', rtmpUrl: null, provider: 'youtube' },
  { id: 'd2', name: 'Twitch', rtmpUrl: 'rtmp://live.twitch.tv/app', provider: 'custom' },
];

describe('DestinationToggles', () => {
  it('renders one card per destination, off by default', () => {
    renderWithProviders(<DestinationToggles destinations={DESTINATIONS} forwards={[]} onToggle={vi.fn()} />);
    expect(screen.getByLabelText('My channel')).not.toBeChecked();
    expect(screen.getByLabelText('Twitch')).not.toBeChecked();
    expect(screen.getAllByText('not forwarded')).toHaveLength(2);
  });

  it('reflects a forward\'s desired and actual state', () => {
    renderWithProviders(
      <DestinationToggles
        destinations={DESTINATIONS}
        forwards={[{ destinationId: 'd1', name: 'My channel', desired: 'on', state: 'connecting' }]}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('My channel')).toBeChecked();
    expect(screen.getByText('connecting…')).toBeInTheDocument();
    // Honest about how long a platform takes, so nobody double-toggles and burns API quota.
    expect(screen.getByText('Going live on a platform takes 10-40 seconds. Toggling again will not make it faster.')).toBeInTheDocument();
  });

  // Toggling on before anything is running is legal and has no platform-side effect at all — the UI
  // has to say that rather than look like it failed.
  it('explains a pending forward', () => {
    renderWithProviders(
      <DestinationToggles
        destinations={DESTINATIONS}
        forwards={[{ destinationId: 'd2', name: 'Twitch', desired: 'on', state: 'pending' }]}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText('will start with the stream')).toBeInTheDocument();
  });

  it('shows the provider phase, the watch link and an error', () => {
    renderWithProviders(
      <DestinationToggles
        destinations={DESTINATIONS}
        forwards={[{
          destinationId: 'd1', name: 'My channel', desired: 'on', state: 'error',
          provider: { type: 'youtube', phase: 'error', watchUrl: 'https://www.youtube.com/channel/UC1/live' },
          error: { reason: 'auth', message: 'invalid_grant' },
        }]}
        onToggle={vi.fn()}
      />,
    );
    // The BADGE renders forwardState.error's own locale value ("error"), not a decorated string.
    // "🔴 Error" IS a real string elsewhere (streamPhase.error, used for a DIFFERENT phase label),
    // but this fixture's provider.phase is 'error' and DestinationToggles renders the badge from
    // forwardState[state], not from streamPhase — getByText('error') is what this component
    // actually produces for this fixture, and (per testing-library's getNodeText, which reads only
    // direct text children) is unambiguous here even though "🔴 Error" also contains the substring.
    expect(screen.getByText('error')).toBeInTheDocument();
    expect(screen.getByText('invalid_grant')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open watch page' })).toHaveAttribute('href', 'https://www.youtube.com/channel/UC1/live');
  });

  it('calls onToggle with the opposite intent', async () => {
    const onToggle = vi.fn();
    renderWithProviders(
      <DestinationToggles
        destinations={DESTINATIONS}
        forwards={[{ destinationId: 'd1', name: 'My channel', desired: 'on', state: 'live' }]}
        onToggle={onToggle}
      />,
    );
    await userEvent.click(screen.getByLabelText('My channel'));
    expect(onToggle).toHaveBeenCalledWith('d1', 'off');
    await userEvent.click(screen.getByLabelText('Twitch'));
    expect(onToggle).toHaveBeenCalledWith('d2', 'on');
  });

  it('renders an empty state when the user owns no destinations', () => {
    renderWithProviders(<DestinationToggles destinations={[]} forwards={[]} onToggle={vi.fn()} />);
    expect(screen.getByText('No destinations yet.')).toBeInTheDocument();
  });

  // The spec requires the YouTube consequences of repeated toggling to be visible in the UI copy,
  // not buried in a design doc.
  it('warns that each YouTube toggle starts a brand-new broadcast', () => {
    renderWithProviders(
      <DestinationToggles
        destinations={DESTINATIONS}
        forwards={[
          { destinationId: 'd1', name: 'My channel', desired: 'on', state: 'live' },
          { destinationId: 'd2', name: 'Twitch', desired: 'on', state: 'live' },
        ]}
        onToggle={vi.fn()}
      />,
    );
    // Once — for the YouTube destination only; a custom RTMP destination has no broadcast concept.
    expect(screen.getAllByText(/brand-new broadcast/)).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/components/DestinationToggles.test.tsx`
Expected: FAIL — cannot resolve `./DestinationToggles`.

- [ ] **Step 4: Implement**

Create `frontend/src/components/DestinationToggles.tsx`:

```tsx
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Destination } from '../api/destinations';
import { DestinationForwardStatus, ForwardActualState, ForwardDesiredState } from '../api/localStream';

const STATE_BADGE: Record<ForwardActualState, string> = {
  off: 'bg-gray-100 text-gray-600',
  pending: 'bg-blue-100 text-blue-700',
  preparing: 'bg-yellow-100 text-yellow-700',
  connecting: 'bg-yellow-100 text-yellow-700',
  live: 'bg-green-100 text-green-700',
  stopping: 'bg-orange-100 text-orange-700',
  error: 'bg-red-100 text-red-700',
};

export interface DestinationTogglesProps {
  // Every destination the user owns — the checklist is over these, not over the forwards. A
  // destination with no forward entry is simply off: the backend prunes forwards that want nothing
  // and hold nothing, so absence IS the representation of "not forwarded".
  destinations: Destination[];
  forwards: DestinationForwardStatus[];
  onToggle: (destinationId: string, desired: ForwardDesiredState) => void;
  disabled?: boolean;
}

export function DestinationToggles({ destinations, forwards, onToggle, disabled }: DestinationTogglesProps) {
  const { t } = useTranslation();
  const byId = new Map(forwards.map((forward) => [forward.destinationId, forward]));

  const phaseLabels: Record<string, string> = {
    creating: t('streamPhase.creating'),
    waitingForYoutube: t('streamPhase.waitingForYoutube'),
    live: t('streamPhase.live'),
    complete: t('streamPhase.complete'),
    error: t('streamPhase.error'),
  };

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">{t('stream.destinationsTitle')}</h2>
        <Link to="/destinations" className="text-xs underline">{t('sidebar.destinations')}</Link>
      </div>
      <p className="mt-1 text-xs text-gray-500">{t('stream.destinationsHelp')}</p>

      {destinations.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500">{t('stream.noDestinations')}</p>
      ) : (
        <ul className="mt-3 divide-y rounded border">
          {destinations.map((destination) => {
            const forward = byId.get(destination.id);
            const state: ForwardActualState = forward?.state ?? 'off';
            const checked = forward?.desired === 'on';
            return (
              <li key={destination.id} className="p-3">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id={`forward-${destination.id}`}
                    checked={checked}
                    disabled={disabled}
                    onChange={() => onToggle(destination.id, checked ? 'off' : 'on')}
                  />
                  {/* The provider name is deliberately OUTSIDE the <label>: it would otherwise be
                      part of the checkbox's accessible name ("My channel (youtube)"), which is both
                      noisier for a screen reader and a needless coupling for every test that finds
                      a destination by name. */}
                  <label htmlFor={`forward-${destination.id}`} className="flex-1 text-sm">{destination.name}</label>
                  <span className="text-xs text-gray-500">({destination.provider})</span>
                  <span className={`rounded px-2 py-0.5 text-xs ${STATE_BADGE[state]}`}>
                    {t(`forwardState.${state}`)}
                  </span>
                </div>

                {/* Toggling on is not instant: a platform needs 10-40s to create the broadcast,
                    detect the ingest and transition to live. Saying so is what stops people
                    double-toggling and burning ~330 API quota units per cycle. */}
                {(state === 'preparing' || state === 'connecting') && (
                  <p className="mt-1 text-xs text-gray-500">{t('stream.connectingHelp')}</p>
                )}

                {/* The spec requires the YouTube consequences to be visible in the UI copy, not just
                    in a design doc: each toggle-on is a brand-new broadcast, so the chat, the
                    concurrent-viewer count and the likes all reset, and each toggle-off leaves
                    another archived VOD on the channel. */}
                {destination.provider === 'youtube' && checked && (
                  <p className="mt-1 text-xs text-gray-500">{t('stream.youtubeToggleWarning')}</p>
                )}

                {forward?.provider && (
                  <div className="mt-1 text-xs text-gray-600">
                    {phaseLabels[forward.provider.phase] ?? forward.provider.phase}
                    {forward.provider.watchUrl && (
                      <a href={forward.provider.watchUrl} target="_blank" rel="noreferrer" className="ml-2 underline">
                        {t('stream.watchLink')}
                      </a>
                    )}
                  </div>
                )}

                {forward?.error && <p className="mt-1 text-xs text-red-600">{forward.error.message}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/components/DestinationToggles.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/DestinationToggles.tsx frontend/src/components/DestinationToggles.test.tsx frontend/src/i18n
git commit -m "$(cat <<'EOF'
feat(frontend): add the destination toggle checklist

One card per destination the user owns, merged with its forward status: desired
intent, actual state, provider phase, stable watch link and error. Says out loud
that going live takes 10-40s, so nobody double-toggles and burns API quota.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 12: One stream page, and the death of the session UI

Addendum decision (d): "merge the Local Stream page and the legacy Streams/session views into ONE
view centered on the local stream — you start/control the one local stream, and destinations appear
as toggleable cards/checkboxes with their own status."

**Files:**
- Create: `frontend/src/pages/Stream.tsx`, `frontend/src/pages/Stream.test.tsx`
- Delete: `frontend/src/pages/Streams.tsx`, `frontend/src/pages/Streams.test.tsx`,
  `frontend/src/pages/StreamSessionPanel.tsx`, `frontend/src/pages/StreamSessionPanel.test.tsx`,
  `frontend/src/pages/LocalStream.tsx`, `frontend/src/pages/LocalStream.test.tsx`,
  `frontend/src/components/StartStreamDrawer.tsx`,
  `frontend/src/components/StartStreamDrawer.test.tsx`,
  `frontend/src/api/streamSessions.ts`, `frontend/src/hooks/useStreamSessionStatus.ts`,
  `frontend/src/hooks/useStreamSessionStatus.test.tsx`
- Modify: `frontend/src/App.tsx`, `frontend/src/components/Sidebar.tsx` (+ its test),
  `frontend/src/i18n/locales/{en,ru,uk}.json`

**Interfaces:**
- Consumes: `localStreamApi` + its types and `useLocalStreamStatus` (Task 10), `streamPresetsApi`
  (Task 10), `DestinationToggles` (Task 11), the unchanged `HlsPlayer`, `playlistsApi`,
  `templatesApi`, `destinationsApi`.
- Produces: the default-exported `Stream` page component at route `/stream`; three redirects; one
  sidebar entry.

- [ ] **Step 1: Rewrite the locale sections**

In each of `frontend/src/i18n/locales/{en,ru,uk}.json`:

(a) delete the `streams`, `startStreamDrawer`, `streamSessionPanel`, `destinationPanel` and
`localStream` sections entirely (`destinationPanel` was already dead except for one watch-link
label, which moved to `stream.watchLink` in Task 11);

(b) add `"starting"` to the existing `streamState` section, between `idle` and `streaming`:
`en` → `"starting"`, `ru` → `"запускается"`, `uk` → `"запускається"`;

(c) replace the `sidebar.streams` + `sidebar.localStream` pair with a single `"stream"`:
`en` → `"Stream"`, `ru` → `"Стрим"`, `uk` → `"Стрім"`;

(d) write the full `stream` section. **Most of these strings already exist, translated, in the
sections being deleted** — `localStream.*` (title/subtitle/playlist/template/transport/preview),
`startStreamDrawer.*` (the whole YouTube metadata block, `manageTemplates`, `selectPlaylist`,
`noTemplate`) and `streamSessionPanel.nowPlayingNext`. **Move those `ru`/`uk` values across rather
than re-translating them**, and take the Task 11 keys' `ru`/`uk` values from Task 11. That leaves
only these genuinely new keys to translate; their values are given here so nothing is left to
invent:

| key | ru | uk |
| --- | --- | --- |
| `title` | Стрим | Стрім |
| `subtitle` | Одно кодирование, работающее на этом сервере. Смотрите его здесь и включайте или выключайте площадки, ни разу не прерывая стрим. | Одне кодування, що працює на цьому сервері. Дивіться його тут і вмикайте або вимикайте майданчики, жодного разу не перериваючи стрім. |
| `presetLabel` | Начать из пресета | Почати з пресета |
| `noPreset` | Без пресета | Без пресета |
| `applyPreset` | Применить | Застосувати |
| `savePresetTitle` | Сохранить эти настройки как пресет | Зберегти ці налаштування як пресет |
| `presetNamePlaceholder` | Название пресета | Назва пресета |
| `savePreset` | Сохранить пресет | Зберегти пресет |
| `presetSaved` | Пресет сохранён | Пресет збережено |
| `presetSaveFailed` | Не удалось сохранить пресет | Не вдалося зберегти пресет |
| `startButton` | Запустить стрим | Запустити стрім |
| `startFailed` | Не удалось запустить стрим | Не вдалося запустити стрім |
| `toggleFailed` | Не удалось переключить эту площадку | Не вдалося перемкнути цей майданчик |
| `noDestinationsNotice` | Никуда не транслируется — стрим только локальный. Это совершенно нормальный режим работы. | Нікуди не транслюється — стрім лише локальний. Це цілком нормальний режим роботи. |

English, in the exact key order all three files must use (the Task 11 keys are folded in here in
their final position):

```json
  "stream": {
    "title": "Stream",
    "subtitle": "One encode, running on this server. Watch it here, and switch destinations on or off without ever interrupting it.",
    "presetLabel": "Start from a preset",
    "noPreset": "No preset",
    "applyPreset": "Apply",
    "savePresetTitle": "Save these settings as a preset",
    "presetNamePlaceholder": "Preset name",
    "savePreset": "Save preset",
    "presetSaved": "Preset saved",
    "presetSaveFailed": "Failed to save the preset",
    "playlistLabel": "Playlist",
    "selectPlaylist": "Select a playlist…",
    "templateLabel": "Overlay template",
    "noTemplate": "No template (default look)",
    "manageTemplates": "Manage templates",
    "startButton": "Start stream",
    "starting": "Starting…",
    "startFailed": "Failed to start the stream",
    "commandFailed": "The command failed",
    "toggleFailed": "Failed to change that destination",
    "previous": "⏮ Previous",
    "pause": "⏸ Pause",
    "resume": "▶ Resume",
    "next": "⏭ Next",
    "stop": "⏹ Stop",
    "nowPlayingNext": "Now playing: {{track}} · Next: {{next}}",
    "previewStarting": "Preview is starting…",
    "previewUnsupported": "Your browser cannot play this preview.",
    "noDestinationsNotice": "Nothing is being forwarded — this stream is local only. That is a perfectly normal way to run it.",
    "destinationsTitle": "Destinations",
    "destinationsHelp": "Toggle a destination on or off at any time. The stream itself never stops.",
    "noDestinations": "No destinations yet.",
    "watchLink": "Open watch page",
    "connectingHelp": "Going live on a platform takes 10-40 seconds. Toggling again will not make it faster.",
    "youtubeToggleWarning": "Each time you switch this on, YouTube starts a brand-new broadcast: chat, viewer count and likes reset, and switching off leaves another recording on your channel. The link above always points at whatever you are broadcasting now.",
    "youtubeHelp": "Broadcast details for any YouTube destination you switch on during this stream.",
    "titlePlaceholder": "Title (optional — defaults to playlist name)",
    "descriptionPlaceholder": "Description (optional)",
    "privacyLabel": "Privacy",
    "private": "Private",
    "unlisted": "Unlisted",
    "public": "Public",
    "latencyLabel": "Stream latency",
    "latencyNormal": "Normal (~20-40s delay, most reliable)",
    "latencyLow": "Low (~5-10s delay)",
    "latencyUltraLow": "Ultra-low (~2-5s delay, least buffering headroom)",
    "latencyHelp": "Lower latency means viewers see track changes almost immediately, at the cost of some playback stability on slow connections."
  },
```

- [ ] **Step 2: Write the failing page test**

Create `frontend/src/pages/Stream.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Stream from './Stream';
import { useLocalStreamStatus } from '../hooks/useLocalStreamStatus';
import { localStreamApi, LocalStreamStatus } from '../api/localStream';
import { streamPresetsApi } from '../api/streamPresets';
import { playlistsApi } from '../api/playlists';
import { templatesApi } from '../api/templates';
import { destinationsApi } from '../api/destinations';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../hooks/useLocalStreamStatus');
vi.mock('../api/localStream');
vi.mock('../api/streamPresets');
vi.mock('../api/playlists');
vi.mock('../api/templates');
vi.mock('../api/destinations');
vi.mock('../components/HlsPlayer', () => ({
  HlsPlayer: ({ src }: { src: string }) => <div data-testid="hls-player">{src}</div>,
}));

const IDLE: LocalStreamStatus = {
  local: {
    state: 'idle', currentTrack: null, nextTrack: null,
    previewReady: false, playlistId: null, templateId: null, startedAt: null,
  },
  destinations: [],
};

const LIVE: LocalStreamStatus = {
  local: {
    state: 'streaming', currentTrack: 'Track A', nextTrack: 'Track B',
    previewReady: true, playlistId: 'p1', templateId: null, startedAt: '2026-09-14T10:00:00.000Z',
  },
  destinations: [],
};

function mockStatus(data: LocalStreamStatus) {
  vi.mocked(useLocalStreamStatus).mockReturnValue({ data } as never);
}

describe('Stream page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(playlistsApi.list).mockResolvedValue([{ id: 'p1', name: 'Friday Mix' }]);
    vi.mocked(templatesApi.list).mockResolvedValue([{ id: 'tpl-1', name: 'Neon' }] as never);
    vi.mocked(destinationsApi.list).mockResolvedValue([
      { id: 'd1', name: 'My channel', rtmpUrl: null, provider: 'youtube' },
    ]);
    vi.mocked(streamPresetsApi.list).mockResolvedValue([]);
    vi.mocked(localStreamApi.previewUrl).mockReturnValue('http://api/local-stream/preview/index.m3u8');
  });

  it('shows the start form and no player when nothing is running', async () => {
    mockStatus(IDLE);
    renderWithProviders(<Stream />);
    expect(await screen.findByLabelText('Playlist')).toBeInTheDocument();
    expect(screen.queryByTestId('hls-player')).not.toBeInTheDocument();
  });

  // While idle the checklist is local form state: ticking a box must not hit the network, and the
  // ticked ids ride along with the start call.
  it('starts with the destinations ticked before starting', async () => {
    mockStatus(IDLE);
    vi.mocked(localStreamApi.start).mockResolvedValue(LIVE);
    renderWithProviders(<Stream />);
    await screen.findByText('Friday Mix');
    await userEvent.selectOptions(screen.getByLabelText('Playlist'), 'p1');
    await userEvent.click(await screen.findByLabelText('My channel'));
    expect(localStreamApi.setDestination).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    await waitFor(() => expect(localStreamApi.start).toHaveBeenCalledWith(expect.objectContaining({
      playlistId: 'p1', destinationIds: ['d1'],
    })));
  });

  it('starts with no destinations at all', async () => {
    mockStatus(IDLE);
    vi.mocked(localStreamApi.start).mockResolvedValue(LIVE);
    renderWithProviders(<Stream />);
    await screen.findByText('Friday Mix');
    await userEvent.selectOptions(screen.getByLabelText('Playlist'), 'p1');
    await userEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    await waitFor(() => expect(localStreamApi.start).toHaveBeenCalledWith(expect.objectContaining({
      playlistId: 'p1', destinationIds: [],
    })));
  });

  it('only offers the YouTube broadcast fields when a YouTube destination is ticked', async () => {
    mockStatus(IDLE);
    renderWithProviders(<Stream />);
    await screen.findByText('Friday Mix');
    expect(screen.queryByLabelText('Privacy')).not.toBeInTheDocument();
    await userEvent.click(await screen.findByLabelText('My channel'));
    expect(await screen.findByLabelText('Privacy')).toBeInTheDocument();
  });

  it('renders the transport controls and player while running', async () => {
    mockStatus(LIVE);
    renderWithProviders(<Stream />);
    expect(await screen.findByTestId('hls-player')).toHaveTextContent('http://api/local-stream/preview/index.m3u8');
    expect(screen.getByText('Now playing: Track A · Next: Track B')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '⏹ Stop' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Playlist')).not.toBeInTheDocument();
  });

  // Zero destinations is a fully valid running state — the page must say so, not look broken.
  it('says plainly that nothing is being forwarded', async () => {
    mockStatus(LIVE);
    renderWithProviders(<Stream />);
    expect(await screen.findByText(/Nothing is being forwarded/)).toBeInTheDocument();
  });

  it('toggles a destination through the API while running, without stopping the stream', async () => {
    mockStatus(LIVE);
    vi.mocked(localStreamApi.setDestination).mockResolvedValue(LIVE);
    renderWithProviders(<Stream />);
    await userEvent.click(await screen.findByLabelText('My channel'));
    await waitFor(() => expect(localStreamApi.setDestination).toHaveBeenCalledWith('d1', 'on'));
    expect(localStreamApi.stop).not.toHaveBeenCalled();
  });

  it.each([
    ['⏮ Previous', 'previous'], ['⏸ Pause', 'pause'], ['⏭ Next', 'next'], ['⏹ Stop', 'stop'],
  ] as const)('sends %s to the backend', async (label, method) => {
    mockStatus(LIVE);
    vi.mocked(localStreamApi[method]).mockResolvedValue(LIVE);
    renderWithProviders(<Stream />);
    await userEvent.click(await screen.findByRole('button', { name: label }));
    await waitFor(() => expect(localStreamApi[method]).toHaveBeenCalled());
  });

  it('offers Resume instead of Pause while paused', async () => {
    mockStatus({ ...LIVE, local: { ...LIVE.local, state: 'paused' } });
    vi.mocked(localStreamApi.resume).mockResolvedValue(LIVE);
    renderWithProviders(<Stream />);
    await userEvent.click(await screen.findByRole('button', { name: '▶ Resume' }));
    await waitFor(() => expect(localStreamApi.resume).toHaveBeenCalled());
  });

  it('shows a starting state rather than the start form while a start is in flight', async () => {
    mockStatus({ ...IDLE, local: { ...IDLE.local, state: 'starting' } });
    renderWithProviders(<Stream />);
    expect(await screen.findByText('starting')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start stream' })).not.toBeInTheDocument();
  });

  it('applies a preset into the form', async () => {
    mockStatus(IDLE);
    vi.mocked(streamPresetsApi.list).mockResolvedValue([{
      id: 'preset-1', name: 'Friday night', playlistId: 'p1', templateId: 'tpl-1',
      destinationIds: ['d1'], title: 'Late night', description: null,
      privacyStatus: 'unlisted', latencyPreference: 'low', createdAt: '2026-09-14T10:00:00.000Z',
    }]);
    vi.mocked(localStreamApi.start).mockResolvedValue(LIVE);
    renderWithProviders(<Stream />);
    await userEvent.selectOptions(await screen.findByLabelText('Start from a preset'), 'preset-1');
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(screen.getByLabelText('My channel')).toBeChecked());
    await userEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    await waitFor(() => expect(localStreamApi.start).toHaveBeenCalledWith({
      playlistId: 'p1', templateId: 'tpl-1', destinationIds: ['d1'],
      title: 'Late night', description: undefined, privacyStatus: 'unlisted', latencyPreference: 'low',
    }));
  });

  it('saves the current form as a preset', async () => {
    mockStatus(IDLE);
    vi.mocked(streamPresetsApi.create).mockResolvedValue({
      id: 'preset-2', name: 'Saturday', playlistId: 'p1', templateId: null, destinationIds: [],
      title: null, description: null, privacyStatus: null, latencyPreference: null, createdAt: '',
    });
    renderWithProviders(<Stream />);
    await screen.findByText('Friday Mix');
    await userEvent.selectOptions(screen.getByLabelText('Playlist'), 'p1');
    await userEvent.type(screen.getByPlaceholderText('Preset name'), 'Saturday');
    await userEvent.click(screen.getByRole('button', { name: 'Save preset' }));
    await waitFor(() => expect(streamPresetsApi.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Saturday', playlistId: 'p1', destinationIds: [],
    })));
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/pages/Stream.test.tsx`
Expected: FAIL — cannot resolve `./Stream`.

- [ ] **Step 4: Implement the page**

Create `frontend/src/pages/Stream.tsx`:

```tsx
import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  localStreamApi, DestinationForwardStatus, ForwardDesiredState, LocalStreamStatus,
} from '../api/localStream';
import { streamPresetsApi } from '../api/streamPresets';
import { useLocalStreamStatus, LOCAL_STREAM_STATUS_QUERY_KEY } from '../hooks/useLocalStreamStatus';
import { playlistsApi } from '../api/playlists';
import { templatesApi } from '../api/templates';
import { destinationsApi } from '../api/destinations';
import { ApiError } from '../api/client';
import { HlsPlayer } from '../components/HlsPlayer';
import { DestinationToggles } from '../components/DestinationToggles';
import { usePageTitle } from '../hooks/usePageTitle';

/**
 * The one stream page. There is exactly one local stream per account, so there is no list, no id in
 * any URL and nothing to navigate between: you start it, you control it, you watch it, and you tick
 * destinations on and off underneath it without ever interrupting it.
 */
export default function Stream() {
  const { t } = useTranslation();
  usePageTitle(t('stream.title'));
  const queryClient = useQueryClient();
  const statusQuery = useLocalStreamStatus();
  const playlistsQuery = useQuery({ queryKey: ['playlists'], queryFn: playlistsApi.list });
  const templatesQuery = useQuery({ queryKey: ['templates'], queryFn: templatesApi.list });
  const destinationsQuery = useQuery({ queryKey: ['destinations'], queryFn: destinationsApi.list });
  const presetsQuery = useQuery({ queryKey: ['stream-presets'], queryFn: streamPresetsApi.list });

  const [presetId, setPresetId] = useState('');
  const [presetName, setPresetName] = useState('');
  const [playlistId, setPlaylistId] = useState('');
  const [templateId, setTemplateId] = useState('');
  // While nothing is running the checklist is LOCAL state — ticking a box then has no backend
  // meaning yet and must not cost a round-trip. Once the stream is running the same checklist is
  // driven by the real forward statuses instead (see `forwards` below).
  const [selectedDestinationIds, setSelectedDestinationIds] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [privacyStatus, setPrivacyStatus] = useState<'public' | 'unlisted' | 'private'>('private');
  const [latencyPreference, setLatencyPreference] = useState<'normal' | 'low' | 'ultraLow'>('normal');

  const status = statusQuery.data;
  const local = status?.local;
  // Three cases, not two. 'idle' and 'error' both mean "nothing is running" and show the start
  // form; 'starting' means a start is in flight, so show neither the form (it would offer to start
  // a second one) nor the transport controls (there is nothing to control yet).
  const isStarting = local?.state === 'starting';
  const isRunning = local !== undefined && local.state !== 'idle' && local.state !== 'error' && !isStarting;
  // Once anything is happening server-side, the checklist reflects real forward statuses; before
  // that it is local form state.
  const usesBackendForwards = isRunning || isStarting;

  const destinations = destinationsQuery.data ?? [];
  // Before the stream runs, synthesise the same shape DestinationToggles reads from real forwards:
  // ticked destinations are exactly "pending" — wanted, with nothing having happened on any
  // platform yet, which is precisely what the backend would report for them.
  const forwards: DestinationForwardStatus[] = usesBackendForwards
    ? status!.destinations
    : selectedDestinationIds.map((destinationId) => ({
      destinationId,
      name: destinations.find((d) => d.id === destinationId)?.name ?? destinationId,
      desired: 'on',
      state: 'pending',
    }));

  const selectedIds = usesBackendForwards
    ? forwards.filter((forward) => forward.desired === 'on').map((forward) => forward.destinationId)
    : selectedDestinationIds;
  const hasYoutubeSelected = destinations.some((d) => d.provider === 'youtube' && selectedIds.includes(d.id));

  // `selectedDestinationIds` only matters while idle (see its own comment above), but nothing kept
  // it in sync with destinations toggled ON mid-stream — a user who checked a box while running
  // would see it silently vanish from the checklist the moment the stream stopped, since the local
  // state variable was never written to during the run at all. `lastBackendSelectedIds` mirrors the
  // backend-derived `selectedIds` on every render WHILE running — captured in a ref, not read at
  // the moment of the transition, because by the render where `usesBackendForwards` has already
  // flipped to false, `selectedIds` has ALREADY switched its own source back to the (still-stale)
  // `selectedDestinationIds`; there is no later point at which the backend-derived value is still
  // reachable through `selectedIds` itself.
  const lastBackendSelectedIds = useRef<string[]>([]);
  if (usesBackendForwards) lastBackendSelectedIds.current = selectedIds;
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !usesBackendForwards) setSelectedDestinationIds(lastBackendSelectedIds.current);
    wasRunning.current = usesBackendForwards;
  }, [usesBackendForwards]);

  const applyStatus = (next: LocalStreamStatus) => queryClient.setQueryData(LOCAL_STREAM_STATUS_QUERY_KEY, next);

  const startMutation = useMutation({
    mutationFn: () => localStreamApi.start({
      playlistId,
      templateId: templateId || undefined,
      destinationIds: selectedDestinationIds,
      title: title || undefined,
      description: description || undefined,
      privacyStatus: hasYoutubeSelected ? privacyStatus : undefined,
      latencyPreference: hasYoutubeSelected ? latencyPreference : undefined,
    }),
    onSuccess: applyStatus,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('stream.startFailed')),
  });

  function useCommand(fn: () => Promise<LocalStreamStatus>) {
    return useMutation({
      mutationFn: fn,
      onSuccess: applyStatus,
      onError: (err) => toast.error(err instanceof ApiError ? err.message : t('stream.commandFailed')),
    });
  }

  const previousMutation = useCommand(localStreamApi.previous);
  const pauseMutation = useCommand(localStreamApi.pause);
  const resumeMutation = useCommand(localStreamApi.resume);
  const nextMutation = useCommand(localStreamApi.next);
  const stopMutation = useCommand(localStreamApi.stop);

  const toggleMutation = useMutation({
    mutationFn: ({ destinationId, desired }: { destinationId: string; desired: ForwardDesiredState }) =>
      localStreamApi.setDestination(destinationId, desired),
    onSuccess: applyStatus,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('stream.toggleFailed')),
  });

  const savePresetMutation = useMutation({
    mutationFn: () => streamPresetsApi.create({
      name: presetName.trim(),
      playlistId,
      templateId: templateId || null,
      destinationIds: selectedDestinationIds,
      title: title || null,
      description: description || null,
      privacyStatus: hasYoutubeSelected ? privacyStatus : null,
      latencyPreference: hasYoutubeSelected ? latencyPreference : null,
    }),
    onSuccess: () => {
      setPresetName('');
      queryClient.invalidateQueries({ queryKey: ['stream-presets'] });
      toast.success(t('stream.presetSaved'));
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('stream.presetSaveFailed')),
  });

  function handleToggle(destinationId: string, desired: ForwardDesiredState) {
    if (usesBackendForwards) {
      toggleMutation.mutate({ destinationId, desired });
      return;
    }
    setSelectedDestinationIds((current) => (desired === 'on'
      ? [...current, destinationId]
      : current.filter((id) => id !== destinationId)));
  }

  function applyPreset() {
    const preset = presetsQuery.data?.find((p) => p.id === presetId);
    if (!preset) return;
    setPlaylistId(preset.playlistId);
    setTemplateId(preset.templateId ?? '');
    setSelectedDestinationIds(preset.destinationIds);
    setTitle(preset.title ?? '');
    setDescription(preset.description ?? '');
    setPrivacyStatus(preset.privacyStatus ?? 'private');
    setLatencyPreference(preset.latencyPreference ?? 'normal');
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!playlistId) return;
    startMutation.mutate();
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('stream.title')}</h1>
        <p className="mt-1 text-sm text-gray-500">{t('stream.subtitle')}</p>
      </div>

      {/* Gated on !isStarting too, not just !isRunning: isRunning already excludes 'starting'
          (see its own comment above), but that only keeps the transport controls from rendering
          during a start — it does nothing to stop THIS form from also rendering and offering to
          start a second stream while the first one is still coming up. */}
      {!isRunning && !isStarting && (
        <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border p-4">
          <div>
            <label htmlFor="stream-preset" className="block text-sm font-medium">{t('stream.presetLabel')}</label>
            <div className="mt-1 flex gap-2">
              <select
                id="stream-preset"
                className="flex-1 rounded border px-3 py-2"
                value={presetId}
                onChange={(e) => setPresetId(e.target.value)}
              >
                <option value="">{t('stream.noPreset')}</option>
                {presetsQuery.data?.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
              </select>
              <button type="button" onClick={applyPreset} disabled={!presetId} className="rounded border px-3 py-2 disabled:opacity-50">
                {t('stream.applyPreset')}
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="stream-playlist" className="block text-sm font-medium">{t('stream.playlistLabel')}</label>
            <select
              id="stream-playlist"
              className="mt-1 w-full rounded border px-3 py-2"
              value={playlistId}
              onChange={(e) => setPlaylistId(e.target.value)}
              required
            >
              <option value="">{t('stream.selectPlaylist')}</option>
              {playlistsQuery.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>

          <div>
            <label htmlFor="stream-template" className="block text-sm font-medium">{t('stream.templateLabel')}</label>
            <select
              id="stream-template"
              className="mt-1 w-full rounded border px-3 py-2"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              <option value="">{t('stream.noTemplate')}</option>
              {templatesQuery.data?.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              <Link to="/templates" className="underline">{t('stream.manageTemplates')}</Link>
            </p>
          </div>

          {hasYoutubeSelected && (
            <div className="space-y-3 rounded border p-3">
              <p className="text-xs text-gray-500">{t('stream.youtubeHelp')}</p>
              <input className="w-full rounded border px-3 py-2" placeholder={t('stream.titlePlaceholder')} value={title} onChange={(e) => setTitle(e.target.value)} />
              <textarea className="w-full rounded border px-3 py-2" placeholder={t('stream.descriptionPlaceholder')} value={description} onChange={(e) => setDescription(e.target.value)} />
              <div>
                <label htmlFor="stream-privacy" className="block text-sm font-medium">{t('stream.privacyLabel')}</label>
                <select
                  id="stream-privacy"
                  className="mt-1 w-full rounded border px-3 py-2"
                  value={privacyStatus}
                  onChange={(e) => setPrivacyStatus(e.target.value as 'public' | 'unlisted' | 'private')}
                >
                  <option value="private">{t('stream.private')}</option>
                  <option value="unlisted">{t('stream.unlisted')}</option>
                  <option value="public">{t('stream.public')}</option>
                </select>
              </div>
              <div>
                <label htmlFor="stream-latency" className="block text-sm font-medium">{t('stream.latencyLabel')}</label>
                <select
                  id="stream-latency"
                  className="mt-1 w-full rounded border px-3 py-2"
                  value={latencyPreference}
                  onChange={(e) => setLatencyPreference(e.target.value as 'normal' | 'low' | 'ultraLow')}
                >
                  <option value="normal">{t('stream.latencyNormal')}</option>
                  <option value="low">{t('stream.latencyLow')}</option>
                  <option value="ultraLow">{t('stream.latencyUltraLow')}</option>
                </select>
                <p className="mt-1 text-xs text-gray-500">{t('stream.latencyHelp')}</p>
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={!playlistId || startMutation.isPending}
            className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50"
          >
            {startMutation.isPending ? t('stream.starting') : t('stream.startButton')}
          </button>

          <div className="border-t pt-3">
            <div className="text-sm font-medium">{t('stream.savePresetTitle')}</div>
            <div className="mt-1 flex gap-2">
              <input
                className="flex-1 rounded border px-3 py-2"
                placeholder={t('stream.presetNamePlaceholder')}
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
              />
              <button
                type="button"
                onClick={() => savePresetMutation.mutate()}
                disabled={!playlistId || presetName.trim().length === 0 || savePresetMutation.isPending}
                className="rounded border px-3 py-2 disabled:opacity-50"
              >
                {t('stream.savePreset')}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* A start is in flight: neither a form that would start a second one, nor controls for
          something that is not running yet. */}
      {isStarting && (
        <p className="rounded-lg border p-4 text-sm text-gray-500">{t('streamState.starting')}</p>
      )}

      {isRunning && local && (
        <div className="rounded-lg border p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">
              {t('stream.nowPlayingNext', { track: local.currentTrack ?? '—', next: local.nextTrack ?? '—' })}
            </span>
            <span className="text-xs text-gray-500">{t(`streamState.${local.state}`)}</span>
          </div>
          {status!.destinations.every((forward) => forward.desired === 'off') && (
            <p className="mt-2 text-xs text-gray-500">{t('stream.noDestinationsNotice')}</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => previousMutation.mutate()} className="rounded border px-3 py-2">{t('stream.previous')}</button>
            {local.state === 'paused'
              ? <button onClick={() => resumeMutation.mutate()} className="rounded border px-3 py-2">{t('stream.resume')}</button>
              : <button onClick={() => pauseMutation.mutate()} className="rounded border px-3 py-2">{t('stream.pause')}</button>}
            <button onClick={() => nextMutation.mutate()} className="rounded border px-3 py-2">{t('stream.next')}</button>
            <button onClick={() => stopMutation.mutate()} className="rounded border px-3 py-2 text-red-600">{t('stream.stop')}</button>
          </div>
        </div>
      )}

      {/* Always visible: a destination can be ticked before the stream starts (it waits at
          'pending' with nothing happening on the platform) and toggled freely while it runs. */}
      <DestinationToggles
        destinations={destinations}
        forwards={forwards}
        onToggle={handleToggle}
        // Also disabled mid-toggle, not just mid-start: the backend now correctly reuses a
        // settling forward (see DestinationForward.isInactive()'s comment) rather than racing a
        // second prepareSession(), but a user firing several toggles on the SAME destination
        // before any of them round-trip still has no reason to — one toggle in flight per
        // checklist render is plenty.
        disabled={isStarting || toggleMutation.isPending}
      />

      {isRunning && local && (
        local.previewReady
          ? <HlsPlayer src={localStreamApi.previewUrl()} unsupportedMessage={t('stream.previewUnsupported')} />
          : <p className="rounded-lg border p-4 text-sm text-gray-500">{t('stream.previewStarting')}</p>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Route it, link it, and delete the old UI**

`frontend/src/App.tsx`: replace the `Streams`/`StreamSessionPanel`/`LocalStream` imports with
`import Stream from './pages/Stream';`, and replace their three routes with:

```tsx
                <Route path="/stream" element={<Stream />} />
                {/* There is one stream per account now, and no id anywhere in its URLs. Redirect the
                    three old entry points so existing bookmarks and links keep working. */}
                <Route path="/streams" element={<Navigate to="/stream" replace />} />
                <Route path="/streams/:id" element={<Navigate to="/stream" replace />} />
                <Route path="/local-stream" element={<Navigate to="/stream" replace />} />
```

`frontend/src/components/Sidebar.tsx`: replace the `/streams` and `/local-stream` entries with one:

```tsx
    { to: '/stream', label: t('sidebar.stream') },
```

Update `frontend/src/components/Sidebar.test.tsx` to expect the single `Stream` link and no
`Streams`/`Local stream` entries.

```bash
git rm frontend/src/pages/Streams.tsx frontend/src/pages/Streams.test.tsx \
       frontend/src/pages/StreamSessionPanel.tsx frontend/src/pages/StreamSessionPanel.test.tsx \
       frontend/src/pages/LocalStream.tsx frontend/src/pages/LocalStream.test.tsx \
       frontend/src/components/StartStreamDrawer.tsx frontend/src/components/StartStreamDrawer.test.tsx \
       frontend/src/api/streamSessions.ts \
       frontend/src/hooks/useStreamSessionStatus.ts frontend/src/hooks/useStreamSessionStatus.test.tsx
```

- [ ] **Step 6: Run the frontend suite and build**

Run: `cd frontend && npm test && npm run build`
Expected: PASS, clean build. `git grep -n "streamSessions\|StartStreamDrawer\|StreamSessionPanel\|local-stream'" frontend/src` must return only `localStreamApi`'s own `/local-stream/...` URL strings.

- [ ] **Step 7: Commit**

```bash
git add -A frontend
git commit -m "$(cat <<'EOF'
feat(frontend): one stream page with destination toggles

Streams.tsx, StreamSessionPanel.tsx, StartStreamDrawer.tsx and LocalStream.tsx
collapse into pages/Stream.tsx at /stream: start the one local stream, control
it, watch it, and tick destinations on and off underneath it. Saved presets
pre-populate the form. The three old routes redirect.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 13: Real-binary smoke test — `RelayProcess` against a real MediaMTX and a real ffmpeg

Every test above fakes ffmpeg and MediaMTX. This subsystem's whole track record says that is exactly
where the bugs hide — the two-FIFO deadlock, the `Buffer`/`Uint8Array` piscina corruption, the
`-stream_loop` gif freeze, and Phase A's own `?session=` 401, all found against real binaries and
none by reasoning about code. The spec names three hazards that **cannot** be checked any other way,
and the "new single point of failure" section names a fourth:

1. **Timestamp origin on `-c copy` RTMP→FLV.** "A relay joining a session already hours in inherits
   large non-zero input timestamps; whether that needs explicit normalization for real-world ingest
   servers is not something a unit test can tell us."
2. **Late-joining reader + keyframes.** "The encoder's GOP is `fps*2` (an IDR every 2s). Verify
   whether MediaMTX hands a newly-connected reader a keyframe-first stream — if not, a toggle-on
   could show up to 2s of garbage at the destination and the relay needs to buffer to the first
   keyframe itself."
3. **`-reconnect` flags don't apply to RTMP inputs.** Confirm the relay really does die when its
   source goes away, so recovery has to be the Node-level respawn `DestinationForward` implements.
4. **"Both reconnect layers actually survive a MediaMTX bounce" is a required smoke test, not an
   assumption.**

Run this on the remote docker host `192.168.14.26` (passwordless SSH). **Touch nothing already
running there**: everything below is prefixed `superdj-fwd-`, lives on its own isolated network,
publishes **no ports at all**, and is torn down at the end.

**Files:**
- Modify: none (findings feed Task 15's `CLAUDE.md` update and, if a hazard bites, `src/ffmpeg/relayProcessArgs.ts`)

**Interfaces:**
- Consumes: `buildRelayProcessArgs` (Task 2), `docker/mediamtx.yml` and
  `LocalRelayTarget`'s URL shapes (Phase A, unchanged).
- Produces: no code unless a hazard fires — a verified relay plus the exact numbers Task 15 records.

- [ ] **Step 1: Stage the config and the throwaway auth stub**

```bash
ssh 192.168.14.26 'rm -rf /tmp/superdj-fwd && mkdir -p /tmp/superdj-fwd'
scp docker/mediamtx.yml 192.168.14.26:/tmp/superdj-fwd/mediamtx.yml
ssh 192.168.14.26 'cat > /tmp/superdj-fwd/auth.js' <<'EOF'
// Stands in for createMediaMtxAuthApp with one hard-coded session, so this smoke test exercises the
// REAL MediaMTX -> HTTP -> allow/deny path without needing Postgres or the whole backend.
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

- [ ] **Step 2: Build this repo's own image and bring the isolated stack up**

The relay must be exercised with **the same ffmpeg the app ships** (Debian bookworm's
`ffmpeg 5.1.9`, from this repo's own `Dockerfile`) — a third-party ffmpeg image is very likely built
against a different RTMP implementation, and verifying the wrong binary defeats the purpose.

**Clone into a throwaway directory, never into `~/repos/super-dj`.** That path is the live demo
stand's own checkout, currently carrying an uncommitted, local-only edit to `docker-compose.yml`
(the port remap documented in this project's own deploy notes) — `git checkout`/`git pull` there
can collide with it, and rebuilding/checking out under a running stack is a side effect on a shared
host this task has no reason to take.

Do **not** pass `--branch feature/local-first-streaming` to this clone: a local-path `git clone`
only copies `refs/heads/*` from the source repo, and the demo stand's own checkout is very likely
sitting on `master` (Task 14 later has to `git checkout feature/local-first-streaming` there,
which only makes sense if it isn't already) — `--branch` on a ref the local clone never copied
fails with "Remote branch … not found in upstream origin". This task doesn't need branch-specific
application code anyway, only the same ffmpeg binary the app ships (Debian bookworm's `ffmpeg
5.1.9`, pulled in by the `Dockerfile`, which this plan does not touch) — clone whatever is
currently checked out there:

```bash
ssh 192.168.14.26 'rm -rf /tmp/superdj-fwd-src && git clone ~/repos/super-dj /tmp/superdj-fwd-src && docker build -t superdj-smoke /tmp/superdj-fwd-src'
ssh 192.168.14.26 '
  docker network create superdj-fwd-net &&
  docker run -d --rm --name superdj-fwd-auth --network superdj-fwd-net \
    --network-alias super-dj -v /tmp/superdj-fwd:/app:ro node:20-bookworm-slim node /app/auth.js &&
  docker run -d --rm --name superdj-fwd-mtx --network superdj-fwd-net \
    -e MTX_AUTHHTTPADDRESS=http://super-dj:3001/internal/mediamtx-auth/smoke-secret \
    -v /tmp/superdj-fwd/mediamtx.yml:/mediamtx.yml:ro bluenviron/mediamtx:1.21.0 &&
  docker run -d --rm --name superdj-fwd-sink --network superdj-fwd-net bluenviron/mediamtx:1.21.0 &&
  sleep 3 && docker logs superdj-fwd-mtx | tail -20'
```

`superdj-fwd-sink` is a SECOND, stock MediaMTX standing in for a destination's ingest (no config
mounted, so it accepts any path with no auth). It is a throwaway test fixture — **do not confuse it
with the shipped `docker/mediamtx.yml`, and do not copy its permissiveness anywhere near the real
one.** Note for the record whether `superdj-fwd-mtx`'s startup log still shows only the RTMP and HLS
listeners (no MoQ/API/metrics lines); a version bump can silently outrun the config's denylist.

- [ ] **Step 3: Start a long-running publisher and let it get "hours in"**

```bash
ssh 192.168.14.26 '
  docker run -d --rm --name superdj-fwd-pub --network superdj-fwd-net --entrypoint ffmpeg superdj-smoke \
    -re -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440:sample_rate=44100 \
    -c:v libx264 -preset ultrafast -tune stillimage -pix_fmt yuv420p -g 60 -c:a aac -b:a 192k \
    -f flv "rtmp://superdj-fwd-mtx:1935/live/abcdef0123456789abcdef0123456789?user=pub&pass=pubsecret" &&
  sleep 90 && docker logs superdj-fwd-mtx | tail -5'
```

90 seconds is enough to make the input timestamps unmistakably non-zero (hazard 1 is about scale,
not about hours specifically — a 90 s offset shows up in the first DTS just as clearly as a 3 h one).

- [ ] **Step 4: Hazard 1 and 2 — measure each at the point that actually answers the question**

A relay-to-relay chain through a SECOND MediaMTX (`superdj-fwd-sink`) cannot measure either hazard:
the sink is a full RTMP server that re-muxes and re-bases timestamps for every reader, so whatever
`dts_time` ffprobe reports there is the SINK's own timeline, not what the relay actually emitted —
"acted on" would be unfalsifiable either way. And hazard 2 is a property of what MediaMTX #1 hands
the relay's OWN input, not what survives two remuxes downstream; with `-c copy` ffmpeg never
decodes, so "decoder complaints in the relay's stderr" cannot fire regardless of the real answer.
Measure each at its own source instead, and keep the sink for a separate, narrower question:

**Hazard 1 — probe the relay's own output file, not a re-muxed copy of it.** Run a second copy of
the relay writing to a mounted volume instead of RTMP, so ffprobe reads the exact bytes the relay
produced:

```bash
ssh 192.168.14.26 '
  mkdir -p /tmp/superdj-fwd-out &&
  docker run -d --rm --name superdj-fwd-relay-file --network superdj-fwd-net \
    -v /tmp/superdj-fwd-out:/out --entrypoint ffmpeg superdj-smoke \
    -hide_banner -nostdin \
    -i "rtmp://superdj-fwd-mtx:1935/live/abcdef0123456789abcdef0123456789?user=sub&pass=readsecret" \
    -c copy -avoid_negative_ts make_zero -f flv /out/relay.flv &&
  sleep 12 && docker stop superdj-fwd-relay-file &&
  docker run --rm -v /tmp/superdj-fwd-out:/out --entrypoint ffprobe superdj-smoke \
    -v error -show_entries packet=stream_index,dts_time,pts_time,flags -read_intervals "%+#12" \
    -of compact /out/relay.flv'
```

If the first `dts_time` is near 0 (< ~1 s), `-avoid_negative_ts make_zero` is doing its job and
`relayProcessArgs.ts` needs no change. If it is ~90 (i.e. the source's own timeline arrives
verbatim), re-run with `-fflags +genpts` inserted **before** `-i`, and if that brings the first DTS
to ~0, add `-fflags +genpts` to `buildRelayProcessArgs` in the same position, with a comment citing
this measurement. Either way, write the observed number into `CLAUDE.md` in Task 15.

**Hazard 2 — probe MediaMTX #1 directly, as a fresh reader, repeated at different GOP phases.**
This is a property of what the FIRST MediaMTX hands out, so read it directly with the read
credential, not through the relay or the sink:

```bash
ssh 192.168.14.26 '
  for i in 1 2 3; do
    echo "--- probe $i (fresh reader) ---";
    docker run --rm --network superdj-fwd-net --entrypoint ffprobe superdj-smoke \
      -v error -show_entries packet=stream_index,flags -read_intervals "%+#6" -of compact \
      "rtmp://superdj-fwd-mtx:1935/live/abcdef0123456789abcdef0123456789?user=sub&pass=readsecret";
    sleep 3;
  done'
```

Record whether the FIRST video packet (`stream_index=0`) in each of the three probes carries the
`K` (keyframe) flag — three probes a few seconds apart land at different phases of the 2 s GOP, so
the answer isn't an accident of one probe's timing. A non-keyframe start is **acceptable and
expected** if it only produces a blank ≤2 s window at the destination (YouTube buffers before its
own transition to live anyway) — record it as a measured property. Only if it produces actual
corruption at a real destination does the relay need to buffer to the first keyframe itself, which
would be a new task, not a silent tweak here.

**Separately — does a real ingest server accept this?** Keep the original relay-to-sink chain for
exactly this narrower question (not for measuring either hazard above):

```bash
ssh 192.168.14.26 '
  docker run -d --rm --name superdj-fwd-relay --network superdj-fwd-net --entrypoint ffmpeg superdj-smoke \
    -hide_banner -nostdin \
    -i "rtmp://superdj-fwd-mtx:1935/live/abcdef0123456789abcdef0123456789?user=sub&pass=readsecret" \
    -c copy -avoid_negative_ts make_zero -f flv "rtmp://superdj-fwd-sink:1935/live/dest" &&
  sleep 12 &&
  docker run --rm --network superdj-fwd-net --entrypoint ffprobe superdj-smoke \
    -v error -show_entries packet=stream_index -of compact "rtmp://superdj-fwd-sink:1935/live/dest" &&
  echo "--- relay stderr ---" && docker logs superdj-fwd-relay | tail -30'
```

A clean ffprobe read and no fatal lines in the relay's stderr means a real RTMP ingest accepts this
argv unchanged — record that as the acceptance result, separately from the two measurements above.

- **Hazard 3 prep:** note the relay's steady-state RSS (`docker stats --no-stream
  superdj-fwd-relay`) to confirm the design's "single-digit MB" claim for a `-c copy` relay.

- [ ] **Step 5: Hazard 3 — prove the relay does not self-heal when its source disappears**

```bash
ssh 192.168.14.26 '
  docker stop superdj-fwd-pub;
  sleep 10;
  docker inspect -f "{{.State.Running}} {{.State.ExitCode}}" superdj-fwd-relay 2>/dev/null || echo "relay container is gone (exited)";
  docker logs superdj-fwd-relay 2>&1 | tail -10'
```

Expected: the relay **exits** within a few seconds of the publisher going away, with a non-zero code
and an EOF/connection-reset message. That is the behaviour `DestinationForward.handleRelayExit()` is
built on, and it confirms the spec's "input-side recovery for the relay must be a Node-level
respawn, not an ffmpeg flag." If instead the relay hangs alive forever with a dead input, say so —
that would mean forwards need their own liveness timeout, which is a new task.

Also confirm here that MediaMTX drops readers promptly when the publisher goes (the assumption
behind the forward "hold" rule): the relay's exit timing IS that measurement. Record it.

- [ ] **Step 6: Hazard 4 — a MediaMTX bounce**

```bash
ssh 192.168.14.26 '
  docker rm -f superdj-fwd-relay 2>/dev/null;
  docker run -d --rm --name superdj-fwd-pub --network superdj-fwd-net --entrypoint ffmpeg superdj-smoke \
    -re -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440:sample_rate=44100 \
    -c:v libx264 -preset ultrafast -tune stillimage -pix_fmt yuv420p -g 60 -c:a aac -b:a 192k \
    -f flv "rtmp://superdj-fwd-mtx:1935/live/abcdef0123456789abcdef0123456789?user=pub&pass=pubsecret" &&
  sleep 8 &&
  docker run -d --rm --name superdj-fwd-relay --network superdj-fwd-net --entrypoint ffmpeg superdj-smoke \
    -hide_banner -nostdin \
    -i "rtmp://superdj-fwd-mtx:1935/live/abcdef0123456789abcdef0123456789?user=sub&pass=readsecret" \
    -c copy -avoid_negative_ts make_zero -f flv "rtmp://superdj-fwd-sink:1935/live/dest" &&
  sleep 5 && docker restart superdj-fwd-mtx && sleep 10 &&
  docker inspect -f "pub={{.State.Running}}" superdj-fwd-pub 2>/dev/null || echo "publisher exited";
  docker inspect -f "relay={{.State.Running}}" superdj-fwd-relay 2>/dev/null || echo "relay exited"'
```

Expected and important: **both** the publisher and the relay die on a MediaMTX restart — neither
ffmpeg reconnects on its own. That is precisely why both layers have Node-level respawns
(`StreamController`'s reconnect for the publisher, `DestinationForward`'s for the relay), and it
confirms that after a MediaMTX bounce the local stream recovers first and forwards then reconnect
against it (they hold while the local stream is `reconnecting`, by design). Record both observations;
if either process survives, the state machines' assumptions need revisiting before Task 15.

Also confirm that after the restart MediaMTX still authenticates against the stub (the auth stub's
log shows a fresh `publish` line), i.e. that nothing about a bounce requires a config reload.

- [ ] **Step 7: Tear everything down**

```bash
ssh 192.168.14.26 '
  docker rm -f superdj-fwd-relay superdj-fwd-relay-file superdj-fwd-pub superdj-fwd-sink superdj-fwd-mtx superdj-fwd-auth 2>/dev/null;
  docker network rm superdj-fwd-net 2>/dev/null;
  rm -rf /tmp/superdj-fwd /tmp/superdj-fwd-src /tmp/superdj-fwd-out; echo cleaned'
ssh 192.168.14.26 'docker ps --format "{{.Names}}" | grep superdj-fwd; echo done'
```

Verify nothing remains and that **no pre-existing container or network was touched**.

- [ ] **Step 8: Commit any argv change the measurements forced**

If Step 4 required an argv change, update `src/ffmpeg/relayProcessArgs.ts` **and its test** (assert
the new flag, with a comment naming the measured number that justifies it), then:

```bash
git add src/ffmpeg/relayProcessArgs.ts test/ffmpeg/relayProcessArgs.test.ts
git commit -m "$(cat <<'EOF'
fix: normalise the relay's output timestamps for a late-joining forward

Measured against a real MediaMTX 1.21.0 and this image's own ffmpeg: a relay
joining a 90s-old session was emitting the source's own timeline. Unit tests
cannot see this; only a real binary can.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

If no change was needed, there is nothing to commit here — the findings land in Task 15's docs.

---

### Task 14: Real-API smoke test — a full toggle cycle against a real YouTube channel

`CLAUDE.md` has always recorded that **no real end-to-end YouTube smoke test has ever been run**.
The spec: "This design multiplies YouTube API state transitions per session by however many times a
user toggles a checkbox — a real smoke test against a real channel is a hard prerequisite for this
work being considered validated, not a nice-to-have." Addendum decision (c) confirms a real channel
with OAuth is available.

**Files:**
- Modify: only whatever the run proves broken (plus Task 15's docs)

**Interfaces:**
- Consumes: the whole stack, Tasks 1-12.
- Produces: a validated toggle cycle, and the measured numbers Task 15 records.

> **Remote-host etiquette:** this runs on the existing demo stack at `192.168.14.26` (compose
> project `super-dj`, published on port 8088). That port mapping is a **local-only edit that a
> redeploy silently reverts** — re-apply it and verify it after `docker compose up`, and never stop
> or inspect any other service on that host.

- [ ] **Step 1: Deploy this branch to the demo stand and apply the migration**

```bash
ssh 192.168.14.26 'cd ~/repos/super-dj && git fetch && git checkout feature/local-first-streaming && git pull'
# Re-apply the local-only 8088 port mapping on the super-dj service before bringing it up.
ssh 192.168.14.26 'cd ~/repos/super-dj && grep -n "8088" docker-compose.yml || echo "PORT MAPPING MISSING — re-apply it now"'
ssh 192.168.14.26 'cd ~/repos/super-dj && docker compose up -d --build'
```

**Do not run `prisma migrate deploy` inside the running `super-dj` container — there is no `prisma`
CLI or `prisma/` directory in it to run.** The runtime image (`Dockerfile`) is a multi-stage build
whose final stage does `npm ci --omit=dev --ignore-scripts` and copies only `dist/`, `assets/`,
`node_modules/.prisma` and `@prisma/client` — `prisma` itself is a devDependency, stripped out, and
`schema.prisma`/`migrations/` are never copied in at all. Apply the migration from a throwaway
container joined to the compose network instead, mirroring Task 4's own migration-generation
recipe:

```bash
ssh 192.168.14.26 '
  docker run --rm --network super-dj_default -v ~/repos/super-dj:/app -w /app \
    -e DATABASE_URL=postgresql://superdj:superdj@postgres:5432/superdj \
    node:20-bookworm-slim bash -lc "apt-get update -qq && apt-get install -y -qq openssl >/dev/null && npm ci --ignore-scripts && npx prisma migrate deploy"'
ssh 192.168.14.26 'docker exec super-dj-postgres-1 psql -U superdj -d superdj -c '"'"'\d "StreamDestination"'"'"''
ssh 192.168.14.26 'cd ~/repos/super-dj && docker compose ps && curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8088/openapi.json'
```

Expected: `200`, and `docker compose ps` shows `super-dj`, `mediamtx`, `postgres` and `frontend` up.
**Confirm `docker compose ps` shows no published port for `mediamtx`** — if a redeploy ever added
one, stop and remove it before going further.

- [ ] **Step 2: Connect the real YouTube channel and start a local stream**

Log in first and save the session cookie every later `curl` in this task reuses:

```bash
ssh 192.168.14.26 'curl -s -c ~/superdj-cookie.txt -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"<test-account-email>\",\"password\":\"<test-account-password>\"}" \
  http://localhost:8088/auth/login; echo'
```

Through the app's own UI (the frontend on the stand), or with `curl -b ~/superdj-cookie.txt`
against port 8088:

1. Connect the channel via `GET /destinations/youtube/oauth/start` and completing consent. **This
   step needs the user, not the agent**: it's an interactive Google OAuth consent flow in a real
   browser, against a real Google account, and the OAuth client's redirect URI must already be
   registered for this stand's `APP_BASE_URL` — nothing here can be scripted or completed
   unattended. Hand off to the user with the `authUrl` from that endpoint's response and wait for
   confirmation that a `StreamDestination` with `provider: "youtube"` now exists before continuing.
2. Upload one short track and create a one-track playlist (or reuse an existing one).
3. `POST /local-stream/start` with that `playlistId`, **no `destinationIds`**, and
   **`privacyStatus: "public"`** — prove the local stream runs and previews with nothing forwarded
   (the spec's "zero destinations is a fully valid running state"), and set the broadcast privacy
   now, at start time, since it can't be changed later: `privacyStatus`/`title`/etc. are `start()`
   options (per the addendum's decision on where broadcast metadata comes from), not something the
   toggle route in Step 3 takes. **This choice matters for what Step 3/4 can actually observe**:
   `watchUrl()`'s new privacy gate (Task 5) only returns the stable channel `/live` link for a
   PUBLIC broadcast — a private one (the default) falls back to a per-broadcast `watch?v=` URL that
   changes on every toggle, which would make Step 4's "same stable watch URL across a toggle"
   check fail by construction, not because of a bug. If a private/unlisted broadcast specifically
   needs verifying too, do that as an explicit extra pass, and expect (correctly) a fresh URL each
   toggle there.
4. Confirm `GET /local-stream/status` reports `local.state: "streaming"`, `previewReady: true` and
   `destinations: []`, and that the preview plays in the browser.

- [ ] **Step 3: Toggle the YouTube destination ON and time it**

```bash
# from the host, with the session cookie in ~/superdj-cookie.txt
ssh 192.168.14.26 'date -Ins; curl -s -b ~/superdj-cookie.txt -X PUT -H "Content-Type: application/json" \
  -d "{\"desired\":\"on\"}" http://localhost:8088/local-stream/destinations/<DESTINATION_ID>; echo'
ssh 192.168.14.26 'for i in $(seq 1 20); do date -Ins; curl -s -b ~/superdj-cookie.txt http://localhost:8088/local-stream/status | head -c 400; echo; sleep 5; done'
```

**Record:**
- the state sequence — expect `pending`/`preparing` → `connecting` → `live`;
- **how long `connecting` → `live` actually takes** (the spec estimates 10-40 s; the UI copy claims
  10-40 s and must be corrected in Task 15 if reality differs);
- the `provider.watchUrl` — it must be `https://www.youtube.com/channel/<CHANNEL_ID>/live`, and
  opening it must show the live broadcast;
- that the broadcast really is live in YouTube Studio, with video and audio, and that the overlay
  looks right (this is also the first real end-to-end check that the `-c copy` relay produces a
  stream YouTube accepts at all).

Also measure the **added latency** the spec asks for ("measure the real number once built and record
it here"): compare a visible change on the local HLS preview against the same change on the YouTube
player, and record the delta attributable to the extra MediaMTX→relay hops (the spec estimates
0.5-2 s on top of YouTube's own 20-40 s).

- [ ] **Step 4: Toggle OFF, then ON again — the cycle this design multiplies**

```bash
ssh 192.168.14.26 'docker compose -f ~/repos/super-dj/docker-compose.yml exec -T postgres psql -U superdj -d superdj -c "select id, name, \"youtubeLiveStreamId\" from \"StreamDestination\";"'
# toggle off, wait for state=off, then toggle on again, then re-run the query above
```

**Record and verify:**
- toggling off transitions the broadcast to `complete` (visible in Studio) and leaves the archived
  VOD in place (spec open question #4 — this is intended, not a bug);
- **`youtubeLiveStreamId` is identical before and after the second toggle-on** — that is the whole
  point of Task 4/5: only the `liveBroadcast` is ephemeral;
- the second toggle-on produces a **new** broadcast but the **same stable watch URL**;
- **the local stream never went to `idle`, `paused` or `error` at any point during either toggle** —
  check `local.state` throughout. This is the central invariant of the whole rework.

- [ ] **Step 5: The failure paths, on a real account**

1. **A forward error must not touch the encode.** Add a second, deliberately broken `custom`
   destination (`rtmp://127.0.0.1:1/nope` with any key), toggle it on, and confirm it lands in
   `state: "error"` with `error.reason: "relay"` after its retry budget, **while the YouTube forward
   stays `live` and the local stream stays `streaming`**.
2. **Deleting a forwarded destination.** With YouTube toggled on, `DELETE /destinations/{id}`.
   Confirm the broadcast is transitioned to `complete`, the destination disappears from
   `status.destinations`, and **the local stream keeps running**.
3. **Stop.** `POST /local-stream/stop` with a destination still live: confirm the response only
   comes back after the broadcast has been completed, and that Studio shows it ended.

- [ ] **Step 6: Check the quota arithmetic against reality**

In Google Cloud Console, note the Data API quota consumed by this session and compare it with the
spec's ~330 units/cycle estimate minus the `liveStreams.insert`/`delete` savings. Record the real
number in Task 15 — the whole "roughly 30 cycles/day for the entire app" warning in the spec depends
on it, and it is the input to any future per-user toggle rate limit.

- [ ] **Step 7: Leave the stand in a clean state**

Stop the local stream, toggle every destination off, and confirm no broadcast is left live on the
channel. Do not delete the user's own destinations or playlists.

There is nothing to commit for this task unless a defect is found; fix any defect with its own
failing test first, in the module that owns it.

---
### Task 15: Documentation and final verification

`CLAUDE.md` is the authoritative description of this codebase and currently describes a system that
no longer exists: `StreamManager`, `StreamSessionManager`, `SessionOverlayCache`, the two legacy
route families and a Phase A local stream with "no destination concept at all". Rewrite it against
what now ships, including the numbers Tasks 13 and 14 measured.

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything from Tasks 1-14, plus their measured findings.
- Produces: no code.

- [ ] **Step 1: Rewrite the architecture sections**

In `CLAUDE.md`:

1. **Project overview** — replace the "Phase A of the local-first rework adds a second,
   destination-free path alongside it" sentence. The model is now: one local stream per account that
   always encodes into the co-located MediaMTX relay, is watchable as an authenticated HLS preview,
   and has 0..N independently toggleable destination forwards. There is no longer any way to stream
   to a destination without a local stream.

2. **Architecture — "Backend streaming pipeline"** — delete the `StreamManager` bullet and the whole
   "Multi-destination stream sessions" bullet. Rewrite the `LocalStreamManager` bullet to cover: one
   `StreamController` + one `Map<destinationId, DestinationForward>` per `userId`; the two host
   ceilings (unchanged); and the fact that the encode's cost no longer grows with destination count
   at all (MediaMTX serves one publisher to N readers — a 3-destination session went from three
   independent libx264 720p30 encodes to one). Add two new bullets:
   - **`DestinationForward`** — desired/actual state plus one `reconcile()` re-entered on every
     relevant event; the `pending` state (wanted, nothing published yet, zero external side
     effects); the hard invariant that a prepared session is registered before desired-state is
     re-checked; the hold-don't-finalize rule while the local stream is `reconnecting`, and why
     (eating a few seconds of ingest gap beats burning quota and every viewer's link); the sticky
     `error` with its `auth`/`provider`/`relay`/`source` reason; and the invariant that a forward can
     never touch the encode or a sibling.
   - **`RelayProcess`** — `ffmpeg -i <MediaMTX read URL> -c copy -f flv <destination>`, the same
     `stopRequested` guard as `PersistentEncoder`, **never transcoding**, and the fact that
     `-reconnect*` flags do not apply to RTMP inputs so recovery is a Node-level respawn. Record the
     Task 13 measurements here: the observed first DTS at the destination, whether a late-joining
     reader gets a keyframe first, how quickly the relay dies when the publisher goes away, and that
     a MediaMTX bounce kills both layers (which is why both have respawns).

3. **Architecture — "Local relay (MediaMTX)"** — keep all three security layers verbatim; add that
   the relay now has a *second* class of reader (the per-destination forwards, using the `sub`
   credential `LocalRelayTarget` has been minting since Phase A) alongside the HLS preview proxy, and
   that Layer 0's no-published-ports rule is unchanged and still enforced by
   `test/infra/mediamtxConfig.test.ts`.

4. **Architecture — `StreamDestinationProvider` / `OAuthProviderAdapter` split** — update: the
   `liveStream` is now persisted per destination (`StreamDestination.youtubeLiveStreamId`) and reused
   across toggles, only the `liveBroadcast` is ephemeral, `finalize()` no longer deletes the stream,
   `watchUrl()` returns the channel's stable `/live` link for a public broadcast (a per-broadcast
   link for an unlisted/private one), and `prepareSession()` is called by a
   `DestinationForward` on toggle-on rather than by `StreamManager.start()`. Record the real quota
   figure measured in Task 14.

5. **Layout** — remove `streamManager.ts`, `streamRoutes.ts`, `streamSessionManager.ts`,
   `streamSessionRoutes.ts`, `sessionOverlayCache.ts`, `streamSessionRepository.ts`; add
   `destinationForward.ts`, `streamPresetRepository.ts`, `streamPresetRoutes.ts`,
   `ffmpeg/relayProcess.ts`, `ffmpeg/relayProcessArgs.ts`. On the frontend, remove `Streams.tsx`,
   `StreamSessionPanel.tsx`, `StartStreamDrawer.tsx`, `LocalStream.tsx`, `api/streamSessions.ts`,
   `hooks/useStreamSessionStatus.ts`; add `pages/Stream.tsx`, `components/DestinationToggles.tsx`,
   `api/streamPresets.ts`.

6. **HTTP API** — delete the `/destinations/{id}/stream/*` and `/stream-sessions/*` blocks entirely.
   Rewrite the `/local-stream/*` block: the new `start` body (including `destinationIds` and the
   broadcast metadata), `PUT /local-stream/destinations/{destinationId}`, the combined
   `{local, destinations[]}` status/SSE payload, and the `'starting'` state. Add the
   `/stream-presets` block. Keep the preview-route paragraph exactly as it is — that leg did not
   change. Keep the note that every mutating `/local-stream/*` route requires
   `Content-Type: application/json`, and say that the new `PUT` does too and why.

7. **Known follow-ups** — remove the ones this work closes and add the ones it opens:
   - **Closed:** the YouTube health-check timeout leaving a local pipeline pushing at a dead ingest
     (a terminal provider phase now stops that forward's relay and nothing else); the orphaned
     ephemeral `liveStream` when `finalize()`'s token call fails (the stream is reused, never
     deleted); `onError` finalizing the wrong session by `destinationId` (there is no
     destinationId-keyed lifecycle registry any more); "a `StreamSession`'s destination list is fixed
     at creation" and `StreamSessionManager.deleteById()`'s non-atomic stops (both classes gone with
     the entity); the Phase A follow-up (e) about `buildStreamScene`'s `overlayCache`/`sessionId`
     parameters (deleted).
   - **New:** (1) destination forwards are in-memory like everything else, so a backend restart drops
     every forward and leaves any YouTube broadcast it had created un-finalized until the user
     toggles again — the same in-memory-state tradeoff this app already makes, now with a
     platform-visible consequence; (2) there is no per-user toggle rate limit, so a user clicking a
     checkbox repeatedly can burn the shared daily Data API quota (record the measured per-cycle cost
     from Task 14 and the resulting cycles/day ceiling); (3) a forward's `error` is sticky until the
     user toggles it off and on again — deliberate, but it means a transient platform outage needs a
     manual re-toggle; (4) whatever Task 13 measured about keyframe alignment, if a late-joining
     reader does not get a keyframe first.
   - Keep Phase A's open items (a)-(d) and (f)-(g) — the shared MediaMTX SPOF, iOS Safari preview,
     a publisher surviving a Node crash, in-memory local-stream state, and the two secrets-in-logs
     leaks — and note that (f) now applies to the **relay's** stderr too: `createPipeSpawner` and
     `createSpawner` both forward ffmpeg's stderr verbatim, and a relay logs its own output URL,
     which for a custom RTMP destination contains that destination's decrypted stream key.

- [ ] **Step 2: Full verification**

Run, and confirm each passes before claiming the plan is done:

```bash
npx jest && npm run build
cd frontend && npm test && npm run build
```

Then confirm the cutover really is complete:

```bash
git grep -n "StreamSessionManager\|SessionOverlayCache\|createStreamRouter\|createStreamSessionRouter" src test frontend/src ; echo "(expect no matches)"
git grep -n "stream-sessions" src test frontend/src ; echo "(expect no matches)"
git grep -rn "new StreamManager\b" src test ; echo "(expect no matches)"
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: describe the unified local-first streaming model

One local stream per account with toggleable destination forwards replaces both
the per-destination and the multi-destination-session paths. Records what the
real-binary and real-YouTube smoke tests measured, closes the follow-ups this
work fixes, and opens the ones it creates.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task dependency order

Tasks are written to be executed in order. The only flexibility: Tasks 1-3 are independent of Task 4
(the migration) and can be done while it is being generated; Tasks 10-12 (frontend) depend on
Tasks 6, 7 and 9 but on nothing in 13-15. Tasks 13 and 14 must come after Task 12, and Task 15 last,
because it records what they measured.

```
1 ─┐
2 ─┼→ 3 ─┐
4 ─→ 5 ──┼→ 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15
```










