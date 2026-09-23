# Donation Library-Track Requests — Phase C (animated playlist window, burst-only layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revised 2026-09-23 per user decision:** the settled playlist window stays baked in the main canvas exactly as today; the new `pipe:7` is a burst-only layer (idle = transparent) that shows the insert animation on top, with a handoff protocol to and from the baked window. Tasks 1–2 are unchanged from the first version; Tasks 3–10 are rewritten.

**Goal:** When a track is queued, the overlay's playlist window shows it arriving with a smooth 600 ms animation, while every stream's settled appearance stays exactly as it is today.

**Architecture:** The baked Satori canvas keeps drawing the window, now from `PlaylistQueue.windowSnapshot()`, so it also lists queued tracks. A per-session `pipe:7` exists whenever the template has a playlist element. It is fed a transparent yuva420p frame by a `RawFramePacer` (extracted from `PulseVisualizer`) while idle. On an insert, a `PlaylistWindowAnimator` runs the handoff:
1. frame 0 (identical to the baked window) → hold
2. canvas re-baked without the window (variant A) → hold
3. 600 ms animation rendered by `PlaylistWindowFeeder` from the SAME Satori node as the baked window, in a dedicated piscina pool
4. canvas re-baked with the new rows (variant B) → hold
5. idle

**Tech Stack:** TypeScript, Satori + @resvg/resvg-js, piscina 4, ffmpeg (real binary only in Task 10), Jest.

**Spec:** `docs/superpowers/specs/2026-09-23-donation-library-track-request-design.md` — section "Phase C", edge cases C1–C22, judgment calls #1, #3–#7, #14–#16.

## Global Constraints

- Requires Phases B and A merged (`StreamController.enqueueTrack` exists).
- **Do not** use `sendcmd`/`zmq`/runtime filter-graph expressions for motion (spike: `overlay`/`drawbox` answer `Function not implemented`). ffmpeg composites a static-position overlay only; whether `pipe:7` exists is decided once, when the encoder spawns.
- **The settled window's appearance must not change.** The baked node is refactored into `playlistWindowNode(el, rows, origin)`, and with no animation props it must be byte-identical to today's `case 'playlist'` node. `test/render/sceneRenderer.test.ts` must pass **unmodified**.
- fd 7 / `pipe:7` / `ChildProcessWithPipes.playlistWindowPipe`. fds 3/4/5/6 unchanged. The input is appended last.
- Pipe format: `-f rawvideo -pix_fmt yuva420p -s WxH -r <PLAYLIST_WINDOW_FPS> -i pipe:7`. `PLAYLIST_WINDOW_FPS = 30`; Task 10's measured fallback rule may set it to 15.
- Idle frame: precomputed yuva420p, A = 0, Y = 16, U = V = 128; never rendered.
- RGBA → yuva420p conversion in the worker: unpremultiply, then BT.601 **limited range**. Y = 16 + (65.481R + 128.553G + 24.966B)/255; U = 128 + (−37.797R − 74.203G + 112.0B)/255; V = 128 + (112.0R − 93.786G − 18.214B)/255. Chroma is the average of each 2×2 block. A is copied at full resolution.
- Composite position: directly after the canvas layer containing the playlist element (`'below'` → after `[vcanvas_below]`, `'top'` → after `[vcanvas_top]`), always before the equalizer.
- Region: `pad = ceil(stroke.width + max(|shadow.offsetX|,|shadow.offsetY|) + shadow.blur) + 2`. Height bound `ceil((PLAYLIST_WINDOW_VISIBLE_ROWS + 1) × fontSize × 1.4)`. Origin even, size even, clamped to 1280×720. Default template → 704×342 at (510,158).
- Animation: 600 ms total.
  - The new row's `maxHeightFactor` goes 0 → 1.5 over 0–360 ms, ease-in-out cubic.
  - Rows pushed out fade 1 → 0 over 0–360 ms.
  - New rows go opacity 0 → 1 and `offsetX` 24 → 0 over 240–600 ms, ease-out cubic.
  - Progress is wall-clock, with at most one render in flight.
- Handoff: `HANDOFF_HOLD_MS = 2 × CANVAS_HEARTBEAT_MS` (400). Order: frame 0 → hold → canvas A → hold → animate → canvas B → hold → idle. Any `feedCurrentTrack`/teardown aborts. Inserts during a burst coalesce into one follow-up.
- piscina pool: `useAtomics: false`, returned `Uint8Array` rewrapped with `Buffer.from(buf.buffer, byteOffset, byteLength)`, resvg `font: { loadSystemFonts: false }`.
- No playlist element (or off-canvas) → no pipe input, no feeder, no animator, and encoder args byte-identical to today.
- Unit tests never spawn ffmpeg; Task 10 is the mandatory real-binary verification.
- Commit trailer: `Co-Authored-By: Claude Opus <noreply@anthropic.com>` (or the trailer matching the model actually committing).

## Review Focus

- A stream that never gets anything queued must look byte-for-byte as it does today — pinned in Task 4 (`sceneRenderer.test.ts` unmodified, plus a node-equality test) and Task 9 (the baked lines equal today's when nothing is queued).
- A track change during a burst must show the new track's full overlay (window included) with no stale moving rows left on top — pinned in Tasks 7 and 9.
- Two donations landing within one burst must produce exactly one follow-up burst that includes both — pinned in Task 7.
- The encoder must never stall waiting on `pipe:7`, including before anything has rendered — pinned in Task 6 (idle transparent frames written from `attach()`) and verified for real in Task 10.
- The timer's once-a-second re-render during a burst must re-render variant A (window omitted), never the old baked window under the moving rows — pinned in Task 9.

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

Create `src/playlist/window.ts` with the interface, constants and `windowRowLines` above (plus a doc comment: "keys are per queue ENTRY, stable across renders — what lets PlaylistWindowAnimator diff the baked snapshot against the new one into an insert animation").

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

### Task 3: Transition planning and animated row props (pure)

**Files:**
- Create: `src/ffmpeg/playlistWindowTransition.ts`
- Test: `test/ffmpeg/playlistWindowTransition.test.ts`

**Interfaces:**
- Consumes: `WindowRow` (Task 2).
- Produces:

```ts
export const INSERT_ANIMATION_MS = 600;
// A row as the Satori node receives it. NO optional prop set = today's exact baked row.
export interface AnimatedRow { key: string; text: string; opacity?: number; offsetX?: number; maxHeightFactor?: number }
export type WindowTransition = { kind: 'none' } | { kind: 'snap' } | { kind: 'insert'; from: WindowRow[]; to: WindowRow[]; insertedKeys: Set<string> };
export type InsertTransition = Extract<WindowTransition, { kind: 'insert' }>;
export function planWindowTransition(from: WindowRow[], to: WindowRow[]): WindowTransition;
export function settledRows(rows: WindowRow[]): AnimatedRow[];
export function animatedRowsAt(t: InsertTransition, elapsedMs: number): AnimatedRow[];
```

- [ ] **Step 1: Failing tests**

```ts
import { planWindowTransition, settledRows, animatedRowsAt, INSERT_ANIMATION_MS, InsertTransition } from '../../src/ffmpeg/playlistWindowTransition';
import { WindowRow } from '../../src/playlist/window';

const row = (key: string, isCurrent = false): WindowRow => ({ key, text: `  ${key}`, isCurrent });
const FROM = [row('b:0'), row('b:1', true), row('b:2'), row('b:3')];
const TO = [row('b:0'), row('b:1', true), row('i:0'), row('b:2')];

describe('planWindowTransition', () => {
  it('none for identical rows', () => {
    expect(planWindowTransition(FROM, FROM.map((r) => ({ ...r })))).toEqual({ kind: 'none' });
  });
  it('snap from empty', () => {
    expect(planWindowTransition([], FROM).kind).toBe('snap');
  });
  it('insert after the current row, bottom row falling off', () => {
    const t = planWindowTransition(FROM, TO);
    expect(t.kind).toBe('insert');
    if (t.kind === 'insert') expect([...t.insertedKeys]).toEqual(['i:0']);
  });
  it('two inserts at once are one insert transition', () => {
    const to = [row('b:0'), row('b:1', true), row('i:0'), row('i:1'), row('b:2'), row('b:3')];
    const t = planWindowTransition(FROM, to);
    expect(t.kind === 'insert' && t.insertedKeys.size).toBe(2);
  });
  it('snap when the current row changes (a track advance, C5)', () => {
    expect(planWindowTransition(FROM, [row('b:1'), row('b:2', true), row('b:3')]).kind).toBe('snap');
  });
  it('snap when a shared row changed text', () => {
    expect(planWindowTransition(FROM, FROM.map((r) => (r.key === 'b:2' ? { ...r, text: 'renamed' } : r))).kind).toBe('snap');
  });
  it('snap when a row vanished from the middle', () => {
    expect(planWindowTransition(FROM, [row('b:0'), row('b:1', true), row('b:3')]).kind).toBe('snap');
  });
});

describe('animated rows', () => {
  const t = planWindowTransition(FROM, TO) as InsertTransition;
  const byKey = (rows: { key: string }[], key: string) => rows.find((r) => r.key === key) as any;

  it('settled rows carry NO animation props (so the Satori node is byte-identical to the baked one)', () => {
    expect(settledRows(TO)).toEqual(TO.map((r) => ({ key: r.key, text: r.text })));
    for (const r of settledRows(TO)) expect(Object.keys(r).sort()).toEqual(['key', 'text']);
  });

  it('t=0: the new row has zero height and is invisible; the pushed-out row is fully visible below', () => {
    const rows = animatedRowsAt(t, 0);
    expect(rows.map((r) => r.key)).toEqual(['b:0', 'b:1', 'i:0', 'b:2', 'b:3']);
    expect(byKey(rows, 'i:0')).toMatchObject({ maxHeightFactor: 0, opacity: 0, offsetX: 24 });
    expect(byKey(rows, 'b:3')).toMatchObject({ opacity: 1 });
    expect(Object.keys(byKey(rows, 'b:2'))).toEqual(['key', 'text']); // kept rows untouched
  });

  it('by 360ms the gap is fully open and the pushed-out row gone; the content only starts after 240ms', () => {
    expect(byKey(animatedRowsAt(t, 200), 'i:0').opacity).toBe(0);
    const rows = animatedRowsAt(t, 360);
    expect(byKey(rows, 'i:0').maxHeightFactor).toBeCloseTo(1.5);
    expect(byKey(rows, 'b:3').opacity).toBe(0);
  });

  it('at the end it is exactly settledRows(to)', () => {
    expect(animatedRowsAt(t, INSERT_ANIMATION_MS)).toEqual(settledRows(TO));
    expect(animatedRowsAt(t, 5000)).toEqual(settledRows(TO));
  });

  it('gap growth is monotonic and never overshoots', () => {
    let last = -1;
    for (let ms = 0; ms <= 600; ms += 20) {
      const f = byKey(animatedRowsAt(t, ms), 'i:0')?.maxHeightFactor ?? 1.5;
      expect(f).toBeGreaterThanOrEqual(last);
      expect(f).toBeLessThanOrEqual(1.5);
      last = f;
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
// The new row's box grows to 1.5 x fontSize. That is above its natural single-line height (~1.2x),
// so the gap finishes opening a little early, but no row-height model is ever needed: the flex
// column pushes everything below it down by exactly the row's real height.
const GAP_MAX_HEIGHT_FACTOR = 1.5;

export interface AnimatedRow { key: string; text: string; opacity?: number; offsetX?: number; maxHeightFactor?: number }
export type WindowTransition =
  | { kind: 'none' }
  | { kind: 'snap' }
  | { kind: 'insert'; from: WindowRow[]; to: WindowRow[]; insertedKeys: Set<string> };
export type InsertTransition = Extract<WindowTransition, { kind: 'insert' }>;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);

/**
 * `insert` ONLY when `to` is `from` with rows added after the current row, and with rows lost only
 * off the bottom — the one change worth animating. Everything else (a track advance, previous, a
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

  const fromKeys = new Set(from.map((r) => r.key));
  const insertedKeys = new Set(to.filter((r) => !fromKeys.has(r.key)).map((r) => r.key));
  if (insertedKeys.size === 0) return { kind: 'snap' };
  if (to.some((r, i) => insertedKeys.has(r.key) && i <= toCur)) return { kind: 'snap' };

  const kept = to.filter((r) => !insertedKeys.has(r.key));
  if (kept.length > from.length) return { kind: 'snap' };
  for (let i = 0; i < kept.length; i += 1) {
    if (kept[i].key !== from[i].key || kept[i].text !== from[i].text) return { kind: 'snap' };
  }
  return { kind: 'insert', from, to, insertedKeys };
}

// No optional props at all: playlistWindowNode() renders these exactly like today's baked rows.
export function settledRows(rows: WindowRow[]): AnimatedRow[] {
  return rows.map((r) => ({ key: r.key, text: r.text }));
}

export function animatedRowsAt(t: InsertTransition, elapsedMs: number): AnimatedRow[] {
  if (elapsedMs >= INSERT_ANIMATION_MS) return settledRows(t.to);
  const gap = easeInOutCubic(clamp01(elapsedMs / GAP_END_MS));
  const appear = easeOutCubic(clamp01((elapsedMs - FADE_IN_START_MS) / (INSERT_ANIMATION_MS - FADE_IN_START_MS)));
  const toKeys = new Set(t.to.map((r) => r.key));
  const rows: AnimatedRow[] = t.to.map((r) => (t.insertedKeys.has(r.key)
    ? { key: r.key, text: r.text, maxHeightFactor: GAP_MAX_HEIGHT_FACTOR * gap, opacity: appear, offsetX: SLIDE_IN_PX * (1 - appear) }
    : { key: r.key, text: r.text }));
  // Rows the insert pushes out of the window stay in the column below it while they fade.
  for (const r of t.from) {
    if (!toKeys.has(r.key)) rows.push({ key: r.key, text: r.text, opacity: 1 - gap });
  }
  return rows;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest test/ffmpeg/playlistWindowTransition.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ffmpeg/playlistWindowTransition.ts test/ffmpeg/playlistWindowTransition.test.ts
git commit -m "feat(ffmpeg): pure insert-transition planning and animated row props for the playlist window"
```

---

### Task 4: Region geometry, the shared playlist node, burst-frame pixels, yuva420p conversion

**Files:**
- Create: `src/render/playlistWindowGeometry.ts`, `src/render/yuva420p.ts`
- Modify: `src/render/sceneRenderer.ts`
- Test: `test/render/playlistWindowGeometry.test.ts`, `test/render/yuva420p.test.ts`, `test/render/playlistWindowNode.test.ts`; `test/render/sceneRenderer.test.ts` **must pass unmodified**

**Interfaces:**
- Consumes: `AnimatedRow`, `settledRows` (Task 3); `PLAYLIST_WINDOW_VISIBLE_ROWS` (Task 2).
- Produces:

```ts
// playlistWindowGeometry.ts
export interface PlaylistWindowRegion { x: number; y: number; width: number; height: number; originX: number; originY: number }
export function computePlaylistWindowRegion(el: PlaylistElement, canvas: { width: number; height: number }, visibleRows: number): PlaylistWindowRegion | null;
// yuva420p.ts
export function yuva420pFrameSize(width: number, height: number): number; // width*height*2.5
export function transparentYuva420p(width: number, height: number): Buffer;
export function rgbaToYuva420p(rgbaStraight: Uint8Array, width: number, height: number): Buffer;
// sceneRenderer.ts
export function playlistWindowNode(el: PlaylistElement, rows: AnimatedRow[], origin: { x: number; y: number }): SatoriNode;
export function collectFontVariants(elements: TemplateElement[]): { family: string; bold: boolean; italic: boolean }[]; // now exported
export interface PlaylistWindowFrameRequest { element: PlaylistElement; rows: AnimatedRow[]; region: PlaylistWindowRegion }
export async function renderPlaylistWindowPixels(req: PlaylistWindowFrameRequest, loadFont?: (family: string, bold: boolean, italic: boolean) => Promise<Buffer>): Promise<{ pixels: Uint8Array; width: number; height: number }>; // premultiplied RGBA
```

- [ ] **Step 1: Failing tests**

`test/render/playlistWindowGeometry.test.ts`:

```ts
import { computePlaylistWindowRegion } from '../../src/render/playlistWindowGeometry';

const el = (over: any = {}) => ({ type: 'playlist' as const, x: 512, y: 160, width: 700, fontSize: 22,
  color: { mode: 'solid' as const, color: '#fff' }, style: { fontFamily: 'DejaVu Sans', bold: false, italic: false }, ...over });
const CANVAS = { width: 1280, height: 720 };

describe('computePlaylistWindowRegion', () => {
  it('default template: 704x342 at (510,158)', () => {
    expect(computePlaylistWindowRegion(el(), CANVAS, 10)).toEqual({ x: 510, y: 158, width: 704, height: 342, originX: 2, originY: 2 });
  });
  it('odd origin -> even origin and even size, element origin preserved', () => {
    const r = computePlaylistWindowRegion(el({ x: 141, y: 501 }), CANVAS, 10)!;
    expect([r.x % 2, r.y % 2, r.width % 2, r.height % 2]).toEqual([0, 0, 0, 0]);
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
    expect(r.originX).toBeGreaterThanOrEqual(15);
  });
  it('null when entirely off-canvas', () => {
    expect(computePlaylistWindowRegion(el({ x: 1400 }), CANVAS, 10)).toBeNull();
  });
});
```

`test/render/yuva420p.test.ts`:

```ts
import { rgbaToYuva420p, transparentYuva420p, yuva420pFrameSize } from '../../src/render/yuva420p';

describe('yuva420p', () => {
  it('frame size is 2.5 bytes per pixel', () => {
    expect(yuva420pFrameSize(4, 2)).toBe(20);
  });
  it('transparent frame: Y=16, U=V=128, A=0', () => {
    const f = transparentYuva420p(4, 2);
    expect([...f.subarray(0, 8)]).toEqual(Array(8).fill(16));
    expect([...f.subarray(8, 10)]).toEqual([128, 128]);
    expect([...f.subarray(10, 12)]).toEqual([128, 128]);
    expect([...f.subarray(12, 20)]).toEqual(Array(8).fill(0));
  });
  it('BT.601 limited range: white, black, pure red', () => {
    const px = (r: number, g: number, b: number, a = 255) => Uint8Array.from([r, g, b, a, r, g, b, a, r, g, b, a, r, g, b, a]);
    const white = rgbaToYuva420p(px(255, 255, 255), 2, 2);
    expect([white[0], white[4], white[5], white[6]]).toEqual([235, 128, 128, 255]);
    const black = rgbaToYuva420p(px(0, 0, 0), 2, 2);
    expect([black[0], black[4], black[5]]).toEqual([16, 128, 128]);
    const red = rgbaToYuva420p(px(255, 0, 0), 2, 2);
    expect([red[0], red[4], red[5]]).toEqual([81, 90, 240]);
  });
  it('alpha copied at full resolution', () => {
    const rgba = Uint8Array.from([0, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0, 30, 0, 0, 0, 40]);
    const f = rgbaToYuva420p(rgba, 2, 2);
    expect([...f.subarray(6, 10)]).toEqual([10, 20, 30, 40]);
  });
});
```

`test/render/playlistWindowNode.test.ts` — the "settled appearance unchanged" gate at the node level:

```ts
import { playlistWindowNode } from '../../src/render/sceneRenderer';
import { settledRows } from '../../src/ffmpeg/playlistWindowTransition';

const el = { type: 'playlist' as const, x: 512, y: 160, width: 700, fontSize: 22, color: { mode: 'solid' as const, color: '#ffffff' }, style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } };

it('with settled rows it is exactly the pre-Phase-C baked node', () => {
  const lines = ['  a', '▶ b', '  c'];
  const node = playlistWindowNode(el, settledRows(lines.map((text, i) => ({ key: String(i), text, isCurrent: false }))), { x: el.x, y: el.y });
  expect(node).toEqual({
    type: 'div',
    props: {
      style: { position: 'absolute', left: 512, top: 160, width: 700, fontSize: 22, display: 'flex', flexDirection: 'column', color: '#ffffff', fontFamily: 'DejaVu Sans', fontWeight: 400, fontStyle: 'normal' },
      children: lines.map((line) => ({ type: 'div', props: { style: { display: 'flex' }, children: line } })),
    },
  });
});

it('animation props only ever ADD style keys to a row', () => {
  const node: any = playlistWindowNode(el, [{ key: 'i:0', text: '  new', opacity: 0.5, offsetX: 12, maxHeightFactor: 0.75 }], { x: 2, y: 2 });
  expect(node.props.style.left).toBe(2);
  expect(node.props.children[0].props.style).toEqual({ display: 'flex', opacity: 0.5, marginLeft: 12, maxHeight: 16.5, overflow: 'hidden' });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/render/playlistWindowGeometry.test.ts test/render/yuva420p.test.ts test/render/playlistWindowNode.test.ts`
Expected: FAIL — modules/exports not found.

- [ ] **Step 3: Implement**

`src/render/playlistWindowGeometry.ts`:

```ts
import { PlaylistElement } from '../templates/templateTypes';

export interface PlaylistWindowRegion { x: number; y: number; width: number; height: number; originX: number; originY: number }

// A generous bound on one natural single-line row (the bundled fonts measure ~1.16-1.2 x fontSize).
// The baked window is never clipped by this; only BURST frames can be, for wrapped names (spec C14).
const ROW_HEIGHT_BOUND_FACTOR = 1.4;
const floorEven = (n: number) => Math.floor(n / 2) * 2;

/**
 * The fixed pipe:7 region for a playlist element's burst frames: the element's box plus one extra
 * row (the row an insert pushes out slides there while it fades), padded for stroke/shadow,
 * clamped to the canvas, with an EVEN origin. overlay in yuv420 snaps odd coordinates to the chroma
 * grid (see GIF_OVERLAY_FORMAT in persistentEncoderArgs.ts); an even origin places it exactly, for
 * free.
 */
export function computePlaylistWindowRegion(el: PlaylistElement, canvas: { width: number; height: number }, visibleRows: number): PlaylistWindowRegion | null {
  const s = el.style;
  const pad = Math.ceil((s.stroke?.width ?? 0) + Math.max(Math.abs(s.shadow?.offsetX ?? 0), Math.abs(s.shadow?.offsetY ?? 0)) + (s.shadow?.blur ?? 0)) + 2;
  const ex = Math.round(el.x);
  const ey = Math.round(el.y);
  const x0 = Math.max(0, floorEven(ex - pad));
  const y0 = Math.max(0, floorEven(ey - pad));
  const x1 = Math.min(canvas.width, Math.round(el.x + el.width) + pad);
  const y1 = Math.min(canvas.height, ey + Math.ceil((visibleRows + 1) * el.fontSize * ROW_HEIGHT_BOUND_FACTOR) + pad);
  const width = floorEven(x1 - x0);
  const height = floorEven(y1 - y0);
  if (width < 2 || height < 2) return null;
  return { x: x0, y: y0, width, height, originX: ex - x0, originY: ey - y0 };
}
```

`src/render/yuva420p.ts`:

```ts
// pipe:7's pixel format. yuva420p (2.5 B/px) rather than rgba (4 B/px): this pipe is fed
// continuously even while idle, so bytes per frame are the steady-state cost. The coefficients are
// BT.601 LIMITED range — swscale's default, which is what CanvasFeeder's one-shot ffmpeg uses to
// turn the baked overlay PNG into pipe:3's yuva420p — so a burst's first and last frames match
// the baked window's colours (Task 10 checks the real deviation, spec C20).
export function yuva420pFrameSize(width: number, height: number): number {
  return width * height + 2 * ((width / 2) * (height / 2)) + width * height;
}

export function transparentYuva420p(width: number, height: number): Buffer {
  const frame = Buffer.alloc(yuva420pFrameSize(width, height));
  const ySize = width * height;
  const cSize = (width / 2) * (height / 2);
  frame.fill(16, 0, ySize);
  frame.fill(128, ySize, ySize + 2 * cSize);
  // alpha plane stays 0
  return frame;
}

const clampByte = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

// Input: STRAIGHT (unpremultiplied) RGBA, even width/height.
export function rgbaToYuva420p(rgba: Uint8Array, width: number, height: number): Buffer {
  const ySize = width * height;
  const cw = width / 2;
  const cSize = cw * (height / 2);
  const out = Buffer.alloc(yuva420pFrameSize(width, height));
  const uOff = ySize;
  const vOff = ySize + cSize;
  const aOff = ySize + 2 * cSize;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      out[y * width + x] = clampByte(16 + (65.481 * r + 128.553 * g + 24.966 * b) / 255);
      out[aOff + y * width + x] = rgba[i + 3];
    }
  }
  for (let cy = 0; cy < height / 2; cy += 1) {
    for (let cx = 0; cx < cw; cx += 1) {
      let r = 0, g = 0, b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const i = ((cy * 2 + dy) * width + (cx * 2 + dx)) * 4;
        r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2];
      }
      r /= 4; g /= 4; b /= 4;
      out[uOff + cy * cw + cx] = clampByte(128 + (-37.797 * r - 74.203 * g + 112.0 * b) / 255);
      out[vOff + cy * cw + cx] = clampByte(128 + (112.0 * r - 93.786 * g - 18.214 * b) / 255);
    }
  }
  return out;
}
```

`src/render/sceneRenderer.ts`: extract today's `case 'playlist'` body into

```ts
// The ONE playlist-window node: the baked canvas and the template preview call it with settled
// rows (no animation props), which must stay byte-identical to the pre-Phase-C node
// (test/render/playlistWindowNode.test.ts). pipe:7's burst frames call it with animation props,
// which only ever ADD row style keys — so a burst's first and last frames are the baked window's
// own pixels, which is what makes the handoff overlaps invisible (spec, "The handoff protocol").
export function playlistWindowNode(el: PlaylistElement, rows: AnimatedRow[], origin: { x: number; y: number }): SatoriNode {
  return {
    type: 'div',
    props: {
      style: { position: 'absolute', left: origin.x, top: origin.y, width: el.width, fontSize: el.fontSize, display: 'flex', flexDirection: 'column', ...textStyleToCss(el.style, el.color) },
      children: rows.map((r): SatoriNode => {
        const style: Record<string, unknown> = { display: 'flex' };
        if (r.opacity !== undefined) style.opacity = r.opacity;
        if (r.offsetX !== undefined) style.marginLeft = r.offsetX;
        if (r.maxHeightFactor !== undefined) {
          // Growing the new row's box is what opens the gap: the flex column pushes every row below
          // down by the row's REAL height — no row-height model, so wrapping and natural line height
          // behave exactly as in the baked window.
          style.maxHeight = r.maxHeightFactor * el.fontSize;
          style.overflow = 'hidden';
        }
        return { type: 'div', props: { style, children: r.text } };
      }),
    },
  };
}
```

and make the case `case 'playlist': return playlistWindowNode(el, settledRows(scene.playlistLines.map((text, i) => ({ key: String(i), text, isCurrent: false }))), { x: el.x, y: el.y });`. Export `collectFontVariants`, and add:

```ts
export interface PlaylistWindowFrameRequest { element: PlaylistElement; rows: AnimatedRow[]; region: PlaylistWindowRegion }

// One pipe:7 burst frame: ONLY the playlist element, in region coordinates (origin shifted by an
// integer offset, so rasterization is identical to the baked canvas's), as raw PREMULTIPLIED RGBA.
// loadSystemFonts: false — satori already turned every glyph into a path, and the scan costs
// ~130ms per call (pulse spike).
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
      children: [playlistWindowNode(req.element, req.rows, { x: req.region.originX, y: req.region.originY })],
    },
  };
  const svg = await satori(root as unknown as Parameters<typeof satori>[0], { width: req.region.width, height: req.region.height, fonts });
  const pixmap = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
  return { pixels: pixmap.pixels, width: pixmap.width, height: pixmap.height };
}
```

- [ ] **Step 4: Add a real-render case** to `test/render/playlistWindowNode.test.ts`, using the same local-font loader approach as `sceneRenderer.test.ts`'s `testLoadFont` (copy its `findFontPath`/`testLoadFont` helpers into this file):

```ts
it('renderPlaylistWindowPixels: w*h*4 bytes; nothing drawn for no rows; opacity 0 draws nothing', async () => {
  const region = { x: 0, y: 0, width: 200, height: 100, originX: 0, originY: 0 };
  const small = { ...el, x: 0, y: 0, width: 120, fontSize: 20 };
  const empty = await renderPlaylistWindowPixels({ element: small, region, rows: [] }, testLoadFont);
  expect(empty.pixels.length).toBe(200 * 100 * 4);
  expect(empty.pixels.every((v, i) => i % 4 !== 3 || v === 0)).toBe(true);
  const hidden = await renderPlaylistWindowPixels({ element: small, region, rows: [{ key: 'a', text: '▶ b', opacity: 0 }] }, testLoadFont);
  expect(hidden.pixels.every((v, i) => i % 4 !== 3 || v === 0)).toBe(true);
  const shown = await renderPlaylistWindowPixels({ element: small, region, rows: [{ key: 'a', text: '▶ b' }] }, testLoadFont);
  expect(shown.pixels.some((v, i) => i % 4 === 3 && v > 0)).toBe(true);
});
```

- [ ] **Step 5: Run to verify pass — with the baked-appearance gate**

Run: `npx jest test/render` then `git diff --stat test/render/sceneRenderer.test.ts` then `npm run build`
Expected: all PASS, **no diff** on `sceneRenderer.test.ts`, and tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/render/playlistWindowGeometry.ts src/render/yuva420p.ts src/render/sceneRenderer.ts test/render
git commit -m "feat(render): shared playlist node (baked output unchanged), burst-frame pixels and yuva420p conversion"
```

---

### Task 5: Dedicated render pool for burst frames

**Files:**
- Create: `src/render/playlistWindowRenderWorker.ts`, `src/render/playlistWindowRenderPool.ts`
- Test: `test/render/playlistWindowRenderWorker.test.ts`, `test/render/playlistWindowRenderPool.test.ts`

**Interfaces:**
- Consumes: `renderPlaylistWindowPixels`, `PlaylistWindowFrameRequest` (Task 4); `rgbaToYuva420p`; `unpremultiplyRgbaInPlace` (`src/render/unpremultiply.ts`).
- Produces: `renderPlaylistWindowFrame(req: PlaylistWindowFrameRequest): Promise<Buffer>` — a yuva420p frame of exactly `region.width * region.height * 2.5` bytes, as a real `Buffer`.

- [ ] **Step 1: Failing tests**

`test/render/playlistWindowRenderPool.test.ts`:

```ts
const runMock = jest.fn();
const piscinaCtor = jest.fn().mockImplementation(() => ({ run: runMock }));
jest.mock('piscina', () => piscinaCtor);

import { renderPlaylistWindowFrame } from '../../src/render/playlistWindowRenderPool';

const REQ: any = { element: {}, rows: [], region: { x: 0, y: 0, width: 2, height: 2, originX: 0, originY: 0 } };

describe('renderPlaylistWindowFrame (pool wrapper)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates its own small pool with useAtomics disabled', async () => {
    runMock.mockResolvedValue(new Uint8Array(10));
    await renderPlaylistWindowFrame(REQ);
    expect(piscinaCtor).toHaveBeenCalledWith(expect.objectContaining({ useAtomics: false }));
    expect(piscinaCtor.mock.calls[0][0].maxThreads).toBeLessThanOrEqual(2);
    expect(piscinaCtor.mock.calls[0][0].filename).toMatch(/playlistWindowRenderWorker\.js$/);
  });

  it('returns a real Buffer, not the plain Uint8Array structured clone hands back', async () => {
    runMock.mockResolvedValue(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    const result = await renderPlaylistWindowFrame(REQ);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(10);
  });

  it('passes an abort signal (render timeout)', async () => {
    runMock.mockResolvedValue(new Uint8Array(10));
    await renderPlaylistWindowFrame(REQ);
    expect(runMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
```

`test/render/playlistWindowRenderWorker.test.ts`:

```ts
jest.mock('../../src/render/sceneRenderer', () => ({
  // 2x2 opaque white, premultiplied (= straight for alpha 255)
  renderPlaylistWindowPixels: jest.fn().mockResolvedValue({ pixels: new Uint8Array(Array(16).fill(255)), width: 2, height: 2 }),
}));
import render from '../../src/render/playlistWindowRenderWorker';

it('unpremultiplies and converts to a yuva420p frame of 2.5*w*h bytes', async () => {
  const frame = await render({ element: {} as any, rows: [], region: { x: 0, y: 0, width: 2, height: 2, originX: 0, originY: 0 } });
  expect(frame.length).toBe(10);
  expect([frame[0], frame[4], frame[5], frame[6]]).toEqual([235, 128, 128, 255]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/render/playlistWindowRender`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/render/playlistWindowRenderWorker.ts`:

```ts
import { renderPlaylistWindowPixels, PlaylistWindowFrameRequest } from './sceneRenderer';
import { unpremultiplyRgbaInPlace } from './unpremultiply';
import { rgbaToYuva420p } from './yuva420p';

// Piscina worker entry for pipe:7 burst frames. Everything CPU-heavy happens here, off the main
// thread: Satori layout, resvg rasterization, unpremultiply, and the yuva420p conversion. Fonts
// load in this thread (fontCache), so no font bytes cross the postMessage boundary.
export default async function render(task: PlaylistWindowFrameRequest): Promise<Uint8Array> {
  const { pixels, width, height } = await renderPlaylistWindowPixels(task);
  const straight = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  unpremultiplyRgbaInPlace(straight);
  return rgbaToYuva420p(straight, width, height);
}
```

(Check `unpremultiplyRgbaInPlace`'s signature in `src/render/unpremultiply.ts` and adapt the argument type if it takes a `Uint8Array`.)

`src/render/playlistWindowRenderPool.ts`:

```ts
import Piscina from 'piscina';
import * as path from 'path';
import * as os from 'os';
import { PlaylistWindowFrameRequest } from './sceneRenderer';

const RENDER_TIMEOUT_MS = 500;
let pool: Piscina | null = null;

// Its own small pool, NOT renderWorkerPool's: a burst fires ~20 renders in under a second, and must
// neither queue behind another tenant's full 1280x720 canvas render nor delay one.
function getPool(): Piscina {
  if (!pool) {
    pool = new Piscina({
      filename: path.join(__dirname, 'playlistWindowRenderWorker.js'),
      maxThreads: Math.max(1, Math.min(2, os.cpus().length)),
      idleTimeout: 60000,
      // Same RSS leak as pulseRenderWorkerPool.ts (read its comment): with Atomics dispatch the
      // worker's event loop never turns during a burst, and resvg's native memory is never freed.
      useAtomics: false,
    });
  }
  return pool;
}

export async function renderPlaylistWindowFrame(req: PlaylistWindowFrameRequest): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  try {
    const result: Uint8Array = await getPool().run(req, { signal: controller.signal });
    // Structured clone hands back a plain Uint8Array, never a Buffer (CLAUDE.md, Stage 1a scar).
    return Buffer.from(result.buffer, result.byteOffset, result.byteLength);
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest test/render` then `npm run build` (must emit `dist/render/playlistWindowRenderWorker.js`).
Expected: PASS; the file exists.

- [ ] **Step 5: Real worker-boundary + gradient check (CLAUDE.md "Verify against real binaries")** — in the Docker image (real fonts), after `npm run build`:

```bash
docker compose run --rm super-dj node -e "
const { renderPlaylistWindowFrame } = require('./dist/render/playlistWindowRenderPool');
const { computePlaylistWindowRegion } = require('./dist/render/playlistWindowGeometry');
const base = { type:'playlist', x:512, y:160, width:700, fontSize:22, style:{fontFamily:'DejaVu Sans',bold:false,italic:false} };
const solid = { ...base, color:{mode:'solid',color:'#ffffff'} };
const grad = { ...base, color:{mode:'gradient',gradientType:'linear',angleDeg:90,stops:[{offset:0,color:'#ff0000'},{offset:100,color:'#0000ff'}]} };
const region = computePlaylistWindowRegion(solid, {width:1280,height:720}, 10);
const alpha = (b) => { const a0 = region.width*region.height*1.5; let s = 0; for (let i = a0; i < b.length; i++) s += b[i]; return s; };
(async () => {
  const cyr = await renderPlaylistWindowFrame({ element: solid, region, rows: [{key:'a',text:'▶ Привіт, світ'}] });
  const lat = await renderPlaylistWindowFrame({ element: solid, region, rows: [{key:'a',text:'▶ Hello, world'}] });
  const gHalf = await renderPlaylistWindowFrame({ element: grad, region, rows: [{key:'a',text:'▶ Hello, world', opacity: 0.5}] });
  const gFull = await renderPlaylistWindowFrame({ element: grad, region, rows: [{key:'a',text:'▶ Hello, world'}] });
  console.log(JSON.stringify({ isBuffer: Buffer.isBuffer(cyr), bytes: cyr.length, expected: region.width*region.height*2.5, cyrAlpha: alpha(cyr), latAlpha: alpha(lat), gradHalf: alpha(gHalf), gradFull: alpha(gFull) }));
  process.exit(0);
})();"
```

Expected: `isBuffer: true`, `bytes === expected`, `cyrAlpha` of the same order as `latAlpha` (a missing-glyph render is far lower or boxy — CLAUDE.md's Cyrillic scar). If `gradHalf ≈ gradFull`, Satori ignores row opacity on gradient-clipped text: record it (spec C16, burst-only degradation) — no code change. Put the numbers in the commit message.

- [ ] **Step 6: Commit**

```bash
git add src/render/playlistWindowRenderWorker.ts src/render/playlistWindowRenderPool.ts test/render
git commit -m "feat(render): dedicated piscina pool producing yuva420p pipe:7 burst frames"
```

---

### Task 6: `PlaylistWindowFeeder` — the pipe:7 frame player

**Files:**
- Create: `src/ffmpeg/playlistWindowFeeder.ts`
- Test: `test/ffmpeg/playlistWindowFeeder.test.ts`

**Interfaces:**
- Consumes: `RawFramePacer` (Task 1); `WindowRow` (Task 2); `animatedRowsAt`, `settledRows`, `INSERT_ANIMATION_MS`, `InsertTransition`, `AnimatedRow` (Task 3); `PlaylistWindowRegion`, `transparentYuva420p` (Task 4); `PlaylistWindowFrameRequest`; `renderPlaylistWindowFrame` (Task 5).
- Produces:

```ts
export class FeederCancelled extends Error {}
export interface PlaylistWindowFeederOptions { element: PlaylistElement; region: PlaylistWindowRegion; fps: number; renderFrame?: (req: PlaylistWindowFrameRequest) => Promise<Buffer>; nowMs?: () => number }
export class PlaylistWindowFeeder {
  constructor(options: PlaylistWindowFeederOptions);
  attach(pipe: NodeJS.WritableStream): void;          // starts pacing the transparent idle frame
  showRows(rows: WindowRow[]): Promise<void>;          // renders the settled rows; resolves once it is the current frame
  animate(plan: InsertTransition): Promise<void>;      // 600ms; resolves once the settled `to` frame is current
  goIdle(): void;                                      // transparent frame now; pending showRows/animate reject with FeederCancelled
  close(): void;
}
```

It owns no timing policy (holds, canvas swaps and coalescing live in the animator, Task 7) and knows nothing about the canvas or the queue.

- [ ] **Step 1: Failing tests** — `test/ffmpeg/playlistWindowFeeder.test.ts`:

```ts
import { EventEmitter } from 'events';
import { PlaylistWindowFeeder, FeederCancelled } from '../../src/ffmpeg/playlistWindowFeeder';
import { planWindowTransition, InsertTransition } from '../../src/ffmpeg/playlistWindowTransition';
import { WindowRow } from '../../src/playlist/window';

const REGION = { x: 0, y: 0, width: 4, height: 2, originX: 0, originY: 0 };
const FRAME = 4 * 2 * 2.5;
const ELEMENT: any = { type: 'playlist', x: 0, y: 0, width: 4, fontSize: 22, color: { mode: 'solid', color: '#fff' }, style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } };
const row = (key: string, isCurrent = false): WindowRow => ({ key, text: key, isCurrent });
const FROM = [row('b:0', true), row('b:1'), row('b:2')];
const TO = [row('b:0', true), row('i:0'), row('b:1'), row('b:2')];
const PLAN = planWindowTransition(FROM, TO) as InsertTransition;

function fakePipe() {
  const pipe: any = new EventEmitter();
  pipe.writes = [] as Buffer[];
  pipe.write = (b: Buffer) => { pipe.writes.push(b); return true; };
  return pipe;
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function setup() {
  jest.useFakeTimers();
  const clock = { ms: 0 };
  const requests: any[] = [];
  const renderFrame = jest.fn(async (req: any) => { requests.push(req); return Buffer.alloc(FRAME, 200); });
  const feeder = new PlaylistWindowFeeder({ element: ELEMENT, region: REGION, fps: 30, renderFrame, nowMs: () => clock.ms });
  const pipe = fakePipe();
  const advance = async (ms: number) => { for (let t = 0; t < ms; t += 10) { clock.ms += 10; jest.advanceTimersByTime(10); await flush(); } };
  return { feeder, pipe, renderFrame, requests, advance };
}

describe('PlaylistWindowFeeder', () => {
  afterEach(() => jest.useRealTimers());

  it('idle: writes the transparent yuva frame from attach(), no renders (C10)', async () => {
    const { feeder, pipe, renderFrame, advance } = setup();
    feeder.attach(pipe);
    await advance(200);
    expect(pipe.writes.length).toBeGreaterThanOrEqual(5);
    const f = pipe.writes[0];
    expect(f.length).toBe(FRAME);
    expect([...f.subarray(0, 8)].every((v) => v === 16)).toBe(true);
    expect([...f.subarray(12, 20)].every((v) => v === 0)).toBe(true);
    expect(renderFrame).not.toHaveBeenCalled();
    feeder.close();
  });

  it('showRows renders settled rows (no animation props) and resolves once that frame is current', async () => {
    const { feeder, pipe, requests, advance } = setup();
    feeder.attach(pipe);
    const done = feeder.showRows(FROM);
    await advance(50);
    await done;
    expect(requests[0].rows).toEqual(FROM.map((r) => ({ key: r.key, text: r.text })));
    await advance(50);
    expect(pipe.writes[pipe.writes.length - 1][0]).toBe(200);
    feeder.close();
  });

  it('animate: ~600ms, at most one render in flight, ends on the settled TO frame', async () => {
    const { feeder, pipe, renderFrame, requests, advance } = setup();
    let inFlight = 0; let maxInFlight = 0;
    renderFrame.mockImplementation(async (req: any) => { requests.push(req); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 20)); inFlight--; return Buffer.alloc(FRAME, 200); });
    feeder.attach(pipe);
    let finished = false;
    const done = feeder.animate(PLAN).then(() => { finished = true; });
    await advance(500);
    expect(finished).toBe(false);
    await advance(300);
    await done;
    expect(maxInFlight).toBe(1);
    expect(requests.length).toBeGreaterThan(5);
    expect(requests.length).toBeLessThanOrEqual(25);
    expect(requests[requests.length - 1].rows).toEqual(TO.map((r) => ({ key: r.key, text: r.text })));
    feeder.close();
  });

  it('goIdle during animate: rejects it with FeederCancelled, transparent immediately, stale renders never written', async () => {
    const { feeder, pipe, renderFrame, advance } = setup();
    let resolveRender!: (b: Buffer) => void;
    renderFrame.mockImplementation(() => new Promise<Buffer>((r) => { resolveRender = r; }));
    feeder.attach(pipe);
    const done = feeder.animate(PLAN);
    await advance(50);
    feeder.goIdle();
    await expect(done).rejects.toBeInstanceOf(FeederCancelled);
    resolveRender(Buffer.alloc(FRAME, 200));
    await advance(100);
    expect(pipe.writes[pipe.writes.length - 1][0]).toBe(16); // still the transparent frame
    feeder.close();
  });

  it('after close(), a resolving render never writes (C8)', async () => {
    const { feeder, pipe, renderFrame, advance } = setup();
    let resolveRender!: (b: Buffer) => void;
    renderFrame.mockImplementation(() => new Promise<Buffer>((r) => { resolveRender = r; }));
    feeder.attach(pipe);
    const done = feeder.showRows(FROM).catch(() => undefined);
    await advance(20);
    feeder.close();
    const before = pipe.writes.length;
    resolveRender(Buffer.alloc(FRAME, 200));
    await advance(200);
    await done;
    expect(pipe.writes.length).toBe(before);
  });

  it('a failed intermediate frame is logged and skipped; a failed showRows rejects', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { feeder, pipe, renderFrame, advance } = setup();
    feeder.attach(pipe);
    renderFrame.mockRejectedValueOnce(new Error('boom'));
    await expect(Promise.all([feeder.showRows(FROM), advance(50)])).rejects.toThrow('boom');
    renderFrame.mockRejectedValueOnce(new Error('mid'));
    const done = feeder.animate(PLAN);
    await advance(800);
    await expect(done).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
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
import { animatedRowsAt, settledRows, INSERT_ANIMATION_MS, InsertTransition, AnimatedRow } from './playlistWindowTransition';
import { PlaylistWindowRegion } from '../render/playlistWindowGeometry';
import { transparentYuva420p } from '../render/yuva420p';
import { PlaylistWindowFrameRequest } from '../render/sceneRenderer';
import { PlaylistElement } from '../templates/templateTypes';
import { renderPlaylistWindowFrame } from '../render/playlistWindowRenderPool';

export class FeederCancelled extends Error {
  constructor() { super('playlist window feeder: cancelled'); }
}

export interface PlaylistWindowFeederOptions {
  element: PlaylistElement;
  region: PlaylistWindowRegion;
  fps: number;
  renderFrame?: (req: PlaylistWindowFrameRequest) => Promise<Buffer>;
  nowMs?: () => number;
}

/**
 * The pipe:7 frame player. Idle, it is the same heartbeat-of-an-unchanging-frame discipline
 * CanvasFeeder uses for pipe:3 — RawFramePacer resending one precomputed transparent frame at the
 * declared rate — so ffmpeg's overlay frame-sync never waits on this pipe. On command it shows a
 * settled frame or plays one insert animation. Holds, canvas swaps and coalescing belong to
 * PlaylistWindowAnimator; this class only turns rows into paced frames.
 */
export class PlaylistWindowFeeder {
  private readonly pacer: RawFramePacer;
  private readonly nowMs: () => number;
  private readonly idleFrame: Buffer;
  private generation = 0;
  private closed = false;
  private inFlight: Promise<unknown> = Promise.resolve();
  private rendering = false;
  private tickTimer: NodeJS.Timeout | null = null;
  private animation: { plan: InsertTransition; startedAtMs: number; generation: number; resolve: () => void; reject: (e: unknown) => void } | null = null;

  constructor(private readonly options: PlaylistWindowFeederOptions) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.pacer = new RawFramePacer({ fps: options.fps, now: () => this.nowMs() / 1000 });
    this.idleFrame = transparentYuva420p(options.region.width, options.region.height);
    this.pacer.setFrame(this.idleFrame);
  }

  attach(pipe: NodeJS.WritableStream): void {
    this.pacer.attach(pipe);
    this.tickTimer = setInterval(() => this.tick(), 1000 / this.options.fps);
    this.tickTimer.unref();
    this.pacer.writeDueFrames();
  }

  async showRows(rows: WindowRow[]): Promise<void> {
    const generation = this.generation;
    await this.renderAndShow(settledRows(rows), generation);
  }

  animate(plan: InsertTransition): Promise<void> {
    if (this.closed) return Promise.reject(new FeederCancelled());
    return new Promise<void>((resolve, reject) => {
      this.animation = { plan, startedAtMs: this.nowMs(), generation: this.generation, resolve, reject };
    });
  }

  goIdle(): void {
    this.generation += 1;
    this.animation?.reject(new FeederCancelled());
    this.animation = null;
    this.pacer.setFrame(this.idleFrame);
  }

  close(): void {
    this.goIdle();
    this.closed = true;
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    this.pacer.detach();
  }

  private tick(): void {
    try {
      this.pacer.writeDueFrames();
      const anim = this.animation;
      if (!anim || this.rendering || this.closed) return;
      const elapsed = this.nowMs() - anim.startedAtMs;
      if (elapsed >= INSERT_ANIMATION_MS) {
        this.animation = null;
        this.renderAndShow(settledRows(anim.plan.to), anim.generation).then(anim.resolve, anim.reject);
        return;
      }
      this.renderAndShow(animatedRowsAt(anim.plan, elapsed), anim.generation).catch((err) => {
        if (!(err instanceof FeederCancelled)) console.error('playlist window burst frame failed, holding the last frame', err);
      });
    } catch (err) {
      // A bare setInterval callback: an uncaught throw would kill every tenant's stream.
      console.error('playlist window tick failed', err);
    }
  }

  // One render in flight at a time. The result becomes the current frame only if nothing
  // (goIdle/close/a newer command) superseded it.
  private async renderAndShow(rows: AnimatedRow[], generation: number): Promise<void> {
    await this.inFlight.catch(() => undefined);
    if (this.closed || generation !== this.generation) throw new FeederCancelled();
    const render = this.options.renderFrame ?? renderPlaylistWindowFrame;
    this.rendering = true;
    const job = render({ element: this.options.element, region: this.options.region, rows });
    this.inFlight = job;
    try {
      const frame = await job;
      if (this.closed || generation !== this.generation) throw new FeederCancelled();
      this.pacer.setFrame(frame);
      this.pacer.writeDueFrames();
    } finally {
      this.rendering = false;
    }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest test/ffmpeg/playlistWindowFeeder.test.ts`
Expected: PASS. Timing-sensitive expectations may need their `advance` amounts adjusted, never the class's discipline (one render in flight, generation check before every `setFrame`).

- [ ] **Step 5: Commit**

```bash
git add src/ffmpeg/playlistWindowFeeder.ts test/ffmpeg/playlistWindowFeeder.test.ts
git commit -m "feat(ffmpeg): PlaylistWindowFeeder — transparent-idle pipe:7 frame player with cancellable bursts"
```

---

### Task 7: `PlaylistWindowAnimator` — the handoff protocol and coalescing

**Files:**
- Create: `src/stream/playlistWindowAnimator.ts`
- Test: `test/stream/playlistWindowAnimator.test.ts`

**Interfaces:**
- Consumes: `planWindowTransition` (Task 3); `FeederCancelled`, feeder API (Task 6); `WindowRow` (Task 2); `CANVAS_HEARTBEAT_MS` (`src/stream/streamScene.ts`, for the sync test only).
- Produces:

```ts
export const HANDOFF_HOLD_MS = 400; // = 2 x CANVAS_HEARTBEAT_MS
export interface PlaylistWindowAnimatorDeps {
  feeder: { showRows(rows: WindowRow[]): Promise<void>; animate(plan: InsertTransition): Promise<void>; goIdle(): void };
  // Builds the current track's overlay from `rows` (minus the live playlist element when asked),
  // makes it the controller's currentOverlay, and awaits CanvasFeeder.render(). Resolves false if
  // the controller decided the result is stale (a track change raced it).
  bakeCanvas(rows: WindowRow[], opts: { omitLivePlaylist: boolean }): Promise<boolean>;
  getBakedRows(): WindowRow[];
  sleep(ms: number): Promise<void>;
  holdMs?: number;
}
export class PlaylistWindowAnimator {
  constructor(deps: PlaylistWindowAnimatorDeps);
  queueChanged(nextRows: WindowRow[]): void;
  abort(): void;
  get busy(): boolean;
}
```

- [ ] **Step 1: Failing tests**

```ts
import { PlaylistWindowAnimator, HANDOFF_HOLD_MS } from '../../src/stream/playlistWindowAnimator';
import { CANVAS_HEARTBEAT_MS } from '../../src/stream/streamScene';
import { WindowRow } from '../../src/playlist/window';

const row = (key: string, isCurrent = false): WindowRow => ({ key, text: key, isCurrent });
const BASE = [row('b:0', true), row('b:1'), row('b:2')];
const ONE = [row('b:0', true), row('i:0'), row('b:1'), row('b:2')];
const TWO = [row('b:0', true), row('i:0'), row('i:1'), row('b:1'), row('b:2')];

function setup() {
  const log: string[] = [];
  let baked = BASE;
  const gates: Array<() => void> = [];
  const deps = {
    feeder: {
      showRows: jest.fn(async (rows: WindowRow[]) => { log.push(`show ${rows.length}`); }),
      animate: jest.fn(async () => { log.push('animate'); }),
      goIdle: jest.fn(() => { log.push('idle'); }),
    },
    bakeCanvas: jest.fn(async (rows: WindowRow[], opts: { omitLivePlaylist: boolean }) => {
      log.push(opts.omitLivePlaylist ? 'bake A' : `bake B ${rows.length}`);
      if (!opts.omitLivePlaylist) baked = rows;
      return true;
    }),
    getBakedRows: () => baked,
    sleep: jest.fn((ms: number) => new Promise<void>((r) => { log.push(`hold ${ms}`); gates.push(r); })),
  };
  const releaseAll = async () => { for (let i = 0; i < 50; i++) { while (gates.length) gates.shift()!(); await Promise.resolve(); } };
  return { animator: new PlaylistWindowAnimator(deps), deps, log, releaseAll };
}

describe('PlaylistWindowAnimator', () => {
  it('HANDOFF_HOLD_MS is two canvas heartbeats', () => {
    expect(HANDOFF_HOLD_MS).toBe(2 * CANVAS_HEARTBEAT_MS);
  });

  it('runs the handoff in exactly this order', async () => {
    const { animator, log, releaseAll } = setup();
    animator.queueChanged(ONE);
    await releaseAll();
    expect(log).toEqual([
      'show 3', `hold ${HANDOFF_HOLD_MS}`,   // frame 0 == baked window, overlapped
      'bake A', `hold ${HANDOFF_HOLD_MS}`,   // canvas without the window
      'animate',
      'bake B 4', `hold ${HANDOFF_HOLD_MS}`, // canvas with the new rows, overlapped
      'idle',
    ]);
    expect(animator.busy).toBe(false);
  });

  it('none: nothing at all', async () => {
    const { animator, log, releaseAll } = setup();
    animator.queueChanged(BASE.map((r) => ({ ...r })));
    await releaseAll();
    expect(log).toEqual([]);
  });

  it('snap-shaped change (not an insert): a plain re-bake, no burst', async () => {
    const { animator, log, releaseAll } = setup();
    animator.queueChanged([row('b:0'), row('b:1', true), row('b:2')]);
    await releaseAll();
    expect(log).toEqual(['bake B 3']);
  });

  it('inserts during a burst coalesce into ONE follow-up burst from the newly baked rows (C3)', async () => {
    const { animator, deps, log, releaseAll } = setup();
    animator.queueChanged(ONE);
    await Promise.resolve();
    animator.queueChanged(TWO);   // arrives mid-burst
    animator.queueChanged(TWO);   // and again
    await releaseAll();
    expect(deps.feeder.animate).toHaveBeenCalledTimes(2);
    expect(log.filter((l) => l.startsWith('bake B'))).toEqual(['bake B 4', 'bake B 5']);
    expect(log[log.length - 1]).toBe('idle');
  });

  it('abort mid-burst: idle at once, no further steps, not busy (C2)', async () => {
    const { animator, deps, log, releaseAll } = setup();
    animator.queueChanged(ONE);
    await Promise.resolve(); await Promise.resolve();
    animator.abort();
    await releaseAll();
    expect(log).toContain('idle');
    expect(deps.bakeCanvas).not.toHaveBeenCalledWith(expect.anything(), { omitLivePlaylist: false });
    expect(animator.busy).toBe(false);
  });

  it('abort drops pending coalesced rows', async () => {
    const { animator, deps, releaseAll } = setup();
    animator.queueChanged(ONE);
    animator.queueChanged(TWO);
    animator.abort();
    await releaseAll();
    expect(deps.feeder.animate).toHaveBeenCalledTimes(0);
  });

  it('a feeder failure mid-burst: idle, then a plain re-bake so the window is never left missing (C9)', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { animator, deps, log, releaseAll } = setup();
    deps.feeder.animate.mockRejectedValueOnce(new Error('render pool died'));
    animator.queueChanged(ONE);
    await releaseAll();
    expect(log.slice(-2)).toEqual(['idle', 'bake B 4']);
    errorSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/stream/playlistWindowAnimator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/stream/playlistWindowAnimator.ts`:

```ts
import { planWindowTransition, InsertTransition } from '../ffmpeg/playlistWindowTransition';
import { FeederCancelled } from '../ffmpeg/playlistWindowFeeder';
import { WindowRow } from '../playlist/window';

// = 2 x CANVAS_HEARTBEAT_MS (streamScene.ts) — asserted by a test, keep in sync.
export const HANDOFF_HOLD_MS = 400;

export interface PlaylistWindowAnimatorDeps {
  feeder: { showRows(rows: WindowRow[]): Promise<void>; animate(plan: InsertTransition): Promise<void>; goIdle(): void };
  bakeCanvas(rows: WindowRow[], opts: { omitLivePlaylist: boolean }): Promise<boolean>;
  getBakedRows(): WindowRow[];
  sleep(ms: number): Promise<void>;
  holdMs?: number;
}

class Stale extends Error {}

/**
 * Runs one playlist-window burst at a time, handing the window between the baked canvas (pipe:3,
 * 5fps heartbeat, one-shot render latency) and the burst layer (pipe:7, 30fps). The two inputs are
 * never frame-synchronized, so the protocol never relies on it: every switch overlaps IDENTICAL
 * content for a hold, so whichever input ffmpeg picks up first, the picture is the same.
 *   frame 0 (== baked window) → hold → canvas A (window omitted) → hold → animate
 *   → canvas B (window with new rows) → hold → idle
 * Queue changes during a burst coalesce into one follow-up. abort() (a track change, a resume,
 * teardown) makes every pending step bail and the layer go transparent at once.
 */
export class PlaylistWindowAnimator {
  private generation = 0;
  private running = false;
  private pendingRows: WindowRow[] | null = null;
  private readonly holdMs: number;

  constructor(private readonly deps: PlaylistWindowAnimatorDeps) {
    this.holdMs = deps.holdMs ?? HANDOFF_HOLD_MS;
  }

  get busy(): boolean {
    return this.running;
  }

  queueChanged(nextRows: WindowRow[]): void {
    if (this.running) {
      this.pendingRows = nextRows;
      return;
    }
    void this.run(nextRows);
  }

  abort(): void {
    this.generation += 1;
    this.running = false;
    this.pendingRows = null;
    this.deps.feeder.goIdle();
  }

  private async run(to: WindowRow[]): Promise<void> {
    const generation = ++this.generation;
    const check = () => { if (generation !== this.generation) throw new Stale(); };
    const step = async <T>(p: Promise<T>): Promise<T> => { const v = await p; check(); return v; };
    this.running = true;
    const from = this.deps.getBakedRows();
    try {
      const plan = planWindowTransition(from, to);
      if (plan.kind === 'none') return;
      if (plan.kind === 'snap') {
        await step(this.deps.bakeCanvas(to, { omitLivePlaylist: false }));
        return;
      }
      await step(this.deps.feeder.showRows(from));
      await step(this.deps.sleep(this.holdMs));
      await step(this.deps.bakeCanvas(from, { omitLivePlaylist: true }));
      await step(this.deps.sleep(this.holdMs));
      await step(this.deps.feeder.animate(plan));
      await step(this.deps.bakeCanvas(to, { omitLivePlaylist: false }));
      await step(this.deps.sleep(this.holdMs));
      this.deps.feeder.goIdle();
    } catch (err) {
      if (err instanceof Stale || err instanceof FeederCancelled) return;
      // Never leave the window missing: fall back to the plain bake.
      console.error('playlist window burst failed, falling back to a plain re-bake', err);
      this.deps.feeder.goIdle();
      if (generation === this.generation) await this.deps.bakeCanvas(to, { omitLivePlaylist: false }).catch(() => undefined);
    } finally {
      if (generation === this.generation) {
        this.running = false;
        const pending = this.pendingRows;
        this.pendingRows = null;
        if (pending) this.queueChanged(pending);
      }
    }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest test/stream/playlistWindowAnimator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stream/playlistWindowAnimator.ts test/stream/playlistWindowAnimator.test.ts
git commit -m "feat(stream): PlaylistWindowAnimator — overlap-safe canvas/pipe:7 handoff with coalescing and abort"
```

---

### Task 8: Encoder args, `pipe:7`, spawner

**Files:**
- Modify: `src/ffmpeg/persistentEncoderArgs.ts`, `src/ffmpeg/persistentEncoder.ts` (pass-through, if it forwards params explicitly), `src/ffmpeg/types.ts`, `src/server.ts` (`createPipeSpawner`)
- Test: `test/ffmpeg/persistentEncoderArgs.test.ts` (plus any fake encoder child in `test/ffmpeg/persistentEncoder.test.ts` / `test/server.test.ts`)

**Interfaces:**
- Produces: `buildPersistentEncoderArgs({ ..., playlistWindow?: { x: number; y: number; width: number; height: number; fps: number; layer: 'below' | 'top' } })`; `ChildProcessWithPipes.playlistWindowPipe: NodeJS.WritableStream`.

- [ ] **Step 1: Failing tests** — in `test/ffmpeg/persistentEncoderArgs.test.ts`:

```ts
  describe('playlist window burst layer (pipe:7)', () => {
    const base = { width: 1280, height: 720, fps: 30, heartbeatFps: 5, rtmpUrl: 'rtmp://h/live', streamKey: 'k', backgroundPath: '/bg.png' };
    const PW = { x: 510, y: 158, width: 704, height: 342, fps: 30, layer: 'top' as const };
    const graphOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1];
    const GIF = { x: 0, y: 0, width: 10, height: 10, filePath: '/g.gif', frameCount: 3 };

    it('absent unless configured: args byte-identical to today (C11)', () => {
      expect(buildPersistentEncoderArgs({ ...base })).toEqual(buildPersistentEncoderArgs({ ...base, playlistWindow: undefined }));
      expect(buildPersistentEncoderArgs({ ...base }).join(' ')).not.toContain('pipe:7');
    });

    it('declares pipe:7 as yuva420p at its own fps, last among inputs', () => {
      const args = buildPersistentEncoderArgs({ ...base, playlistWindow: PW });
      const i = args.indexOf('pipe:7');
      expect(args.slice(i - 9, i + 1)).toEqual(['-f', 'rawvideo', '-pix_fmt', 'yuva420p', '-s', '704x342', '-r', '30', '-i', 'pipe:7']);
      expect(args.lastIndexOf('-i')).toBe(i - 1);
    });

    it("layer 'top': right after the top canvas, before the equalizer", () => {
      const g = graphOf(buildPersistentEncoderArgs({ ...base, playlistWindow: PW, equalizer: { x: 0, y: 600, width: 400, height: 100 } }));
      // inputs: 0 canvas, 1 audio, 2 bg, 3 pulse, 4 playlist window
      expect(g).toContain('[4:v]format=yuva420p[plwin]');
      expect(g).toContain('[vcanvas_top][plwin]overlay=510:158[vplwin]');
      expect(g).toContain('[vplwin][pulse]overlay=0:600[vout]');
    });

    it("layer 'below' (bottom placement): right after the below canvas, UNDER the gifs", () => {
      const g = graphOf(buildPersistentEncoderArgs({ ...base, canvasPlacement: 'bottom', gifOverlays: [GIF], playlistWindow: { ...PW, layer: 'below' } }));
      // inputs: 0 canvas, 1 audio, 2 bg, 3 gif, 4 playlist window
      expect(g).toContain('[vcanvas_below][plwin]overlay=510:158[vplwin]');
      expect(g).toContain('[vplwin][gif0]overlay=0:0:format=rgb[vgif0]');
    });

    it("split: index follows the above-canvas input; 'top' sits after the above layer", () => {
      const g = graphOf(buildPersistentEncoderArgs({ ...base, canvasPlacement: 'split', gifOverlays: [GIF], playlistWindow: PW }));
      // 0 canvas, 1 audio, 2 bg, 3 gif, 4 above canvas, 5 playlist window
      expect(g).toContain('[5:v]format=yuva420p[plwin]');
      expect(g).toContain('[vcanvas_top][plwin]overlay=510:158[vplwin]');
    });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/ffmpeg/persistentEncoderArgs.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`persistentEncoderArgs.ts`: add `playlistWindow?: { x: number; y: number; width: number; height: number; fps: number; layer: 'below' | 'top' };` to the params and destructure it. Compute `const playlistWindowInputIndex = aboveCanvasInputIndex + (canvasPlacement === 'split' ? 1 : 0);`. Append to `inputs` (after the split entry):

```ts
    // The playlist window's BURST layer (PlaylistWindowFeeder): transparent while idle, the insert
    // animation during a burst — the settled window stays baked in pipe:3. Present only when the
    // template has a playlist element (decided once per session, like every input). Declared last,
    // so no earlier index moves. Its motion is rendered in Node: ffmpeg's overlay/drawbox refuse
    // runtime x/y commands (sendcmd spike: "Function not implemented").
    ...(playlistWindow
      ? ['-f', 'rawvideo', '-pix_fmt', 'yuva420p', '-s', `${playlistWindow.width}x${playlistWindow.height}`, '-r', String(playlistWindow.fps), '-i', 'pipe:7']
      : []),
```

Add a helper right before the gif loop, and call it at the two positions:

```ts
  const compositePlaylistWindow = () => {
    // Directly above the canvas layer the playlist element is baked into, so burst frames keep
    // the baked window's z-position relative to the gifs. Even x/y (computePlaylistWindowRegion)
    // makes yuv420 placement exact without GIF_OVERLAY_FORMAT's RGB round trip.
    filterLines.push(`[${playlistWindowInputIndex}:v]format=yuva420p[plwin]`);
    filterLines.push(`[${videoPad}][plwin]overlay=${playlistWindow!.x}:${playlistWindow!.y}[vplwin]`);
    videoPad = 'vplwin';
  };
```

- Inside `if (canvasPlacement !== 'top') { ...; videoPad = 'vcanvas_below'; }`, append `if (playlistWindow?.layer === 'below') compositePlaylistWindow();`.
- After the `vcanvas_top` block, add `if (playlistWindow && (playlistWindow.layer === 'top' || canvasPlacement === 'top')) compositePlaylistWindow();`. (For `top` placement there is no below layer, so a `'below'` value is treated as `'top'`.)
- Guard against compositing twice: `'below'` together with `canvasPlacement !== 'top'` matches only the first call.

`types.ts`: add to `ChildProcessWithPipes`:

```ts
  // The playlist window's burst layer (fd 7) — see PlaylistWindowFeeder. Same "always present,
  // sometimes written" arrangement as pulsePipe.
  readonly playlistWindowPipe: NodeJS.WritableStream;
```

`server.ts` `createPipeSpawner`: add an eighth `'pipe'` to stdio; `const playlistWindowPipe = stdio[7];` with `playlistWindowPipe.on('error', (err) => { console.error('playlist window pipe write error', err); });`; include it in the `Object.assign`; update the fd comment ("fd3/fd4/fd5/fd6/fd7 are video/audio/pulse/above-canvas/playlist-window"). If `PersistentEncoder` forwards named options into `buildPersistentEncoderArgs`, add `playlistWindow` there. Add `playlistWindowPipe: {}` to every fake encoder child in tests.

- [ ] **Step 4: Run to verify pass**

Run: `npx jest test/ffmpeg test/server.test.ts` then `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ffmpeg src/server.ts test
git commit -m "feat(ffmpeg): optional yuva420p pipe:7 burst layer composited at the playlist's own canvas layer"
```

---

### Task 9: Wire it through `buildStreamScene`, `LocalStreamManager` and `StreamController`

**Files:**
- Modify: `src/stream/streamScene.ts`, `src/stream/localStreamManager.ts`, `src/stream/streamController.ts`, `src/ffmpeg/overlayText.ts` (delete the two window-line builders), `src/playlist/queue.ts` (comment only)
- Test: `test/stream/streamScene.test.ts`, `test/stream/streamController.test.ts`, `test/stream/localStreamManager.test.ts` (fake scene gains the optional factory), `test/ffmpeg/overlayText.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `StreamScene.buildOverlay: (track: Track, windowRows: WindowRow[], opts?: { omitLivePlaylist?: boolean }) => Promise<NowPlayingOverlay>`
  - `StreamScene.createPlaylistWindowFeeder?: () => PlaylistWindowFeeder`
  - `export const PLAYLIST_WINDOW_FPS = VIDEO_FPS;` in `streamScene.ts`
  - `StreamControllerDeps.createPlaylistWindowFeeder?: () => { attach(pipe: NodeJS.WritableStream): void; showRows(rows: WindowRow[]): Promise<void>; animate(plan: InsertTransition): Promise<void>; goIdle(): void; close(): void }`

- [ ] **Step 1: Failing tests**

`test/stream/streamScene.test.ts` — change every existing `scene.buildOverlay(track)` call to `scene.buildOverlay(track, [])`. The existing `elements: DEFAULT_TEMPLATE_ELEMENTS` assertion stays **unchanged**: the playlist is still baked. Add a new `describe`:

```ts
describe('buildStreamScene — playlist window burst layer (pipe:7)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (renderTemplatePng as jest.Mock).mockResolvedValue(Buffer.from('fake-png'));
    (getImageFrameCount as jest.Mock).mockResolvedValue(1);
  });

  const style = { fontFamily: 'DejaVu Sans', bold: false, italic: false };
  const playlistEl = (x: number, y: number) => ({ type: 'playlist', x, y, width: 400, fontSize: 20, color: { mode: 'solid', color: '#ffffff' }, style });
  const titleEl = { type: 'title', x: 0, y: 0, width: 100, fontSize: 20, color: { mode: 'solid', color: '#ffffff' }, style };
  const ROWS = [{ key: 'b:0', text: '▶ a', isCurrent: true }, { key: 'i:0', text: '  queued', isCurrent: false }];
  const encoderArgs = async (deps: StreamSceneDeps, p: typeof params & { templateId?: string }) => {
    const pipeSpawner = jest.fn().mockReturnValue({ once: jest.fn(), kill: jest.fn(), pid: 1, stdout: null, stderr: null });
    const scene = await buildStreamScene({ ...deps, pipeSpawner } as unknown as StreamSceneDeps, p);
    scene.createPersistentEncoder({ rtmpUrl: 'rtmp://x/live', streamKey: 'k' }).start(() => {});
    return { scene, args: pipeSpawner.mock.calls[0][1] as string[] };
  };

  it('default template: the playlist stays BAKED, pipe:7 exists, and the rows become its lines', async () => {
    const { deps } = buildDeps();
    const { scene, args } = await encoderArgs(deps, params);
    expect(scene.createPlaylistWindowFeeder).toBeDefined();
    expect(args).toContain('pipe:7');
    await scene.buildOverlay(scene.tracks[0], ROWS);
    const call = (renderTemplatePng as jest.Mock).mock.calls[0][0];
    expect(call.elements).toEqual(DEFAULT_TEMPLATE_ELEMENTS);
    expect(call.playlistLines).toEqual(['▶ a', '  queued']);
  });

  it('variant A omits exactly the live playlist element', async () => {
    const { deps } = buildDeps();
    const { scene } = await encoderArgs(deps, params);
    await scene.buildOverlay(scene.tracks[0], ROWS, { omitLivePlaylist: true });
    const call = (renderTemplatePng as jest.Mock).mock.calls[0][0];
    expect(call.elements).toEqual(DEFAULT_TEMPLATE_ELEMENTS.filter((e) => e.type !== 'playlist'));
  });

  it('a second playlist element stays in variant A too (only the first animates, C12)', async () => {
    const { deps, templateRepository } = buildDeps();
    templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [playlistEl(10, 10), playlistEl(600, 10)] });
    const { scene } = await encoderArgs(deps, { ...params, templateId: 'tpl-1' });
    await scene.buildOverlay(scene.tracks[0], ROWS, { omitLivePlaylist: true });
    expect((renderTemplatePng as jest.Mock).mock.calls[0][0].elements).toEqual([playlistEl(600, 10)]);
  });

  it('no playlist element: no feeder, no pipe:7', async () => {
    const { deps, templateRepository } = buildDeps();
    templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [titleEl] });
    const { scene, args } = await encoderArgs(deps, { ...params, templateId: 'tpl-1' });
    expect(scene.createPlaylistWindowFeeder).toBeUndefined();
    expect(args).not.toContain('pipe:7');
  });

  it('off-canvas playlist element: no layer', async () => {
    const { deps, templateRepository } = buildDeps();
    templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [playlistEl(1400, 10)] });
    const { scene, args } = await encoderArgs(deps, { ...params, templateId: 'tpl-1' });
    expect(scene.createPlaylistWindowFeeder).toBeUndefined();
    expect(args).not.toContain('pipe:7');
  });
});
```

`test/stream/streamController.test.ts`: in `buildDeps()` add `windowSnapshot: jest.fn().mockReturnValue(BASE_ROWS)` to the queue fake (`const BASE_ROWS = [{ key: 'b:0', text: '▶ a', isCurrent: true }, { key: 'b:1', text: '  b', isCurrent: false }];` at file top), and add `playlistWindowPipe: {}` to `encoderChild`. Leave `buildDeps()`'s `buildOverlay` fake returning plain `overlayFor(t)`, so existing assertions such as `render` being called with `overlayFor(track('a'))` keep passing. Only `withFeeder()` below swaps in a variant-tagging fake. Then add:

```ts
  describe('playlist window burst layer', () => {
    const INSERTED_ROWS = [{ key: 'b:0', text: '▶ a', isCurrent: true }, { key: 'i:0', text: '  d', isCurrent: false }, { key: 'b:1', text: '  b', isCurrent: false }];
    function withFeeder() {
      const ctx = buildDeps();
      const feeder = { attach: jest.fn(), showRows: jest.fn().mockResolvedValue(undefined), animate: jest.fn().mockResolvedValue(undefined), goIdle: jest.fn(), close: jest.fn() };
      ctx.deps.createPlaylistWindowFeeder = jest.fn().mockReturnValue(feeder);
      ctx.deps.buildOverlay = jest.fn((t: Track, _rows: unknown, opts?: { omitLivePlaylist?: boolean }) =>
        Promise.resolve({ ...overlayFor(t), variant: opts?.omitLivePlaylist ? 'A' : 'B' }));
      return { ...ctx, feeder };
    }
    const settle = async () => { for (let i = 0; i < 30; i++) { jest.advanceTimersByTime(100); await Promise.resolve(); await Promise.resolve(); } };

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('attaches the feeder to pipe:7 and bakes the snapshot rows on start', async () => {
      const { deps, feeder, encoderChild } = withFeeder();
      await new StreamController(deps).start();
      expect(feeder.attach).toHaveBeenCalledWith(encoderChild.playlistWindowPipe);
      expect(deps.buildOverlay).toHaveBeenCalledWith(expect.anything(), BASE_ROWS);
    });

    it('enqueueTrack runs a burst: A is baked (and becomes currentOverlay), then B with the new rows', async () => {
      const { deps, queue, canvasFeeder, feeder } = withFeeder();
      const controller = new StreamController(deps);
      await controller.start();
      queue.windowSnapshot.mockReturnValue(INSERTED_ROWS);
      controller.enqueueTrack({ name: 'd', audioPath: '/tmp/d.mp3', coverPath: null });
      await settle();
      expect(feeder.showRows).toHaveBeenCalledWith(BASE_ROWS);
      expect(feeder.animate).toHaveBeenCalled();
      const variants = canvasFeeder.render.mock.calls.map((c: any[]) => c[0].variant);
      expect(variants).toContain('A');
      expect(variants[variants.length - 1]).toBe('B');
      expect(deps.buildOverlay).toHaveBeenLastCalledWith(expect.anything(), INSERTED_ROWS, { omitLivePlaylist: false });
      expect(feeder.goIdle).toHaveBeenCalled();
    });

    it("the timer's once-a-second re-render uses variant A while the burst is in progress", async () => {
      const { deps, queue, canvasFeeder, feeder } = withFeeder();
      deps.buildOverlay.mockImplementation((t: Track, _r: unknown, opts?: any) => Promise.resolve({ ...overlayFor(t), variant: opts?.omitLivePlaylist ? 'A' : 'B', timer: { x: 0, y: 0, fontSize: 10, color: '#fff', style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } } }));
      let releaseAnimate!: () => void;
      feeder.animate.mockImplementation(() => new Promise<void>((r) => { releaseAnimate = r; }));
      const controller = new StreamController(deps);
      await controller.start();
      queue.windowSnapshot.mockReturnValue(INSERTED_ROWS);
      controller.enqueueTrack({ name: 'd', audioPath: '/tmp/d.mp3', coverPath: null });
      await settle(); // now parked inside animate(), canvas is A
      canvasFeeder.render.mockClear();
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(canvasFeeder.render.mock.calls.every((c: any[]) => c[0].variant === 'A')).toBe(true);
      releaseAnimate();
      await settle();
    });

    it('next() during a burst aborts it (feeder idle) and the new track bakes normally (C2)', async () => {
      const { deps, queue, canvasFeeder, feeder } = withFeeder();
      feeder.animate.mockImplementation(() => new Promise<void>(() => {}));
      const controller = new StreamController(deps);
      await controller.start();
      queue.windowSnapshot.mockReturnValue(INSERTED_ROWS);
      controller.enqueueTrack({ name: 'd', audioPath: '/tmp/d.mp3', coverPath: null });
      await settle();
      feeder.goIdle.mockClear();
      await controller.next();
      expect(feeder.goIdle).toHaveBeenCalled();
      const last = canvasFeeder.render.mock.calls[canvasFeeder.render.mock.calls.length - 1][0];
      expect(last.variant).toBe('B');
    });

    it('enqueueTrack while idle/reconnecting runs no burst (C7)', () => {
      const { deps, feeder } = withFeeder();
      const controller = new StreamController(deps);
      controller.enqueueTrack({ name: 'd', audioPath: '/tmp/d.mp3', coverPath: null });
      expect(feeder.showRows).not.toHaveBeenCalled();
    });

    it('stop() closes the feeder', async () => {
      const { deps, feeder } = withFeeder();
      const controller = new StreamController(deps);
      await controller.start();
      controller.stop();
      expect(feeder.close).toHaveBeenCalled();
    });

    it('without a playlist element (no factory) enqueueTrack only queues', async () => {
      const { deps, queue } = buildDeps();
      const controller = new StreamController(deps);
      await controller.start();
      deps.buildOverlay.mockClear();
      queue.windowSnapshot.mockReturnValue(INSERTED_ROWS);
      controller.enqueueTrack({ name: 'd', audioPath: '/tmp/d.mp3', coverPath: null });
      expect(deps.buildOverlay).not.toHaveBeenCalled();
    });
  });
```

`test/ffmpeg/overlayText.test.ts`: delete the `buildPlaylistWindowLines`/`buildInsertedTrackWindowLines` suites (their behaviour lives in `windowSnapshot` now, Task 2).

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/stream test/ffmpeg/overlayText.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`streamScene.ts`:
- Import `computePlaylistWindowRegion`, `PlaylistWindowFeeder`, `PLAYLIST_WINDOW_VISIBLE_ROWS`, `PLAYLIST_WINDOW_BEFORE`/`AFTER` (delete the local constants), `WindowRow`, `windowRowLines`, `PlaylistElement`. Drop the overlayText window-builder import. Add `export const PLAYLIST_WINDOW_FPS = VIDEO_FPS; // Task 10's measured fallback rule may lower this to 15`.
- After computing `belowElements`/`canvasPlacement`:

```ts
  // The FIRST playlist element gets a burst layer (pipe:7) for insert animations. It stays BAKED
  // in the canvas like before — the layer is transparent except during a burst (see
  // PlaylistWindowAnimator). Later playlist elements (rare) are only ever baked. The layer sits
  // directly above whichever canvas layer the element is baked into.
  const livePlaylistElement = templateElements.find((e): e is PlaylistElement => e.type === 'playlist') ?? null;
  const livePlaylistRegion = livePlaylistElement
    ? computePlaylistWindowRegion(livePlaylistElement, { width: VIDEO_WIDTH, height: VIDEO_HEIGHT }, PLAYLIST_WINDOW_VISIBLE_ROWS)
    : null;
  const livePlaylist = livePlaylistElement && livePlaylistRegion
    ? {
        element: livePlaylistElement,
        region: livePlaylistRegion,
        layer: (canvasPlacement !== 'top' && belowElements.includes(livePlaylistElement) ? 'below' : 'top') as 'below' | 'top',
      }
    : null;
```

- `buildOverlay = async (track: Track, windowRows: WindowRow[], opts: { omitLivePlaylist?: boolean } = {})`: set `const playlistLines = windowRowLines(windowRows);` (delete the old `currentIndex`/builder logic), and inside `renderLayer` filter elements with `const shown = opts.omitLivePlaylist && livePlaylist ? elements.filter((e) => e !== livePlaylist.element) : elements;` before `applyOverlayOverride` and `resolveImageAssets`.
- `createPersistentEncoder`: add `playlistWindow: livePlaylist ? { x: livePlaylist.region.x, y: livePlaylist.region.y, width: livePlaylist.region.width, height: livePlaylist.region.height, fps: PLAYLIST_WINDOW_FPS, layer: livePlaylist.layer } : undefined,`.
- Return `createPlaylistWindowFeeder: livePlaylist ? () => new PlaylistWindowFeeder({ element: livePlaylist.element, region: livePlaylist.region, fps: PLAYLIST_WINDOW_FPS }) : undefined,`. Update the `StreamScene` interface: the `buildOverlay` signature, the new optional factory, and drop the `baseAnchorIndex` comment.

`localStreamManager.ts`: pass `createPlaylistWindowFeeder: scene.createPlaylistWindowFeeder` into the `StreamController` deps.

`streamController.ts`:
- Imports: `WindowRow`, `PLAYLIST_WINDOW_BEFORE`, `PLAYLIST_WINDOW_AFTER` (`../playlist/window`), `InsertTransition` (`../ffmpeg/playlistWindowTransition`), `PlaylistWindowAnimator`, `HANDOFF_HOLD_MS` (`./playlistWindowAnimator`).
- Deps: `buildOverlay: (track: Track, windowRows: WindowRow[], opts?: { omitLivePlaylist?: boolean }) => Promise<NowPlayingOverlay>;` and `createPlaylistWindowFeeder?` (type as in Interfaces above).
- Fields: `private playlistWindowFeeder: PlaylistWindowFeederLike | null = null; private playlistAnimator: PlaylistWindowAnimator | null = null; private bakedRows: WindowRow[] = []; private overlayGeneration = 0;`
  - `overlayGeneration` is separate from `sessionGeneration` on purpose: `pause()` bumps `sessionGeneration`, and a burst's canvas-B bake must still land while paused.
- `private windowRows(): WindowRow[] { return this.deps.queue.windowSnapshot(PLAYLIST_WINDOW_BEFORE, PLAYLIST_WINDOW_AFTER); }`
- `spawnPipeline()`, after the pulse wiring:

```ts
    if (this.deps.createPlaylistWindowFeeder) {
      const feeder = this.deps.createPlaylistWindowFeeder();
      feeder.attach(child.playlistWindowPipe);
      this.playlistWindowFeeder = feeder;
      this.playlistAnimator = new PlaylistWindowAnimator({
        feeder,
        bakeCanvas: (rows, opts) => this.bakeCanvas(rows, opts),
        getBakedRows: () => this.bakedRows,
        sleep: (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref(); }),
        holdMs: HANDOFF_HOLD_MS,
      });
    }
```

- `teardown()`: `this.playlistAnimator?.abort(); this.playlistWindowFeeder?.close(); this.playlistAnimator = null; this.playlistWindowFeeder = null; this.bakedRows = []; this.overlayGeneration += 1;`
- New private method:

```ts
  // The animator's hook back into the canvas: builds the current track's overlay from `rows`
  // (variant A omits the live playlist element), makes it currentOverlay — so the once-a-second
  // timer tick and pause()'s frozen frame re-render the RIGHT variant — and renders it. Returns
  // false when a track change (feedCurrentTrack bumps overlayGeneration) made the result stale.
  private async bakeCanvas(rows: WindowRow[], opts: { omitLivePlaylist: boolean }): Promise<boolean> {
    const generation = this.overlayGeneration;
    const track = this.deps.queue.current();
    if (!track || !this.canvasFeeder) return false;
    const overlay = await this.deps.buildOverlay(track, rows, opts);
    if (generation !== this.overlayGeneration || !this.canvasFeeder) return false;
    if (this.state !== 'streaming' && this.state !== 'paused') return false;
    this.currentOverlay = overlay;
    if (!opts.omitLivePlaylist) this.bakedRows = rows;
    const elapsed = this.state === 'paused' ? this.pausedElapsedSeconds : this.elapsedTrackSeconds();
    await this.canvasFeeder.render(overlay, this.timerText(elapsed));
    return true;
  }
```

- `feedCurrentTrack()` at the very top: `this.playlistAnimator?.abort(); this.overlayGeneration += 1; const rows = this.windowRows();` then `const overlay = await this.deps.buildOverlay(track, rows);`, and after the existing generation/state re-check set `this.bakedRows = rows;` next to `this.currentOverlay = overlay;`.
- `enqueueTrack()`:

```ts
  enqueueTrack(track: Track): void {
    this.deps.queue.insertNext(track);
    // Animate only when a picture is actually being produced; otherwise the next
    // feedCurrentTrack() simply bakes the new snapshot.
    if (this.playlistAnimator && (this.state === 'streaming' || this.state === 'paused')) {
      this.playlistAnimator.queueChanged(this.windowRows());
    }
    this.deps.onStatusChanged?.();
  }
```

`overlayText.ts`: delete `buildPlaylistWindowLines` and `buildInsertedTrackWindowLines`. Keep `formatDuration` and the drawtext-escaping NOTE. `queue.ts`: point `positionInBase()`'s comment at `windowSnapshot` (the method stays).

- [ ] **Step 4: Run to verify pass**

Run: `npm test` then `npm run build`
Expected: all green. `git diff --stat test/render/sceneRenderer.test.ts` must still show no change.

- [ ] **Step 5: Commit**

```bash
git add src/stream src/ffmpeg/overlayText.ts src/playlist test
git commit -m "feat(stream): bake the queue-aware window and animate inserts on the pipe:7 burst layer"
```

---

### Task 10: Real-binary verification (idle and burst measured separately), docs

**Files:**
- Modify: `CLAUDE.md`; possibly `src/stream/streamScene.ts` (`PLAYLIST_WINDOW_FPS`), per the fallback rule
- Scratch (not committed): a verification harness in your scratchpad directory

- [ ] **Step 1: Harness** (run inside the repo's own image after `npm run build`, so it uses the real ffmpeg 5.1.9 and fonts):
  1. Build a real scene with `buildStreamScene` against small in-memory fakes of the repositories (the default template, a 3-track playlist of short real audio files generated with `ffmpeg -f lavfi -i sine=d=120`).
  2. Build a real `StreamController` with that scene's factories, pushing to a file: `createPersistentEncoder({ rtmpUrl: '/tmp/out', streamKey: 'run.flv' })` yields `-f flv /tmp/out/run.flv`.
  3. Run A — **idle cost**: start, run 90 s with no inserts, stop.
  4. Run B — **baseline**: the same, with a template whose only difference is no playlist element — use `DEFAULT_TEMPLATE_ELEMENTS` minus the playlist, plus an equivalent `text` element at the same position, so the canvas work is comparable.
  5. Run C — **bursts**: start; at 20 s `enqueueTrack`; at 20.3 s another (coalescing); at 40 s `enqueueTrack` then `next()` 0.5 s later (abort); at 60 s a burst while paused; run to 90 s. Log a timestamped marker for every animator step (wrap the feeder/bakeCanvas in logging proxies).

- [ ] **Step 2: Idle vs baseline (A vs B)**
  - Steady-state `speed=`: the median of the last 30 progress lines.
  - `ps -o %cpu,rss` for the ffmpeg and node processes, sampled every second (median).
  - Bytes written to `pipe:7` per second, from a counter in a harness proxy around the pipe.
  - Output duration vs wall-clock (no timeline drift — the CanvasFeeder heartbeat scar).

  **Fallback rule:** if A's speed is < 0.98x, or A's ffmpeg CPU exceeds B's by more than 10 percentage points of one core, set `PLAYLIST_WINDOW_FPS = 15`, rerun A, and record both.

- [ ] **Step 3: Burst cost (C)**: the renders per burst (pool counter), peak node CPU and RSS during a burst, the two canvas re-renders' latency, and the total burst duration from `enqueueTrack` to idle.

- [ ] **Step 4: Pixel checks on run C's output**. Crop the region (`crop=W:H:X:Y`) at 30 fps between each burst's markers:
  - **Handoff overlaps (C19):** compare each frame's region luma histogram to the baked-only frame just before the burst. It may differ only slightly during the two 400 ms overlaps (heavier antialiasing): sum of |Δluma| over the region < 2% of the region's own text-luma sum. No frame may show two different row sets — check that the row count found by horizontal luma projection is never the sum of the from and to counts.
  - **Motion:** the row below the insertion point moves monotonically down between the canvas-A mark and the canvas-B mark, and the new row's luma ramps up.
  - **Colour match (C20):** in the last burst frame vs the first baked-B frame, the text pixels' Y/U/V deviate by ≤ 2 code values (sample with `-pix_fmt yuv420p` raw output).
  - **Fringe (C17):** no edge luma above the text colour's luma.
  - **Placement (C13):** pixels 2 px outside the region equal the background run's.
  - **Abort (C2):** after `next()` at 40.5 s, no moving rows remain once the new track's canvas has landed.

- [ ] **Step 5: Live look** — deploy to the stand (re-apply and verify the port-8088 mapping). With the default template, trigger a `songRequest` Test and a `libraryTrackRequest` Test a few seconds apart and watch the HLS preview. Each queued row should slide in, then stay baked; with nothing queued, the window must look exactly as before the change.

- [ ] **Step 6: CLAUDE.md**
  - Under "Backend streaming pipeline", add a bullet:

    > **The playlist window's insert animation (fd 7 / `pipe:7`, burst-only).** The settled window stays baked in the canvas (`playlistWindowNode`, byte-identical to before) from `PlaylistQueue.windowSnapshot()`, which now lists queued tracks. When the template has a playlist element, a yuva420p `pipe:7` exists for the session. `PlaylistWindowFeeder` keeps it fed with a transparent frame (`RawFramePacer`, extracted from `PulseVisualizer`). On a visible insert, `PlaylistWindowAnimator` runs frame 0 → hold → canvas A (window omitted) → hold → the 600 ms animation (the same Satori node, animated via row `maxHeight`/opacity/margin, rendered in its own piscina pool) → canvas B → hold → idle. Every switch overlaps identical content for `HANDOFF_HOLD_MS` = 2 canvas heartbeats. Composited directly above the canvas layer the playlist is baked into. Why not ffmpeg-side motion: `sendcmd`/`zmq` reach `overlay`/`drawbox`, which answer `Function not implemented` for x/y. Measured idle cost: <A vs B numbers>. Measured burst cost: <C numbers>.

  - Add the new files to the Layout tree: `rawFramePacer.ts`, `playlistWindowFeeder.ts`, `playlistWindowTransition.ts`, `src/playlist/window.ts`, `playlistWindowGeometry.ts`, `yuva420p.ts`, `playlistWindowRender{Worker,Pool}.ts`, `src/stream/playlistWindowAnimator.ts`.
  - Add `fd7 playlist-window burst layer` to the `types.ts` fd list.
  - In "Donation-triggered song requests", replace Phase B's `positionInBase()`/`buildInsertedTrackWindowLines()` sentence with: "the overlay's playlist window lists queued tracks via `PlaylistQueue.windowSnapshot()`, and each visible insertion animates on the `pipe:7` burst layer (see `PlaylistWindowAnimator`)".

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md src/stream/streamScene.ts
git commit -m "docs: record the pipe:7 burst layer and its measured idle and burst cost"
```
