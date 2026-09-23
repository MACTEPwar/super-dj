# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Project overview

**super-dj** — a multi-tenant YouTube streamer. A Node.js/TypeScript service, running in Docker
on Linux, where each user uploads audio tracks, arranges them into playlists, registers one or
more stream destinations (RTMP URL + stream key, or an OAuth-connected YouTube channel), and runs
**exactly one live stream per account** — all via a REST API, gated behind email/password auth.

That one stream is **local-first**: it always encodes into the co-located MediaMTX relay (see
"Local relay (MediaMTX)" below) and is always watchable as an authenticated HLS preview in the
app's own UI, whether or not any platform is involved. On top of it sit **0..N independently
toggleable destination forwards** — each a `-c copy` ffmpeg process pulling the already-encoded
stream back out of the relay and pushing it at one destination, tickable on and off mid-stream
without ever interrupting the encode, the preview, or a sibling destination. Zero destinations is
a completely ordinary running state, not a degenerate one.

**There is no longer any way to stream to a destination without a local stream.** The two older
paths — one independent encode per destination (`/destinations/{id}/stream/*`) and a
multi-destination fan-out over N of them (`/stream-sessions/*`) — are gone, along with
`StreamManager`, `StreamSessionManager` and `SessionOverlayCache`. What replaced them is one
encode that MediaMTX serves to N readers, so the encode's cost no longer grows with destination
count at all.

## Architecture (as built)

**Backend streaming pipeline.** A single persistent `PersistentEncoder` process **per account** —
spawned once in `StreamController.start()` and never restarted for the life of the session — is
fed by two Node-owned pipes (anonymous pipe file descriptors 3/4 that `spawn()` itself creates via
`stdio: [..., 'pipe', 'pipe']`, not named FIFOs — see `ChildProcessWithPipes`/`PipeSpawner` in
`src/ffmpeg/types.ts`). It pushes into the local MediaMTX relay and nowhere else; anything a real
platform receives is a `-c copy` `RelayProcess` reading that relay back out (below):

- **`PersistentEncoder` reads raw video (`pipe:3`) and raw PCM audio (`pipe:4`), continuously
  encodes+muxes+pushes to RTMP for the whole session.** Its codec parameters (H.264/yuv420p, fixed
  fps + GOP, AAC 44.1kHz stereo) are pinned once in `src/ffmpeg/persistentEncoderArgs.ts` — since
  there's only one encode process, there's no `-c copy` handoff between
  differently-encoded segments to keep in sync any more, which is what actually eliminates the
  continuity-counter/PTS discontinuity the earlier FIFO + two-process pipeline hit at every track
  switch (see the "Overlay templates" Stage 2 note below for a two-FIFO split-encode-from-mux
  design that was tried and abandoned along the way, before this one).
- **`CanvasFeeder` owns the video leg.** It renders one still frame (background + composited
  overlay PNG + optional timer `drawtext`, via a one-shot `ffmpeg` call built by
  `buildCanvasFrameArgs` in `src/ffmpeg/segmentArgs.ts`) on every actual content change — track
  switch, pause, resume, a once-a-second timer tick — and independently resends the last-rendered
  frame on a fixed `heartbeatMs` cadence the rest of the time, so `PersistentEncoder`'s declared
  input framerate (`heartbeatFps` in `persistentEncoderArgs.ts`) matches real wall-clock time.
  A template with an animated-gif element makes it a **two-layer** feeder (one extra pipe, `fd 6`
  / `pipe:6`) — see the `CanvasPlacement` note under "Overlay templates" below. The second layer
  is owned by this same instance, not a second one, precisely so both pipes share one heartbeat:
  ffmpeg synthesizes each raw pipe's PTS from its own frame count alone, so a write one feeder
  made and the other skipped would slide the two layers permanently out of register.
  **Every actual pipe write — heartbeat or fresh render — must land exactly `heartbeatMs` apart**;
  `render()` resyncs the heartbeat's phase from its own write rather than writing an extra frame on
  top of the timer's independent schedule (a real bug: writing both left the video timeline running
  measurably ahead of real time, worst with a timer element since that reduces the whole session to
  little more than a chain of these writes). `CanvasFeeder.close()`'s heartbeat `setInterval` is
  `.unref()`'d so it never blocks process exit on its own.
- **`AudioRelay` owns the audio leg**, one short-lived decode-only ffmpeg per track (or a
  silence/background "pause" clip) piped into the shared audio pipe. `stopCurrent()` `unpipe()`s
  the outgoing decoder's stdout from that pipe *before* killing it and piping the next decoder's
  stdout in — the same discipline the earlier per-segment pipeline always needed: `kill('SIGTERM')` alone doesn't
  stop a still-alive process's stdout from draining into the same pipe as the next track's, and two
  decoders piped in at once interleaves their raw PCM.
- **`LocalStreamManager` owns one `StreamController` *and* one `Map<destinationId,
  DestinationForward>` per user account** (both keyed by `userId`, both in-memory). It is the single
  replacement for the two managers this rework deleted — the destinationId-keyed `StreamManager` and
  the fan-out `StreamSessionManager` — and it is smaller than either was, because **there is nothing
  to fan out any more**: `LocalRelayTarget` mints a fresh MediaMTX path + publish/read credentials on
  every start, the one encoder pushes into the co-located MediaMTX relay, and every destination is
  just another reader of that same path. A 3-destination session used to mean three independent
  libx264 720p30 encodes; it is now **one**, plus three `-c copy` relays (measured against real
  binaries at ~1.4% CPU / ~16 MiB RSS each versus the encode's ~68% / ~84 MiB — roughly 1/47th; see
  `RelayProcess` below). The encode's cost does not grow with destination count at all.
  `start()` resolves scene and destinations through **`buildStreamScene()`**
  (`src/stream/streamScene.ts`) — playlist/template/track resolution and their ownership checks, gif
  probing, canvas placement, the `buildOverlay` closure and the `CanvasFeeder`/`AudioRelay`/
  `PersistentEncoder`/`PulseVisualizer` factories, i.e. everything a stream needs that has no
  destination in it; its `createPersistentEncoder(target: RtmpTarget)` takes the one thing it
  deliberately doesn't know: where to push. The playlist's track snapshot is read once at start
  (deliberately *not* re-read live, so editing a playlist mid-stream doesn't affect the running
  session), alongside the user's full track list for `play`-by-name lookup (the `LibraryLike`
  adapter in `streamController.ts`).
  Two host-level ceilings exist, unchanged from Phase A, because a local stream costs a full
  libx264 720p30 `ultrafast` encode while possibly having no destination and no viewer at all:
  `MAX_CONCURRENT_LOCAL_STREAMS` (default 10, sized against exactly that encode — an 11th `start()`
  gets a 429; the count is checked *and* a slot reserved synchronously before any `await`, or N
  concurrent starts from N different users would all observe the pre-increment size and all pass)
  and `MAX_LOCAL_STREAM_HOURS` (default 12, after which the stream auto-stops). Deliberately no
  idle/viewer-count timeout instead of the duration cap: MediaMTX's control API is the only
  viewer-count signal there is, and Layer 0 below disables it on purpose — enabling it to save some
  CPU would trade the security boundary for an optimisation.
  Two states live at *this* layer rather than in `StreamController`: **`'starting'`** (a start is in
  flight — promoted out of what used to be a private `Set`, because a destination toggle can now
  arrive mid-start and the UI must not read `idle` then), and **`previewReady`** (true exactly while
  the encoder is publishing into MediaMTX, i.e. `streaming` or `paused` — pausing swaps the audio to
  silence and never interrupts the publish).
- **`DestinationForward` (`src/stream/destinationForward.ts`) is one destination's forward for one
  user: policy and lifecycle only, zero knowledge of child processes beyond an injected
  `createRelay` factory.** It holds a `desired` (`on`/`off`, set directly and idempotently by the
  checkbox) and an `actual` (`off` → `pending` → `preparing` → `connecting` → `live`, plus
  `stopping` and `error`), and drives one toward the other through **exactly one `reconcile()`
  loop, re-entered on every relevant event** rather than N special-cased handlers — because every
  edge case (double-toggle, toggle-during-prepare, toggle-during-finalize, toggle-before-start,
  source loss, relay crash) is the same root cause: an async transition in flight when intent
  changed. A `reconcile()` arriving while a pass is running just asks the loop to go round again.
  The load-bearing details:
  - **`pending` is "wanted, nothing published yet, zero external side effects."** No
    `prepareSession()`, no YouTube broadcast, nothing. That is what makes "tick a box while nothing
    is running" and "tick a box mid-stream" the *same* code path — literally the same call,
    `PUT /local-stream/destinations/{destinationId}` — and a toggle-on with an idle account parks
    at `pending` and the next `start()` reconciles it into life with no extra orchestration.
    `POST /local-stream/start` itself carries no destination list or broadcast metadata of its own
    at all: a destination's own title/description/privacy/latency are supplied by whoever actually
    calls `setDesired(desired, meta?)` below, not once for a whole session.
  - **`setDesired(desired, meta?)`'s `meta` is this ONE destination's own broadcast title/
    description/privacy/latency — remembered on the forward instance itself, not derived from the
    local session.** Supplied by the caller at the moment of switching it on for real (the
    frontend's commit-time settings drawer — see "Frontend" below; the checkbox click itself never
    calls this), it is stored (`this.meta`) and reused by every future
    `prepareSession()` call this same forward makes until the caller supplies a new one — a respawn
    or an internal reconcile that omits it keeps using whatever was last chosen, rather than
    silently reverting to the bare `{title: destination.name}` fallback used when a forward has
    never been given any at all. This is the whole point of the toggle-time-settings rework: two
    YouTube destinations forwarded from the same account can go out with two entirely different
    titles/privacy levels, chosen independently, each right when IT actually goes live.
  - **HARD INVARIANT: a prepared session is registered before desired-state is re-checked.**
    `pass()` assigns `this.session = session` the instant `prepareSession()` resolves, *before* any
    re-read of `desired`. A `desired -> off` that arrived while that call was in flight must find a
    lifecycle to finalize; dropping it there orphans a live YouTube broadcast with nothing left in
    the process that could ever end it. The next pass does the finalizing.
  - **Hold, don't finalize, while the local stream is `reconnecting`.** `sourceUrl()` deliberately
    stays non-null through `reconnecting` (it returns null only for `idle`/`error`, i.e. the session
    is genuinely over), while `isSourcePublishing()` goes false — so a source outage parks the
    forward without finalizing its broadcast and without spending its own retry budget. MediaMTX
    drops every reader within ~1 s of the publisher disconnecting (measured: the publisher's
    `closed: EOF` and the relay's `closed: terminated` land in the same second, and the relay
    process is gone 0.242 s later), so the relay is already dead either way. Eating a few seconds of
    ingest gap beats burning a YouTube broadcast, its quota, and every viewer's link over an encoder
    hiccup. `ForwardErrorReason` declares a `'source'` value for completeness but nothing sets it,
    by construction — don't add a path that does without first re-deciding this rule.
  - **`error` is sticky, with a reason: `auth` | `provider` | `relay` | `source`.** It is set when
    `prepareSession()` rejects (classified via the provider's own `isAuthError?()`, which is why
    `DestinationForward` stays free of any YouTube-specific knowledge), when the provider's
    lifecycle reaches a terminal phase (`error`/`complete` — checked *ahead* of the hold and relay
    branches, so a terminal phase arriving while a respawn is merely scheduled can't let that timer
    fire into a broadcast the provider already ended), or when the relay's reconnect budget runs
    out. Only two things clear it: the user toggling off and on again, or the local session
    disappearing entirely (so a brand-new session never inherits a stale failure).
  - **A forward can never touch the encode or a sibling.** That is the invariant the class exists to
    protect, and it is what a real-API smoke test confirmed end to end: a deliberately broken custom
    destination (`rtmp://127.0.0.1:1/nope`) reached `state: "error"`, `reason: "relay"` within
    10-20 s while the YouTube forward next to it stayed `live` and `local.state` stayed `streaming`
    for the whole ~3-minute observation window.
- **`RelayProcess` (`src/ffmpeg/relayProcess.ts`) is one forward's ffmpeg:**
  `-hide_banner -nostdin -i <MediaMTX read URL> -c copy -avoid_negative_ts make_zero -f flv
  <destination URL>` (`buildRelayProcessArgs`, `relayProcessArgs.ts`). Structurally identical to
  `PersistentEncoder` on purpose, **including the same `stopRequested` guard** — a deliberate kill
  (toggling off, stopping the stream) must never look like a dropped destination and trigger a
  respawn or a broadcast finalize. It takes a plain `Spawner`, not a `PipeSpawner`: a relay owns its
  stdio end to end and shares no pipe, so the `unpipe()`-before-`kill()` discipline the audio leg
  needs does not apply. **It never transcodes**, and must never be given a codec, scaler, bitrate or
  filter option — MediaMTX serves one publisher to N readers, and per-destination transcoding would
  destroy that entire CPU-sharing premise. Also deliberately absent:
  `-reconnect`/`-reconnect_streamed`/`-reconnect_delay_max`, which apply to HTTP(S) inputs only and
  are ignored on an RTMP input — **input-side recovery is a Node-level respawn owned by
  `DestinationForward`**, on its own faster schedule (0.5/1/2/5/10 s, then 10 s forever, against the
  encoder's 2/5/10/20/30 s; `createForwardReconnectPolicy` in `reconnectPolicy.ts` shares every
  other budget rule with the encoder's policy).
  **Measured against real binaries** (a real Debian-bookworm `ffmpeg 5.1.9` from this repo's own
  image, reading a real `bluenviron/mediamtx:1.21.0`, on an isolated docker network — the same
  standard as the MediaMTX findings below):
  - **The output timeline starts at 0 even for a relay joining a session already hours in.**
    MediaMTX hands a new reader the source's timeline *verbatim* — an input baseline probe on a
    121.3 s-old session read `dts_time=121.230000`, and a relay attaching 263 s in logged
    `Duration: N/A, start: 263.801000` — yet ffprobe of the exact bytes that relay produced shows
    `format|start_time=0.000000` and a first `dts_time=0.000000`. `-fflags +genpts` is not needed
    and was not added. **Nuance worth keeping straight: a control run with `-avoid_negative_ts
    make_zero` REMOVED produced 0.000000 too** — ffmpeg's default (`auto`) already re-bases for the
    flv muxer under `-c copy`, so the flag is explicitness/portability insurance for ingest servers
    that might not tolerate the default, not the mechanism that produces the zero.
  - **A late-joining reader is handed a keyframe first, every time.** Three fresh readers ~8 s apart
    (so at different phases of the 2 s GOP) each began at `flags=K_` on exactly a GOP boundary —
    `pts_time` 186.023, 194.023, 202.023 — with the following five packets non-key. MediaMTX serves
    from the most recent IDR, not from the live write head, so **the design's "the relay may need to
    buffer to the first keyframe itself" contingency is closed, not deferred**, and a toggle-on does
    not show garbage at the destination.
  - **The relay dies 0.242 s after its publisher goes away — but exits 0, not non-zero.** Its stderr
    ends `rtmp://…: Input/output error` plus the flv muxer's `Failed to update header` lines, and
    ffmpeg treats a demuxer-side EOF as a successful end of stream. `handleRelayExit()` correctly
    **does not branch on the exit code at all** (it holds if the source isn't publishing, otherwise
    goes to `evaluateRetry`; `exitCode` is interpolated only into the give-up message) — *do not*
    "optimise" it by treating exit 0 as a clean intentional stop, which would silently disable
    source-loss recovery, and which no fake-based unit test could catch because the fakes choose
    their own exit codes.
  - **A MediaMTX bounce kills both layers, and neither ffmpeg reconnects on its own.** `docker
    restart` on the relay container took the publisher (exit 1, `Conversion failed!` — an *encoding*
    process whose output write failed) and the forward relay (exit 0, the same demuxer EOF as above)
    down at ~0.4 s, both within the same poll interval. That is exactly why both Node-level respawn
    layers are load-bearing: the local stream recovers first via `StreamController`'s reconnect, and
    forwards then reconnect against it, holding while it is `reconnecting`. MediaMTX came back with
    the same two listeners and re-authenticated a fresh publisher against the callback with **no
    config reload**.
  - **Acceptance:** a real RTMP ingest server takes `buildRelayProcessArgs`' argv unchanged
    (`stream is available and online, 2 tracks (H264, MPEG-4 Audio)`), 1280x720@30 H.264 + 44.1 kHz
    AAC passed through bit for bit, relay stderr free of fatal lines.
- **Auto-advance.** `StreamController` listens for `AudioRelay`'s current decode child's `close`
  (fired once the track file naturally ends) and advances the queue. A `sessionGeneration` counter
  (renamed from the FIFO-era `segmentGeneration` — there's no more per-segment process for
  "segment" to describe) distinguishes a natural end-of-track from a track that was deliberately
  superseded (next/previous/pause/stop/start), preventing double-advance.
- **Async duration probe.** `buildOverlay`/`getAudioDurationSeconds` run `ffprobe` asynchronously
  (never `execFileSync`, which would block Node's entire event loop). Because feeding a track has
  an `await` point, `feedCurrentTrack` re-checks `sessionGeneration` *and* `state === 'streaming'`
  right after the probe resolves, before calling into `AudioRelay`/`CanvasFeeder` — otherwise a
  command that arrived during the probe (next/previous/pause/stop, or the encoder dying) could feed
  a stale/superseded track. A track's `durationSeconds` is also probed once at upload time and
  cached on the `Track` row, so playlist listings don't need to re-probe.
- **Overlay.** Each rendered canvas frame composites background + a pre-rendered overlay PNG
  (cover art, title, playlist window — from the selected `StreamTemplate`, or a built-in default
  layout when none is selected) via ffmpeg's `overlay` filter, plus an optional native `drawtext`
  for the template's `timer` element (ticking elapsed/total) layered on top — see "Overlay
  templates" below for the full rework this landed as part of, including Stage 2 (below), which is
  what actually produces this "one persistent encoder" shape.
- **Session states:** `idle` → `streaming` ⇄ `paused` → `idle`, with `reconnecting` while a respawn
  is pending; an unexpected encoder exit that reconnect gives up on sets `error`, from which
  `start()` recovers — it tears down the errored controller's still-alive collaborators
  (`CanvasFeeder`'s heartbeat, `AudioRelay`'s decode process) via `stop()` before wiring a fresh one
  (`LocalStreamManager.start()`; skipped for an already-`idle` controller, which has nothing left to
  tear down). `'starting'` is a status-layer state `LocalStreamManager` adds on top; `StreamController`
  itself never produces it.
- **Stream keys at rest.** `StreamDestination.streamKeyEncrypted` is AES-256-GCM-encrypted
  (`src/crypto/streamKeyCipher.ts`) with `STREAM_KEY_ENCRYPTION_KEY`; the plaintext key is never
  echoed back by the API (`toPublicDestination` omits it) and is only decrypted in-memory when a
  stream starts.
- **`StreamDestinationProvider` / `OAuthProviderAdapter` split.** How a destination is *connected*
  (OAuth2 authorization code flow, provider-generic via `OAuthProviderAdapter` — currently just
  `YoutubeOAuthAdapter`) is a separate concern from how a *broadcast* is prepared for it
  (`StreamDestinationProvider` — `CustomRtmpProvider` for a manually-entered RTMP URL/key,
  `YoutubeProvider` for an OAuth-connected YouTube channel). **`prepareSession()` is now called by a
  `DestinationForward` on toggle-on**, not by any stream-start path: the local encode has no
  destination in it, so nothing else in the app has a reason to ask a provider for anything. It
  returns the RTMP ingest URL/key the forward's `RelayProcess` pushes at, plus an optional
  `DestinationLifecycle` handle (a custom RTMP destination has none — it has no broadcast concept at
  all). `OAuthConnection` (refresh token, external account id/name) is itself provider-generic —
  keyed by `destinationId` and a `provider` string — so a future OAuth-based provider doesn't need
  its own connection table.

  **For YouTube, only the `liveBroadcast` is ephemeral now; the `liveStream` is persisted and
  reused.** `StreamDestination.youtubeLiveStreamId` remembers the destination's ingest endpoint
  across every toggle: `prepareSession()` verifies a persisted id with `getStream` (YouTube reports
  a stream the user deleted in Studio as an *empty result*, not an error, so this is a verify-then-
  fall-back, never a blind reuse), creates and re-persists a fresh one only when that comes back
  empty, then creates the per-toggle broadcast and binds it. **`finalize()` transitions the
  broadcast to `complete` and deliberately does NOT delete the stream** — which is what closes the
  old "the ephemeral `liveStream` is orphaned because `finalize()`'s own token refresh failed"
  failure class outright, rather than narrowing it. It is also why `DestinationForward
  .setDestination()` exists and why `LocalStreamManager` re-applies a freshly-read row on *every*
  `getOrCreateForward()` and once more from `start()` (`refreshForwardRows`): `prepareSession()`
  persists that id to the **database**, not back onto whatever row object the caller passed in, so a
  long-lived forward reading its construction-time copy would keep seeing `null` and leak a brand-new
  liveStream on every single toggle.
  **`watchUrl()` returns the channel's stable `/live` link for a PUBLIC broadcast** —
  `https://www.youtube.com/channel/{externalAccountId}/live`, one link that survives every toggle,
  where a per-broadcast `watch?v=` URL dies the moment the destination is toggled off and nobody
  following the old link migrates. For anything *but* public it falls back to
  `https://www.youtube.com/watch?v={broadcast.id}`, because YouTube's channel `/live` page only ever
  resolves a public broadcast — using the stable link for an unlisted/private one would 404 for the
  owner's own viewers. Both behaviours were confirmed against a real channel: a public toggle-on
  returned `.../channel/UC46DVVfzwsCsRLBrZbsiH6Q/live`, and two private toggle-ons of the same
  destination returned two different `watch?v=` URLs (`8pqXEKOnZRM`, then `Hb35d8fAwNk`) while the DB's
  `youtubeLiveStreamId` stayed **byte-identical** (`46DVVfzwsCsRLBrZbsiH6Q1789396296003933`) across
  the whole off→on cycle, with `local.state` never leaving `streaming`.
  **Measured Data API quota cost: ~7 units per full prepare→live→finalize cycle** — the Google Cloud
  Console reported **29 of 10,000 units for a whole day** covering roughly four full cycles (plus an
  auth-failure attempt and a delete-while-live finalize). That is **40-50x cheaper than the design
  spec's ~330 units/cycle estimate**, which had made a per-user toggle rate limit look urgent: the
  default quota supports on the order of **1,000+ toggle cycles/day for the entire app**, not the
  ~30 the estimate implied. Size any future rate limit off the measured number, not the estimate.
  **Timing, measured end to end:** toggle-on → `preparing` immediately (in the toggle response
  itself), `connecting`/`provider.phase: waitingForYoutube` a few seconds later, `live` at
  **~13-18 s** overall (connecting→live 5-15 s at 5 s poll granularity), within the design's 10-40 s
  estimate and at the fast end of it. `stop()` genuinely **waits** for each forward's provider-side
  finalize before its HTTP response returns — measured at **1.11 s**, with `destinations: []` and
  `local.state: "idle"` already in that same response, not fire-and-forget.
- **Ownership checks.** Every track/playlist/destination/template/preset route verifies the
  resource belongs to the authenticated user: 404 if the resource doesn't exist, 403 if it exists
  but belongs to someone else. The local-stream routes mostly have **no id to check** (one stream
  per account, resolved from the session cookie); the one place an id does arrive —
  `PUT /local-stream/destinations/{destinationId}` (`POST /local-stream/start` carries no
  destination id of its own at all) — goes through `LocalStreamManager.requireOwnedDestination()`,
  which 404s/403s the same way, **before any side effect**: a bad or foreign id must not mint a
  relay token, register MediaMTX credentials or build a scene. Ids referenced from a request **body** into the
  caller's own resource (`PUT /playlists/{id}/tracks`'s `trackIds`) are instead validated against
  the caller's own tracks and rejected with 400 — not 403/404 — so playlist membership can't leak
  which ids exist for other users. (A preset's body ids are the exception that proves the rule: a
  preset is a private object of the caller's with no membership to leak, so they answer 404/403.)

- **Saved presets, not sessions.** The `StreamSession` (+ `StreamSessionDestination`) tables
  survive, **repurposed**: they no longer represent "the running thing" — the running thing is the
  one in-memory local stream per account — but a named, saved **preset** (playlist + template +
  destination checklist + broadcast metadata) to pre-populate the next start with. Read through
  `StreamPresetRepository`/`createStreamPresetRouter` at `/stream-presets`. The model/table names
  were deliberately left alone so the repurposing costs no rename and no data migration; only the
  TypeScript layer is named `StreamPreset*`. A preset has zero side effects — routes plus repository
  with no manager in between, exactly like playlists/destinations/templates — and **zero
  destinations is a valid preset**, where the old `StreamSession` required a non-empty list because
  fanning out to destinations was its only reason to exist. Twitch still has no dedicated
  `StreamDestinationProvider`/OAuth adapter (deliberately out of MVP scope) — it's just a `custom`
  destination pointed at `rtmp://live.twitch.tv/app` with the channel's stream key, which works
  through the existing `CustomRtmpProvider` path and is forwarded exactly like any other.
- **The playlist window's insert animation (fd 7 / `pipe:7`, burst-only).** The settled window
  stays baked in the canvas (`playlistWindowNode`, byte-identical to before) from
  `PlaylistQueue.windowSnapshot()`, which now lists queued tracks alongside the base playlist. When
  the template has a playlist element, a yuva420p `pipe:7` exists for the whole session. A
  `PlaylistWindowFeeder` keeps it fed with a transparent idle frame (`RawFramePacer`, extracted
  from `PulseVisualizer` behaviour-identically) so ffmpeg's overlay frame-sync never stalls waiting
  on it. On a visible insert, `PlaylistWindowAnimator` runs frame 0 (== the baked window) → hold →
  canvas A (window omitted) → hold → a 600ms animation (the SAME Satori node as the baked window,
  animated via row `maxHeight`/`opacity`/`margin`, rendered in its own dedicated piscina pool,
  `useAtomics: false`) → canvas B (window with the new rows) → hold → idle. Every switch overlaps
  identical content for `HANDOFF_HOLD_MS` = 2 canvas heartbeats (400ms), so it never matters which
  of the two never-frame-synchronized inputs ffmpeg's compositor samples first. Composited directly
  above whichever canvas layer the playlist element is baked into (before the equalizer). Why not
  ffmpeg-side motion: a real spike proved `sendcmd`/`zmq` reach `overlay`/`drawbox`, which answer
  `Function not implemented` for a runtime x/y command — ffmpeg composites a static-position overlay
  only, so the motion has to be rendered frame-by-frame in Node and streamed in, not commanded.

  **Verified against real binaries** (deployed to the 192.168.14.26 stand, a real account's stream,
  real ffmpeg 5.1.9, real MediaMTX 1.21.0, real HLS output captured via the authenticated preview
  proxy over ~15 minutes including two real donation-triggered bursts — narrower than an isolated
  A/B-with-and-without-pipe:7 harness would give, but against the actual production pipeline rather
  than a synthetic one; see the design doc's Phase C plan, Task 10, for the fuller harness this
  substituted for):
  - **The encoder accepts `pipe:7` and never stalls on it.** Real startup log: `Input #3, rawvideo,
    from 'pipe:7': ... 704x342, 144460 kb/s, 30 tbr, 30 tbn`, correctly mapped into the filter graph
    (`Stream #3:0 (rawvideo) -> format:default (graph 0)`) and composited (`overlay:default (graph
    0) -> Stream #0:0 (libx264)`). The stream ran steadily the whole session; zero errors, crashes
    or stalls in the backend log across the whole test window (~5 min of log checked, spanning two
    triggered bursts).
  - **Idle steady-state cost** (main encoder ffmpeg, sampled via two `/proc/<pid>/stat` reads 10s
    apart — no `ps` binary in the deploy image): **~104% of one CPU core**, RSS **~148 MiB**, with
    the playlist window present but transparent (idle). Node's own process stayed near-idle between
    renders. **No isolated same-host measurement without `pipe:7` was taken this session — this
    number is NOT a verified delta against a no-`pipe:7` baseline**: the only other number on record
    (~68% CPU) was measured on a different host, a different template and a different method, so
    the two are not comparable, and the plan's own fallback rule (drop `PLAYLIST_WINDOW_FPS` to 15
    if the encoder's CPU exceeds a genuine no-`pipe:7` baseline by more than 10 percentage points)
    cannot honestly be called "not triggered" from this data — the only number available (a 36-point
    gap) points the other way. `PLAYLIST_WINDOW_FPS` stays at `VIDEO_FPS` (30) for now because
    nothing OBSERVED during the live test (no dropped frames, no growing latency, no stall)
    indicated a real problem, but this is provisional: run the real A-vs-B (same host, same
    template, a build with `pipe:7` vs one without) before trusting the capacity math in
    `MAX_CONCURRENT_LOCAL_STREAMS`, which is sized off the encoder's own cost.
  - **A real donation visibly, correctly inserts a row into the baked window**, confirmed by
    downloading real HLS `.ts` segments through the authenticated preview proxy before and after a
    real `libraryTrackRequest` donation and extracting frames with `ffmpeg` (cropped to the
    `computePlaylistWindowRegion` box): the pre-donation frame showed the ordinary 3-row window: the
    donated track then appeared as an extra row in exactly the position `windowSnapshot()` predicts
    (immediately after the current-track row), with the base after-context row still correctly
    following it — 4 rows total, no corruption, no duplicate/missing rows, no stale content left
    over from the transition. The two segments spanning the actual burst were measurably larger than
    steady-state segments (~130 KB vs ~108-111 KB for the same 2s duration) — **consistent with**
    the animation's extra motion being encoded (canvas A and canvas B's own re-bakes would also
    enlarge those segments, and no mid-animation frame was captured to isolate the two causes, so
    this is corroborating, not conclusive).
  - **Burst cost stays off the main encoder.** Sampling the encoder's own CPU ticks immediately
    before, at, and 2s after triggering a fresh burst showed no meaningful spike on the persistent
    encoder process itself — consistent with the design (burst rendering happens in Node's piscina
    pool and short-lived one-shot `ffmpeg` renders, not inside the long-lived encoder). One
    additional short-lived `ffmpeg` process (RSS ~55 MiB) was observed appearing and disappearing
    around a trigger, consistent with `CanvasFeeder`'s one-shot canvas-A/canvas-B renders firing as
    part of the handoff.
  - **Not measured this session** (narrower scope than the plan's full Task 10 harness — this was a
    deliberate scoping decision by the orchestrator, reusing this session's own deploy/capture
    tooling against the real demo stand instead of building the plan's isolated-container harness
    from scratch): a true idle-vs-baseline A/B without `pipe:7` present at all (see above — this is
    the one gap worth closing before trusting capacity numbers);
    frame-accurate motion capture of the animation in progress (only before/after settled states
    were captured, not the moving frames themselves); the elaborate per-frame luma-histogram/
    row-projection pixel forensics (handoff-overlap deviation, colour-match tolerance, fringe
    detection) the plan's Task 10 originally specified; exact wall-clock donation-to-visible latency
    (bounded well under the observation window, not measured to the millisecond). If any of these
    become load-bearing later (e.g. investigating a reported visual glitch), build the isolated
    harness the original plan describes rather than re-deriving these from production captures.

**Local relay (MediaMTX).** Every stream publishes into a `bluenviron/mediamtx:1.21.0`
container (`docker/mediamtx.yml`, mounted read-only, plus the `mediamtx` service in
`docker-compose.yml` with a 512m memory limit and `restart: unless-stopped`). The image is pinned to
an exact version, never `:latest` — every behaviour below was read out of that version's source
tree, and this one container is shared by every tenant.

Since the unified rework the relay has **two classes of reader**, not one: the authenticated HLS
preview proxy (`/local-stream/preview/*`, using the read secret as a Basic `Authorization` header),
and **one RTMP reader per enabled destination forward** (`RelayProcess`, using the `sub` credential
in the query string). Both present the same per-session read credential `LocalRelayTarget` has been
minting since Phase A — the `sub` half was built then and simply had no consumer yet, so nothing
about the credential model changed to add forwards. Publishing is still exactly one process, the
local `PersistentEncoder`. **Layer 0's no-published-ports rule is unchanged and still enforced by
`test/infra/mediamtxConfig.test.ts`**: forwards read the relay from *inside* the compose network,
so adding them needed no new exposure whatsoever.

Three layers make it safe:

- **Layer 0 — the network.** The service has **no `ports:` entry at all**, and must never get one:
  it is reachable only as `mediamtx` on the compose network, so nothing outside the host can speak
  RTMP or HLS to it even holding a valid credential — and every non-RTMP/HLS surface the config
  names (`api`, `metrics`, `pprof`, `playback`, `rtsp`, `webrtc`, `srt`, `moq`) is `false`. **That
  list is a denylist, not an inventory**: Task 12's smoke run caught v1.21.0 also starting `[MoQ] …
  listeners on :8892 (TCP/HTTP2), :8892 (UDP/HTTP3), :8893 (UDP/QUIC)` — `moq` defaults to enabled
  and the config didn't name it (it even self-generates a TLS key at startup to do it). `moq: false`
  is now in `docker/mediamtx.yml` and asserted by the invariant test. Re-audited since, against a
  real 1.21.0 booted from this repo's committed config verbatim, on both an initial start and a
  post-`docker restart` one: the startup log is **only** `[RTMP] started with listener on :1935
  (TCP/RTMP)` and `[HLS] started with listener on :8888 (TCP/HTTP)` — no MoQ, API, metrics, pprof,
  RTSP, WebRTC or SRT line. The underlying lesson still stands, though —
  a version bump can silently outrun this list again, so re-read MediaMTX's own `started with
  listener on …` lines whenever the pinned version changes. This layer's port rule is the
  actual trust boundary; everything else is defense in depth. Because it is one careless line away
  from being undone, it's enforced by an automated test — **`test/infra/mediamtxConfig.test.ts`**
  parses both YAML files and fails the build if a `ports:` entry, an enabled control surface, or a
  catch-all path reappears. Don't weaken it "just to check whether it's reachable".
- **Layer 1 — the path.** Exactly one regex path, `~^live/[0-9a-f]{32}$`, and **no `all_others`
  entry**: anything that isn't a 128-bit lowercase-hex token is rejected by MediaMTX outright,
  before the auth callback is consulted at all. The token is minted per *start* (not per user, never
  persisted, never returned by any API), so a path leaked from an earlier session is worthless once
  that session ends.
- **Layer 2 — the callback.** `authMethod: http`: MediaMTX POSTs every publish/read attempt to the
  backend's `MediaMtxAuthRegistry` (`src/stream/mediaMtxAuth.ts`), an in-memory `path → {publish
  secret, read secret}` map. In memory on purpose — stopping a stream revokes its credentials
  instantly (unlike a JWT, which stays valid until it expires) and neither adding nor removing a
  session ever needs a MediaMTX config reload. Fail-closed by construction: MediaMTX allows only on
  a 2xx, so an unregistered path, an unknown action, a malformed body, an unexpected throw, or a
  backend that is simply down all deny. It listens on its **own** unpublished port
  (`MEDIAMTX_AUTH_PORT`, default 3001 — a second `listen()` in `main.ts` over a separate Express app)
  rather than being mounted on the public API, because MediaMTX is not a browser and cannot present
  the session cookie `requireAuth` needs.

Two carrier shapes here were read out of the pinned v1.21.0 source rather than assumed, and each
overrode what the design spec originally called for:

- **RTMP credentials travel as query parameters, not as URL userinfo.**
  `internal/servers/rtmp/conn.go` does `query := c.rconn.URL.Query()` then `User: query.Get("user"),
  Pass: query.Get("pass")` in both `runPublish()` and `runRead()`; the `rtmp://user:pass@host/...`
  userinfo form is documented for RTSP, **not** RTMP. So `LocalRelayTarget`
  (`src/stream/localRelayTarget.ts`) splits one credentialed URL across the two fields
  `buildPersistentEncoderArgs` already takes — `rtmpUrl = rtmp://mediamtx:1935/live`,
  `streamKey = <token>?user=pub&pass=<publishSecret>` — so its existing `` `${rtmpUrl}/${streamKey}` ``
  concatenation yields `rtmp://mediamtx:1935/live/<token>?user=pub&pass=<secret>` and
  **`persistentEncoderArgs.ts`/`persistentEncoder.ts` are not modified by the local-first path at
  all**. Publish and read use different usernames (`pub`/`sub`) *and* different secrets, so a leaked
  read credential can never publish over the path. HLS reads instead present the read secret as a
  Basic `Authorization` header, since HTTP-based protocols don't take the query-string form.
- **The auth callback's shared secret travels as a URL path segment, not a header.**
  `internal/auth/manager.go` does `httpClient.Post(m.HTTPAddress, "application/json", ...)` — it
  sets **no custom headers** and substitutes no placeholders in `authHTTPAddress` — so the spec's
  "shared-secret header" is impossible. `MTX_AUTHHTTPADDRESS` is therefore
  `http://super-dj:3001/internal/mediamtx-auth/<MEDIAMTX_AUTH_SECRET>`, compared with
  `timingSafeEqual`, and supplied by environment so the secret never lands in the committed
  `mediamtx.yml` — which leaves `authHTTPAddress:` empty in the committed file on purpose. If
  `MEDIAMTX_AUTH_SECRET` is ever unset, Compose substitutes an empty string rather than
  failing — but `loadConfig()` (`src/config/env.ts`) requires the variable and throws before
  the backend ever boots, which is the actual fail-closed mechanism; even without that guard,
  the resulting path (`/internal/mediamtx-auth/`, trailing slash, no secret segment) wouldn't
  match the route and would 404 — itself still a deny.

**Verified against a real binary** (Task 12's smoke test: a real Debian-bookworm `ffmpeg 5.1.9`
from this repo's own image publishing into a real `bluenviron/mediamtx:1.21.0`, on an isolated
docker network with a throwaway auth stub). The exact body the auth endpoint receives, copied from
that stub's log:

```
AUTH /internal/mediamtx-auth/smoke-secret {"ip":"172.26.0.4","user":"pub","password":"pubsecret",
"token":"pubsecret","action":"publish","path":"live/abcdef0123456789abcdef0123456789",
"protocol":"rtmp","id":"0ef094e9-06b9-499e-8d66-5a394be00186","query":"user=pub&pass=pubsecret",
"userAgent":"FMLE/3.0 (compatible; Lavf59.27.100)"}
```

`path` really does arrive as `live/<token>` with **no leading slash** and `action` as the literal
`publish`/`read`, so `MediaMtxAuthRegistry` matches it as written. One detail that was *not*
predicted: **`token` carries a copy of the password**, so the publish secret appears three times in
the body (`password`, `token`, `query`). `authorize()` ignores `token` and compares `user` +
`password` only, which is still correct — but do not start trusting `token` as if it were a
separate credential. Also confirmed on that run: `-f flv "rtmp://…/live/<token>?user=pub&pass=…"`
is accepted by that ffmpeg build unchanged, MediaMTX logs `is publishing to path
'live/abcdef…'`; a wrong password is denied (`[rtmp] Server error: authentication failed`, ffmpeg
exit 1, MediaMTX `failed to authenticate: server replied with code 401`); and a path that does not
match the Layer 1 regex is rejected as `path 'live/short' is not configured` **without the auth
endpoint being called at all** — Layer 1 really does short-circuit ahead of Layer 2.

**The HLS read leg needed two corrections the design did not anticipate, both found by Task 12's
smoke test and both fixed (and re-verified against a real MediaMTX 1.21.0) by Task 13:**

1. **Playlist child references carry a REQUIRED `?session=<uuid>` query string**, and the proxy
   originally dropped it. Real output: `index.m3u8` (200) references
   `main_stream.m3u8?session=5c973b5e-…`, whose own playlist references
   `e6e8ed7f85d9_main_seg0.ts?session=5c973b5e-…`. The references *are* relative (so no playlist
   rewriting is needed, as assumed), and the bare file names do pass the route's `ALLOWED_FILE`
   regex — but the route built its upstream URL as `` `${target.hlsBaseUrl}/${fileName}` `` from
   `req.params.file`, which in Express excludes the query string. Fetched without `?session=`,
   MediaMTX answers **401** `{"status":"error","error":"authentication error"}` for both the media
   playlist and every segment — and does not even consult the auth endpoint, because for child
   files the session id, not the `Authorization` header, is the credential (the header only
   authenticates the `index.m3u8` entry point, which is what mints the session). `proxy()` now
   appends the inbound query verbatim (`req.url`'s substring from the first `?`), **after** the
   `ALLOWED_FILE` check, which therefore still guards the file name alone and never the query.
   Re-verified end to end through the real running backend against a real MediaMTX: with the query,
   the media playlist returns 200 `application/vnd.apple.mpegurl` and the segment 200 `video/mp2t`
   (85 540 bytes, first byte `0x47`); with it stripped, both still 401 — so the session id really is
   what makes the difference.
2. **The first request of every HLS session is answered with a `cookieCheck` 302**, before any
   authentication: `302 Found`, `Location: /live/<token>/index.m3u8?cookieCheck=1`,
   `Set-Cookie: cookieCheck=1; HttpOnly; Secure; SameSite=None; Partitioned`. The proxy survives
   this because `createPreviewFetch()` uses Node's global `fetch`, which follows redirects and
   re-sends the `Authorization` header on the same-origin hop (confirmed: `redirected: true`, final
   200). That used to be an implicit default it silently relied on; it now passes
   `redirect: 'follow'` explicitly, so a future client swap that does not follow redirects is a
   visible change rather than a silent breakage into bare 302s with no `Location`.

What held on the read leg unchanged: from a fresh publish, `index.m3u8` 404s
(`{"status":"error","error":"no stream is available on path 'live/…'"}`) for a few seconds (measured
2.4 s with a stub publisher, ~6.4 s through the real encoder, which has a template render and a
track probe to do first) and then returns 200 with a segment already available. And the credential
split works: no credentials → 401, wrong read secret → 401, and the **publish** credential used for
a read → 401. What did **not** hold is the assumption in that first sentence's original wording —
that `HlsPlayer`'s retry logic coped with that window at all. It did not; see item 3 below.

**Two further corrections, found after Phase A shipped, both on the CLIENT half of the read leg —
and both of which first presented as server-side faults.** Same standard of evidence as items 1
and 2: reproduced and then re-verified against a real MediaMTX 1.21.0, a real ffmpeg publisher, the
real hls.js 1.7.3 the app bundles, and a real headless Google Chrome — item 3 on an isolated docker
network, item 4 against the deployed stand's own encoder/relay/proxy:

3. **A preview whose first read lands before MediaMTX's own "stream is available and online"
   transition used to hang forever, until a manual page reload.** Confirmed from the deployed
   stand's own MediaMTX log: at `09:25:09` an RTMP connection opened and two HLS sessions were
   logged, at `09:25:11` the path went online — and for the next **nine minutes**, while the encoder
   happily advanced tracks, MediaMTX logged no further HLS session and never created a muxer for
   that path. Three separate facts combine into that, each verified rather than assumed:
   - **A `[HLS] [session …] created by` line does not mean a session exists.**
     `internal/servers/hls/session.go` logs it *before* calling `pathManager.AddReader`, so a
     request that 404s ("no stream is available") still logs one. A session line with no
     `[muxer …] created` line after it is simply a 404 — which is what every one of those
     never-worked sessions was.
   - **The redirect chain is not the culprit, and does not duplicate sessions.** Measured directly:
     one proxy-shaped fetch (`redirect: 'follow'`) produces exactly **one** MediaMTX session and one
     `authHTTP` callback, even though it is two HTTP hops — the `cookieCheck` 302 is written at
     `http_server.go:289`, well before the session struct at `:315`. Two session lines therefore
     mean two real client requests, not one request seen twice.
   - **hls.js never retries a 4xx, and `hls.startLoad()` cannot recover a manifest that never
     loaded.** `retryForHttpStatus` (hls.js 1.7.3) excludes 400-499 outright, so no
     `manifestLoadPolicy` tuning can make the on-demand 404 retryable; the playlist loader marks a
     failed MANIFEST context `fatal`. And with no manifest ever parsed there is no level, so
     `LevelController.startLoad()` → `loadPlaylist()` → `shouldLoadPlaylist(undefined)` is a no-op:
     the old `ERROR` handler's `hls.startLoad()` never re-requested `index.m3u8` at all.

   Reproduced end to end (real Chrome, real MediaMTX, real ffmpeg, first read 1.2 s ahead of the
   publisher): `PROXY index.m3u8 -> 404` … `ERROR fatal=true details=manifestLoadError
   httpStatus=404` … `recovery: hls.startLoad()` … then **zero** further requests, `readyState=0`,
   `currentTime=0.00` for the next 40 s while the path was online and healthy.

   The same dead end has a second trigger that does not need the startup window at all: MediaMTX
   bakes a `?session=<uuid>` into every child reference, that session id is the credential for child
   requests, and MediaMTX destroys it with its muxer (measured: `hlsMuxerCloseAfter` 60 s idle, or
   the publisher dropping). `startLoad()` then reloads the **same** session-scoped level URI, which
   401s forever. Reproduced: a player that had been happily playing froze at `currentTime=15.94`
   and hammered `main_stream.m3u8?session=efc5ef90-…` with 401s for 80 s straight — including the
   final 40 s, during which the publisher was back and the path was online again.

   **Fix (`frontend/src/components/HlsPlayer.tsx`): a fatal error destroys and rebuilds the whole
   `Hls` instance** — the only recovery that re-fetches `index.m3u8` and so makes MediaMTX mint a
   fresh session — on a backoff of 500/1000/1500/2000/3000/5000/8000 ms whose last value repeats
   **forever**, reset whenever a manifest parses. A fatal media error still gets one in-place
   `recoverMediaError()` first, and falls through to a rebuild if it recurs. Re-verified under the
   identical conditions that reproduced each failure: startup race → rebuilds #1-#3 through the 404
   window, `index.m3u8 -> 200` at t+7.07 s, `MANIFEST_PARSED`, `currentTime` climbing 0.26 → 38.26 s
   at `readyState=4`, 20 segments fetched; mid-playback session loss → rebuilds #1-#8 backing off to
   a steady 8 s poll (MediaMTX logging a brand-new session per attempt: `190dca5f`, `4d475da7`,
   `1bee8919`, `1650122c`, `2c298463`, `96c80e9f`, `d9386a85`, all 404), then 7 s after the
   publisher returned, `session 0c8ec684` → `muxer … created` → `MANIFEST_PARSED (backoff reset)`
   and playback resumed, with no page reload.

   No backend defect was found. The proxy, `createPreviewFetch`'s redirect handling, and
   `previewReady`'s timing all behave as documented; passing MediaMTX's 404 straight through is
   still right, and nothing on the server side was changed for this.

4. **A preview built while the browser tab is HIDDEN never loads a single fragment — and the
   symptom points convincingly at the server.** Reported as "the manifest and the media playlist
   both load, 200, every ~2 s, forever, and hls.js never issues one `.ts` request; `readyState`
   stays 0; no `ERROR` event ever fires." Every server-side suspect was measured and cleared
   against the real deployed stand (real persistent encoder → real MediaMTX 1.21.0 → the real
   `/local-stream/preview` proxy), so record them here so they are not re-investigated:
   - The multivariant playlist is well-formed: `#EXT-X-INDEPENDENT-SEGMENTS`,
     `CODECS="avc1.42c01f,mp4a.40.2"`, `RESOLUTION=1280x720`, `FRAME-RATE=30.000`.
   - The media playlist is well-formed and carries an `#EXT-X-PROGRAM-DATE-TIME` before **every**
     segment (not just the first), `#EXT-X-TARGETDURATION:2`, seven `#EXTINF:2.00000` entries.
   - Proxy response headers are correct: `content-type: application/vnd.apple.mpegurl` for both
     playlists, **`video/mp2t` for segments** (so the extension-fallback map in
     `localStreamPreviewRoutes.ts` is never even reached), `cache-control: no-store` throughout.
   - The segments are structurally fine: `ffprobe` on a live one shows H.264 Constrained Baseline
     L3.1 1280x720 + AAC-LC 44.1 kHz stereo, the first video packet of the segment flagged `K_`
     (keyframe) at `pts_time 42.023`, audio starting 4.8 ms later at `42.028` — no missing IDR, no
     audio/video PTS divergence, no discontinuity (`cc [0,0]`).
   - `PTSKnown: false` / `alignedSliding: false` on every `LEVEL_UPDATED` are *consequences*, not
     causes: both flip true the instant the first fragment is parsed. So is `startPosition: -1` —
     for a live playlist that is hls.js's deliberate sentinel (`base-stream-controller.ts`
     `setStartPosition`: "Leave this.startPosition at -1, so that we can use `getInitialLiveFragment`
     logic"), not a stuck value.
   - `backBufferLength: 30` is not implicated: the identical config plays fine.

   **Root cause is Chrome, and it is invisible from every one of those angles: Chrome DEFERS a
   media element's load entirely while `document.hidden` is true.** The element sits at
   `networkState === 2` (NETWORK_LOADING) and stops there; the `MediaSource` that `hls.attachMedia()`
   handed it never leaves `readyState === 'closed'`, so `sourceopen` — and therefore hls.js's
   `MEDIA_ATTACHED` — never fires. hls.js has no error path for that: `StreamController.doTickIdle()`
   returns at its very **first** gate (`!media && !primaryPrefetch && (startFragRequested ||
   !hls.config.startFragPrefetch)`) on every 100 ms tick, silently, while `LevelController` keeps
   refreshing the playlist on its own timer. Hence 200s forever, no fragment, no error.

   Measured in the reporter's own Chrome 153/Windows on the real deployed app (`visibilityState:
   "hidden"`, tab driven by an automation extension in a background window): 10 preview requests in
   17 s, **zero** `.ts`, `readyState 0`; a separately-attached `Hls` in the same page reported
   `mediaSource.readyState: "closed"`, `streamController.media: null`, and exactly two lifecycle
   events in 52 s — `MEDIA_ATTACHING`, `MANIFEST_PARSED` — with `MEDIA_ATTACHED` never among them.
   Then the one-variable confirmation, in a controlled headless Chrome against the same real stack:
   page hidden via a second tab's `bringToFront()` → `mediaSource: "closed"`, `hasMedia: false`, 0
   `FRAG_LOADING` in 15 s; `bringToFront()` back on the **same** instance → MediaSource opened,
   `FRAG_LOADING`/`FRAG_LOADED` immediately, `readyState 4`, `currentTime` 9.73 → 24.75 s.

   **Fix (`frontend/src/components/HlsPlayer.tsx`): `build()` does nothing while `document.hidden`,
   and a `visibilitychange` listener builds (or rebuilds) when the page is shown.** The rebuild half
   is gated on a `MEDIA_ATTACHED` flag, so it only fires for an instance that never attached — a
   player that *is* attached keeps buffering in a background tab, which is what a viewer who tabs
   away expects. Deliberately one-directional: becoming visible can start a player, becoming hidden
   never stops one. Re-verified A/B through real binaries, same hidden-at-mount scenario, real
   deployed backend/MediaMTX/encoder, real headless Chrome: **before** — 7 preview requests, 0
   segments, `readyState 0` for 15 s while hidden; **after** — **0 preview requests at all** while
   hidden (so a hidden tab no longer holds MediaMTX's on-demand muxer open for nobody), then on
   `bringToFront()`: 8 segments, `readyState 4`, `currentTime` 0.35 → 15.36 s. The ordinary
   visible-at-mount path is unchanged (13 segments, `currentTime` 26.63 → 29.64 s at `readyState 4`).

   No backend, MediaMTX or encoder defect was found, and nothing server-side was changed. Note the
   trap for next time: **any browser automation that drives a background window reproduces this
   100% of the time**, which makes a purely client-side, purely environmental stall look exactly
   like a server-side one.

**Overlay templates (in progress).** Rework driven by two goals at once: fix the recurring
segment-switch corruption (see "Known follow-ups" below) *and* lay the foundation for a
user-configurable overlay ("canvas editor", à la OBS scene composition — positioned cover art,
title text, playlist window, eventually custom images/fonts). Staged rollout, tracked here as it
lands:
- **Stage 0 (done):** `StreamTemplate` (Prisma) is a named, reusable, per-user overlay layout —
  `elements: Json`, an array of positioned element configs (`{type: 'cover'|'title'|'playlist',
  x, y, width, height?, fontSize?, color?}`, validated by `src/templates/templateTypes.ts`'s
  hand-rolled `isValidTemplateElement` rather than a schema library, since the element-type set
  is expected to keep growing through the later stages). `src/render/sceneRenderer.ts` renders a
  template + scene data (title, playlist lines, cover) to a PNG via **Satori** (HTML/CSS-shaped
  layout → SVG) + **@resvg/resvg-js** (SVG → PNG) — chosen over a headless-browser renderer
  (Puppeteer/Playwright) specifically because this has to re-render on the order of once a
  second *per active stream*, multi-tenant; Satori has no browser-process overhead. `POST
  /templates/{id}/preview` renders a template (or an unsaved draft passed in the body) against
  sample scene data and returns the PNG directly, for the future visual editor's live preview.
  `CustomRtmpProvider`/`YoutubeProvider`/the ffmpeg pipeline do not consume templates yet — this
  stage is renderer + CRUD only.
- **Stage 1a (done):** `renderScene()`'s output replaces the hand-built `drawtext` filter graph in
  `src/ffmpeg/segmentArgs.ts` (`overlayText.ts`'s escaping went away with it — at the time,
  `formatDuration`/`buildPlaylistWindowLines` were all that was left there; the donation
  library-track-request Phase C rework later deleted `buildPlaylistWindowLines` too, once
  `PlaylistQueue.windowSnapshot()` took over listing the window's rows — `formatDuration` alone
  remains). Still one ffmpeg process per segment, architecture otherwise untouched. Notable
  decisions from this stage, since they're easy to
  second-guess without the context:
  - **`templateId` is optional, not required** (today on `POST /local-stream/start` and
    `POST /stream-presets`; at the time, on the two now-deleted start routes) — deliberately, so a
    stream can go out with no template configured at all rather than 400ing. At the time this stage landed, no visual editor existed yet (Stage 3,
    now done — see below) and a template could only be authored via a direct API call; the
    optionality itself remains the right default now that the editor exists too. Omitting it uses
    `DEFAULT_TEMPLATE_ELEMENTS` (`src/templates/templateTypes.ts`), a built-in layout that
    approximates the old drawtext positions, so a user who never configures a template doesn't
    lose cover/title/playlist entirely.
  - **Rendering runs in a `piscina` worker-thread pool** (`src/render/renderWorkerPool.ts` +
    `renderWorker.ts`), not inline — Resvg's SVG→PNG rasterization is synchronous native CPU
    work, and this pipeline re-renders on the order of once per track switch *per active stream*,
    multi-tenant; running it on the main thread would stall every other stream's ffmpeg feeding
    and every other in-flight HTTP request while it runs. `renderTemplatePng()`
    (`src/render/renderOverlay.ts`) is the one shared entry point both `/templates/{id}/preview`
    and the live pipeline call — but each owns a **different failure policy**: preview lets a
    render error propagate as a real 500 (someone testing a template needs to see it broke);
    `buildStreamScene`'s `buildOverlay` closure catches it and falls back to `BLANK_OVERLAY_PNG`
    (`src/render/blankOverlay.ts` — a hand-built-via-`zlib` transparent 1×1 PNG, deliberately
    *not* generated through Satori/resvg, so the fallback still works even if that pipeline
    itself is what's broken) — keeping the RTMP connection up matters more than one segment's
    picture.
  - **`Buffer`s crossing the piscina worker boundary need rewrapping, in both directions.**
    `postMessage` structured clone (what piscina uses to hand data to/from a worker) has no
    concept of Node's `Buffer` subclass, only the plain `Uint8Array` it's built on — a value that
    was a real `Buffer` on one side of the boundary arrives a plain `Uint8Array` on the other.
    Found live (not by a unit test — every unit test mocks the pool boundary, and the one real
    end-to-end render test, `sceneRenderer.test.ts`, doesn't go through the pool at all) in two
    separate spots, both fixed by re-wrapping with `Buffer.from(x.buffer, x.byteOffset,
    x.byteLength)`: (1) `renderViaPool()`'s return value — Express's `res.send()` silently
    JSON-serializes anything that isn't `Buffer.isBuffer() === true` instead of erroring, so
    `/templates/{id}/preview` was returning a `{"0":137,"1":80,...}` body with a 200 and an
    `image/png` content-type; (2) `fontData` on the way *into* `renderWorker.ts` — Satori's font
    parsing doesn't throw on a plain `Uint8Array`, it just silently produces missing-glyph boxes
    for anything outside ASCII, which only showed up when previewing real Cyrillic text.
  - **The overlay PNG is written to a fixed per-scene path before every render** (`sceneId`, which
    the unified model makes simply the `userId` — one pipeline per account), superseded
    at Stage 2 (below) into `CanvasFeeder.render()` — including a pause, which still calls
    `render()` (to update the frozen timer text) but composites the *same* overlay PNG, since
    pausing only changes the audio, never the picture. The file is cleaned up in `close()` (full
    teardown), not on every render.
  - **`SessionOverlayCache` existed here and is now deleted.** It let several destinations in one
    `StreamSession` that were showing the identical `(track, template)` share one Satori render
    instead of each paying for its own. The local-first rework removed the thing it optimised: there
    is one encode per account now, so there is exactly one render of a given frame to begin with and
    nothing to share it with. `buildStreamScene`'s `overlayCache`/`sessionId` parameters went with
    it, replaced by the single `sceneId` above.
  - **`StreamSession.templateId`** is a nullable FK, persisted like `playlistId` (migration
    `add_stream_session_template_id`). That row is now a saved **preset** rather than a running
    session (see "Saved presets, not sessions" above), so what it remembers across restarts is the
    user's template *choice* for the next start.
- **Stage 1b (done, later superseded by Stage 2's timer mechanism — see below):** a `timer`
  overlay element — position/font/color configurable like `title`/`playlist` (no `width`, unlike
  them — drawtext sizes itself to its own text) — restoring the elapsed/total counter Stage 1a
  dropped. Unlike the other element types it isn't baked into the PNG (it needs to tick every
  second, and re-rendering through Satori/resvg once a second per stream would be wasteful):
  `buildStreamScene` splits a `timer` element out of what gets rendered before calling
  `renderTemplatePng()`. At this stage the ticking value was a *live* ffmpeg drawtext pts
  expression (`%{pts\:hms\:OFFSET}` — both colons need escaping, not just the one between `pts`
  and `hms`, found by running the generated filter string through a real local `ffmpeg` process
  rather than trusting the string shape a unit test can assert) on a track segment, frozen (a
  plain formatted string) on a pause segment. Stage 2 (below) replaced this: there's no more
  continuous per-track encode process for a live pts expression to run against, so
  `StreamController.timerText()` now always computes a plain, already-formatted string itself —
  ticking case and frozen case both reuse the same `pausedElapsedSeconds`/`trackStartOffsetSeconds`
  bookkeeping this stage introduced, just fed through `CanvasFeeder.render()`'s one-shot re-render
  once a second instead of a live expression.
- **Stage 2 (done):** replaced the per-segment ffmpeg pipeline with one persistent `PersistentEncoder`
  process per stream (per destination at the time; per account since the local-first rework),
  spawned once in `StreamController.start()` and never restarted for the
  life of the session, fed by two Node-owned pipes (`CanvasFeeder` for video, `AudioRelay` for
  audio — see "Backend streaming pipeline" above for the full mechanism). This is what actually
  eliminates the continuity-counter/PTS discontinuity at every switch, not just papers over it.
  Landing here took two rejected intermediate designs — a concat-demuxer MVP, then a two-FIFO
  split-encode-from-mux design that deadlocked and hit a FIFO EOF-on-last-writer-close bug against
  real ffmpeg binaries — see `docs/superpowers/specs/2026-09-03-obs-style-persistent-canvas-design.md`
  for the full story of why those were abandoned.
- **Stage 3 (done):** drag-and-drop visual canvas editor in the frontend
  (`frontend/src/pages/Templates.tsx` — list/create/delete; `TemplateEditor.tsx` — the editor
  itself), a full editor from the start as originally decided, not a simpler form-based v1: click
  to select an element, pointer-driven drag to move and a resize handle to resize (both clamped
  in-editor to the same bounds the backend validates, so the editor can never produce a draft the
  backend would reject), add/remove `cover`/`title`/`playlist`/`timer` elements, and a debounced
  live preview that renders through the real Satori+resvg pipeline (Stage 0's preview endpoint) —
  what's shown while editing is what will actually appear on stream, not an approximation. Routed
  at `/templates` and `/templates/:id`, linked from the sidebar.
- **Canvas layering around animated gifs (`CanvasPlacement`, `persistentEncoderArgs.ts`).** Every
  non-gif ("baked") element is flattened into ONE Satori picture, so the canvas can only be
  composited as a whole — but the template's element ORDER says which elements belong behind a gif
  and which in front of it. The canvas used to be pinned on top of every gif, so a full-frame
  opaque element listed *before* a gif (a static image, a cover, or a per-track
  `overlayOverride.backgroundColor`) hid that gif completely. `buildStreamScene` now splits the baked
  elements at the first gif element's index and picks a placement: `top` (no gifs — the original
  single-layer graph, byte for byte), `bottom` (one canvas, composited under the gifs), or `split`
  (two canvases — `pipe:3` below the gifs, `pipe:6` above them, one extra Satori render per frame
  and one extra `CanvasFeeder` layer). With gifs present the canvas is never pinned on top, so a
  track's `overlayOverride` background always has a layer beneath them to land on. The timer's
  `drawtext` goes on whichever layer ends up on top, preserving "the timer draws above
  everything". Deliberately a two-layer approximation rather than a full per-element z-order: with
  gifs on both sides of a baked element, that element lands above *both* — a full interleave would
  cost one Satori render and one pipe per gif.
- **Equalizer containment (`pulseGeometry`, `src/render/pulseSvg.ts`).** `layoutPulsePoints` (the
  inset) and `buildPulseSvg` (the stroke widths) must agree about how wide the glow is allowed to
  be, and they read one shared `pulseGeometry()` for exactly that reason: they used to derive it
  independently, and the layout capping its inset for a box too small for its configured glow
  while the renderer kept drawing that glow at full width is what painted the neon line onto the
  element's outermost pixels. The engine's own output ceiling (`MAX_VALUE`) is enforced *after*
  the `globalPulse` multiplication (`pulseEngine.ts`), so no template setting can push a value
  past what the inset was sized for — measured across the whole configurable range.
- **Stage 4 (done):** a template picker on the real start flow, passing the selected `templateId`
  through — the sample scene data Stage 0's preview endpoint uses is still only for the editor's own
  live preview, not the real stream start flow. It landed in `StartStreamDrawer.tsx` against the two
  now-deleted start routes; the unified rework moved it onto the start form in
  `frontend/src/pages/Stream.tsx`, calling `POST /local-stream/start`, and deleted the drawer.

**Frontend.** A separately-deployed React + Vite SPA (`frontend/`) served to browsers, talking to
the same backend API over CORS with credentialed cross-origin requests. Live status updates
(`LocalStreamManager` emits one `statusChanged` event per userId) are delivered to the client via
Server-Sent Events — **one endpoint, `GET /local-stream/events`**, carrying the whole combined
`{local, destinations[]}` payload, so the destination toggles and the transport controls can never
disagree about what is running. `useLocalStreamStatus.ts` does the initial fetch and writes every
SSE frame into the query cache; nothing polls.

**There is one stream page** (`pages/Stream.tsx`, routed at `/stream`, linked from the sidebar;
`/streams`, `/streams/:id` and `/local-stream` all redirect to it) — no list, no id in any URL and
nothing to navigate between, because there is exactly one local stream per account. It carries the
start form (playlist, template, preset picker — no broadcast metadata of its own any more, see
below), the transport controls, the embedded preview, `components/DestinationToggles.tsx` (the
checklist) and `components/DestinationSettingsDrawer.tsx` (the commit-time settings step).

**The checklist is deliberately TWO-STEP, and this is the load-bearing UX decision of the whole
rework: ticking a box only ever records LOCAL intent, never a backend call and never a request for
settings.** `Stream.tsx` holds `intendedOnIds: Set<string> | null` — `null` means "mirrors the
backend", and becomes a real Set the instant the user ticks anything, whether the stream is idle or
already running. Nothing reaches `PUT /local-stream/destinations/{id}` from a checkbox click at
all. What actually commits that intent is a separate, explicit action: pressing **"Start stream"**
(idle) or **"Apply changes"** (running — shown only once local intent genuinely diverges from what
is really running, via `commitDestinationChanges()`). Committing does three things in order: (1)
every destination newly turned OFF is switched off immediately, no settings involved; (2) every
destination newly turned ON whose metadata is already known (see presets, below) is switched on
immediately too; (3) every destination newly turned ON that actually has a broadcast to configure
and whose metadata ISN'T already known opens `DestinationSettingsDrawer` — a slide-out panel, one
section per such destination, each with its own title/description/privacy/latency — and only once
that is confirmed do their own `setDestination(id, 'on', meta)` calls fire. Only after ALL of that
lands does `start()` itself run, for the idle case. A provider with no broadcast concept (custom
RTMP) never reaches the drawer at all — its toggle-on commits in step (2), immediately. Dismissing
the drawer without confirming (Escape, the ✕, an overlay click) commits nothing and leaves local
intent exactly as it was — `Stream.tsx` throws a dedicated `CommitCancelled` marker internally so
that path is never confused with, or reported as, a real failure.

This is why the earlier, ALWAYS-backend-driven design this replaced (checklist mirrors the backend
in real time; ticking a box calls the backend immediately, opening an inline per-checkbox settings
panel right there for anything needing one) didn't survive contact with actual use: it meant a
tentative click already had a real side effect — an actual toggle-on, an actual settings prompt —
before the user had committed to anything, including while just exploring the checklist with no
intention to start yet. The two-step version fixes that at the cost of one extra explicit action,
and it is also what finally closes the class of bug the very first version of this checklist had to
patch around at the frontend layer (switching a leftover backend-on destination off before
`start()`, because `start()`'s own now-removed `destinationIds` only ever ADDED intent and never
removed it): there is no more "local state that can silently drift from the backend's" to guard
against, because ALL local editing is explicit now, and committing it is the one and only thing
that ever reconciles the two.

The checklist itself is rendered over the user's **destinations**, not over the forwards (the
backend prunes forwards that want nothing and hold nothing, so *absence is the representation of
"not forwarded"*) — `Stream.tsx` synthesizes what `DestinationToggles` displays: a real backend
forward's own state/phase/error survives display, with only its `desired` field overridden to
reflect local intent; a destination the user has only ticked locally (no backend entry yet at all)
gets a synthesized `pending` row, exactly what the backend would report for it once committed. The
"nothing is being forwarded" notice, deliberately, reads real backend truth (`status.destinations`)
rather than local intent — it must describe what is ACTUALLY running, not what the user is
mid-edit on.

**Applying a saved preset (`api/streamPresets.ts`) sets local intent — which destinations, plus
their SAME shared saved metadata — exactly like a manual tick does, and touches the network no more
than a manual tick does either.** A preset only ever holds one shared title/description/privacy/
latency for every destination it lists together (unlike the drawer's own per-destination fields),
so committing a preset-sourced destination skips the drawer (step 2 above, not step 3) — its
metadata is already known. Saving a NEW preset, symmetrically, captures only the currently-intended
destination ids and the playlist/template — no broadcast metadata of its own, since there is no
single value left on this page to capture once each destination's settings are collected
independently at commit time.

The preview is `components/HlsPlayer.tsx` — hls.js with `withCredentials` set on every request,
because the backend resolves *which* stream to serve from the session cookie, and a fatal error
there destroys and rebuilds the whole `Hls` instance rather than calling `startLoad()` (the only
recovery that re-fetches `index.m3u8`, which is what makes MediaMTX mint a fresh HLS session — see
"Local relay (MediaMTX)" item 3). Every add/edit form (track upload, playlist creation, destination
connection) opens in a shared `Drawer` component (a slide-out panel built on the same Radix `Dialog`
primitive) rather than being inlined on the page.

**Donation-triggered song requests.** A per-user `InteractionRule` (Prisma model: `actionType`
`'songRequest'` or `'libraryTrackRequest'`, `enabled`, `minAmount`, `commandKeyword`) lets a donation on
Donatello.to trigger a one-off track play: a donation message containing `!<keyword>:<query>` at
or above the rule's `minAmount` (converted to UAH) fetches audio for `<query>` from the streamer's
own external media-search service and is **queued to play next**, exactly like `play`-by-name: it
plays once the current track ends, never cutting it off (it used to interrupt and resume; that was
removed — see `docs/superpowers/specs/2026-09-23-donation-library-track-request-design.md`, Phase
B). A donation arriving while the stream is `paused` no longer wakes it either — it just queues,
and plays once the streamer manually resumes. The whole module lives in
`src/donations/`: `donatelloWebhookRoutes.ts` (`POST /webhooks/donatello` — the inbound event,
authenticated by a shared `X-Key` header rather than the session cookie, since Donatello is not a
browser), `donationEvent.ts` (payload parsing), `ruleMatcher.ts` (`parseCommand`/`matchRules` —
keyword/threshold matching against a user's enabled rules), `currencyConverter.ts`,
`mediaSearchClient.ts` (the external media-search HTTP client), `songRequestAction.ts`
(`executeSongRequest` — fetches audio, writes it to a dedicated temp dir, and calls
`LocalStreamManager.enqueueTrack`; resolves a `SongRequestResult` rather than throwing on
failure, so both the real webhook path — which only logs it — and the interaction-rule "Test"
button — which reports it back to the caller — can share one implementation),
`donationRequestQueue.ts` (`DonationRequestQueue` — see below), `libraryTrackRequestAction.ts`
(`executeLibraryTrackRequest` — the exact-track counterpart to `executeSongRequest`, see below),
`donationActions.ts` (the `ActionType` union and the shared `DonationActionHandlers` dispatch
object both the webhook and the rule "Test" route use), `tempFileCleanup.ts` (the sweep backstop —
see "Configuration" below), and `interactionRuleRepository.ts`/`interactionRuleRoutes.ts` (CRUD
plus `POST /interaction-rules/{id}/test`, mounted at `/interaction-rules`, cookie-authenticated and
owner-scoped like every other resource route). `frontend/src/pages/Donations.tsx` +
`frontend/src/api/interactionRules.ts` are the rules management UI, including a per-rule "Test"
panel that calls the `/test` route directly — bypassing Donatello entirely — with the rule's own
`minAmount` (not editable client-side) and an editable message defaulted to a working `!keyword:`
command.

**Exact library-track requests + the public request page.** A second action type,
`libraryTrackRequest`, lets a donor request an EXACT track. The streamer shares
`/r/<requestPageToken>` (a public frontend page, outside the authenticated shell), which reads
`GET /public/request-page/:token` — the ONE unauthenticated read besides `/auth/*` — listing the
tracks of the owner's currently-live playlist (`streaming`/`paused`/`reconnecting`; anything else
is `{live:false}`), read fresh from the DB at page load (no live updates). Each track copies
`!<keyword>:<first 20 code points of its name> <track uuid>`. `executeLibraryTrackRequest`
(`src/donations/libraryTrackRequestAction.ts`) takes the LAST uuid in the matched query, checks the
track belongs to `DONATION_TARGET_USER_ID` (ownership only, not membership in the live playlist),
and calls `LocalStreamManager.enqueueTrack` — no media-search fetch, no temp file — through the
SAME `DonationRequestQueue` as free-text requests, so the two types play strictly in donation
order (an exact-track request waits behind an earlier free-text one that is still downloading).
The token is `User.requestPageToken` — 128-bit hex, unique, minted/rotated/disabled
only via `POST`/`DELETE /request-page/token` (owner, `requireAuth`), and never the `userId`. The
public route 404s a malformed token by shape before any DB call, answers the same 404 for an
unknown one, sets `no-store` + `no-referrer`, and exposes only names/ids/durations. Rule keywords
are unique per user (409), since two rules sharing one would both fire. The webhook and the rule
"Test" button dispatch through one shared `DonationActionHandlers` object built in `server.ts`
(`src/donations/donationActions.ts`).

**One queue (`StreamController.enqueueTrack`).** Every donation request and every `play`-by-name
goes through the one `PlaylistQueue.insertNext()` FIFO via `enqueueTrack(track)` — play after the
current track ends, in call order, never interrupting, and skippable like any other track. A
donation's temp-file track carries `ephemeral: true` plus `_onFinished`: `PlaylistQueue.next()`
never pushes an ephemeral track into `history` (its file is deleted the moment it finishes, so
`previous()` must never reach it), and `StreamController.next()`/`previous()` call
`releaseTrack()` on an ephemeral track they move off mid-play, so skipping one still deletes its
file. A stop or crash mid-donation leaves the file to the 12-hour sweep, as before.
`status().currentTrack` is `queue.current()` while a session exists
(`streaming`/`paused`/`reconnecting`) and `null` otherwise. The overlay's playlist window lists
queued tracks via `PlaylistQueue.windowSnapshot()`, and each visible insertion animates on the
`pipe:7` burst layer (see `PlaylistWindowAnimator` under "Backend streaming pipeline" above) —
which covers both donation tracks and `play`-by-name picks from outside the running playlist.

**Donation ordering is by arrival, not by download speed (`donationRequestQueue.ts`).** Two
donations racing on the external media-search HTTP fetch — or one free-text and one exact-track
donation arriving moments apart — could otherwise insert, and therefore play, in whichever order
their work happened to finish, not the order the donations actually arrived in.
`DonationRequestQueue.enqueue(() => task)` is task-generic (not query-string-specific any more —
that's what let it become the one shared queue for BOTH action types) and chains every task onto
one promise tail, so a task is not even started until every task enqueued ahead of it has fully
settled — deliberately fully sequential rather than "run in parallel, deliver in order": simpler,
and ordering is what was asked for, not throughput. An exact-track task is two indexed DB
queries and settles almost instantly once its turn comes; a free-text task waits on the external
media-search download — so a free-text donation that arrived first still plays before a
later-arriving exact-track one, even though the exact-track one resolves first once it's running.
`server.ts` constructs ONE `DonationRequestQueue` instance and both `donationActions.songRequest`
and `donationActions.libraryTrackRequest` enqueue onto it, shared by both the real webhook path and
the interaction-rule "Test" button, so a manual test and a real donation queued moments apart still
resolve in the order they were actually issued. A **head-of-line timeout**
(`DONATION_TASK_TIMEOUT_MS = 90_000`) is the knock-on of sharing one queue across a
fetch-bound task and near-instant ones: a hung media-search download would otherwise block every
later donation of BOTH types for as long as it hangs. After 90s the queue moves on; the timed-out
task is not cancelled and still resolves its own caller's promise if it eventually completes — one
request landing out of order (logged), instead of the whole queue stalling. The residual race this
doesn't remove: two webhooks arriving within one `listEnabledByUser` DB round trip are ordered by
whichever `matchRules` call resolves first, not by which HTTP request the platform sent first —
narrow, and unchanged from the original arrival-ordering design's own scope.

**MVP scope note:** `DONATION_TARGET_USER_ID` hard-codes which single
account's stream every donation is routed to (see "Configuration" below) — there is no per-donor
or per-channel routing yet.

**Adding library tracks via the media-search service.** Alongside uploading a file, a track can be
added by typing a text query and previewing the result before it's ever saved to the library.
`POST /tracks/search-preview` (`{query}`, 400 on a missing/empty string) fetches audio for it from
the same external media-search service the donation feature uses — `MediaSearchClient`/
`HttpMediaSearchClient`/`MediaSearchError` moved out of `src/donations/` into `src/media/
mediaSearchClient.ts` when this landed, since the client itself was never donation-specific, and
both features now share the one `HttpMediaSearchClient` instance `server.ts` constructs off
`MEDIA_SEARCH_SERVICE_URL` — no new env var was needed. The fetched audio is written to a
dedicated temp dir (`path.join(os.tmpdir(), 'super-dj-track-previews')`) and registered in
`TrackPreviewRegistry` (`src/tracks/trackPreviewRegistry.ts` — in-memory `previewId -> {userId,
query, tempFilePath, createdAt}`, the same discipline as `MediaMtxAuthRegistry`); a
`MediaSearchError` from the client maps to a 502 carrying the upstream service's own `detail`
text. The registry keeps the **original query text**, not just the temp path, for a concrete
reason: `TrackUploadService.upload()`'s own filename-based name fallback is meaningless for a
preview file, since its `originalname` is a synthetic `${previewId}.mp3` rather than anything a
streamer actually typed — so `TrackPreviewService.confirm()` (`src/tracks/trackPreviewService.ts`)
defaults an empty/omitted name to the registry's stored query instead of falling through to that
synthetic filename. The frontend streams the temp file straight back for an in-browser `<audio>`
preview via `GET /tracks/preview/{previewId}` (owner-checked, 404/403 like every other resource
route, `Cache-Control: no-store`) — **nothing is saved to the library yet** at this point.
`POST /tracks/from-preview/{previewId}` hands that SAME temp file to the existing
`TrackUploadService.upload()` **completely unchanged** — no second fetch from the external
service, no parallel upload code path — and it's that function's own pre-existing `moveFile`
(a `rename`, falling back to copy+unlink across filesystems) that actually consumes the temp file,
moving it into `{UPLOADS_DIR}/{userId}/{trackId}/` exactly as a normal upload would.
`DELETE /tracks/preview/{previewId}` discards an unconfirmed preview explicitly (unlinks the temp
file, drops the registry entry); a preview abandoned without that explicit discard is reaped by a
**second** `startTempFileCleanupSweep` instance (`server.ts`, alongside the pre-existing donation
one, both stopped on shutdown) pointed at that same temp dir — 1 hour max age, 10 min interval,
deliberately much shorter than the donation feature's 12-hour sweep, since an abandoned preview is
a forgotten draft the streamer navigated away from, not a track a running stream might still be
about to play.

`AddTrackDrawer.tsx` (`frontend/src/components/`) gained a tab switcher — "Upload" (`UploadTab`,
the pre-existing flow, unchanged) and "Через сервис" (`ServiceTab`: query -> search -> listen to
the preview `<audio>` -> optional name/cover -> confirm). Its `onUploaded: () => void` prop was
renamed to **`onAdded: (track: Track) => void`** (a breaking change propagated to both call sites,
`pages/Library.tsx` and the new one in `pages/PlaylistEditor.tsx`), because the playlist editor
needs the confirmed track's id/name back, not just an "something changed, go refetch" signal: it
stages the returned track straight into the page's own **pre-existing** local `addTrack()` — the
playlist's in-memory, unsaved-until-"Save" track list — with no separate "add to playlist" API
call of its own; nothing reaches `PUT /playlists/{id}/tracks` until the page's existing Save
button is pressed.

Four things were raised and explicitly accepted during design review rather than engineered around
(see `docs/superpowers/specs/2026-09-22-track-library-via-media-service-design.md`'s "Reviewed and
explicitly accepted, not fixed" section for the full reasoning). Three are backstopped by the same
1-hour sweep rather than fixed at the source: abandoning a pending preview by switching the
drawer's tab or closing the drawer outright (rather than clicking "Другой запрос"/try-another-
query, the only path that calls `discardPreview`) leaves the temp file and registry entry to be
reaped by the sweep; a double-click on "Добавить"/confirm can race `confirm()` against itself,
since the second call's `moveFile` finds the temp file the first call already renamed away; and a
track added from the playlist editor is created in the library immediately on confirm even if the
playlist page's own "Save" is never pressed afterward. **The fourth is NOT sweep-backstopped and
is currently unmitigated:** switching away from the Upload tab while its own upload request is
still in flight, then having that request resolve later, can still close the whole drawer out from
under the streamer — `onSuccess` fires and calls `onOpenChange(false)` regardless of which tab is
now active, since it's wired on `UploadTab`'s own `useMutation` independently of which tab is
currently rendered. This is a new edge case the tab switcher itself introduces (a single-tab drawer
had nothing to switch away *to* mid-request) and is a genuine UX surprise, not a self-healing one
like the other three.

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
                            trackPreviewRegistry.ts (in-memory previewId -> {userId, query,
                            tempFilePath, createdAt}, same discipline as MediaMtxAuthRegistry),
                            trackPreviewService.ts (search/getPreviewPath/confirm/discard — the
                            add-a-track-by-search-query flow, see "Adding library tracks via the
                            media-search service" below), trackRoutes.ts (incl.
                            POST /search-preview, GET /preview/:previewId,
                            POST /from-preview/:previewId, DELETE /preview/:previewId)
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
  media/mediaSearchClient.ts MediaSearchClient/HttpMediaSearchClient/MediaSearchError — the
                            external media-search HTTP client, shared by
                            donations/songRequestAction.ts and tracks/trackPreviewService.ts
                            (moved here out of donations/ when the track-library-via-media-service
                            feature landed, since it's no longer donation-specific)
  stream/                   localStreamManager.ts (the one manager: per-userId StreamController +
                            per-userId Map<destinationId, DestinationForward>; concurrency/duration
                            caps, auth-registry lifecycle, 'starting'/previewReady),
                            streamController.ts (session state machine; LibraryLike adapter),
                            destinationForward.ts (one destination's desired/actual state and its
                            single reconcile() loop), reconnectPolicy.ts (backoff + crash-loop
                            threshold, shared by the encoder and — on a faster schedule via
                            createForwardReconnectPolicy — a forward's relay), types.ts,
                            streamScene.ts (buildStreamScene() — the destination-free scene
                            resolver), localRelayTarget.ts (mints one local
                            stream's MediaMTX path token, publish/read credentials and every URL
                            derived from them), mediaMtxAuth.ts (MediaMtxAuthRegistry in-memory
                            allow/deny map + the unpublished Express app MediaMTX POSTs to),
                            localStreamRoutes.ts (mounted at /local-stream),
                            localStreamPreviewRoutes.ts (the authenticated HLS proxy, mounted at
                            /local-stream/preview), streamPresetRepository.ts (Prisma; reads the
                            repurposed StreamSession tables) / streamPresetRoutes.ts (mounted at
                            /stream-presets), playlistWindowAnimator.ts (PlaylistWindowAnimator —
                            the one-burst-at-a-time canvas/pipe:7 handoff protocol, coalescing,
                            abort)
  playlist/                 queue.ts (cursor + insertNext + windowSnapshot — the keyed rows a
                            stream's on-screen window shows, incl. queued tracks), window.ts
                            (WindowRow + window-size constants), types.ts — shared by
                            streamController
  ffmpeg/                   canvasFeeder.ts (video leg: one-shot renders + heartbeat resend),
                            audioRelay.ts / audioRelayArgs.ts (audio leg: per-track decode-only
                            process), persistentEncoder.ts / persistentEncoderArgs.ts (the one
                            long-lived encoder process per local stream),
                            relayProcess.ts / relayProcessArgs.ts (one -c copy ffmpeg per enabled
                            destination forward: MediaMTX in, destination RTMP out, never
                            transcoding), segmentArgs.ts (canvas-
                            frame render args + overlay/timer types), duration.ts (ffprobe),
                            overlayText.ts (formatDuration — the playlist-window text builders
                            that used to live here were deleted when Phase C's windowSnapshot()
                            took over),
                            types.ts (Spawner, ChildProcessLike, PipeSpawner, ChildProcessWithPipes
                            — pipes: fd3 canvas, fd4 audio, fd5 equalizer, fd6 above-canvas,
                            fd7 playlist-window burst layer),
                            rawFramePacer.ts (paces a raw-video pipe at its declared fps from
                            wall-clock time; shared by PulseVisualizer and the playlist-window
                            burst layer), playlistWindowTransition.ts (pure insert-transition
                            planning + animated row props), playlistWindowFeeder.ts (the pipe:7
                            frame player: idle transparent frame, showRows, one 600ms animate burst)
  templates/                templateRepository.ts (Prisma), templateRoutes.ts (mounted at
                            /templates, incl. POST /:id/preview), templateTypes.ts
                            (TemplateElement union + isValidTemplateElement(s) +
                            DEFAULT_TEMPLATE_ELEMENTS)
  render/                   sceneRenderer.ts (template + scene data -> PNG via satori + resvg),
                            imageDataUri.ts (local image file -> data: URI, for satori's <img>),
                            fontCache.ts (shared lazy-loaded font bytes), renderWorker.ts /
                            renderWorkerPool.ts (piscina pool renderScene runs in, off the main
                            thread), renderOverlay.ts (renderTemplatePng() — the one shared,
                            happy-path-only entry point both /templates/{id}/preview and the live
                            pipeline call), blankOverlay.ts (hand-built transparent-PNG fallback,
                            independent of satori/resvg), playlistWindowGeometry.ts
                            (computePlaylistWindowRegion — the fixed pixel region pipe:7's burst
                            frames render into), yuva420p.ts (transparentYuva420p/rgbaToYuva420p —
                            pipe:7's pixel format, BT.601 limited range), playlistWindowRenderWorker.ts
                            / playlistWindowRenderPool.ts (a SEPARATE small dedicated piscina pool,
                            not renderWorkerPool.ts, producing pipe:7 burst frames)
  donations/                donatelloWebhookRoutes.ts (POST /webhooks/donatello, X-Key
                            authenticated), donationEvent.ts (payload parsing), ruleMatcher.ts
                            (parseCommand/matchRules), currencyConverter.ts, songRequestAction.ts
                            (executeSongRequest — fetch, temp-write, enqueueTrack; fetches
                            through media/mediaSearchClient.ts, above),
                            libraryTrackRequestAction.ts (executeLibraryTrackRequest — exact-track
                            counterpart: resolve a donated uuid to an owned track, enqueueTrack,
                            no fetch/temp file), donationActions.ts (ActionType union,
                            DonationActionHandlers — the shared dispatch object both the webhook
                            and the rule "Test" route use), donationRequestQueue.ts
                            (DonationRequestQueue — serializes EVERY donation-triggered action, both
                            types, so play order matches arrival order, not download/DB speed; a
                            head-of-line timeout keeps a hung task from blocking later donations),
                            tempFileCleanup.ts (age-based sweep backstop),
                            interactionRuleRepository.ts (Prisma) / interactionRuleRoutes.ts
                            (mounted at /interaction-rules, incl. per-user keyword uniqueness)
  requestPage/               requestPageRoutes.ts (owner routes, mounted at /request-page: mint/
                            rotate/disable the public share token), publicRequestPageRoutes.ts
                            (the ONE unauthenticated read besides /auth/*, mounted at
                            /public/request-page — token-gated live playlist for donors)
prisma/                     schema.prisma (User — incl. requestPageToken, Session, Track, Playlist,
                            PlaylistTrack, StreamDestination — incl. the reused youtubeLiveStreamId,
                            OAuthConnection, OAuthState, StreamSession +
                            StreamSessionDestination — kept under their old names, now read as
                            saved PRESETS, StreamTemplate, InteractionRule) + migrations/
docker/mediamtx.yml         the local relay's config: every non-RTMP/HLS surface off,
                            authMethod: http, one regex path, no all_others (see "Local relay")
test/                       mirrors src/; unit tests only — plus infra/mediamtxConfig.test.ts,
                            which asserts the compose/MediaMTX security invariants (no published
                            ports, control surfaces off, regex path, no catch-all)
assets/                     default cover + background images
frontend/                   React + Vite SPA
  src/
    api/                    typed API client (fetch wrappers + type definitions; localStream.ts
                            covers /local-stream/* — start, transport, the destination toggle, the
                            combined status/SSE payload and the preview URLs;
                            streamPresets.ts covers /stream-presets; interactionRules.ts covers
                            /interaction-rules; tracks.ts covers /tracks incl.
                            searchPreview/previewUrl/confirmPreview/discardPreview)
    pages/                  route page components (incl. Stream.tsx — THE stream page: start form,
                            preset picker, transport controls, destination checklist, embedded
                            preview; Templates.tsx list/create/delete,
                            TemplateEditor.tsx the Stage 3 drag-and-drop overlay editor;
                            Donations.tsx — InteractionRule list/create/edit/delete;
                            PlaylistEditor.tsx — reuses AddTrackDrawer to stage a newly-added
                            track into its own local, unsaved-until-"Save" track list)
    components/             shared UI components (Drawer.tsx + the drawers built on it:
                            AddTrackDrawer — two tabs, "Upload" (UploadTab) and "Через сервис"
                            (ServiceTab, search/preview/confirm against /tracks/search-preview
                            etc.), CreatePlaylistDrawer, AddDestinationModal;
                            DestinationToggles.tsx — the checklist, purely local intent, no
                            backend calls of its own; DestinationSettingsDrawer.tsx — the
                            commit-time settings step, one section per destination that needs one;
                            ConfirmDialog, LanguageSwitcher, HlsPlayer.tsx — hls.js preview player
                            with credentialed requests and a destroy-and-rebuild recovery loop)
    i18n/                   react-i18next setup + en/ru/uk locale files
    hooks/                  custom React hooks (incl. useLocalStreamStatus.ts — initial fetch +
                            SSE-driven query-cache updates)
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
`destinationRepository.ts`, `oauthConnectionRepository.ts`, `oauthStateRepository.ts`,
`streamPresetRepository.ts`) are thin wrappers verified by manual smoke test with a real Postgres
(`docker compose up`), not unit tests — services that consume them (`LocalStreamManager`,
`TrackUploadService`, route handlers) take `Pick<...>` structural subsets so they can be
unit-tested with plain-object fakes instead. `DestinationForward` additionally takes injected
`now`/`setTimer`/`clearTimer`, so its reconcile loop's timing can be driven deterministically
without jest fake timers leaking across its `await` points. Follow the existing fake-child /
fake-repository pattern rather than introducing a new mocking style.

Two classes of defect this repo has repeatedly proven unit tests **cannot** catch, both with
scars in this file: values crossing a `worker_threads` boundary (see the `Buffer` rewrapping note
under "Overlay templates" Stage 1a) and anything about how a real ffmpeg or a real MediaMTX
actually behaves — generated filter strings, query-string carriage, exit codes, keyframe
alignment, timestamp origin. Every finding in "Local relay (MediaMTX)" and in the `RelayProcess`
bullet came from running the real binaries, not from a test, and several contradicted what the
design predicted. Run the real thing once before trusting a change in either class.

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

`POST /local-stream/{start,stop,pause,resume,next,previous,play}`, `GET /local-stream/status`,
`GET /local-stream/events` (SSE), `PUT /local-stream/destinations/{destinationId}` — **the whole
streaming API.** `/destinations/{id}/stream/*` and `/stream-sessions/*` no longer exist (both 404);
`GET /openapi.json` no longer lists them, and `test/api/openapi.test.ts` and `test/server.test.ts`
assert that as a regression check.

**Apart from the destination toggle, none of these routes takes an id of any kind**: there is
exactly one local stream per account, resolved from the session cookie, so there is nothing to
address and therefore no ownership check to get wrong.

`start` takes `playlistId` (400 if missing or not a string), and optionally `templateId` (400 on an
empty string; 404/403 if given and not found/not owned — a stream can start with no overlay template
selected and fall back to a built-in default layout, see the "Overlay templates" Stage 1a notes for
why it isn't required) — **and nothing else**. It names no destination and carries no broadcast
metadata of its own: a destination (and its own title/description/privacy/latency) is switched on
separately, via `PUT /local-stream/destinations/{destinationId}` below, before or after this call —
ticking a box before `start()` parks that forward at `pending` with zero external side effects, and
the very same `start()` (via `refreshForwardRows()` + one `reconcileForwards()` pass) is what
reconciles it into life, the identical code path a later mid-stream toggle takes. `start` 409s if a
stream is already active **or already starting** for the account, and 429s once the host is at
`MAX_CONCURRENT_LOCAL_STREAMS`. `play` takes `name` (400 if missing or not a string) and jumps to
that track by name out of the user's whole library; `pause`/`resume`/`next`/`previous` take no body.
Everything but `start` 409s when no local stream is active.

`PUT /local-stream/destinations/{destinationId}` takes `{desired: 'on' | 'off'}` (400 on anything
else) and is **the checkbox**: idempotent, valid in *every* local-stream state including `idle` (a
toggle with nothing running parks the forward at `pending` rather than 409ing), never blocking on
the work it triggers, and answering with the same combined status payload every other route does.
It is a `PUT` because it sets a value rather than issuing a command. **This is also where a
destination's own broadcast settings live** — `title`/`description`/`privacyStatus`/
`latencyPreference` (same validation `start` used to carry: 400 on a non-string `title`/
`description`, a `privacyStatus` outside `'public'`/`'unlisted'`/`'private'`, or a
`latencyPreference` outside `'normal'`/`'low'`/`'ultraLow'`), all optional and all ignored on
`desired: 'off'`. Every one of them is THIS destination's own — chosen right at the moment of
switching it on, not a session-wide default — and ignored entirely by a provider with no broadcast
concept (`custom` RTMP). `title` defaults to the destination's own name when omitted (there is no
playlist context at toggle time to default it from any more); any value this same destination last
used is otherwise kept, since `DestinationForward` remembers the metadata it was last given across
a respawn or a toggle-off-then-on that doesn't resupply it. `latencyPreference` maps straight to
YouTube's own broadcast `contentDetails.latencyPreference` and defaults to `'normal'` when
omitted — YouTube's own default, and its highest end-to-end latency (its ingest→transcode→CDN→player
pipeline typically adds ~20-40s regardless of how fast this app reacts to a command); `'low'`/
`'ultraLow'` trade some playback-buffering resilience for viewers on slow connections for a much
snappier feel. 404/403 if the destination isn't the caller's; 400 for a destination whose `provider`
has no registered `StreamDestinationProvider`.

`stop` is **awaited**: it forces every forward's desired to `off`, tears the encode down, and waits
for each provider-side finalize (a YouTube transition-to-complete takes seconds) before responding,
so the response is truthful about what actually stopped — measured at 1.11 s against a real channel,
with `destinations: []` and `local.state: "idle"` already in that same response.

**Every route answers with one combined payload**, `{local, destinations[]}` — and `GET
/local-stream/events` streams exactly that same object on every change, so the transport controls
and the destination checklist can never disagree. `local` is
`{state, currentTrack, nextTrack, previewReady, playlistId, templateId, startedAt}`, where `state`
adds **`'starting'`** to `StreamController`'s own `idle`/`streaming`/`paused`/`reconnecting`/`error`
— a start is in flight, so a client must show neither the start form (it would offer to start a
second one) nor the transport controls (there is nothing to control yet). `previewReady` is true
exactly while the encoder is publishing into MediaMTX (`streaming` or `paused`). Each entry of
`destinations[]` is `{destinationId, name, desired, state, provider?, error?}` —
`state` being the forward's actual
`off`/`pending`/`preparing`/`connecting`/`live`/`stopping`/`error`, `provider` present only while a
provider lifecycle exists (i.e. YouTube: `{type, phase, watchUrl}`), and `error` carrying
`{reason, message}` with `reason` one of `auth`/`provider`/`relay`/`source`. A forward that wants
nothing and holds nothing is **pruned**, so absence is the representation of "not forwarded" — a
client renders the checklist over the user's destinations and treats a missing entry as off.
**`destinations: []` alongside a `streaming` local state is a completely normal payload**, confirmed
live, not just in a unit test.

Every *mutating* route (the `PUT` included) requires
`Content-Type: application/json` (400 otherwise) — not decoration: with no id in the URL these
routes have no accidental CSRF token either, and requiring JSON is what forces a browser preflight
that the CORS policy then has to approve, which a plain cross-site HTML form POST (a CORS "simple
request", whose side effect lands even though its response is blocked) could never get. The `PUT`
does carry an id, but it is one of the caller's own destination ids, not an unguessable per-request
token, so it buys no CSRF protection on its own and gets exactly the same treatment.

`DELETE /destinations/{id}` additionally drops that destination's forward and finalizes its
lifecycle **without touching the local stream** (confirmed live: the entry disappeared from
`status.destinations` immediately and `local.state` stayed `streaming`). The pre-rework code stopped
the whole per-destination stream here, which in this model would tear down the user's entire encode
to delete one checkbox.

`GET /local-stream/preview/index.m3u8` and `GET /local-stream/preview/{file}` proxy the relay's HLS
output to the browser behind `requireAuth`. **The client never names a MediaMTX path, token or
credential** — the path is resolved server-side from `req.user.id`, and the proxy still presents
that session's read credential upstream so `authHTTP` applies even to our own traffic. A variant
that accepted a path or token parameter would be one IDOR away from cross-tenant viewing. `{file}`
is checked against an anchored allowlist regex (`name.m3u8|ts|mp4|m4s`, no separators, no traversal)
and every response is `no-store`. A non-2xx upstream status is passed straight through rather than
remapped: MediaMTX muxes HLS on demand, so the first playlist request after a start legitimately
404s until the muxer has cut a segment (measured against a real relay: 2.4-6.4 s of 404 from a fresh
publish, then 200) — carrying the player across that window is `HlsPlayer`'s destroy-and-rebuild
recovery loop, **not** an hls.js retry, because hls.js does not retry a 4xx at all (see "Local relay
(MediaMTX)" item 3; this route is correct as written and was not changed by that fix).
The **inbound query string is forwarded upstream verbatim**, because MediaMTX's playlists reference
their children with a required `?session=<uuid>` and answer 401 without it — the `{file}` allowlist
deliberately applies to the file name only, never to the query. Verified end to end against a real
MediaMTX 1.21.0 (see the "Local relay" section above).

`POST /stream-presets` (`name` + `playlistId` required, optional `templateId`/`destinationIds[]`/
`title`/`description`/`privacyStatus`/`latencyPreference` — every field validated the same way
`PUT /local-stream/destinations/{destinationId}` validates its own copy), `GET /stream-presets`,
`GET /stream-presets/{id}`, `PUT /stream-presets/{id}` (full replace, same validation),
`DELETE /stream-presets/{id}` — all scoped to the preset's owner. A preset is a **saved choice, not
a running thing**: it has no side effects at all, and applying one from the frontend only sets local
intent (which destinations, plus their one shared saved metadata) exactly like a manual checklist
tick does — nothing reaches this API, or `POST /local-stream/start`, until the user actually commits
(see "Frontend" above for the two-step checklist this rides on). A preset holds only ONE shared
title/description/privacy/latency for every destination it lists together, unlike the commit-time
settings drawer's own per-destination fields, which is why saving a *new* preset from the frontend
no longer captures those fields at all. `name`
is deliberately separate from `title` (`title` is the YouTube *broadcast* title; overloading one
field would make the preset picker show broadcast titles), and **`destinationIds: []` is valid** —
a local stream forwarded nowhere is a normal way to run, where the old `StreamSession` these rows
used to back required a non-empty list. Every referenced id is checked against the caller's own
resources and answered 404/403 (not 400, as `PUT /playlists/{id}/tracks` has to: a preset is a
private object of the caller's with no membership to leak). Backed by the repurposed
`StreamSession`/`StreamSessionDestination` tables — same tables, no rename, no data migration.

`POST /templates` (`name`, `elements[]`), `GET /templates`, `GET /templates/{id}`,
`PUT /templates/{id}`, `DELETE /templates/{id}` — a template is a named, reusable overlay layout
(positioned `cover`/`title`/`playlist` elements), selected by id when starting a stream (see
above) — Stage 1a of the overlay rework wired this into the actual ffmpeg pipeline; the
drag-and-drop visual editor to create one with (Stage 3) is at `/templates` in the frontend, on
top of this same CRUD API. `POST /templates/{id}/preview`
(optional `elements[]` to preview an unsaved draft instead of the saved template, optional
`title`/`playlistLines`/`trackId` sample scene data) renders and returns the PNG directly
(`image/png`), not persisted — a render failure here is a real HTTP error (500), unlike the live
stream pipeline which falls back to a blank overlay instead of failing the request.

`POST /interaction-rules` (`actionType`, `enabled`, `minAmount`, `commandKeyword` — every field
required and validated: `actionType` must be one of `songRequest`/`libraryTrackRequest`,
`minAmount` a positive whole number, `commandKeyword` 1-20 letters/digits, stored lowercased and
**bare, without a leading `!`**, and unique per user — **409** if another of the caller's own rules
already uses it, case-insensitively, regardless of that other rule's action type, since two rules
sharing a keyword would both fire on one donation), `GET /interaction-rules`,
`PUT /interaction-rules/{id}` (same validation, full replace — a partial body is rejected, not
merged, except `actionType` which defaults to the existing rule's own value when omitted; the
keyword-uniqueness check excludes the rule's own id, so keeping an unchanged keyword never 409s
against itself), `DELETE /interaction-rules/{id}` — cookie-authenticated and owner-scoped (404 if
the rule isn't the caller's) like every other resource route. Backs the donation feature's per-user
rule set — see "Donation-triggered song requests" and "Exact library-track requests" above.

`POST /webhooks/donatello` — the inbound Donatello.to donation event. **Not session-cookie
authenticated** (Donatello is a server-to-server caller, not a browser): a shared secret is
compared against the `X-Key` request header (`timingSafeEqual`), 401 on a missing or wrong key.
Answers `200` fast, before any rule matching or media fetch, so Donatello never sees our own
downstream decisions (no rule matched, the media fetch failed) as a delivery failure and retries
forever; a structurally invalid payload is the only case that 400s.

`GET /request-page` (returns `{token: string | null}`, never mints one as a side effect),
`POST /request-page/token` (mints or rotates the caller's public share token, invalidating any
previous link immediately), `DELETE /request-page/token` (disables it — no `Content-Type` guard,
matching every other DELETE route in the app, since a bodiless browser DELETE carries no body to
guard) — cookie-authenticated, no id in the URL (there is exactly one token per account, like the
local-stream routes). See "Exact library-track requests" above.

`GET /public/request-page/{token}` — **the one unauthenticated read besides `/auth/*`.** A donor
opens this from the streamer's shared link; the token alone resolves to a user's currently-live
playlist. 404s a malformed token by shape before any DB call, and the identical 404 for an unknown
one; `{live: false}` (200, not 404) for a valid token whose stream isn't
`streaming`/`paused`/`reconnecting`. Every response carries `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`, and exposes only track id/name/duration plus which command
keyword/minAmount to use (never file paths, covers or the owner's email).

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
externally-reachable origin, used for CORS policy), `MEDIAMTX_AUTH_SECRET` (guards the unpublished
`authHTTP` endpoint MediaMTX calls; it is also interpolated into the `mediamtx` service's
`MTX_AUTHHTTPADDRESS`, so both containers read the same value from the environment — required and
never defaulted, because a defaulted shared secret is a backdoor), `DONATELLO_CALLBACK_KEY` (the
shared secret `POST /webhooks/donatello` compares against the inbound `X-Key` header),
`DONATION_TARGET_USER_ID` (the single account id every donation-triggered song request is routed
to — MVP has no per-donor/per-channel routing, see "Donation-triggered song requests" above), and
`MEDIA_SEARCH_SERVICE_URL` (base URL of the external media-search service — fetched from by both
`songRequestAction.ts`'s donation-triggered song requests and `TrackPreviewService.search()`'s
add-a-track-by-query flow, see "Adding library tracks via the media-search service" above; no new
env var was needed when the latter was added, since both share one `HttpMediaSearchClient`
instance constructed once in `server.ts`). The app throws at boot if any of the three is unset.
Optional: `PORT` (3000), `SESSION_TTL_DAYS` (30), `UPLOADS_DIR` (`/data/uploads`), `FIFO_DIR`
(`/tmp`), `DEFAULT_COVER_PATH`, `BACKGROUND_IMAGE_PATH`, `MEDIAMTX_RTMP_URL`
(`rtmp://mediamtx:1935`), `MEDIAMTX_HLS_URL` (`http://mediamtx:8888`), `MEDIAMTX_AUTH_PORT` (3001),
`MAX_CONCURRENT_LOCAL_STREAMS` (10), `MAX_LOCAL_STREAM_HOURS` (12). The last three, plus
`MEDIAMTX_AUTH_PORT`, go through `parsePositiveInt` rather than a bare `parseInt`: a typo'd value
would otherwise become `NaN`, which silently *disables* the concurrency cap (`size >= NaN` is always
false) or makes `setTimeout(fn, NaN)` fire on the next tick and auto-stop every local stream the
instant it starts.

RTMP URL and stream key are no longer global config — they're per-`StreamDestination`, supplied
by each user via `POST /destinations`. The frontend's `VITE_API_BASE_URL` is a build-time
environment variable documented in `frontend/.env.example` (not a runtime env var — the frontend
is statically served after build).

**TLS is required in front of both services for a real deployment.** `docker-compose.yml` as
written publishes both `super-dj` (backend, port 3000) and `frontend` (port 5173) over plain
HTTP, with no TLS termination anywhere. But `NODE_ENV=production` is set in the backend's
`Dockerfile`, which makes `sessionCookie.ts` emit the session cookie as `SameSite=None; Secure`.
Browsers silently discard a `Secure` cookie sent over a plain `http://` origin (localhost is
exempted, a real deployment is not) — login would appear to succeed (200 + user JSON) but every
subsequent request would silently 401, with nothing in the logs to explain why. Put a
TLS-terminating reverse proxy (e.g. nginx, Caddy, Traefik) in front of both services before
deploying this compose file anywhere but local development. Additionally, prefer putting the
frontend and backend under one registrable domain (e.g. `app.example.com` for the frontend,
`api.example.com` for the backend) rather than two unrelated domains — Safari's Intelligent
Tracking Prevention and Chrome's third-party-cookie restrictions can still block a cross-site
cookie even with `SameSite=None; Secure` set correctly when the two origins don't share a
registrable domain.

## Known follow-ups (deliberately deferred)

`PORT` parsing is unvalidated;
`stopCurrent()` SIGTERMs mid-TS-packet; the Docker image runs as root; `assets/` holds 1×1
placeholder PNGs; uploaded files are never cleaned up on track deletion (`DELETE /tracks/{id}`
removes the DB row but not `{UPLOADS_DIR}/{userId}/{trackId}/`); no per-user storage quota. Real-
ffmpeg smoke testing of segment concatenation has not been run in CI. A YouTube-connected
destination's access token is refreshed on every API call rather than cached against its
`expiresIn` (deliberate — avoids a whole class of expiry-timing bugs for streams that can run far
longer than a token's ~1 hour lifetime, at the cost of a few extra token-endpoint calls).
**(Closed.)** Real end-to-end YouTube API smoke testing has now been run: a real channel went live
through this app, the toggle-on/off/on cycle and the failure paths were exercised against the real
Data API, and the numbers recorded above (quota, timings, `youtubeLiveStreamId` reuse, watch-URL
behaviour) come from that run. The real-ffmpeg-smoke-testing caveat is likewise closed for the
relay leg — see the `RelayProcess` bullet — though not for the *encoder* leg, whose own real-binary
coverage is still only what the persistent-encoder rework did.
**(Closed.)** A YouTube destination's health-check timeout used to stop the YouTube-side broadcast
while leaving the local ffmpeg pipeline pushing at a dead ingest endpoint until the user stopped the
stream by hand. A terminal provider phase (`error`/`complete`) now stops **that forward's relay and
nothing else** — `DestinationForward.pass()` checks for it ahead of every branch that could start or
respawn a relay, so even a respawn that was merely *scheduled* can't fire into an ended broadcast —
and the local encode, the preview and every sibling forward carry on untouched.
**(Closed.)** A persistently failing `refreshAccessToken` (e.g. a revoked Google grant) used to make
the health-check poll loop retry silently for the full 90s timeout instead of short-circuiting on an
auth-class error — `youtubeProvider.ts`'s poll loop now checks `isAuthClassError(err)` and calls
`giveUp()` immediately instead of scheduling another poll, predating this plan (verified against
`93ffcf9`, Phase A's own tip). What used to follow from the old behaviour — an orphaned ephemeral
`liveStream`, because `finalize()` needs a working token too — cannot happen any more either: the
`liveStream` is persisted on the destination row, reused across every toggle, and never deleted by
`finalize()` at all. `OAuthState` rows for an abandoned `/oauth/start` (the user never
completes the consent flow) are never swept — they just sit until their `expiresAt` passes,
matching the pre-existing `Session` table's same lack of a sweep job. The OAuth callback's
state-row lookup-then-delete (`oauthStateRepository.findValid` then `deleteById`) isn't atomic —
two concurrent callbacks presenting the same valid `state` value could both pass and create two
destinations before either delete lands. Narrow (requires already holding a valid single-use
state), but a compare-and-delete-returning-count check would close it. `OAuthConnection` has no
uniqueness constraint on `(provider, externalAccountId)` — a user can connect the same YouTube
channel to multiple `StreamDestination`s, which would then compete over the same channel's
broadcasts if both were streamed to at once — and, now that the `liveStream` is persisted per
destination row, two such destinations would also hold two separate reusable ingest endpoints on the
same channel. Observed in practice during the real-API smoke test, though from a different cause:
**one consent click produced two `StreamDestination` rows**, which is the non-atomic state-row
consumption above firing for real. Worth knowing alongside it: the second row's refresh token came
back already revoked (`invalid_grant: Token has been expired or revoked`), plausibly Google
invalidating an earlier refresh token when the same client re-authorizes the same user in quick
succession — unconfirmed against Google's docs, but it is what organically exercised the
`reason: "auth"` forward-error path. **(Closed.)** `onError` used to resolve a destination's
lifecycle to finalize **by `destinationId` alone**, so a crashed session's exit event arriving after
a fast restart could finalize the *new*, healthy broadcast. There is no destinationId-keyed
lifecycle registry any more: a lifecycle is owned by the one `DestinationForward` that prepared it,
and `onProviderPhaseChanged` additionally ignores any callback whose session is not that forward's
current one. Also **(Closed.)** with the entity itself: "a `StreamSession`'s destination list is
fixed at creation" (destinations are toggleable mid-stream now, which was the whole point) and
`StreamSessionManager.deleteById()`'s non-atomic per-destination `stop()` calls (there is no fan-out
to be non-atomic about; `stop()` awaits every forward's shutdown in one `Promise.all` and the
encode is one process).
The OAuth-connect popup's `postMessage` fallback (polling `popup.closed`) means a connect can take up to 500ms to be detected if the message itself is lost — a timing-dependent edge case. The **10-minute `OAuthState` TTL** (`oauthRoutes.ts`) is tight enough to genuinely expire during a human-in-the-loop connect: it did, during the real-API smoke test, when an `authUrl` was handed over and clicked a few minutes later. Working exactly as designed (fail closed on state reuse/expiry), but a real friction point for manual testing and demos. The playlist editor's drag-and-drop reordering has no automated test coverage (documented test-scope decision — see Task 11 brief). No e2e/Playwright coverage exists for any frontend flow. **(Fixed.)** Segment switches used to be able to kill the RTMP connection outright (confirmed by live testing, worse under rapid manual switching), because each track/pause segment was muxed to MPEG-TS by its own short-lived ffmpeg process, resetting the container's continuity counter and ADTS bitstream-filter state at every switch. The fix landed as the persistent-encoder rework described under "Overlay templates" Stage 2 below — one long-lived `PersistentEncoder` per stream (per destination at the time; per account since the local-first rework), never restarted for the session, fed by two Node-owned pipes instead of independent per-segment processes handed off through a FIFO, so there is no more continuity-counter/PTS discontinuity to begin with. Getting there took two rejected intermediate designs (a concat-demuxer MVP, then a two-FIFO split-encode-from-mux design that deadlocked against real ffmpeg binaries) before landing on this shape — see `docs/superpowers/specs/2026-09-03-obs-style-persistent-canvas-design.md` for the full story.

**Local-first streaming** knowingly leaves these open. (a)-(d) and (f)-(g) date from Phase A and are
unchanged by the unified rework; (n)-(q) at the end are what the rework itself opens:
(a) **MediaMTX is now a shared single point of failure** — one container relays every tenant's local
stream, so its crash takes them all down at once, and nothing re-publishes the sessions that were up
when it died. Mitigated only by `restart: unless-stopped`, the 512m memory limit and the exact
version pin; there is no per-tenant isolation.
(b) **iOS Safari cannot play the preview.** `Hls.isSupported()` is false there, so the `<video>`
element fetches the playlist with its native player, which will not attach the cross-site session
cookie the proxy authenticates with — the preview silently fails. A short-lived signed query token
on the preview URL would fix it; deliberately not built in this phase.
(c) **A publisher that survives a Node *crash* (not a container restart) keeps its connection.**
Revocation lives in the in-memory `MediaMtxAuthRegistry`, and MediaMTX's control API is deliberately
disabled by Layer 0, so nothing can kick an already-established RTMP connection — MediaMTX does not
re-authorise one. Mitigate later with MediaMTX read/write timeouts.
(d) **Local-stream state is in-memory**, so a backend restart drops every local stream — matching
this app's existing choice for stream state rather than a new regression.
(e) **(Closed.)** `buildStreamScene`'s `overlayCache`/`sessionId` parameters existed only for the
legacy multi-destination path; they are gone, together with `SessionOverlayCache`, replaced by a
single `sceneId` (which is simply the `userId` — one pipeline per account).
(f) **Stream secrets land in plaintext in `docker logs` for the backend container**, because
`createPipeSpawner` **and `createSpawner`** both forward ffmpeg's stderr verbatim and ffmpeg logs
its own output URL on startup. That is two leaks now, not one: the encoder logs
`Output #0, flv, to 'rtmp://mediamtx:1935/live/<token>?user=pub&pass=<secret>'`, exposing the
per-session MediaMTX **publish** secret (the same class of leak the design's "why not let MediaMTX
forward" section rejected `runOnReady` for, now happening one hop over), and **each
`RelayProcess` logs its own output URL too** — which for a custom RTMP destination contains that
destination's **decrypted stream key**, the very value `streamKeyCipher.ts` exists to keep
encrypted at rest. (The relay's *input* URL carries the MediaMTX read secret as well.) A relay's
stderr is deliberately drained through the same forwarder as everything else, so fixing this means
fixing the forwarder, not the relay.
(g) **The shared `MEDIAMTX_AUTH_SECRET` lands in MediaMTX's own logs** on any connection failure to
the auth endpoint (`Post "http://super-dj:3001/internal/mediamtx-auth/<SECRET>": dial tcp …:
connection refused`), which routine backend restarts will trigger — a consequence of carrying it as
a path segment rather than a header, which MediaMTX leaves no room for. Neither (f) nor (g) is
fixed; both are still tolerated on the same footing as this app's existing
secrets-in-process-args tolerance (destination stream keys are already visible to `ps` inside their
own container), but (f) got strictly worse when forwards landed — it now leaks a *destination's*
decrypted key, not just a session-scoped MediaMTX secret — and should be revisited first, e.g. by
redacting the trailing URL in the stderr forwarder, before this leaves a single trusted deployment.
(h) **(Fixed.)** Task 12's real-binary smoke test found the HLS preview could not play at all:
MediaMTX 1.21.0's playlists reference their children with a required `?session=<uuid>` query string,
and `localStreamPreviewRoutes.ts` built its upstream URL from Express's `req.params.file`, which
excludes the query — so every media-playlist and segment request 401'd and hls.js retried forever.
The proxy now forwards the inbound query verbatim (appended *after* the `ALLOWED_FILE` check, which
therefore still guards the file name alone), and `createPreviewFetch()` states `redirect: 'follow'`
explicitly rather than leaning on Node's default for MediaMTX's pre-auth `cookieCheck` 302. Both
re-verified against a real MediaMTX 1.21.0 driven through the actual running backend — see the
"Local relay (MediaMTX)" section above. Worth remembering for the next change here: **no unit test
could have caught the original bug**, because every preview test fakes `PreviewFetch` and so cannot
see a query string Express never gave the route in the first place. Real-binary verification is what
found it, and is what closed it.
(i) **(Fixed.)** `docker/mediamtx.yml` now sets `moq: false` and uses the plural `hlsAllowOrigins:
[]`, both asserted by `test/infra/mediamtxConfig.test.ts`. v1.21.0 had been starting a MoQ listener
on :8892/:8893 by default (never exposed — no ports are published) and logging a deprecation warning
for the singular `hlsAllowOrigin`; a real 1.21.0's startup log confirms both are gone. The standing
risk is the general one rather than these two keys: the surface list is a denylist that a future
version bump can outrun again.
(j) **A local stream that hits a permanent, unrecoverable error (`onError` fires) keeps its
`LocalStreamEntry` — and everything it holds — resident for the rest of the process's life,
not just a small bookkeeping record.** The retained entry's `StreamController` still holds the
whole scene closure: the resolved playlist's `tracks` array, the user's **full**
`allUserTracks` array (used for play-by-name lookup), and the resolved template's elements/gif
configs. For a user with a large library this is real memory, not a small record, and nothing
reaps it except that same user calling `start`/`stop` again. Consider evicting the entry after
an interval, or replacing the retained live controller with a small terminal-status snapshot.
(It no longer pins a **concurrency slot**, at least: `start()`'s `active` count excludes entries in
`error`, since an errored encoder has already stopped costing CPU. Only the memory is retained.)
(k) **(Closed.)** Phase A could run two independent, separately-uncapped encode pools on one host:
`MAX_CONCURRENT_LOCAL_STREAMS` (default 10) bounded local streams only, while
`/stream-sessions/*`/`/destinations/{id}/stream/*` had and always had no cap on concurrent
per-destination encodes, so a host could reach `10 + N`. Those route families are gone, and with
them the second pool: **`MAX_CONCURRENT_LOCAL_STREAMS` is now the only encode ceiling and it is
the real one.** What it does not bound is `RelayProcess` count — a user's N destinations are N more
ffmpeg processes — but each is a `-c copy` costing ~1.4% CPU / ~16 MiB against the encode's ~68% /
~84 MiB, so capacity is still sized off encodes.
(l) **(Fixed.)** The HLS preview could hang forever — no video, no network activity, until a manual
page reload — whenever its first read landed in MediaMTX's on-demand 404 window (the common case:
the page mounts the player the instant `previewReady` flips true, ~2 s before the encoder's publish
is established), and again whenever MediaMTX destroyed the session mid-playback. Root cause was
entirely client-side: hls.js never retries a 4xx, so the 404 goes straight to a fatal
`manifestLoadError`, and the old handler's `hls.startLoad()` is a no-op for a manifest that never
parsed (and, once one has, re-requests the same permanently-401 `?session=<uuid>` URL).
`HlsPlayer.tsx` now destroys and rebuilds the `Hls` instance on a capped, never-expiring backoff.
Confirmed and re-verified with real binaries — see "Local relay (MediaMTX)" item 3 for the full
timings and log lines. Two things worth carrying forward: the **native-HLS fallback path** (iOS
Safari, follow-up (b) above) gets none of this recovery, since nothing there is an `Hls` instance to
rebuild — one more reason (b) needs a real fix rather than a documented shrug; and a `[HLS]
[session …] created by` line in MediaMTX's log means a request arrived, **not** that a session
exists, so never read one as evidence that a read succeeded.
(m) **(Fixed.)** A second, unrelated "the preview never plays" failure: built while the browser tab
is **hidden**, the player loaded both playlists successfully every ~2 s forever and never requested
a single segment, with `readyState 0` and no `ERROR` event to recover from. Root cause is again
entirely client-side and entirely environmental — Chrome defers a media element's load while
`document.hidden`, so the `MediaSource` never opens, hls.js never fires `MEDIA_ATTACHED`, and
`StreamController.doTickIdle()` bails at its first gate on every tick. `HlsPlayer.tsx` now declines
to build a player while the page is hidden and builds/rebuilds one on `visibilitychange`. Every
server-side suspect (playlist shape, proxy content types, segment keyframe/PTS structure) was
measured against the real stand and cleared — see "Local relay (MediaMTX)" item 4 for the full
evidence. **Carry forward: browser automation that drives a background window reproduces this
100% of the time**, so a stall observed only through such a tool must have `document.visibilityState`
checked before anything server-side is suspected. The native-HLS fallback path (iOS Safari,
follow-up (b)) again gets none of this, for the same reason as in (l).
(n) **Destination forwards are in-memory, like everything else — but now with a platform-visible
consequence.** A backend restart drops every `DestinationForward` along with the local stream it
read from ((d) above), which is the same tradeoff this app has always made for stream state. What
is new is what it leaves behind *outside* the process: a YouTube `liveBroadcast` a forward had
created is never transitioned to `complete`, because the only object that could finalize it is
gone. The channel is left showing a broadcast that will never end until the user toggles that
destination on and off again (the next toggle-on creates a *new* broadcast; it does not adopt the
orphan). The reusable `liveStream` is unaffected — it is persisted, and it is supposed to survive.
(o) **There is no per-user toggle rate limit.** A user clicking a checkbox repeatedly drives a full
`prepareSession` → broadcast → `finalize` cycle each time, against the app's **shared** daily
YouTube Data API quota — one quota for every tenant, since all of them go through one Google Cloud
project. The measured cost is **~7 units per full cycle** (29 units observed for a whole day of
roughly four cycles), so the default 10,000/day supports on the order of **1,000+ cycles/day for
the entire app**. That is 40-50x more headroom than the design spec's ~330 units/cycle estimate
implied (~30 cycles/day), which is what had made a rate limit look urgent — at the measured cost it
is a safety margin against a pathological client rather than a capacity requirement. If one is
added, size it off ~7 units/cycle, not off the old estimate.
(p) **A forward's `error` is sticky until the user toggles it off and on again.** Deliberate — a
forward that gave up must never silently re-arm itself on an unrelated `reconcile()`, of which
there is one per local status change — and the local session ending also clears it, so a fresh
session never inherits a stale failure. But it does mean a *transient* platform outage leaves that
destination sitting in `error` with a reason, needing a manual re-toggle, while the local stream
and every sibling forward carry on. There is no automatic retry after the relay's own reconnect
budget is spent.
(q) **Added relay latency — the local-preview-vs-destination-player delta — has NOT been measured.**
The design's estimate is **0.5-2 s** for the `-c copy` hop, and it remains exactly that: an
estimate. The real-API smoke test deliberately skipped it (it needs a side-by-side view of the
cookie-authenticated local preview and the destination's own player at the same visible change),
so do not quote a number here as measured. What *was* measured about the relay's timing is in the
`RelayProcess` bullet above; latency is not among it. For context on the scale: YouTube's own
ingest→transcode→CDN→player pipeline typically adds ~20-40 s at `latencyPreference: 'normal'`
regardless, so this hop is unlikely to be the dominant term either way.
(r) **(Fixed 2026-09-24.)** `CanvasFeeder.render()` had no "latest request wins" rule: two
overlapping one-shot renders (the once-a-second timer tick racing a burst's canvas-A/canvas-B
re-bake, or either racing a `pause()` render) shared one fixed overlay PNG path, and whichever
one-shot ffmpeg process happened to finish last landed on screen regardless of which was issued
last — occasionally two renders' ffmpeg processes overlapped enough for one to read the file mid-
overwrite by the other, producing a single frame with the outgoing and incoming rows visibly
blended/doubled. Reported live, on a real stream, the day the playlist-window burst layer (Phase C)
made it substantially easier to hit. `render()` now **serializes** every call — a `rendering` flag
plus a FIFO `pendingQueue`, with the lock handed directly from one call's `finally` to the next
queued waiter (never released-then-reacquired, which would itself reopen a window for a fresh call
to slip in) — so two calls' write+spawn+read cycles can never overlap. The first fix attempt tried
discarding a queued call's result whenever a *newer* call had merely been *issued* (not finished)
in the meantime, reasoned as a "latest wins" safety net; real review caught that this throws away a
render's own valid, just-finished work for no reason and, under real host load, could cascade to
discarding *every* render in a burst, freezing the canvas for the rest of the session — removed
entirely. Plain FIFO already guarantees the last call to actually finish is the most recently
issued one, with nothing to discard. Serializing also introduced a new failure mode that didn't
exist before (a single hung, close-event-never-fires ffmpeg process would now freeze every *later*
render() call too, not just its own caller) — closed with a `RENDER_TIMEOUT_MS = 5000` timeout in
`runOneShot` that kills the child (`SIGKILL`) and rejects, letting the queue move on. See
`test/ffmpeg/canvasFeeder.test.ts`'s "concurrent render() calls" suite for the regression tests
(FIFO-all-three-run, rejection-doesn't-stall-the-queue, post-close no-op, timeout-releases-queue,
close-drain-wakes-everyone).
**Known non-blocking follow-ups from this fix, not yet acted on:** (1) the once-a-second timer
ticker has no coalescing — if a render is genuinely slow (approaching the 5s timeout) for a
sustained period, ticks queue up faster than they drain and a track-switch render can end up
waiting behind a growing backlog of stale ticks; a cheap fix would be having the ticker skip firing
while a render is already in flight. (2) `StreamController.feedCurrentTrack()`'s auto-advance
listener is attached to the *decode* child, not gated on the canvas render succeeding — a canvas
render that rejects (non-zero exit, or now a timeout) already meant, even before this fix, that the
frame simply doesn't update; not a regression from this fix, but adjacent and worth closing at the
same time if this area gets touched again.

## Tooling

Developed with help from the [wshobson/agents](https://github.com/wshobson/agents) Claude Code
plugin marketplace. No repo-specific plugin is pinned.
