# OBS-style persistent canvas + encoder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a track switch from ever killing a destination's RTMP connection, by replacing the
per-segment-process pipeline (already found, via real-ffmpeg testing, to deadlock in its two-FIFO
form) with one persistent per-destination encoder process — fed by two Node-owned anonymous pipes
— that never restarts for the life of the session.

**Architecture:** `CanvasFeeder` (one-shot ffmpeg renders on content change, resent on a fixed
heartbeat) writes raw video frames into the encoder's video pipe. `AudioRelay` (decode-only ffmpeg
per track, silence on pause) writes raw PCM into the encoder's audio pipe — same
kill-outgoing-before-spawning-next discipline `SegmentFeeder` already had. `PersistentEncoder`
(replaces `RtmpPusher`/`rtmpPusherArgs.ts`) is the one process per destination that never
restarts: it encodes both raw streams and muxes+pushes to RTMP continuously. `StreamController`
coordinates the three instead of driving one big per-segment process.

**Tech Stack:** TypeScript, Node.js `child_process`/`fs`, ffmpeg (via the existing injected
`Spawner`/`ChildProcessLike` fakes, plus a new `PipeSpawner` for the encoder's extra stdio pipes),
Jest.

**Spec:** `docs/superpowers/specs/2026-09-03-obs-style-persistent-canvas-design.md`

## Global Constraints

- No feature flag / dual-path — full replacement. Rollback is `git revert`, not a runtime toggle.
- Every unit test in this codebase fakes the `Spawner`/`PipeSpawner`/`ChildProcessLike` boundary —
  never spawn real ffmpeg in a unit test.
- `FIFO_DIR`/`fifoDir` (env var and `StreamManagerDeps` field) is **not** renamed even though this
  pipeline no longer creates FIFOs with it — it's still where `SegmentFeeder`'s replacement writes
  the per-destination overlay-image scratch file. Renaming the env var is out of scope.
- `-re` belongs on the persistent encoder's **audio** input only, not the video input — audio
  pacing is what backpressures the upstream decode-only `AudioRelay` process to real time; video
  timing is already governed by `CanvasFeeder`'s own fixed-interval heartbeat.
- `CanvasFeeder` writes to its pipe on a **fixed heartbeat interval**, re-rendering (spawning a new
  one-shot ffmpeg) only on an actual content change. Never make the heartbeat itself conditional
  on "did content change" — the declared input framerate must match the real wall-clock write
  cadence exactly, or the video timeline drifts from real elapsed time (this is the reason the
  original "write only on change" framing was corrected during spec self-review).
- The native ticking-timer drawtext expression (`%{pts\:hms\:OFFSET}`) is gone. There is no longer
  a continuous per-track encode process for ffmpeg's own pts clock to drive a live expression from
  — `CanvasFeeder` re-renders with a plain, Node-computed elapsed-time string on every timer tick
  (streaming) or once on pause (frozen), the same code path for both. Do not reintroduce the pts
  expression.
- This plan's automated tests alone do **not** constitute done — the final task (real-ffmpeg
  verification) is required before considering this fixed, per
  `[[feedback_verify_against_real_binaries]]`.

---

## Task 0: Revert the two-FIFO implementation back to the pre-Stage-2 baseline

The two-FIFO raw-elementary-stream design (5 tasks, already implemented and reviewed in this same
worktree) was invalidated by real-ffmpeg verification — see the spec's "Why the two-FIFO design
was abandoned" section. Before building the replacement, clear that code back to the last known-
good commit so the new architecture is built on a clean, working baseline rather than patched onto
code that's being thrown away.

**Files:**
- Reverts: `src/ffmpeg/segmentArgs.ts`, `src/ffmpeg/segmentFeeder.ts`, `src/ffmpeg/rtmpPusher.ts`,
  `src/ffmpeg/rtmpPusherArgs.ts`, `src/stream/streamController.ts`, `src/stream/streamManager.ts`,
  and their test files, all back to their content at commit `cdec284` (the last commit before any
  Stage 2 work started this session).

- [ ] **Step 1: Confirm the baseline commit and current HEAD**

Run: `git log --oneline -1 cdec284` — expect `cdec284 feat: visual drag-and-drop editor for
overlay templates (Stage 3)`. Run: `git log --oneline -1 HEAD` — this is the tip of the two-FIFO
work (docs commits plus 6 implementation commits) that Task 0 is reverting.

- [ ] **Step 2: Restore the affected files to their pre-Stage-2 content**

```bash
git checkout cdec284 -- \
  src/ffmpeg/segmentArgs.ts \
  src/ffmpeg/segmentFeeder.ts \
  src/ffmpeg/rtmpPusher.ts \
  src/ffmpeg/rtmpPusherArgs.ts \
  src/stream/streamController.ts \
  src/stream/streamManager.ts \
  test/ffmpeg/segmentArgs.test.ts \
  test/ffmpeg/segmentFeeder.test.ts \
  test/ffmpeg/rtmpPusher.test.ts \
  test/ffmpeg/rtmpPusherArgs.test.ts \
  test/stream/streamController.test.ts \
  test/stream/streamManager.test.ts
```

- [ ] **Step 3: Run the full suite to confirm the revert lands on a green baseline**

Run: `npm test`
Expected: PASS, every suite — this should look identical to the state before any Stage 2 work
this session (40 suites, 311 tests, per the session's very first baseline run).

- [ ] **Step 4: Commit**

```bash
git add src/ffmpeg/segmentArgs.ts src/ffmpeg/segmentFeeder.ts src/ffmpeg/rtmpPusher.ts src/ffmpeg/rtmpPusherArgs.ts src/stream/streamController.ts src/stream/streamManager.ts test/ffmpeg/segmentArgs.test.ts test/ffmpeg/segmentFeeder.test.ts test/ffmpeg/rtmpPusher.test.ts test/ffmpeg/rtmpPusherArgs.test.ts test/stream/streamController.test.ts test/stream/streamManager.test.ts
git commit -m "$(cat <<'EOF'
revert: back out the two-FIFO raw-ES pipeline (deadlocks under real ffmpeg)

Real-ffmpeg verification found this design deadlocks (ffmpeg opens
multiple -i/output targets in a fixed order, producing a circular
wait between the persistent muxer and each producer) and, in a
single-FIFO follow-up, hits the classic FIFO EOF-on-last-writer-close
gotcha once the Node-owned persistent write stream was removed. See
docs/superpowers/specs/2026-09-03-obs-style-persistent-canvas-design.md
for the full diagnosis and the replacement architecture this clears
the way for.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01J9KpK2UY7XGtFAxYJPFkzP
EOF
)"
```

---

## Task 1: `PipeSpawner` — the encoder's extra-stdio spawn primitive

**Files:**
- Modify: `src/ffmpeg/types.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Produces: `ChildProcessWithPipes extends ChildProcessLike { readonly videoPipe:
  NodeJS.WritableStream; readonly audioPipe: NodeJS.WritableStream }`.
- Produces: `PipeSpawner = (command: string, args: string[]) => ChildProcessWithPipes`.
- Produces: `createPipeSpawner(): PipeSpawner` in `server.ts`, alongside the existing
  `createSpawner()`.

This is the only new piece of spawning machinery this plan needs — `CanvasFeeder` and
`AudioRelay` (Tasks 3 and 5) both use the existing plain `Spawner` unchanged, since they only need
a single stdout pipe each, exactly like today's `SegmentFeeder`. Only `PersistentEncoder`
(Task 4) needs two *extra* pipes beyond stdin/stdout/stderr, which is what `PipeSpawner` is for.

- [ ] **Step 1: Add the types**

In `src/ffmpeg/types.ts`, after the existing `Spawner` type, add:

```typescript
// The persistent encoder is the one thing in this pipeline that needs more than a single stdout
// pipe: Node feeds it raw video and raw PCM audio continuously for the life of the session via
// two extra anonymous pipe file descriptors (fd 3 and 4) — no named FIFOs, no filesystem entity
// with the multi-writer-over-time semantics that broke the two-FIFO design (see the Stage 2
// design doc's "Why the two-FIFO design was abandoned").
export interface ChildProcessWithPipes extends ChildProcessLike {
  readonly videoPipe: NodeJS.WritableStream;
  readonly audioPipe: NodeJS.WritableStream;
}

export type PipeSpawner = (command: string, args: string[]) => ChildProcessWithPipes;
```

- [ ] **Step 2: Add the production implementation to `server.ts`**

In `src/server.ts`, after the existing `createSpawner` function, add:

```typescript
export function createPipeSpawner(): PipeSpawner {
  return (command: string, args: string[]): ChildProcessWithPipes => {
    // fd0 (stdin) unused, fd1 (stdout) unused — this process's real output is the RTMP push, not
    // anything on stdout. fd2 (stderr) drained the same way createSpawner() does. fd3/fd4 are the
    // video/audio pipes ffmpeg's own args reference as pipe:3/pipe:4.
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    return Object.assign(child as unknown as ChildProcessLike, {
      videoPipe: child.stdio[3] as unknown as NodeJS.WritableStream,
      audioPipe: child.stdio[4] as unknown as NodeJS.WritableStream,
    }) as ChildProcessWithPipes;
  };
}
```

Add `ChildProcessWithPipes`, `PipeSpawner` to the existing `import { ... } from './ffmpeg/types'`
line at the top of `server.ts` (alongside whatever's already imported there — check the current
import line before editing so you extend it rather than duplicate it).

- [ ] **Step 3: Type-check**

Run: `npm run build`
Expected: succeeds (no test file references this yet — Task 4 is what actually exercises it via a
fake `PipeSpawner`).

- [ ] **Step 4: Commit**

```bash
git add src/ffmpeg/types.ts src/server.ts
git commit -m "$(cat <<'EOF'
feat: add PipeSpawner for the persistent encoder's extra stdio pipes

First piece of the OBS-style persistent-canvas architecture. Only
PersistentEncoder (Task 4) needs this — CanvasFeeder and AudioRelay
both use the existing plain Spawner, same as SegmentFeeder always did.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01J9KpK2UY7XGtFAxYJPFkzP
EOF
)"
```

---

## Task 2: `segmentArgs.ts` — replace the per-segment encode builders with a one-shot canvas-frame builder

**Files:**
- Modify: `src/ffmpeg/segmentArgs.ts`
- Modify: `test/ffmpeg/segmentArgs.test.ts`

**Interfaces:**
- Removes: `buildTrackSegmentArgs`, `buildPauseSegmentArgs` (no longer used anywhere — there is no
  more continuous per-track encode process; `PersistentEncoder`, Task 4, is the only thing that
  encodes now).
- Keeps unchanged: `TimerElementPosition`, `NowPlayingOverlay`, `TimerOverlay`,
  `overlayFilterComplex` (the internal compositing-filter builder — still exactly what's needed to
  composite background + overlay PNG + optional drawtext, just invoked differently now).
- Produces: `buildCanvasFrameArgs(params: { backgroundPath: string; overlayPngPath: string;
  fontFile: string; timer?: TimerOverlay | null; width: number; height: number }): string[]` — a
  single-frame raw-video render, not a continuous encode.

- [ ] **Step 1: Replace the test file**

Replace `test/ffmpeg/segmentArgs.test.ts` entirely with:

```typescript
import { buildCanvasFrameArgs, TimerOverlay } from '../../src/ffmpeg/segmentArgs';

const timer: TimerOverlay = { x: 10, y: 660, fontSize: 20, color: '#ffffff', text: '0:05 / 1:05' };

describe('buildCanvasFrameArgs', () => {
  const base = {
    backgroundPath: '/assets/background.png',
    overlayPngPath: '/tmp/super-dj-overlay-dest-1.png',
    fontFile: '/fonts/DejaVuSans-Bold.ttf',
    width: 1280,
    height: 720,
  };

  it('builds a single-frame raw-video render compositing the background and overlay PNG, with no timer by default', () => {
    const args = buildCanvasFrameArgs(base);

    expect(args).toEqual([
      '-y',
      '-i', '/assets/background.png',
      '-i', '/tmp/super-dj-overlay-dest-1.png',
      '-filter_complex', '[0:v]scale=1280:720[bg];[1:v]scale=1280:720[ov];[bg][ov]overlay=0:0[outv]',
      '-map', '[outv]',
      '-frames:v', '1',
      '-f', 'rawvideo',
      '-pix_fmt', 'yuv420p',
      '-',
    ]);
  });

  it('layers a drawtext for the timer on top of the overlay when given one, as a plain (already-formatted) string', () => {
    const args = buildCanvasFrameArgs({ ...base, timer });

    const filterComplex = args[args.indexOf('-filter_complex') + 1];
    expect(filterComplex).toBe(
      "[0:v]scale=1280:720[bg];[1:v]scale=1280:720[ov];[bg][ov]overlay=0:0[base];"
      + "[base]drawtext=fontfile=/fonts/DejaVuSans-Bold.ttf:text='0:05 / 1:05':x=10:y=660:fontsize=20:fontcolor=#ffffff[outv]",
    );
    // No pts-expression escaping — there's no continuous per-track encode process for a live
    // %{pts\:hms\:OFFSET} expression to run against any more (see CanvasFeeder/StreamController).
    expect(filterComplex).not.toContain('%{pts');
  });

  it('always overwrites the previous frame at this path without prompting (a real ffmpeg gotcha found via live testing)', () => {
    const args = buildCanvasFrameArgs(base);

    expect(args[0]).toBe('-y');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/ffmpeg/segmentArgs.test.ts`
Expected: FAIL — `buildCanvasFrameArgs` doesn't exist yet.

- [ ] **Step 3: Replace `buildTrackSegmentArgs`/`buildPauseSegmentArgs` with `buildCanvasFrameArgs`**

In `src/ffmpeg/segmentArgs.ts`, delete both `buildTrackSegmentArgs` and `buildPauseSegmentArgs` in
their entirety (everything from `export function buildTrackSegmentArgs` to the end of the file),
keeping everything above them (`VideoParams` import, `TimerElementPosition`, `NowPlayingOverlay`,
`TimerOverlay`, `overlayFilterComplex`) exactly as-is. Add in their place:

```typescript
// A single still frame — background + overlay PNG composited, optional drawtext layered on top —
// rendered once and handed back as raw YUV420p bytes on stdout. Used by CanvasFeeder (see
// canvasFeeder.ts) both on an actual content change (track switch, pause/resume, a timer tick)
// and never on any other cadence — CanvasFeeder itself is what resends the same rendered frame on
// a fixed heartbeat between renders, this function only ever produces ONE new frame per call.
export function buildCanvasFrameArgs(params: {
  backgroundPath: string;
  overlayPngPath: string;
  fontFile: string;
  timer?: TimerOverlay | null;
  width: number;
  height: number;
}): string[] {
  const { backgroundPath, overlayPngPath, fontFile, width, height } = params;
  return [
    '-y',
    '-i', backgroundPath,
    '-i', overlayPngPath,
    '-filter_complex', overlayFilterComplex(width, height, fontFile, params.timer ?? null),
    '-map', '[outv]',
    '-frames:v', '1',
    '-f', 'rawvideo',
    '-pix_fmt', 'yuv420p',
    '-',
  ];
}
```

Note `VideoParams` is no longer used by this file directly (the removed functions were the only
consumers of the `width`/`height`/`fps` triple via that shared type — `buildCanvasFrameArgs` takes
`width`/`height` as plain fields, no `fps`, since a one-shot single-frame render has no frame rate
of its own). Remove the now-unused `import { VideoParams } from './types';` line if nothing else
in the file references `VideoParams` — check before removing.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/ffmpeg/segmentArgs.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ffmpeg/segmentArgs.ts test/ffmpeg/segmentArgs.test.ts
git commit -m "$(cat <<'EOF'
refactor: segmentArgs builds one still frame, not a continuous per-track encode

buildTrackSegmentArgs/buildPauseSegmentArgs encoded a whole track's
worth of video continuously — nothing in the new persistent-canvas
architecture does that any more (see the design doc). Replaced with
buildCanvasFrameArgs: composite once, emit exactly one raw frame.
overlayFilterComplex itself (the actual compositing logic) is
untouched and fully reused.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01J9KpK2UY7XGtFAxYJPFkzP
EOF
)"
```

---

## Task 3: `AudioRelay` — decode-only per-track relay into the encoder's audio pipe

**Files:**
- Create: `src/ffmpeg/audioRelayArgs.ts`
- Create: `src/ffmpeg/audioRelay.ts`
- Test: `test/ffmpeg/audioRelayArgs.test.ts`
- Test: `test/ffmpeg/audioRelay.test.ts`

**Interfaces:**
- Consumes: `Spawner`/`ChildProcessLike` from `./types` (the existing, unchanged plain spawner —
  not `PipeSpawner`).
- Produces: `buildDecodeTrackArgs(params: { audioPath: string; startOffsetSeconds?: number }):
  string[]`.
- Produces: `buildSilenceArgs(): string[]`.
- Produces: `new AudioRelay({ spawner })`, `.attach(audioPipe: NodeJS.WritableStream): void`,
  `.switchTrack(audioPath: string, startOffsetSeconds?: number): ChildProcessLike`,
  `.switchToSilence(): ChildProcessLike`, `.stopCurrent(): void`, `.close(): void` — consumed by
  `StreamController` (Task 6).

- [ ] **Step 1: Write the args-builder test file**

Create `test/ffmpeg/audioRelayArgs.test.ts`:

```typescript
import { buildDecodeTrackArgs, buildSilenceArgs } from '../../src/ffmpeg/audioRelayArgs';

describe('buildDecodeTrackArgs', () => {
  it('decodes a track file to raw PCM on stdout, no seek by default', () => {
    const args = buildDecodeTrackArgs({ audioPath: '/music/a.mp3' });

    expect(args).toEqual(['-i', '/music/a.mp3', '-f', 's16le', '-ar', '44100', '-ac', '2', '-']);
  });

  it('adds a -ss seek before the input when resuming mid-track', () => {
    const args = buildDecodeTrackArgs({ audioPath: '/music/a.mp3', startOffsetSeconds: 42 });

    expect(args).toEqual(['-ss', '42', '-i', '/music/a.mp3', '-f', 's16le', '-ar', '44100', '-ac', '2', '-']);
  });

  it('omits -ss when startOffsetSeconds is 0', () => {
    const args = buildDecodeTrackArgs({ audioPath: '/music/a.mp3', startOffsetSeconds: 0 });

    expect(args).not.toEqual(expect.arrayContaining(['-ss']));
  });
});

describe('buildSilenceArgs', () => {
  it('generates raw PCM silence matching the same format as a decoded track', () => {
    const args = buildSilenceArgs();

    expect(args).toEqual(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-f', 's16le', '-ar', '44100', '-ac', '2', '-']);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test -- test/ffmpeg/audioRelayArgs.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Create `src/ffmpeg/audioRelayArgs.ts`**

```typescript
// Raw PCM (s16le, 44.1kHz stereo) is the common format both a decoded track and generated
// silence are handed to the persistent encoder's audio pipe in — plain samples, no container, so
// there is nothing here that could ever develop a continuity-counter or bitstream-filter
// discontinuity at a track switch the way the old per-segment MPEG-TS encode did.
export function buildDecodeTrackArgs(params: { audioPath: string; startOffsetSeconds?: number }): string[] {
  const args: string[] = [];
  if (params.startOffsetSeconds) {
    args.push('-ss', String(params.startOffsetSeconds));
  }
  args.push('-i', params.audioPath, '-f', 's16le', '-ar', '44100', '-ac', '2', '-');
  return args;
}

export function buildSilenceArgs(): string[] {
  return ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-f', 's16le', '-ar', '44100', '-ac', '2', '-'];
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npm test -- test/ffmpeg/audioRelayArgs.test.ts`
Expected: PASS

- [ ] **Step 5: Write the `AudioRelay` class test file**

Create `test/ffmpeg/audioRelay.test.ts`:

```typescript
import { PassThrough, Writable } from 'stream';
import { AudioRelay } from '../../src/ffmpeg/audioRelay';
import { Spawner, ChildProcessLike } from '../../src/ffmpeg/types';

function fakeChild(): ChildProcessLike & { stdout: PassThrough } {
  const stdout = new PassThrough();
  return { pid: 123, stdout, stderr: null, kill: jest.fn(), once: jest.fn() };
}

describe('AudioRelay', () => {
  it('switchTrack spawns a decode-only ffmpeg and pipes its stdout into the attached audio pipe', () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const chunks: Buffer[] = [];
    const audioPipe = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
    const relay = new AudioRelay({ spawner });
    relay.attach(audioPipe);

    relay.switchTrack('/music/a.mp3');
    child.stdout.write('pcm-bytes');
    child.stdout.end();

    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-i', '/music/a.mp3']));
    expect(Buffer.concat(chunks).toString()).toBe('pcm-bytes');
  });

  it('switchTrack passes the start offset through for a resumed track', () => {
    const spawner: Spawner = jest.fn().mockReturnValue(fakeChild());
    const relay = new AudioRelay({ spawner });
    relay.attach(new PassThrough());

    relay.switchTrack('/music/a.mp3', 42);

    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-ss', '42']));
  });

  it('switchToSilence spawns anullsrc instead of decoding a file', () => {
    const spawner: Spawner = jest.fn().mockReturnValue(fakeChild());
    const relay = new AudioRelay({ spawner });
    relay.attach(new PassThrough());

    relay.switchToSilence();

    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['anullsrc=r=44100:cl=stereo']));
  });

  it('kills the outgoing process and unpipes it before spawning the next one', () => {
    const chunks: Buffer[] = [];
    const audioPipe = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
    const child1 = fakeChild();
    const child2 = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    const relay = new AudioRelay({ spawner });
    relay.attach(audioPipe);

    relay.switchTrack('/music/a.mp3');
    relay.switchTrack('/music/b.mp3');

    child1.stdout.write('stale-bytes-from-the-dying-decoder');
    child2.stdout.write('fresh-track-bytes');
    child2.stdout.end();

    expect(Buffer.concat(chunks).toString()).toBe('fresh-track-bytes');
    expect(child1.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('stopCurrent kills the active process without spawning a replacement', () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const relay = new AudioRelay({ spawner });
    relay.attach(new PassThrough());

    relay.switchTrack('/music/a.mp3');
    relay.stopCurrent();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('close() stops the active process', () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const relay = new AudioRelay({ spawner });
    relay.attach(new PassThrough());

    relay.switchTrack('/music/a.mp3');
    relay.close();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('switchTrack returns the spawned child so the caller can listen for natural end-of-track', () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const relay = new AudioRelay({ spawner });
    relay.attach(new PassThrough());

    const returned = relay.switchTrack('/music/a.mp3');

    expect(returned).toBe(child);
  });
});
```

- [ ] **Step 6: Run it, verify it fails**

Run: `npm test -- test/ffmpeg/audioRelay.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 7: Create `src/ffmpeg/audioRelay.ts`**

```typescript
import { Spawner, ChildProcessLike } from './types';
import { buildDecodeTrackArgs, buildSilenceArgs } from './audioRelayArgs';

export interface AudioRelayOptions {
  spawner: Spawner;
}

export class AudioRelay {
  private activeProcess: ChildProcessLike | null = null;
  private audioPipe: NodeJS.WritableStream | null = null;

  constructor(private readonly options: AudioRelayOptions) {}

  /** Called once, right after the persistent encoder starts — see StreamController.start(). */
  attach(audioPipe: NodeJS.WritableStream): void {
    this.audioPipe = audioPipe;
  }

  switchTrack(audioPath: string, startOffsetSeconds = 0): ChildProcessLike {
    return this.spawnNext(buildDecodeTrackArgs({ audioPath, startOffsetSeconds }));
  }

  switchToSilence(): ChildProcessLike {
    return this.spawnNext(buildSilenceArgs());
  }

  stopCurrent(): void {
    if (this.activeProcess) {
      // Same reasoning SegmentFeeder always had: kill() doesn't stop a still-alive process's
      // stdout from draining into the audio pipe immediately, so unpipe first or two decoders'
      // raw PCM could interleave into the same pipe for a moment.
      if (this.activeProcess.stdout && this.audioPipe) {
        this.activeProcess.stdout.unpipe(this.audioPipe);
      }
      this.activeProcess.kill('SIGTERM');
      this.activeProcess = null;
    }
  }

  close(): void {
    this.stopCurrent();
  }

  private spawnNext(args: string[]): ChildProcessLike {
    this.stopCurrent();
    const child = this.options.spawner('ffmpeg', args);
    if (child.stdout && this.audioPipe) {
      child.stdout.pipe(this.audioPipe, { end: false });
    }
    this.activeProcess = child;
    return child;
  }
}
```

- [ ] **Step 8: Run it, verify it passes**

Run: `npm test -- test/ffmpeg/audioRelay.test.ts test/ffmpeg/audioRelayArgs.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/ffmpeg/audioRelayArgs.ts src/ffmpeg/audioRelay.ts test/ffmpeg/audioRelayArgs.test.ts test/ffmpeg/audioRelay.test.ts
git commit -m "$(cat <<'EOF'
feat: AudioRelay — decode-only per-track raw PCM relay

Second piece of the persistent-canvas architecture. Replaces the
audio-producing half of SegmentFeeder: instead of encoding a whole
track to a container, this only decodes it to raw PCM and relays it
into the persistent encoder's audio pipe, reusing the exact
kill-outgoing-before-spawning-next discipline SegmentFeeder already
had. Raw PCM has no container of its own, so there's nothing here
that could develop a continuity-counter/bitstream-filter
discontinuity at a switch.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01J9KpK2UY7XGtFAxYJPFkzP
EOF
)"
```

---

## Task 4: `PersistentEncoder` — the one long-lived process per destination

**Files:**
- Create: `src/ffmpeg/persistentEncoderArgs.ts`
- Create: `src/ffmpeg/persistentEncoder.ts`
- Test: `test/ffmpeg/persistentEncoderArgs.test.ts`
- Test: `test/ffmpeg/persistentEncoder.test.ts`

**Interfaces:**
- Produces: `buildPersistentEncoderArgs(params: { width: number; height: number; fps: number;
  heartbeatFps: number; rtmpUrl: string; streamKey: string }): string[]`.
- Produces: `new PersistentEncoder({ spawner: PipeSpawner, width, height, fps, heartbeatFps,
  rtmpUrl, streamKey })`, `.start(onExit: (code: number | null) => void): ChildProcessWithPipes`,
  `.stop(): void` — consumed by `StreamController` (Task 6), which reads `.videoPipe`/
  `.audioPipe` off the returned child to `attach()` `CanvasFeeder`/`AudioRelay` to them.

- [ ] **Step 1: Write the args-builder test**

Create `test/ffmpeg/persistentEncoderArgs.test.ts`:

```typescript
import { buildPersistentEncoderArgs } from '../../src/ffmpeg/persistentEncoderArgs';

describe('buildPersistentEncoderArgs', () => {
  it('reads raw video from pipe:3 and raw PCM audio from pipe:4, encodes and muxes to the rtmp url + stream key', () => {
    const args = buildPersistentEncoderArgs({
      width: 1280, height: 720, fps: 30, heartbeatFps: 5,
      rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2', streamKey: 'abcd-1234',
    });

    expect(args).toEqual([
      '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', '1280x720', '-r', '5', '-i', 'pipe:3',
      '-re', '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:4',
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', '30', '-g', '60',
      '-c:a', 'aac', '-b:a', '192k',
      '-f', 'flv', 'rtmp://a.rtmp.youtube.com/live2/abcd-1234',
    ]);
  });

  it('-re is on the audio input only, not the video input (video timing is governed by the caller\'s own heartbeat)', () => {
    const args = buildPersistentEncoderArgs({
      width: 1280, height: 720, fps: 30, heartbeatFps: 5, rtmpUrl: 'rtmp://x', streamKey: 'k',
    });

    const reIndex = args.indexOf('-re');
    const pipe4Index = args.indexOf('pipe:4');
    const pipe3Index = args.indexOf('pipe:3');
    expect(reIndex).toBeGreaterThan(pipe3Index);
    expect(reIndex).toBeLessThan(pipe4Index);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test -- test/ffmpeg/persistentEncoderArgs.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Create `src/ffmpeg/persistentEncoderArgs.ts`**

```typescript
export function buildPersistentEncoderArgs(params: {
  width: number;
  height: number;
  fps: number;
  // The rate CanvasFeeder actually writes new/resent frames at (its heartbeat interval) — this
  // must match CanvasFeeder's real wall-clock write cadence exactly, or ffmpeg's synthesized PTS
  // (frame count / this declared rate) drifts from real elapsed time. See CanvasFeeder.
  heartbeatFps: number;
  rtmpUrl: string;
  streamKey: string;
}): string[] {
  const { width, height, fps, heartbeatFps, rtmpUrl, streamKey } = params;
  return [
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${width}x${height}`, '-r', String(heartbeatFps), '-i', 'pipe:3',
    // -re paces audio consumption to real time, which backpressures AudioRelay's decode-only
    // process through the pipe's bounded OS buffer — the same relationship -re/RtmpPusher used to
    // have with the whole FIFO, just narrowed to the audio leg specifically now that video timing
    // is independently governed by CanvasFeeder's own heartbeat.
    '-re', '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:4',
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', String(fps), '-g', String(fps * 2),
    '-c:a', 'aac', '-b:a', '192k',
    '-f', 'flv', `${rtmpUrl}/${streamKey}`,
  ];
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npm test -- test/ffmpeg/persistentEncoderArgs.test.ts`
Expected: PASS

- [ ] **Step 5: Write the `PersistentEncoder` class test**

Create `test/ffmpeg/persistentEncoder.test.ts`:

```typescript
import { PersistentEncoder } from '../../src/ffmpeg/persistentEncoder';
import { PipeSpawner, ChildProcessWithPipes } from '../../src/ffmpeg/types';
import { PassThrough } from 'stream';

function fakeChild(): ChildProcessWithPipes & { emitExit: (code: number | null) => void } {
  let exitListener: ((code: number | null) => void) | null = null;
  return {
    pid: 1,
    stdout: null,
    stderr: null,
    videoPipe: new PassThrough(),
    audioPipe: new PassThrough(),
    kill: jest.fn(),
    once: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'exit') exitListener = listener as (code: number | null) => void;
    }),
    emitExit: (code) => exitListener && exitListener(code),
  };
}

function buildEncoder(spawner: PipeSpawner) {
  return new PersistentEncoder({
    spawner, width: 1280, height: 720, fps: 30, heartbeatFps: 5,
    rtmpUrl: 'rtmp://x', streamKey: 'k',
  });
}

describe('PersistentEncoder', () => {
  it('starts ffmpeg with the persistent encoder args and returns the child (with its video/audio pipes)', () => {
    const child = fakeChild();
    const spawner: PipeSpawner = jest.fn().mockReturnValue(child);
    const encoder = buildEncoder(spawner);

    const returned = encoder.start(() => {});

    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-i', 'pipe:3', '-i', 'pipe:4']));
    expect(returned).toBe(child);
    expect(returned.videoPipe).toBeDefined();
    expect(returned.audioPipe).toBeDefined();
  });

  it('invokes onExit when the process exits unexpectedly', () => {
    const child = fakeChild();
    const spawner: PipeSpawner = jest.fn().mockReturnValue(child);
    const encoder = buildEncoder(spawner);
    const onExit = jest.fn();

    encoder.start(onExit);
    child.emitExit(1);

    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('stop kills the running process', () => {
    const child = fakeChild();
    const spawner: PipeSpawner = jest.fn().mockReturnValue(child);
    const encoder = buildEncoder(spawner);

    encoder.start(() => {});
    encoder.stop();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not invoke onExit for the exit that follows an intentional stop', () => {
    const child = fakeChild();
    const spawner: PipeSpawner = jest.fn().mockReturnValue(child);
    const encoder = buildEncoder(spawner);
    const onExit = jest.fn();

    encoder.start(onExit);
    encoder.stop();
    child.emitExit(null);

    expect(onExit).not.toHaveBeenCalled();
  });

  it('reports unexpected exits again after a stop/start cycle', () => {
    const child = fakeChild();
    const spawner: PipeSpawner = jest.fn().mockReturnValue(child);
    const encoder = buildEncoder(spawner);
    const onExit = jest.fn();

    encoder.start(() => {});
    encoder.stop();
    encoder.start(onExit);
    child.emitExit(1);

    expect(onExit).toHaveBeenCalledWith(1);
  });
});
```

- [ ] **Step 6: Run it, verify it fails**

Run: `npm test -- test/ffmpeg/persistentEncoder.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 7: Create `src/ffmpeg/persistentEncoder.ts`**

```typescript
import { PipeSpawner, ChildProcessWithPipes } from './types';
import { buildPersistentEncoderArgs } from './persistentEncoderArgs';

export interface PersistentEncoderParams {
  spawner: PipeSpawner;
  width: number;
  height: number;
  fps: number;
  heartbeatFps: number;
  rtmpUrl: string;
  streamKey: string;
}

// Spawned once in StreamController.start() and never restarted for the life of the session —
// this is the actual fix: there is no per-track/per-segment process for a continuity counter or
// bitstream filter to lose sync at any more. See the Stage 2 design doc.
export class PersistentEncoder {
  private process: ChildProcessWithPipes | null = null;
  private stopRequested = false;

  constructor(private readonly params: PersistentEncoderParams) {}

  start(onExit: (code: number | null) => void): ChildProcessWithPipes {
    this.stopRequested = false;
    const args = buildPersistentEncoderArgs(this.params);
    const child = this.params.spawner('ffmpeg', args);
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

- [ ] **Step 8: Run it, verify it passes**

Run: `npm test -- test/ffmpeg/persistentEncoder.test.ts test/ffmpeg/persistentEncoderArgs.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/ffmpeg/persistentEncoderArgs.ts src/ffmpeg/persistentEncoder.ts test/ffmpeg/persistentEncoderArgs.test.ts test/ffmpeg/persistentEncoder.test.ts
git commit -m "$(cat <<'EOF'
feat: PersistentEncoder — the one long-lived process per destination

Third piece of the persistent-canvas architecture, replacing
RtmpPusher/rtmpPusherArgs.ts. Reads raw video (pipe:3) and raw PCM
audio (pipe:4) continuously and muxes+pushes to RTMP — spawned once
in StreamController.start(), never restarted for the life of the
session. start()/stop()/onExit lifecycle mirrors RtmpPusher's exactly;
only the input shape and the fact it never restarts are new.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01J9KpK2UY7XGtFAxYJPFkzP
EOF
)"
```

---

## Task 5: `CanvasFeeder` — one-shot renders on change, resent on a fixed heartbeat

**Files:**
- Create: `src/ffmpeg/canvasFeeder.ts`
- Test: `test/ffmpeg/canvasFeeder.test.ts`

**Interfaces:**
- Consumes: `buildCanvasFrameArgs` (Task 2), the existing plain `Spawner`.
- Produces: `new CanvasFeeder({ spawner, backgroundPath, overlayImagePath, fontFile, width,
  height, heartbeatMs, writeFileSync? })`, `.attach(videoPipe: NodeJS.WritableStream): void`,
  `.render(overlay: NowPlayingOverlay, timerText: string | null): Promise<void>`, `.close():
  void` — consumed by `StreamController` (Task 6).

- [ ] **Step 1: Write the test file**

Create `test/ffmpeg/canvasFeeder.test.ts`:

```typescript
import { PassThrough, Writable } from 'stream';
import { CanvasFeeder } from '../../src/ffmpeg/canvasFeeder';
import { Spawner, ChildProcessLike } from '../../src/ffmpeg/types';
import { NowPlayingOverlay } from '../../src/ffmpeg/segmentArgs';

type FakeChild = ChildProcessLike & { stdout: PassThrough; emitClose: (code: number | null) => void };

// Exposes an explicit emitClose() the test calls itself, synchronously, instead of scheduling
// the fake completion via process.nextTick/setTimeout — this keeps the test correct whether or
// not jest.useFakeTimers() is active (some fake-timer configurations also intercept
// process.nextTick, which silently hangs a test relying on it to eventually fire on its own).
function fakeChild(outputChunks: string[] = ['fake-frame-bytes']): FakeChild {
  const stdout = new PassThrough();
  let closeListener: ((code: number | null) => void) | null = null;
  return {
    pid: 1,
    stdout,
    stderr: null,
    kill: jest.fn(),
    once: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'close') closeListener = listener as (code: number | null) => void;
    }),
    emitClose: (code = 0) => {
      for (const chunk of outputChunks) stdout.write(chunk);
      stdout.end();
      closeListener?.(code);
    },
  };
}

const overlay: NowPlayingOverlay = { durationSeconds: 65, overlayPng: Buffer.from('fake-png-bytes'), timer: null };
const overlayWithTimer: NowPlayingOverlay = {
  durationSeconds: 65,
  overlayPng: Buffer.from('fake-png-bytes'),
  timer: { x: 10, y: 660, fontSize: 20, color: '#ffffff' },
};

function buildFeeder(overrides: Partial<{ spawner: Spawner; writeFileSync: jest.Mock; heartbeatMs: number }> = {}) {
  const writeFileSync = overrides.writeFileSync ?? jest.fn();
  const feeder = new CanvasFeeder({
    spawner: overrides.spawner ?? (jest.fn().mockReturnValue(fakeChild()) as Spawner),
    backgroundPath: '/assets/background.png',
    overlayImagePath: '/tmp/overlay-dest-1.png',
    fontFile: '/fonts/DejaVuSans-Bold.ttf',
    width: 1280,
    height: 720,
    heartbeatMs: overrides.heartbeatMs ?? 200,
    writeFileSync,
  });
  return { feeder, writeFileSync };
}

// render()'s synchronous portion (spawn + attach listeners) runs to completion before it hits
// its first real await, so the fake child is ready to have its close event emitted immediately
// after calling render() and before awaiting the promise it returned.
async function renderAndClose(feeder: CanvasFeeder, child: FakeChild, overlay: NowPlayingOverlay, timerText: string | null): Promise<void> {
  const promise = feeder.render(overlay, timerText);
  child.emitClose(0);
  await promise;
}

describe('CanvasFeeder', () => {
  it('render() writes the overlay PNG to the fixed path, spawns a one-shot canvas-frame render, and writes the resulting bytes to the attached video pipe', async () => {
    const child = fakeChild(['frame-one']);
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const { feeder, writeFileSync } = buildFeeder({ spawner });
    const chunks: Buffer[] = [];
    const videoPipe = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
    feeder.attach(videoPipe);

    await renderAndClose(feeder, child, overlay, null);

    expect(writeFileSync).toHaveBeenCalledWith('/tmp/overlay-dest-1.png', overlay.overlayPng);
    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-i', '/tmp/overlay-dest-1.png']));
    expect(Buffer.concat(chunks).toString()).toBe('frame-one');
  });

  it('render() with a timer element passes the given plain text through as a static drawtext, not a live pts expression', async () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const { feeder } = buildFeeder({ spawner });
    feeder.attach(new PassThrough());

    await renderAndClose(feeder, child, overlayWithTimer, '0:37 / 1:05');

    const args = (spawner as jest.Mock).mock.calls[0][1] as string[];
    const filterComplex = args[args.indexOf('-filter_complex') + 1];
    expect(filterComplex).toContain("text='0:37 / 1:05'");
    expect(filterComplex).not.toContain('%{pts');
  });

  it('render() with a timer element but null timerText omits the drawtext (used when the caller has no live/frozen text yet)', async () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const { feeder } = buildFeeder({ spawner });
    feeder.attach(new PassThrough());

    await renderAndClose(feeder, child, overlayWithTimer, null);

    const args = (spawner as jest.Mock).mock.calls[0][1] as string[];
    const filterComplex = args[args.indexOf('-filter_complex') + 1];
    expect(filterComplex).not.toContain('drawtext');
  });

  it('attach() starts a heartbeat that resends the last rendered frame at the configured interval', async () => {
    jest.useFakeTimers();
    try {
      const child = fakeChild(['frame-a']);
      const spawner: Spawner = jest.fn().mockReturnValue(child);
      const { feeder } = buildFeeder({ spawner, heartbeatMs: 200 });
      const chunks: Buffer[] = [];
      const videoPipe = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
      feeder.attach(videoPipe);

      await renderAndClose(feeder, child, overlay, null);
      chunks.length = 0; // clear the initial render's own write, isolate the heartbeat's writes

      jest.advanceTimersByTime(600); // 3 heartbeat ticks at 200ms

      expect(chunks.length).toBe(3);
      expect(chunks.every((c) => c.toString() === 'frame-a')).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('the heartbeat writes nothing before the first render() call resolves', () => {
    jest.useFakeTimers();
    try {
      const { feeder } = buildFeeder();
      const chunks: Buffer[] = [];
      const videoPipe = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
      feeder.attach(videoPipe);

      jest.advanceTimersByTime(1000);

      expect(chunks.length).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('close() stops the heartbeat and removes the overlay image file', () => {
    const unlinkSync = jest.spyOn(require('fs'), 'unlinkSync').mockImplementation(() => {});
    const { feeder } = buildFeeder();
    feeder.attach(new PassThrough());

    feeder.close();

    expect(unlinkSync).toHaveBeenCalledWith('/tmp/overlay-dest-1.png');
    unlinkSync.mockRestore();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test -- test/ffmpeg/canvasFeeder.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Create `src/ffmpeg/canvasFeeder.ts`**

```typescript
import * as fs from 'fs';
import { Spawner } from './types';
import { buildCanvasFrameArgs, NowPlayingOverlay, TimerOverlay } from './segmentArgs';

export interface CanvasFeederOptions {
  spawner: Spawner;
  backgroundPath: string;
  // Fixed on-disk path this feeder writes the current overlay PNG to before every render — same
  // pattern SegmentFeeder always used, just now feeding a one-shot render instead of a continuous
  // encode.
  overlayImagePath: string;
  fontFile: string;
  width: number;
  height: number;
  // How often the last-rendered frame is resent to the video pipe, regardless of whether content
  // changed — this fixed cadence is what keeps the persistent encoder's declared input framerate
  // (see persistentEncoderArgs.ts's heartbeatFps) matching real wall-clock time. Re-rendering
  // (spawning a new one-shot ffmpeg) only happens on an actual call to render(); the heartbeat
  // itself never re-renders, only resends the existing buffer.
  heartbeatMs: number;
  writeFileSync?: (path: string, data: Buffer) => void;
}

export class CanvasFeeder {
  private readonly writeFileSync: (path: string, data: Buffer) => void;
  private cachedFrame: Buffer | null = null;
  private videoPipe: NodeJS.WritableStream | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: CanvasFeederOptions) {
    this.writeFileSync = options.writeFileSync ?? fs.writeFileSync;
  }

  /** Called once, right after the persistent encoder starts — see StreamController.start(). */
  attach(videoPipe: NodeJS.WritableStream): void {
    this.videoPipe = videoPipe;
    this.heartbeatTimer = setInterval(() => {
      if (this.cachedFrame) this.videoPipe!.write(this.cachedFrame);
    }, this.options.heartbeatMs);
  }

  /**
   * Renders one new frame and writes it immediately. `timerText` is always a plain, already-
   * formatted string (or null for "no timer element on this template") — there's no live
   * pts-expression any more, since there's no continuous per-track encode process for one to run
   * against. The caller (StreamController) computes the right string for both the live-ticking
   * case (elapsed time, called once a second) and the frozen-on-pause case (same code path).
   */
  async render(overlay: NowPlayingOverlay, timerText: string | null): Promise<void> {
    this.writeFileSync(this.options.overlayImagePath, overlay.overlayPng);

    const timer: TimerOverlay | null = overlay.timer && timerText !== null
      ? { ...overlay.timer, text: timerText }
      : null;

    const args = buildCanvasFrameArgs({
      backgroundPath: this.options.backgroundPath,
      overlayPngPath: this.options.overlayImagePath,
      fontFile: this.options.fontFile,
      timer,
      width: this.options.width,
      height: this.options.height,
    });

    this.cachedFrame = await this.runOneShot(args);
    this.videoPipe?.write(this.cachedFrame);
  }

  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    try {
      fs.unlinkSync(this.options.overlayImagePath);
    } catch {
      // Never written, or already gone — either way there's nothing left to clean up.
    }
  }

  private runOneShot(args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = this.options.spawner('ffmpeg', args);
      const chunks: Buffer[] = [];
      child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.once('close', (code: unknown) => {
        if (code === 0 || code === null) resolve(Buffer.concat(chunks));
        else reject(new Error(`canvas frame render failed with exit code ${String(code)}`));
      });
    });
  }
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npm test -- test/ffmpeg/canvasFeeder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ffmpeg/canvasFeeder.ts test/ffmpeg/canvasFeeder.test.ts
git commit -m "$(cat <<'EOF'
feat: CanvasFeeder — one-shot renders on change, resent on a fixed heartbeat

Fourth piece of the persistent-canvas architecture, replacing the
video-producing half of SegmentFeeder. Re-renders (a fresh one-shot
ffmpeg spawn) only on an actual content change; a fixed-interval
heartbeat resends the last rendered buffer the rest of the time, so
the persistent encoder's declared input framerate genuinely matches
CanvasFeeder's real wall-clock write cadence -- this is the fix for
the video-timeline-drift gap the design spec's self-review caught.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01J9KpK2UY7XGtFAxYJPFkzP
EOF
)"
```

---

## Task 6: `StreamController` — coordinate `CanvasFeeder` + `AudioRelay` + `PersistentEncoder`

**Files:**
- Modify: `src/stream/streamController.ts`
- Modify: `test/stream/streamController.test.ts`

**Interfaces:**
- Consumes: `CanvasFeeder`/`AudioRelay`/`PersistentEncoder` (Tasks 3-5).
- Produces: `StreamControllerDeps { library: LibraryLike; queue: PlaylistQueue; createCanvasFeeder:
  () => CanvasFeeder; createAudioRelay: () => AudioRelay; createPersistentEncoder: () =>
  PersistentEncoder; buildOverlay: (track: Track) => Promise<NowPlayingOverlay>; onError?: () =>
  void; onStatusChanged?: () => void }`.
- `StreamController`'s **public** method signatures are unchanged: `start(): Promise<void>`,
  `stop(): void`, `pause(): void`, `resume(): Promise<void>`, `next(): Promise<void>`,
  `previous(): Promise<void>`, `playByName(name: string): void`, `status(): StreamStatus` — no
  route/caller anywhere else needs to change.

This is the task with the most judgment in this plan — it's a real restructuring, not a mechanical
signature change like Tasks 1-5. Read the *current* `src/stream/streamController.ts` (restored to
its pre-Stage-2 shape by Task 0) before starting, to see exactly what today's
`segmentGeneration`/`pausedElapsedSeconds`/error-recovery logic looks like — this task preserves
all of that behavior, just retargets it at the three new collaborators instead of
`SegmentFeeder`/`RtmpPusher`.

- [ ] **Step 1: Replace the test file**

Replace `test/stream/streamController.test.ts` entirely with:

```typescript
import { StreamController } from '../../src/stream/streamController';
import { ApiError } from '../../src/errors';
import { Track } from '../../src/playlist/types';

const track = (name: string): Track => ({ name, audioPath: `/music/${name}.mp3`, coverPath: null });
const overlayFor = (t: Track) => ({ title: t.name, playlistLines: [`▶ ${t.name}`], durationSeconds: 100, overlayPng: Buffer.from('png'), timer: null });

type FakeChild = { pid: number; stdout: null; stderr: null; kill: jest.Mock; once: jest.Mock; emitClose: (code?: number | null) => void };

function fakeChild(): FakeChild {
  let closeListener: ((code: number | null) => void) | null = null;
  return {
    pid: 1, stdout: null, stderr: null, kill: jest.fn(),
    once: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'close') closeListener = listener as (code: number | null) => void;
    }),
    emitClose: (code = 0) => closeListener && closeListener(code),
  };
}

function buildDeps() {
  const tracks = [track('a'), track('b')];
  const library = {
    list: jest.fn().mockReturnValue(tracks),
    findByName: jest.fn((name: string) => tracks.find((t) => t.name === name)),
  };
  const queue = {
    current: jest.fn().mockReturnValue(tracks[0]),
    next: jest.fn().mockReturnValue(tracks[1]),
    previous: jest.fn().mockReturnValue(tracks[0]),
    insertNext: jest.fn(),
    peekNext: jest.fn().mockReturnValue(tracks[1]),
  };
  const children: FakeChild[] = [];
  const audioRelay = {
    attach: jest.fn(),
    switchTrack: jest.fn(() => {
      const child = fakeChild();
      children.push(child);
      return child;
    }),
    switchToSilence: jest.fn(() => fakeChild()),
    stopCurrent: jest.fn(),
    close: jest.fn(),
  };
  const canvasFeeder = { attach: jest.fn(), render: jest.fn().mockResolvedValue(undefined), close: jest.fn() };
  const encoderChild = { videoPipe: {}, audioPipe: {} };
  const encoder = { start: jest.fn().mockReturnValue(encoderChild), stop: jest.fn() };
  const deps: any = {
    library, queue,
    createCanvasFeeder: jest.fn().mockReturnValue(canvasFeeder),
    createAudioRelay: jest.fn().mockReturnValue(audioRelay),
    createPersistentEncoder: jest.fn().mockReturnValue(encoder),
    buildOverlay: jest.fn((t: Track) => Promise.resolve(overlayFor(t))),
  };
  return { deps, library, queue, canvasFeeder, audioRelay, encoder, encoderChild, children };
}

describe('StreamController', () => {
  it('start() creates the persistent encoder, attaches the canvas feeder and audio relay to its pipes, and feeds the current track', async () => {
    const { deps, encoder, encoderChild, canvasFeeder, audioRelay } = buildDeps();
    const controller = new StreamController(deps);

    await controller.start();

    expect(encoder.start).toHaveBeenCalled();
    expect(canvasFeeder.attach).toHaveBeenCalledWith(encoderChild.videoPipe);
    expect(audioRelay.attach).toHaveBeenCalledWith(encoderChild.audioPipe);
    expect(audioRelay.switchTrack).toHaveBeenCalledWith('/music/a.mp3', 0);
    // overlayFor()'s tracks have no timer element, so timerText() is null, not a formatted
    // string — see the timer-specific tests further down for the non-null case.
    expect(canvasFeeder.render).toHaveBeenCalledWith(overlayFor(track('a')), null);
    expect(controller.status().state).toBe('streaming');
  });

  it('start() throws 409 when already streaming', async () => {
    const { deps } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();
    await expect(controller.start()).rejects.toThrow(ApiError);
  });

  it('start() throws 409 when the library is empty', async () => {
    const { deps } = buildDeps();
    deps.library.list.mockReturnValue([]);
    const controller = new StreamController(deps);
    await expect(controller.start()).rejects.toThrow('library is empty');
  });

  it('start() flips state to streaming synchronously, before awaiting buildOverlay (regression: must not block the event loop on ffprobe)', async () => {
    const { deps, audioRelay } = buildDeps();
    let resolveOverlay!: (overlay: unknown) => void;
    deps.buildOverlay = jest.fn(() => new Promise((resolve) => { resolveOverlay = resolve; }));
    const controller = new StreamController(deps);

    const startPromise = controller.start();

    expect(controller.status().state).toBe('streaming');
    expect(audioRelay.switchTrack).not.toHaveBeenCalled();

    resolveOverlay(overlayFor(track('a')));
    await startPromise;

    expect(audioRelay.switchTrack).toHaveBeenCalled();
  });

  it('does not feed a track if the encoder dies while the overlay is still being probed', async () => {
    const { deps, audioRelay, encoder } = buildDeps();
    let resolveOverlay!: (overlay: unknown) => void;
    deps.buildOverlay = jest.fn(() => new Promise((resolve) => { resolveOverlay = resolve; }));
    const controller = new StreamController(deps);

    const startPromise = controller.start();
    const onExit = encoder.start.mock.calls[0][0] as (code: number | null) => void;
    onExit(1);

    resolveOverlay(overlayFor(track('a')));
    await startPromise;

    expect(audioRelay.switchTrack).not.toHaveBeenCalled();
    expect(controller.status().state).toBe('error');
  });

  it('invokes deps.onError when the encoder exits unexpectedly', async () => {
    const { deps, encoder } = buildDeps();
    const onError = jest.fn();
    deps.onError = onError;
    const controller = new StreamController(deps);
    await controller.start();

    const onExit = encoder.start.mock.calls[0][0] as (code: number | null) => void;
    onExit(1);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(controller.status().state).toBe('error');
  });

  it('pause() switches the audio relay to silence and renders a frozen timer text, then resume() seeks the audio relay back', async () => {
    const { deps, audioRelay, canvasFeeder } = buildDeps();
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000);
    const controller = new StreamController(deps);
    await controller.start();
    canvasFeeder.render.mockClear();

    nowSpy.mockReturnValue(1_000 + 12_345);
    controller.pause();

    expect(audioRelay.switchToSilence).toHaveBeenCalled();
    expect(canvasFeeder.render).toHaveBeenCalledWith(overlayFor(track('a')), null);
    expect(controller.status().state).toBe('paused');

    nowSpy.mockReturnValue(1_000 + 20_000);
    await controller.resume();

    expect(audioRelay.switchTrack).toHaveBeenLastCalledWith('/music/a.mp3', 12.345);
    expect(controller.status().state).toBe('streaming');

    nowSpy.mockRestore();
  });

  it('accumulates track-elapsed time across multiple pause/resume cycles, for a frozen timer to show while paused', async () => {
    const { deps, audioRelay } = buildDeps();
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(0);
    const controller = new StreamController(deps);
    await controller.start();

    nowSpy.mockReturnValue(5_000);
    controller.pause();

    nowSpy.mockReturnValue(8_000);
    await controller.resume();
    expect(audioRelay.switchTrack).toHaveBeenLastCalledWith('/music/a.mp3', 5);

    nowSpy.mockReturnValue(11_000);
    controller.pause();

    nowSpy.mockReturnValue(14_000);
    await controller.resume();
    expect(audioRelay.switchTrack).toHaveBeenLastCalledWith('/music/a.mp3', 8);

    nowSpy.mockRestore();
  });

  it('next() advances the queue, resets elapsed time and feeds the new track while streaming', async () => {
    const { deps, queue, audioRelay, canvasFeeder } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();

    await controller.next();

    expect(queue.next).toHaveBeenCalled();
    expect(audioRelay.switchTrack).toHaveBeenLastCalledWith('/music/b.mp3', 0);
    expect(canvasFeeder.render).toHaveBeenLastCalledWith(overlayFor(track('b')), null);
  });

  it('next() throws 409 when idle', async () => {
    const { deps } = buildDeps();
    const controller = new StreamController(deps);
    await expect(controller.next()).rejects.toThrow(ApiError);
  });

  it('playByName() inserts into the queue without switching immediately', async () => {
    const { deps, queue, audioRelay } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();
    audioRelay.switchTrack.mockClear();

    controller.playByName('b');

    expect(queue.insertNext).toHaveBeenCalledWith({ name: 'b', audioPath: '/music/b.mp3', coverPath: null });
    expect(audioRelay.switchTrack).not.toHaveBeenCalled();
  });

  it('playByName() throws 404 for an unknown track', () => {
    const { deps } = buildDeps();
    const controller = new StreamController(deps);
    expect(() => controller.playByName('missing')).toThrow(ApiError);
  });

  it('stop() tears down the audio relay, canvas feeder and encoder', async () => {
    const { deps, audioRelay, canvasFeeder, encoder } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();

    controller.stop();

    expect(audioRelay.close).toHaveBeenCalled();
    expect(canvasFeeder.close).toHaveBeenCalled();
    expect(encoder.stop).toHaveBeenCalled();
    expect(controller.status().state).toBe('idle');
  });

  it('auto-advances to the next track when the current decode process closes naturally', async () => {
    const { deps, queue, audioRelay, children } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();

    expect(children).toHaveLength(1);
    children[0].emitClose(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(queue.next).toHaveBeenCalled();
    expect(audioRelay.switchTrack).toHaveBeenLastCalledWith('/music/b.mp3', 0);
    expect(controller.status().state).toBe('streaming');
  });

  it('does not double-advance when a superseded decode process closes late after next()', async () => {
    const { deps, queue, audioRelay, children } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();

    await controller.next();
    expect(queue.next).toHaveBeenCalledTimes(1);
    expect(audioRelay.switchTrack).toHaveBeenCalledTimes(2);

    children[0].emitClose(null);
    await Promise.resolve();
    await Promise.resolve();

    expect(queue.next).toHaveBeenCalledTimes(1);
    expect(audioRelay.switchTrack).toHaveBeenCalledTimes(2);
  });

  it('does not advance when a decode process closes after stop()', async () => {
    const { deps, queue, audioRelay, children } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();

    controller.stop();
    children[0].emitClose(null);
    await Promise.resolve();
    await Promise.resolve();

    expect(queue.next).not.toHaveBeenCalled();
    expect(audioRelay.switchTrack).toHaveBeenCalledTimes(1);
    expect(controller.status().state).toBe('idle');
  });

  it('start() recovers from the error state instead of rejecting with 409', async () => {
    const { deps, encoder } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();

    const onExit = encoder.start.mock.calls[0][0] as (code: number | null) => void;
    onExit(1);
    expect(controller.status().state).toBe('error');

    await controller.start();

    expect(controller.status().state).toBe('streaming');
  });

  it('supports a full start() -> stop() -> start() cycle without getting stuck in error', async () => {
    const { deps, encoder } = buildDeps();
    const controller = new StreamController(deps);

    await controller.start();
    controller.stop();
    await controller.start();

    expect(controller.status().state).toBe('streaming');
    expect(encoder.start).toHaveBeenCalledTimes(2);
  });

  it('invokes deps.onStatusChanged after start(), pause(), resume(), next(), previous(), playByName(), and stop()', async () => {
    const { deps } = buildDeps();
    const onStatusChanged = jest.fn();
    deps.onStatusChanged = onStatusChanged;
    const controller = new StreamController(deps);

    await controller.start();
    expect(onStatusChanged).toHaveBeenCalledTimes(1);
    controller.pause();
    expect(onStatusChanged).toHaveBeenCalledTimes(2);
    await controller.resume();
    expect(onStatusChanged).toHaveBeenCalledTimes(3);
    await controller.next();
    expect(onStatusChanged).toHaveBeenCalledTimes(4);
    await controller.previous();
    expect(onStatusChanged).toHaveBeenCalledTimes(5);
    controller.playByName('a');
    expect(onStatusChanged).toHaveBeenCalledTimes(6);
    controller.stop();
    expect(onStatusChanged).toHaveBeenCalledTimes(7);
  });
});
```

Note what's *gone* relative to the pre-Stage-2 test file: the fifo path/`createFifo`/`removeFifo`
assertions (no more FIFOs at all — Task 0's restored `createFifo`/`removeFifo` deps are dropped
from `StreamControllerDeps` entirely in this task), and the `elapsedSessionSeconds`-style trailing
argument on feed calls (never existed in the pre-Stage-2 `SegmentFeeder.feedTrack` signature to
begin with, so nothing to remove there — the pre-Stage-2 `feedTrack` already took just
`(track, overlay, startOffsetSeconds)`, matching this task's `audioRelay.switchTrack(audioPath,
startOffsetSeconds)` shape).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/stream/streamController.test.ts`
Expected: FAIL — `StreamController` still has the pre-Stage-2 `SegmentFeeder`/`RtmpPusher`/fifo
shape.

- [ ] **Step 3: Rewrite `src/stream/streamController.ts`**

```typescript
import { PlaylistQueue } from '../playlist/queue';
import { Track } from '../playlist/types';
import { CanvasFeeder } from '../ffmpeg/canvasFeeder';
import { AudioRelay } from '../ffmpeg/audioRelay';
import { PersistentEncoder } from '../ffmpeg/persistentEncoder';
import { NowPlayingOverlay } from '../ffmpeg/segmentArgs';
import { formatDurationForDrawtext } from '../ffmpeg/overlayText';
import { ApiError } from '../errors';
import { SessionState, StreamStatus } from './types';

export interface LibraryLike {
  list(): Track[];
  findByName(name: string): Track | undefined;
}

export interface StreamControllerDeps {
  library: LibraryLike;
  queue: PlaylistQueue;
  createCanvasFeeder: () => CanvasFeeder;
  createAudioRelay: () => AudioRelay;
  createPersistentEncoder: () => PersistentEncoder;
  buildOverlay: (track: Track) => Promise<NowPlayingOverlay>;
  onError?: () => void;
  onStatusChanged?: () => void;
}

export class StreamController {
  private state: SessionState = 'idle';
  private canvasFeeder: CanvasFeeder | null = null;
  private audioRelay: AudioRelay | null = null;
  private encoder: PersistentEncoder | null = null;
  private trackStartedAt: number | null = null;
  private pausedElapsedSeconds = 0;
  private currentOverlay: NowPlayingOverlay | null = null;
  private timerTicker: NodeJS.Timeout | null = null;
  // Distinguishes "this track ended naturally" (advance to the next one) from "this track was
  // superseded/torn down by next/previous/pause/stop/start" (do nothing) — same role
  // segmentGeneration always had, renamed because there's no more per-segment process for
  // "segment" to describe.
  private sessionGeneration = 0;

  constructor(private readonly deps: StreamControllerDeps) {}

  async start(): Promise<void> {
    if (this.state === 'streaming' || this.state === 'paused') {
      throw new ApiError(409, 'stream is already active');
    }
    if (this.deps.library.list().length === 0) throw new ApiError(409, 'library is empty');

    this.sessionGeneration += 1;
    this.teardown();

    this.encoder = this.deps.createPersistentEncoder();
    const child = this.encoder.start(() => {
      this.state = 'error';
      this.deps.onError?.();
      this.deps.onStatusChanged?.();
    });
    this.canvasFeeder = this.deps.createCanvasFeeder();
    this.canvasFeeder.attach(child.videoPipe);
    this.audioRelay = this.deps.createAudioRelay();
    this.audioRelay.attach(child.audioPipe);
    this.pausedElapsedSeconds = 0;
    this.trackStartedAt = null;

    this.state = 'streaming';

    const track = this.deps.queue.current();
    if (track) {
      await this.feedCurrentTrack(track);
    }
    this.deps.onStatusChanged?.();
  }

  stop(): void {
    if (this.state === 'idle') throw new ApiError(409, 'stream is not active');
    this.sessionGeneration += 1;
    this.teardown();
    this.state = 'idle';
    this.deps.onStatusChanged?.();
  }

  pause(): void {
    if (this.state !== 'streaming') throw new ApiError(409, 'stream is not currently streaming');
    if (this.trackStartedAt !== null) {
      this.pausedElapsedSeconds += (Date.now() - this.trackStartedAt) / 1000;
      this.trackStartedAt = null;
    }
    this.sessionGeneration += 1;
    this.state = 'paused';
    this.stopTimerTicker();
    this.audioRelay!.switchToSilence();
    if (this.currentOverlay) {
      this.canvasFeeder!.render(this.currentOverlay, this.timerText(this.pausedElapsedSeconds)).catch((err) => {
        console.error('failed to render the frozen pause frame', err);
      });
    }
    this.deps.onStatusChanged?.();
  }

  async resume(): Promise<void> {
    if (this.state !== 'paused') throw new ApiError(409, 'stream is not paused');
    this.state = 'streaming';
    const track = this.deps.queue.current();
    if (track) {
      await this.feedCurrentTrack(track, this.pausedElapsedSeconds);
    }
    this.deps.onStatusChanged?.();
  }

  async next(): Promise<void> {
    if (this.state === 'idle' || this.state === 'error') throw new ApiError(409, 'stream is not active');
    const track = this.deps.queue.next();
    if (!track) throw new ApiError(409, 'no tracks in queue');
    this.pausedElapsedSeconds = 0;
    if (this.state === 'streaming') {
      await this.feedCurrentTrack(track);
    }
    this.deps.onStatusChanged?.();
  }

  async previous(): Promise<void> {
    if (this.state === 'idle' || this.state === 'error') throw new ApiError(409, 'stream is not active');
    const track = this.deps.queue.previous();
    this.pausedElapsedSeconds = 0;
    if (track && this.state === 'streaming') {
      await this.feedCurrentTrack(track);
    }
    this.deps.onStatusChanged?.();
  }

  private async feedCurrentTrack(track: Track, startOffsetSeconds = 0): Promise<void> {
    const generation = ++this.sessionGeneration;
    const overlay = await this.deps.buildOverlay(track);
    // The generation may have advanced, or the session may have left 'streaming', while we were
    // awaiting the overlay — a stale overlay must never be fed.
    if (generation !== this.sessionGeneration) return;
    if (this.state !== 'streaming') return;

    this.currentOverlay = overlay;
    this.trackStartedAt = Date.now();
    const child = this.audioRelay!.switchTrack(track.audioPath, startOffsetSeconds);
    await this.canvasFeeder!.render(overlay, this.timerText(startOffsetSeconds));
    this.startTimerTicker();

    // 'close' — the decode-only process reaches this on its own once the track file ends, same
    // auto-advance signal SegmentFeeder's encode process used to provide.
    child.once('close', () => {
      if (generation !== this.sessionGeneration) return;
      if (this.state !== 'streaming') return;
      this.advanceToNextTrack();
    });
  }

  private startTimerTicker(): void {
    this.stopTimerTicker();
    if (!this.currentOverlay?.timer) return;
    this.timerTicker = setInterval(() => {
      if (this.state !== 'streaming' || !this.currentOverlay) return;
      this.canvasFeeder!.render(this.currentOverlay, this.timerText(this.elapsedTrackSeconds())).catch((err) => {
        console.error('failed to render the ticking timer frame', err);
      });
    }, 1000);
  }

  private stopTimerTicker(): void {
    if (this.timerTicker) {
      clearInterval(this.timerTicker);
      this.timerTicker = null;
    }
  }

  private elapsedTrackSeconds(): number {
    return this.trackStartedAt !== null ? (Date.now() - this.trackStartedAt) / 1000 : 0;
  }

  private timerText(elapsedSeconds: number): string | null {
    if (!this.currentOverlay?.timer) return null;
    return `${formatDurationForDrawtext(elapsedSeconds)} / ${formatDurationForDrawtext(this.currentOverlay.durationSeconds)}`;
  }

  private advanceToNextTrack(): void {
    const track = this.deps.queue.next();
    this.deps.onStatusChanged?.();
    this.pausedElapsedSeconds = 0;
    if (track) {
      this.feedCurrentTrack(track).catch((err) => {
        console.error('failed to auto-advance to the next track', err);
      });
    }
  }

  private teardown(): void {
    this.stopTimerTicker();
    this.audioRelay?.close();
    this.canvasFeeder?.close();
    this.encoder?.stop();
    this.audioRelay = null;
    this.canvasFeeder = null;
    this.encoder = null;
    this.trackStartedAt = null;
    this.pausedElapsedSeconds = 0;
    this.currentOverlay = null;
  }

  playByName(name: string): void {
    const track = this.deps.library.findByName(name);
    if (!track) throw new ApiError(404, `track not found: ${name}`);
    this.deps.queue.insertNext(track);
    this.deps.onStatusChanged?.();
  }

  status(): StreamStatus {
    return {
      state: this.state,
      currentTrack: this.deps.queue.current()?.name ?? null,
      nextTrack: this.deps.queue.peekNext()?.name ?? null,
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/stream/streamController.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/stream/streamController.ts test/stream/streamController.test.ts
git commit -m "$(cat <<'EOF'
refactor: StreamController drives CanvasFeeder + AudioRelay + PersistentEncoder

Fifth piece of the persistent-canvas architecture. Public API
(start/stop/pause/resume/next/previous/playByName/status) is
unchanged -- every route and caller is unaffected. Internally, a
track switch is now "tell AudioRelay to switch decoders + tell
CanvasFeeder to re-render" instead of spawning one big per-segment
process; the timer no longer needs a live pts expression at all, since
CanvasFeeder re-renders with a plain Node-computed elapsed-time string
on every tick, the same code path whether streaming or paused.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01J9KpK2UY7XGtFAxYJPFkzP
EOF
)"
```

---

## Task 7: `StreamManager` — wire the new trio, drop FIFO path construction

**Files:**
- Modify: `src/stream/streamManager.ts`
- Modify: `test/stream/streamManager.test.ts`

**Interfaces:**
- Consumes: `CanvasFeeder`/`AudioRelay`/`PersistentEncoder` (Tasks 3-5),
  `StreamControllerDeps` (Task 6), `PipeSpawner` (Task 1).
- Produces: `StreamManagerDeps` gains `pipeSpawner: PipeSpawner`, drops the FIFO-path-only
  responsibility from `start()` (the `overlayImagePath` scratch-file construction stays, still
  under `this.deps.fifoDir` — see Global Constraints on why that field isn't renamed). No public
  method on `StreamManager` itself changes shape.

- [ ] **Step 1: Read the current `src/stream/streamManager.ts` and `test/stream/streamManager.test.ts`**

Task 0 restored these to their pre-Stage-2 content. Read both before editing — this task's exact
`old_string`/`new_string` edits below are written against that restored baseline; if any
`old_string` doesn't match verbatim, stop and report NEEDS_CONTEXT with what you find instead.

- [ ] **Step 2: Update `test/stream/streamManager.test.ts`**

1. Update the imports at the top: remove any import of `SegmentFeeder`/`RtmpPusher` fakes/mocks
   specific to the old shape (check what's actually imported — the pre-Stage-2 file mocks
   `../../src/ffmpeg/fifo` via `jest.mock`; that mock is no longer needed since `StreamManager` no
   longer imports `fifo.ts` — remove the `jest.mock('../../src/ffmpeg/fifo', ...)` block entirely).
2. In `buildDeps()`, add a fake `pipeSpawner` alongside the existing `spawner`:
   ```typescript
   const pipeSpawner = jest.fn().mockReturnValue({
     ...fakeChild(),
     videoPipe: new PassThrough(),
     audioPipe: new PassThrough(),
   });
   ```
   (add `pipeSpawner` to both the returned `deps` object and the outer returned object, matching
   how `spawner` is already threaded through). If `PassThrough` isn't already imported from
   `'stream'` in this file, add the import.
3. Remove the `createWriteStream` fake and its plumbing if still present after Task 0's revert
   (Task 0 restores the pre-Stage-2 file, which — per this session's earlier history — still had
   `createWriteStream` as a real seam; check the restored file and remove it here if so, since
   `CanvasFeeder`/`AudioRelay` don't take one).
4. Every other test in the file (404/403/409 checks, provider selection, template
   resolution/fallback, overlay cache wiring, lifecycle finalize-on-error/stop/restart) stays as-is
   — none of it touches fifo paths or feeder/pusher construction directly.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- test/stream/streamManager.test.ts`
Expected: FAIL — `StreamManager` still constructs the pre-Stage-2 `SegmentFeeder`/`RtmpPusher`/fifo
shape and doesn't accept `pipeSpawner`.

- [ ] **Step 4: Update `src/stream/streamManager.ts`**

1. Add imports: `CanvasFeeder` from `'../ffmpeg/canvasFeeder'`, `AudioRelay` from
   `'../ffmpeg/audioRelay'`, `PersistentEncoder` from `'../ffmpeg/persistentEncoder'`,
   `PipeSpawner` from `'../ffmpeg/types'` (alongside the existing `Spawner` import from that same
   module — extend the existing import line). Remove the `createFifo`/`removeFifo` import from
   `'../ffmpeg/fifo'` and the `SegmentFeeder`/`RtmpPusher` imports.
2. Add `pipeSpawner: PipeSpawner;` to `StreamManagerDeps`, alongside the existing `spawner:
   Spawner;` field.
3. In `start()`, replace the `fifoPath`/`createFifo`/`removeFifo` construction (the pre-Stage-2
   `const fifoPath = path.join(...)` line and its use in the `StreamController` construction)
   entirely — the `overlayImagePath` line stays (`CanvasFeeder` still needs it), just drop
   `fifoPath` and the two fifo-lifecycle functions from what's passed into `StreamController`.
4. Replace the `StreamController` construction's feeder/pusher fields:
   ```typescript
       createCanvasFeeder: () => new CanvasFeeder({
         spawner: this.deps.spawner,
         backgroundPath: this.deps.backgroundImagePath,
         overlayImagePath,
         fontFile: this.deps.fontFile,
         width: VIDEO_WIDTH,
         height: VIDEO_HEIGHT,
         heartbeatMs: CANVAS_HEARTBEAT_MS,
       }),
       createAudioRelay: () => new AudioRelay({ spawner: this.deps.spawner }),
       createPersistentEncoder: () => new PersistentEncoder({
         spawner: this.deps.pipeSpawner,
         width: VIDEO_WIDTH,
         height: VIDEO_HEIGHT,
         fps: VIDEO_FPS,
         heartbeatFps: CANVAS_HEARTBEAT_FPS,
         rtmpUrl: session.rtmpUrl,
         streamKey: session.streamKey,
       }),
   ```
   in place of the old `fifoPath`/`createFifo`/`removeFifo`/`createSegmentFeeder`/
   `createRtmpPusher` fields (`library`, `queue`, `buildOverlay`, `onError`, `onStatusChanged`
   stay exactly as they are).
5. Add the two new constants near the existing `VIDEO_WIDTH`/`VIDEO_HEIGHT`/`VIDEO_FPS`
   constants:
   ```typescript
   // How often CanvasFeeder resends its last-rendered frame — see canvasFeeder.ts and
   // persistentEncoderArgs.ts's heartbeatFps for why these two must always match.
   const CANVAS_HEARTBEAT_MS = 200;
   const CANVAS_HEARTBEAT_FPS = 1000 / CANVAS_HEARTBEAT_MS;
   ```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- test/stream/streamManager.test.ts`
Expected: PASS

- [ ] **Step 6: Wire `pipeSpawner` into the real composition root**

In `src/server.ts`, find where `StreamManager` is constructed (`new StreamManager({ spawner, ...
})`) and add `pipeSpawner: createPipeSpawner(),` alongside the existing `spawner: createSpawner(),`
— or `spawner` field, whichever the actual current line reads (check before editing).

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS, every suite.

- [ ] **Step 8: Commit**

```bash
git add src/stream/streamManager.ts test/stream/streamManager.test.ts src/server.ts
git commit -m "$(cat <<'EOF'
refactor: StreamManager wires CanvasFeeder + AudioRelay + PersistentEncoder

Final wiring step of the persistent-canvas architecture. No more FIFO
path construction anywhere in the streaming pipeline -- createFifo/
removeFifo are no longer called by StreamManager at all (Task 8 checks
whether fifo.ts has any remaining caller and removes it if not).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01J9KpK2UY7XGtFAxYJPFkzP
EOF
)"
```

---

## Task 8: Remove whichever pre-Stage-2 files are now truly dead code

Task 0 revived `src/ffmpeg/segmentFeeder.ts`, `src/ffmpeg/rtmpPusher.ts`, and
`src/ffmpeg/rtmpPusherArgs.ts` (plus `src/ffmpeg/fifo.ts`, never touched by Task 0 but always
present) purely so the codebase kept compiling between Task 0 and the new architecture landing.
Once Task 7 lands, none of the streaming pipeline calls any of them any more — leaving them in the
repo unreferenced would misleadingly suggest `SegmentFeeder`/`RtmpPusher` are still part of the
live pipeline. Check each independently; not all four are guaranteed dead (e.g. if anything
outside the streaming pipeline ever imported one of them) — verify per-file, don't assume.

**Files:**
- Possibly delete: `src/ffmpeg/fifo.ts`, `src/ffmpeg/segmentFeeder.ts`, `src/ffmpeg/rtmpPusher.ts`,
  `src/ffmpeg/rtmpPusherArgs.ts`, and their four test files.

- [ ] **Step 1: Confirm nothing still imports each one**

Run: `grep -rln "ffmpeg/fifo'\|ffmpeg/segmentFeeder'\|ffmpeg/rtmpPusher'\|ffmpeg/rtmpPusherArgs'" src/`
Expected: no matches outside the four files' own test files (which import their own module under
test — that doesn't count as "something else depends on it"). If this finds a real remaining
import in some other `src/` file, that file is not dead — leave it and its test in place, and
note which one and why in your report.

- [ ] **Step 2: Delete whichever files Step 1 confirmed are unreferenced**

```bash
git rm src/ffmpeg/fifo.ts test/ffmpeg/fifo.test.ts
git rm src/ffmpeg/segmentFeeder.ts test/ffmpeg/segmentFeeder.test.ts
git rm src/ffmpeg/rtmpPusher.ts test/ffmpeg/rtmpPusher.test.ts
git rm src/ffmpeg/rtmpPusherArgs.ts test/ffmpeg/rtmpPusherArgs.test.ts
```

(Adjust — only run `git rm` for the pairs Step 1 actually confirmed dead.)

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS, fewer suites than before (however many pairs were actually removed).

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
chore: remove the pre-Stage-2 files now dead after the persistent-canvas rewrite

fifo.ts (named FIFOs are gone -- PipeSpawner uses anonymous pipes
instead), segmentFeeder.ts and rtmpPusher.ts/rtmpPusherArgs.ts
(replaced by CanvasFeeder+AudioRelay and PersistentEncoder) were kept
around through Task 0's revert and the tasks since purely so the
codebase kept compiling one file at a time -- nothing in the
streaming pipeline calls any of them any more as of the previous task.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01J9KpK2UY7XGtFAxYJPFkzP
EOF
)"
```

---

## Task 9: Real-ffmpeg verification (required — see Global Constraints)

Not a code task — the check that actually validates the fix. None of Tasks 0-8's unit tests spawn
real ffmpeg, and this exact architecture's two predecessors (the two-FIFO design, and the
single-FIFO/NUT prototype) both looked correct on paper and in unit tests before real testing
found they didn't work.

- [ ] **Step 1: Build and deploy to the 192.168.14.26 test host**

Follow the established deploy workflow (`[[project_super_dj_remote_test_host]]`): `git archive
HEAD | ssh ...`, rebuild, re-apply the `docker-compose.yml` `8088:3000` port fix (local-only edit,
silently reverted by every redeploy).

- [ ] **Step 2: Real-ffmpeg smoke test outside the full app/auth stack first**

Before testing through the real HTTP API, adapt this session's already-proven standalone
verification technique (a Node script inside the deployed container invoking the actual compiled
`dist/ffmpeg/*` functions with real ffmpeg processes, no auth/database/external RTMP account
needed) to this new architecture: spawn a `PersistentEncoder`, `attach()` a `CanvasFeeder` and
`AudioRelay` to its pipes exactly as `StreamController.start()` does, drive at least three
consecutive `switchTrack()` calls (mirroring three track switches), and confirm the persistent
encoder process is still alive after all three with no fatal ffmpeg error in its log. Point the
encoder's `rtmpUrl`/`streamKey` at a local file path instead of a real RTMP destination (same
substitution this session already used, and already established as an equivalent test of the
mechanism in question).

- [ ] **Step 3: Real stream through the actual API**

Start a real stream against a destination with a 3+ track playlist, trigger next at least twice,
confirm via `docker logs` that the RTMP push stays alive across both switches and the overlay
(cover/title/timer) visibly updates.

- [ ] **Step 4: Report the result**

If clean: this plan's goal is met. If not: capture the exact failure (same rigor as this session's
earlier investigation — `/proc/<pid>/wchan`, stdio inspection, whatever the failure actually
needs) and treat it as a new Phase 1 investigation (`superpowers:systematic-debugging`) rather than
patching blind.
