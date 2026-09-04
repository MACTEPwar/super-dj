# Template Editor UX Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Undo/redo, a layers panel with z-order control, canvas-relative
snap guides, element duplication, arrow-key nudge, and (dependent on the
separate template-overlay-extensions Part A plan) text-overflow ellipsis
for `title`/`text` elements — all in `TemplateEditor.tsx`.

**Architecture:** Everything in Tasks 1-5 is client-side React state
management inside the existing `TemplateEditor.tsx` component — no new
backend endpoints, no schema changes, no new dependencies. Task 6 is
gated on the template-overlay-extensions plan's Part A having landed
first (it needs `TextStyle` and the `text` element type, which don't
exist without it).

**Tech Stack:** React + TypeScript (existing), no new frontend
dependencies — reorder-by-button and canvas-relative snapping are both
deliberately scoped to avoid needing a drag-and-drop library.

**Spec:** `docs/superpowers/specs/2026-09-04-template-editor-ux-improvements-design.md`
— read it before this plan; it documents why element-to-element snapping,
free drag-and-drop layer reordering, and auto-shrink-to-fit text were all
explicitly scoped out of this round, and includes a real Satori
`text-overflow: ellipsis` render verification for Task 6.

## Global Constraints

- No task in this plan adds a new npm dependency to `frontend/package.json`.
- Undo/redo captures whole-`elements`-array snapshots, never a per-field
  diff — see Task 1's exact commit-point design; don't push a history
  entry on every intermediate `pointermove` of a drag/resize gesture, or
  on every keystroke of a text/number field — both would make undo
  practically useless (one undo press must undo "that gesture" or "that
  field edit," not one pixel or one keystroke).
- Every new interactive control in this plan (layers panel buttons, undo/
  redo buttons, duplicate button, snap guides) must not interfere with
  the canvas's existing pointer-event-based drag/resize/select handlers —
  read `onCanvasPointerMove`/`startDrag`/`startResize`/`endInteraction`
  before touching any of them.
- Arrow-key nudging must not fire while focus is inside a text/number
  input (it would hijack cursor movement or a number spinner instead of
  moving the selected element) — always check `document.activeElement`
  before handling an arrow key as a nudge.

---

### Task 1: Undo/redo

**Files:**
- Modify: `frontend/src/pages/TemplateEditor.tsx`
- Test: extend `frontend/src/pages/TemplateEditor.test.tsx`

**Interfaces:**
- Produces: `undo()`/`redo()` functions and `canUndo`/`canRedo` booleans
  used by both the keyboard handler and the toolbar buttons this task
  adds. No other task in this plan depends on this one — order relative
  to Tasks 2-5 doesn't matter, but every later task that mutates
  `elements` (duplicate in Task 4, snap-driven drag in Task 3) must call
  this task's commit functions at its own natural "gesture end" point —
  noted in each of those tasks below.

**The core design problem this task must get right:** by the time a drag
gesture's pointer-up fires, `elements` has *already* been mutated
continuously throughout the drag (`onCanvasPointerMove` calls
`updateElement` on every move) — the "before the drag" state is gone by
then. The undo snapshot must be captured at gesture **start**, not
gesture end.

- [ ] **Step 1: Write the failing tests**

```typescript
// frontend/src/pages/TemplateEditor.test.tsx — add to the existing test suite
it('undo restores the element position from before a drag gesture, not mid-drag', () => {
  // render the editor with one element loaded, simulate a full drag gesture (pointerdown at the
  // element, pointermove to a new position, pointerup), then press Ctrl+Z — assert the element's
  // x/y are back to their pre-drag values, not the mid-drag intermediate ones
});

it('undo/redo round-trips a single field edit in the properties panel', () => {
  // select an element, change its color via ColorField, blur the field, press Ctrl+Z — assert
  // the color reverts; press Ctrl+Shift+Z — assert it's re-applied
});

it('a new action after an undo clears the redo stack', () => {
  // undo once, then make a new edit — assert redo is now unavailable (canRedo false / button disabled)
});

it('undo/redo buttons are disabled when their respective stack is empty', () => {
  // fresh editor: undo disabled (nothing to undo); after one committed action: undo enabled, redo
  // still disabled until an undo happens
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run TemplateEditor`
Expected: FAIL — no undo/redo exists yet.

- [ ] **Step 3: Implement**

```typescript
// frontend/src/pages/TemplateEditor.tsx — additions to the existing component
const [past, setPast] = useState<TemplateElement[][]>([]);
const [future, setFuture] = useState<TemplateElement[][]>([]);
// Captures the "before" snapshot exactly once per gesture/edit-session, guarded so a gesture
// spanning many pointermove/updateElement calls only ever records its START state.
const gestureSnapshotRef = useRef<TemplateElement[] | null>(null);

function beginHistoryGesture() {
  if (gestureSnapshotRef.current === null) gestureSnapshotRef.current = elements;
}

function commitHistoryGesture() {
  const before = gestureSnapshotRef.current;
  gestureSnapshotRef.current = null;
  if (before === null) return;
  setPast((p) => [...p, before]);
  setFuture([]);
}

// For one-shot actions with no separate "gesture" phase (add/remove/duplicate) — captures the
// CURRENT elements as the undo target, then the caller applies its change immediately after.
function commitHistoryNow() {
  setPast((p) => [...p, elements]);
  setFuture([]);
}

// Deliberately NOT using the functional setState-updater form here (setPast(p => {... calls
// setFuture/setElements inside ...})) — React may invoke an updater function more than once
// (StrictMode's dev-mode double-invoke check being the concrete case that would bite here),
// which would double-fire the nested setFuture/setElements calls too. Reading `past`/`future`/
// `elements` directly from the surrounding closure is correct because undo/redo are plain
// event-handler functions re-created fresh every render (not stored across renders), so they
// always see the current values.
function undo() {
  if (past.length === 0) return;
  const previous = past[past.length - 1];
  setFuture((f) => [elements, ...f]);
  setPast((p) => p.slice(0, -1));
  setElements(previous);
}

function redo() {
  if (future.length === 0) return;
  const next = future[0];
  setPast((p) => [...p, elements]);
  setFuture((f) => f.slice(1));
  setElements(next);
}

const canUndo = past.length > 0;
const canRedo = future.length > 0;
```

Wire the gesture functions into the existing handlers:
- `startDrag`/`startResize`: call `beginHistoryGesture()` at the top (before setting `dragRef.current`/`resizeRef.current`).
- `endInteraction`: call `commitHistoryGesture()` (after the existing drag/resize-clearing logic, or before — order doesn't matter since they touch different state).
- Add `onFocus={beginHistoryGesture}` / `onBlur={commitHistoryGesture}` to `NumberField` and `ColorField` (both take these as new optional props, defaulting to no-ops if a caller doesn't pass them, so this doesn't break any other usage).
- `addElement`/`removeElement`: call `commitHistoryNow()` immediately before their existing `setElements` call.

Add the keyboard handler (a `useEffect` with a `window` listener, cleaned
up on unmount):

```typescript
useEffect(() => {
  function onKeyDown(e: KeyboardEvent) {
    const tag = (document.activeElement as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return; // Ctrl+Z inside a text field should be that field's own native undo
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  }
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}, [undo, redo]); // undo/redo close over past/future/elements — must be in the dependency array,
  // or wrap them in useCallback with correct deps; do not silence the exhaustive-deps lint rule
  // here instead of fixing it.
```

Add Undo/Redo buttons near the existing Save button, `disabled={!canUndo}`/`disabled={!canRedo}`.

- [ ] **Step 4: Run tests, then the full suite**

Run: `cd frontend && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/pages/TemplateEditor.tsx src/pages/TemplateEditor.test.tsx
git commit -m "feat: undo/redo in the template editor"
```

---

### Task 2: Layers panel + z-order

**Files:**
- Modify: `frontend/src/pages/TemplateEditor.tsx`
- Modify: `frontend/src/i18n/locales/{en,ru,uk}.json`
- Test: extend `frontend/src/pages/TemplateEditor.test.tsx`

**Interfaces:**
- Consumes: `commitHistoryNow` (Task 1) — reordering is a one-shot
  action, commit history before applying it, the same way `addElement`/
  `removeElement` do.

**The directional convention, stated precisely so it isn't reinvented
ambiguously at implementation time:** `elements[elements.length - 1]` is
the topmost/frontmost element (rendered last = on top, today's existing,
unchanged convention). The layers panel displays elements **reversed**
(frontmost first, so the visual top of the list = the actual frontmost
element — the natural reading order for "what's on top"). Because the
list is a simple reversal (not a re-sort), an item's neighbor *above* it
in the displayed list is always the element at the *next-higher* index in
the real `elements` array — so "move up" in the panel and "increment the
element's array index by swapping with its neighbor" are the same
operation, with no separate translation table to get wrong.

- [ ] **Step 1: Write the failing tests**

```typescript
it('the layers panel lists elements frontmost-first', () => {
  // elements: [cover, title, playlist] (playlist is frontmost, last in the array) — assert the
  // panel's rendered list order is playlist, title, cover
});

it('clicking a layer entry selects the same element clicking its canvas box would', () => {
  // click the layers-panel entry for "title" — assert selectedIndex / the properties panel now
  // shows title's fields, same as clicking its canvas box does today
});

it('moving a layer up swaps it toward the front of the elements array', () => {
  // elements: [cover, title, playlist] — click "move up" on the title entry — assert the
  // resulting elements array is [cover, playlist, title] (title swapped with the array-index-
  // adjacent playlist, moving toward the end/front)
});

it('move-up is disabled for the already-frontmost element, move-down disabled for the backmost', () => {});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run TemplateEditor`
Expected: FAIL — no layers panel exists yet.

- [ ] **Step 3: Implement**

```typescript
function moveElement(index: number, direction: 1 | -1): void {
  const target = index + direction;
  if (target < 0 || target >= elements.length) return;
  commitHistoryNow();
  setElements((els) => {
    const next = [...els];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });
  if (selectedIndex === index) setSelectedIndex(target);
  else if (selectedIndex === target) setSelectedIndex(index);
}

function layerLabel(el: TemplateElement): string {
  if (el.type === 'text') return el.text.slice(0, 20) || t('templateEditor.elementType.text');
  return t(`templateEditor.elementType.${el.type}`);
}
```

Add a new panel, positioned to the **left** of the existing canvas (the
current layout is `<div className="flex flex-wrap items-start gap-4">`
containing the canvas div then the properties-panel div — add the layers
panel as a new first child of that same flex container, `w-48 shrink-0`
matching the existing `w-64` properties panel's sizing convention):

```tsx
<div className="w-48 shrink-0 space-y-1 rounded-lg border p-3">
  <div className="text-sm font-medium">{t('templateEditor.layersTitle')}</div>
  {elements.map((el, i) => i).reverse().map((i) => (
    <div key={i} className={`flex items-center justify-between rounded px-2 py-1 text-sm ${selectedIndex === i ? 'bg-blue-50' : ''}`}>
      <button onClick={() => setSelectedIndex(i)} className="flex-1 truncate text-left">{layerLabel(elements[i])}</button>
      <div className="flex gap-1">
        <button onClick={() => moveElement(i, 1)} disabled={i === elements.length - 1} className="disabled:opacity-30">▲</button>
        <button onClick={() => moveElement(i, -1)} disabled={i === 0} className="disabled:opacity-30">▼</button>
      </div>
    </div>
  ))}
  {elements.length === 0 && <p className="text-xs text-gray-500">{t('templateEditor.layersEmpty')}</p>}
</div>
```

(The `▲` button — "move toward the front" — is `disabled` when `i` is
already `elements.length - 1`, the frontmost position; `▼` — "move toward
the back" — disabled at `i === 0`. Confirm this matches the directional
convention stated above once written, don't just trust this snippet
blindly if the surrounding component's structure turns out to differ
from what this plan assumed.)

- [ ] **Step 4: Add the new i18n keys**

`templateEditor.layersTitle` ("Layers" / "Слои" / "Шари"),
`templateEditor.layersEmpty` — to all three locale files, matching
existing tone.

- [ ] **Step 5: Run tests, then the full suite**

Run: `cd frontend && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd frontend && git add src/pages/TemplateEditor.tsx src/pages/TemplateEditor.test.tsx src/i18n/locales
git commit -m "feat: layers panel with z-order reordering in the template editor"
```

---

### Task 3: Snap guides (canvas-relative only)

**Files:**
- Modify: `frontend/src/pages/TemplateEditor.tsx`
- Test: extend `frontend/src/pages/TemplateEditor.test.tsx`

**Interfaces:**
- Consumes: nothing from other tasks — independent of Tasks 1/2/4/5.

- [ ] **Step 1: Read `onCanvasPointerMove`'s drag and resize branches in full before changing them**

Confirm the exact current computation of candidate `x`/`y` (drag) and
`width`/`height` (resize) before the existing `clamp(...)` calls — this
task inserts snapping *before* that existing clamp, it doesn't replace
it.

- [ ] **Step 2: Write the failing tests**

```typescript
it('dragging an element within 8px of the canvas horizontal center snaps its center exactly to it', () => {
  // element width 200, canvas width 1280 (center 640) — drag so the element's own computed
  // center lands at, say, 645 (5px off) — assert the committed x snaps to exactly
  // 640 - width/2 = 540, not 545
});

it('dragging more than 8px away from any snap target does not snap', () => {
  // drag to a position 20px off any canvas edge/center — assert x/y land exactly where dragged,
  // unmodified
});

it('a snap guide line renders while a snap is active, and clears on pointer-up', () => {});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd frontend && npx vitest run TemplateEditor`
Expected: FAIL.

- [ ] **Step 4: Implement**

```typescript
const SNAP_THRESHOLD_PX = 8;

function snapValue(value: number, targets: number[]): { value: number; snapped: boolean } {
  for (const t of targets) {
    if (Math.abs(value - t) <= SNAP_THRESHOLD_PX) return { value: t, snapped: true };
  }
  return { value, snapped: false };
}
```

Inside `onCanvasPointerMove`'s drag branch, after computing the
candidate (unclamped) `x`/`y` and before the existing `clamp(...)` call,
compute the element's candidate center (`x + width/2`, `y + height/2`)
and snap it against `[0, CANVAS_WIDTH / 2, CANVAS_WIDTH]` (x) /
`[0, CANVAS_HEIGHT / 2, CANVAS_HEIGHT]` (y) — note these targets cover
both the canvas center AND edges (an element's *center* landing on `0`
means its left edge is off-canvas by half its width, which is correct
snap-to-edge behavior for the element's edge, not its center, at that
target — if a distinct "snap the LEFT edge to 0" behavior is wanted
in addition to centering, check both `x` and the center against the edge
targets; the tests above only require center-based canvas-center
snapping and edge snapping to work, choose whichever of these two
equally-valid formulations passes them and keep the simpler one). Track
which axis snapped in a small piece of state (e.g.
`const [snapLines, setSnapLines] = useState<{ x: number | null; y: number | null }>({ x: null, y: null })`)
and render a 1px guide `div` spanning the canvas for each active axis.
Clear `snapLines` in `endInteraction`.

- [ ] **Step 5: Run tests, then the full suite**

Run: `cd frontend && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd frontend && git add src/pages/TemplateEditor.tsx src/pages/TemplateEditor.test.tsx
git commit -m "feat: canvas-relative snap guides while dragging/resizing"
```

---

### Task 4: Duplicate element

**Files:**
- Modify: `frontend/src/pages/TemplateEditor.tsx`
- Modify: `frontend/src/i18n/locales/{en,ru,uk}.json`
- Test: extend `frontend/src/pages/TemplateEditor.test.tsx`

**Interfaces:**
- Consumes: `commitHistoryNow` (Task 1).

- [ ] **Step 1: Write the failing tests**

```typescript
it('duplicating an element inserts a copy offset by +20/+20, selected, immediately after the original', () => {
  // select elements[1] (title, say), click Duplicate — assert elements now has length+1, the new
  // entry at index 2 is a deep-equal copy of the original except x+20/y+20, and selectedIndex is 2
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run TemplateEditor`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
function duplicateElement(index: number): void {
  commitHistoryNow();
  setElements((els) => {
    const copy = { ...els[index], x: els[index].x + 20, y: els[index].y + 20 };
    const next = [...els];
    next.splice(index + 1, 0, copy);
    return next;
  });
  setSelectedIndex(index + 1);
}
```

Add a "Duplicate" button in the properties panel, next to the existing
`removeElement` button:

```tsx
<button onClick={() => duplicateElement(selectedIndex!)} className="text-sm text-blue-600">{t('templateEditor.duplicateElement')}</button>
```

- [ ] **Step 4: Add the i18n key**

`templateEditor.duplicateElement` ("Duplicate" / "Дублировать" /
"Дублювати") to all three locale files.

- [ ] **Step 5: Run tests, then the full suite**

Run: `cd frontend && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd frontend && git add src/pages/TemplateEditor.tsx src/pages/TemplateEditor.test.tsx src/i18n/locales
git commit -m "feat: duplicate element button in the template editor"
```

---

### Task 5: Arrow-key nudge

**Files:**
- Modify: `frontend/src/pages/TemplateEditor.tsx`
- Test: extend `frontend/src/pages/TemplateEditor.test.tsx`

**Interfaces:**
- Consumes: `commitHistoryNow` (Task 1) — each nudge press commits its
  own history entry (a deliberate, stated simplification — see the
  spec's scope notes; holding an arrow key down producing several
  single-pixel undo steps is an accepted minor cost, not a bug to
  engineer away with debouncing in this round).

- [ ] **Step 1: Write the failing tests**

```typescript
it('arrow keys nudge the selected element by 1px, Shift+arrow by 10px', () => {
  // select an element, press ArrowRight — assert x increased by 1; press Shift+ArrowDown —
  // assert y increased by 10
});

it('arrow keys do nothing when no element is selected', () => {});

it('arrow keys do not nudge while focus is inside a text/number input', () => {
  // focus a NumberField input, press ArrowUp — assert the element's own x/y are UNCHANGED
  // (the browser's native number-input increment behavior, if any, is not this task's concern)
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run TemplateEditor`
Expected: FAIL.

- [ ] **Step 3: Implement**

Extend the same keyboard `useEffect` Task 1 added (don't create a second
`window` keydown listener):

```typescript
const ARROW_KEYS: Record<string, [number, number]> = {
  ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
};
// inside the existing onKeyDown, after the early-return guard for INPUT/TEXTAREA focus:
if (selectedIndex !== null && e.key in ARROW_KEYS) {
  e.preventDefault();
  const [dx, dy] = ARROW_KEYS[e.key];
  const step = e.shiftKey ? 10 : 1;
  commitHistoryNow();
  const el = elements[selectedIndex];
  updateElement(selectedIndex, {
    x: clamp(el.x + dx * step, 0, CANVAS_WIDTH),
    y: clamp(el.y + dy * step, 0, CANVAS_HEIGHT),
  });
}
```

- [ ] **Step 4: Run tests, then the full suite**

Run: `cd frontend && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/pages/TemplateEditor.tsx src/pages/TemplateEditor.test.tsx
git commit -m "feat: arrow-key nudge for the selected element"
```

---

### Task 6: Text overflow (ellipsis) — BLOCKED until template-overlay-extensions Part A lands

**Do not start this task until you have confirmed `TextStyle` and the
`text` element type already exist** in `src/templates/templateTypes.ts`
and `frontend/src/api/templates.ts` (template-overlay-extensions plan,
Task 1 and Task 10) — check the real files first; if they don't exist
yet, stop and report this task as blocked rather than improvising a
partial `TextStyle` shape that the other plan will conflict with later.

**Files:**
- Modify: `src/templates/templateTypes.ts`, `src/render/sceneRenderer.ts`,
  `frontend/src/pages/TemplateEditor.tsx` (or wherever Part A's Task 11
  put the shared `ColorValueField`/style controls — read that code first)
- Test: extend `test/templates/templateTypes.test.ts`,
  extend `test/render/sceneRenderer.test.ts`,
  extend `frontend/src/pages/TemplateEditor.test.tsx`

**Interfaces:**
- Consumes: `TextStyle`, `TextElement`, `TitleElement` (all from
  template-overlay-extensions Part A).

- [ ] **Step 1: Extend `TextStyle` with the optional `overflow` field**

```typescript
// src/templates/templateTypes.ts
export interface TextStyle {
  // ...existing Part A fields (fontFamily, bold, italic, stroke?, shadow?)...
  overflow?: 'ellipsis';
}
```

Extend `isValidTextStyle` (or wherever Part A's validation for this shape
lives) to accept `overflow` being absent or exactly `'ellipsis'` — reject
any other string.

- [ ] **Step 2: Write the failing validation test**

```typescript
it('accepts a TextStyle with overflow: ellipsis', () => {
  expect(isValidTemplateElement({
    type: 'title', x: 0, y: 0, width: 200, fontSize: 20,
    color: { mode: 'solid', color: '#ffffff' },
    style: { fontFamily: 'DejaVu Sans', bold: false, italic: false, overflow: 'ellipsis' },
  })).toBe(true);
});

it('rejects an invalid overflow value', () => {
  expect(isValidTemplateElement({
    type: 'title', x: 0, y: 0, width: 200, fontSize: 20,
    color: { mode: 'solid', color: '#ffffff' },
    style: { fontFamily: 'DejaVu Sans', bold: false, italic: false, overflow: 'clip' as unknown },
  })).toBe(false);
});
```

- [ ] **Step 3: Write the failing real-render test**

```typescript
// test/render/sceneRenderer.test.ts
it('a title with overflow: ellipsis truncates long text instead of overflowing its box', async () => {
  const png = await renderScene(
    [{ type: 'title', x: 0, y: 0, width: 200, fontSize: 30,
       color: { mode: 'solid', color: '#ffffff' },
       style: { fontFamily: 'DejaVu Sans', bold: false, italic: false, overflow: 'ellipsis' } }],
    { title: 'This Is A Very Long Track Title That Should Not Fit', playlistLines: [], coverDataUri: null },
    testOptions, testLoadFont, // reuse Part A Task 4's testLoadFont fixture
  );
  expect(png.length).toBeGreaterThan(0);
  // Verified by hand during brainstorming that Satori genuinely truncates with a visible
  // ellipsis glyph for this exact style combination — this test's bar is "doesn't throw and
  // produces real output," matching this file's existing convention for CSS-trick tests; if you
  // want to go further, visually inspect the output PNG once by hand the way brainstorming did,
  // don't build automated pixel-diffing for this.
});
```

- [ ] **Step 4: Implement in `sceneRenderer.ts`**

In `textStyleToCss` (Part A), add:
```typescript
if (style.overflow === 'ellipsis') {
  css.whiteSpace = 'nowrap';
  css.overflow = 'hidden';
  css.textOverflow = 'ellipsis';
}
```
Only apply this for element types where it makes sense — confirm
`textStyleToCss` is called from the `title`/`text` cases (single-line by
design) and **not** the `playlist` case (multi-line, wrapping is
intentional) before assuming this one shared function's output is safe
to use unconditionally; if `playlist` calls the same helper, either
special-case it there or accept that a playlist author could technically
enable `overflow: 'ellipsis'` on a playlist element with a confusing
visual result — decide explicitly rather than leaving this ambiguous, and
prefer restricting the *editor UI* checkbox to only `title`/`text` (Step
6) over a backend-level restriction, since the type itself is on the
shared `TextStyle`.

- [ ] **Step 5: Run tests to verify they pass, then the full suite**

Run: `npx jest`
Expected: PASS.

- [ ] **Step 6: Add the editor checkbox**

In whatever the properties panel's style controls look like once Part A
has landed (read that code first — it may already be a shared
`TemplateFormFields.tsx` component per Part A's Task 11), add a checkbox
bound to `selected.style.overflow === 'ellipsis'`, shown **only** when
`selected.type === 'title' || selected.type === 'text'`:

```tsx
{(selected.type === 'title' || selected.type === 'text') && (
  <label className="flex items-center gap-2 text-xs text-gray-600">
    <input
      type="checkbox"
      checked={selected.style.overflow === 'ellipsis'}
      onChange={(e) => updateElement(selectedIndex!, { style: { ...selected.style, overflow: e.target.checked ? 'ellipsis' : undefined } })}
    />
    {t('templateEditor.fieldOverflowEllipsis')}
  </label>
)}
```

Add `templateEditor.fieldOverflowEllipsis` ("Truncate with …" / "Обрезать
многоточием" / "Обрізати трикрапкою") to all three locale files.

- [ ] **Step 7: Run the frontend suite**

Run: `cd frontend && npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/templates/templateTypes.ts src/render/sceneRenderer.ts test/templates/templateTypes.test.ts test/render/sceneRenderer.test.ts
cd frontend && git add src/pages/TemplateEditor.tsx src/pages/TemplateEditor.test.tsx src/i18n/locales
git commit -m "feat: text-overflow ellipsis option for title/text elements"
```

---

## Final Verification

- [ ] Frontend suite: `cd frontend && npx vitest run` — all green.
- [ ] Frontend build: `cd frontend && npm run build` — clean.
- [ ] (Tasks 1-5 only) Backend untouched — `npx jest` and `npm run build`
  at the repo root should show zero diff-related changes; this is a
  frontend-only bundle for those five tasks.
- [ ] (Task 6 only, if built) Backend suite + build also green.
- [ ] Manual smoke pass in a real browser: undo/redo across a mix of
  drags, field edits, and add/remove; reorder layers and confirm the
  canvas visually restacks; drag near canvas center/edges and confirm
  guides appear and snapping feels right, not jittery; duplicate an
  element and confirm the copy is visibly offset; nudge with arrow keys
  and Shift+arrow. This entire plan is interactive UI feel that a test
  suite can assert the mechanics of but not the *feel* of — don't skip
  actually using it before calling this done.
