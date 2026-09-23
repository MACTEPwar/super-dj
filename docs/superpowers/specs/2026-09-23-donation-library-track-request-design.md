# Donation library-track requests — design spec

Status: design agreed with the user in brainstorming (2026-09-23); this document writes it up,
closes the gaps the brainstorm left open, and records every judgment call made while doing so.
Implemented in three sequential phases — **B → A → C** — each in its own session, each with its
own plan file (see "Implementation plans" at the end).

## Goal

A donor's free-text `!song:<query>` can have typos, and the external media-search service can
return the wrong track. Give donors a second, exact path: a public page listing the tracks of the
streamer's currently-live playlist, where each track has a "copy" button producing a ready-to-paste
donation command that identifies the track by its database id. Alongside it:

- **Phase B** — stop donation requests from interrupting playback. Every requested track (free-text
  or exact) is queued "next", exactly like the streamer's own `play`-by-name.
- **Phase A** — the public request page, its share token, and a new `libraryTrackRequest`
  interaction-rule action type that resolves a command to a real library track.
- **Phase C** — when a track is queued, the overlay's playlist window shows it arriving with a real,
  smooth animation instead of an instant cut.

Success criteria, per phase:

- B: a donation never cuts off the current track; it plays after it, in arrival order alongside
  `play`-by-name requests; every interrupt-only code path is gone; no regression in reconnect,
  pause/resume, or temp-file cleanup.
- A: a donor opening the shared link sees the live playlist (or "not live"), copies a command, and
  a donation carrying it plays exactly that track; a bad/foreign/garbled id is dropped silently like
  every other donation failure; the streamer can show, copy, rotate and disable their link.
- C: a queued track visibly slides into the playlist window over ~0.6 s on the real stream, the
  stream's timing is unaffected (encoder speed stays ~1.0x), and a template without a playlist
  element pays nothing.

## Why this order

B first because A's resolution path needs B's unified "queue this next" call to exist (and to be
named for what it does); C last because it animates what B makes true — a donation track becoming
an ordinary upcoming queue entry — and because C is the only phase that needs real-binary
performance work, which should not block A shipping.

---

## Phase B — one queue, no interrupt

### What exists today

`PlaylistQueue` has two FIFOs: `insertedQueue` (`insertNext()`, consumed by `next()`, entries join
`history`) and `donationQueue` (`enqueueDonation`/`hasDonationPending`/`shiftDonation`, never touches
`position`/`history`). `StreamController` layers an interrupt-and-resume state machine on the
second: `nowPlayingTrack`, `interruptedForDonation`, `interruptCurrentTrackForDonation()`,
`playNextDonationTrack()`, `advanceAfterTrackFinished()`'s donation branch, the 409 guard in
`next()`/`previous()`, the `nowPlayingTrack ?? queue.current()` reads in `resume()`/
`handleUnexpectedExit()`/`status()`, the `interruptedForDonation` restore in
`handleUnexpectedExit()`, and the donation branch at the top of `performReconnect()`.

### Design

Delete everything that exists only to support interrupt/resume:

- `PlaylistQueue`: remove `donationQueue`, `enqueueDonation()`, `hasDonationPending()`,
  `shiftDonation()`. `insertNext()` is the one "queue this next" mechanism.
- `StreamController`: remove `nowPlayingTrack`, `interruptedForDonation`,
  `interruptCurrentTrackForDonation()`, `playNextDonationTrack()`, and `advanceAfterTrackFinished()`
  (the `close` handler calls `advanceToNextTrack()` directly again). `next()`/`previous()` lose the
  409 guard. `resume()`, `handleUnexpectedExit()`, `performReconnect()` read `queue.current()`
  directly; `performReconnect()` loses its donation branch and keeps only the plain-playlist path
  (which already handles "the queue moved on while reconnecting").
- `status().currentTrack` becomes `queue.current()?.name` **only while the state is `streaming`,
  `paused` or `reconnecting`, else `null`** (see edge case B7 — this keeps today's observable
  "null when nothing is playing" behaviour, which `nowPlayingTrack` provided implicitly by being
  cleared in `teardown()`).

**Rename `insertEphemeralTrack` → `enqueueTrack`** on `StreamController`, `LocalStreamManager`, and
`songRequestAction.ts`'s `StreamInserter` interface. Its body becomes exactly `playByName`'s tail:
`this.deps.queue.insertNext(track); this.deps.onStatusChanged?.();`. Justification: after B the
method has nothing ephemeral-specific about it, and Phase A calls it with a *real library track* —
keeping "Ephemeral" in the name would make the Phase A call site read as a bug. `playByName(name)`
stays as the name-resolving front door and calls `enqueueTrack()` internally, so there is literally
one line that inserts.

### Temp-file lifecycle once donation tracks are ordinary queue entries

Today a donation track is never in `history` and can never be skipped, so its `_onFinished` hook
(deletes the temp file) fires reliably at natural end. After B neither is true, which opens two
real holes this phase must close:

1. **`previous()` would replay a deleted file.** A finished donation track now sits in `history`;
   `previous()` pops it and feeds an audio path whose file `_onFinished` already unlinked (the
   decoder exits at once, the track silently "plays" for 0 s, and the queue advances).
   **Fix:** add `ephemeral?: true` to `Track` (set by `songRequestAction.ts` alongside
   `_onFinished`), and `PlaylistQueue.next()` does not push an ephemeral current track into
   `history`. A dedicated flag, not "has `_onFinished`", because `_onFinished` is self-disarming
   (cleared after it fires) and so cannot be read after the fact.
2. **Skipping would leak the file.** `next()`/`previous()` can now move off a donation track
   mid-play; the `close` handler that fires `_onFinished` is generation-guarded and never runs for a
   superseded track. **Fix:** `StreamController.next()`/`previous()` capture `queue.current()`
   before the queue operation and, if it changed and the old track carries `_onFinished`, invoke it
   (same self-disarm + try/catch discipline as the `close` handler — extract that into one private
   `releaseTrack(track)` helper used by both sites).

Tracks queued but never reached before `stop()`, and a track playing at `stop()`/crash-give-up, are
left to the existing 12-hour `startTempFileCleanupSweep` backstop — unchanged from today (a stop
mid-donation already leaves its file to the sweep). The `server.ts` comment justifying the 12-hour
threshold ("the queue is an unbounded FIFO…") becomes *more* true, not less, and stays.

### Overlay window machinery: still needed, renamed

`positionInBase()` + `buildEphemeralPlaylistWindowLines()` exist because a track that is not in the
playlist's own `tracks` snapshot can't be found by name, and `buildPlaylistWindowLines()` would
render an empty window for it. That is **not donation-specific**: a `play`-by-name track taken from
the user's whole library (not the running playlist) hits the same miss today, and after B so does
every donation track, now arriving via `insertNext()` and becoming `queue.current()` through
`next()`. The machinery stays. Phase B only fixes its doc comments (they describe "a donation
interruption") and renames `buildEphemeralPlaylistWindowLines` → `buildInsertedTrackWindowLines`.
Phase C then replaces both window builders with a queue-aware snapshot (see Phase C, "Window
contents").

### What B deliberately does not change

`SongRequestQueue` (arrival-ordered serialization of free-text fetches), `executeSongRequest`'s
result shape, the webhook's fast-200, the `_onFinished` hook itself, and the playlist window's
contents (it still does not list upcoming inserted tracks until Phase C — see edge case C1).

---

## Phase A — public request page + `libraryTrackRequest`

### Data model

One additive schema change: `User.requestPageToken String? @unique`. A real migration
(`add_user_request_page_token`) must be generated during implementation via the documented
remote-Postgres workflow on 192.168.14.26 (CLAUDE.md "Persistence") — never hand-written. The new
action type is a string value in the existing `InteractionRule.actionType` column and needs no
schema change.

Why a column on `User`, not a new table: there is exactly one live token per account, rotation is
"overwrite", and nothing needs rotation history. A table would add a join and a relation for no
behaviour. If per-link analytics or several concurrent links are ever wanted, that is when a table
earns its place.

**Token shape and handling** — deliberately matching `LocalRelayTarget`'s path token:
`randomBytes(16).toString('hex')`, 32 lowercase hex chars, 128 bits. It is minted only by an
explicit streamer action (never lazily by a GET), never logged, never included in any response
other than the owner's own `GET /request-page`, and rotation/disable take effect on the next request
(DB-backed, nothing caches it). It is stored in plaintext, deliberately: the owner's settings page
must be able to redisplay it, and what it unlocks — the track names of a playlist the streamer is
already broadcasting publicly — is low-sensitivity. (Contrast stream keys, which unlock publishing
and are AES-GCM-encrypted.) It is *not* the `userId`, so rotating it never touches account identity,
and a leaked `userId` never exposes the page.

### Backend API

Authenticated (owner) routes, `src/requestPage/requestPageRoutes.ts`, mounted at `/request-page`,
`requireAuth`, mutating routes require `Content-Type: application/json` like every other mutating
route:

- `GET /request-page` → `{ token: string | null }`.
- `POST /request-page/token` → mints a new token (creating or replacing), `{ token }`. Replacing is
  how rotation works; the old link 404s immediately.
- `DELETE /request-page/token` → sets it to null, `{ token: null }`. The page is off.

No ids in any of these URLs: the token belongs to `req.user.id`, so there is no ownership check to
get wrong.

Public route, `src/requestPage/publicRequestPageRoutes.ts`, mounted at `/public/request-page`, **no
authentication**:

- `GET /public/request-page/:token`
  - `:token` not matching `^[0-9a-f]{32}$` → 404 **without touching the database** (cheap
    rejection of garbage; the same "reject by shape before the expensive check" idea as MediaMTX's
    Layer 1 regex path).
  - No user with that token → 404 (same body as a malformed token, so the two are
    indistinguishable).
  - Owner's local stream not `streaming`/`paused`/`reconnecting` (from
    `LocalStreamManager.status(userId).local`) → `200 { live: false }`. `starting` counts as not
    live (no `playlistId` yet); `reconnecting` counts as live (the session and its queue survive).
  - Otherwise `200 { live: true, playlistName, tracks: [{ id, name, durationSeconds }], request }`,
    where `tracks` is `playlistRepository.listTracks(local.playlistId)` in playlist order, read
    fresh from the database on every request, and `request` is `{ keyword, minAmount }` from the
    owner's enabled `libraryTrackRequest` rule with the **lowest** `minAmount` (the cheapest
    command that actually works), or `null` if there is no enabled rule of that type.
  - Response headers: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`.
  - Nothing else is exposed: no `audioPath`, `coverPath`, `userId`, email, template, or queue state.

`PlaylistTrackView` gains `durationSeconds: number | null` (additive; the column is already on
`Track` and cached at upload).

**Threat model of the public route.** The token *is* the access control, so the route leaks only
what a token holder may see, and nothing about any other account: the token resolves to exactly one
user, and the playlist id is read from that user's own in-memory stream entry — never from the
request. There is no id parameter to swap (no IDOR surface). Enumeration is infeasible at 128 bits.
There is no rate limit, which is an accepted, stated risk: it matches the rest of this app's
unauthenticated surface (`/auth/login`, `/auth/register` have none either), a garbage token costs a
regex, and a valid token costs two indexed queries. CORS is unchanged: the page is served from the
frontend origin, which the existing policy already allows, and the public fetch sends no
credentials.

### The copy command

Built client-side on the public page from `request.keyword` and each track:

```
!<keyword>:<prefix> <uuid>
```

- `<prefix>` is the track name with every whitespace run (including newlines) collapsed to one
  space, trimmed, then cut to its first **20 code points** (`Array.from(name).slice(0, 20)`, not
  UTF-16 units, so an emoji is never split into a lone surrogate). Purely for human readability in
  the donation feed; the backend ignores it.
- `<uuid>` is the track id, all 36 characters.
- One space separates them — a small addition to the agreed format, for readability in the feed. It
  changes nothing for the parser (below).

The page uses `navigator.clipboard.writeText` and, when that is unavailable or rejects (non-secure
context, permissions), falls back to showing the command in a pre-selected read-only text field so
the donor can copy it by hand.

### Resolving a matched command

New module `src/donations/libraryTrackRequestAction.ts`:

```ts
export type LibraryTrackRequestResult =
  | { ok: true }
  | { ok: false; reason: 'trackIdMissing' | 'trackNotFound' | 'noActiveStream'; message: string };

export async function executeLibraryTrackRequest(deps, query): Promise<LibraryTrackRequestResult>
```

1. **Extract the id as the LAST UUID-shaped substring of the query**
   (`/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi`, last match, lowercased).
   This deliberately strengthens "take the last 36 characters": for the command exactly as copied
   the two are identical, but the regex also survives a donor who types anything after the command
   ("…a1b2 thanks!!"), trailing whitespace the parser didn't trim, or a UUID-looking substring
   inside the name prefix (the real id is always last). The parser itself (`COMMAND_PATTERN`) is
   unchanged — it already captures everything after `!keyword:` as one string. No match →
   `trackIdMissing`.
2. `trackRepository.findById(id)`; missing **or** `track.userId !== targetUserId` → `trackNotFound`
   (one reason for both, so the result never distinguishes "exists but someone else's").
3. Map to a playlist `Track` (`name`, `audioPath`, `coverPath`, `overlayOverride`; no `ephemeral`,
   no `_onFinished` — it is a real library track and joins `history` like a `play`-by-name track).
4. `streamInserter.enqueueTrack(targetUserId, track)`; a throw (no active stream) →
   `noActiveStream`.

Every failure is `console.error`-logged and otherwise dropped — a donation has no feedback channel,
by design, and this path does not invent one.

**Membership in the live playlist is deliberately not checked.** Only ownership is. The playlist can
change between a donor copying a command and the donation arriving, and dropping a paid request over
that race is worse than playing a track of the streamer's own that isn't in the current playlist.
The only ids a donor can realistically know are ones some request page showed them.

**Not routed through `SongRequestQueue`**, as agreed: there is no download to race, so it resolves
in two indexed queries and inserts immediately. Consequence stated plainly (edge case A5): a library
request can overtake a free-text request that arrived *earlier* but is still downloading. See
"Judgment calls" #2.

### Rule type, validation, dispatch

- `KNOWN_ACTION_TYPES` becomes `['songRequest', 'libraryTrackRequest']`.
- **New: a `commandKeyword` must be unique among the user's own rules** (compared lowercased, which
  is how it is stored). `POST` and `PUT` answer **409** if another of the caller's rules already
  uses the keyword (a `PUT` excludes the rule being edited). Without this, a `songRequest` and a
  `libraryTrackRequest` rule sharing `track` would *both* fire on every matching donation —
  `matchRules` returns every matching rule — sending the copied command to the media-search service
  as a garbage free-text query as well. Enforced in the route, not as a DB constraint: existing
  duplicate `songRequest` rules (possible today) keep working rather than breaking a migration, and
  simply can't be *re*-saved with a clash.
- **Dispatch by action type.** A new `src/donations/donationActions.ts` defines
  `type DonationActionResult = SongRequestResult | LibraryTrackRequestResult` and
  `type DonationActionHandlers = Record<ActionType, (query: string) => Promise<DonationActionResult>>`.
  `server.ts` builds one handlers object — `songRequest` → `songRequestQueue.enqueue(query)` (as
  today), `libraryTrackRequest` → `executeLibraryTrackRequest(...)` — and hands the **same** object
  to both the webhook (whose loop becomes the `switch`-on-`actionType` its own comment anticipated)
  and the rule test route. This replaces the `executeSongRequest` dep on both.
- **The "Test" button** (`POST /interaction-rules/{id}/test`) needs no new logic: it already runs
  the real `matchRules` for exactly that rule, then dispatches `match.rule.actionType` through the
  shared handlers. Its response shape is unchanged, with `result` widened to
  `DonationActionResult`.

### Frontend

- **Public page** `frontend/src/pages/RequestPage.tsx`, route `/r/:token`, registered **outside**
  `ProtectedRoute` and `AppShell` (no sidebar/header). It fetches with a plain `fetch` (no
  `credentials`), not the shared `api` client. States: loading; not found ("this link isn't
  valid"); not live; live without `request` (track list, no copy buttons, "requests aren't enabled
  right now"); live with `request` (per-track copy button, plus "minimum donation: N UAH" and a
  short how-to: copy, paste into the donation message). Adds `<meta name="referrer"
  content="no-referrer">`. Loads once — no polling, no SSE, a manual "refresh" button only. i18n in
  en/ru/uk. The app-wide `AuthProvider` will still issue one `GET /auth/me` for an anonymous donor;
  it treats 401 as "logged out" without redirecting (verified in `useAuth.tsx`), so this is a wasted
  request, not a break.
- **Streamer side** (`frontend/src/pages/Donations.tsx`): a "Request page" card above the rules list
  showing the full link (`${window.location.origin}/r/${token}`), Copy, Regenerate (behind
  `ConfirmDialog`: "the old link stops working"), Disable, or "Create link" when there is none. A
  hint appears when no *enabled* `libraryTrackRequest` rule exists ("the page will list tracks but
  offer no command").
- **Rules UI:** the action-type `<select>` becomes real (enabled on create, disabled on edit — an
  existing rule's type isn't editable, and the backend's `PUT` default already keeps it). Switching
  the type in the create form swaps an untouched default keyword (`song` ↔ `track`).
  `ACTION_TYPE_LABELS`, the `ActionType` union, `SongRequestResult` → `DonationActionResult`, and
  the test panel's error toast learn the new reasons. The test panel's default message for a
  `libraryTrackRequest` rule is `!<keyword>:` plus a hint to paste a command copied from the request
  page — a working default can't be invented without a real track id.

### Scope limit inherited from the MVP

Donations are routed only to `DONATION_TARGET_USER_ID`. Any user can create a request page and a
`libraryTrackRequest` rule, but only the target user's are ever used by a real donation — exactly
as with `songRequest` rules today. A non-target user's page copies commands that, if donated,
resolve against the target user's library and fail ownership → dropped. Not fixed here; noted so
nobody mistakes it for a Phase A bug.

---

## Phase C — animated playlist window

### Settled fact from the spike (do not re-litigate)

ffmpeg's live-command path cannot drive this. A real ffmpeg 8.0 `sendcmd` script matched a named
filter instance and fired on schedule (`-loglevel debug`: `Processing command #0 target:ov1
command:x arg:200`), but both `overlay` and `drawbox` replied `Command reply for command #0:
ret:Function not implemented`, and pixel sampling showed the box's position byte-identical before
and after. The dispatch worked; the target filters implement no `process_command` for `x`/`y`. `zmq`
goes through the same `avfilter_graph_send_command` path, and injecting expression strings hits the
same wall. No `sendcmd`/`zmq`/runtime-expression design is considered.

### Chosen approach: a dedicated, continuously-fed playlist-window pipe

A new raw-video pipe carries **only the playlist window's region**, composited by ffmpeg at a fixed
x/y with no ffmpeg-side motion. All animation is computed and rendered in Node.

**The fork, and the call made on it.** Either (i) the playlist window moves out of the baked Satori
canvas *permanently* and this layer always draws it, or (ii) the canvas keeps drawing the settled
window and this layer only contributes during a burst. **Chosen: (i), permanent.** The decisive
fact: *a raw pipe declared to ffmpeg must be fed continuously at its declared rate in both designs*
— `overlay`'s frame sync stalls the entire encode on any input that stops delivering frames (the
failure `PulseVisualizer.framesDue()` exists to prevent; see its comment). So (ii) saves no
steady-state cost at all — it would write transparent frames all the time instead of the window —
and adds a handoff: at burst start and end, the canvas (5 fps heartbeat, one-shot ffmpeg render, ~100
ms+ latency) and this layer (30 fps) would have to swap who draws the window on the same frame, or
the window would visibly double or blink. (i) has one code path for how the window looks, no
handoff, and the preview endpoint renders it through the same row builder.

### Pipe, fd, and compositing

- **fd 7 / `pipe:7`**, a new `playlistWindowPipe` on `ChildProcessWithPipes`. Existing fds are
  unchanged: 3 canvas, 4 audio, 5 equalizer, 6 above-canvas. `createPipeSpawner` opens stdio slot 7
  unconditionally (stdio becomes 8 entries) and attaches an `'error'` listener, exactly like 5 and 6.
- **Optional, like the equalizer.** `buildPersistentEncoderArgs` gains `playlistWindow?: { x, y,
  width, height }` and declares `-f rawvideo -pix_fmt rgba -s WxH -r 30 -i pipe:7` only when present.
  The input is appended **last** (after the above-canvas input) so no existing input index moves:
  `playlistWindowInputIndex = aboveCanvasInputIndex + (split ? 1 : 0)`.
- **Filter:** `[idx:v]format=yuva420p[plwin]`, then `[videoPad][plwin]overlay=X:Y[vplwin]`, placed
  **after the top canvas layer and before the equalizer**. So the window draws above the canvas
  (including the timer) and above gifs, and below the equalizer. This is the same kind of fixed-slot
  approximation the equalizer already makes (it always draws on top regardless of element order);
  a template that lists an opaque element *after* the playlist to cover it will now have the playlist
  on top. Stated, not engineered around.
- **RGBA straight alpha**, following `PulseVisualizer`: resvg's premultiplied pixels go through the
  existing `unpremultiplyRgbaInPlace` before being written.
- **Declared rate: 30 fps** (`PLAYLIST_WINDOW_FPS = VIDEO_FPS`), so the animation runs at the output
  frame rate with no duplicate-frame stepping. It is one named constant; see "Cost" for the measured
  fallback rule.

### Region geometry

`PlaylistElement` has no height, and a pipe needs fixed dimensions. Rows therefore get a
**deterministic height**: `rowHeight = round(fontSize × 1.25)`, applied as an explicit `lineHeight`
and `height` on every row. Rows become **single-line** (`whiteSpace: nowrap`, `overflow: hidden`,
`textOverflow: ellipsis`) — needed so a long name can't wrap and break the row grid. Both are small
visible changes to existing templates (today rows use Satori's `normal` line height, about 1.16 for
DejaVu Sans, and long names wrap), and the preview endpoint shows them identically, because it
renders rows through the same shared node builder.

- `visibleRows = PLAYLIST_WINDOW_BEFORE + 1 + PLAYLIST_WINDOW_AFTER` (= 10) and `regionRows =
  visibleRows + 1`: one extra row of room so the row pushed out at the bottom can slide down while
  it fades instead of being clipped hard.
- `pad = ceil((stroke?.width ?? 0) + max(|shadow.offsetX|, |shadow.offsetY|) + (shadow?.blur ?? 0)) + 2`.
- Region = `[el.x − pad, el.x + el.width + pad] × [el.y − pad, el.y + regionRows·rowHeight + pad]`,
  clamped to the 1280×720 canvas, **with x/y rounded down to even and width/height adjusted to
  even**. The persistent encoder's `overlay` snaps odd coordinates to the yuv420 chroma grid (see
  `GIF_OVERLAY_FORMAT`'s comment), and an even origin makes placement exact at zero cost, without
  the RGB-compositing option the gifs pay for.
- A region with width or height < 2 after clamping (an element placed off-canvas) is treated as "no
  playlist layer": no pipe, no feeder.
- Default template: 700 px wide at `fontSize: 22` gives `rowHeight` 28 and a region of about
  704 × 312.

### Window contents: a queue-aware snapshot with stable keys

Today the window lists only base-playlist tracks around the current one, so a queued track is
**invisible until it starts playing** (true today for `play`-by-name, and for every donation after
B). The animation needs the queued track to appear, so Phase C changes what the window shows:

`PlaylistQueue.windowSnapshot(before, after): WindowRow[]`, with `WindowRow = { key, text, isCurrent }`:

- **Before:** the same base context as today — `before` base rows ending just before the current
  base index, or, when the current track is an inserted one, the `before` rows ending at (and
  including) `positionInBase()` (today's two builders' semantics, unchanged).
- **Current:** `▶ <name>`.
- **After:** remaining `insertedQueue` entries in FIFO order, then base rows from
  `positionInBase() + 1`, `after` rows in total (no wrap-around, as today).
- **Keys are stable per queue entry**: base rows are `b:<baseIndex>`, inserted entries get
  `i:<seq>` from a per-queue counter assigned in `insertNext()`, and an inserted entry keeps its
  key when it becomes current. `history` stores `{ track, key }` so `previous()` restores the right
  key too.

This replaces `buildPlaylistWindowLines`/`buildInsertedTrackWindowLines` and `positionInBase()`'s
use as a render argument. `buildOverlay(track, windowRows)` still receives the rows, because a
template's **second and later** `playlist` elements (rare) stay baked into the canvas with the same
row builder — they update on track change only, like today, and don't animate. Only the **first**
`playlist` element goes on the live layer. One region per element would mean one pipe per element.

### Components

- **`RawFramePacer`** (`src/ffmpeg/rawFramePacer.ts`) — **extracted from `PulseVisualizer`**, with
  identical behaviour: `framesDue()`, `framesAccounted`/`framesWritten`, `MAX_CATCH_UP_FRAMES`, the
  forgive-under-backpressure rule, and the `'drain'` handler. `PulseVisualizer` delegates to it and
  `test/ffmpeg/pulseVisualizer.test.ts` must pass **unmodified** — that is the refactor's acceptance
  test. Extracted, not copied, because this is the most measured and least obvious write discipline
  in the repo, and two drifting copies of it would be a liability.
  - This is the same invariant as `CanvasFeeder`'s "every write lands exactly `heartbeatMs` apart"
    rule — the frame count written must track wall-clock time × declared rate — in the form that
    holds at 30 fps. It also removes the bug `CanvasFeeder` once had *by construction*: a render
    never writes to the pipe. It only replaces the cached frame, and the pacer's tick does all the
    writing.
- **`PlaylistWindowFeeder`** (`src/ffmpeg/playlistWindowFeeder.ts`) — one clear purpose: turn
  "what rows should the window show" into a continuously-paced raw RGBA stream on `pipe:7`,
  animating insertions. API: `attach(pipe)`, `setRows(rows: WindowRow[])`, `close()`. It holds a
  30 fps tick timer (`.unref()`'d), a pacer, the cached frame, the "rendering" in-flight flag, and
  the animation state. Constructor takes geometry, the element's style, and an injectable
  `renderFrame` and `now` (for fakes/tests, like `PulseVisualizer`).
  - **Before its first render**, the cached frame is a pre-allocated all-zero (fully transparent)
    buffer, so the encoder never stalls waiting for this pipe. That frame is also what a render
    failure falls back to (log, keep the last good frame; a transparent frame only if nothing was
    ever rendered) — the same "keeping the stream up matters more than one picture" policy as the
    canvas's `BLANK_OVERLAY_PNG`.
- **Why not a capability of `CanvasFeeder`:** different cadence (30 vs 5 fps), different pixel
  format (rgba vs yuva420p), different renderer (Satori-direct pixels vs one-shot ffmpeg), and
  different pacing discipline. Merging them would couple two timing regimes in one class.
  Why not `PulseVisualizer`: that class is audio-analysis-driven. The shared part is exactly the
  pacer, and that is what gets shared.
- **Rendering:** a new worker entry `src/render/playlistWindowRenderWorker.ts` in its own small
  piscina pool `src/render/playlistWindowRenderPool.ts` (`maxThreads` 2, `idleTimeout` 60 s,
  **`useAtomics: false`** — the RSS-leak scar documented in `pulseRenderWorkerPool.ts` applies
  verbatim). The worker runs Satori → resvg and returns raw `pixels`. The pool rewraps the returned
  `Uint8Array` with `Buffer.from(buf.buffer, byteOffset, byteLength)` (the worker-boundary scar), and
  fonts are loaded inside the worker via `fontCache`, as `renderScene` does, so no font bytes cross
  the boundary. It gets its own pool so an animation burst never queues behind, or delays, another
  tenant's 1280×720 canvas render in the shared render pool.
- **One shared row builder** (`playlistWindowNode(el, rows, layout)` in `sceneRenderer.ts`): used by
  the preview/bake path (settled layout, rows at `i·rowHeight`, opacity 1) and by the worker
  (per-frame offsets/opacity, origin shifted into region coordinates). The window looks the same in
  the editor preview, on stream settled, and at the end of every animation.

### Lifecycle and wiring

- `buildStreamScene()` finds the first `playlist` element, computes its region, removes it from the
  baked element lists (`isBaked` excludes it, like timer/equalizer/gifs), passes
  `playlistWindow: region` to `createPersistentEncoder`, and exposes
  `createPlaylistWindowFeeder?: () => PlaylistWindowFeeder`, present only when the template has a
  usable playlist element (same optional-factory shape as `createPulseVisualizer`). **No playlist
  element → no factory, no `-i pipe:7`, no renders, no timer: zero cost.**
- `StreamControllerDeps` gains `createPlaylistWindowFeeder?`. `spawnPipeline()` creates and attaches
  it to `child.playlistWindowPipe`; `teardown()` closes it; it is recreated on reconnect like every
  other collaborator.
- `StreamController` pushes rows through one private `publishWindow()` —
  `this.playlistWindowFeeder?.setRows(this.deps.queue.windowSnapshot(BEFORE, AFTER))` — called from
  `feedCurrentTrack()` (after the generation/state re-check, alongside the canvas render), from
  `enqueueTrack()`, and from `next()`/`previous()` when not streaming (paused/reconnecting, where
  the queue moves without a feed).

### The animation

`PlaylistWindowFeeder.setRows(next)` diffs `next` against its current target with a pure function,
`planWindowTransition(from, to)` (`src/ffmpeg/playlistWindowTransition.ts`):

- `none` — identical keys and texts: nothing to do.
- `insert` — the current row's key and index are unchanged, and `to` equals `from` with one or more
  rows inserted after the current row, while rows fall off only at the bottom. Every shared key keeps
  its text and relative order.
- `snap` — anything else (a track advance, `previous`, a restart, a first render from empty).

`snap` renders the new settled frame immediately. `insert` runs a **600 ms** animation, driven by
wall-clock progress `p = (now − startedAt) / 600`, not frame index, so a slow or dropped render
shortens the visible frame rate but never stretches the animation:

| What | Motion | Window (ms) | Easing |
|---|---|---|---|
| Rows below the insertion point | slide down by `k × rowHeight` (`k` = rows inserted) | 0–360 | ease-in-out cubic |
| Rows pushed past the last visible slot | same slide, opacity 1 → 0 | 0–360 | ease-in-out cubic |
| New row(s) | opacity 0 → 1, and x offset +24 px → 0 | 240–600 | ease-out cubic |

The gap opens first and the new row settles into it, overlapping by 120 ms so the motion reads as
one movement. No colour or highlight is invented: rows keep the template's own style. At `p ≥ 1` the
feeder renders the target's settled frame (byte-identical to what a `snap` would produce) and the
animation ends. During an animation the tick requests a new render whenever none is in flight, so
there is **at most one render in flight per feeder** (the `PulseVisualizer` discipline). At most 18
renders per insertion at 30 fps, fewer if renders are slower than 33 ms.

**Coalescing.** At most one animation is in flight. `setRows` during an animation:

- If the pending change, diffed against the in-flight animation's *target*, is `insert` (more
  donations landing within the same 600 ms), it is **queued** and runs as exactly **one** follow-up
  animation from that target once the current one ends. Any number of inserts within one animation
  coalesce into one follow-up that opens a `k`-row gap.
- If it is `snap` (e.g. the track advanced mid-animation), the animation is **abandoned** and the
  new state snaps immediately. A cosmetic animation must never delay showing the real now-playing
  state.

Donations seconds apart (the realistic case, since a free-text request needs a download first) each
get their own animation.

**Every insertion animates, including the streamer's own `play`-by-name.** After B there is one
insert path, and the viewer sees the queue change the same way whatever its source. An insertion
beyond the visible `after` rows (more queued than fit) changes nothing visible, so it produces a
`none`-equivalent result (see edge case C4).

### Cost, stated plainly

- **Constant, for every stream whose template has a playlist element — including the built-in
  default template.** Pipe writes of `w × h × 4` bytes at 30 fps. Default: 704 × 312 × 4 ≈ 0.88 MB
  per frame, **~26 MB/s** of Node → kernel → ffmpeg memcpy, plus ffmpeg's rgba → yuva420p conversion
  and one overlay of that region at 30 fps. This is the same order as the already-shipped equalizer
  (a 1000 × 300 element is ~36 MB/s), but the equalizer is opt-in and this is on by default. It is
  paid **even when no donation ever arrives**, because the pipe must be fed regardless (see "The
  fork").
- **Per settled change** (track switch, insertion end): one Satori + resvg render of the region.
- **Per insertion:** up to 18 region renders over 0.6 s, self-limited to one in flight — at most one
  worker thread busy for about 0.6 s. That is far cheaper than 18 full 1280×720 canvas renders, and
  still real work.
- **Measured fallback rule** (enforced by the plan's real-binary task): if, on the real image, the
  encoder's steady-state `speed=` falls below 0.98x with the layer enabled, or its CPU rises by more
  than 10 percentage points of one core over the same stream without it, `PLAYLIST_WINDOW_FPS`
  drops to 15 (the `fps=` stage duplicates frames up to 30), and the numbers are re-measured and
  recorded in CLAUDE.md either way.

---

## Edge cases considered

### Phase B

- **B1 — `previous()` onto a deleted donation file.** Closed by `Track.ephemeral` + not pushing
  ephemeral tracks into `history` (above). Consequence: `previous()` from a track that followed a
  donation track goes to the base track before it — the donation is a one-off, not replayable.
- **B2 — skipping a donation track leaks its file.** Closed by `releaseTrack()` on
  `next()`/`previous()`.
- **B3 — the streamer can now skip a paid request.** A direct consequence of the agreed
  "behave like `play`-by-name" and of deleting the 409. Stated, not mitigated.
- **B4 — a donation arriving while paused no longer wakes the stream.** It queues, like a
  `play`-by-name. Intentional (today's wake-up was part of the interrupt).
- **B5 — a donation arriving while `reconnecting`** queues on the surviving `PlaylistQueue` (it
  outlives the respawn), and `performReconnect()`'s existing "current track changed → start from 0"
  logic is unaffected: `insertNext()` doesn't change `current()`.
- **B6 — ordering.** `play`-by-name and donation inserts share one FIFO, so they play in call order.
  Free-text requests are still serialized among themselves by `SongRequestQueue`.
- **B7 — `status().currentTrack` after `stop()`.** `teardown()` used to clear `nowPlayingTrack`,
  making it `null`. Reading `queue.current()` unconditionally would report a track for an idle
  controller (the entry survives `stop()`). Gated on state (above).
- **B8 — a track playing at `stop()`, or queued and never reached.** Its temp file is left to the
  12-hour sweep, exactly as today (a stop mid-donation already does this). `releaseTrack()` is
  deliberately not extended to `stop()`: B's scope is closing the holes B itself opens (B1, B2),
  and the stop case is neither new nor unbacked. A live temp-path tracking set remains the known
  follow-up already recorded in `server.ts`.
- **B9 — the same `Track` object queued twice** (two `play`-by-name calls for one name). This is
  already possible today. Phase C's keys are per queue entry (`i:<seq>`), not per `Track` object,
  so the two stay distinct rows.

### Phase A

- **A1 — the donor edits or garbles the UUID.** `trackNotFound` or `trackIdMissing`, dropped
  silently. The donor paid and nothing plays — inherent to "no feedback channel", which is
  unchanged. The streamer can check the logs or use the Test button.
- **A2 — the donor adds text after the command.** Handled by last-UUID extraction.
- **A3 — the name prefix contains `!`, `:`, a newline, or a UUID-like substring.** The parser takes
  the first `!keyword:`, which comes before the prefix; newlines are collapsed at copy time; and the
  real id is always the last UUID.
- **A4 — the playlist changed, or the track was removed from it, after copying.** Ownership only is
  checked, so it still plays (above). A track *deleted from the library* → `trackNotFound`.
- **A5 — a library request overtakes an earlier free-text request that is still downloading.** It
  resolves immediately while the free-text one waits on its fetch. Accepted per the agreed "never
  touches `SongRequestQueue`" decision; flagged as judgment call #2 with a one-line alternative.
- **A6 — a keyword collision between rule types** would double-fire. Closed by the 409 uniqueness
  check. Pre-existing duplicates are grandfathered.
- **A7 — several enabled `libraryTrackRequest` rules.** The page advertises the lowest `minAmount`,
  and a donation fires every rule it matches — two rules with *different* keywords are simply two
  valid commands, and the same keyword twice is now impossible (A6).
- **A8 — the rule is disabled or deleted while a donor has the page open.** The copied command stops
  matching and is dropped. The page is load-time only by agreement, so the donor sees stale info
  until they refresh.
- **A9 — the stream stops while a donor has the page open.** Same staleness. Their donation hits
  `noActiveStream` and is dropped.
- **A10 — token rotation while donors have the old page open.** Their already-copied commands still
  work: the command carries a track id, not the token. Only reloading the old link fails (404).
- **A11 — `reconnecting`** is reported as live, and a request during it queues (B5). `error` is not
  live.
- **A12 — non-target users** (inherited MVP limit, above).
- **A13 — the clipboard API is unavailable** (http, or permission denied). Manual-copy fallback.
- **A14 — a very large playlist.** The page lists every track (the response is names, ids and
  durations only). No pagination; noted for later if it ever matters.
- **A15 — Donatello message length.** A command is `1 + keyword (≤20) + 1 + ≤20 + 1 + 36` ≤ 79
  characters. **Assumption:** Donatello accepts messages at least that long plus a greeting. Verify
  in the Phase A real end-to-end test; if the limit is tighter, shorten the prefix.
- **A16 — a `Referer` leak of the token** when a donor follows a link off the page. Blocked by
  `no-referrer` on both the page and the API response. The page contains no outbound links anyway.

### Phase C

- **C1 — upcoming queued tracks were never shown in the window at all** (today, and after B until C
  lands). Found while designing C, and fixed by `windowSnapshot()`. It is also a prerequisite for
  the animation to have anything to show.
- **C2 — an animation in flight when the track advances.** Abandoned, snap (above).
- **C3 — N donations within one animation.** One coalesced follow-up animation.
- **C4 — an insertion lands beyond the visible rows.** No visible change. `planWindowTransition`
  compares the *visible* rows only (the snapshot is already capped at `after`), so this returns
  `none`, and no render happens.
- **C5 — the queue drains while an inserted row is visible** (the inserted track becomes current).
  That is a track advance → snap. Only insertions animate; track changes cut instantly, as today.
- **C6 — pause during an animation.** Pause doesn't change the rows, so the animation completes. The
  pipe keeps being fed while paused, like the canvas heartbeat.
- **C7 — an insertion while `reconnecting`.** The feeder is torn down (`?.` makes the push a no-op),
  and the reconnect's `feedCurrentTrack()` publishes the full state into the fresh feeder as a snap.
- **C8 — the encoder dies mid-animation.** `teardown()` → `close()` stops the tick. A render
  resolving after `close()` must not write: the feeder checks a `closed` flag / null pipe, as
  `PulseVisualizer` does.
- **C9 — a render slower than 33 ms, or a timeout.** The pacer resends the last frame (a visible hold,
  not a stall). Progress is wall-clock, so the animation still ends on time. A failure logs and holds.
- **C10 — before the first render.** Transparent frames, so the encoder never waits on `pipe:7`.
- **C11 — a template with no playlist element, or one placed fully off-canvas.** No pipe, no
  feeder, no `-i pipe:7`. `persistentEncoderArgs` snapshot tests must show byte-identical args for
  such templates.
- **C12 — multiple playlist elements.** The first is live and animated; the rest stay baked and
  static (above).
- **C13 — odd element coordinates.** The region origin is rounded to even, so placement is exact.
- **C14 — stroke or shadow overflowing the row box.** Covered by `pad`. Long names ellipsize instead
  of wrapping (a visible change, stated).
- **C15 — the timer overlapping the playlist region.** The playlist layer is now above the timer.
  The approximation is stated. A template that deliberately overlaps them is unusual.
- **C16 — gradient text colour.** Satori's `backgroundClip: text` per row works the same in the
  row builder. The worker must load every font variant the element uses (`collectFontVariants` for
  the one element).
- **C17 — the premultiplied-alpha fringe.** Unpremultiplied before writing, as the equalizer does.
  Verified on real output (plan task).
- **C18 — rows re-rendered while their text is unchanged.** A `none` diff doesn't render. A
  settled frame is cached and resent by the pacer for free.

### Cross-phase

- **X1 — A without C.** A library request queues correctly after A, but it doesn't appear in the
  window until it plays (C1). Acceptable interim state, since the phases ship in order.
- **X2 — C without the B rename.** Impossible by ordering. C's `publishWindow()` hooks into
  `enqueueTrack()`, which B creates.
- **X3 — the test button inserting into a live stream.** A `libraryTrackRequest` test really queues
  the track (and animates it) on the live stream, exactly as a `songRequest` test really plays its
  fetched track today. Unchanged semantics.

## Judgment calls made in this write-up

Listed so the user can review them without rereading the whole spec:

1. **Phase C: the playlist window moves permanently to the new layer**, rather than the layer being
   active only during a burst. This is backed by the fact that the pipe costs the same either way.
2. **Phase A: library requests bypass `SongRequestQueue`, as agreed.** This means they can overtake
   an earlier free-text request that is still downloading (A5). Alternative: generalize
   `SongRequestQueue` to take any `() => Promise<R>` task and route both through it — this restores
   strict cross-type arrival order, at the cost of a library request waiting on the slowest pending
   download ahead of it.
3. **Phase C cost is paid by default.** The built-in default template has a playlist element, so
   every such stream gets the new ~26 MB/s pipe even with donations unused. This comes with a
   measured 30 → 15 fps fallback rule.
4. **Phase C: rows become fixed-height and single-line** (`rowHeight = round(1.25 × fontSize)`,
   ellipsis instead of wrapping), which slightly changes how existing templates look, preview
   included.
5. **Phase C: the playlist layer composites above the canvas, timer and gifs, and below the
   equalizer**, regardless of element order.
6. **Phase C: every insertion animates, including `play`-by-name. Track changes do not** — they cut
   instantly.
7. **Phase C: the window now lists queued tracks** (C1), which changes what viewers see even with
   no donations.
8. **Phase B: new `Track.ephemeral` flag.** Ephemeral tracks never enter `history`, and skipping one
   deletes its file.
9. **Phase B: `insertEphemeralTrack` is renamed to `enqueueTrack`**, and `playByName` delegates to
   it.
10. **Phase A: `commandKeyword` must be unique per user** (409), enforced in the route and
    grandfathered for existing rows.
11. **Phase A: the id is extracted as the last UUID-shaped substring** rather than literally the
    last 36 characters, and the copied command has a space between prefix and id.
12. **Phase A: only ownership is checked, not membership in the live playlist.**
13. **Phase A: the token is a `User` column, 128-bit hex, stored in plaintext, and minted only
    explicitly.** Rotation overwrites it; disabling nulls it. There is no rate limit (accepted, and
    consistent with `/auth/*`).
14. **Phase C: `RawFramePacer` is extracted from `PulseVisualizer`** (behaviour-identical, with its
    existing tests unmodified as the gate) rather than having its algorithm copied.

## Testing and verification

Follows CLAUDE.md's testing strategy throughout: `Spawner`/`PipeSpawner`/`ChildProcessLike` fakes
for anything ffmpeg, `Pick<…>` plain-object fakes for repositories, injectable `now`/`renderFrame`
for timing-driven classes, and no real ffmpeg in unit tests.

- **B:** `queue.test.ts` (delete the donation-FIFO tests; add ephemeral-not-in-history),
  `streamController.test.ts` (delete the interrupt/resume/409/reconnect-restore suites; add
  queue-next semantics for `enqueueTrack`, release on skip, and the status gating),
  `songRequestAction.test.ts` (rename, `ephemeral` flag), `localStreamManager.test.ts` (rename),
  `overlayText.test.ts` (rename). Full `npm test` and `tsc` green.
- **A:** repository-free route tests for both routers (fake repositories and a fake
  `LocalStreamManager`: 404-by-shape without a DB call, 404 unknown, offline, live, `request` null vs
  lowest-`minAmount`, headers); `libraryTrackRequestAction.test.ts` (every reason, last-UUID
  extraction, foreign-owner, mapping); keyword-uniqueness 409s; webhook and test-route dispatch by
  type; `openapi.test.ts` lists the new routes. Frontend vitest for `RequestPage` (all five states,
  command format including code-point truncation and whitespace collapsing, clipboard fallback) and
  the Donations card/select. **Real end-to-end once:** migration applied on the stand, a real page
  load, a real donation through Donatello (or the Test button when Donatello is unavailable) with a
  copied command, confirming the track queues next. A15's message-length assumption is checked there.
- **C:** pure tests for `planWindowTransition`, `windowSnapshot`, geometry, and easing;
  `RawFramePacer` extracted with `pulseVisualizer.test.ts` unmodified; `PlaylistWindowFeeder` with
  a fake `renderFrame`/`now`/pipe (transparent-first, pacing, coalescing, abandon-on-snap,
  no-write-after-close); `persistentEncoderArgs` (fd 7 input and filter only when present; args
  byte-identical without it); `streamScene` (element excluded from bake, factory present/absent).
  **Mandatory real-binary tasks**, because this phase is squarely in both classes CLAUDE.md says
  unit tests can't catch:
  1. The worker boundary: render through the *real* pool and assert `Buffer.isBuffer`, the expected
     byte length `w·h·4`, and non-empty glyphs for Cyrillic text.
  2. Real ffmpeg from the repo's own image: the generated args are accepted; pixel-sample the output
     at the region before, during, and after an animation (rows actually move, the new row's alpha
     ramps, no fringe, no stall); measure encoder `speed=` and CPU with and without the layer over
     ≥ 60 s; apply the 30 → 15 fps fallback rule; record the numbers in CLAUDE.md.
  3. A live look on the deployed stand at a real donation insert.

## Documentation updates (part of each phase's plan)

CLAUDE.md's "Donation-triggered song requests" section (the interrupt-and-resume paragraph goes
away; describe queue-next, `ephemeral`, and release-on-skip), a new section for the request page and
`libraryTrackRequest`, the `pipe:7` layer under the pipeline/`CanvasPlacement` notes (with the
measured numbers), the Layout tree (new files), the HTTP API section (new routes), and the fd list
in `types.ts`/`createPipeSpawner` comments.

## Out of scope

Per-donor feedback, live-updating the request page, pagination, covers on the public page, rate
limiting, per-channel donation routing, animating track changes, and full per-element z-order for
the playlist layer.

## Implementation plans

Three files, one per phase, executed in order in separate sessions:

- `docs/superpowers/plans/2026-09-23-donation-library-track-request-phase-b.md`
- `docs/superpowers/plans/2026-09-23-donation-library-track-request-phase-a.md`
- `docs/superpowers/plans/2026-09-23-donation-library-track-request-phase-c.md`
