# Playlist window: single-line truncation + current-track marquee — design spec

## Goal

A long track name in the on-screen playlist window used to wrap onto a second line (reported live,
with a screenshot: "▶" alone on one line, the name below), because a row's `<div>` had no
`white-space`/`overflow` constraint of its own — it stretched to the window's width via flex's
`align-items: stretch` but text inside it wrapped normally. Two requirements, from the user
directly:

1. **No row may ever take two lines.** A name that doesn't fit is truncated with `…`.
2. **If the CURRENTLY PLAYING track's name is the one truncated, it scrolls like a marquee** —
   continuous loop, not pause-then-scroll-then-snap-back — so the streamer's audience can eventually
   read the whole name. Every other row (queue/donation tracks) just sits truncated, motionless.

## Part A — single-line truncation (done, already implemented and merged)

`src/render/sceneRenderer.ts`'s `playlistWindowNode` gives every row's div
`{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', maxWidth: el.width }` as its
BASE style (animation props from `pipe:7`'s burst layer only ever add keys on top, unchanged). A
real Satori+resvg render confirmed (`test/render/playlistWindowNode.test.ts`) that a name many times
wider than the row now produces zero opaque pixels in the row below it — it never wraps. This alone
closes the reported bug for every row, current or not. No further work needed for this part; it is
the fallback the marquee below draws over.

## Part B — the marquee

### Why this can't reuse the timer's mechanism

The template's `timer` element updates by **re-rendering a whole new static frame once a second**
(`CanvasFeeder`'s one-shot render, `segmentArgs.ts`) — fine for a digit that changes once a second,
useless for text that must glide a few pixels 30 times a second. A marquee has to live inside the
**one persistent, never-restarted `PersistentEncoder` process** (`persistentEncoderArgs.ts`), the
same reason the playlist window's insert-burst animation (`pipe:7`) exists as its own continuously-
fed raw-pixel pipe rather than a baked-canvas re-render.

A native `drawtext` with a `t`-based scrolling `x` expression was spiked and confirmed to work
(real local `ffmpeg 8.0`: text enters from the right, both edges clip cleanly to a fixed-size
canvas, loops with no visible seam) — but it hits the same wall `pipe:7`'s own design doc already
recorded: **`overlay`'s x/y cannot be changed at runtime in this ffmpeg build** (`sendcmd`/`zmq`:
"Function not implemented"). The marquee's row sits at a Y that is NOT a session-wide constant — a
donation/`play`-by-name track can make the current row occupy a different slot in the window than
usual, and near the very start of a session (fewer than `PLAYLIST_WINDOW_BEFORE` base tracks played
so far) the "before" context is short, so the current row's index among the window's rows can
genuinely differ. A native-`drawtext`-with-fixed-`overlay`-position design would misalign under
exactly those conditions. So: same shape as `pipe:7` — a dedicated raw-pixel pipe, Node decides
WHERE to draw within a fixed-position frame, `overlay` itself never moves.

### Chosen approach: pre-rendered text strip + per-frame crop (not per-frame Satori)

Re-rendering the marquee's text via Satori/resvg 30 times a second, per active stream, is exactly
the cost `pipe:7`'s own design rejected for its burst frames at rest (why it's transparent-and-idle
between bursts). It doesn't have to: unlike the insert animation (whose row LAYOUT genuinely changes
frame to frame), a marquee's content is static — only which SLICE of it is visible changes. So:

- **Render the current track's row text exactly ONCE per activation** (a track switch whose new
  current name doesn't fit) via the same Satori+resvg pipeline as everything else in this codebase,
  into a **strip**: `[blank: rowWidth][text: textWidth][blank: rowWidth]`, transparent background,
  `white-space: nowrap` (no ellipsis — this render wants the FULL name), same font/size/color as the
  template's playlist element. `textWidth` comes from `measureTextWidth` (below); a strip a little
  WIDER than necessary is harmless (extra blank space, never shown as ink) — this render doesn't
  need to be pixel-exact the way the box-clipping does.
- **Every output frame, no rendering at all — just a byte slice.** `cropX(t) = mod((t - activatedAtMs) / 1000 * MARQUEE_SPEED_PX_PER_SEC, textWidth + rowWidth)`, and the frame's content is
  `strip[y][cropX .. cropX+rowWidth)` for `y` in `[0, rowHeight)`. Because the strip is padded by a
  full `rowWidth` on BOTH sides, `cropX` ranges over `[0, textWidth+rowWidth)` and the crop window
  never needs to read past the strip's own bounds or stitch two segments across a wrap — one period
  of motion exactly spans the strip, then jumps back to `cropX = 0` (fully blank — the text is
  "about to enter" — a clean loop point with no visible jump, confirmed by the earlier spike's own
  wrap-point reasoning).
- **Phase resets on every new activation** (`activatedAtMs` = the moment marquee turns on for THIS
  track), not tied to encoder uptime — a fresh over-long title always starts from "gliding in from
  the right," never from wherever an unrelated previous marquee happened to be. This is essentially
  free with this design (Node already owns the clock), unlike the native-drawtext approach where it
  would have meant an extra dynamic value ffmpeg has no clean way to read.
- **`MARQUEE_SPEED_PX_PER_SEC = 80`** — the spike's own value, visually confirmed smooth and
  readable. Not user-configurable in this iteration (YAGNI, matching this codebase's other
  hardcoded animation-timing constants like `INSERT_ANIMATION_MS`).

### Deciding whether a track needs a marquee at all: `measureTextWidth`

Already implemented (`src/render/textWidth.ts`, done): real glyph-advance measurement via
`@shuding/opentype.js` (satori's own dependency, pinned to the exact same version, added as a direct
dependency) — the SAME font-metrics engine satori itself uses internally, not a monospace/character-
count heuristic. `measureTextWidth('▶ ' + track.name, family, bold, italic, fontSize)` vs
`playlistElement.width` decides activation. Parsed fonts are cached by file path (parsing is real
CPU work, and this runs on every track switch for every active stream with a playlist element).

### Row geometry: measured once, not estimated

The earlier concern — "how do we know precisely where the current row sits, in Y, inside the
window?" — is resolved by Part A's own fix: every row in one playlist element now shares the SAME
font/size and is forced single-line, so every row has the SAME rendered height. That height is
**measured once** (not assumed) via a small new helper, `measureRowHeight(element, loadFont)`
(`src/render/rowHeight.ts`): render TWO rows of representative text (letters with both ascenders and
descenders, e.g. `'Ag'`) through the existing `renderPlaylistWindowPixels`, and take the Y-delta
between where each row's ink begins (a straightforward top-to-bottom alpha-channel scan — the same
kind of check the new `playlistWindowNode.test.ts` truncation test already does). Because both rows
render identical text at identical size, `row2.inkY0 − row1.inkY0` is exactly the flex column's
per-row allocated height, regardless of leading/kerning details neither Node nor this spec needs to
model directly. Cached by `(fontFamily, bold, italic, fontSize)`, same discipline as
`measureTextWidth`'s parsed-font cache.

Given that exact height, the current row's canvas-space rect is:
```
rowIndex = windowRows.findIndex(r => r.isCurrent)   // known already — WindowRow carries isCurrent
rowY = element.y + rowIndex * rowHeight
rowX = element.x, rowWidth = element.width, rowHeight = <measured>
```
computed fresh on every activation (a track switch where the new current name overflows) — cheap
arithmetic, not baked into anything ffmpeg-side, so a shifting `rowIndex` (short before-context near
the start of a session, or an inserted/donation track) is simply a different number on the next
activation. No architecture problem.

### The pipe: `pipe:8`, frame = the same region `pipe:7` already computes

- **fd 8 / `pipe:8`**, a new pipe on `ChildProcessWithPipes`/`createPipeSpawner` (existing: 3
  canvas, 4 audio, 5 equalizer, 6 above-canvas, 7 playlist-window burst). Declared only when the
  template has a playlist element — same conditionality as `pipe:7`.
- **Frame size: `computePlaylistWindowRegion`'s own region** (already computed for `pipe:7`; the
  marquee reuses the exact same rect, no new geometry function). This gives the marquee pipe a FIXED
  `overlay` position at spawn time — never needs to move — while Node freely decides, per frame,
  where within that region's frame to draw the scrolling slice (`region.y + rowY_within_region`,
  `region.originX` for X — the same origin math `pipe:7` already uses to place a row within its
  region).
- **Pixel format `yuva420p`**, matching `pipe:3`/`pipe:6`/`pipe:7` — same BT.601 limited-range
  conversion, same reasoning (bandwidth, and colour-matches the baked text around it).
- **Declared rate:** reuse `PLAYLIST_WINDOW_FPS` (currently 30).
- **Composited directly above `pipe:7`'s own compositing stage** in `persistentEncoderArgs.ts`
  (after whichever branch calls `compositePlaylistWindow()`, before the equalizer stage) — so the
  marquee always draws on top of the settled/bursting window, never under it.
- **Idle frame:** fully transparent, region-sized, precomputed once — identical discipline to
  `PlaylistWindowFeeder`'s own idle frame. Fed continuously via a `RawFramePacer` (reused as-is, no
  changes) even when nothing is scrolling, so the pipe's frame-sync never stalls — the same
  contract every other continuously-fed pipe in this graph already keeps.

### Hiding the static fallback text while the marquee is live

While the marquee is active for the current row, the BAKED canvas must not ALSO show that row's
full (or ellipsis-truncated) name — the two would double up. `buildOverlay` in `streamScene.ts`
gains one more optional field on its existing `opts` parameter:
`currentRowOverrideText?: string`. When present, the current row's line (matched by `isCurrent`,
already on `WindowRow`) is replaced with this string before `windowRowLines()` collapses the rows to
plain text for the Satori render. `StreamController` passes `'▶'` (bare marker, no name) when the
marquee is active for the current track, and omits the option (today's behaviour, unchanged)
otherwise. This is a small, additive change next to the existing `omitLivePlaylist` option on the
same `opts` object — it does not touch that option or its own (Phase C handoff) behaviour.

### Components

- **`src/render/textWidth.ts`** — done (`measureTextWidth`).
- **`src/render/rowHeight.ts`** — new: `measureRowHeight(element: PlaylistElement, loadFont?):
  Promise<number>`, as described above.
- **`src/ffmpeg/marqueeStrip.ts`** — new: `renderMarqueeStrip(element: PlaylistElement, text:
  string, rowWidth: number, rowHeight: number, loadFont?): Promise<{ pixels: Uint8Array; width:
  number; height: number }>` — the one-shot Satori+resvg render of the padded strip described
  above. Structurally close to `renderPlaylistWindowPixels`, but a single unconstrained-width row
  rather than the whole window.
- **`src/ffmpeg/marqueeFeeder.ts`** — new: `MarqueeFeeder`, the `pipe:8` frame player. API mirrors
  `PlaylistWindowFeeder`'s shape:
  - `attach(pipe)`
  - `activate(text: string, rowRect: { x: number; y: number; width: number; height: number }):
    Promise<void>` — renders the strip once, resets `activatedAtMs`, starts cropping frames into
    the pipe on the shared `RawFramePacer` tick.
  - `deactivate(): void` — back to the idle transparent frame; cancels anything in flight.
  - `close()`
  Holds its own "one render in flight" + generation-counter discipline, same shape as
  `PlaylistWindowFeeder`'s, so a `deactivate()` racing a still-in-flight `activate()`'s strip render
  can never let a stale strip become current.
- **`src/ffmpeg/types.ts` + `src/server.ts`** — `ChildProcessWithPipes` gains a `marqueePipe` field,
  and `createPipeSpawner`'s `stdio` array gains one more `'pipe'` entry (`stdio[8]`), read out and
  assigned exactly like `playlistWindowPipe`/`stdio[7]` is today. Always present on the spawned
  child regardless of whether the session's template has a playlist element — same "the slot always
  exists, simply never written to" arrangement `pulsePipe` already uses.
- **`persistentEncoderArgs.ts`** — gains an optional `marquee?: { x, y, width, height, fps }`
  parameter (the SAME shape as `playlistWindow`, since it reuses that region), declares `pipe:8`
  when present, and composites it right after the playlist-window stage.
- **`streamScene.ts`** — `buildStreamScene()` computes `measureRowHeight` lazily (only the first
  time a track's name actually overflows — most tracks never need it, so most sessions never pay
  this cost at all) and exposes `createMarqueeFeeder?: () => MarqueeFeeder`, present exactly when
  `createPlaylistWindowFeeder` is (same `livePlaylist` gate). `buildOverlay` gains
  `currentRowOverrideText` as described above.
- **`streamController.ts`** — `feedCurrentTrack()`, right after computing `windowRows` and before
  baking the overlay: measure the current row's text against `element.width`; if it overflows,
  measure the row height (cached) and call `marqueeFeeder.activate(text, rect)`, then bake the
  overlay with `currentRowOverrideText: '▶'`; otherwise call `marqueeFeeder.deactivate()` (a no-op
  if it was already idle) and bake normally. `teardown()` closes the feeder alongside the others.

### Cost, stated plainly

- **Idle** (current track's name fits, the common case): `pipe:8` still exists and is fed a
  transparent frame at `PLAYLIST_WINDOW_FPS`, exactly like `pipe:7`'s own idle cost — no Satori
  render, no extra CPU beyond the pacer + one `overlay` blend of fully transparent pixels per output
  frame. `measureTextWidth`/`measureRowHeight` are NOT called at all when the previous track's name
  also fit (only recomputed at a track switch).
- **Per activation** (a track switch to a name that overflows): one `measureTextWidth` call
  (font-parse cached), one `measureRowHeight` call (cached by font+size — effectively free after the
  first), one strip render (a single Satori+resvg call, not the whole window), then pure byte-slicing
  per frame for as long as that track plays. No repeated rendering cost while a marquee scrolls.
- **Per deactivation** (switching to a name that DOES fit): no render at all, just a flag flip.

### Edge cases considered

- **A track shorter than the row, immediately followed by one that overflows, followed again by a
  short one.** Each `feedCurrentTrack()` call independently decides activate/deactivate — no state
  leaks between tracks beyond the feeder's own idle-vs-active flag.
- **The current row's index shifts** (session start, short before-context; an inserted/donation
  track anchored differently). Handled by construction — `rowY` is recomputed from
  `windowRows.findIndex(isCurrent)` on every activation, never assumed constant.
- **A track's name overflows by only a few pixels.** Still triggers the marquee — no dead zone. The
  strip's trailing blank padding means a barely-overflowing name still produces a clean, short loop
  rather than a visually jarring near-instant snap.
- **The burst layer (`pipe:7`) and the marquee (`pipe:8`) are visually independent.** A `pipe:7`
  insert animation never touches the CURRENT row (it animates newly-inserted/pushed rows elsewhere
  in the window); the marquee never touches any row but the current one. They can be simultaneously
  active without conflicting, and are composited as two separate, independently-idle layers.
- **Marquee active, then the stream pauses.** `pause()` doesn't touch the canvas today (only the
  audio); the marquee frame pacer keeps running (matching `pipe:7`'s and the canvas heartbeat's own
  behaviour of continuing to resend/animate through a pause) — the scrolling continues, which is
  consistent with "the picture doesn't change on pause" being the existing rule, not a new one this
  feature invents.
- **A template with no playlist element at all.** No `livePlaylist`, so no `pipe:8`, no
  `MarqueeFeeder`, no measurement calls — byte-identical to today, same gate `pipe:7` already uses.

### Judgment calls made in this write-up

- **Strip-and-crop over live `drawtext`.** Decided above: `drawtext`'s own continuous-scroll
  expression was real and spiked successfully, but the position problem (`overlay` can't move at
  runtime, and the row's Y isn't session-constant) rules it out on its own; the strip-and-crop design
  was chosen specifically because it turns "where do I draw" into ordinary Node state instead of a
  static ffmpeg argument, at negligible extra cost (one render per activation, not per frame).
- **Row height measured, not estimated.** `computePlaylistWindowRegion`'s existing
  `ROW_HEIGHT_BOUND_FACTOR = 1.4` is a deliberately generous BOUND for sizing `pipe:7`'s region, not
  an exact per-row figure — reusing it for exact row positioning would misalign the marquee against
  the baked text under real fonts (documented there as "~1.16-1.2 x fontSize for the bundled
  fonts" — a 15-20% gap from the bound, enough to visibly misplace a scrolling row). Measuring it for
  real, once per font/size and cached, costs nothing ongoing and removes the guesswork entirely.
- **No user-facing speed/style configuration.** The user's own answer was "continuous loop," no
  further tuning requested — YAGNI per this codebase's own stated convention for animation-timing
  constants.

## Testing and verification

- **Unit, with fakes** (this codebase's default — see CLAUDE.md's "Testing strategy"):
  `measureRowHeight`/`renderMarqueeStrip` with the same cross-platform test-font substitution
  pattern already used throughout `test/render/*` and `test/ffmpeg/*`; `MarqueeFeeder`'s
  activate/deactivate/generation-counter discipline with a fake pipe and injected clock, mirroring
  `test/ffmpeg/playlistWindowFeeder.test.ts`'s existing shape; `persistentEncoderArgs.ts`'s new
  `marquee` branch asserted the same way its `playlistWindow`/`equalizer`/gif branches already are
  (argv/filter-string shape, not a real spawn); `streamController.ts`'s activate/deactivate/
  `currentRowOverrideText` wiring with the existing fake-child/fake-scene test harness.
- **Real-binary verification, before this is called done** (this codebase's own repeated lesson —
  see CLAUDE.md's "Verify against real binaries" note and the multiple MediaMTX/ffmpeg findings that
  ONLY a real run caught): the crop-and-composite technique was already spiked successfully against a
  real local `ffmpeg 8.0`. Before shipping, deploy to the demo stand and confirm against a REAL
  running session: (a) a genuinely long track name visibly scrolls, continuously, without a visible
  jump at the loop point; (b) the static baked row underneath is genuinely blank while scrolling (no
  double text); (c) a short name never shows any motion; (d) switching between an overflowing and a
  fitting track cleanly activates/deactivates; (e) the encoder's steady-state `speed=` doesn't
  regress from adding `pipe:8` (same fallback-rule discipline `pipe:7`'s own spec used) — sample
  CPU/`speed=` with an active marquee against a baseline without one.

## Out of scope

- User-configurable marquee speed/style.
- Marquee for any row but the current track's.
- Retroactively re-measuring `measureRowHeight` if a template's fontSize changes mid-session — a
  template is resolved once at stream start (documented existing behaviour for every other
  per-session-fixed value: gifs, equalizer, timer element, canvas placement).
