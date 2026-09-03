# Stream continuity: persistent muxer + raw elementary-stream handoff (Overlay templates Stage 2)

## Problem

Live testing (this session, 2026-09-03) reproduced and confirmed the issue already flagged in
CLAUDE.md's "Known follow-ups": a second track switch in the same session killed the RTMP
connection outright. Backend logs from the reproduction:

```
[mpegts] Packet corrupt (stream = 0, dts = 4963320)          <- switch #1, video, tolerated
...
[mpegts] PES packet size mismatch
[mpegts] Packet corrupt (stream = 1, dts = 4955777)           <- switch #2, audio
[aac_adtstoasc] Error parsing ADTS frame header!
[flv] Error applying bitstream filters to an output packet for stream #1: Invalid data found when processing input
av_interleaved_write_frame(): Invalid data found when processing input
Conversion failed!
fifo write stream error [Error: EPIPE: broken pipe, write]
```

**Root cause.** Each track/pause segment is muxed to MPEG-TS by its own short-lived ffmpeg
process, so its per-PID continuity counter and its ADTS bitstream state always restart at zero.
The long-lived pusher's MPEG-TS demuxer sees the counter jump as packet corruption at every
switch. `-err_detect ignore_err` (existing mitigation) makes the demuxer itself tolerate this, but
it does not help when the corruption lands on the audio stream: the `aac_adtstoasc` bitstream
filter (FLV output needs AudioSpecificConfig, not raw ADTS) cannot parse a broken ADTS frame
header, and that failure is fatal to `av_interleaved_write_frame()` — the whole `-c copy` push
dies, taking the RTMP connection with it. First switch happened to corrupt only the video stream
(survivable); second switch's corruption landed on audio (fatal). This matches CLAUDE.md's Stage 2
description exactly — it is the same defect, not a new regression, and CLAUDE.md already named the
fix as architectural: replace the per-segment MPEG-TS handoff with a single persistent process per
destination.

## Goal / success criteria

- A destination's RTMP connection survives an arbitrary number of track switches,
  next/previous/pause/resume, in the same streaming session — no connection drop caused by the
  switch mechanism itself.
- No visible behavior regression: overlay compositing, native ticking timer drawtext, `-shortest`
  audio-bounded segment length, auto-advance-on-track-end, and multi-destination fan-out
  (`StreamSessionManager`) all keep working exactly as today.
- Verified against a real ffmpeg binary with at least two consecutive live track switches, not
  just unit tests with a fake `Spawner` (see `[[feedback_verify_against_real_binaries]]` —
  unit tests already existed for the current architecture and did not catch this).

## Chosen approach: split "encode" from "mux", make only the muxer persistent

Two ffmpeg responsibilities are currently fused into one process per segment: encoding the
composited video + audio, and muxing that into a self-contained MPEG-TS stream. The MPEG-TS
container is exactly where continuity counters and ADTS bitstream-filter state live — so it's the
part that must never restart. The encode step (per-track overlay compositing, `-shortest`
trimming, drawtext timer) has no such statefulness and can keep restarting per segment exactly as
today.

**Producer (per segment, restarts as today):** instead of muxing to MPEG-TS on `pipe:1`, outputs
two raw elementary streams directly to two well-known FIFO paths — H.264 Annex-B video and ADTS
AAC audio — via two output legs of the same ffmpeg invocation:

```
... -map [outv] -c:v libx264 -tune stillimage ... <videoFifoPath>   (-f h264)
... -map 2:a    -c:a aac ...                       <audioFifoPath>   (-f adts)
```

Raw elementary streams carry no container-level continuity counter, no PES packetization, and no
ADTS-to-ASC filter state — there is nothing at that boundary left to desynchronize when one
producer stops and the next starts.

**Muxer (persistent, replaces `RtmpPusher`):** created once in `start()`, never restarted for a
track switch, reads both FIFOs continuously and muxes+pushes:

```
-re -f h264 -r <fps> -i <videoFifoPath> -f aac -i <audioFifoPath> -c copy -f flv <rtmpUrl>/<key>
```

Because this process's own PTS clock is assigned once and never reset, there is no
continuity-counter or PTS discontinuity to smooth over at a switch, and `-err_detect ignore_err`
becomes a pure defensive belt (not doing any real work anymore).

### Rejected alternative: filter-graph input switching via zmq/sendcmd

Keep one persistent process and dynamically swap which `movie`/`amovie` filter source is active
via ffmpeg's zmq/sendcmd remote control. Rejected: ffmpeg has no supported verb to swap a
`movie`/`amovie` filter's underlying file at runtime — sendcmd can change filter *parameters*
(volume, drawtext text, position) but not its source. Working around that would mean either
pre-opening every possible track as an input (impossible — the playlist is an arbitrary,
dynamically-growing set of user-uploaded files, not a fixed small set) or reloading the whole
filtergraph per switch, which reintroduces the same kind of process-restart discontinuity this
work exists to remove. Not pursued further.

## Design detail

### 1. FIFO layout

One destination's pipeline currently owns one FIFO path,
`{FIFO_DIR}/super-dj-stream-{destinationId}.fifo`. It becomes two:
`{FIFO_DIR}/super-dj-stream-{destinationId}-video.fifo` and `...-audio.fifo`.
`fifo.ts`'s `createFifo`/`removeFifo` are unchanged in behavior, just called twice (once per
path) everywhere a single `fifoPath` is created/removed today.

### 2. `segmentArgs.ts`

`buildTrackSegmentArgs`/`buildPauseSegmentArgs` take `videoFifoPath`/`audioFifoPath` instead of a
single output target, and end in two output groups (`-f h264 <videoFifoPath>`, `-f adts
<audioFifoPath>`) instead of one (`-f mpegts pipe:1`). The overlay `filter_complex` (composited
cover/title/playlist/timer PNG + drawtext), `-shortest`, and all codec parameters are unchanged —
this is a pure output-stage swap.

`outputTsOffsetSeconds`/`-output_ts_offset` is removed from both builders — see point 5.

### 3. `SegmentFeeder`

Currently pipes the producer's `stdout` into a single `fifoWriteStream` it owns, and
`stopCurrent()` explicitly `unpipe()`s before killing the outgoing process to prevent two
producers writing into the same stream concurrently.

With two named FIFO *paths* passed directly to ffmpeg (rather than a single anonymous stdout
pipe), ffmpeg itself opens and writes both — Node no longer owns a write stream or does manual
piping/unpiping at all. This is a net simplification: `SegmentFeeder` becomes responsible only for
spawning the right process with the right args and killing the outgoing one before starting the
next (still needed — two producers must not have both FIFOs open for write at once, since a FIFO
only supports one writer cleanly). `stopCurrent()` keeps its "kill before the next spawn" ordering
requirement but drops the stream-level unpipe logic, since there's no Node-owned stream to unpipe.

`overlayImagePath`/`hasWrittenOverlay`/`lastOverlay` bookkeeping (per-destination fixed PNG path,
reused verbatim on `feedPause()`) is unchanged.

### 4. Muxer (renamed from `RtmpPusher`) / its args builder (renamed from `rtmpPusherArgs.ts`)

New args, per destination, built once and used for the process's entire lifetime:

```
-err_detect ignore_err -re -f h264 -r <fps> -i <videoFifoPath> -f aac -i <audioFifoPath> -c copy -f flv <rtmpUrl>/<streamKey>
```

Lifecycle (`start()`/`stop()`, `onExit` callback wiring into `StreamController`'s `error` state)
is unchanged — only the args and the input side (two raw-ES FIFOs instead of one MPEG-TS FIFO)
differ.

### 5. Drop `-output_ts_offset` / `elapsedSessionSeconds()`

That machinery exists purely because each old per-segment process's PTS/DTS restarted near zero,
and the pusher needed a way to keep pacing (`-re`) against one continuous real-time clock across
those restarts. With a persistent muxer, its own PTS is assigned once, continuously, for the
entire session — there is no restart to compensate for. `StreamController.elapsedSessionSeconds()`,
`streamStartedAt`, and every `outputTsOffsetSeconds` parameter threaded through
`feedCurrentTrack`/`feedTrack`/`feedPause`/`buildTrackSegmentArgs`/`buildPauseSegmentArgs` are
removed together.

The native timer drawtext's own offset (`pts:hms:OFFSET` using `pausedElapsedSeconds`/track-start
time) is a *different* clock — elapsed time within the current track, not the session — and is
unaffected by this removal.

### 6. Call sites owning the FIFO path(s)

Everywhere `fifoPath: string` is threaded through today (`StreamControllerDeps`, `StreamManager`,
whatever constructs `SegmentFeeder`/the muxer per destination) becomes
`{ videoFifoPath: string; audioFifoPath: string }`. `StreamManager`'s per-destination create/
teardown calls `createFifo`/`removeFifo` for both paths instead of one.

### 7. Error handling

`SegmentFeeder`'s current `fifoWriteStream.on('error', ...)` guard (EPIPE handling) goes away with
the Node-owned write stream itself (point 3) — ffmpeg writing directly to a FIFO path that has no
reader yet blocks on open() rather than raising a Node-level EPIPE, and once opened, a downstream
reader disappearing is ffmpeg's own problem to log and exit from, same as it already handles other
process-level failures. `StreamController`'s reaction to an unexpected muxer exit (`state =
'error'`) is unchanged.

## Testing plan

- **Unit tests** (fake `Spawner`, existing pattern): assert the producer's built args contain the
  two correct output legs (`-f h264 <videoFifoPath>`, `-f adts <audioFifoPath>`) and no longer
  `-f mpegts pipe:1`; assert the muxer's built args read both FIFOs with `-re -f h264 -r <fps> -f
  aac`; assert `SegmentFeeder`/`StreamController` no longer reference
  `outputTsOffsetSeconds`/`elapsedSessionSeconds`; assert two FIFOs are created/removed per
  destination lifecycle instead of one.
- **Real-ffmpeg verification (required before considering this done, per
  `[[feedback_verify_against_real_binaries]]`):** run the actual pipeline locally or on the
  192.168.14.26 host with a real playlist, and manually trigger at least two consecutive track
  switches (the exact scenario that killed the stream in this session's reproduction) while
  watching the RTMP output stays alive and the backend log shows no `Conversion failed!`/EPIPE.
  This is what actually validates the fix — the corruption this design eliminates was never
  visible to a fake-`Spawner` unit test in the first place.

## Risk / rollback

Touches `segmentArgs.ts`, `segmentFeeder.ts`, `rtmpPusher.ts` → renamed, `rtmpPusherArgs.ts` →
renamed, `fifo.ts` call sites, `streamController.ts`, `streamManager.ts` — every place a single
`fifoPath` currently flows through. This is a full replacement of the segment-handoff mechanism,
not a feature-flagged addition — no dual-path/backwards-compatibility shim. If real-binary
verification surfaces a problem (e.g. the two FIFOs drifting out of sync under some edge case),
the rollback is `git revert`, not a runtime toggle.

## Explicitly out of scope

- Stage 3 (visual template editor) and Stage 4 (wiring it into the real stream-start flow) are
  already done/separate — untouched by this work.
- No change to overlay rendering (Satori/resvg/piscina pool), template CRUD, or the timer
  drawtext's own text/positioning — only the container/mux boundary changes.
- No change to `StreamSessionManager`'s fan-out behavior — each destination's pipeline remains
  fully independent; this is a per-`StreamController` internal change.
