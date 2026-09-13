# Local-first streaming: one always-on local encode, toggleable destination forwards

## Problem

Today, starting a stream to any destination means committing immediately: `StreamController.start()`
spawns a `PersistentEncoder` that pushes RTMP **directly to the destination's real ingest URL** the
moment it starts (a YouTube destination even creates and transitions a real `liveBroadcast` to
`live` in the process). There is no way to run/preview/control a stream locally without already
being live somewhere, and no way to add or drop a destination without tearing down and restarting
the whole encode — which is exactly the class of operation the persistent-encoder rework (see
`2026-09-03-obs-style-persistent-canvas-design.md`) was built to avoid needing.

The user wants: **one local stream that starts, runs, and is directly previewable on its own**,
completely decoupled from whether — or how many, or which — real platforms are currently receiving
it. Destinations become checkboxes: toggle one on, it starts receiving the stream; toggle it off,
it stops; the local stream itself is never interrupted by any of this.

## Decisions locked in with the user before this design (do not relitigate)

1. **Full API unification.** The existing two flows — single-destination
   (`/destinations/{id}/stream/*`) and multi-destination session (`/stream-sessions/*`) — collapse
   into one model: one local stream + 0..N independently toggleable destination forwards. No
   separate single-destination code path survives. (Verified: the frontend only ever calls
   `/stream-sessions/*` — the single-destination routes are dead from the frontend's perspective
   already, which makes this unification much cheaper than it sounds.)
2. **Preview is an embedded web player** (HLS via hls.js, authenticated through the backend) in
   this iteration. A raw RTMP URL for external players (OBS/VLC) is an explicitly-deferred future
   addition — the design below must not foreclose it, but it is not being built now.
3. **Destinations can be toggled on/off multiple times per local session.** For YouTube this means
   a fresh ephemeral `liveBroadcast` per toggle-on and a `complete` transition per toggle-off — an
   accepted, intended consequence, not a defect to design around.
4. **Local relay: a dedicated MediaMTX container** in `docker-compose.yml`, not an embedded Node
   RTMP library. The encoder pushes RTMP into it; everything else (preview, per-destination
   forwarding) reads from it.
5. **Exactly one active local stream per user account at a time**, keyed by `userId`.

## Chosen approach

### Component shape

- **`LocalStream`** (renamed/slimmed `StreamController`) — one per active user. Owns exactly what
  it owns today minus anything destination-specific: `CanvasFeeder`, `AudioRelay`,
  `PersistentEncoder`, the equalizer pulse pipe, overlay rendering. The only change to its own
  responsibility is *where* `PersistentEncoder` pushes: a MediaMTX path instead of a real
  destination's ingest URL. State machine unchanged: `idle → starting → streaming ⇄ paused → idle`,
  plus `reconnecting`/`error`.
- **`DestinationForward`** — one per destination the user has checked for the current local
  stream. Owns *policy and lifecycle only*: the desired/actual state (see below), calling
  `StreamDestinationProvider.prepareSession()` / `DestinationLifecycle` (YouTube's ephemeral
  broadcast dance, or the no-op custom-RTMP path), and the reconnect policy for its own relay.
  **Deliberately has zero knowledge of child processes** — that lives in:
- **`RelayProcess`** — a thin `Spawner`-injected class, structurally near-identical to
  `PersistentEncoder`: `start(onExit)` / `stop()` around `ffmpeg -i <mediamtx-read-url> -c copy -f
  flv <destRtmpUrl>`, including the same `stopRequested` guard that suppresses `onExit` on a
  deliberate kill (needed here for the same reason it's needed there). Testable with the existing
  fake-child pattern, no new mocking style.
- **`LocalStreamManager`** (replaces `StreamManager` + `StreamSessionManager`) — keyed by `userId`,
  owns one `LocalStream` plus its map of `DestinationForward`s. Exposes start/stop/pause/resume/
  next/previous (act on the shared encode) and `setDestinationDesired(destinationId, on|off)`.
- **`LocalRelayTarget`** — a small factory, `create(userId) → { publishUrl, publishSecret,
  readUrl, readSecret, pathToken }`, minted fresh per local-stream start (not per user — see
  security section). This is where the whole MediaMTX credential/path scheme lives as one
  injectable, testable unit, and where the future "hand me a durable RTMP URL for OBS" feature
  would be a second method rather than a redesign.
- **`buildStreamScene(userId, playlistId, templateId)`** — an extraction out of today's
  ~320-line `StreamManager.start()`, which currently interleaves scene resolution (template load,
  gif probing, canvas placement split, equalizer normalization, the `buildOverlay` closure) with
  destination resolution (provider lookup, `prepareSession`, lifecycle wiring). This rework's diff
  *is* that separation; without deliberately extracting the scene half, `LocalStreamManager`
  inherits the same untestable method under a new name. Returns everything `LocalStream` needs
  with zero destination concept inside it.

### Why not let MediaMTX itself forward to destinations

MediaMTX's `source:` is pull-only; there is no native RTMP push-out. The documented way to
restream from it is `runOnReady: ffmpeg -i rtmp://localhost/$MTX_PATH -c copy -f flv <dest>` —
which is still our `ffmpeg` process, just supervised by MediaMTX instead of by us. That trade is
strictly worse here:

- No in-process push-started/died callbacks (needed to fire `onPushStarted()`/reconnect/finalize
  at the right moments) — would have to poll MediaMTX's control API and *infer* state instead.
- Testability regresses from the existing fake-`Spawner` pattern to faking an HTTP config API.
- **A real security regression**: a destination's stream key (AES-256-GCM at rest, decrypted only
  in-memory today) would have to be written into MediaMTX's runtime path config in plaintext —
  visible in its config dump and logs.
- Every toggle becomes an HTTP round-trip with its own partial-failure modes (config applied but
  process didn't spawn, etc.) instead of "spawn a process / kill a process."
- If MediaMTX itself restarts, it re-runs `runOnReady` and **resurrects a push into a YouTube
  broadcast the backend already finalized** — an orphaned forward the lifecycle owner thinks is
  dead. A backend-owned process dying with the backend is the correct failure mode; a
  MediaMTX-owned process surviving a backend restart is not.

### Why not one shared relay (`ffmpeg ... -f tee "[f=flv]dest1|[f=flv]dest2"`) instead of N processes

ffmpeg has no runtime interface to add or remove an output on a running process — `-f tee`'s
output set is fixed at process start, `zmq`/`azmq` can only mutate filter options, and `tee`'s
`onfail=ignore` handles an output that fails, not one that arrives later. So a shared tee would
need every destination known atomically at start, which contradicts "toggle repeatedly" (decision
3). Restarting the shared tee on every toggle avoids touching the *encoder*, but disconnects every
*other already-live destination* to flip one checkbox — for YouTube that's a visible health blip
on an unrelated broadcast; for Twitch it may end the stream outright. N independent processes is
correct **for isolation**, not just because the API forces it — the isolation argument would still
hold even if ffmpeg gained a live-output API tomorrow.

Cost check: each relay is `-c copy` — no decode, no encode, single-digit MB RSS. MediaMTX serves
one publisher to N readers, so **the local encode's cost does not grow with destination count at
all** — this is also a real CPU win over today's N-full-encodes-per-session model, worth stating
plainly: a 3-destination session goes from three independent libx264 720p30 encodes to one.

## Security model: MediaMTX multi-tenancy

MediaMTX has no concept of this app's per-user auth, so the trust boundary is entirely ours to
build, in three layers.

**Layer 0 — no published ports.** MediaMTX gets no `ports:` entry in `docker-compose.yml` at all;
reachable only by service name on the compose network. `api: no`, `metrics: no`, `pprof: no`,
`playback: no`, `webrtc: no`, `rtsp: no`, `srt: no` — only RTMP ingest and HLS stay enabled. This
is the actual boundary; everything below is defense in depth, and it's the line most likely to be
silently undone later by an incautious "let me just check if it's reachable" port publish — call
it out as a rule with a reason attached wherever it's configured.

**Layer 1 — path naming.** Path = `live/<opaque 128-bit token>`, minted fresh **per local-stream
start**, not per user (a leaked path from a prior session must not stay valid forever). MediaMTX
config: a single regex path (`~^live/[0-9a-f]{32}$`) with all-permission-denied `pathDefaults`, no
`all_others` catch-all — so no runtime config-reload dependency is ever needed.

**Layer 2 — `authHTTP`.** MediaMTX POSTs every publish/read attempt (`{user, password, ip, action,
path, ...}`) to a backend endpoint we control; 200 = allow, 401 = deny. This keeps the actual
policy decision as an in-memory map lookup in our own backend — no config reload, instant
revocation on stop (unlike a JWT, which stays valid until it expires). That endpoint must itself be
unreachable from outside (its own unpublished port + a shared-secret header, since it's not a
browser client and can't use the cookie-based `requireAuth` middleware) and must fail closed if
the backend is unreachable.

**Layer 3 — three credentialed legs.**
- *Publish* (encoder → MediaMTX): `rtmp://pub:<publishSecret>@mediamtx:1935/live/<pathToken>`,
  `publishSecret` per-session, in-memory only, never persisted, never returned by any API.
- *Forward* (relay → MediaMTX read): same path, `action=read`, a **different** secret than
  publish, so a leaked read credential can never be used to hijack the path by publishing over it.
- *Preview* (browser → backend proxy → MediaMTX HLS) — the leg with **zero MediaMTX-native
  enforcement reachable by the browser**, entirely our proxy route:
  - The client never names a MediaMTX path. Route is `GET /local-stream/preview/index.m3u8` /
    `GET /local-stream/preview/:file`, behind `requireAuth`; the path token is resolved from the
    authenticated user's own `LocalStream` server-side. A design where the browser supplies a path
    or token as a request parameter is one IDOR away from cross-tenant viewing — this is the single
    most important rule in this section.
  - Sanitize `:file` against `..`/anything but a segment or playlist filename; rewrite relative
    references in the playlist as needed.
  - The proxy still presents the MediaMTX read credential server-to-server, so `authHTTP` applies
    even to our own proxy traffic (defense in depth against a proxy misconfiguration).
  - Stream, don't buffer: pipe the response, `Cache-Control: no-store`, inject the HTTP client as
    a dependency (matches the repo's fake-injection testing style over reaching for a mocking lib).
  - **Known limitation, not a blocker:** hls.js on iOS Safari can't be used (the native player
    fetches the playlist itself and won't attach a cross-site cookie) — preview will silently fail
    there in this iteration. Documented as an open follow-up (a short-lived signed query token
    would fix it), not solved now.

**Left over, stated rather than hidden:** code execution inside the backend container bypasses all
of this (out of scope, as it would for any of this app's other secrets). A publisher that survives
a Node *crash* (not a container restart) keeps a live connection per-session-secret can't kick
without the control API enabled — mitigate with MediaMTX read/write timeouts, accept as a
known-follow-up. Pin the MediaMTX image to an exact version; mount config read-only; note it runs
as root by default, matching (not worsening) this app's existing same known issue.

## State machine

**Level 1 — `LocalStream`, per user.** `idle → starting → streaming ⇄ paused → idle`, plus
`reconnecting`/`error` — unchanged in shape from today's `SessionState`, with `starting` promoted
from `StreamManager`'s side-channel `Set<string>` into a real state (a destination toggle can now
arrive mid-start and needs somewhere to land).

**Level 2 — `DestinationForward`, per toggled destination. Modeled as desired-state + a
reconciler, not an imperative transition function.** Every edge case below (double-toggle,
toggle-during-finalize, stop-during-prepare, toggle-before-start) is the same root cause — an
async transition in flight when intent changes — so one `reconcile()`, re-entered on every
relevant event, replaces N special-cased handlers:

- `desired: 'on' | 'off'` — set directly and idempotently by the checkbox.
- `actual: 'off' | 'pending' | 'preparing' | 'connecting' | 'live' | 'stopping' | 'error'`.
- `reconcile()` re-runs on: toggle, `LocalStream` state change, relay exit, lifecycle phase change.

Sub-state rationale:
- **`pending`** (desired=on, `LocalStream` not yet streaming): zero external side effects — no
  `prepareSession()`, no YouTube broadcast created, until the local stream actually starts. Chosen
  over a 409-on-toggle-while-idle specifically so "start with these 3 destinations pre-checked"
  and "check a box mid-stream" are the same code path (set intents, then reconcile) rather than two
  orchestration paths.
- **`preparing`**: `prepareSession()` in flight — where YouTube API auth errors can surface, and
  where a `desired → off` arriving mid-call must not drop the returned lifecycle on the floor.
  Hard invariant: **once `prepareSession()` resolves, always register the lifecycle before
  re-checking desired-state** — the next `reconcile()` then finalizes it if desired has flipped.
  This generalizes the try/register/finalize discipline `StreamManager.start()` already uses.
- **`connecting`**: relay spawned, `onPushStarted()` fired (this now fires on **relay** spawn, not
  encoder spawn — the encoder no longer touches any real destination). For custom RTMP (no
  lifecycle to poll) reuse the existing `SHORT_LIVED_UPTIME_MS` heuristic — a relay surviving that
  long counts as connected.
- **`stopping`**: `finalize()` in flight (YouTube transition-to-complete + cleanup can take
  seconds and can fail) — without this state, a re-toggle-on mid-finalize races a second broadcast
  against the first.
- **`error`**: carries a reason (`auth` / `provider` / `relay` / `source`) so the UI can
  distinguish "reconnect your YouTube account" from "the destination rejected the key."

**Resolved edge cases:**
- *Encoder crashes while 3 destinations are live* — MediaMTX drops all readers within ~1s of the
  publisher disconnecting, so the cascade happens regardless of design. Forwards **hold** rather
  than finalize while `LocalStream` is `reconnecting` (do not finalize, do not burn their own
  reconnect budget, wait for the source), and only finalize once `LocalStream` gives up and goes
  `error`. This is a real improvement over today, where an encoder crash *always* finalized the
  broadcast via the `onError` hook — eating a few seconds of ingest gap (YouTube tolerates this;
  it only auto-ends after a sustained one) beats burning ~330 quota units and three new watch URLs.
- *Stop while a forward is mid-toggle-on* — set every `desired = off`; the in-flight prepare
  completes, registers, and the next `reconcile()` finalizes it. No special case needed.
- *A forward errors* — never touches the encoder or sibling forwards. Stated as an explicit
  invariant, since it's the entire point of this rework.
- *Toggle on before the local stream has started* — `desired=on`, `actual=pending`, surfaced in
  the UI as "will start with the stream."
- *Zero destinations checked* is a fully valid, non-degenerate running state — the stream runs and
  previews with nothing forwarded. This inverts today's model (a stream exists *because* something
  is receiving it) and every status/empty-state UI check needs to be written for it deliberately.
- *Pause* gets strictly safer than today: it no longer needs to keep any destination-facing RTMP
  connection alive through a silence swap, because the local publish to MediaMTX never stops
  regardless of pause state.
- *`DELETE /destinations/{id}` while forwarded* — must toggle that forward off and finalize its
  lifecycle **without touching the local stream** (today it calls `streamManager.stop
  (destinationId)`, which would be wrong here — easy one-line miss that orphans a broadcast).

**Status/events API shape:** one SSE stream per user, replacing the per-destination and
per-session routes: `{ local: {state, currentTrack, nextTrack, previewReady}, destinations:
[{destinationId, desired, state, provider?: {phase, watchUrl}, error?}] }`.

## YouTube-specific consequences (accepted, but must be visible to the user in the UI copy)

- **Quota**: one full toggle-on/off cycle costs on the order of ~330 Data API units (broadcast
  insert/bind/transition×2, stream insert/delete, health-poll list calls) against a shared
  10,000-units/day project quota — roughly 30 cycles/day for the **entire app** if nothing is
  done. Mitigation (locked in above): persist `liveStream` per destination, reuse it across
  toggles, only the `liveBroadcast` is ephemeral — removes `liveStreams.insert`/`delete` (~30% of
  the cost) and the entire "ephemeral liveStream orphaned because finalize's token call failed"
  failure class already in `CLAUDE.md`'s known follow-ups. Schema addition:
  `StreamDestination.youtubeLiveStreamId` (nullable). A per-user daily toggle rate limit and a
  Google quota-increase request are both worth doing but are ops/product tasks, not part of this
  design's code.
- **Viewer-facing**: the watch URL changes on every toggle (nobody following an old link migrates
  automatically); chat/concurrent-viewers/likes reset each time; every toggle-off leaves an
  archived VOD on the channel (six toggles ⇒ six short VODs); toggle-on is not instant (~10–40s
  broadcast-creation + ingest-detection + transition-to-live, on top of the existing ~20–40s
  ingest→CDN latency `latencyPreference` already documents) — the UI's `connecting` state must be
  honest about this or users will double-toggle and burn quota faster.
- **Mitigation adopted**: `DestinationLifecycle.watchUrl()` should expose a stable
  `https://www.youtube.com/channel/{channelId}/live` share link (valid across every toggle) instead
  of, or alongside, the per-broadcast watch URL — the single best fix for "my viewers' link keeps
  dying," and a small change.
- CLAUDE.md already records that **no real end-to-end YouTube smoke test has ever been run**. This
  design multiplies YouTube API state transitions per session by however many times a user
  toggles a checkbox — a real smoke test against a real channel is a hard prerequisite for this
  work being considered validated, not a nice-to-have.

## What this deletes or simplifies

- **`SessionOverlayCache`** — clean deletion. Constructed in exactly one place
  (`StreamSessionManager.create`), consumed in exactly one place (`StreamManager`'s `renderShared`
  closure). Its entire reason to exist — destinations in a session drifting onto different tracks
  — becomes structurally impossible once there is one queue driving one encode. Deleting it also
  removes `StreamStartOptions.overlayCache`/`sessionId` and the `renderShared` indirection.
- **`StreamSessionManager.fanOut`** and all per-destination best-effort error plumbing built on
  top of it (`StreamSessionDestinationStatus.error`, the "only one destination failed" frontend
  UX) — gone, because there is exactly one encode to fan anything out from now.
- **`StreamManager`'s three parallel destinationId-keyed maps** (`controllers`, `lifecycles`,
  `starting`) and its stale-lifecycle-cleanup-before-restart block — collapse into
  `LocalStreamManager`'s single per-user `LocalStream` + forward map.
- **`streamRoutes.ts` (single-destination HTTP API) and its tests/OpenAPI block** — deletable
  outright. Verified: the frontend only ever constructs `/stream-sessions/*` URLs, so this
  deletion breaks zero frontend code.
- **Destinations can no longer desynchronize from each other** — not mitigated, structurally
  impossible, since there's one queue and one encode instead of N independent ones.

## What gets bigger or riskier — stated plainly, not glossed over

- **Reconnect logic gets a bigger surface, in a better place.** The existing
  `reconnectPolicy.ts` (already parameterized on an `isRetryableDestination` veto hook) is reused
  **verbatim** at the new forward level — only its wiring moves. But:
  - At the local level (encoder → MediaMTX, a container-network push that essentially never drops
    for network reasons), the `isRetryableDestination`/auth-error veto is removed entirely — there
    is no destination concept left at that layer. This makes local reconnect near-dead code,
    firing only on a genuine ffmpeg crash/OOM.
  - Most of the *value* of the existing auto-reconnect feature migrates to the forward level, which
    needs two additions: an `isSourceAvailable` veto (so a forward doesn't burn its own reconnect
    budget while the local stream itself is down) and its own, faster backoff schedule (a relay
    respawn is cheap and should retry sub-second; the encoder's 2s-start schedule is tuned for
    rebuilding a whole pipeline, not a copy-relay).
  - Net: two reconnect call sites sharing one policy module, instead of one. A genuinely bigger
    surface — don't sell it as a pure simplification even though most other things shrink.
- **A new single point of failure.** Today a tenant's stream dies only if *its own* ffmpeg dies.
  After this, a MediaMTX crash/OOM/bad-image-update kills **every tenant's local stream
  simultaneously** — the most significant thing this design gives up in exchange for the CPU and
  isolation wins above. Mitigate with `restart: unless-stopped`, a memory limit, a pinned image
  version, and treat "both reconnect layers actually survive a MediaMTX bounce" as a required smoke
  test, not an assumption.
- **Latency**: encoder → MediaMTX → relay → destination adds roughly two buffering hops on top of
  a destination's own ingest latency (YouTube's own ~20–40s is unaffected by this app, but the new
  hops add on the order of 0.5–2s on top). Someone who explicitly chose `latencyPreference:
  'ultraLow'` will notice; measure the real number once built and record it here.
- **Frontend blast radius** (moderate, contained): `api/streamSessions.ts`, `Streams.tsx`,
  `StreamSessionPanel.tsx`, `StartStreamDrawer.tsx`, `useStreamSessionStatus.ts` and their tests,
  plus a new hls.js-based preview player component and the `hls.js` dependency. No
  single-destination frontend UI exists to port, per the earlier grep.
- **Backend test rewrite**: `streamManager.test.ts`, `streamSessionManager.test.ts`, parts of
  `streamController.test.ts`. `RelayProcess` tests exactly like `AudioRelay` (existing fake-child
  pattern). Two genuinely new test surfaces: the MediaMTX `authHTTP` endpoint (a pure function over
  an in-memory map — trivial) and the HLS proxy route (needs an injected HTTP client fake, staying
  in the repo's existing injection style rather than a new mocking library).

## Implementation hazards flagged for real-binary verification (not just unit tests)

Given this subsystem's track record (the two-FIFO deadlock, the `Buffer`/`Uint8Array` piscina
corruption, the odd-coordinate overlay displacement, the `-stream_loop` gif freeze — all found
against real binaries, none by reasoning about the code in isolation), the implementation plan
must include a real-ffmpeg/real-MediaMTX smoke test covering:

1. **Timestamp origin on `-c copy` RTMP→FLV.** A relay joining a session already hours in inherits
   large non-zero input timestamps; whether that needs explicit normalization for real-world
   ingest servers is not something a unit test can tell us.
2. **Late-joining reader + keyframes.** The encoder's GOP is `fps*2` (an IDR every 2s). Verify
   whether MediaMTX hands a newly-connected reader a keyframe-first stream — if not, a toggle-on
   could show up to 2s of garbage at the destination and the relay needs to buffer to the first
   keyframe itself.
3. **`-reconnect` flags don't apply to RTMP inputs** (HTTP(S)-only) — input-side recovery for the
   relay must be a Node-level respawn, not an ffmpeg flag. State this explicitly so it isn't
   assumed away during implementation.

## Phased delivery (do not big-bang this)

This replaces the one subsystem that took two rejected designs to get right, in a currently-working
system. Ship in three checkpoints, each independently useful and revertible:

- **Phase A — local stream + preview, zero destinations.** MediaMTX container, `LocalStream`
  keyed by userId, `LocalRelayTarget`, the `authHTTP` endpoint, the HLS proxy route, the embedded
  player. A complete, useful feature on its own ("start a stream, watch it") that proves the whole
  transport/auth/preview path with the smallest possible diff. Existing `/stream-sessions/*` and
  `/destinations/{id}/stream/*` keep working, untouched, throughout this phase.
- **Phase B — `DestinationForward` + `RelayProcess` + toggles**, built on a transport already
  soak-tested in Phase A.
- **Phase C — delete `streamRoutes.ts`, `StreamSessionManager`, `SessionOverlayCache`; migrate the
  frontend onto the unified model; resolve the `StreamSession` schema question below.**

## Open questions this spec resolves (so the plan doesn't have to guess)

Resolved during brainstorming, recorded here so the decomposition has a fixed target:

1. **`StreamSession` / `StreamSessionDestination` fate**: repurposed as a *saved preset* (playlist
   + template + a default destination checklist to pre-populate on next start), not dropped. No
   longer represents "the running thing" — that's `LocalStream` now.
2. **Reusable `liveStream` vs. ephemeral-per-toggle**: reusable, per destination (see YouTube
   section) — a schema change (`StreamDestination.youtubeLiveStreamId`), decided now rather than
   deferred, since it can't be bolted on painlessly later.
3. **Toggle-on-while-idle**: `pending` desired-state, not a 409.
4. **Toggle-off VOD cleanup**: leave the archived broadcast as-is (matches today's `finalize()`
   behavior) — deleting it automatically is out of scope for this design.
5. **Preview latency target**: plain HLS (~4–6s glass-to-glass) for this iteration; MediaMTX
   low-latency HLS is a later optimization, not a dependency of Phase A.
6. **iOS Safari preview**: known limitation (see security section), not solved now.
7. **Idle-stream cost control**: a local stream can now run indefinitely with zero destinations and
   zero viewers, consuming a full encode the whole time — needs a max-session-duration cap and/or
   an idle timeout. Concrete values are an implementation-plan decision, not fixed here.
8. **Per-host concurrency cap**: every logged-in user can trivially start an encode with no
   destination configured at all (today implicitly gated by needing a working RTMP destination) —
   a cap on simultaneous local streams per host is now required, not optional; concrete value is an
   implementation-plan decision.

## Deliberately deferred (YAGNI, stated so it isn't silently reintroduced)

- **Per-destination transcoding** (different bitrate/resolution per platform) — would reintroduce
  per-destination encodes and destroy the entire CPU-sharing premise of this design. Every forward
  is `-c copy`, full stop.
- **Raw RTMP preview for OBS/VLC** — out of scope per decision 2 above; `LocalRelayTarget` is kept
  able to mint a longer-lived read credential later so this is a route addition, not a redesign.
- **Recording/VOD via MediaMTX's `record: yes`** — tempting (one config line) but the app has no
  storage-quota story yet; would make an existing known gap urgent.
- **ABR / multi-rendition preview** — one rendition only.
- **Resuming a local stream after a backend restart** — state stays in-memory, matching today's
  existing, documented choice for stream state generally.
- **A MediaMTX path per destination** — pointless; one publisher, N readers is the entire point.
- **Twitch (or any platform) as a first-class OAuth provider** — unaffected by this design; still
  just a `custom` destination via `CustomRtmpProvider`.

## Explicit reassurance for the next implementer

`persistentEncoder.ts` does not change. `persistentEncoderArgs.ts` changes at most in how the
output URL/credential is constructed (and not at all if `LocalRelayTarget` mints MediaMTX
credentials in userinfo form — `rtmp://pub:<secret>@mediamtx:1935/live` as `rtmpUrl`, `<pathToken>`
as `streamKey` — so the existing `${rtmpUrl}/${streamKey}` concatenation in
`buildPersistentEncoderArgs` needs no signature change at all; verify the pinned MediaMTX version
accepts userinfo-form RTMP credentials before committing to this). `canvasFeeder.ts` and
`audioRelay.ts` do not change. No new code path restarts the encoder. The `unpipe()`-before-`kill()`
discipline is unaffected because no new component shares a pipe with an existing one — each
`RelayProcess` owns its own stdio end to end, independent of the encoder's pipes.
