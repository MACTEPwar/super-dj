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
- **Two incidental improvements**, worth knowing so nobody "fixes" them back:
  - After a paused `next()`, `status().currentTrack` now reports the track the queue moved to. The
    old code kept reporting `nowPlayingTrack`, the stale pre-`next()` one, until resume.
  - `resume()` now feeds `queue.current()` at `pausedElapsedSeconds`, so it always resumes the
    track the queue is actually on. After a paused `next()` (which resets `pausedElapsedSeconds` to
    0), the old `nowPlayingTrack ?? queue.current()` restarted the *skipped* track from 0 instead of
    playing the track `next()` moved to. The new code plays the new track from its start, which is
    what `next()` asked for.

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

**One arrival-ordered queue for both types (user decision, 2026-09-23).** "There must be one queue;
whoever donated first goes first." `SongRequestQueue` is generalized and renamed
**`DonationRequestQueue`** (`src/donations/donationRequestQueue.ts`), with
`enqueue<R>(task: () => Promise<R>): Promise<R>` — the same promise-tail chain as today, just no
longer tied to a query string. Both handlers enqueue onto the **one** instance `server.ts` builds,
so a donation's place in the play queue is fixed at the moment the webhook (or the Test button)
dispatched it, not by which task finished first. An exact-track task is two indexed queries, so
once its turn comes it resolves almost at once; the point is ordering, not speed.

**Knock-on, added deliberately (flagged in the revision report):** `HttpMediaSearchClient` sets no
timeout of its own, so a stuck download is bounded only by Node fetch's default (about 300 s), and
already holds up every free-text request behind it for that long. With one shared queue it would
hold up exact-track requests too — a new failure mode this decision introduces.
`DonationRequestQueue` therefore gets a **head-of-line timeout**: if a task hasn't settled within
`DONATION_TASK_TIMEOUT_MS` (90 s), the queue logs and moves on to the next task. That cuts the
worst case from about 5 minutes to 90 s. 90 s is well above a normal download, and above the point
where the media-search service normally answers with its own 504; retune it if that service's
timeout changes. The timed-out task is not cancelled. If it completes later it still inserts, and
that one request lands out of order — a degraded but bounded outcome. A task that throws
synchronously clears its timer too, so there is no stray "still running" log.

The timeout never affects a caller's **own** promise, which settles when its task does. So the
rule Test button's HTTP request just waits for its own task (at worst about 300 s, fetch's
default) and then reports the real outcome. That is accepted as-is: the Test button is a manual,
single-user diagnostic, and a real result beats a synthetic "timed out".

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
  `server.ts` builds one handlers object — `songRequest` →
  `donationQueue.enqueue(() => executeSongRequest(..., query))`, `libraryTrackRequest` →
  `donationQueue.enqueue(() => executeLibraryTrackRequest(..., query))`, both on the same
  `DonationRequestQueue` — and hands the **same** object
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
  content="no-referrer">`. Loads once — no polling, no SSE, and TanStack Query's automatic refetch on window focus and on
  reconnect is switched off for this query, so a manual "refresh" button is the only way to reload. i18n in
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

### Chosen approach (user decision, 2026-09-23): the settled window stays baked; pipe:7 is a burst-only layer

> Revision note. The first version of this spec moved the playlist window out of the baked canvas
> permanently. The user chose the other fork: **"everything stays in the main canvas; the new pipe
> is only for the animation burst."** This section is rewritten for that choice. The findings it
> reverses are listed under "Judgment calls" (#1, #3, #4, #5).

The real constraint behind both forks: ffmpeg's filter graph is fixed when the encoder spawns. So
whether `pipe:7` exists can only be decided once per session — the same invariant that rules out
`sendcmd`/`zmq`. It can't be toggled by "are donations happening right now".

- **The settled window is exactly today's.** It is baked into the main Satori canvas PNG by the
  same `case 'playlist'` node, with the same natural line height, wrapping, gradient spanning the
  block, and position in the canvas's own layer. Its content is rebuilt through the existing
  render-on-change path (`buildOverlay` → `CanvasFeeder.render`). A stream that never has anything
  queued looks byte-for-byte as it does today.
- **`pipe:7` exists structurally** whenever the template has a usable `playlist` element (the same
  per-session optionality as the equalizer's `pipe:5`). While idle it carries a precomputed
  **fully transparent frame**, resent at the declared rate, and contributes nothing visible.
- **During a burst** (a track was just queued and the change is visible in the window), the layer
  shows the animation on top, and the canvas temporarily bakes the window *out*, so the old rows
  underneath don't double up with the moving ones. When the burst ends, the canvas bakes the window
  back in with the new rows (its normal render-on-change path) and the layer returns to transparent.

**Why the canvas must bake the window out during a burst.** The burst layer draws text on a
transparent background. Composited over a canvas that still shows the *old* rows, the viewer would
see two different row sets overlapping. Making the burst layer opaque would need it to reproduce
whatever is under the window (background image, gifs, the per-track background override), which it
can't. So for the length of a burst, the canvas is rendered as variant **A** — the current overlay
with the live playlist element omitted. Afterwards it is rendered as variant **B** — the full
overlay with the new rows.

### The handoff protocol

The canvas (`pipe:3`, a 5 fps heartbeat, with one-shot-ffmpeg render latency) and `pipe:7` (30 fps)
are separate inputs with no frame-accurate synchronization between them. The protocol never relies
on one: every switch overlaps **identical** content for a hold period, so whichever input ffmpeg
picks up first, the picture is the same. `HANDOFF_HOLD_MS = 2 × CANVAS_HEARTBEAT_MS` (400 ms).

1. **Frame 0.** The feeder renders the *from* rows with the settled layout. That is pixel-for-pixel
   the window already baked in the canvas, because it is the same Satori node at the same position.
   It becomes the `pipe:7` frame. Wait `HANDOFF_HOLD_MS`: the same text is now drawn twice, in the
   same place.
2. **Canvas → A.** Render and write canvas variant A (window omitted), then wait
   `HANDOFF_HOLD_MS`. The window is now drawn only by `pipe:7`, still showing the from rows.
3. **Animate** for 600 ms (below). It ends on a frame with the *to* rows at the settled layout.
4. **Canvas → B.** Render and write canvas variant B (window baked in with the to rows), then wait
   `HANDOFF_HOLD_MS`. Identical content is drawn twice again.
5. **Idle.** `pipe:7` goes back to the transparent frame.

A burst runs about 2–2.5 s from `enqueueTrack` to idle (two canvas renders plus two holds around
the 600 ms of motion). The motion itself starts about 0.8–1 s after the insert. That is invisible
next to the seconds a donation already takes to arrive and download. The residual artifact is
that, during each 400 ms hold, text is drawn over identical text, which makes antialiased edges
slightly heavier (edge case C19). Task 10 of the Phase C plan pixel-checks it.

**Who orchestrates it: `PlaylistWindowAnimator`** (`src/stream/playlistWindowAnimator.ts`). This
is a small class with one purpose: run bursts and coalesce queue changes. It is kept out of
`StreamController` so the controller only gains a few calls. Its injected deps:

- the feeder: `showRows`, `animate`, `goIdle`
- `bakeCanvas(rows, { omitLivePlaylist })`, a controller callback that builds the overlay for the
  track actually on screen (`bakedTrack`, not `queue.current()`), sets it as `currentOverlay` (so
  the once-a-second timer tick keeps re-rendering the right variant), and awaits
  `CanvasFeeder.render`
- `getBakedRows()` — the rows currently baked into the canvas
- a `sleep`
- `holdMs`

Its API is `queueChanged(nextRows)`, `abort()`, and `busy`. Each run reads its *from* rows from
`getBakedRows()` at the moment it starts, so a coalesced follow-up burst automatically diffs
against the rows the previous burst just baked.

`bakeCanvas` resolves `false` when its result was stale. The animator doesn't branch on that. This
is an accepted minor gap rather than an oversight: every path that makes a bake stale — a track
change, teardown, leaving `streaming`/`paused` — also calls `animator.abort()`, and that is what
actually stops the burst.

- **Coalescing.** A `queueChanged` during a burst only records the latest target rows. When the
  burst finishes (after step 5), if the recorded target differs from what's baked, a follow-up runs
  from the newly baked rows. It is a burst if the diff is an insert, otherwise a plain re-bake. Any
  number of inserts during one burst collapse into one follow-up.
- **Abort** (any `feedCurrentTrack` — a track change, a resume — or `teardown`). The burst's
  generation is bumped, so every pending await bails; the feeder goes idle immediately; and
  `feedCurrentTrack` bakes the full overlay as it always does. On a track change the window can be
  missing for that one render's latency (edge case C2). It happens during what is already a hard
  cut (the title and cover change at the same moment), and it's preferable to showing stale rows
  over new ones.
- **When bursts run.** Only while the controller is `streaming` or `paused` (the video keeps
  running while paused) and a feeder exists. In any other state, or with no playlist element, a
  queue change just waits for the next normal bake.

### Pipe, fd, format, and compositing

- **fd 7 / `pipe:7`**, a new `playlistWindowPipe` on `ChildProcessWithPipes`. Existing fds are
  unchanged: 3 canvas, 4 audio, 5 equalizer, 6 above-canvas. `createPipeSpawner` opens stdio slot 7
  unconditionally and attaches an `'error'` listener, exactly like 5 and 6.
- **Optional.** `buildPersistentEncoderArgs` gains `playlistWindow?: { x, y, width, height, fps,
  layer: 'below' | 'top' }` and declares `-f rawvideo -pix_fmt yuva420p -s WxH -r <fps> -i pipe:7`
  only when it is present. The input is appended **last**, so no existing index moves.
- **Pixel format `yuva420p`**, not rgba: 2.5 bytes per pixel instead of 4 (37% less pipe traffic,
  which matters because this pipe is fed even while idle), and the same format `pipe:3` carries. The
  worker converts resvg's premultiplied RGBA to straight alpha (the existing
  `unpremultiplyRgbaInPlace`), then to yuva420p with the **BT.601 limited-range** coefficients that
  swscale uses by default. That default is what `CanvasFeeder`'s one-shot render uses to produce the
  baked window, so frame 0 and the final frame match the baked text's colours (checked in Phase C Task 10:
  max deviation ≤ 2 code values). The idle frame is precomputed once: A = 0 everywhere, Y = 16,
  U = V = 128.
- **Where it composites: directly above the canvas layer that contains the playlist element.** For
  `top` placement, or when the playlist is in the above layer of a `split`, that is right after
  `[vcanvas_top]`. When the playlist is in the below layer (`bottom`, or `split`-below), it is right
  after `[vcanvas_below]` — under the gifs, exactly where the baked window sits. Always before the
  equalizer. So during a burst the moving rows keep the baked window's z-position relative to gifs.
  The one burst-only exception: in `top` placement the timer's drawtext lives in the same canvas
  layer, so moving rows draw above the timer if the two overlap (C15).
- **Declared rate `PLAYLIST_WINDOW_FPS = 30`** (the output frame rate, so the motion isn't stepped),
  with the measured fallback to 15 below.

### Region geometry (burst frames only)

The pipe needs fixed dimensions, and `PlaylistElement` has no height. The region is a bound, not a
layout change — the baked window keeps its natural layout.

- `pad = ceil((stroke?.width ?? 0) + max(|shadow.offsetX|, |shadow.offsetY|) + (shadow?.blur ?? 0)) + 2`.
- Width: `el.x − pad` … `el.x + el.width + pad`. Height: `el.y − pad` …
  `el.y + ceil((visibleRows + 1) × fontSize × 1.4) + pad`. Here `visibleRows = 10`, plus one row of
  room for the pushed-out row to slide while it fades, and 1.4 × fontSize generously bounds the
  natural single-line height (about 1.16–1.2 × for the bundled fonts).
- Clamped to 1280×720, with the origin rounded down to even and the size to even — so `overlay`
  places it exactly without the gifs' RGB-compositing cost (see `GIF_OVERLAY_FORMAT`).
- Width or height < 2 after clamping (the element is off-canvas) → no layer at all.
- A window whose names wrap onto a second line can extend past the bound. Only **burst frames** are
  clipped there (C14); the baked window never is.
- Default template (`x 512, y 160, width 700, fontSize 22`): **704 × 342**.

### The burst frames: the same node, animated

`sceneRenderer.ts`'s existing `case 'playlist'` node (a flex column with the container's text
style, one div per row) is refactored into `playlistWindowNode(el, rows, origin)`, where each row
may carry optional animation props: `opacity`, `offsetX`, and `maxHeightFactor`.

- **With no animation props, the node is byte-identical to today's.** The baked canvas and the
  template preview call it that way. The existing `sceneRenderer` tests, unmodified, are the gate.
- Burst frames render **only this element**, region-sized, with the origin shifted into region
  coordinates. Frame 0 and the final frame pass no animation props, so they are the baked window's
  own pixels. That is what makes the handoff overlaps invisible.
- Intermediate frames animate the gap by growing the new row's box:
  `maxHeight = maxHeightFactor × fontSize`, with `overflow: hidden`. The flex column then pushes
  every row below it down naturally — no row-height model is needed, so wrapping, natural line
  height and the block-spanning gradient all behave as they do in the baked window.

| What | Motion | Window (ms) | Easing |
|---|---|---|---|
| New row(s): gap | `maxHeightFactor` 0 → 1.5 (saturates at the row's natural height, about 1.2) | 0–360 | ease-in-out cubic |
| Row(s) pushed past the last visible slot | stay in the column below, opacity 1 → 0 | 0–360 | ease-in-out cubic |
| New row(s): content | opacity 0 → 1, `offsetX` +24 px → 0 | 240–600 | ease-out cubic |

Because the cap of 1.5 × fontSize is above the natural height, the gap finishes opening at about
80% of its eased progress — slightly early, but still smooth. At `t ≥ 600` the feeder renders the
to rows with no props (the final frame).

The motion is driven by wall-clock progress, so a slow render drops frames but never stretches the
animation. At most one render is in flight per feeder (the `PulseVisualizer` discipline); that is up
to 18 frames at 30 fps. A gradient `color` is applied by the container's `backgroundClip: text`, so
it stretches as the block grows during the burst. Satori may also not apply a row's `opacity` to
gradient-clipped text, in which case the fade is lost but the gap motion stays. Both are burst-only
and are checked in Task 5 (C16).

### Window contents: a queue-aware snapshot with stable keys (unchanged from the first version)

`PlaylistQueue.windowSnapshot(before, after): WindowRow[]` with `WindowRow = { key, text, isCurrent }`:

- **Before:** `before` base rows ending just before the current base index. When an inserted track
  is current, the `before` rows end at (and include) `positionInBase()`.
- **Current:** `▶ <name>`.
- **After:** remaining `insertedQueue` entries, then base rows, capped at `after` rows in total,
  with no wrap-around.
- **Keys:** `b:<baseIndex>` for base rows, and `i:<seq>` per inserted queue entry, kept when the
  entry becomes current and when `previous()` restores it.

It replaces `buildPlaylistWindowLines`/`buildInsertedTrackWindowLines`, and `buildOverlay(track,
windowRows, opts?)` bakes `windowRowLines(rows)`.

**This is the one change to the baked window that survives the reversal, and it is visible:** the
window now lists queued tracks. With nothing queued, the snapshot's lines are exactly today's, so
there is no change. With something queued — a `play`-by-name, which is possible today, or any
donation after B — the queued rows appear after the current one. That is required: otherwise the
burst's final frame would not match the baked window (C1).

### Components

- **`RawFramePacer`** (`src/ffmpeg/rawFramePacer.ts`), extracted from `PulseVisualizer` with
  identical behaviour, and `pulseVisualizer.test.ts` unmodified as the gate. This is the same
  heartbeat-of-an-unchanging-frame discipline `CanvasFeeder` uses for `pipe:3` — the frame count
  written tracks wall-clock time × declared rate, and a render only replaces the cached frame and
  never writes by itself — in the count-driven form that holds at 30 fps. Idle is exactly this:
  the pacer resending the precomputed transparent frame.
- **`PlaylistWindowFeeder`** (`src/ffmpeg/playlistWindowFeeder.ts`) is now a dumb frame player for
  `pipe:7`. Its API:
  - `attach(pipe)`
  - `showRows(rows): Promise<void>` — render a settled frame and make it current
  - `animate(plan): Promise<void>` — play the 600 ms insert and end on the settled to-rows frame
  - `goIdle()` — back to the transparent frame; cancels anything in flight
  - `close()`

  It holds a 30 fps tick timer (`.unref()`'d), the pacer, the "one render in flight" flag, and a
  generation counter so a cancelled render never becomes current. It takes injectable `renderFrame`
  and `nowMs`. It owns no timing policy, and no knowledge of the canvas or the queue.
- **`PlaylistWindowAnimator`** (`src/stream/playlistWindowAnimator.ts`) runs the handoff protocol
  and coalescing described above.
- **Rendering:** its own piscina pool, `playlistWindowRenderPool.ts` + `playlistWindowRenderWorker.ts`:
  - `maxThreads` 2, `useAtomics: false` (the RSS-leak scar)
  - resvg with `loadSystemFonts: false` (Satori has already turned glyphs into paths, and the scan
    costs about 130 ms per call)
  - unpremultiply and yuva conversion inside the worker, so the main thread only memcpys
  - the returned `Uint8Array` rewrapped as a `Buffer` (the worker-boundary scar)

  It has its own pool so a burst never queues behind, or delays, another tenant's canvas render.

### Lifecycle and wiring

- `buildStreamScene()` finds the first `playlist` element and computes its region. If it is usable,
  it records which canvas layer the element was baked into (`'below'` when it falls in
  `belowElements` under `bottom`/`split`, else `'top'`). It passes `playlistWindow` to
  `createPersistentEncoder` and exposes `createPlaylistWindowFeeder?`, present only then.
  `buildOverlay(track, rows, { omitLivePlaylist })` bakes every element as today, minus that one
  element when asked (variant A). **No playlist element → no factory, no `-i pipe:7`, no renders,
  no timer, and args byte-identical to today.**
- `StreamController`:
  - creates the feeder in `spawnPipeline()`, and the animator around it with a `bakeCanvas`
    callback; closes both in `teardown()`
  - remembers `bakedRows` and `bakedTrack` — the rows and track in the current overlay
  - `feedCurrentTrack()` first calls `animator.abort()`, then bakes the full overlay from a fresh
    snapshot, as today
  - `enqueueTrack()` calls `animator.queueChanged(windowSnapshot())`, but only while
    `streaming`/`paused` **and** `queue.current() === bakedTrack`
  - `next()`/`previous()` while paused change nothing on screen, exactly as today (no bake until
    resume). That is also why `enqueueTrack` checks `bakedTrack`: after a paused `next()` the
    snapshot's current row has moved, and a burst or re-bake would show the next track's
    title/cover under the old audio. The next `feedCurrentTrack()` (on resume) bakes everything
    instead.

### Cost, stated plainly

- **Idle, per session whose template has a playlist element — including the built-in default
  template.** A transparent frame costs exactly the same bytes as a real one; what the reversal
  removes is the visual change and the settled renders, not the pipe traffic. Only the format and
  the rate reduce that. Default region 704 × 342 in yuva420p ≈ **0.60 MB/frame**:
  - **~18 MB/s at 30 fps**, **~9 MB/s at 15 fps**. For scale, the existing canvas `pipe:3` is
    1280 × 720 × 2.5 × 5 fps ≈ 11.5 MB/s.
  - ffmpeg also runs one `overlay` blend of that region per output frame, on fully transparent
    pixels.
  - **No Satori/resvg renders at all.**
- **Per insert that changes the visible window:**
  - about 20 region renders (frame 0, up to 18 animation frames, the final frame), at most one in
    flight: roughly one worker thread busy for about 0.6–0.8 s
  - **plus two full-canvas re-renders** (variants A and B: a Satori render and a one-shot ffmpeg
    each). B is new work anyway, since the baked window now lists queued tracks; A exists only for
    the handoff.
- **Measured fallback rule** (enforced by the plan's real-binary task). The idle cost and the burst
  cost are measured separately. If the idle layer makes the encoder's steady-state `speed=` drop
  below 0.98x, or adds more than 10 percentage points of one core to ffmpeg's CPU over the same
  stream without the layer, then `PLAYLIST_WINDOW_FPS` drops to 15 and everything is re-measured.
  The numbers are recorded in CLAUDE.md either way.

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
  Free-text requests are still serialized among themselves by `SongRequestQueue` (which Phase A
  generalizes into `DonationRequestQueue` for both donation types).
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
- **A5 — ordering across the two donation types.** Closed by the user's decision: both types go
  through one `DonationRequestQueue`, so an exact-track request waits behind an earlier free-text
  request that is still downloading, and plays after it. Residual risk: a hung download. Bounded by
  the queue's 90 s head-of-line timeout, after which the queue moves on and the late task, if it
  ever finishes, inserts out of order (logged). Residual, accepted: the webhook enqueues after its
  `listEnabledByUser` read, so two webhooks landing within one DB round trip (milliseconds) are
  ordered by when that read resolves. Closing it would mean enqueueing before the action type is
  known.
- **A5b — a single donation matching two rules** (two different keywords in one message is not
  possible; `COMMAND_PATTERN` takes the first command only). Several matches of one command can only
  come from pre-existing duplicate-keyword rules (A6). They are enqueued in rule order,
  synchronously, within one webhook call, so they keep that order.
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

(Revised for the burst-only layer.)

- **C1 — queued tracks were never shown in the window.** This is true today and after B. Fixed by
  `windowSnapshot()`, which the *baked* window now uses. It is a visible change only when something
  is queued, and it is required so the burst's final frame equals the re-baked window.
- **C2 — the track advances (or the stream resumes) mid-burst.** `feedCurrentTrack` aborts the
  burst, the layer goes idle at once, and the full overlay is baked as usual. The window can be
  missing for that one canvas render's latency, during what is already a hard cut. This beats
  stale rows over new ones.
- **C3 — N inserts during one burst.** They coalesce into one follow-up burst after the current one
  has fully handed back, starting from the newly baked rows.
- **C4 — an insert beyond the visible rows.** The snapshot is unchanged → `none` → no burst and no
  re-bake.
- **C5 — the inserted track becomes current.** That is a track change → C2 path, no animation.
- **C6 — pause during a burst.** It completes. `pause()`'s frozen-frame render uses `currentOverlay`,
  which is variant A during the burst (the animator sets it), so the timer freeze never re-bakes the
  old window under the moving rows.
- **C7 — an insert while `reconnecting`/`idle`/`error`.** No burst. The next `feedCurrentTrack`
  bakes the snapshot.
- **C8 — the encoder dies mid-burst.** `teardown()` aborts the animator and closes the feeder. A
  render resolving afterwards is discarded by the generation check and never written.
- **C9 — a slow or failed render.** The pacer resends the last frame (a hold, not a stall), and
  progress is wall-clock. If frame 0 or the final frame fails, the animator aborts: the layer goes
  idle and variant B is baked, so the only visible effect is losing the animation.
- **C10 — before anything renders, and while idle.** The precomputed transparent yuva frame, so
  ffmpeg never waits on `pipe:7`.
- **C11 — a template with no playlist element, or one that's fully off-canvas.** No pipe, no feeder,
  no animator, and encoder args byte-identical to today (asserted).
- **C12 — multiple playlist elements.** Only the first animates. The others stay baked in both
  variants A and B, and update at B.
- **C13 — odd element coordinates.** An even region origin gives exact placement.
- **C14 — a wrapped name, or a very long window.** Only **burst frames** can clip at the region's
  bottom bound. The baked window is untouched.
- **C15 — the timer overlapping the window in `top` placement.** Moving rows draw above the timer
  during a burst only.
- **C16 — gradient text.** The gradient stretches as the block grows during a burst, and a fading
  row's opacity may not apply to gradient-clipped text in Satori. Both are burst-only, verified in
  Task 5, and don't change the settled look.
- **C17 — premultiplied-alpha fringe.** Unpremultiplied in the worker before yuva conversion.
  Pixel-checked for real.
- **C18 — the same rows again.** `none` → nothing happens.
- **C19 — handoff overlap.** For up to `HANDOFF_HOLD_MS` at the start and end of each burst,
  identical text is drawn twice, so antialiased edges are slightly heavier. Pixel-checked: the
  region's luma during the overlap must stay within a small tolerance of the baked-only frames.
- **C20 — the colour of the conversion path.** The worker's BT.601 limited-range yuva conversion
  vs ffmpeg's swscale conversion of the baked PNG: max deviation ≤ 2 code values, checked in Phase C Task 10.
  Otherwise the text would visibly shift colour at the handoff.
- **C21 — a per-track `overlayOverride` background.** It lives on the canvas's below layer and is
  present in both A and B. The burst layer never paints a background.
- **C22 — a variant-A/B canvas render fails.** `buildOverlay`'s existing blank-overlay fallback
  applies, as for any bake. The animator aborts the burst, and the next bake restores it.

### Cross-phase

- **X1 — A without C.** A library request queues correctly after A, but it doesn't appear in the
  window until it plays (C1). An acceptable interim state, since the phases ship in order.
- **X2 — C without the B rename.** Impossible by ordering: C hooks `enqueueTrack()`, which B
  creates.
- **X3 — the test button inserts into the live stream.** A `libraryTrackRequest` test really queues
  (and animates) the track on the live stream, exactly as a `songRequest` test really plays its
  fetched track today. Unchanged semantics.
- **X4 — one shared donation queue (A) and the burst (C).** Donations are dispatched one at a time,
  so bursts arrive at most as fast as the queue drains. A slow download ahead spaces them out; a
  run of instant exact-track requests coalesces per C3.

## Judgment calls made in this write-up

Listed so the user can review them without rereading the whole spec. Revised 2026-09-23 after two
user decisions; each item that was reversed or narrowed says so.

1. **REVERSED by the user: the playlist window stays baked in the main canvas, and `pipe:7` is a
   burst-only layer** (it was: moved permanently to the new layer). The cost this reversal brings
   is the handoff protocol — canvas variant A, and two 400 ms identical-content overlaps per burst.
2. **DECIDED by the user: one arrival-ordered queue for both donation types**
   (`DonationRequestQueue`). The knock-on added in this revision is a 90 s head-of-line timeout.
3. **NARROWED: idle cost is still paid by every session whose template has a playlist element,
   including the default template.** A transparent idle frame is the same bytes as a real one. It is
   now about 18 MB/s at 30 fps (yuva420p, 704×342) rather than about 26 MB/s (rgba), with no renders
   at idle, and a measured 30 → 15 fps fallback (about 9 MB/s). It is not free: flagged for the user.
4. **MOOT for the settled appearance.** No fixed row height, no ellipsis, no per-row gradient — the
   baked window and the preview are unchanged. **Burst-only remnants:** the region's height bound
   (1.4 × fontSize per row, which can clip wrapped names during a burst), the gap animated by
   growing the new row's `maxHeight`, and a gradient that stretches (and may not fade) during a
   burst.
5. **MOOT for the settled appearance, and mostly fixed for the burst.** The layer now composites
   directly above the canvas layer the playlist is baked into (below or above the gifs, as baked),
   always under the equalizer. The only burst-only remnant is drawing above the timer in `top`
   placement.
6. **Every visible insertion animates, including `play`-by-name. Track changes do not** — they cut
   instantly (unchanged).
7. **The baked window now lists queued tracks** (C1). It is visible only when something is queued
   (unchanged; the reversal keeps it necessary).
8. **Phase B: new `Track.ephemeral` flag** — never in `history`, and deleted when skipped.
9. **Phase B: `insertEphemeralTrack` is renamed to `enqueueTrack`**, and `playByName` delegates to
   it.
10. **Phase A: `commandKeyword` must be unique per user** (409).
11. **Phase A: the id is the last UUID-shaped substring**, and the command has a space between the
    prefix and the id.
12. **Phase A: only ownership is checked, not membership in the live playlist.**
13. **Phase A: the token is a `User` column, 128-bit hex, in plaintext, minted only explicitly, with
    no rate limit.**
14. **Phase C: `RawFramePacer` is extracted from `PulseVisualizer`** (behaviour-identical).
15. **NEW: the handoff protocol** — frame 0 overlap → canvas A → animate → canvas B → overlap →
    idle, with `HANDOFF_HOLD_MS = 2 × CANVAS_HEARTBEAT_MS`, orchestrated by a separate
    `PlaylistWindowAnimator`.
16. **NEW: `pipe:7` carries yuva420p**, converted in the worker with BT.601 limited-range
    coefficients to match swscale's default, verified for real (C20).
17. **NEW (knock-on of decision 1): `DonationRequestQueue`'s head-of-line timeout.**

## Testing and verification

Follows CLAUDE.md's testing strategy throughout: `Spawner`/`PipeSpawner`/`ChildProcessLike` fakes
for anything ffmpeg, `Pick<…>` plain-object fakes for repositories, injectable `now`/`renderFrame`
for timing-driven classes, and no real ffmpeg in unit tests.

- **B:** `queue.test.ts` (delete the donation-FIFO tests; add ephemeral-not-in-history),
  `streamController.test.ts` (delete the interrupt/resume/409/reconnect-restore suites; add
  queue-next semantics for `enqueueTrack`, release on skip, and the status gating),
  `songRequestAction.test.ts` (rename, `ephemeral` flag), `localStreamManager.test.ts` (rewrite the
  delegation test, which asserts the old interrupt: the track must now queue without switching
  anything, and `next()` must resolve rather than 409; plus the rename),
  `overlayText.test.ts` (rename). Full `npm test` and `tsc` green.
- **A:**
  - repository-free route tests for both routers (404-by-shape without a DB call, 404 unknown,
    offline, live, `request` null vs lowest `minAmount`, headers)
  - `libraryTrackRequestAction.test.ts` (every reason, last-UUID extraction, foreign owner, mapping)
  - `donationRequestQueue.test.ts`: strict arrival order across task types, and the head-of-line
    timeout moving on while a late task still resolves
  - keyword-uniqueness 409s; webhook and test-route dispatch by type through the shared queue
  - `openapi.test.ts` lists the new routes
  - frontend vitest for `RequestPage` (all six states — loading, not found, offline, live without a
    rule, live with a rule, and the clipboard-fallback field — plus the command format) and for
    the Donations card and type select
  - **real end-to-end once**, including a free-text and an exact-track Test fired back to back,
    confirming they play in the order fired, and A15's message-length check
- **C:**
  - pure tests for `planWindowTransition`, the animated-row props, `windowSnapshot`, geometry, and
    the yuva conversion
  - `RawFramePacer` extracted, with `pulseVisualizer.test.ts` unmodified
  - `sceneRenderer.test.ts` **unmodified** as the gate that the baked node didn't change
  - `PlaylistWindowFeeder` with fakes (transparent idle, `showRows`, `animate`, `goIdle` cancelling,
    no write after close)
  - `PlaylistWindowAnimator` with a fake feeder, a fake `bakeCanvas` and a fake sleep: the exact
    handoff order and holds, coalescing, abort at every stage
  - `persistentEncoderArgs`: the `pipe:7` input and placement for both layers; args byte-identical
    without it
  - `streamScene`: variant A omits exactly the live element; factory present/absent
  - **Mandatory real-binary tasks:**
    1. The worker boundary: a real `Buffer` of `2.5·w·h` bytes, and Cyrillic glyphs.
    2. Real ffmpeg from the repo's own image. Measure the **idle** cost (60 s with the layer idle vs
       the same template's stream with no layer: `speed=`, CPU and pipe bytes) **separately from
       the burst** cost (renders per burst, worker CPU, canvas renders). Pixel-sample the handoff
       (no doubled or blank window beyond C19's tolerance), the motion, the colour match (C20) and
       the fringe (C17). Apply the fallback rule and record the numbers in CLAUDE.md.
    3. A live look on the stand.

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
