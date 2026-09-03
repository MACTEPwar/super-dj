# Audio-Reactive Equalizer Element (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one new template element type — an audio-reactive spectrum
equalizer, rendered natively by ffmpeg (`showfreqs`) inside the persistent
encoder, not through the Satori/resvg pipeline every other element uses.

**Architecture:** A template's `equalizer` element (if present) is
discovered once at stream-start time (same pattern as the existing
`timer` element) and threaded into `PersistentEncoder`'s construction.
`buildPersistentEncoderArgs` conditionally adds a `-filter_complex` that
splits the audio input, feeds one branch into `showfreqs` to produce a
transparent reactive video layer, and overlays it onto the canvas video —
present only when the template actually uses an equalizer; every existing
template's encoder args are byte-for-byte unchanged otherwise. The element
is invisible to `sceneRenderer.ts` entirely (skipped like `timer` already
is) and cannot be live-previewed in the editor (no audio exists at
preview time) — the editor shows a static placeholder box instead.

**Tech Stack:** TypeScript/Express backend (existing), ffmpeg
`showfreqs`/`asplit`/`overlay` filters (existing ffmpeg binary, no new
dependency), React + Vite frontend (existing).

**Spec:** `docs/superpowers/specs/2026-09-04-audio-equalizer-element-design.md`
— read it before this plan. It documents a real ffmpeg spike's findings
(gradient and gapped-bars are NOT natively supported by `showfreqs`,
confirmed by rendering real test frames, not by reading docs) and the
resulting MVP scope decisions (solid color only, continuous-spectrum
look, always-topmost z-order, no live preview). This plan argues from
that spec — don't relitigate those decisions here.

## Global Constraints

- `EqualizerElement.color` is a plain hex string (`HEX_COLOR_PATTERN`),
  **not** the `ColorValue` (solid/gradient) type used by `title`/
  `playlist`/`text` — matches `TimerElement.color`'s existing precedent,
  for the same reason (the rendering mechanism can't do gradients).
- `buildPersistentEncoderArgs`'s output must be **byte-for-byte identical
  to today's** when no `equalizer` param is passed — no task in this plan
  may change the no-equalizer code path's behavior.
- Every generated `-filter_complex` string must be run through a real
  local `ffmpeg` process before being considered done — this project has
  a repeated, real history of filter strings that pass a string-shape
  unit test but fail (or silently misbehave) against the real binary
  (drawtext's double-colon escaping; this spec's own gradient/gap
  findings). String-shape tests alone are not sufficient sign-off for
  this plan's core task.
- `sceneRenderer.ts`'s `elementNode()` must treat `'equalizer'` exactly
  like the existing `'timer'` case: return `null`, unconditionally.

---

### Task 1: Data model — `EqualizerElement`, validation

**Files:**
- Modify: `src/templates/templateTypes.ts`
- Test: `test/templates/templateTypes.test.ts`

**Interfaces:**
- Produces: `EqualizerElement` added to the `TemplateElement` union;
  `isValidTemplateElement` grows one more branch. Every later task imports
  this type from here.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/templates/templateTypes.test.ts — add to the existing describe block
describe('isValidTemplateElement — equalizer', () => {
  it('accepts a valid equalizer element', () => {
    expect(isValidTemplateElement({
      type: 'equalizer', x: 10, y: 10, width: 400, height: 150, color: '#ffffff',
    })).toBe(true);
  });

  it('rejects an equalizer with a non-hex color', () => {
    expect(isValidTemplateElement({
      type: 'equalizer', x: 10, y: 10, width: 400, height: 150, color: 'not-a-color',
    })).toBe(false);
  });

  it('rejects an equalizer with an out-of-canvas position', () => {
    expect(isValidTemplateElement({
      type: 'equalizer', x: -1, y: 10, width: 400, height: 150, color: '#ffffff',
    })).toBe(false);
  });

  it('rejects an equalizer missing width/height', () => {
    expect(isValidTemplateElement({
      type: 'equalizer', x: 10, y: 10, color: '#ffffff',
    })).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/templates/templateTypes.test.ts`
Expected: FAIL — `'equalizer'` isn't in `ELEMENT_TYPES` yet.

- [ ] **Step 3: Implement**

```typescript
// src/templates/templateTypes.ts

export interface EqualizerElement {
  type: 'equalizer';
  x: number;
  y: number;
  width: number;
  height: number;
  color: string; // solid hex only — see the spec's "why not ColorValue" section
}

export type TemplateElement =
  | CoverElement | TitleElement | PlaylistElement | TimerElement | TextElement | ImageElement | EqualizerElement;
```

Add `'equalizer'` to `ELEMENT_TYPES`. In `isValidTemplateElement`, add a
branch alongside the existing `'cover'`/`'timer'` branches:

```typescript
if (el.type === 'equalizer') {
  return isValidSize(el.width, CANVAS_WIDTH) && isValidSize(el.height, CANVAS_HEIGHT) && isValidColor(el.color);
}
```

(Position is already checked earlier in the function via the existing
`isValidPosition(el.x, el.y)` call that runs for every non-`image` type —
confirm this by reading the function's current structure, Task 1 of the
template-overlay-extensions plan may or may not have already landed and
changed nearby lines depending on execution order between these two
plans; adapt the exact insertion point to whatever the file's real
current shape is.)

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

Run: `npx jest`
Expected: PASS. Fallout in `sceneRenderer.test.ts`/`templateRoutes.test.ts`
is not expected here (no existing test constructs a template containing
an `'equalizer'` element yet) — if there is any, note it in your report
but don't fix it in this task.

- [ ] **Step 5: Commit**

```bash
git add src/templates/templateTypes.ts test/templates/templateTypes.test.ts
git commit -m "feat: EqualizerElement type + validation"
```

---

### Task 2: `sceneRenderer.ts` — skip the equalizer entirely

**Files:**
- Modify: `src/render/sceneRenderer.ts`
- Test: `test/render/sceneRenderer.test.ts`

**Interfaces:**
- Consumes: `EqualizerElement` (Task 1).
- Produces: no new exported interface — `elementNode()` gets one more
  `case`, that's the whole task.

- [ ] **Step 1: Read the current `elementNode()`'s `'timer'` case first**

It should currently be `case 'timer': return null;` with a comment
explaining it's handled elsewhere. Confirm this against the real file —
if the template-overlay-extensions plan's Task 4 has already landed
(it may not have; these two plans' execution order isn't fixed by
anything written here), `elementNode` will have grown several other
cases too (`text`, `image`) — this task only touches the `equalizer`
case, ignore the rest.

- [ ] **Step 2: Write the failing test**

```typescript
it('renders a template containing an equalizer element without throwing, and produces no visible output for it', async () => {
  const png = await renderScene(
    [{ type: 'equalizer', x: 10, y: 10, width: 400, height: 150, color: '#ffffff' }],
    { title: 'x', playlistLines: [], coverDataUri: null },
    testOptions, // whatever this file's existing tests already pass — see this file's own
                 // established fixture, don't invent a new one
  );
  expect(png.length).toBeGreaterThan(0);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest test/render/sceneRenderer.test.ts`
Expected: FAIL — TypeScript's `switch` over `TemplateElement` isn't
exhaustive once `EqualizerElement` exists (a compile error, not a runtime
assertion failure, if `elementNode`'s switch has no default case relying
on exhaustiveness checking — confirm which by reading the file).

- [ ] **Step 4: Implement**

```typescript
// inside elementNode()'s switch, alongside the existing 'timer' case:
case 'equalizer':
  // Never part of the baked PNG — a native, continuously-updating ffmpeg filter
  // (showfreqs) composited by PersistentEncoder, not Satori. See the design spec.
  return null;
```

- [ ] **Step 5: Run tests, then the full suite**

Run: `npx jest`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/render/sceneRenderer.ts test/render/sceneRenderer.test.ts
git commit -m "feat: sceneRenderer skips equalizer elements (handled natively by ffmpeg, not Satori)"
```

---

### Task 3: `persistentEncoderArgs.ts` — conditional equalizer filter graph

**This is the core task — the rest of this plan is wiring around it.**

**Files:**
- Modify: `src/ffmpeg/persistentEncoderArgs.ts`, `src/ffmpeg/persistentEncoder.ts`
- Test: `test/ffmpeg/persistentEncoderArgs.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (this is pure ffmpeg-arg-building
  logic, no dependency on `TemplateElement` types — it takes a plain
  `EqualizerConfig` shape, decoupled from `templateTypes.ts` the same way
  `TimerElementPosition` in `segmentArgs.ts` is decoupled from
  `TimerElement`).
- Produces: `buildPersistentEncoderArgs`'s params gain an optional
  `equalizer?: EqualizerConfig` field;
  `EqualizerConfig = { x: number; y: number; width: number; height: number; color: string }`
  exported from this file. `PersistentEncoderParams` (in
  `persistentEncoder.ts`) gains the same optional field, passed straight
  through (that file today is a pure pass-through to
  `buildPersistentEncoderArgs`, confirmed by reading it — no logic change
  needed there beyond widening the interface). Task 4 depends on both.

**Confirmed by reading the real, current file** (reproduced here so
the diff is unambiguous):

```typescript
// src/ffmpeg/persistentEncoderArgs.ts, as it exists today
export function buildPersistentEncoderArgs(params: {
  width: number;
  height: number;
  fps: number;
  heartbeatFps: number;
  rtmpUrl: string;
  streamKey: string;
}): string[] {
  const { width, height, fps, heartbeatFps, rtmpUrl, streamKey } = params;
  return [
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${width}x${height}`, '-r', String(heartbeatFps), '-i', 'pipe:3',
    '-re', '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:4',
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', String(fps), '-g', String(fps * 2),
    '-c:a', 'aac', '-b:a', '192k',
    '-f', 'flv', `${rtmpUrl}/${streamKey}`,
  ];
}
```

- [ ] **Step 1: Write the failing tests**

```typescript
// test/ffmpeg/persistentEncoderArgs.test.ts — add to the existing describe block
it('is byte-for-byte identical to the no-equalizer output when equalizer is omitted', () => {
  const withoutField = buildPersistentEncoderArgs({
    width: 1280, height: 720, fps: 30, heartbeatFps: 5, rtmpUrl: 'rtmp://x', streamKey: 'k',
  });
  const withUndefined = buildPersistentEncoderArgs({
    width: 1280, height: 720, fps: 30, heartbeatFps: 5, rtmpUrl: 'rtmp://x', streamKey: 'k', equalizer: undefined,
  });
  expect(withUndefined).toEqual(withoutField);
});

it('adds a filter_complex with asplit/showfreqs/overlay and maps [vout]/[a_out] when equalizer is present', () => {
  const args = buildPersistentEncoderArgs({
    width: 1280, height: 720, fps: 30, heartbeatFps: 5, rtmpUrl: 'rtmp://x', streamKey: 'k',
    equalizer: { x: 40, y: 500, width: 400, height: 150, color: '#ff6600' },
  });
  const filterIndex = args.indexOf('-filter_complex');
  expect(filterIndex).toBeGreaterThan(-1);
  const filterArg = args[filterIndex + 1];
  expect(filterArg).toContain('[1:a]asplit=2[a_out][a_viz]');
  expect(filterArg).toContain('showfreqs=s=400x150:mode=bar:colors=#ff6600');
  expect(filterArg).toContain('overlay=40:500');
  expect(args).toEqual(expect.arrayContaining(['-map', '[vout]', '-map', '[a_out]']));
  expect(args).not.toEqual(expect.arrayContaining(['-map', '0:v']));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/ffmpeg/persistentEncoderArgs.test.ts`
Expected: FAIL — `equalizer` param doesn't exist yet.

- [ ] **Step 3: Implement**

```typescript
// src/ffmpeg/persistentEncoderArgs.ts — full replacement
export interface EqualizerConfig {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

export function buildPersistentEncoderArgs(params: {
  width: number;
  height: number;
  fps: number;
  heartbeatFps: number;
  rtmpUrl: string;
  streamKey: string;
  equalizer?: EqualizerConfig;
}): string[] {
  const { width, height, fps, heartbeatFps, rtmpUrl, streamKey, equalizer } = params;

  const inputs = [
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${width}x${height}`, '-r', String(heartbeatFps), '-i', 'pipe:3',
    '-re', '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:4',
  ];

  // Present only when the template actually has an equalizer element — every existing
  // template's args are completely unaffected. Splits the audio so the visualization branch
  // never touches what actually gets encoded as the stream's real audio; showfreqs draws a
  // transparent reactive spectrum (colorkey removes its own black background) which is then
  // overlaid on top of the already-composited canvas video. See the design spec for why this
  // is solid color / continuous-spectrum only for this MVP, and why it always renders above
  // every other element (it's composited after the canvas is already flattened, not part of
  // Satori's own element stacking).
  const mapping = equalizer
    ? [
        '-filter_complex',
        `[1:a]asplit=2[a_out][a_viz];` +
        `[a_viz]showfreqs=s=${equalizer.width}x${equalizer.height}:mode=bar:colors=${equalizer.color},format=yuva420p,colorkey=black:0.1:0.1[eq];` +
        `[0:v][eq]overlay=${equalizer.x}:${equalizer.y}[vout]`,
        '-map', '[vout]', '-map', '[a_out]',
      ]
    : ['-map', '0:v', '-map', '1:a'];

  return [
    ...inputs,
    ...mapping,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', String(fps), '-g', String(fps * 2),
    '-c:a', 'aac', '-b:a', '192k',
    '-f', 'flv', `${rtmpUrl}/${streamKey}`,
  ];
}
```

- [ ] **Step 4: Widen `PersistentEncoderParams` (pure pass-through, no logic change)**

```typescript
// src/ffmpeg/persistentEncoder.ts
import { buildPersistentEncoderArgs, EqualizerConfig } from './persistentEncoderArgs';

export interface PersistentEncoderParams {
  spawner: PipeSpawner;
  width: number;
  height: number;
  fps: number;
  heartbeatFps: number;
  rtmpUrl: string;
  streamKey: string;
  equalizer?: EqualizerConfig;
}
```

No other change to this file — `start()` already does
`buildPersistentEncoderArgs(this.params)`, which picks up the new field
automatically once it's part of the type.

- [ ] **Step 5: Run tests to verify they pass, then the full suite**

Run: `npx jest`
Expected: PASS.

- [ ] **Step 6: Real-ffmpeg verification — already done once during planning, repeat it against your own implementation**

This exact command was run for real during planning (not simulated) and
visually confirmed to produce a correctly positioned, correctly colored,
correctly transparent orange spectrum at `(40, 500)`, sized `400x150`, on
a black canvas — this is the ground truth your Task 3 code should
reproduce:

```bash
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=2" -f lavfi -i "color=c=black:s=1280x720:d=2" \
  -filter_complex "[0:a]showfreqs=s=400x150:mode=bar:colors=#ff6600,format=yuva420p,colorkey=black:0.1:0.1[eq];[1:v][eq]overlay=40:500[vout]" \
  -map "[vout]" -frames:v 1 -update 1 -y /tmp/eq-verify.png
```

(This single-frame PNG spot-check deliberately skips `asplit`/`a_out` and
only maps `[vout]` — a PNG output can't hold an audio stream at all, and
an unmapped `asplit` output pad is a real ffmpeg filtergraph validation
error, both discovered by actually running this during planning. The full
`asplit`+audio-mapped version is what Task 3's actual `buildPersistentEncoderArgs`
implementation and unit test use, and what Step 7 below verifies
end-to-end with real audio input over real elapsed time — this step is
just the fast visual sanity check.) Confirm the PNG visually shows the
expected spectrum shape at the expected position — don't just check exit
code 0. This project has real prior history of a filter string that's
syntactically valid JS but wrong ffmpeg syntax (drawtext's double-colon
escaping) — that's exactly the class of mistake this step catches, and
it already caught one during this plan's own writing (an earlier draft's
example command had video/audio input indices swapped and an unmapped
filter output — both invisible in a code read, both caught only by
actually running it).

- [ ] **Step 7: Verify the real persistent-encoder pipeline end-to-end, with real audio, for at least a few real seconds**

Using this project's established real-binary verification harness
pattern (see `verify-persistent-canvas.js`-style scripts used earlier
this project, run inside the built backend container against a synthetic
test track): start a `PersistentEncoder` with a real `equalizer` config,
feed it a few real seconds of a synthetic audio tone via `AudioRelay`,
capture output to a local file, and confirm by eye (extract a couple of
frames at different timestamps) that the equalizer region actually
changes between frames — a static/frozen equalizer region would mean the
filter graph is technically valid ffmpeg syntax but not actually reactive
in practice (e.g. a framerate-sync mismatch between the 5fps canvas input
and showfreqs' own internal rate). **Also watch CPU/encode speed
(`speed=` in ffmpeg's own progress output) during this run** — adding a
constantly-changing overlay region works against `-tune stillimage`'s
whole assumption of near-static frames, and this project already had a
real CPU-bound-encoder-falls-behind-real-time incident this session; if
`speed=` visibly degrades with the equalizer present under the same kind
of host contention, that's a real finding to report, not something to
silently work around by guessing at a fix.

- [ ] **Step 8: Commit**

```bash
git add src/ffmpeg/persistentEncoderArgs.ts src/ffmpeg/persistentEncoder.ts test/ffmpeg/persistentEncoderArgs.test.ts
git commit -m "feat: conditional showfreqs equalizer filter graph in the persistent encoder"
```

---

### Task 4: Wire equalizer discovery from `StreamManager` into `PersistentEncoder`

**Files:**
- Modify: `src/stream/streamManager.ts`
- Test: extend `test/stream/streamManager.test.ts`

**Interfaces:**
- Consumes: `EqualizerElement` (Task 1), `EqualizerConfig`/the widened
  `PersistentEncoderParams` (Task 3).

**Confirmed by reading the real, current file** — the exact pattern to
mirror already exists for `timer`:

```typescript
// src/stream/streamManager.ts, as it exists today
const bakedElements = templateElements.filter((e) => e.type !== 'timer');
const timerElement = templateElements.find((e): e is TimerElement => e.type === 'timer') ?? null;
// ...
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

- [ ] **Step 1: Write the failing test**

```typescript
it('passes the template equalizer element config through to PersistentEncoder construction', async () => {
  // construct a StreamManager the way this file's other tests already do, with a template
  // whose elements include one 'equalizer' element ({x,y,width,height,color})
  // start a session, then assert the fake createPersistentEncoder-equivalent (however this
  // file's tests currently intercept PersistentEncoder construction — read the file's existing
  // timer-element test for the pattern to copy) received an `equalizer` field matching it
});

it('passes no equalizer field when the template has none', async () => {
  // same setup without an equalizer element — assert the PersistentEncoder constructor args
  // have no `equalizer` field (or it's undefined)
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/stream/streamManager.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// alongside the existing bakedElements/timerElement lines
const equalizerElement = templateElements.find((e): e is EqualizerElement => e.type === 'equalizer') ?? null;
```

Also exclude it from `bakedElements` (it's already skipped by
`sceneRenderer.ts`'s `elementNode`, Task 2 — this is for clarity/
consistency with how `timer` is excluded, not strictly required for
correctness):

```typescript
const bakedElements = templateElements.filter((e) => e.type !== 'timer' && e.type !== 'equalizer');
```

Then in the `createPersistentEncoder` closure:

```typescript
createPersistentEncoder: () => new PersistentEncoder({
  spawner: this.deps.pipeSpawner,
  width: VIDEO_WIDTH,
  height: VIDEO_HEIGHT,
  fps: VIDEO_FPS,
  heartbeatFps: CANVAS_HEARTBEAT_FPS,
  rtmpUrl: session.rtmpUrl,
  streamKey: session.streamKey,
  equalizer: equalizerElement
    ? { x: equalizerElement.x, y: equalizerElement.y, width: equalizerElement.width, height: equalizerElement.height, color: equalizerElement.color }
    : undefined,
}),
```

Import `EqualizerElement` from `../templates/templateTypes` alongside the
existing `TimerElement` import.

- [ ] **Step 4: Run tests, then the full suite**

Run: `npx jest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stream/streamManager.ts test/stream/streamManager.test.ts
git commit -m "feat: wire template equalizer element into PersistentEncoder construction"
```

---

### Task 5: Editor UI — add the `equalizer` element type (placeholder box, no live reactivity)

**Files:**
- Modify: `frontend/src/pages/TemplateEditor.tsx`
- Modify: `frontend/src/i18n/locales/{en,ru,uk}.json`
- Test: extend `frontend/src/pages/TemplateEditor.test.tsx`

**Interfaces:**
- Consumes: `EqualizerElement` shape (mirrored from Task 1, same
  hand-kept-in-sync discipline this file already documents for every
  other element type).

- [ ] **Step 1: Read the current file's `addElement`/`defaultElement`/canvas-rendering section**

If the template-overlay-extensions plan's Task 11 has already landed by
the time this task executes, this file will already have `text`/`image`
handling and a `TemplateFormFields.tsx` extraction — read whatever the
real current state is rather than assuming either plan landed first;
this task only needs to add one more case alongside whatever's there.

- [ ] **Step 2: Add `'equalizer'` to the addable element types and `defaultElement`**

```typescript
case 'equalizer':
  return { type: 'equalizer', x: 100, y: 500, width: 400, height: 150, color: '#ffffff' };
```

`displayWidth`/`displayHeight` for `'equalizer'` behave like `cover` (it
has its own `width`/`height`, not a derived text-box size).

- [ ] **Step 3: Properties panel — position/size + a plain solid `ColorField`, no gradient toggle**

```tsx
{selected.type === 'equalizer' && (
  <ColorField label={t('templateEditor.fieldColor')} value={selected.color} onChange={(v) => updateElement(selectedIndex!, { color: v })} />
)}
```

(Same pattern as the existing `timer` color field — a plain string, not
`ColorValue` — do not route this through whatever solid/gradient toggle
component `title`/`playlist`/`text` might be using if that plan's work
has landed; `equalizer` and `timer` are both solid-only for a real
rendering-mechanism reason, not by omission.)

- [ ] **Step 4: Canvas placeholder — the interactive box needs its own visual fill, since there's no Satori-rendered content to show through it**

Every element already renders as a draggable/resizable interactive `div`
on top of the preview image (`{elements.map((el, i) => (<div ... />))}`).
For every other element type, the actual rendered picture is visible
*underneath* that box via `previewUrl`. For `equalizer`, nothing renders
there — Satori skips it entirely (Task 2) — so the box would look like an
empty invisible rectangle with no indication of what it is. Give it its
own fill so it's not blank:

```tsx
{elements.map((el, i) => (
  <div
    key={i}
    onClick={(e) => selectElement(e, i)}
    onPointerDown={(e) => startDrag(e, i)}
    className={`absolute cursor-move border-2 ${selectedIndex === i ? 'border-blue-500' : 'border-white/60 hover:border-white'}`}
    style={{
      left: el.x * SCALE, top: el.y * SCALE,
      width: displayWidth(el) * SCALE, height: displayHeight(el) * SCALE,
      ...(el.type === 'equalizer' ? { backgroundColor: el.color, opacity: 0.25 } : {}),
    }}
  >
    {/* existing label span, resize handle, unchanged */}
    {el.type === 'equalizer' && (
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-center text-xs text-white/90">
        {t('templateEditor.equalizerPlaceholder')}
      </span>
    )}
  </div>
))}
```

(Merge this into whatever the real current JSX for this element-rendering
loop looks like at execution time — the `style`/label additions are the
substance of this step, not a full replacement of surrounding code you
haven't read yet.)

- [ ] **Step 5: Add the new i18n keys to all three locale files**

`templateEditor.elementType.equalizer` (e.g. "Equalizer" / "Эквалайзер" /
"Еквалайзер"), `templateEditor.equalizerPlaceholder` — a short string
communicating "this reacts to sound live, not shown here" (e.g. English:
"Equalizer — reacts to sound during live playback, not shown here").
Match the existing tone of this file's other `templateEditor.*` entries
in Russian/Ukrainian, read all three before writing the new ones.

- [ ] **Step 6: Write component tests**

Cover: adding an equalizer element inserts it with sane defaults;
selecting it shows only a plain color field (no gradient toggle, if that
UI exists by the time this runs); the canvas box renders with the
placeholder label.

- [ ] **Step 7: Run the frontend suite**

Run: `cd frontend && npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
cd frontend && git add src/pages/TemplateEditor.tsx src/pages/TemplateEditor.test.tsx src/i18n/locales
git commit -m "feat: equalizer element in the template editor (placeholder box, no live preview)"
```

---

## Final Verification

- [ ] Full backend suite: `npx jest` — all green.
- [ ] Backend build: `npm run build` — clean.
- [ ] Frontend suite: `cd frontend && npx vitest run` — all green.
- [ ] Frontend build: `cd frontend && npm run build` — clean.
- [ ] Deploy to the 192.168.14.26 demo stand and run one real live stream
  with an equalizer-containing template, watching real audio actually
  move the visualization — this is the one feature in this whole project
  so far that is fundamentally unverifiable by preview or unit test alone;
  a real live check is not optional polish here, it's the only way to
  know the feature works at all.
