# Donation Library-Track Requests — Phase C (animated playlist window) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The overlay's playlist window lists queued tracks, and a newly queued track slides into it over 600 ms on the real stream, via a dedicated continuously-fed raw RGBA pipe (`pipe:7`) with all animation computed and rendered in Node.

**Architecture:** The first `playlist` template element leaves the baked Satori canvas permanently and is drawn by a new `PlaylistWindowFeeder`, which writes region-sized RGBA frames through a `RawFramePacer` (extracted from `PulseVisualizer`) at a declared 30 fps. `PlaylistQueue.windowSnapshot()` produces keyed rows; a pure `planWindowTransition()` decides none/snap/insert; insert animations are laid out by pure easing functions and rendered one frame in flight at a time in a dedicated piscina pool. ffmpeg composites the region at a fixed, even x/y.

**Tech Stack:** TypeScript, Satori + @resvg/resvg-js, piscina 4, ffmpeg (real binary only in the verification task), Jest.

**Spec:** `docs/superpowers/specs/2026-09-23-donation-library-track-request-design.md` — section "Phase C", edge cases C1–C18, judgment calls #1, #3–#7, #14.

## Global Constraints

- Requires Phases B and A merged (`StreamController.enqueueTrack` exists).
- **Do not** use `sendcmd`/`zmq`/runtime filter-graph expressions for motion (spike: `overlay`/`drawbox` answer `Function not implemented` to `process_command`). ffmpeg only composites a static-position overlay.
- fd 7 / `pipe:7` / `ChildProcessWithPipes.playlistWindowPipe`. fds 3/4/5/6 unchanged. The input is appended last; no existing input index moves.
- Pipe format: `-f rawvideo -pix_fmt rgba -s WxH -r <PLAYLIST_WINDOW_FPS> -i pipe:7`, straight alpha (unpremultiply before writing). `PLAYLIST_WINDOW_FPS = 30` (single constant; the fallback rule in Task 9 may set it to 15).
- Filter: `[idx:v]format=yuva420p[plwin]` then `overlay=X:Y` placed after the top canvas layer and before the equalizer.
- Region origin even, width/height even; `rowHeight = Math.round(fontSize * 1.25)`; `visibleRows = 2 + 1 + 7 = 10`; `regionRows = 11`; `pad = ceil(stroke.width + max(|shadow.offsetX|, |shadow.offsetY|) + shadow.blur) + 2`.
- Animation: 600 ms total; gap slide 0–360 ms ease-in-out cubic; pushed-out rows fade 1→0 over the same window; new rows opacity 0→1 and x +24→0 over 240–600 ms ease-out cubic; wall-clock progress; at most one render in flight per feeder; at most one animation in flight; inserts during an animation coalesce into one follow-up; any snap abandons the animation.
- A template with no (usable) playlist element: no pipe input, no feeder, no renders — encoder args byte-identical to today.
- piscina pool: `useAtomics: false` (RSS-leak scar), rewrap returned `Uint8Array` with `Buffer.from(buf.buffer, byteOffset, byteLength)` (worker-boundary scar), resvg with `font: { loadSystemFonts: false }` (Satori already converts text to paths; system-font scan costs ~130 ms/call per the pulse spike).
- Unit tests never spawn ffmpeg; Task 9 is the mandatory real-binary verification.
- Commit trailer: `Co-Authored-By: Claude Opus <noreply@anthropic.com>` (or the trailer matching the model actually committing).

## Review Focus

- A track advance while an insert animation is mid-flight must show the new now-playing state immediately, not after the animation — pinned in Task 6.
- Two donations landing within one animation must produce exactly one follow-up animation that includes both — pinned in Task 6.
- The encoder must never stall waiting on `pipe:7` before the first render completes — pinned in Task 6 (transparent frame written on the first tick) and verified for real in Task 9.
- A render that completes after `close()` (encoder died mid-animation) must not write to the pipe — pinned in Task 6.
- A template with no playlist element must produce byte-identical encoder args to today — pinned in Task 7.

---

### Task 1: Extract `RawFramePacer` from `PulseVisualizer` (behaviour-identical)

**Files:**
- Create: `src/ffmpeg/rawFramePacer.ts`
- Modify: `src/ffmpeg/pulseVisualizer.ts`
- Test: `test/ffmpeg/rawFramePacer.test.ts` (new); `test/ffmpeg/pulseVisualizer.test.ts` **must pass unmodified**

**Interfaces:**
- Produces:

```ts
export const MAX_CATCH_UP_FRAMES = 10;
export class RawFramePacer {
  constructor(options: { fps: number; now: () => number /* seconds */ });
  attach(pipe: NodeJS.WritableStream): void; // resets counters, records attach time, listens for 'drain'
  detach(): void;                            // removes the drain listener, drops the pipe
  setFrame(frame: Buffer): void;             // replaces the frame resent from now on; never writes by itself
  writeDueFrames(): void;                    // brings the written-frame count up to wall-clock time
  get framesWritten(): number;
}
```

- [ ] **Step 1: Write the pacer's own tests** — `test/ffmpeg/rawFramePacer.test.ts`:

```ts
import { EventEmitter } from 'events';
import { RawFramePacer, MAX_CATCH_UP_FRAMES } from '../../src/ffmpeg/rawFramePacer';

function fakePipe() {
  const pipe: any = new EventEmitter();
  pipe.writes = [] as Buffer[];
  pipe.writableNeedDrain = false;
  pipe.write = (b: Buffer) => { pipe.writes.push(b); return true; };
  return pipe;
}

describe('RawFramePacer', () => {
  it('writes nothing until a frame is set', () => {
    const clock = { s: 0 };
    const pacer = new RawFramePacer({ fps: 30, now: () => clock.s });
    const pipe = fakePipe();
    pacer.attach(pipe);
    clock.s = 1;
    pacer.writeDueFrames();
    expect(pipe.writes).toHaveLength(0);
  });

  it('writes exactly the frames due at the declared rate, capped by MAX_CATCH_UP_FRAMES', () => {
    const clock = { s: 0 };
    const pacer = new RawFramePacer({ fps: 30, now: () => clock.s });
    const pipe = fakePipe();
    pacer.attach(pipe);
    pacer.setFrame(Buffer.from([1]));
    clock.s = 0.1; // 3 frames due
    pacer.writeDueFrames();
    expect(pipe.writes).toHaveLength(3);
    clock.s = 10; // hundreds due -> capped
    pacer.writeDueFrames();
    expect(pipe.writes).toHaveLength(3 + MAX_CATCH_UP_FRAMES);
    expect(pacer.framesWritten).toBe(3 + MAX_CATCH_UP_FRAMES);
  });

  it('forgives frames while the pipe is backed up and owes one on drain', () => {
    const clock = { s: 0 };
    const pacer = new RawFramePacer({ fps: 30, now: () => clock.s });
    const pipe = fakePipe();
    pacer.attach(pipe);
    pacer.setFrame(Buffer.from([1]));
    pipe.writableNeedDrain = true;
    clock.s = 1; // 30 due, pipe blocked
    pacer.writeDueFrames();
    expect(pipe.writes).toHaveLength(0);
    pipe.writableNeedDrain = false;
    pipe.emit('drain');
    expect(pipe.writes).toHaveLength(1);
  });

  it('never writes after detach', () => {
    const clock = { s: 0 };
    const pacer = new RawFramePacer({ fps: 30, now: () => clock.s });
    const pipe = fakePipe();
    pacer.attach(pipe);
    pacer.setFrame(Buffer.from([1]));
    pacer.detach();
    clock.s = 1;
    pacer.writeDueFrames();
    pipe.emit('drain');
    expect(pipe.writes).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/ffmpeg/rawFramePacer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/ffmpeg/rawFramePacer.ts`** by MOVING (not rewriting) `PulseVisualizer`'s `framesDue()`, `writeDueFrames()`, `onDrain`, `framesAccounted`, `framesWritten`, `attachedAtSeconds`, and `MAX_CATCH_UP_FRAMES` (with their full comments) into the class:

```ts
function needsDrain(pipe: NodeJS.WritableStream): boolean {
  return (pipe as unknown as { writableNeedDrain?: boolean }).writableNeedDrain === true;
}

// <MAX_CATCH_UP_FRAMES comment moved verbatim from pulseVisualizer.ts>
export const MAX_CATCH_UP_FRAMES = 10;

/**
 * Keeps a raw-video pipe declared to ffmpeg at a fixed `-r fps` (with no timestamps) fed with
 * exactly as many frames as wall-clock time says it should have received. ffmpeg synthesizes that
 * pipe's timeline purely from the frame count, and its overlay frame-sync stalls the WHOLE encode
 * on an input that falls behind — so the count, not any render, is what must track real time.
 * This is the same invariant as CanvasFeeder's "every write lands exactly heartbeatMs apart" rule,
 * in the form that holds at 30fps; and a render can never add an extra frame, because renders only
 * call setFrame() and this class alone writes. Extracted from PulseVisualizer (behaviour-identical)
 * so PlaylistWindowFeeder shares it instead of copying it.
 */
export class RawFramePacer {
  private pipe: NodeJS.WritableStream | null = null;
  private frame: Buffer | null = null;
  private attachedAtSeconds = 0;
  private framesAccounted = 0;
  private written = 0;
  private readonly onDrain = () => {
    // <comment moved verbatim>
    this.framesAccounted = Math.max(this.framesAccounted, this.framesDue() - 1);
    this.writeDueFrames();
  };

  constructor(private readonly options: { fps: number; now: () => number }) {}

  attach(pipe: NodeJS.WritableStream): void {
    this.pipe = pipe;
    this.attachedAtSeconds = this.options.now();
    this.framesAccounted = 0;
    this.written = 0;
    pipe.on('drain', this.onDrain);
  }

  detach(): void {
    this.pipe?.removeListener('drain', this.onDrain);
    this.pipe = null;
  }

  setFrame(frame: Buffer): void {
    this.frame = frame;
  }

  get framesWritten(): number {
    return this.written;
  }

  // <framesDue comment moved verbatim>
  private framesDue(): number {
    return Math.floor((this.options.now() - this.attachedAtSeconds) * this.options.fps + 1e-6);
  }

  // <writeDueFrames comment moved verbatim>
  writeDueFrames(): void {
    if (!this.frame || !this.pipe) return;
    const due = this.framesDue();
    if (needsDrain(this.pipe)) {
      this.framesAccounted = Math.max(this.framesAccounted, due - 1);
      return;
    }
    if (due - this.framesAccounted > MAX_CATCH_UP_FRAMES) this.framesAccounted = due - MAX_CATCH_UP_FRAMES;
    while (this.framesAccounted < due) {
      this.pipe.write(this.frame);
      this.framesAccounted += 1;
      this.written += 1;
    }
  }
}
```

In `src/ffmpeg/pulseVisualizer.ts`: delete the moved members; add `private readonly pacer: RawFramePacer;` built in the constructor as `new RawFramePacer({ fps: options.fps, now: this.now })` (after `this.now` is assigned); `attach()` → `this.pulsePipe = pulsePipe; this.pacer.attach(pulsePipe); this.startTicking();`; `close()` → `this.stopTicking(); this.pacer.detach(); this.pulsePipe = null;`; in the render `.then` → `this.cachedFrame = pixels; this.pacer.setFrame(pixels); this.pacer.writeDueFrames();`; in `tickUnsafe()`'s in-flight branch → `this.pacer.writeDueFrames();`; in `loadAnalysisWindow()` use `this.pacer.framesWritten`. Keep `export { MAX_CATCH_UP_FRAMES } from './rawFramePacer';` so the existing test import keeps working. `cachedFrame` may be removed if nothing else reads it.

- [ ] **Step 4: Run both suites — the pulse suite unmodified**

Run: `npx jest test/ffmpeg/rawFramePacer.test.ts test/ffmpeg/pulseVisualizer.test.ts` and confirm with `git diff --stat test/ffmpeg/pulseVisualizer.test.ts` that it shows no changes.
Expected: PASS, and no diff on the pulse test file.

- [ ] **Step 5: Commit**

```bash
git add src/ffmpeg/rawFramePacer.ts src/ffmpeg/pulseVisualizer.ts test/ffmpeg/rawFramePacer.test.ts
git commit -m "refactor(ffmpeg): extract RawFramePacer from PulseVisualizer, behaviour-identical"
```

---

### Task 2: Keyed window snapshot on `PlaylistQueue`

**Files:**
- Create: `src/playlist/window.ts`
- Modify: `src/playlist/queue.ts`
- Test: `test/playlist/queue.test.ts`

**Interfaces:**
- Produces (`src/playlist/window.ts`):

```ts
export interface WindowRow { key: string; text: string; isCurrent: boolean }
export const PLAYLIST_WINDOW_BEFORE = 2;
export const PLAYLIST_WINDOW_AFTER = 7;
export const PLAYLIST_WINDOW_VISIBLE_ROWS = PLAYLIST_WINDOW_BEFORE + 1 + PLAYLIST_WINDOW_AFTER;
export function windowRowLines(rows: WindowRow[]): string[]; // rows.map(r => r.text)
```

- `PlaylistQueue.windowSnapshot(before: number, after: number): WindowRow[]`. Keys: base rows `b:<baseIndex>`; inserted entries `i:<seq>` assigned in `insertNext()`, kept when they become current and when restored by `previous()`.

- [ ] **Step 1: Failing tests** — append to `test/playlist/queue.test.ts`:

```ts
  describe('windowSnapshot', () => {
    const names = (rows: { text: string }[]) => rows.map((r) => r.text);
    const base = () => new PlaylistQueue(['a', 'b', 'c', 'd', 'e'].map(track));

    it('shows base context around a base current track', () => {
      const q = base();
      q.next(); q.next(); // c
      expect(names(q.windowSnapshot(2, 7))).toEqual(['  a', '  b', '▶ c', '  d', '  e']);
      expect(q.windowSnapshot(2, 7).map((r) => r.key)).toEqual(['b:0', 'b:1', 'b:2', 'b:3', 'b:4']);
    });

    it('lists queued inserted tracks right after the current one (C1)', () => {
      const q = base();
      q.insertNext(track('z'));
      expect(names(q.windowSnapshot(2, 7))).toEqual(['▶ a', '  z', '  b', '  c', '  d', '  e']);
      expect(q.windowSnapshot(2, 7)[1].key).toBe('i:0');
    });

    it('caps the after-section, inserted rows first', () => {
      const q = base();
      q.insertNext(track('y'));
      q.insertNext(track('z'));
      expect(names(q.windowSnapshot(0, 3))).toEqual(['▶ a', '  y', '  z', '  b']);
    });

    it('an inserted current track keeps its key and anchors before-context on positionInBase', () => {
      const q = base();
      q.next(); // b
      q.insertNext(track('z'));
      q.next(); // z
      const rows = q.windowSnapshot(2, 7);
      expect(names(rows)).toEqual(['  a', '  b', '▶ z', '  c', '  d', '  e']);
      expect(rows[2]).toEqual({ key: 'i:0', text: '▶ z', isCurrent: true });
    });

    it('two inserts of the same Track object are two distinct rows (B9)', () => {
      const q = base();
      const z = track('z');
      q.insertNext(z);
      q.insertNext(z);
      const keys = q.windowSnapshot(0, 7).map((r) => r.key);
      expect(keys.slice(1, 3)).toEqual(['i:0', 'i:1']);
    });

    it('previous() restores the key the track had', () => {
      const q = base();
      q.insertNext(track('z'));
      q.next(); // z (i:0)
      q.next(); // b
      q.previous(); // back to z
      expect(q.windowSnapshot(0, 0)).toEqual([{ key: 'i:0', text: '▶ z', isCurrent: true }]);
    });

    it('empty playlist -> no rows', () => {
      expect(new PlaylistQueue([]).windowSnapshot(2, 7)).toEqual([]);
    });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/playlist/queue.test.ts`
Expected: FAIL — `windowSnapshot` is not a function.

- [ ] **Step 3: Implement**

Create `src/playlist/window.ts` with the interface, constants and `windowRowLines` above (plus a doc comment: "keys are per queue ENTRY, stable across renders — what lets PlaylistWindowFeeder diff two snapshots into an insert animation").

In `src/playlist/queue.ts`:

```ts
interface QueueEntry { track: Track; key: string }
```

- `insertedQueue: QueueEntry[]`, `history: QueueEntry[]`, `private currentKey: string`, `private insertSeq = 0`.
- constructor: `this.currentKey = 'b:0';`
- `peekNext()`: `return this.insertedQueue[0].track` when non-empty.
- `next()`: push `{ track: this.currentTrack, key: this.currentKey }` to history (still skipping ephemeral tracks, Phase B); on inserted: `const entry = this.insertedQueue.shift()!; this.currentTrack = entry.track; this.currentKey = entry.key;`; on base: `this.currentKey = \`b:${this.position}\``.
- `previous()`: `const entry = this.history.pop()!;` — keep the existing name lookup for `position`; `this.currentTrack = entry.track; this.currentKey = entry.key;`.
- `insertNext(track)`: `this.insertedQueue.push({ track, key: \`i:${this.insertSeq++}\` });`
- `setTracks()`: after recomputing `position`, set `this.currentKey = \`b:${this.position}\``.
- New method:

```ts
  windowSnapshot(before: number, after: number): WindowRow[] {
    if (!this.currentTrack) return [];
    const rows: WindowRow[] = [];
    const insertedIsCurrent = this.currentKey.startsWith('i:');
    const anchor = this.position;
    if (this.baseTracks.length > 0 && anchor >= 0) {
      // Same before-context semantics the old buildPlaylistWindowLines/buildInsertedTrackWindowLines
      // had: base rows before the current base track, or — while an inserted track is current —
      // ending at (and including) the base track it follows.
      const end = insertedIsCurrent ? anchor : anchor - 1;
      const start = Math.max(0, end - before + 1);
      for (let i = start; i <= end; i += 1) rows.push({ key: `b:${i}`, text: `  ${this.baseTracks[i].name}`, isCurrent: false });
    }
    rows.push({ key: this.currentKey, text: `▶ ${this.currentTrack.name}`, isCurrent: true });
    let remaining = after;
    for (const entry of this.insertedQueue) {
      if (remaining <= 0) break;
      rows.push({ key: entry.key, text: `  ${entry.track.name}`, isCurrent: false });
      remaining -= 1;
    }
    for (let i = anchor + 1; i < this.baseTracks.length && remaining > 0; i += 1, remaining -= 1) {
      rows.push({ key: `b:${i}`, text: `  ${this.baseTracks[i].name}`, isCurrent: false });
    }
    return rows;
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest test/playlist` then `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/playlist/window.ts src/playlist/queue.ts test/playlist/queue.test.ts
git commit -m "feat(queue): keyed window snapshot that lists queued tracks"
```

---

### Task 3: Transition planning and animation layout (pure)

**Files:**
- Create: `src/ffmpeg/playlistWindowTransition.ts`
- Test: `test/ffmpeg/playlistWindowTransition.test.ts`

**Interfaces:**
- Consumes: `WindowRow` (Task 2).
- Produces:

```ts
export const INSERT_ANIMATION_MS = 600;
export interface RowLayout { key: string; text: string; top: number; left: number; opacity: number } // top/left in px relative to the element's own origin
export type WindowTransition = { kind: 'none' } | { kind: 'snap' } | { kind: 'insert'; from: WindowRow[]; to: WindowRow[]; insertedKeys: Set<string> };
export function planWindowTransition(from: WindowRow[], to: WindowRow[]): WindowTransition;
export function layoutSettled(rows: WindowRow[], rowHeight: number): RowLayout[];
export function layoutInsertFrame(t: Extract<WindowTransition, { kind: 'insert' }>, rowHeight: number, elapsedMs: number): RowLayout[];
```

- [ ] **Step 1: Failing tests**

```ts
import { planWindowTransition, layoutSettled, layoutInsertFrame, INSERT_ANIMATION_MS } from '../../src/ffmpeg/playlistWindowTransition';
import { WindowRow } from '../../src/playlist/window';

const row = (key: string, isCurrent = false): WindowRow => ({ key, text: `  ${key}`, isCurrent });
const FROM = [row('b:0'), row('b:1', true), row('b:2'), row('b:3')];

describe('planWindowTransition', () => {
  it('none for identical rows', () => {
    expect(planWindowTransition(FROM, FROM.map((r) => ({ ...r })))).toEqual({ kind: 'none' });
  });
  it('snap from empty', () => {
    expect(planWindowTransition([], FROM).kind).toBe('snap');
  });
  it('insert after the current row, bottom row falling off', () => {
    const to = [row('b:0'), row('b:1', true), row('i:0'), row('b:2')];
    const t = planWindowTransition(FROM, to);
    expect(t.kind).toBe('insert');
    if (t.kind === 'insert') expect([...t.insertedKeys]).toEqual(['i:0']);
  });
  it('two inserts at once are one insert transition', () => {
    const to = [row('b:0'), row('b:1', true), row('i:0'), row('i:1'), row('b:2'), row('b:3')];
    const t = planWindowTransition(FROM, to);
    expect(t.kind === 'insert' && t.insertedKeys.size).toBe(2);
  });
  it('snap when the current row changes (a track advance, C5)', () => {
    const to = [row('b:1'), row('b:2', true), row('b:3')];
    expect(planWindowTransition(FROM, to).kind).toBe('snap');
  });
  it('snap when a shared row changed text', () => {
    const to = FROM.map((r) => (r.key === 'b:2' ? { ...r, text: 'renamed' } : r));
    expect(planWindowTransition(FROM, to).kind).toBe('snap');
  });
  it('snap when a row vanished from the middle', () => {
    const to = [row('b:0'), row('b:1', true), row('b:3')];
    expect(planWindowTransition(FROM, to).kind).toBe('snap');
  });
});

describe('layout', () => {
  const to = [row('b:0'), row('b:1', true), row('i:0'), row('b:2')];
  const t = planWindowTransition(FROM, to) as Extract<ReturnType<typeof planWindowTransition>, { kind: 'insert' }>;
  const byKey = (rows: { key: string }[], key: string) => rows.find((r) => r.key === key) as any;

  it('settled rows sit on the row grid, fully opaque', () => {
    expect(layoutSettled(to, 28).map((r) => [r.top, r.left, r.opacity])).toEqual([[0, 0, 1], [28, 0, 1], [56, 0, 1], [84, 0, 1]]);
  });
  it('at t=0 the frame equals the FROM layout, with the new row invisible', () => {
    const f = layoutInsertFrame(t, 28, 0);
    expect(byKey(f, 'b:2').top).toBe(56);
    expect(byKey(f, 'b:3')).toMatchObject({ top: 84, opacity: 1 });
    expect(byKey(f, 'i:0')).toMatchObject({ opacity: 0, left: 24 });
  });
  it('gap is fully open by 360ms; new row starts appearing only after 240ms', () => {
    expect(byKey(layoutInsertFrame(t, 28, 200), 'i:0').opacity).toBe(0);
    const f = layoutInsertFrame(t, 28, 360);
    expect(byKey(f, 'b:2').top).toBe(84);
    expect(byKey(f, 'b:3').opacity).toBe(0);
  });
  it('at the end it equals the settled TO layout (pushed-out rows gone)', () => {
    const end = layoutInsertFrame(t, 28, INSERT_ANIMATION_MS).filter((r) => r.opacity > 0);
    expect(end).toEqual(layoutSettled(to, 28));
  });
  it('motion is monotonic (no overshoot)', () => {
    let last = -Infinity;
    for (let ms = 0; ms <= 600; ms += 20) {
      const top = byKey(layoutInsertFrame(t, 28, ms), 'b:2').top;
      expect(top).toBeGreaterThanOrEqual(last);
      last = top;
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/ffmpeg/playlistWindowTransition.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { WindowRow } from '../playlist/window';

export const INSERT_ANIMATION_MS = 600;
const GAP_END_MS = 360;
const FADE_IN_START_MS = 240;
const SLIDE_IN_PX = 24;

export interface RowLayout { key: string; text: string; top: number; left: number; opacity: number }
export type WindowTransition =
  | { kind: 'none' }
  | { kind: 'snap' }
  | { kind: 'insert'; from: WindowRow[]; to: WindowRow[]; insertedKeys: Set<string> };

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);

/**
 * `insert` ONLY when `to` is `from` with rows added after the current row and rows lost only off
 * the bottom — the one change worth animating. Everything else (a track advance, previous, a
 * restart, a first render) is `snap`: a cosmetic animation must never delay showing what's
 * actually playing.
 */
export function planWindowTransition(from: WindowRow[], to: WindowRow[]): WindowTransition {
  const same = from.length === to.length && from.every((r, i) => r.key === to[i].key && r.text === to[i].text && r.isCurrent === to[i].isCurrent);
  if (same) return { kind: 'none' };
  if (from.length === 0) return { kind: 'snap' };

  const fromCur = from.findIndex((r) => r.isCurrent);
  const toCur = to.findIndex((r) => r.isCurrent);
  if (fromCur < 0 || fromCur !== toCur || from[fromCur].key !== to[toCur].key) return { kind: 'snap' };

  const fromByKey = new Map(from.map((r) => [r.key, r]));
  const insertedKeys = new Set(to.filter((r) => !fromByKey.has(r.key)).map((r) => r.key));
  if (insertedKeys.size === 0) return { kind: 'snap' };
  if (to.some((r, i) => insertedKeys.has(r.key) && i <= toCur)) return { kind: 'snap' };

  const kept = to.filter((r) => !insertedKeys.has(r.key));
  // kept must be a PREFIX of from (rows only fall off the bottom), with identical text.
  if (kept.length > from.length) return { kind: 'snap' };
  for (let i = 0; i < kept.length; i += 1) {
    if (kept[i].key !== from[i].key || kept[i].text !== from[i].text) return { kind: 'snap' };
  }
  return { kind: 'insert', from, to, insertedKeys };
}

export function layoutSettled(rows: WindowRow[], rowHeight: number): RowLayout[] {
  return rows.map((r, i) => ({ key: r.key, text: r.text, top: i * rowHeight, left: 0, opacity: 1 }));
}

export function layoutInsertFrame(t: Extract<WindowTransition, { kind: 'insert' }>, rowHeight: number, elapsedMs: number): RowLayout[] {
  const gap = easeInOutCubic(clamp01(elapsedMs / GAP_END_MS));
  const appear = easeOutCubic(clamp01((elapsedMs - FADE_IN_START_MS) / (INSERT_ANIMATION_MS - FADE_IN_START_MS)));
  const toIndex = new Map(t.to.map((r, i) => [r.key, i]));
  const rows: RowLayout[] = [];

  t.from.forEach((r, fromIdx) => {
    const target = toIndex.get(r.key);
    if (target === undefined) {
      // Pushed off the bottom: keeps sliding by the number of rows inserted, fading out.
      const endIdx = fromIdx + t.insertedKeys.size;
      rows.push({ key: r.key, text: r.text, top: (fromIdx + (endIdx - fromIdx) * gap) * rowHeight, left: 0, opacity: 1 - gap });
    } else {
      rows.push({ key: r.key, text: r.text, top: (fromIdx + (target - fromIdx) * gap) * rowHeight, left: 0, opacity: 1 });
    }
  });
  t.to.forEach((r, idx) => {
    if (!t.insertedKeys.has(r.key)) return;
    rows.push({ key: r.key, text: r.text, top: idx * rowHeight, left: SLIDE_IN_PX * (1 - appear), opacity: appear });
  });
  return rows.sort((a, b) => a.top - b.top);
}
```

(The last test filters opacity-0 rows; at `t = 600` the pushed-out rows have opacity 0 and the inserted row has left 0 and opacity 1, so the filtered frame equals `layoutSettled(to)` when sorted by top.)

- [ ] **Step 4: Run to verify pass**

Run: `npx jest test/ffmpeg/playlistWindowTransition.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ffmpeg/playlistWindowTransition.ts test/ffmpeg/playlistWindowTransition.test.ts
git commit -m "feat(ffmpeg): pure insert-transition planning and eased row layout for the playlist window"
```

---

### Task 4: Region geometry and the shared fixed-row builder (preview included)

**Files:**
- Create: `src/render/playlistWindowGeometry.ts`
- Modify: `src/render/sceneRenderer.ts`
- Test: `test/render/playlistWindowGeometry.test.ts`, `test/render/sceneRenderer.test.ts`

**Interfaces:**
- Consumes: `RowLayout`, `layoutSettled` (Task 3); `PLAYLIST_WINDOW_VISIBLE_ROWS` (Task 2).
- Produces:

```ts
// playlistWindowGeometry.ts
export const ROW_HEIGHT_FACTOR = 1.25;
export function rowHeightFor(fontSize: number): number; // Math.round(fontSize * 1.25)
export interface PlaylistWindowRegion { x: number; y: number; width: number; height: number; originX: number; originY: number; rowHeight: number }
export function computePlaylistWindowRegion(el: PlaylistElement, canvas: { width: number; height: number }, visibleRows: number): PlaylistWindowRegion | null;

// sceneRenderer.ts
export function playlistRowsNode(el: PlaylistElement, rows: RowLayout[], origin: { x: number; y: number }): SatoriNode;
export function collectFontVariants(elements: TemplateElement[]) // now exported
export interface PlaylistWindowFrameRequest { element: PlaylistElement; rows: RowLayout[]; region: PlaylistWindowRegion }
export async function renderPlaylistWindowPixels(req: PlaylistWindowFrameRequest, loadFont?: ...): Promise<{ pixels: Uint8Array; width: number; height: number }>;
```

- [ ] **Step 1: Failing geometry tests** — `test/render/playlistWindowGeometry.test.ts`:

```ts
import { computePlaylistWindowRegion, rowHeightFor } from '../../src/render/playlistWindowGeometry';

const el = (over: any = {}) => ({ type: 'playlist' as const, x: 512, y: 160, width: 700, fontSize: 22,
  color: { mode: 'solid' as const, color: '#fff' }, style: { fontFamily: 'DejaVu Sans', bold: false, italic: false }, ...over });
const CANVAS = { width: 1280, height: 720 };

describe('computePlaylistWindowRegion', () => {
  it('default template: even origin, padded, 11 rows tall', () => {
    const r = computePlaylistWindowRegion(el(), CANVAS, 10)!;
    expect(rowHeightFor(22)).toBe(28);
    expect(r).toEqual({ x: 510, y: 158, width: 704, height: 312, originX: 2, originY: 2, rowHeight: 28 });
  });
  it('rounds an odd origin down to even and keeps the size even', () => {
    const r = computePlaylistWindowRegion(el({ x: 141, y: 501 }), CANVAS, 10)!;
    expect(r.x % 2).toBe(0);
    expect(r.y % 2).toBe(0);
    expect(r.width % 2).toBe(0);
    expect(r.height % 2).toBe(0);
    expect(r.x + r.originX).toBe(141);
    expect(r.y + r.originY).toBe(501);
  });
  it('clamps to the canvas', () => {
    const r = computePlaylistWindowRegion(el({ x: 1000, y: 600 }), CANVAS, 10)!;
    expect(r.x + r.width).toBeLessThanOrEqual(1280);
    expect(r.y + r.height).toBeLessThanOrEqual(720);
  });
  it('pads for stroke and shadow', () => {
    const r = computePlaylistWindowRegion(el({ style: { fontFamily: 'DejaVu Sans', bold: false, italic: false, stroke: { width: 3, color: '#000' }, shadow: { offsetX: 4, offsetY: -2, blur: 6, color: '#000' } } }), CANVAS, 10)!;
    expect(r.originX).toBeGreaterThanOrEqual(3 + 4 + 6 + 2);
  });
  it('null for an element entirely off-canvas', () => {
    expect(computePlaylistWindowRegion(el({ x: 1400 }), CANVAS, 10)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/render/playlistWindowGeometry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement geometry**

```ts
import { PlaylistElement } from '../templates/templateTypes';

export const ROW_HEIGHT_FACTOR = 1.25;
export function rowHeightFor(fontSize: number): number { return Math.round(fontSize * ROW_HEIGHT_FACTOR); }

export interface PlaylistWindowRegion { x: number; y: number; width: number; height: number; originX: number; originY: number; rowHeight: number }

const floorEven = (n: number) => Math.floor(n / 2) * 2;

/**
 * The fixed pipe:7 region for a playlist element: one extra row beyond the visible ones (room for
 * the row an insert pushes out to slide while it fades), padded for stroke/shadow, clamped to the
 * canvas, with an EVEN origin — overlay in yuv420 snaps odd coordinates to the chroma grid (see
 * GIF_OVERLAY_FORMAT in persistentEncoderArgs.ts), and an even origin makes placement exact for free.
 */
export function computePlaylistWindowRegion(el: PlaylistElement, canvas: { width: number; height: number }, visibleRows: number): PlaylistWindowRegion | null {
  const rowHeight = rowHeightFor(el.fontSize);
  const s = el.style;
  const pad = Math.ceil((s.stroke?.width ?? 0) + Math.max(Math.abs(s.shadow?.offsetX ?? 0), Math.abs(s.shadow?.offsetY ?? 0)) + (s.shadow?.blur ?? 0)) + 2;
  const x0 = Math.max(0, floorEven(Math.round(el.x) - pad));
  const y0 = Math.max(0, floorEven(Math.round(el.y) - pad));
  const x1 = Math.min(canvas.width, Math.round(el.x + el.width) + pad);
  const y1 = Math.min(canvas.height, Math.round(el.y) + (visibleRows + 1) * rowHeight + pad);
  const width = floorEven(x1 - x0);
  const height = floorEven(y1 - y0);
  if (width < 2 || height < 2) return null;
  return { x: x0, y: y0, width, height, originX: Math.round(el.x) - x0, originY: Math.round(el.y) - y0, rowHeight };
}
```

- [ ] **Step 4: Shared row builder in `sceneRenderer.ts`** — add `sceneRenderer.test.ts` cases first. They render through the real satori+resvg with the file's existing `testLoadFont`, and read raw pixels from `renderPlaylistWindowPixels` (defined below), so no PNG decoding is needed:

```ts
  describe('playlist rows (fixed grid, shared with pipe:7)', () => {
    const el = { type: 'playlist' as const, x: 0, y: 0, width: 120, fontSize: 20, color: { mode: 'solid' as const, color: '#ffffff' }, style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } };
    const region = { x: 0, y: 0, width: 200, height: 100, originX: 0, originY: 0, rowHeight: 25 };
    const alphaInRows = (px: Uint8Array, width: number, y0: number, y1: number) => {
      let sum = 0;
      for (let y = y0; y < y1; y++) for (let x = 0; x < width; x++) sum += px[(y * width + x) * 4 + 3];
      return sum;
    };

    it('one line per row: a long name ellipsizes instead of wrapping into the next row', async () => {
      const rows = [{ key: 'a', text: '  a very very very long track name that would wrap', top: 0, left: 0, opacity: 1 }];
      const { pixels, width } = await renderPlaylistWindowPixels({ element: el, region, rows }, testLoadFont);
      expect(alphaInRows(pixels, width, 0, 25)).toBeGreaterThan(0);
      expect(alphaInRows(pixels, width, 25, 100)).toBe(0);
    });

    it('returns width*height*4 bytes, fully transparent for no rows', async () => {
      const { pixels, width, height } = await renderPlaylistWindowPixels({ element: el, region, rows: [] }, testLoadFont);
      expect(pixels.length).toBe(width * height * 4);
      expect(alphaInRows(pixels, width, 0, height)).toBe(0);
    });

    it('opacity 0 draws nothing', async () => {
      const rows = [{ key: 'a', text: '▶ b', top: 0, left: 0, opacity: 0 }];
      const { pixels, width, height } = await renderPlaylistWindowPixels({ element: el, region, rows }, testLoadFont);
      expect(alphaInRows(pixels, width, 0, height)).toBe(0);
    });
  });
```

Implement:

```ts
export function playlistRowsNode(el: PlaylistElement, rows: RowLayout[], origin: { x: number; y: number }): SatoriNode {
  const rowHeight = rowHeightFor(el.fontSize);
  return {
    type: 'div',
    props: {
      style: { position: 'absolute', left: origin.x, top: origin.y, width: el.width, height: (rows.length + 1) * rowHeight, display: 'flex' },
      children: rows.map((r): SatoriNode => ({
        type: 'div',
        props: {
          style: {
            position: 'absolute', left: r.left, top: r.top, width: el.width, height: rowHeight,
            fontSize: el.fontSize, lineHeight: `${rowHeight}px`, opacity: r.opacity, display: 'flex',
            ...textStyleToCss(el.style, el.color),
            // Fixed geometry is what lets pipe:7 have fixed dimensions and lets an insert slide by
            // exactly one row: single line, ellipsis instead of wrapping.
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          },
          children: r.text,
        },
      })),
    },
  };
}
```

and replace the `case 'playlist':` body with
`return playlistRowsNode(el, layoutSettled(scene.playlistLines.map((text, i) => ({ key: String(i), text, isCurrent: false })), rowHeightFor(el.fontSize)), { x: el.x, y: el.y });`.
Note (spec C16, visible change): a gradient `color` now spans each row rather than the whole block.

Export `collectFontVariants`, and add:

```ts
export interface PlaylistWindowFrameRequest { element: PlaylistElement; rows: RowLayout[]; region: PlaylistWindowRegion }

// One pipe:7 frame: ONLY the playlist element, in region coordinates, as raw premultiplied RGBA
// (the caller unpremultiplies, as PulseVisualizer does). loadSystemFonts: false — satori has
// already turned every glyph into a path, and the scan costs ~130ms per call (pulse spike).
export async function renderPlaylistWindowPixels(
  req: PlaylistWindowFrameRequest,
  loadFont: (family: string, bold: boolean, italic: boolean) => Promise<Buffer> = defaultLoadFont,
): Promise<{ pixels: Uint8Array; width: number; height: number }> {
  const variants = collectFontVariants([req.element]);
  const fonts = await Promise.all(variants.map(async (v) => ({
    name: v.family, data: await loadFont(v.family, v.bold, v.italic),
    weight: (v.bold ? 700 : 400) as 400 | 700, style: (v.italic ? 'italic' : 'normal') as 'italic' | 'normal',
  })));
  const root: SatoriNode = {
    type: 'div',
    props: {
      style: { width: req.region.width, height: req.region.height, display: 'flex', position: 'relative' },
      children: [playlistRowsNode(req.element, req.rows, { x: req.region.originX, y: req.region.originY })],
    },
  };
  const svg = await satori(root as unknown as Parameters<typeof satori>[0], { width: req.region.width, height: req.region.height, fonts });
  const pixmap = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
  return { pixels: pixmap.pixels, width: pixmap.width, height: pixmap.height };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx jest test/render` then `npm run build`
Expected: PASS. If an existing `sceneRenderer.test.ts`/`templateRoutes` snapshot or pixel assertion on playlist wrapping fails, update it to the fixed-row behaviour — it's the intended visible change (spec judgment call #4).

- [ ] **Step 6: Commit**

```bash
git add src/render/playlistWindowGeometry.ts src/render/sceneRenderer.ts test/render
git commit -m "feat(render): fixed-row playlist builder shared by preview and the pipe:7 frame renderer"
```

---

### Task 5: Dedicated render pool for playlist-window frames

**Files:**
- Create: `src/render/playlistWindowRenderWorker.ts`, `src/render/playlistWindowRenderPool.ts`
- Test: `test/render/playlistWindowRenderWorker.test.ts`, `test/render/playlistWindowRenderPool.test.ts`

**Interfaces:**
- Consumes: `renderPlaylistWindowPixels`, `PlaylistWindowFrameRequest` (Task 4).
- Produces: `renderPlaylistWindowFrame(req: PlaylistWindowFrameRequest): Promise<Buffer>` — raw premultiplied RGBA of exactly `region.width * region.height * 4` bytes, a real `Buffer`.

- [ ] **Step 1: Failing tests**

`test/render/playlistWindowRenderPool.test.ts` (same piscina mocking as `pulseRenderWorkerPool.test.ts`):

```ts
const runMock = jest.fn();
const piscinaCtor = jest.fn().mockImplementation(() => ({ run: runMock }));
jest.mock('piscina', () => piscinaCtor);

import { renderPlaylistWindowFrame } from '../../src/render/playlistWindowRenderPool';

const REQ: any = { element: {}, rows: [], region: { x: 0, y: 0, width: 1, height: 1, originX: 0, originY: 0, rowHeight: 25 } };

describe('renderPlaylistWindowFrame (pool wrapper)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates its own pool with useAtomics disabled and at most 2 threads', async () => {
    runMock.mockResolvedValue({ pixels: new Uint8Array(4), width: 1, height: 1 });
    await renderPlaylistWindowFrame(REQ);
    expect(piscinaCtor).toHaveBeenCalledWith(expect.objectContaining({ useAtomics: false }));
    expect(piscinaCtor.mock.calls[0][0].maxThreads).toBeLessThanOrEqual(2);
    expect(piscinaCtor.mock.calls[0][0].filename).toMatch(/playlistWindowRenderWorker\.js$/);
  });

  it('returns a real Buffer, not the plain Uint8Array structured clone hands back', async () => {
    runMock.mockResolvedValue({ pixels: new Uint8Array([1, 2, 3, 4]), width: 1, height: 1 });
    const result = await renderPlaylistWindowFrame(REQ);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect([...result]).toEqual([1, 2, 3, 4]);
  });

  it('passes an abort signal (render timeout)', async () => {
    runMock.mockResolvedValue({ pixels: new Uint8Array(4), width: 1, height: 1 });
    await renderPlaylistWindowFrame(REQ);
    expect(runMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
```

`test/render/playlistWindowRenderWorker.test.ts`:

```ts
jest.mock('../../src/render/sceneRenderer', () => ({ renderPlaylistWindowPixels: jest.fn().mockResolvedValue({ pixels: new Uint8Array(8), width: 2, height: 1 }) }));
import render from '../../src/render/playlistWindowRenderWorker';
import { renderPlaylistWindowPixels } from '../../src/render/sceneRenderer';

it('delegates the task unchanged to renderPlaylistWindowPixels', async () => {
  const task: any = { element: {}, rows: [], region: {} };
  await expect(render(task)).resolves.toEqual({ pixels: new Uint8Array(8), width: 2, height: 1 });
  expect(renderPlaylistWindowPixels).toHaveBeenCalledWith(task);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/render/playlistWindowRender`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/render/playlistWindowRenderWorker.ts`:

```ts
import { renderPlaylistWindowPixels, PlaylistWindowFrameRequest } from './sceneRenderer';

// Piscina worker entry for pipe:7 frames. Fonts load inside this thread (fontCache), so no font
// bytes cross the postMessage boundary.
export default function render(task: PlaylistWindowFrameRequest) {
  return renderPlaylistWindowPixels(task);
}
```

`src/render/playlistWindowRenderPool.ts`:

```ts
import Piscina from 'piscina';
import * as path from 'path';
import * as os from 'os';
import { PlaylistWindowFrameRequest } from './sceneRenderer';

const RENDER_TIMEOUT_MS = 500;
let pool: Piscina | null = null;

// Its own small pool, NOT renderWorkerPool's: an insert animation fires up to ~18 renders in 0.6s,
// and must neither queue behind another tenant's full 1280x720 canvas render nor delay one.
function getPool(): Piscina {
  if (!pool) {
    pool = new Piscina({
      filename: path.join(__dirname, 'playlistWindowRenderWorker.js'),
      maxThreads: Math.max(1, Math.min(2, os.cpus().length)),
      idleTimeout: 60000,
      // Same RSS leak as pulseRenderWorkerPool.ts (read its comment): with Atomics dispatch the
      // worker's event loop never turns during a burst and resvg's native memory is never freed.
      useAtomics: false,
    });
  }
  return pool;
}

export async function renderPlaylistWindowFrame(req: PlaylistWindowFrameRequest): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  try {
    const result = await getPool().run(req, { signal: controller.signal });
    // Structured clone hands back a plain Uint8Array, never a Buffer (CLAUDE.md, Stage 1a scar).
    return Buffer.from(result.pixels.buffer, result.pixels.byteOffset, result.pixels.byteLength);
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest test/render` then `npm run build` (the build must emit `dist/render/playlistWindowRenderWorker.js`).
Expected: PASS; the file exists under `dist/render/`.

- [ ] **Step 5: Real worker-boundary check (not a unit test — CLAUDE.md "Verify against real binaries")** — after `npm run build`, run once in the Docker image (where the real fonts exist):

```bash
docker compose run --rm super-dj node -e "
const { renderPlaylistWindowFrame } = require('./dist/render/playlistWindowRenderPool');
const { computePlaylistWindowRegion } = require('./dist/render/playlistWindowGeometry');
const el = { type:'playlist', x:512, y:160, width:700, fontSize:22, color:{mode:'solid',color:'#ffffff'}, style:{fontFamily:'DejaVu Sans',bold:false,italic:false} };
const region = computePlaylistWindowRegion(el, {width:1280,height:720}, 10);
renderPlaylistWindowFrame({ element: el, region, rows: [{key:'a',text:'▶ Привіт, світ',top:0,left:0,opacity:1}] }).then((b) => {
  let alpha = 0; for (let i = 3; i < b.length; i += 4) alpha += b[i];
  console.log(JSON.stringify({ isBuffer: Buffer.isBuffer(b), bytes: b.length, expected: region.width*region.height*4, alpha }));
  process.exit(0);
});"
```

Expected: `isBuffer: true`, `bytes === expected`, `alpha > 0`. Then compare glyph coverage against a Latin string: the Cyrillic alpha sum must be of the same order (a tofu/missing-glyph render shows up as far lower or boxy coverage — CLAUDE.md's Stage 1a Cyrillic scar). Record the numbers in the task's commit message.

- [ ] **Step 6: Commit**

```bash
git add src/render/playlistWindowRenderWorker.ts src/render/playlistWindowRenderPool.ts test/render
git commit -m "feat(render): dedicated piscina pool for pipe:7 playlist-window frames"
```

---

### Task 6: `PlaylistWindowFeeder`

**Files:**
- Create: `src/ffmpeg/playlistWindowFeeder.ts`
- Test: `test/ffmpeg/playlistWindowFeeder.test.ts`

**Interfaces:**
- Consumes: `RawFramePacer` (Task 1); `WindowRow` (Task 2); `planWindowTransition`, `layoutSettled`, `layoutInsertFrame`, `INSERT_ANIMATION_MS`, `RowLayout` (Task 3); `PlaylistWindowRegion`, `PlaylistWindowFrameRequest` (Task 4); `renderPlaylistWindowFrame` (Task 5); `unpremultiplyRgbaInPlace` (`src/render/unpremultiply.ts`).
- Produces:

```ts
export interface PlaylistWindowFeederOptions {
  element: PlaylistElement;
  region: PlaylistWindowRegion;
  fps: number;
  renderFrame?: (req: PlaylistWindowFrameRequest) => Promise<Buffer>;
  nowMs?: () => number;
}
export class PlaylistWindowFeeder {
  constructor(options: PlaylistWindowFeederOptions);
  attach(pipe: NodeJS.WritableStream): void;
  setRows(rows: WindowRow[]): void;
  close(): void;
}
```

- [ ] **Step 1: Failing tests** — `test/ffmpeg/playlistWindowFeeder.test.ts`:

```ts
import { EventEmitter } from 'events';
import { PlaylistWindowFeeder } from '../../src/ffmpeg/playlistWindowFeeder';
import { WindowRow } from '../../src/playlist/window';

const REGION = { x: 0, y: 0, width: 4, height: 2, originX: 0, originY: 0, rowHeight: 28 };
const ELEMENT: any = { type: 'playlist', x: 0, y: 0, width: 4, fontSize: 22, color: { mode: 'solid', color: '#fff' }, style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } };
const row = (key: string, isCurrent = false): WindowRow => ({ key, text: key, isCurrent });
const BASE = [row('b:0', true), row('b:1'), row('b:2')];
const WITH_INSERT = [row('b:0', true), row('i:0'), row('b:1'), row('b:2')];
const WITH_TWO = [row('b:0', true), row('i:0'), row('i:1'), row('b:1'), row('b:2')];
const ADVANCED = [row('b:0'), row('i:0', true), row('b:1')];

function fakePipe() {
  const pipe: any = new EventEmitter();
  pipe.writes = [] as Buffer[];
  pipe.write = (b: Buffer) => { pipe.writes.push(b); return true; };
  return pipe;
}

async function flush() { for (let i = 0; i < 5; i++) await Promise.resolve(); }

function setup() {
  jest.useFakeTimers();
  const clock = { ms: 0 };
  const requests: any[] = [];
  const renderFrame = jest.fn(async (req: any) => { requests.push(req); return Buffer.alloc(REGION.width * REGION.height * 4, 7); });
  const feeder = new PlaylistWindowFeeder({ element: ELEMENT, region: REGION, fps: 30, renderFrame, nowMs: () => clock.ms });
  const pipe = fakePipe();
  const advance = async (ms: number) => { clock.ms += ms; jest.advanceTimersByTime(ms); await flush(); };
  return { feeder, pipe, renderFrame, requests, advance, clock };
}

describe('PlaylistWindowFeeder', () => {
  afterEach(() => jest.useRealTimers());

  it('writes fully transparent frames before any render (never stalls the encoder, C10)', async () => {
    const { feeder, pipe, advance } = setup();
    feeder.attach(pipe);
    await advance(100);
    expect(pipe.writes.length).toBeGreaterThan(0);
    expect(pipe.writes[0].every((b: number) => b === 0)).toBe(true);
    expect(pipe.writes[0].length).toBe(REGION.width * REGION.height * 4);
    feeder.close();
  });

  it('first setRows snaps: one settled render, then only resends', async () => {
    const { feeder, pipe, renderFrame, advance } = setup();
    feeder.attach(pipe);
    feeder.setRows(BASE);
    await advance(500);
    expect(renderFrame).toHaveBeenCalledTimes(1);
    feeder.close();
  });

  it('identical rows render nothing (C18)', async () => {
    const { feeder, pipe, renderFrame, advance } = setup();
    feeder.attach(pipe);
    feeder.setRows(BASE);
    await advance(100);
    feeder.setRows(BASE.map((r) => ({ ...r })));
    await advance(500);
    expect(renderFrame).toHaveBeenCalledTimes(1);
    feeder.close();
  });

  it('an insert animates for ~600ms with at most one render in flight, then a final settled render', async () => {
    const { feeder, pipe, renderFrame, requests, advance } = setup();
    feeder.attach(pipe);
    feeder.setRows(BASE);
    await advance(100);
    renderFrame.mockClear(); requests.length = 0;
    feeder.setRows(WITH_INSERT);
    await advance(700);
    expect(renderFrame.mock.calls.length).toBeGreaterThan(5);
    expect(renderFrame.mock.calls.length).toBeLessThanOrEqual(20);
    const last = requests[requests.length - 1].rows;
    expect(last.every((r: any) => r.opacity === 1 && r.left === 0)).toBe(true);
    expect(last.map((r: any) => r.key)).toEqual(['b:0', 'i:0', 'b:1', 'b:2']);
    await advance(500);
    expect(renderFrame.mock.calls.length).toBeLessThanOrEqual(20); // settled again, no more renders
    feeder.close();
  });

  it('never has two renders in flight', async () => {
    const { feeder, pipe, advance } = setup();
    let inFlight = 0; let maxInFlight = 0;
    (feeder as any).options.renderFrame = async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 80)); inFlight--; return Buffer.alloc(32); };
    feeder.attach(pipe);
    feeder.setRows(BASE);
    await advance(200);
    feeder.setRows(WITH_INSERT);
    for (let i = 0; i < 20; i++) await advance(40);
    expect(maxInFlight).toBe(1);
    feeder.close();
  });

  it('two inserts within one animation coalesce into exactly one follow-up (C3)', async () => {
    const { feeder, pipe, requests, advance } = setup();
    feeder.attach(pipe);
    feeder.setRows(BASE);
    await advance(100);
    feeder.setRows(WITH_INSERT);
    await advance(100);
    feeder.setRows(WITH_TWO);
    await advance(2000);
    const finalRows = requests[requests.length - 1].rows.map((r: any) => r.key);
    expect(finalRows).toEqual(['b:0', 'i:0', 'i:1', 'b:1', 'b:2']);
    // The follow-up animated i:1 in (some frame had it at partial opacity).
    expect(requests.some((q: any) => q.rows.some((r: any) => r.key === 'i:1' && r.opacity > 0 && r.opacity < 1))).toBe(true);
    feeder.close();
  });

  it('a track advance mid-animation abandons it and snaps immediately (C2)', async () => {
    const { feeder, pipe, requests, advance } = setup();
    feeder.attach(pipe);
    feeder.setRows(BASE);
    await advance(100);
    feeder.setRows(WITH_INSERT);
    await advance(100);
    feeder.setRows(ADVANCED);
    await advance(100);
    const last = requests[requests.length - 1].rows;
    expect(last.map((r: any) => r.key)).toEqual(['b:0', 'i:0', 'b:1']);
    expect(last.every((r: any) => r.opacity === 1)).toBe(true);
    const countAfterSnap = requests.length;
    await advance(1000);
    expect(requests.length).toBe(countAfterSnap); // no zombie animation frames
    feeder.close();
  });

  it('a render resolving after close() never writes (C8)', async () => {
    const { feeder, pipe, advance } = setup();
    let resolveRender!: (b: Buffer) => void;
    (feeder as any).options.renderFrame = () => new Promise<Buffer>((r) => { resolveRender = r; });
    feeder.attach(pipe);
    feeder.setRows(BASE);
    await advance(50);
    feeder.close();
    const before = pipe.writes.length;
    resolveRender(Buffer.alloc(32, 9));
    await advance(500);
    expect(pipe.writes.length).toBe(before);
  });

  it('a failed render logs and keeps resending the last good frame (C9)', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { feeder, pipe, renderFrame, advance } = setup();
    feeder.attach(pipe);
    feeder.setRows(BASE);
    await advance(100);
    renderFrame.mockRejectedValueOnce(new Error('boom'));
    feeder.setRows(WITH_INSERT);
    await advance(100);
    expect(errorSpy).toHaveBeenCalled();
    // Still the last good settled frame: its alpha byte is 7 (unpremultiply never changes alpha),
    // not the all-zero transparent placeholder.
    expect(pipe.writes[pipe.writes.length - 1][3]).toBe(7);
    errorSpy.mockRestore();
    feeder.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/ffmpeg/playlistWindowFeeder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/ffmpeg/playlistWindowFeeder.ts`:

```ts
import { RawFramePacer } from './rawFramePacer';
import { WindowRow } from '../playlist/window';
import { planWindowTransition, layoutSettled, layoutInsertFrame, INSERT_ANIMATION_MS, RowLayout, WindowTransition } from './playlistWindowTransition';
import { PlaylistWindowRegion } from '../render/playlistWindowGeometry';
import { PlaylistWindowFrameRequest } from '../render/sceneRenderer';
import { PlaylistElement } from '../templates/templateTypes';
import { renderPlaylistWindowFrame } from '../render/playlistWindowRenderPool';
import { unpremultiplyRgbaInPlace } from '../render/unpremultiply';

export interface PlaylistWindowFeederOptions {
  element: PlaylistElement;
  region: PlaylistWindowRegion;
  fps: number;
  renderFrame?: (req: PlaylistWindowFrameRequest) => Promise<Buffer>;
  nowMs?: () => number;
}

type InsertTransition = Extract<WindowTransition, { kind: 'insert' }>;

/**
 * Owns pipe:7: turns "which rows should the playlist window show" into a continuously paced raw
 * RGBA stream, animating insertions. One purpose; the three things it composes each live
 * elsewhere — pacing (RawFramePacer), what to animate (planWindowTransition), how a frame looks
 * (the shared Satori row builder, rendered in its own pool).
 *
 * State: `target` is what the window is heading to; `animation` is an in-flight insert (at most
 * one); `pending` is the latest snapshot that arrived during it (coalesced — only the newest
 * matters). A snap abandons any animation: a cosmetic transition must never delay showing the
 * real now-playing state.
 */
export class PlaylistWindowFeeder {
  private readonly pacer: RawFramePacer;
  private readonly nowMs: () => number;
  private target: WindowRow[] = [];
  private animation: { plan: InsertTransition; startedAtMs: number } | null = null;
  private pending: WindowRow[] | null = null;
  private needsSettledRender = false;
  private rendering = false;
  private generation = 0;
  private closed = false;
  private tickTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: PlaylistWindowFeederOptions) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.pacer = new RawFramePacer({ fps: options.fps, now: () => this.nowMs() / 1000 });
    // Fully transparent until the first render lands, so ffmpeg's overlay frame-sync never waits
    // on this pipe (spec C10) — and the fallback if nothing ever renders.
    this.pacer.setFrame(Buffer.alloc(options.region.width * options.region.height * 4));
  }

  attach(pipe: NodeJS.WritableStream): void {
    this.pacer.attach(pipe);
    this.tickTimer = setInterval(() => this.tick(), 1000 / this.options.fps);
    this.tickTimer.unref();
    this.pacer.writeDueFrames();
  }

  setRows(rows: WindowRow[]): void {
    if (this.closed) return;
    if (this.animation) {
      const t = planWindowTransition(this.animation.plan.to, rows);
      if (t.kind === 'none') { this.pending = null; return; }
      if (t.kind === 'insert') { this.pending = rows; return; }
      this.snapTo(rows);
      return;
    }
    const t = planWindowTransition(this.target, rows);
    if (t.kind === 'none') return;
    if (t.kind === 'insert') {
      this.generation += 1;
      this.animation = { plan: t, startedAtMs: this.nowMs() };
      this.target = rows;
      return;
    }
    this.snapTo(rows);
  }

  close(): void {
    this.closed = true;
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    this.pacer.detach();
  }

  private snapTo(rows: WindowRow[]): void {
    this.generation += 1;
    this.animation = null;
    this.pending = null;
    this.target = rows;
    this.needsSettledRender = true;
  }

  private tick(): void {
    try {
      this.pacer.writeDueFrames();
      if (this.rendering || this.closed) return;
      if (this.animation) {
        const elapsed = this.nowMs() - this.animation.startedAtMs;
        if (elapsed >= INSERT_ANIMATION_MS) {
          this.animation = null;
          this.needsSettledRender = true;
          if (this.pending) {
            const next = this.pending;
            this.pending = null;
            this.setRows(next); // insert -> a new animation from `target`; snap -> settled render
          }
        } else {
          this.dispatch(layoutInsertFrame(this.animation.plan, this.options.region.rowHeight, elapsed));
          return;
        }
      }
      if (this.needsSettledRender && !this.animation) {
        this.needsSettledRender = false;
        this.dispatch(layoutSettled(this.target, this.options.region.rowHeight));
      }
    } catch (err) {
      // A bare setInterval callback: an uncaught throw would kill every tenant's stream.
      console.error('playlist window tick failed, resending the last good frame', err);
    }
  }

  private dispatch(rows: RowLayout[]): void {
    const generation = this.generation;
    const render = this.options.renderFrame ?? renderPlaylistWindowFrame;
    this.rendering = true;
    render({ element: this.options.element, region: this.options.region, rows })
      .then((pixels) => {
        // Stale (a snap superseded it) or torn down (encoder died, C8): never write it.
        if (this.closed || generation !== this.generation) return;
        unpremultiplyRgbaInPlace(pixels);
        this.pacer.setFrame(pixels);
        this.pacer.writeDueFrames();
      })
      .catch((err) => {
        console.error('playlist window frame render failed, resending the last good frame', err);
      })
      .finally(() => {
        this.rendering = false;
      });
  }
}
```

Note the stale-generation guard: an animation frame in flight when a snap arrives is discarded, and the snap's settled render goes out on the next tick.

- [ ] **Step 4: Run to verify pass**

Run: `npx jest test/ffmpeg/playlistWindowFeeder.test.ts`
Expected: PASS. If timing-sensitive assertions are flaky because the settled render after a snap waits for the in-flight frame to finish, that is the designed behaviour: adjust `advance` amounts, not the class.

- [ ] **Step 5: Commit**

```bash
git add src/ffmpeg/playlistWindowFeeder.ts test/ffmpeg/playlistWindowFeeder.test.ts
git commit -m "feat(ffmpeg): PlaylistWindowFeeder — paced pipe:7 frames with coalesced insert animations"
```

---

### Task 7: Encoder args, `pipe:7`, spawner

**Files:**
- Modify: `src/ffmpeg/persistentEncoderArgs.ts`, `src/ffmpeg/persistentEncoder.ts` (pass-through of the new option, if it forwards params explicitly), `src/ffmpeg/types.ts`, `src/server.ts` (`createPipeSpawner`)
- Test: `test/ffmpeg/persistentEncoderArgs.test.ts`, `test/ffmpeg/persistentEncoder.test.ts` (if it builds a fake child), `test/server.test.ts` (if it asserts stdio length)

**Interfaces:**
- Produces: `buildPersistentEncoderArgs({ ..., playlistWindow?: { x: number; y: number; width: number; height: number; fps: number } })`; `ChildProcessWithPipes.playlistWindowPipe: NodeJS.WritableStream`.

- [ ] **Step 1: Failing tests** — in `test/ffmpeg/persistentEncoderArgs.test.ts`:

```ts
  describe('playlist window layer (pipe:7)', () => {
    const base = { width: 1280, height: 720, fps: 30, heartbeatFps: 5, rtmpUrl: 'rtmp://h/live', streamKey: 'k', backgroundPath: '/bg.png' };
    const PW = { x: 510, y: 158, width: 704, height: 312, fps: 30 };

    it('is absent unless configured: args byte-identical to today (C11)', () => {
      expect(buildPersistentEncoderArgs({ ...base })).toEqual(buildPersistentEncoderArgs({ ...base, playlistWindow: undefined }));
      expect(buildPersistentEncoderArgs({ ...base }).join(' ')).not.toContain('pipe:7');
    });

    it('declares pipe:7 as rgba at its own fps, last among inputs', () => {
      const args = buildPersistentEncoderArgs({ ...base, playlistWindow: PW });
      const i = args.indexOf('pipe:7');
      expect(args.slice(i - 9, i + 1)).toEqual(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '704x312', '-r', '30', '-i', 'pipe:7']);
      expect(args.lastIndexOf('-i')).toBe(i - 1);
    });

    it('composites after the top canvas and before the equalizer', () => {
      const args = buildPersistentEncoderArgs({ ...base, playlistWindow: PW, equalizer: { x: 0, y: 600, width: 400, height: 100 } });
      const graph = args[args.indexOf('-filter_complex') + 1];
      // inputs: 0 canvas, 1 audio, 2 bg, 3 pulse, 4 playlist window
      expect(graph).toContain('[4:v]format=yuva420p[plwin]');
      expect(graph).toContain('[vcanvas_top][plwin]overlay=510:158[vplwin]');
      expect(graph).toContain('[vplwin][pulse]overlay=0:600[vout]');
    });

    it('with a split canvas the index follows the above-canvas input', () => {
      const args = buildPersistentEncoderArgs({ ...base, playlistWindow: PW, canvasPlacement: 'split', gifOverlays: [{ x: 0, y: 0, width: 10, height: 10, filePath: '/g.gif', frameCount: 3 }] });
      const graph = args[args.indexOf('-filter_complex') + 1];
      // 0 canvas, 1 audio, 2 bg, 3 gif, 4 above canvas, 5 playlist window
      expect(graph).toContain('[5:v]format=yuva420p[plwin]');
    });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/ffmpeg/persistentEncoderArgs.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`persistentEncoderArgs.ts`: add `playlistWindow?: { x: number; y: number; width: number; height: number; fps: number };` to params, destructure it, and:

```ts
  const playlistWindowInputIndex = aboveCanvasInputIndex + (canvasPlacement === 'split' ? 1 : 0);
```

Append to `inputs` (after the split entry):

```ts
    // The playlist window's own continuously paced layer (PlaylistWindowFeeder) — present only
    // when the template has a playlist element. Declared last so no earlier input index moves.
    // Its motion is computed and rendered in Node: ffmpeg's overlay/drawbox refuse runtime x/y
    // commands (sendcmd spike: "Function not implemented"), so this is a static-position overlay.
    ...(playlistWindow
      ? ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${playlistWindow.width}x${playlistWindow.height}`, '-r', String(playlistWindow.fps), '-i', 'pipe:7']
      : []),
```

After the `vcanvas_top` block and before `if (equalizer)`:

```ts
  if (playlistWindow) {
    // Even x/y (computePlaylistWindowRegion guarantees it) so yuv420 compositing places it exactly
    // without GIF_OVERLAY_FORMAT's RGB round trip.
    filterLines.push(`[${playlistWindowInputIndex}:v]format=yuva420p[plwin]`);
    filterLines.push(`[${videoPad}][plwin]overlay=${playlistWindow.x}:${playlistWindow.y}[vplwin]`);
    videoPad = 'vplwin';
  }
```

`types.ts`: add to `ChildProcessWithPipes`:

```ts
  // The playlist window layer (fd 7), fed only when the template has a playlist element — see
  // PlaylistWindowFeeder. Same "always present, sometimes written" arrangement as pulsePipe.
  readonly playlistWindowPipe: NodeJS.WritableStream;
```

`server.ts` `createPipeSpawner`: stdio gets an eighth `'pipe'`; `const playlistWindowPipe = stdio[7];`, `playlistWindowPipe.on('error', (err) => { console.error('playlist window pipe write error', err); });`, include it in the `Object.assign`. Update the fd comment to "fd3/fd4/fd5/fd6/fd7 are video/audio/pulse/above-canvas/playlist-window". If `PersistentEncoder` forwards named params into `buildPersistentEncoderArgs`, add `playlistWindow` to its options and pass it through. Update any fake encoder child in tests to include `playlistWindowPipe: {}`.

- [ ] **Step 4: Run to verify pass**

Run: `npx jest test/ffmpeg test/server.test.ts` then `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ffmpeg src/server.ts test
git commit -m "feat(ffmpeg): optional pipe:7 playlist-window layer in the persistent encoder"
```

---

### Task 8: Wire it through `buildStreamScene` and `StreamController`

**Files:**
- Modify: `src/stream/streamScene.ts`, `src/stream/streamController.ts`, `src/ffmpeg/overlayText.ts` (delete the two window-line builders), `src/playlist/queue.ts` (only if `positionInBase` has no remaining caller — keep it if tests still use it)
- Test: `test/stream/streamScene.test.ts`, `test/stream/streamController.test.ts`, `test/ffmpeg/overlayText.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `StreamScene.buildOverlay: (track: Track, windowRows: WindowRow[]) => Promise<NowPlayingOverlay>`; `StreamScene.createPlaylistWindowFeeder?: () => PlaylistWindowFeeder`; `StreamControllerDeps.createPlaylistWindowFeeder?: () => { attach(pipe: NodeJS.WritableStream): void; setRows(rows: WindowRow[]): void; close(): void }`; `export const PLAYLIST_WINDOW_FPS = VIDEO_FPS;` in `streamScene.ts`.

- [ ] **Step 1: Failing tests**

`test/stream/streamScene.test.ts` — add a new `describe` using the file's existing `buildDeps()`/`params`/mocked `renderTemplatePng` (with the same `beforeEach` clearing block as the existing describes):

```ts
describe('buildStreamScene — playlist window layer (pipe:7)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (renderTemplatePng as jest.Mock).mockResolvedValue(Buffer.from('fake-png'));
    (getImageFrameCount as jest.Mock).mockResolvedValue(1);
  });

  const style = { fontFamily: 'DejaVu Sans', bold: false, italic: false };
  const playlistEl = (x: number, y: number) => ({ type: 'playlist', x, y, width: 400, fontSize: 20, color: { mode: 'solid', color: '#ffffff' }, style });
  const titleEl = { type: 'title', x: 0, y: 0, width: 100, fontSize: 20, color: { mode: 'solid', color: '#ffffff' }, style };
  const ROWS = [{ key: 'b:0', text: '▶ a', isCurrent: true }];
  const encoderArgs = async (deps: StreamSceneDeps, p: typeof params & { templateId?: string }) => {
    const pipeSpawner = jest.fn().mockReturnValue({ once: jest.fn(), kill: jest.fn(), pid: 1, stdout: null, stderr: null });
    const scene = await buildStreamScene({ ...deps, pipeSpawner } as unknown as StreamSceneDeps, p);
    scene.createPersistentEncoder({ rtmpUrl: 'rtmp://x/live', streamKey: 'k' }).start(() => {});
    return { scene, args: pipeSpawner.mock.calls[0][1] as string[] };
  };

  it('moves the default template\'s playlist element out of the baked canvas onto pipe:7', async () => {
    const { deps } = buildDeps();
    const { scene, args } = await encoderArgs(deps, params);
    expect(scene.createPlaylistWindowFeeder).toBeDefined();
    expect(args).toContain('pipe:7');
    await scene.buildOverlay(scene.tracks[0], ROWS);
    const baked = (renderTemplatePng as jest.Mock).mock.calls[0][0].elements;
    expect(baked.some((e: { type: string }) => e.type === 'playlist')).toBe(false);
  });

  it('a template without a playlist element has no feeder and no pipe:7', async () => {
    const { deps, templateRepository } = buildDeps();
    templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [titleEl] });
    const { scene, args } = await encoderArgs(deps, { ...params, templateId: 'tpl-1' });
    expect(scene.createPlaylistWindowFeeder).toBeUndefined();
    expect(args).not.toContain('pipe:7');
  });

  it('a playlist element entirely off-canvas gets no layer', async () => {
    const { deps, templateRepository } = buildDeps();
    templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [playlistEl(1400, 10)] });
    const { scene, args } = await encoderArgs(deps, { ...params, templateId: 'tpl-1' });
    expect(scene.createPlaylistWindowFeeder).toBeUndefined();
    expect(args).not.toContain('pipe:7');
  });

  it('a second playlist element stays baked and receives the rows as lines (C12)', async () => {
    const { deps, templateRepository } = buildDeps();
    templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [playlistEl(10, 10), playlistEl(600, 10)] });
    const { scene } = await encoderArgs(deps, { ...params, templateId: 'tpl-1' });
    await scene.buildOverlay(scene.tracks[0], ROWS);
    const call = (renderTemplatePng as jest.Mock).mock.calls[0][0];
    expect(call.elements).toEqual([playlistEl(600, 10)]);
    expect(call.playlistLines).toEqual(['▶ a']);
  });
});
```

Also update the existing assertion `expect(renderTemplatePng).toHaveBeenCalledWith(expect.objectContaining({ elements: DEFAULT_TEMPLATE_ELEMENTS }))` to `elements: DEFAULT_TEMPLATE_ELEMENTS.filter((e) => e.type !== 'playlist')`, and every existing `scene.buildOverlay(track)` call in the file to `scene.buildOverlay(track, [])`.

`test/stream/streamController.test.ts`: in `buildDeps()` add `windowSnapshot: jest.fn().mockReturnValue([{ key: 'b:0', text: '▶ a', isCurrent: true }])` to the queue fake and `playlistWindowPipe: {}` to `encoderChild`. Change the `buildOverlay` fake to `jest.fn((t: Track, _rows: unknown) => …)`. Add:

```ts
  describe('playlist window feeder', () => {
    function withFeeder() {
      const ctx = buildDeps();
      const feeder = { attach: jest.fn(), setRows: jest.fn(), close: jest.fn() };
      ctx.deps.createPlaylistWindowFeeder = jest.fn().mockReturnValue(feeder);
      return { ...ctx, feeder };
    }

    it('attaches to the encoder\'s pipe:7 and publishes rows when a track is fed', async () => {
      const { deps, feeder, encoderChild, queue } = withFeeder();
      await new StreamController(deps).start();
      expect(feeder.attach).toHaveBeenCalledWith(encoderChild.playlistWindowPipe);
      expect(feeder.setRows).toHaveBeenCalledWith(queue.windowSnapshot.mock.results[0].value);
      expect(deps.buildOverlay).toHaveBeenCalledWith(expect.anything(), queue.windowSnapshot.mock.results[0].value);
    });

    it('enqueueTrack republishes rows (this is what triggers the insert animation)', async () => {
      const { deps, feeder } = withFeeder();
      const controller = new StreamController(deps);
      await controller.start();
      feeder.setRows.mockClear();
      controller.enqueueTrack({ name: 'd', audioPath: '/tmp/d.mp3', coverPath: null });
      expect(feeder.setRows).toHaveBeenCalledTimes(1);
    });

    it('enqueueTrack while reconnecting is a safe no-op for the window (C7)', async () => {
      const { deps } = withFeeder();
      const controller = new StreamController(deps);
      expect(() => controller.enqueueTrack({ name: 'd', audioPath: '/tmp/d.mp3', coverPath: null })).not.toThrow();
    });

    it('next() while paused republishes rows without feeding', async () => {
      const { deps, feeder } = withFeeder();
      const controller = new StreamController(deps);
      await controller.start();
      controller.pause();
      feeder.setRows.mockClear();
      await controller.next();
      expect(feeder.setRows).toHaveBeenCalledTimes(1);
    });

    it('stop() closes the feeder', async () => {
      const { deps, feeder } = withFeeder();
      const controller = new StreamController(deps);
      await controller.start();
      controller.stop();
      expect(feeder.close).toHaveBeenCalled();
    });
  });
```

`test/ffmpeg/overlayText.test.ts`: delete the `buildPlaylistWindowLines`/`buildInsertedTrackWindowLines` suites (their behaviour now lives in, and is tested by, `windowSnapshot`).

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/stream test/ffmpeg/overlayText.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`streamScene.ts`:
- Import `computePlaylistWindowRegion`, `PlaylistWindowFeeder`, `PLAYLIST_WINDOW_VISIBLE_ROWS`, `WindowRow`, `windowRowLines`, `PlaylistElement`; delete the `PLAYLIST_WINDOW_BEFORE/AFTER` constants (now in `src/playlist/window.ts`) and the `overlayText` window-builder import. Add `export const PLAYLIST_WINDOW_FPS = VIDEO_FPS;` with a comment pointing at the Task 9 fallback rule.
- After the equalizer detection:

```ts
  // The FIRST playlist element leaves the baked canvas for its own paced layer (pipe:7) so an
  // insert can animate; later ones (rare) stay baked and static, like before. See the 2026-09-23
  // spec, Phase C. An element placed entirely off-canvas gets no layer at all.
  const livePlaylistElement = templateElements.find((e): e is PlaylistElement => e.type === 'playlist') ?? null;
  const playlistRegion = livePlaylistElement
    ? computePlaylistWindowRegion(livePlaylistElement, { width: VIDEO_WIDTH, height: VIDEO_HEIGHT }, PLAYLIST_WINDOW_VISIBLE_ROWS)
    : null;
  const livePlaylist = livePlaylistElement && playlistRegion ? { element: livePlaylistElement, region: playlistRegion } : null;
```

- `isBaked`: add `&& e !== livePlaylist?.element`.
- `buildOverlay = async (track: Track, windowRows: WindowRow[])`: `const playlistLines = windowRowLines(windowRows);` (delete the old `currentIndex`/builder logic).
- `createPersistentEncoder`: add `playlistWindow: livePlaylist ? { x: livePlaylist.region.x, y: livePlaylist.region.y, width: livePlaylist.region.width, height: livePlaylist.region.height, fps: PLAYLIST_WINDOW_FPS } : undefined,`.
- Return `createPlaylistWindowFeeder: livePlaylist ? () => new PlaylistWindowFeeder({ element: livePlaylist.element, region: livePlaylist.region, fps: PLAYLIST_WINDOW_FPS }) : undefined,` and update the `StreamScene` interface (`buildOverlay` signature + the new optional factory; drop the `baseAnchorIndex` comment).

`src/stream/localStreamManager.ts`: pass `createPlaylistWindowFeeder: scene.createPlaylistWindowFeeder` into the `StreamController` deps.

`streamController.ts`:
- Import `WindowRow`, `PLAYLIST_WINDOW_BEFORE`, `PLAYLIST_WINDOW_AFTER`. Deps: `buildOverlay: (track: Track, windowRows: WindowRow[]) => Promise<NowPlayingOverlay>;` and `createPlaylistWindowFeeder?: () => PlaylistWindowFeederLike;` with `interface PlaylistWindowFeederLike { attach(pipe: NodeJS.WritableStream): void; setRows(rows: WindowRow[]): void; close(): void }`.
- Field `private playlistWindowFeeder: PlaylistWindowFeederLike | null = null;` — created/attached in `spawnPipeline()` (`this.playlistWindowFeeder.attach(child.playlistWindowPipe)` when the factory exists), closed and nulled in `teardown()`.
- `private windowRows(): WindowRow[] { return this.deps.queue.windowSnapshot(PLAYLIST_WINDOW_BEFORE, PLAYLIST_WINDOW_AFTER); }` and `private publishWindow(rows = this.windowRows()): void { this.playlistWindowFeeder?.setRows(rows); }`.
- `feedCurrentTrack`: `const rows = this.windowRows(); const overlay = await this.deps.buildOverlay(track, rows);` … after the generation/state re-check, right before `canvasFeeder.render`: `this.publishWindow(rows);`.
- `enqueueTrack`: `this.deps.queue.insertNext(track); this.publishWindow(); this.deps.onStatusChanged?.();`.
- `next()`/`previous()`: in the non-streaming branch (no feed) call `this.publishWindow();` (i.e. `else this.publishWindow();` after the `if (this.state === 'streaming')` feed).

`overlayText.ts`: delete `buildPlaylistWindowLines` and `buildInsertedTrackWindowLines`; keep `formatDuration` and the drawtext-escaping NOTE (it concerns `formatDuration`'s output). `PlaylistQueue.positionInBase()` stays as a public method (Phase B's queue test uses it, and it documents the anchor `windowSnapshot` uses); update its comment to point at `windowSnapshot` instead of the deleted builder. Remove `positionInBase` from the controller test's queue fake only if nothing calls it.

- [ ] **Step 4: Run to verify pass**

Run: `npm test` then `npm run build`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/stream src/ffmpeg/overlayText.ts src/playlist test
git commit -m "feat(stream): drive the playlist window from the queue snapshot on its own animated layer"
```

---

### Task 9: Real-binary verification, performance measurement, docs

**Files:**
- Modify: `CLAUDE.md`; possibly `src/stream/streamScene.ts` (`PLAYLIST_WINDOW_FPS`) per the fallback rule
- Scratch (not committed): a verification script in your scratchpad directory

- [ ] **Step 1: Build the real image and write a harness** (scratch, run inside the container so it uses the repo's own ffmpeg 5.1.9 and fonts). The harness, in `node`, after `npm run build`:
  1. `const scene = await buildStreamScene(realishDeps, …)` is heavy to fake; instead construct directly: `buildPersistentEncoderArgs({ width:1280, height:720, fps:30, heartbeatFps:5, rtmpUrl:'/tmp/out', streamKey:'run.flv', backgroundPath:'/app/assets/background.png', playlistWindow: { ...region, fps: 30 } })` (region from `computePlaylistWindowRegion` for the default element), spawn it with the real `createPipeSpawner()`, and attach a real `CanvasFeeder` (a blank overlay PNG), a silent PCM writer on `audioPipe` (a 44.1 kHz stereo s16le zero buffer paced at real time), and a real `PlaylistWindowFeeder` with the real pool.
  2. `setRows` with a 10-track settled window at t=0; at t=10 s `setRows` with one row inserted after the current; at t=10.2 s another (coalescing); at t=20 s a track-advance snapshot; run 60 s; then `stop`.
  3. A second 60 s run, identical but with `playlistWindow: undefined` and no feeder (the baseline).

- [ ] **Step 2: Pixel checks** on `/tmp/out/run.flv`:

```bash
ffmpeg -v error -ss 9.9 -i /tmp/out/run.flv -frames:v 1 -vf "crop=${W}:${H}:${X}:${Y}" -f rawvideo -pix_fmt rgb24 /tmp/before.rgb
ffmpeg -v error -ss 10.3 -i /tmp/out/run.flv -frames:v 1 -vf "crop=${W}:${H}:${X}:${Y}" -f rawvideo -pix_fmt rgb24 /tmp/mid.rgb
ffmpeg -v error -ss 11.5 -i /tmp/out/run.flv -frames:v 1 -vf "crop=${W}:${H}:${X}:${Y}" -f rawvideo -pix_fmt rgb24 /tmp/after.rgb
```

Using a small node script, compute each image's per-row luma profile (sum per pixel row): `mid` must differ from both `before` and `after` (motion actually happened on video, not just in Node); `after` must show one more text row than `before`; frames at 30 fps between 10.0 and 10.6 s must show a monotonic shift of the row below the insertion point. Check there's no bright/dark fringe: luma along text edges in `after` must not exceed the text colour's luma (straight-alpha check, C17). Check the region boundary: pixels 2 px outside the region equal the background run (exact placement, C13).

- [ ] **Step 3: Timing and cost** — from each run's ffmpeg stderr take the steady-state `speed=` (median of the last 30 progress lines) and sample `ps -o %cpu,rss` of the ffmpeg and node processes every second (median). Record: speed with/without, ffmpeg CPU with/without, node CPU with/without, peak node RSS during the insert burst, and the number of renders per insert (log a counter from the feeder in the harness).
  **Fallback rule (spec "Cost"):** if speed with the layer is < 0.98x, or ffmpeg CPU rises by more than 10 percentage points of one core over the baseline, set `PLAYLIST_WINDOW_FPS = 15` in `streamScene.ts`, rerun, and record both runs. Either way, check that the output's total duration is within ±1 frame of wall-clock run time (no timeline drift — the CanvasFeeder heartbeat scar).

- [ ] **Step 4: Live look** — deploy to the stand (re-apply and verify the port-8088 mapping), start a stream with the default template, trigger two rule "Test" requests (one `songRequest`, one `libraryTrackRequest` via a copied command) a few seconds apart, and watch the HLS preview. The window should show each arrive with a slide, then show them queued. Press next during an animation: it should cut instantly to the new current track.

- [ ] **Step 5: CLAUDE.md**
  - Under "Backend streaming pipeline", add a bullet: "**`PlaylistWindowFeeder` owns the playlist window (fd 7 / `pipe:7`)**: the first `playlist` element is no longer baked; it's rendered region-sized (even origin, `rowHeight = round(1.25·fontSize)`, single-line rows) in its own piscina pool and paced by `RawFramePacer` (extracted from `PulseVisualizer`) at `PLAYLIST_WINDOW_FPS`. `PlaylistQueue.windowSnapshot()` gives keyed rows (queued tracks included); `planWindowTransition` animates an insert (600 ms, coalesced, abandoned on any snap) and snaps everything else. Why not ffmpeg-side motion: `sendcmd`/`zmq` reach `overlay`/`drawbox`, which answer `Function not implemented` for x/y. Measured cost: <numbers from Step 3>." Plus the composite order note (above the canvas/timer/gifs, below the equalizer).
  - Update the `types.ts` fd list in the Layout tree to include `fd7 playlist window`; add the new files (`rawFramePacer.ts`, `playlistWindowFeeder.ts`, `playlistWindowTransition.ts`, `src/playlist/window.ts`, `playlistWindowGeometry.ts`, `playlistWindowRender{Worker,Pool}.ts`).
  - In "Donation-triggered song requests", replace the `positionInBase()`/`buildInsertedTrackWindowLines()` sentence (from Phase B) with "the overlay's playlist window lists queued tracks via `PlaylistQueue.windowSnapshot()` and animates each insertion (see `PlaylistWindowFeeder`)".

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md src/stream/streamScene.ts
git commit -m "docs: record pipe:7 playlist-window layer and its measured cost"
```
