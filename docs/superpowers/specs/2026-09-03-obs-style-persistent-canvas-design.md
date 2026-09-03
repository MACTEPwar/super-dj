# OBS-style persistent canvas + encoder (supersedes the two-FIFO Stage 2 design)

> Supersedes `2026-09-03-stream-continuity-persistent-mux-design.md`. That design (two
> independent raw-ES FIFOs, each ffmpeg process opening both directly) was implemented (5 tasks,
> all reviewed and merged in this worktree) and then invalidated by real-ffmpeg verification: it
> deadlocks (see "Why the two-FIFO design was abandoned" below). This document replaces it with
> the architecture actually being built.

## Problem (unchanged from the superseded spec)

Live testing reproduced and confirmed a real, previously-documented bug: a second track switch
in the same streaming session could kill the RTMP connection outright, because each track/pause
segment was muxed to MPEG-TS by its own short-lived ffmpeg process, resetting the container's
continuity counter and ADTS bitstream-filter state at every switch. See the superseded spec for
the full original diagnosis (still accurate) and the exact failure logs.

## Why the two-FIFO design was abandoned

Implementing "split encode from mux, two raw elementary-stream FIFOs read by one persistent
muxer" (the superseded spec) and testing it against real ffmpeg binaries surfaced two real,
sequential failures:

1. **Circular open-order deadlock.** ffmpeg processes multiple `-i`/output targets in order. The
   persistent muxer's `-f h264 -i video.fifo -f aac -i audio.fifo` fully opens *and probes* its
   first input (which requires reading real bitstream data) before opening its second. The
   producer's `-map [outv] ... -f h264 video.fifo -map 2:a ... -f adts audio.fifo` needs *both*
   its outputs open before writing to *either*. Confirmed via `/proc/<pid>/wchan`: the muxer was
   blocked in `pipe_read` on the first FIFO, the producer blocked in `wait_for_partner` trying to
   open the second — a genuine circular wait, not a timing fluke.
2. **FIFO EOF-on-last-writer-close**, found via a follow-up single-FIFO/NUT-container prototype:
   once a FIFO's only writer closes, a reader that opened the FIFO itself sees permanent EOF —
   even after a *new* writer opens the same path afterward — unless the reader itself holds the
   write end open too. The pre-existing (pre-Stage-2) architecture avoided this by having
   `SegmentFeeder` hold one `fs.createWriteStream` open on the FIFO for the whole session and
   piping each segment's producer stdout through it; Task 2 of the superseded plan removed that
   write stream (each producer opened the FIFO path itself instead), silently reintroducing this
   exact failure mode — confirmed live: a persistent-muxer prototype exited cleanly (code 0)
   right after the first producer segment closed, never seeing the second.

Both problems are consequences of the same underlying shape: independent, short-lived producer
processes handing off through named pipes on disk. The fix isn't a smaller patch to that shape —
it's not having short-lived producer processes at all.

## Goal / success criteria (unchanged)

- A destination's RTMP connection survives an arbitrary number of track switches,
  next/previous/pause/resume in the same session.
- No visible regression: overlay compositing, ticking timer, auto-advance-on-track-end,
  multi-destination fan-out all keep working.
- Verified against real ffmpeg binaries, not just unit tests with a fake `Spawner`.

## Chosen approach: one persistent encoder per destination, fed by two Node-owned pipes

This mirrors how OBS itself works: a continuously-running compositor/encoder, fed by swappable
sources, rather than a process-per-clip model. Concretely, per destination:

- **One `PersistentEncoder` process, spawned once in `start()`, never restarted for the life of
  the session.** Reads raw video frames and raw PCM audio from two pipes and encodes+muxes+pushes
  to RTMP continuously.
- **No named FIFOs, no `mkfifo`.** Since Node itself spawns the encoder and is the sole writer of
  both its inputs, it uses anonymous extra pipe file descriptors instead:
  `spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })`, referenced
  in ffmpeg's own args as `pipe:3` (video) and `pipe:4` (audio). This sidesteps both failure modes
  above entirely — there is no filesystem entity with ambiguous multi-writer-over-time semantics,
  and Node holds both write ends open for the whole session by construction. `src/ffmpeg/fifo.ts`
  becomes unused by the streaming pipeline once this lands.
- **Video: `CanvasFeeder` re-renders only when content actually changes, but writes to the pipe on
  a fixed heartbeat** — these are two different things and the distinction matters. A raw video
  pipe has no timestamps of its own; ffmpeg assigns each arriving frame a PTS purely from a
  declared input rate (`-r`) and frame *count*, not real elapsed time. If `CanvasFeeder` only wrote
  when content changed and declared a flat `-r 1`, an extra frame written mid-second (e.g. a track
  switch landing between two timer ticks) would still be charged a full second of screen time,
  silently drifting the video timeline away from real elapsed time over a long session. Instead:
  a fixed interval timer (e.g. every 200ms — tunable, cheap since it's a plain buffer write, no
  subprocess) resends whatever frame is currently cached; re-rendering only happens on an actual
  content change (track switch, pause/resume, or the once-a-second timer-text tick), producing a
  new cached buffer that the next heartbeat tick(s) then resend unchanged. The encoder's video
  input is declared at that same fixed heartbeat rate (`-r 5` for a 200ms interval); its *output*
  rate is the real target (`-r 30`), and ffmpeg's standard frame-rate-conversion duplication
  (`-r`-on-output, not custom logic) fills in between — but only correctly because the *input*
  side's declared rate now actually matches the real wall-clock cadence Node writes at.
  Re-rendering itself reuses the *existing* compositing logic (`overlayFilterComplex` from
  `segmentArgs.ts` — background + overlay PNG + optional drawtext, unchanged) via a one-shot
  ffmpeg invocation ending in `-frames:v 1 -f rawvideo -pix_fmt yuv420p -` instead of a continuous
  encode to a FIFO; Node captures that single frame's bytes from stdout as the new cached buffer.
- **Audio: `AudioRelay` runs a decode-only ffmpeg per track** (`-i track.mp3 -f s16le -ar 44100
  -ac 2 -`, no encoding) and pipes its raw PCM stdout into the encoder's audio pipe, exactly the
  same "kill outgoing before spawning next" discipline `SegmentFeeder.stopCurrent()` already has
  today (reused, not reinvented). Pause feeds `anullsrc` instead of a decoder. Because this is raw
  PCM with no container of its own, there is nothing here that can develop a continuity-counter or
  bitstream-filter discontinuity at a switch — the persistent encoder's own AAC encode never
  restarts. **`-re` belongs on the persistent encoder's *audio* input** (`-re -f s16le -ar 44100
  -ac 2 -i pipe:4`) — a plain decode-only ffmpeg process has no reason to pace itself and will
  decode a whole track as fast as disk/CPU allow otherwise. `-re` there paces audio consumption to
  real time, which backpressures the pipe (bounded OS pipe buffer) and naturally throttles the
  upstream decoder — the same backpressure relationship the current architecture already relies on
  (today `-re` sits on `RtmpPusher`; here it moves to the persistent encoder's audio input
  specifically, not the video input, since video timing is already governed by `CanvasFeeder`'s
  own heartbeat).
- **`StreamController` coordinates the three pieces** instead of driving one big per-segment
  process. Track switch = `AudioRelay.switchTrack()` + `CanvasFeeder.render()`. Pause =
  `AudioRelay.switchToSilence()` + `CanvasFeeder.render({frozen: true})`. Auto-advance still keys
  off the decode-only process's natural `'close'` on reaching end-of-file, so the existing
  `segmentGeneration` double-advance guard carries over essentially unchanged.

### Explicitly deferred (does not block this design)

Local preview (watching the composed output without pushing to a real RTMP destination — e.g. an
HLS endpoint served to the frontend) is a real, desired future capability this architecture makes
straightforward to add later (`tee` the persistent encoder's output, or add a second local output
target) — but is **not** part of this work. Nothing in this design should make it harder to add;
nothing here builds it now.

## Components / files (expected shape — finalized in the implementation plan)

- `src/render/canvasFeeder.ts` (new) — one-shot raw-frame rendering + write-on-change, replacing
  the video-producing half of `src/ffmpeg/segmentFeeder.ts`.
- `src/ffmpeg/audioRelay.ts` (new) — per-track decode-only relay + silence-on-pause, replacing the
  audio-producing half of `segmentFeeder.ts`.
- `src/ffmpeg/persistentEncoder.ts` (new, replaces `src/ffmpeg/rtmpPusher.ts` +
  `rtmpPusherArgs.ts`) — the one long-lived process per destination.
- `src/ffmpeg/segmentArgs.ts` — keeps `overlayFilterComplex`/`TimerOverlay`/etc.; gains a raw-frame
  render arg builder alongside (or replacing) `buildTrackSegmentArgs`/`buildPauseSegmentArgs`,
  whichever the implementation plan finds cleanest given the actual code.
- `src/stream/streamController.ts` — restructured to own/drive `CanvasFeeder` + `AudioRelay` +
  `PersistentEncoder` instead of `SegmentFeeder` + `RtmpPusher`.
- `src/stream/streamManager.ts` — updated wiring; no more FIFO path construction.
- `src/ffmpeg/fifo.ts` — becomes dead code for this pipeline once nothing calls it; removal is an
  implementation-plan decision (confirm nothing else in the codebase depends on it first).

The exact split of responsibilities above is a starting point for `writing-plans`, not a
contract — the plan may adjust file boundaries once it works out the concrete interfaces, as long
as the "one persistent encoder, two Node-owned pipes, no named FIFOs" shape is preserved.

## Testing plan

- Unit tests for `CanvasFeeder`/`AudioRelay`/`PersistentEncoder` follow the existing fake-`Spawner`
  pattern used throughout this codebase — assert built args, assert kill-before-spawn ordering on
  track switch, assert silence-on-pause.
- **Mandatory real-ffmpeg verification** (the same technique already built and proven working in
  this session's investigation — a standalone script invoking the real compiled functions with
  real ffmpeg processes on the deployed test host, no auth/external account needed): at least
  three consecutive track switches, confirming the persistent encoder process survives all of
  them without exiting, and that a real (or local-file-substituted) RTMP-shaped output is
  produced. This is not optional polish — both failures this design exists to fix were invisible
  to unit tests and only found this way.

## Risk / rollback

This fully replaces the two-FIFO design's already-merged commits in this worktree — those commits
implemented real, working, reviewed code for their own narrow scope, but real testing showed the
overall shape doesn't work for this problem. No feature flag / dual-path. Rollback is `git
revert`/resetting this worktree branch, not a runtime toggle.
