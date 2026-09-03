# Stream continuity: persistent muxer + raw elementary streams — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a second (or later) track switch from occasionally killing a destination's RTMP
connection outright, by eliminating the per-segment MPEG-TS continuity-counter/ADTS-bitstream
discontinuity that causes it.

**Architecture:** Split "encode" from "mux". The per-segment producer ffmpeg process (one per
track/pause segment, restarts on every switch exactly as today) now outputs two raw elementary
streams — H.264 Annex-B video and ADTS AAC audio — into two long-lived named pipes, instead of
muxing to MPEG-TS on a single pipe. `RtmpPusher` (unchanged name/responsibility: the one
long-lived process per destination that survives every switch) reads both raw-ES FIFOs
continuously and muxes+pushes to RTMP with `-c copy` — since raw elementary streams carry no
container-level continuity counter or ADTS-to-ASC filter state, there is nothing left at a switch
boundary to desynchronize.

**Tech Stack:** TypeScript, Node.js `child_process`/`fs`, ffmpeg (spawned as a subprocess via the
existing injected `Spawner`/`ChildProcessLike` fakes), Jest.

**Spec:** `docs/superpowers/specs/2026-09-03-stream-continuity-persistent-mux-design.md`

## Global Constraints

- No feature flag / dual-path — this fully replaces the segment-handoff mechanism (spec, "Risk /
  rollback"). Rollback is `git revert`, not a runtime toggle.
- `RtmpPusher`/`rtmpPusherArgs.ts` keep their existing names (spec section 4) — only their args
  and params shape change.
- No change to overlay rendering (Satori/resvg/piscina), template CRUD, timer drawtext
  text/positioning, or `StreamSessionManager` fan-out (spec, "Explicitly out of scope").
- Every unit test in this codebase fakes the `Spawner`/`ChildProcessLike` boundary — never spawn
  real ffmpeg in a unit test (CLAUDE.md, "Testing strategy").
- This plan's automated tests alone do **not** constitute done — Task 8 (real-ffmpeg verification
  against at least two consecutive live track switches) is required before considering this
  fixed, per `[[feedback_verify_against_real_binaries]]` and the spec's testing-plan section.

---

## Task 1: `segmentArgs.ts` — raw elementary-stream outputs, drop `-output_ts_offset`

**Files:**
- Modify: `src/ffmpeg/segmentArgs.ts`
- Test: `test/ffmpeg/segmentArgs.test.ts`

**Interfaces:**
- Produces: `buildTrackSegmentArgs(params: VideoParams & { audioPath: string; backgroundPath:
  string; overlayPngPath: string; fontFile: string; timer?: TimerOverlay | null;
  startOffsetSeconds?: number; durationSeconds: number; videoFifoPath: string; audioFifoPath:
  string }): string[]` — `outputTsOffsetSeconds` is gone; `durationSeconds` is new and required.
- Produces: `buildPauseSegmentArgs(params: VideoParams & { backgroundPath: string; overlayPngPath:
  string; fontFile: string; timer?: TimerOverlay | null; videoFifoPath: string; audioFifoPath:
  string }): string[]` — `outputTsOffsetSeconds` is gone.
- `TimerElementPosition`, `NowPlayingOverlay`, `TimerOverlay`, the internal
  `overlayFilterComplex()` helper: unchanged, still exported/used exactly as today.

- [ ] **Step 1: Replace the test file with assertions for the new two-output shape**

Replace `test/ffmpeg/segmentArgs.test.ts` entirely with:

```typescript
import { buildTrackSegmentArgs, buildPauseSegmentArgs, TimerOverlay } from '../../src/ffmpeg/segmentArgs';

const timer: TimerOverlay = { x: 10, y: 660, fontSize: 20, color: '#ffffff', text: '%{pts\\:hms:0} / 1\\:05' };

describe('buildTrackSegmentArgs', () => {
  const base = {
    audioPath: '/music/a.mp3',
    backgroundPath: '/assets/background.png',
    overlayPngPath: '/tmp/super-dj-overlay-dest-1.png',
    fontFile: '/fonts/DejaVuSans-Bold.ttf',
    width: 1280,
    height: 720,
    fps: 30,
    durationSeconds: 65,
    videoFifoPath: '/tmp/super-dj-stream-dest-1-video.fifo',
    audioFifoPath: '/tmp/super-dj-stream-dest-1-audio.fifo',
  };

  it('builds ffmpeg args compositing the background and the overlay PNG, with no seek or timer by default', () => {
    const args = buildTrackSegmentArgs(base);

    expect(args.slice(0, 8)).toEqual([
      '-loop', '1', '-i', '/assets/background.png',
      '-loop', '1', '-i', '/tmp/super-dj-overlay-dest-1.png',
    ]);
    expect(args).toEqual(expect.arrayContaining(['-i', '/music/a.mp3']));
    expect(args).not.toEqual(expect.arrayContaining(['-ss']));
    expect(args).not.toEqual(expect.arrayContaining(['-output_ts_offset']));
    expect(args).not.toEqual(expect.arrayContaining(['-shortest']));

    const filterComplexIndex = args.indexOf('-filter_complex');
    const filterComplex = args[filterComplexIndex + 1];
    expect(filterComplex).toBe('[0:v]scale=1280:720[bg];[1:v]scale=1280:720[ov];[bg][ov]overlay=0:0[outv]');

    // Assert the two output legs exactly so a missing pin cannot slip through.
    expect(args.slice(filterComplexIndex + 2)).toEqual([
      '-map', '[outv]',
      '-c:v', 'libx264',
      '-tune', 'stillimage',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-g', '60',
      '-t', '65',
      '-f', 'h264', '/tmp/super-dj-stream-dest-1-video.fifo',
      '-map', '2:a',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '44100',
      '-ac', '2',
      '-t', '65',
      '-f', 'adts', '/tmp/super-dj-stream-dest-1-audio.fifo',
    ]);
  });

  it('adds a -ss seek before the audio input when resuming mid-track, and bounds -t by the remaining duration', () => {
    const args = buildTrackSegmentArgs({ ...base, startOffsetSeconds: 42 });
    const audioInputIndex = args.indexOf('/music/a.mp3');

    expect(args[audioInputIndex - 3]).toBe('-ss');
    expect(args[audioInputIndex - 2]).toBe('42');
    // 65s track, resuming 42s in -> 23s of video/audio left to encode in this segment.
    const tIndices = args.reduce<number[]>((acc, v, i) => (v === '-t' ? [...acc, i] : acc), []);
    expect(tIndices).toHaveLength(2);
    for (const i of tIndices) expect(args[i + 1]).toBe('23');
  });

  it('layers a drawtext for the timer on top of the overlay when the template has one', () => {
    const args = buildTrackSegmentArgs({ ...base, timer });

    const filterComplex = args[args.indexOf('-filter_complex') + 1];
    expect(filterComplex).toBe(
      "[0:v]scale=1280:720[bg];[1:v]scale=1280:720[ov];[bg][ov]overlay=0:0[base];"
      + "[base]drawtext=fontfile=/fonts/DejaVuSans-Bold.ttf:text='%{pts\\:hms:0} / 1\\:05':x=10:y=660:fontsize=20:fontcolor=#ffffff[outv]",
    );
  });
});

describe('buildPauseSegmentArgs', () => {
  const base = {
    backgroundPath: '/assets/background.png',
    overlayPngPath: '/tmp/super-dj-overlay-dest-1.png',
    fontFile: '/fonts/DejaVuSans-Bold.ttf',
    width: 1280,
    height: 720,
    fps: 30,
    videoFifoPath: '/tmp/super-dj-stream-dest-1-video.fifo',
    audioFifoPath: '/tmp/super-dj-stream-dest-1-audio.fifo',
  };

  it('builds ffmpeg args compositing the background, the reused overlay PNG, and silence, unbounded (killed externally)', () => {
    const args = buildPauseSegmentArgs(base);

    expect(args).toEqual([
      '-loop', '1', '-i', '/assets/background.png',
      '-loop', '1', '-i', '/tmp/super-dj-overlay-dest-1.png',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-filter_complex', '[0:v]scale=1280:720[bg];[1:v]scale=1280:720[ov];[bg][ov]overlay=0:0[outv]',
      '-map', '[outv]',
      '-c:v', 'libx264',
      '-tune', 'stillimage',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-g', '60',
      '-f', 'h264', '/tmp/super-dj-stream-dest-1-video.fifo',
      '-map', '2:a',
      '-c:a', 'aac',
      '-ar', '44100',
      '-ac', '2',
      '-f', 'adts', '/tmp/super-dj-stream-dest-1-audio.fifo',
    ]);
  });

  it('layers a (frozen) drawtext for the timer on top of the overlay when the template has one', () => {
    const frozenTimer: TimerOverlay = { ...timer, text: '0\\:05 / 1\\:05' };
    const args = buildPauseSegmentArgs({ ...base, timer: frozenTimer });

    const filterComplex = args[args.indexOf('-filter_complex') + 1];
    expect(filterComplex).toContain("drawtext=fontfile=/fonts/DejaVuSans-Bold.ttf:text='0\\:05 / 1\\:05'");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/ffmpeg/segmentArgs.test.ts`
Expected: FAIL — the current implementation still emits `-f mpegts pipe:1` and `-shortest`/
`-output_ts_offset`, not the new two-leg raw-ES shape.

- [ ] **Step 3: Implement the new `buildTrackSegmentArgs`/`buildPauseSegmentArgs`**

Replace the body of `src/ffmpeg/segmentArgs.ts` from `export function buildTrackSegmentArgs`
onward (keep everything above it — `TimerElementPosition`, `NowPlayingOverlay`, `TimerOverlay`,
`overlayFilterComplex` — unchanged) with:

```typescript
export function buildTrackSegmentArgs(params: VideoParams & {
  audioPath: string;
  backgroundPath: string;
  overlayPngPath: string;
  fontFile: string;
  timer?: TimerOverlay | null;
  startOffsetSeconds?: number;
  // Bounds each output leg's length explicitly (see the -t comment below) — probed once up
  // front (ffprobe, via getAudioDurationSeconds) and threaded all the way through from
  // NowPlayingOverlay.durationSeconds.
  durationSeconds: number;
  videoFifoPath: string;
  audioFifoPath: string;
}): string[] {
  const { width, height, fps, audioPath, backgroundPath, overlayPngPath, fontFile, videoFifoPath, audioFifoPath } = params;

  const args = ['-loop', '1', '-i', backgroundPath, '-loop', '1', '-i', overlayPngPath];

  if (params.startOffsetSeconds) {
    args.push('-ss', String(params.startOffsetSeconds));
  }

  args.push('-i', audioPath, '-filter_complex', overlayFilterComplex(width, height, fontFile, params.timer ?? null));

  // Two independent raw elementary-stream outputs (see the Stage 2 design doc) instead of one
  // muxed MPEG-TS output, so -shortest can't be used to bound this segment's length the way it
  // used to — -shortest only compares streams muxed into the SAME output, and ffmpeg has
  // nothing to compare within either of these on its own. The video leg in particular is driven
  // by an infinite `-loop 1` background/overlay image and would never end on its own without an
  // explicit bound.
  const remainingSeconds = Math.max(0, params.durationSeconds - (params.startOffsetSeconds ?? 0));

  args.push(
    '-map', '[outv]',
    '-c:v', 'libx264',
    '-tune', 'stillimage',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-g', String(fps * 2),
    '-t', String(remainingSeconds),
    '-f', 'h264', videoFifoPath,
    '-map', '2:a',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '44100',
    '-ac', '2',
    '-t', String(remainingSeconds),
    '-f', 'adts', audioFifoPath,
  );

  return args;
}

// Pause segments are killed externally (next/resume/stop), never by hitting an encoded-length
// bound, so — unlike buildTrackSegmentArgs — neither output leg needs a -t here; both the
// looped image and anullsrc are already infinite sources that just run until SegmentFeeder
// kills this process.
export function buildPauseSegmentArgs(params: VideoParams & {
  backgroundPath: string;
  overlayPngPath: string;
  fontFile: string;
  timer?: TimerOverlay | null;
  videoFifoPath: string;
  audioFifoPath: string;
}): string[] {
  const { width, height, fps, backgroundPath, overlayPngPath, fontFile, videoFifoPath, audioFifoPath } = params;

  return [
    '-loop', '1', '-i', backgroundPath,
    '-loop', '1', '-i', overlayPngPath,
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-filter_complex', overlayFilterComplex(width, height, fontFile, params.timer ?? null),
    '-map', '[outv]',
    '-c:v', 'libx264',
    '-tune', 'stillimage',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-g', String(fps * 2),
    '-f', 'h264', videoFifoPath,
    '-map', '2:a',
    '-c:a', 'aac',
    '-ar', '44100',
    '-ac', '2',
    '-f', 'adts', audioFifoPath,
  ];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/ffmpeg/segmentArgs.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ffmpeg/segmentArgs.ts test/ffmpeg/segmentArgs.test.ts
git commit -m "$(cat <<'EOF'
refactor: segment args emit raw H.264/ADTS elementary streams, not MPEG-TS

First step of the Stage 2 stream-continuity fix: producer segments no
longer mux to MPEG-TS (that's where the continuity-counter/ADTS state
that breaks at every switch lives). They now write two raw elementary
streams to two FIFOs instead. -shortest is replaced with an explicit
-t bound (from the already-probed track duration) since it can no
longer compare streams that are muxed into the same output.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01J9KpK2UY7XGtFAxYJPFkzP
EOF
)"
```

---

## Task 2: `segmentFeeder.ts` — stop owning a FIFO write stream, pass raw-ES paths straight to ffmpeg

**Files:**
- Modify: `src/ffmpeg/segmentFeeder.ts`
- Test: `test/ffmpeg/segmentFeeder.test.ts`

**Interfaces:**
- Consumes: `buildTrackSegmentArgs`/`buildPauseSegmentArgs` from Task 1 (now require
  `durationSeconds`, `videoFifoPath`, `audioFifoPath`; no `outputTsOffsetSeconds`).
- Produces: `new SegmentFeeder({ spawner, videoFifoPath, audioFifoPath, backgroundPath,
  overlayImagePath, fontFile, width, height, fps, writeFileSync? })` (no `fifoPath`,
  `createWriteStream` params). `feedTrack(track, overlay, startOffsetSeconds?):
  ChildProcessLike` (drops the trailing `outputTsOffsetSeconds` arg). `feedPause
  (trackElapsedSeconds?): ChildProcessLike` (drops the leading `outputTsOffsetSeconds` arg —
  what used to be its first parameter). `stopCurrent(): void`, `close(): void` — same shapes as
  today.

- [ ] **Step 1: Replace the test file for the new no-write-stream shape**

Replace `test/ffmpeg/segmentFeeder.test.ts` entirely with:

```typescript
import { SegmentFeeder } from '../../src/ffmpeg/segmentFeeder';
import { Spawner, ChildProcessLike } from '../../src/ffmpeg/types';
import { Track } from '../../src/playlist/types';
import { NowPlayingOverlay } from '../../src/ffmpeg/segmentArgs';
import { BLANK_OVERLAY_PNG } from '../../src/render/blankOverlay';

function fakeChild(): ChildProcessLike {
  return { pid: 123, stdout: null, stderr: null, kill: jest.fn(), once: jest.fn() };
}

const track: Track = { name: 'a', audioPath: '/music/a.mp3', coverPath: null };
const overlay: NowPlayingOverlay = { durationSeconds: 10, overlayPng: Buffer.from('fake-png-bytes'), timer: null };
const overlayWithTimer: NowPlayingOverlay = {
  durationSeconds: 65,
  overlayPng: Buffer.from('fake-png-bytes'),
  timer: { x: 10, y: 660, fontSize: 20, color: '#ffffff' },
};

function buildFeeder(overrides: Partial<{ spawner: Spawner; writeFileSync: jest.Mock }> = {}) {
  const writeFileSync = overrides.writeFileSync ?? jest.fn();
  const feeder = new SegmentFeeder({
    spawner: overrides.spawner ?? (jest.fn().mockReturnValue(fakeChild()) as Spawner),
    videoFifoPath: '/tmp/stream-dest-1-video.fifo',
    audioFifoPath: '/tmp/stream-dest-1-audio.fifo',
    backgroundPath: '/assets/background.png',
    overlayImagePath: '/tmp/overlay-dest-1.png',
    fontFile: '/fonts/DejaVuSans-Bold.ttf',
    width: 1280,
    height: 720,
    fps: 30,
    writeFileSync,
  });
  return { feeder, writeFileSync };
}

function filterComplexArg(args: string[]): string {
  return args[args.indexOf('-filter_complex') + 1];
}

describe('SegmentFeeder', () => {
  it('spawns ffmpeg with track args pointed at both raw-ES fifo paths', () => {
    const spawner: Spawner = jest.fn().mockReturnValue(fakeChild());
    const { feeder } = buildFeeder({ spawner });

    feeder.feedTrack(track, overlay);

    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-i', '/music/a.mp3']));
    const args = (spawner as jest.Mock).mock.calls[0][1] as string[];
    expect(args).toEqual(expect.arrayContaining(['-f', 'h264', '/tmp/stream-dest-1-video.fifo']));
    expect(args).toEqual(expect.arrayContaining(['-f', 'adts', '/tmp/stream-dest-1-audio.fifo']));
  });

  it('feedTrack writes the rendered overlay PNG to the fixed overlay path before spawning ffmpeg', () => {
    const spawner: Spawner = jest.fn().mockReturnValue(fakeChild());
    const { feeder, writeFileSync } = buildFeeder({ spawner });

    feeder.feedTrack(track, overlay);

    expect(writeFileSync).toHaveBeenCalledWith('/tmp/overlay-dest-1.png', overlay.overlayPng);
    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-loop', '1', '-i', '/tmp/overlay-dest-1.png']));
  });

  it('feedTrack passes the start offset through for a resumed track', () => {
    const spawner: Spawner = jest.fn().mockReturnValue(fakeChild());
    const { feeder } = buildFeeder({ spawner });

    feeder.feedTrack(track, overlay, 4);

    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-ss', '4']));
  });

  it('feedTrack does not add a timer drawtext when the template has no timer element', () => {
    const spawner: Spawner = jest.fn().mockReturnValue(fakeChild());
    const { feeder } = buildFeeder({ spawner });

    feeder.feedTrack(track, overlay);

    const args = (spawner as jest.Mock).mock.calls[0][1] as string[];
    expect(filterComplexArg(args)).not.toContain('drawtext');
  });

  it('feedTrack builds a live, pts-driven timer expression carrying the seek offset forward, when the template has a timer', () => {
    const spawner: Spawner = jest.fn().mockReturnValue(fakeChild());
    const { feeder } = buildFeeder({ spawner });

    feeder.feedTrack(track, overlayWithTimer, 12);

    const args = (spawner as jest.Mock).mock.calls[0][1] as string[];
    const filterComplex = filterComplexArg(args);
    expect(filterComplex).toContain('drawtext=fontfile=/fonts/DejaVuSans-Bold.ttf');
    expect(filterComplex).toContain("text='%{pts\\:hms\\:12} / 1\\:05'");
    expect(filterComplex).toContain('x=10:y=660:fontsize=20:fontcolor=#ffffff');
  });

  it('feedPause reuses the overlay PNG already written by the last feedTrack, without rewriting it', () => {
    const spawner: Spawner = jest.fn().mockReturnValue(fakeChild());
    const { feeder, writeFileSync } = buildFeeder({ spawner });

    feeder.feedTrack(track, overlay);
    writeFileSync.mockClear();
    feeder.feedPause();

    expect(writeFileSync).not.toHaveBeenCalled();
    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-i', '/assets/background.png', '-loop', '1', '-i', '/tmp/overlay-dest-1.png', '-f', 'lavfi']));
  });

  it('feedPause writes the shared blank overlay when no track has ever been fed yet, instead of pointing ffmpeg at a missing file', () => {
    const spawner: Spawner = jest.fn().mockReturnValue(fakeChild());
    const { feeder, writeFileSync } = buildFeeder({ spawner });

    feeder.feedPause();

    expect(writeFileSync).toHaveBeenCalledWith('/tmp/overlay-dest-1.png', BLANK_OVERLAY_PNG);
  });

  it('feedPause freezes the timer at the given track-elapsed position instead of a live pts expression', () => {
    const spawner: Spawner = jest.fn().mockReturnValue(fakeChild());
    const { feeder } = buildFeeder({ spawner });

    feeder.feedTrack(track, overlayWithTimer);
    feeder.feedPause(37);

    const args = (spawner as jest.Mock).mock.calls[1][1] as string[];
    const filterComplex = filterComplexArg(args);
    expect(filterComplex).toContain("text='0\\:37 / 1\\:05'");
    expect(filterComplex).not.toContain('%{pts');
  });

  it('stopCurrent kills the active process', () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const { feeder } = buildFeeder({ spawner });

    feeder.feedTrack(track, overlay);
    feeder.stopCurrent();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('kills the outgoing process before spawning the next segment, so both never hold the fifos open for write at once', () => {
    const child1 = fakeChild();
    const child2 = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    const { feeder } = buildFeeder({ spawner });

    feeder.feedTrack(track, overlay);
    feeder.feedTrack(track, overlay);

    expect((child1.kill as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((spawner as jest.Mock).mock.invocationCallOrder[1]);
  });

  it('close() removes the overlay image file', () => {
    const { feeder } = buildFeeder();
    const unlinkSync = jest.spyOn(require('fs'), 'unlinkSync').mockImplementation(() => {});

    feeder.close();

    expect(unlinkSync).toHaveBeenCalledWith('/tmp/overlay-dest-1.png');
    unlinkSync.mockRestore();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/ffmpeg/segmentFeeder.test.ts`
Expected: FAIL — the current `SegmentFeeder` still requires `fifoPath`/`createWriteStream` in its
options and pipes stdout instead of passing FIFO paths as ffmpeg output targets.

- [ ] **Step 3: Rewrite `src/ffmpeg/segmentFeeder.ts`**

```typescript
import * as fs from 'fs';
import { Track } from '../playlist/types';
import { Spawner, ChildProcessLike, VideoParams } from './types';
import { buildTrackSegmentArgs, buildPauseSegmentArgs, NowPlayingOverlay, TimerOverlay } from './segmentArgs';
import { formatDurationForDrawtext } from './overlayText';
import { BLANK_OVERLAY_PNG } from '../render/blankOverlay';

export interface SegmentFeederOptions extends VideoParams {
  spawner: Spawner;
  // ffmpeg opens both of these paths itself (as -f h264/-f adts output targets) — SegmentFeeder
  // no longer owns a write stream onto either of them, see the Stage 2 design doc.
  videoFifoPath: string;
  audioFifoPath: string;
  backgroundPath: string;
  // Fixed on-disk path this feeder writes the current overlay PNG to before every track
  // segment, and reuses as-is for a pause segment — see feedPause().
  overlayImagePath: string;
  // Only actually used when the template has a `timer` element — see buildTimerOverlay().
  fontFile: string;
  writeFileSync?: (path: string, data: Buffer) => void;
}

export class SegmentFeeder {
  private readonly writeFileSync: (path: string, data: Buffer) => void;
  private activeProcess: ChildProcessLike | null = null;
  private hasWrittenOverlay = false;
  // Remembered across calls so feedPause() can reuse the last track's overlay picture and timer
  // position/style without re-rendering — pausing only ever changes the audio.
  private lastOverlay: NowPlayingOverlay | null = null;

  constructor(private readonly options: SegmentFeederOptions) {
    this.writeFileSync = options.writeFileSync ?? fs.writeFileSync;
  }

  feedTrack(track: Track, overlay: NowPlayingOverlay, startOffsetSeconds = 0): ChildProcessLike {
    this.writeFileSync(this.options.overlayImagePath, overlay.overlayPng);
    this.hasWrittenOverlay = true;
    this.lastOverlay = overlay;

    const timer: TimerOverlay | null = overlay.timer && {
      ...overlay.timer,
      // Live, ticking — pts:hms's optional offset carries the seek position forward so a
      // resumed track's displayed time continues from where it was paused instead of
      // restarting at 0 (this segment's own pts always starts near 0). Both colons inside
      // %{...} need escaping, not just the first one — confirmed by actually running this
      // through ffmpeg locally (`No option name near ...` otherwise), not just by reading docs.
      text: `%{pts\\:hms\\:${startOffsetSeconds}} / ${formatDurationForDrawtext(overlay.durationSeconds)}`,
    };

    const args = buildTrackSegmentArgs({
      audioPath: track.audioPath,
      backgroundPath: this.options.backgroundPath,
      overlayPngPath: this.options.overlayImagePath,
      fontFile: this.options.fontFile,
      timer,
      width: this.options.width,
      height: this.options.height,
      fps: this.options.fps,
      startOffsetSeconds,
      durationSeconds: overlay.durationSeconds,
      videoFifoPath: this.options.videoFifoPath,
      audioFifoPath: this.options.audioFifoPath,
    });
    return this.spawnNext(args);
  }

  feedPause(trackElapsedSeconds = 0): ChildProcessLike {
    // Reuses whichever picture is already on disk — the last playing track's — so pausing
    // only ever changes the audio, never the overlay. If a track segment somehow never got
    // to write one yet (defensive: shouldn't happen — start() always feeds a track before a
    // pause is reachable), fall back to the shared blank PNG so ffmpeg's -loop 1 input never
    // points at a file that doesn't exist.
    if (!this.hasWrittenOverlay) {
      this.writeFileSync(this.options.overlayImagePath, BLANK_OVERLAY_PNG);
      this.hasWrittenOverlay = true;
      this.lastOverlay = { durationSeconds: 0, overlayPng: BLANK_OVERLAY_PNG, timer: null };
    }

    const timer: TimerOverlay | null = this.lastOverlay!.timer && {
      ...this.lastOverlay!.timer,
      // Static — frozen at the elapsed position, not a live pts expression, since a paused
      // segment's own pts keeps advancing in real time even though no track is playing.
      text: `${formatDurationForDrawtext(trackElapsedSeconds)} / ${formatDurationForDrawtext(this.lastOverlay!.durationSeconds)}`,
    };

    const args = buildPauseSegmentArgs({
      backgroundPath: this.options.backgroundPath,
      overlayPngPath: this.options.overlayImagePath,
      fontFile: this.options.fontFile,
      timer,
      width: this.options.width,
      height: this.options.height,
      fps: this.options.fps,
      videoFifoPath: this.options.videoFifoPath,
      audioFifoPath: this.options.audioFifoPath,
    });
    return this.spawnNext(args);
  }

  stopCurrent(): void {
    if (this.activeProcess) {
      this.activeProcess.kill('SIGTERM');
      this.activeProcess = null;
    }
  }

  /** Removes the overlay image file. Call once the feeder is being discarded. */
  close(): void {
    try {
      fs.unlinkSync(this.options.overlayImagePath);
    } catch {
      // Never written, or already gone — either way there's nothing left to clean up.
    }
  }

  private spawnNext(args: string[]): ChildProcessLike {
    // The outgoing process must be killed before the next one starts — a FIFO only supports
    // one writer cleanly, so two producers must never both hold the video/audio FIFOs open at
    // once. Unlike the old single-FIFO design, there's no Node-owned write stream to unpipe
    // here: ffmpeg opens both FIFO paths itself as its own output targets.
    this.stopCurrent();
    const child = this.options.spawner('ffmpeg', args);
    this.activeProcess = child;
    return child;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/ffmpeg/segmentFeeder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ffmpeg/segmentFeeder.ts test/ffmpeg/segmentFeeder.test.ts
git commit -m "$(cat <<'EOF'
refactor: SegmentFeeder hands raw-ES fifo paths to ffmpeg directly

No more Node-owned write stream / manual pipe+unpipe — ffmpeg now
opens both the video and audio FIFO paths itself as -f h264/-f adts
output targets. stopCurrent() still has to kill the outgoing process
before the next one spawns (a FIFO only supports one clean writer),
it just no longer needs a stream-level unpipe to do it.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01J9KpK2UY7XGtFAxYJPFkzP
EOF
)"
```

---

## Task 3: `rtmpPusherArgs.ts` / `rtmpPusher.ts` — read both raw-ES fifos continuously

**Files:**
- Modify: `src/ffmpeg/rtmpPusherArgs.ts`
- Modify: `src/ffmpeg/rtmpPusher.ts`
- Test: `test/ffmpeg/rtmpPusherArgs.test.ts`
- Test: `test/ffmpeg/rtmpPusher.test.ts`

**Interfaces:**
- Produces: `buildRtmpPusherArgs(params: { videoFifoPath: string; audioFifoPath: string; fps:
  number; rtmpUrl: string; streamKey: string }): string[]`.
- Produces: `RtmpPusherParams = { videoFifoPath: string; audioFifoPath: string; fps: number;
  rtmpUrl: string; streamKey: string }` (the `RtmpPusher` class itself — constructor, `start()`,
  `stop()` — keeps its exact current shape and behavior; only its params type changes).

- [ ] **Step 1: Update `test/ffmpeg/rtmpPusherArgs.test.ts`**

Replace its contents with:

```typescript
import { buildRtmpPusherArgs } from '../../src/ffmpeg/rtmpPusherArgs';

describe('buildRtmpPusherArgs', () => {
  it('builds ffmpeg args that continuously mux both raw-ES fifos into the rtmp url + stream key', () => {
    const args = buildRtmpPusherArgs({
      videoFifoPath: '/tmp/x-video.fifo',
      audioFifoPath: '/tmp/x-audio.fifo',
      fps: 30,
      rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',
      streamKey: 'abcd-1234',
    });

    expect(args).toEqual([
      '-err_detect', 'ignore_err',
      '-re',
      '-f', 'h264', '-r', '30', '-i', '/tmp/x-video.fifo',
      '-f', 'aac', '-i', '/tmp/x-audio.fifo',
      '-c', 'copy',
      '-f', 'flv',
      'rtmp://a.rtmp.youtube.com/live2/abcd-1234',
    ]);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test -- test/ffmpeg/rtmpPusherArgs.test.ts`
Expected: FAIL — current implementation still takes a single `fifoPath` and emits `-i <fifoPath>`
with no `-f h264`/`-f aac`/`-r`.

- [ ] **Step 3: Rewrite `src/ffmpeg/rtmpPusherArgs.ts`**

```typescript
export function buildRtmpPusherArgs(params: {
  videoFifoPath: string;
  audioFifoPath: string;
  fps: number;
  rtmpUrl: string;
  streamKey: string;
}): string[] {
  return [
    // Kept as a defensive belt, though with raw elementary-stream inputs there is no longer a
    // container-level continuity counter for a segment switch to desynchronize in the first
    // place — see the Stage 2 design doc for why that's true now and wasn't before.
    '-err_detect', 'ignore_err',
    '-re',
    // Raw H.264 Annex-B has no in-band timing, so -r tells ffmpeg's demuxer what rate to
    // synthesize PTS at (must match the fps every producer segment encodes at).
    '-f', 'h264', '-r', String(params.fps), '-i', params.videoFifoPath,
    '-f', 'aac', '-i', params.audioFifoPath,
    '-c', 'copy',
    '-f', 'flv',
    `${params.rtmpUrl}/${params.streamKey}`,
  ];
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npm test -- test/ffmpeg/rtmpPusherArgs.test.ts`
Expected: PASS

- [ ] **Step 5: Update `test/ffmpeg/rtmpPusher.test.ts`'s fixture params (no behavior changes to assert — only the params shape)**

In `test/ffmpeg/rtmpPusher.test.ts`, replace every
`{ fifoPath: '/tmp/fifo', rtmpUrl: 'rtmp://x', streamKey: 'k' }` with
`{ videoFifoPath: '/tmp/video.fifo', audioFifoPath: '/tmp/audio.fifo', fps: 30, rtmpUrl: 'rtmp://x', streamKey: 'k' }`,
and change the one assertion that reads:

```typescript
    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-i', '/tmp/fifo', 'rtmp://x/k']));
```

to:

```typescript
    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-i', '/tmp/video.fifo', 'rtmp://x/k']));
```

Everything else in that file (the `fakeChild`/`emitExit` helper, the `onExit`/`stop`/
"reports unexpected exits again" tests) is unchanged.

- [ ] **Step 6: Run it, verify it still fails (params type doesn't match `RtmpPusher` yet)**

Run: `npm test -- test/ffmpeg/rtmpPusher.test.ts`
Expected: FAIL — TypeScript error / runtime mismatch, since `RtmpPusher`'s `RtmpPusherParams`
interface still expects `fifoPath`.

- [ ] **Step 7: Update `RtmpPusherParams` in `src/ffmpeg/rtmpPusher.ts`**

In `src/ffmpeg/rtmpPusher.ts`, replace:

```typescript
export interface RtmpPusherParams {
  fifoPath: string;
  rtmpUrl: string;
  streamKey: string;
}
```

with:

```typescript
export interface RtmpPusherParams {
  videoFifoPath: string;
  audioFifoPath: string;
  fps: number;
  rtmpUrl: string;
  streamKey: string;
}
```

Nothing else in the file changes — `start()`/`stop()` already just forward `this.params` into
`buildRtmpPusherArgs(this.params)`.

- [ ] **Step 8: Run both test files, verify they pass**

Run: `npm test -- test/ffmpeg/rtmpPusherArgs.test.ts test/ffmpeg/rtmpPusher.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/ffmpeg/rtmpPusherArgs.ts src/ffmpeg/rtmpPusher.ts test/ffmpeg/rtmpPusherArgs.test.ts test/ffmpeg/rtmpPusher.test.ts
git commit -m "$(cat <<'EOF'
refactor: RtmpPusher reads two raw-ES fifos instead of one MPEG-TS fifo

Second step of the Stage 2 stream-continuity fix. RtmpPusher keeps its
name and start()/stop()/onExit lifecycle exactly as before — only the
ffmpeg args and params shape change, to mux+push directly from the
video/audio elementary streams SegmentFeeder now produces.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01J9KpK2UY7XGtFAxYJPFkzP
EOF
)"
```

---

## Task 4: `streamController.ts` — two fifo paths, drop the session-clock offset machinery

**Files:**
- Modify: `src/stream/streamController.ts`
- Test: `test/stream/streamController.test.ts`

**Interfaces:**
- Consumes: `SegmentFeeder.feedTrack(track, overlay, startOffsetSeconds?)` and
  `feedPause(trackElapsedSeconds?)` from Task 2 (no more trailing/leading session-offset arg).
- Produces: `StreamControllerDeps` gains `videoFifoPath: string; audioFifoPath: string` in place
  of `fifoPath: string`; every other field (`library`, `queue`, `createFifo`, `removeFifo`,
  `createSegmentFeeder`, `createRtmpPusher`, `buildOverlay`, `onError`, `onStatusChanged`) is
  unchanged. `StreamController`'s public methods (`start`, `stop`, `pause`, `resume`, `next`,
  `previous`, `playByName`, `status`) keep their exact current signatures.

- [ ] **Step 1: Update `test/stream/streamController.test.ts`'s fixtures and offset-bearing assertions**

In `test/stream/streamController.test.ts`:

1. In `buildDeps()`, replace:

```typescript
    library, queue, fifoPath: '/tmp/fifo',
```

with:

```typescript
    library, queue, videoFifoPath: '/tmp/video.fifo', audioFifoPath: '/tmp/audio.fifo',
```

2. Every `feeder.feedTrack` assertion currently ending in `..., 0, expect.any(Number))` or
   `..., 12.345, 20)` etc. drops its trailing session-offset argument. Concretely:

- `'start() creates the fifo, starts the pusher and feeds the current track with no offset'`:
  replace
  ```typescript
      expect(deps.createFifo).toHaveBeenCalledWith('/tmp/fifo');
  ```
  with
  ```typescript
      expect(deps.createFifo).toHaveBeenCalledWith('/tmp/video.fifo');
      expect(deps.createFifo).toHaveBeenCalledWith('/tmp/audio.fifo');
  ```
  and replace
  ```typescript
      expect(feeder.feedTrack).toHaveBeenCalledWith(
        { name: 'a', audioPath: '/music/a.mp3', coverPath: null },
        overlayFor(track('a')),
        0,
        expect.any(Number),
      );
  ```
  with
  ```typescript
      expect(feeder.feedTrack).toHaveBeenCalledWith(
        { name: 'a', audioPath: '/music/a.mp3', coverPath: null },
        overlayFor(track('a')),
        0,
      );
  ```

- `'pause() then resume() seeks feedTrack to the elapsed position'`: replace
  ```typescript
      expect(feeder.feedPause).toHaveBeenCalledWith(12.345, 12.345);
  ```
  with
  ```typescript
      expect(feeder.feedPause).toHaveBeenCalledWith(12.345);
  ```
  and replace
  ```typescript
      expect(feeder.feedTrack).toHaveBeenLastCalledWith(
        { name: 'a', audioPath: '/music/a.mp3', coverPath: null },
        overlayFor(track('a')),
        12.345,
        20,
      );
  ```
  with
  ```typescript
      expect(feeder.feedTrack).toHaveBeenLastCalledWith(
        { name: 'a', audioPath: '/music/a.mp3', coverPath: null },
        overlayFor(track('a')),
        12.345,
      );
  ```

- `'accumulates track-elapsed time across multiple pause/resume cycles...'`: replace both
  ```typescript
      expect(feeder.feedPause).toHaveBeenLastCalledWith(expect.any(Number), 5);
  ```
  and
  ```typescript
      expect(feeder.feedPause).toHaveBeenLastCalledWith(expect.any(Number), 8);
  ```
  with
  ```typescript
      expect(feeder.feedPause).toHaveBeenLastCalledWith(5);
  ```
  and
  ```typescript
      expect(feeder.feedPause).toHaveBeenLastCalledWith(8);
  ```
  respectively.

- `'next() advances the queue, resets elapsed time and feeds the new track while streaming'` and
  `'auto-advances to the next track when the current segment exits naturally'`: both currently end
  their `feedTrack` assertion with `0, expect.any(Number),); ` — drop the trailing
  `expect.any(Number)` so it reads `..., 0,);`.

3. `'stop() tears down the feeder, pusher and fifo'`: replace
   ```typescript
       expect(deps.removeFifo).toHaveBeenCalledWith('/tmp/fifo');
   ```
   with
   ```typescript
       expect(deps.removeFifo).toHaveBeenCalledWith('/tmp/video.fifo');
       expect(deps.removeFifo).toHaveBeenCalledWith('/tmp/audio.fifo');
   ```

4. `'start() removes any stale fifo before creating it'`: replace
   ```typescript
       expect(deps.removeFifo).toHaveBeenCalledWith('/tmp/fifo');
       expect(deps.removeFifo.mock.invocationCallOrder[0])
         .toBeLessThan(deps.createFifo.mock.invocationCallOrder[0]);
   ```
   with
   ```typescript
       expect(deps.removeFifo).toHaveBeenCalledWith('/tmp/video.fifo');
       expect(deps.removeFifo).toHaveBeenCalledWith('/tmp/audio.fifo');
       expect(Math.max(...deps.removeFifo.mock.invocationCallOrder))
         .toBeLessThan(Math.min(...deps.createFifo.mock.invocationCallOrder));
   ```

Every other test in the file (empty-library, already-streaming 409, the overlay-probe-race tests,
`playByName`, `stop()`/`start()` recovery, `onStatusChanged` invocation counts, auto-advance
double-advance guards) is unaffected and stays as-is.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/stream/streamController.test.ts`
Expected: FAIL — `StreamController` still reads `deps.fifoPath` and still calls
`feeder.feedTrack(..., outputTsOffsetSeconds)`/`feeder.feedPause(offset, elapsed)`.

- [ ] **Step 3: Update `src/stream/streamController.ts`**

Replace the `StreamControllerDeps` interface's `fifoPath: string;` line with:

```typescript
  videoFifoPath: string;
  audioFifoPath: string;
```

Remove the `private streamStartedAt: number | null = null;` field.

In `start()`, replace:

```typescript
    this.pusher?.stop();
    this.feeder = null;
    this.pusher = null;
    this.deps.removeFifo(this.deps.fifoPath);

    this.deps.createFifo(this.deps.fifoPath);
```

with:

```typescript
    this.pusher?.stop();
    this.feeder = null;
    this.pusher = null;
    this.deps.removeFifo(this.deps.videoFifoPath);
    this.deps.removeFifo(this.deps.audioFifoPath);

    this.deps.createFifo(this.deps.videoFifoPath);
    this.deps.createFifo(this.deps.audioFifoPath);
```

Still in `start()`, remove the `this.streamStartedAt = Date.now();` line (keep
`this.pausedElapsedSeconds = 0;`/`this.trackStartedAt = null;` as-is).

In `stop()`, replace:

```typescript
    this.pusher?.stop();
    this.deps.removeFifo(this.deps.fifoPath);
    this.feeder = null;
```

with:

```typescript
    this.pusher?.stop();
    this.deps.removeFifo(this.deps.videoFifoPath);
    this.deps.removeFifo(this.deps.audioFifoPath);
    this.feeder = null;
```

and remove the `this.streamStartedAt = null;` line further down in `stop()`.

In `pause()`, replace:

```typescript
    this.feeder!.feedPause(this.elapsedSessionSeconds(), this.pausedElapsedSeconds);
```

with:

```typescript
    this.feeder!.feedPause(this.pausedElapsedSeconds);
```

In `feedCurrentTrack()`, replace:

```typescript
    const child = this.feeder!.feedTrack(track, overlay, startOffsetSeconds, this.elapsedSessionSeconds());
```

with:

```typescript
    const child = this.feeder!.feedTrack(track, overlay, startOffsetSeconds);
```

Delete the entire `elapsedSessionSeconds()` private method and its doc comment (the block
starting `// How many real seconds this stream session has been live for...` through its closing
`}`) — it existed only to compute `-output_ts_offset`, which no longer exists (Task 1).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/stream/streamController.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/stream/streamController.ts test/stream/streamController.test.ts
git commit -m "$(cat <<'EOF'
refactor: StreamController owns two fifo paths, drops session-clock offset

Third step of the Stage 2 stream-continuity fix. -output_ts_offset
and elapsedSessionSeconds() existed only to patch over each segment's
PTS restarting near 0 when it was its own MPEG-TS mux — with a
persistent RtmpPusher now assigning PTS once for the whole session
(Task 3), there's nothing left to patch over.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01J9KpK2UY7XGtFAxYJPFkzP
EOF
)"
```

---

## Task 5: `streamManager.ts` — wire two fifo paths per destination, drop the `createWriteStream` seam

**Files:**
- Modify: `src/stream/streamManager.ts`
- Test: `test/stream/streamManager.test.ts`

**Interfaces:**
- Consumes: `StreamControllerDeps.{videoFifoPath, audioFifoPath}` (Task 4),
  `SegmentFeederOptions.{videoFifoPath, audioFifoPath}` (Task 2, no more `createWriteStream`),
  `RtmpPusherParams.{videoFifoPath, audioFifoPath, fps}` (Task 3).
- Produces: `StreamManagerDeps` loses its `createWriteStream?` field — nothing else in its public
  surface (`StreamManager.start/stop/pause/resume/next/previous/playByName/status/get`) changes.

- [ ] **Step 1: Update `test/stream/streamManager.test.ts`**

Remove the `createWriteStream` fake and its plumbing:

1. Delete the `PassThrough` import if nothing else in the file needs it (check — it's currently
   only used to fake the write stream); if `PassThrough` becomes unused after this task's other
   edits, remove `import { PassThrough } from 'stream';` too.
2. Remove this block from `buildDeps()`:
   ```typescript
     // SegmentFeeder opens a real fs.createWriteStream on the fifo path unless overridden;
     // fake it so start()/tests never touch the real filesystem (same rationale as the
     // fifo/duration module mocks above — no real fs/subprocess touches in a unit test).
     const createWriteStream = jest.fn().mockImplementation(() => new PassThrough());
   ```
3. Remove `createWriteStream` from both the returned `deps` object and the outer returned object
   in `buildDeps()`.
4. In the test `'start() creates a controller reachable via get(), and status() reflects it'`,
   replace:
   ```typescript
     const { deps, createWriteStream } = buildDeps();
   ```
   with:
   ```typescript
     const { deps } = buildDeps();
   ```
   and replace:
   ```typescript
     expect(createWriteStream).toHaveBeenCalledWith('/tmp/super-dj-stream-dest-1.fifo');
   ```
   with:
   ```typescript
     expect(deps.spawner).not.toHaveBeenCalled(); // nothing spawns until the fifos exist and a track is fed — see the next assertions
     expect(manager.status('dest-1').currentTrack).toBe('a');
   ```
   Actually — simplify: just drop that `createWriteStream` assertion outright (there is no longer
   a write-stream seam to assert against); the surrounding assertions
   (`manager.get('dest-1')`/`status('dest-1').state`/`.currentTrack`) already cover this test's
   intent. Final shape of that test body:
   ```typescript
   it('start() creates a controller reachable via get(), and status() reflects it', async () => {
     const { deps } = buildDeps();
     const manager = new StreamManager(deps as any);

     await manager.start('dest-1', 'playlist-1');

     expect(manager.get('dest-1')).toBeDefined();
     expect(manager.status('dest-1').state).toBe('streaming');
     expect(manager.status('dest-1').currentTrack).toBe('a');
   });
   ```

Every other test in the file (404/403/409 checks, provider selection, template
resolution/fallback, overlay cache wiring, lifecycle finalize-on-error/stop/restart) doesn't touch
`fifoPath`/`createWriteStream` and stays as-is.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/stream/streamManager.test.ts`
Expected: FAIL — `StreamManagerDeps` still declares `createWriteStream`, and `StreamManager.start`
still builds one `fifoPath` and passes it as `SegmentFeederOptions.fifoPath`/
`StreamControllerDeps.fifoPath`/`RtmpPusherParams.fifoPath`, none of which compile against Tasks
2-4's new types.

- [ ] **Step 3: Update `src/stream/streamManager.ts`**

Remove the `createWriteStream` field from `StreamManagerDeps`:

```typescript
  // Optional seam for tests: SegmentFeeder opens a real fs write stream onto the
  // FIFO by default. Left undefined in production so SegmentFeeder's own default
  // (fs.createWriteStream) applies unchanged.
  createWriteStream?: (path: string) => NodeJS.WritableStream;
```

— delete this whole block (including its comment); it no longer applies now that `SegmentFeeder`
doesn't own a write stream at all (Task 2).

In `start()`, replace:

```typescript
      const queue = new PlaylistQueue(tracks);
      const fifoPath = path.join(this.deps.fifoDir, `super-dj-stream-${destinationId}.fifo`);
      const overlayImagePath = path.join(this.deps.fifoDir, `super-dj-overlay-${destinationId}.png`);
```

with:

```typescript
      const queue = new PlaylistQueue(tracks);
      const videoFifoPath = path.join(this.deps.fifoDir, `super-dj-stream-${destinationId}-video.fifo`);
      const audioFifoPath = path.join(this.deps.fifoDir, `super-dj-stream-${destinationId}-audio.fifo`);
      const overlayImagePath = path.join(this.deps.fifoDir, `super-dj-overlay-${destinationId}.png`);
```

Replace the `StreamController` construction's `fifoPath` field and its two factory closures:

```typescript
      const controller = new StreamController({
        library: {
          list: () => tracks,
          findByName: (name: string) => allUserTracks.find((t) => t.name === name),
        },
        queue,
        fifoPath,
        createFifo,
        removeFifo,
        buildOverlay,
        createSegmentFeeder: () => new SegmentFeeder({
          spawner: this.deps.spawner,
          fifoPath,
          backgroundPath: this.deps.backgroundImagePath,
          overlayImagePath,
          fontFile: this.deps.fontFile,
          width: VIDEO_WIDTH,
          height: VIDEO_HEIGHT,
          fps: VIDEO_FPS,
          createWriteStream: this.deps.createWriteStream,
        }),
        createRtmpPusher: () => new RtmpPusher(this.deps.spawner, { fifoPath, rtmpUrl: session.rtmpUrl, streamKey: session.streamKey }),
```

with:

```typescript
      const controller = new StreamController({
        library: {
          list: () => tracks,
          findByName: (name: string) => allUserTracks.find((t) => t.name === name),
        },
        queue,
        videoFifoPath,
        audioFifoPath,
        createFifo,
        removeFifo,
        buildOverlay,
        createSegmentFeeder: () => new SegmentFeeder({
          spawner: this.deps.spawner,
          videoFifoPath,
          audioFifoPath,
          backgroundPath: this.deps.backgroundImagePath,
          overlayImagePath,
          fontFile: this.deps.fontFile,
          width: VIDEO_WIDTH,
          height: VIDEO_HEIGHT,
          fps: VIDEO_FPS,
        }),
        createRtmpPusher: () => new RtmpPusher(this.deps.spawner, {
          videoFifoPath,
          audioFifoPath,
          fps: VIDEO_FPS,
          rtmpUrl: session.rtmpUrl,
          streamKey: session.streamKey,
        }),
```

(the rest of that object literal — `onError`, `onStatusChanged` — is unchanged).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/stream/streamManager.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full backend test suite**

Run: `npm test`
Expected: PASS, no failures anywhere (this is the point where any missed call site across the
whole backend — routes, other stream tests — would surface).

- [ ] **Step 6: Commit**

```bash
git add src/stream/streamManager.ts test/stream/streamManager.test.ts
git commit -m "$(cat <<'EOF'
refactor: StreamManager wires two per-destination fifo paths

Final wiring step of the Stage 2 stream-continuity fix: each active
destination now owns a -video.fifo and a -audio.fifo instead of one
combined .fifo, threaded through to SegmentFeeder/StreamController/
RtmpPusher. Also drops the createWriteStream test seam entirely, now
that SegmentFeeder doesn't own a write stream (previous commit).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01J9KpK2UY7XGtFAxYJPFkzP
EOF
)"
```

---

## Task 6: Real-ffmpeg verification (required — see Global Constraints)

Not a code task — this is the check that actually validates the fix, since none of Tasks 1-5's
unit tests spawn real ffmpeg (per CLAUDE.md's testing strategy, they all fake the `Spawner`
boundary) and the original bug was never visible to a fake-`Spawner` test in the first place.

- [ ] **Step 1: Build and deploy to the 192.168.14.26 test host**

Follow the existing deploy workflow documented in `[[project_super_dj_remote_test_host]]` (git
archive + scp/ssh, then re-apply the `docker-compose.yml` `8088:3000` port fix — it's a
local-only edit that redeploys silently revert).

- [ ] **Step 2: Start a real stream and trigger at least two consecutive track switches**

Start a stream against a destination with a playlist of 3+ tracks, then call `next` (or
equivalent UI action) at least twice in the same session — the exact scenario that killed the
stream in this session's reproduction (first switch survived, second switch was fatal).

- [ ] **Step 3: Confirm no connection drop and no corruption in the logs**

Watch `docker logs -f super-dj-super-dj-1` across both switches (or fetch recent logs
afterward). Confirm: the RTMP connection stays alive through both switches (no `EPIPE`, no
`Conversion failed!`, no `aac_adtstoasc` parse error), and ideally no `Packet corrupt` at all
(raw elementary streams have no continuity counter to desync — if one still shows up, that's a
signal something about the fix isn't fully working and needs another look before calling this
done).

- [ ] **Step 4: Report the result**

If clean: this plan's goal is met — no further code changes needed. If not clean: capture the
exact log output (same as this session's original reproduction) and treat it as a new Phase 1
investigation (`superpowers:systematic-debugging`) rather than patching blind — the two-FIFO
timing assumptions (spec section 1, "Risk / rollback") are the most likely place a real ffmpeg
binary could still surprise this design.
