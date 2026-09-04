# Template Editor UX Improvements — Design

## Motivation

The template editor (Stage 3) supports drag/resize/select and a
properties panel, but lacks the basic conveniences any real design work
needs: no undo, no way to reorder overlapping elements, no alignment
help, no way to duplicate a configured element, no keyboard fine-tuning,
and no protection against a long track title overflowing its box. This
spec covers five independent, mostly-frontend-only improvements
identified by the user as most valuable right now.

## Scope note: one of these five depends on the (separately planned,
not yet implemented) template-overlay-extensions "Part A" work

Four of the five features (undo/redo, layers panel + z-order, snap
guides, duplicate element, arrow-key nudge) operate on whatever elements
already exist in this editor today (`cover`/`title`/`playlist`/`timer`)
and need **zero** dependency on Part A landing first. The fifth (text
overflow ellipsis) targets `title` and the new `text` element type's
`style` field — both of which are Part A additions
(`docs/superpowers/specs/2026-09-04-template-overlay-extensions-design.md`,
`TextStyle`). **The overflow task in this plan cannot be built before
Part A's Task 1 (`TextStyle`) and Task 11 (the `text` element type in the
editor) land.** The other four tasks have no such ordering constraint and
can be built and shipped independently, before or after Part A.

## 1. Undo/redo

**Mechanism:** a snapshot-based history stack of the whole `elements`
array (not a fine-grained per-field diff) — simplest to reason about and
correct by construction (every undo step is just "restore array X"). A
new snapshot is pushed on every *completed* action: pointer-up after a
drag/resize gesture ends, a properties-panel field losing focus (or its
value committing, for controlled inputs that update on every keystroke —
debounce the snapshot push, not the input itself), add/remove/duplicate
element, reorder in the layers panel. **Never** push a snapshot on every
intermediate `pointermove` during a drag — that would flood the history
with hundreds of steps for one gesture and make undo useless (one undo
press should undo "that drag," not "that one pixel of that drag").

**UI:** `Ctrl+Z` / `Ctrl+Shift+Z` (and `Ctrl+Y` as a Windows-convention
alias for redo) global keyboard handlers while the editor is focused, plus
visible Undo/Redo buttons (disabled when the respective stack is empty)
near the Save button.

## 2. Layers panel + z-order

Element stacking order today is implicit (array order = render order,
later = on top) with no way to change it except delete-and-re-add. Adds a
new panel — **on the left side of the canvas** (canvas stays centered,
properties panel stays on the right — a three-column layout) — listing
every element in the template, top-of-list = frontmost (rendered last =
on top, matching the array's own convention, just displayed
front-to-back for a natural "what's on top" reading order).

- Clicking a list entry selects that element — the same selection state
  `selectedIndex` already drives for the canvas boxes and the properties
  panel; clicking an entry and clicking its canvas box are two paths to
  the same state, not two different mechanisms.
- Each entry gets ↑/↓ buttons that swap it with its neighbor in the
  `elements` array (moving `elements[i]` toward the front/back by one
  position) — **not** free drag-and-drop reordering. This was a
  deliberate scope decision: with a realistic template holding somewhere
  around 5-15 elements (the full current+planned element-type roster is
  seven types, and duplicating any of them stays modest), a plain list
  with move-up/move-down buttons is entirely sufficient and needs no new
  drag-and-drop library or hand-rolled reorder-by-pointer logic — the
  canvas's own element dragging is already hand-rolled pointer-event code
  for *positioning*, and reordering is a different, simpler problem that
  doesn't need the same machinery.
- Each entry shows the element's type + a short label (e.g. its `text`
  content for a `text` element, "Cover" for `cover`, etc.) so a list of
  several similar elements is still distinguishable at a glance.

## 3. Snap guides

**Scope: canvas-relative snapping only for this round** (horizontal/
vertical canvas center, and the four canvas edges) — **not**
element-to-element snapping. Snapping a dragged element against every
*other* element's edges/centers is a real O(n) comparison on every
pointermove and a materially bigger feature; canvas-relative snapping
alone already solves the most common real need (centering a title,
aligning a logo to an edge) with a much smaller, well-bounded change.
Element-to-element snapping is a reasonable, understood follow-up, not
forgotten — just not this round.

**Mechanism:** during `onCanvasPointerMove`'s existing drag-handling
branch, after computing the candidate new `x`/`y` (before clamping to
canvas bounds, which already happens), check whether the element's
center or edges land within a **threshold of 8 canvas px** of the
canvas's own center or edges; if so, snap the coordinate exactly to that
value and render a thin guide line (a simple absolutely-positioned `div`,
1px wide/tall, spanning the canvas) for as long as the snap is active.
Resize (`onCanvasPointerMove`'s resize branch) gets the same treatment
for the element's resulting edges.

## 4. Duplicate element

A "Duplicate" button in the properties panel, next to the existing
"Remove element" link. Clones the selected element (a plain object spread
— every field, including `style`/`color` if Part A has landed by the time
this is built) offset by `+20`/`+20` canvas px on `x`/`y` so the copy is
never pixel-identical-and-invisible on top of the original, inserts it
immediately after the original in the `elements` array (so it's
adjacent in the new layers panel too), and selects the new copy.

## 5. Text overflow (ellipsis) — depends on Part A, see scope note above

Adds one optional field to `TextStyle` (Part A):
```typescript
interface TextStyle {
  // ...existing fields from Part A...
  overflow?: 'ellipsis'; // absent = today's behavior (text can overflow its box, unchanged)
}
```
Only offered for `title` and the new `text` element type in the editor's
properties panel (a single checkbox — "Truncate with …" or similar) —
**not** `playlist` (intentionally multi-line, wrapping is the point) or
`timer` (fixed-format short strings, not user-authored length). Verified
directly against this project's real installed Satori
(`satori@^0.33.4`) during brainstorming: `whiteSpace: 'nowrap',
overflow: 'hidden', textOverflow: 'ellipsis'` on a fixed-width flex div
genuinely truncates with a visible `…`, confirmed by rendering and
visually inspecting real output — not assumed from documentation.
Auto-shrinking font size instead of truncating was considered and
explicitly rejected for this round: Satori has no native "fit text to
box" behavior, and building one would need an iterative
render-measure-shrink-retry loop with no verified visual-quality
guarantee — deferred, not forgotten, should a real need for it show up
later.

## Testing approach

Undo/redo, layers reordering, snapping, duplicate, and the overflow
checkbox are all component-level `TemplateEditor.tsx` behavior — covered
by `TemplateEditor.test.tsx` in the same style the file's existing
drag/resize/select tests already use (simulate pointer/keyboard events,
assert resulting `elements` state or rendered DOM). The overflow field's
actual Satori rendering behavior additionally needs one real-render test
in `sceneRenderer.test.ts` (mirroring how gradient/stroke/shadow got a
real render assertion in Part A) — this is exactly the kind of CSS
behavior this project has learned not to trust without checking against
the real binary.

## Out of scope (deliberately deferred)

- Element-to-element snapping (canvas-relative only, this round).
- Free drag-and-drop layer reordering (↑/↓ buttons only, this round).
- Auto-shrinking font size as an overflow strategy.
- Multi-line ellipsis / line-clamping for `playlist`.
- A keyboard shortcut for duplicate (button only, this round).
