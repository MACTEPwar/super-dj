# Unified Color / Gradient Picker — Design

## Motivation

User request, verbatim (translated): *"also work on the colors — i.e. everywhere you can change
colors except the equalizer, make it so there's one consistent way to change color: i.e. if an
element has a color picker, the choice should be: solid color, gradient, gradient type. You should
be able to add points to it (stops), and each point has its own color."*

Today's `ColorValue` (`src/templates/templateTypes.ts:6-8`) already models solid-vs-gradient, but
the gradient half is a stub:

```typescript
export type ColorValue =
  | { mode: 'solid'; color: string }
  | { mode: 'gradient'; stops: [string, string] | [string, string, string]; angleDeg: number };
```

- **No gradient type.** Linear only, hardcoded in `sceneRenderer.ts:22`.
- **No addable stops.** `stops` is a fixed-arity tuple union — exactly 2 or 3. The editor
  (`frontend/src/components/TemplateFormFields.tsx`, `ColorValueField`, line 76) renders one
  `ColorField` per existing stop and has **no add or remove button at all**, so a 3-stop value can
  only ever arrive from a direct API call, never from the visual editor.
- **No stop positions.** Stops are bare colors; CSS spreads them evenly by implication.

Meanwhile the *equalizer* element — the one thing this round explicitly must not touch — already
has the add/remove-stop UI the user is asking for everywhere else
(`frontend/src/pages/TemplateEditor.tsx:767-806`, min 2 / max 6). So the ask is: bring the shared
picker up to (and past) the affordance the equalizer already has, and keep it the *single* control
every gradient-capable element uses.

## Scope finding: this is two call sites, not N element types

Worth stating up front, because it changes the shape of the work: `ColorValueField` is **already**
the one shared control, and it is used from exactly two places:

- `frontend/src/pages/TemplateEditor.tsx:761-763` — the `title | playlist | text` branch of the
  properties panel, `value={selected.color}` / `onChange={(v) => updateElement(i, { color: v })}`.
- `frontend/src/pages/Library.tsx:48` and `:61` — the per-track `overlayOverride` editor's
  `color` and `backgroundColor`.

Both already pass and receive a whole `ColorValue`. So "wire the new picker into each element
type's form" is **not** a task: if the component keeps its `{ label, value, onChange, onFocus,
onBlur }` prop signature, both call sites compile and behave unchanged, and every gradient-capable
element gets the new capability for free. The work is the *type*, the *renderer*, and the
*component's internals* — not a per-element rollout.

## Spike: what can Satori actually render?

Same discipline as every prior round in this project (see
`feedback_verify_against_real_binaries`): verified against the **installed** `satori@0.33.4` +
`@resvg/resvg-js`, not against documentation. Every case below was rendered for real and the
output pixels inspected (distinct quantized colors among lit pixels, plus which SVG gradient tag
Satori emitted).

| CSS fed to Satori | Result |
| --- | --- |
| `linear-gradient(45deg, #ff0000, #0000ff)` (today's shape) | OK, `<linearGradient>` |
| `linear-gradient(45deg, #ff0000 0%, #00ff00 20%, #0000ff 100%)` (explicit `%` offsets) | OK |
| `linear-gradient(90deg, …6 stops with offsets…)` | OK, 64 distinct colors |
| 8 stops with offsets | OK, 70 distinct colors |
| `linear-gradient(12.5deg, …)` — fractional angle | OK |
| `… #00ff00 33.333%` — fractional offset | OK |
| `#ff000080` / `#0000ffff` — 8-digit hex stops | OK (alpha honoured) |
| `radial-gradient(circle at 50% 50%, …)` | OK, `<radialGradient>` |
| `radial-gradient(ellipse at 20% 80%, …)` | OK |
| `radial-gradient(#ff0000 0%, #0000ff 100%)` — bare, no shape/position | OK, pixel-identical to `farthest-corner at 50% 50%` |
| `conic-gradient(from 0deg at 50% 50%, …)` | **THROWS** `Invalid background image: "conic-gradient(…)"` |
| Duplicate offsets `0/50/50/100` (a CSS "hard stop") | OK |
| Unsorted offsets `0/80/30/100` | Does **not** throw; renders as if clamped (25 distinct colors vs 39 sorted) — i.e. silently wrong picture |
| Offsets not spanning 0–100 (`20%`…`70%`) | OK (CSS pads the ends with the first/last color) |
| A single stop | OK (renders flat) |

Also verified **through the real `renderScene`** (not raw Satori): a gradient `ColorValue` applied
to a `title` element *and* to a `playlist` element — whose Satori node is a flex-column parent
with one child `<div>` per line — produces a real multi-color fill on both (12 distinct colors vs
2 for the solid baseline). So `backgroundClip: 'text'` survives the multi-line playlist node shape
that already exists today; nothing new is needed there.

**Conclusions baked into the design below as settled decisions:**

1. `linear` and `radial` are both offered. `conic` is **not** — it is a hard throw, which in the
   live pipeline means `StreamManager.buildOverlay` falls back to `BLANK_OVERLAY_PNG` (the whole
   layer goes blank, not just the one element) and on `POST /templates/{id}/preview` means a 500.
2. Arbitrary stop counts with explicit `%` offsets work. The 2–6 bound chosen below is a product
   decision, not a renderer limit.
3. Unsorted offsets are the one genuinely dangerous input — no error, just a wrong picture. The
   renderer therefore **sorts stops by offset before emitting the CSS string** (see below) rather
   than validation rejecting them.

## Data model

```typescript
// One gradient stop: a color plus where along the gradient axis it sits, in PERCENT (0-100).
export interface GradientStop {
  color: string;  // #RGB / #RGBA / #RRGGBB / #RRGGBBAA, same as everywhere else
  offset: number; // 0-100
}

export type ColorValue =
  | { mode: 'solid'; color: string }
  | {
      mode: 'gradient';
      gradientType: 'linear' | 'radial';
      stops: GradientStop[];   // 2-6
      angleDeg: number;        // 0-360; linear only, ignored (but retained) for radial
    };
```

### Why percent (0-100), not a 0-1 fraction

- The CSS string Satori consumes is percent-based (`#00ff00 33.333%`), so there is no conversion
  arithmetic and no float-formatting decision at the boundary — the number goes straight into the
  string.
- The editor's existing `NumberField` primitive
  (`frontend/src/components/TemplateFormFields.tsx:12`) is integer-stepped (`step = 1` by default)
  and takes `min`/`max`. `0..100` lands on it as-is; `0..1` would need `step={0.01}` and would
  route through its `decimals`/`snap` path for every keystroke.
- `angleDeg` is already a "human" `0-360` number in this same union. Percent keeps the whole shape
  in one unit idiom rather than mixing a fraction and a degree.

Fractional offsets are **allowed** by validation (verified to render). The editor just steps by 1.

### Why 2-6 stops

Precedent already in this codebase: `MIN_EQUALIZER_COLOR_STOPS = 2` / `MAX_EQUALIZER_COLOR_STOPS
= 6` (`src/templates/templateTypes.ts:151-152`). Reusing the same bounds means one mental model
across the whole editor, and the equalizer's own add/remove UI already trains the user on it. A
single stop is not a gradient (that is what `mode: 'solid'` is for), hence a hard minimum of 2.
Satori renders 8 stops fine, so 6 is deliberately a product ceiling, chosen for consistency — not
a renderer constraint.

### Why `angleDeg` stays on the union even for radial

`angleDeg` is declared unconditionally and validated unconditionally (`0-360`), even though
`colorValueToCss` ignores it when `gradientType === 'radial'`. Two reasons:

- Toggling linear → radial → linear in the editor must not silently lose the angle the author set.
  A conditional field would have to be re-defaulted on every toggle.
- `isValidColorValue` stays a flat sequence of checks rather than branching on `gradientType`,
  which is the style the rest of this hand-rolled validator is written in.

Radial **center / shape / size are not exposed** in v1. The emitted CSS is bare
`radial-gradient(<stops>)`, which is CSS's own default (`ellipse farthest-corner at center`) and
was verified to render pixel-identically to the explicit spelling. Adding `radialShape` /
`radialCenter` fields later is a purely additive change to the same union.

### Element coverage

| Element / field | Gets the new picker? | Why |
| --- | --- | --- |
| `title.color`, `playlist.color`, `text.color` | **Yes** — the whole point | Rendered by Satori as a text fill |
| `Track.overlayOverride.color` | **Yes**, automatically | Same `ColorValue` type, same `ColorValueField` component (`Library.tsx:48`) |
| `Track.overlayOverride.backgroundColor` | **Yes**, automatically | Rendered as a plain `backgroundImage` on the scene root (`sceneRenderer.ts:172-175`) |
| `equalizer.colors[]` | **No — explicitly excluded** | User's own instruction; it has its own `string[]` + glow model from the neon-pulse work |
| `timer.color` | **No** | Drawn by ffmpeg `drawtext`, which cannot render gradient text — the documented "Timer's drawtext ceiling" (see `2026-09-04-template-overlay-extensions-design.md`). Moving the timer into the Satori PNG would force a full Satori render **once per second per active stream**, which the overlay rework explicitly avoided |
| `style.stroke.color` | **No** | Maps to `-webkit-text-stroke-color`, which takes one color |
| `style.shadow.color` | **No** | Maps to `text-shadow`, which takes one color |

The three "No" cases keep the existing plain `ColorField` (swatch + hex text input) — which is
itself already the one shared primitive, so "one consistent way to change color" still holds:
every color control in the editor is either `ColorField` (solid-only by physics) or
`ColorValueField` (solid-or-gradient).

## Rendering

`src/render/sceneRenderer.ts` grows one shared pure helper and both existing call sites use it:

```typescript
// The CSS the renderer emits for a gradient ColorValue. Extracted so colorValueToCss (text fill)
// and backgroundToCss (scene background) can never drift, and so the frontend has one exact
// shape to mirror for its live gradient-strip preview.
export function gradientCss(color: Extract<ColorValue, { mode: 'gradient' }>): string {
  // Sorted, because SVG gradient stops must be non-decreasing: satori does NOT reject an
  // out-of-order CSS stop list, it renders a silently clamped (wrong) picture — verified against
  // the real satori+resvg (offsets 0/80/30/100 produced 25 distinct colors vs 39 sorted). A
  // STABLE sort, so two stops sharing an offset keep author order, which is exactly CSS's
  // "hard stop" semantics.
  const stops = [...color.stops]
    .sort((a, b) => a.offset - b.offset)
    .map((s) => `${s.color} ${s.offset}%`)
    .join(', ');
  return color.gradientType === 'radial'
    // Bare — CSS's own default (ellipse, farthest-corner, centre). Verified pixel-identical to
    // the explicit `ellipse farthest-corner at 50% 50%` spelling, with fewer moving parts.
    ? `radial-gradient(${stops})`
    : `linear-gradient(${color.angleDeg}deg, ${stops})`;
}
```

- `colorValueToCss` (line 19) — unchanged except `backgroundImage: gradientCss(color)`.
- `backgroundToCss` (line 172) — same.

Both already run inside the piscina render worker. `ColorValue` crosses that `postMessage`
structured-clone boundary (inside `elements`, and inside `SceneRendererOptions.background`) — this
is plain objects and arrays, which clone losslessly, unlike the `Buffer` problem this project hit
twice before. No re-wrapping needed; noted here only so nobody has to re-derive it.

## Legacy normalization

Nothing re-validates a stored template's elements on **read** — only on write (`templateRoutes.ts`
POST/PUT, and the preview endpoint's draft body). So the database can hold two older `ColorValue`
generations, and one of them is already a latent crash:

1. **Pre-`ColorValue`**: `color: '#ffffff'` — a bare string, from before
   `2026-09-04-template-overlay-extensions`. Today this reaches `colorValueToCss`, misses the
   `mode === 'solid'` branch, and falls through to `color.stops.join(...)` on `undefined` → a
   `TypeError` inside the render worker. Live that is a blank overlay layer; on the preview
   endpoint it is a 500.
2. **Gen-1 gradient**: `{ mode: 'gradient', stops: ['#a', '#b'], angleDeg: 45 }` — a `string[]`,
   no `gradientType`, no offsets.

A new exported `normalizeColorValue(value: unknown): ColorValue` absorbs both, following
`normalizeEqualizerElement`'s established precedent (strict on write, patch on read):

- A value that already satisfies the new `isValidColorValue` → returned as-is.
- A bare hex string → `{ mode: 'solid', color: <that string> }`.
- `{ mode: 'gradient', stops: string[] }` → `{ mode: 'gradient', gradientType: 'linear',
  stops: stops.map((c, i) => ({ color: c, offset: n > 1 ? (i * 100) / (n - 1) : 0 })),
  angleDeg: <valid angle, else 0> }`. Spreading the offsets evenly is exactly what CSS already
  does for an offset-less stop list, so **these templates render byte-identically to what they
  render today** — the migration is invisible, not a look change.
- Anything else (null, a number, an object with an unknown `mode`) →
  `{ mode: 'solid', color: '#ffffff' }`, with a `console.warn`, matching
  `normalizeEqualizerElement`'s "log and fall back rather than crash the render" policy.

**Where it is applied:** at the renderer boundary — `colorValueToCss` and `backgroundToCss` each
call it first. One change covers every path (live stream, preview endpoint, per-track override)
and it is the only place that reads stored elements without prior validation.

**`isValidColorValue` stays strict on write**, accepting only the new shape. That is deliberate:
writes only ever come from the editor, and the editor normalizes on load (below), so the old
shapes cannot be re-saved and the schema does not have to carry them forever. The one thing this
demands is that the frontend's own `normalizeElements()` handles legacy colors — otherwise opening
an old template would make both `PUT /templates/{id}` (400) and the debounced
`POST /templates/{id}/preview` (400, swallowed as "keep the last good preview") fail silently.

## Frontend

### The shared component

`ColorValueField` in `frontend/src/components/TemplateFormFields.tsx` is rewritten in place —
**same export name, same props** (`{ label, value, onChange, onFocus, onBlur }`), so
`TemplateEditor.tsx:762` and `Library.tsx:48,61` need no change at all.

Internals, top to bottom:

1. **Mode toggle** — the existing two `<button>`s (`Solid` / `Gradient`), unchanged text and
   unchanged `handleModeToggle` focus→change→blur trick that makes a toggle exactly one undo
   entry. (`TemplateEditor.test.tsx:637` asserts that behaviour; `TemplateFormFields.test.tsx:146`
   asserts the payload — that payload changes, the mechanism does not.)
2. **Gradient-type toggle** — two more `<button>`s (`Linear` / `Radial`), same one-undo-entry
   trick. Buttons rather than a `<select>` to match the existing idiom and keep the tests'
   `getByText(...)` queries working.
3. **Gradient preview strip** — a ~16px-tall `<div>` whose inline `style.background` is the *exact
   same CSS string the backend will emit*, built by a hand-kept frontend mirror of `gradientCss`.
   In v1, not a stretch goal: per-stop numeric offsets are hard to reason about blind, and the
   real backend preview is 400ms + a network round trip away. The frontend mirror carries the same
   "kept in sync by hand, like every other frontend mirror of backend logic in this project"
   comment `PulseEqualizerPreview.tsx` already uses.
4. **Per-stop row** — for each stop: a `ColorField` labelled
   `t('templateEditor.fieldGradientStop', { n: i + 1 })` (**keep this key and format** — three
   existing tests query `getByLabelText('Stop 1')`), a `NumberField` for the offset
   (`min = 0`, `max = 100`, `step = 1`), and a Remove button rendered only when
   `stops.length > 2`.
5. **Add-stop button** — rendered only when `stops.length < 6`.
6. **Angle** — the existing `NumberField` (`max = 360`), rendered only when
   `gradientType === 'linear'`.

Add/remove follow the equalizer's precedent of `commitHistoryNow()`-style one-shot history rather
than the focus/blur gesture pair — here expressed the way `handleModeToggle` already does it
inside the component (`onFocus?.(); onChange(next); onBlur?.();`), so `Library.tsx`, which passes
no `onFocus`/`onBlur` at all, keeps working.

**Add-stop offset rule:** on Add, the new stop's color is `#ffffff` and **every** stop's offset is
re-spread evenly across 0–100 (`Math.round((i * 100) / (n - 1))`). On Remove, the remaining stops'
offsets are left exactly as they are. Rationale: adding a stop is a deliberate structural change
where "evenly spaced" is the only sensible default (and is exactly what the offset-less legacy
shape meant), whereas removing one must not silently move stops the author positioned. One rule,
no special cases, and the result is always visibly different from before the click — unlike
appending a stop at an offset that collides with an existing one.

### Types and legacy handling

- `frontend/src/api/templates.ts:5-7` — mirror the new `GradientStop` / `ColorValue` exactly.
- A new `frontend/src/api/colorValue.ts` (or a small section of `TemplateFormFields.tsx`) carrying
  the hand-kept `gradientCss` mirror plus `normalizeColorValue`, used by both the preview strip
  and the editor's load-time normalization.
- `TemplateEditor.tsx`'s `normalizeElements()` (lines 119-134, today equalizer-only) gains a
  branch: for `title | playlist | text`, `color: normalizeColorValue(el.color)`. This is what
  keeps an old template openable, previewable and re-savable.

### Live preview

Nothing extra is needed. `TemplateEditor.tsx`'s preview effect (lines 221-233) is a `useEffect` on
`[templateId, elements]` identity with a 400ms debounce, and every control already routes through
`updateElement` → `setElements`. Once `colorValueToCss` understands the new shape, the real
Satori+resvg preview is correct automatically. The only thing to be aware of is the one already
noted above: the draft body is validated with `isValidTemplateElements` server-side
(`templateRoutes.ts:98`), so a legacy-shaped draft silently keeps the last good preview — which is
exactly why the editor normalizes on load.

### i18n

Five new keys under `templateEditor`, added to **all three** locales (en/ru/uk are currently
key-identical, 53 keys each, and must stay that way):

| Key | en |
| --- | --- |
| `templateEditor.gradientTypeLinear` | `Linear` |
| `templateEditor.gradientTypeRadial` | `Radial` |
| `templateEditor.fieldGradientStopOffset` | `Stop {{n}} position` |
| `templateEditor.addGradientStop` | `+ Add stop` |
| `templateEditor.removeGradientStop` | `Remove` |

Existing keys `colorModeSolid`, `colorModeGradient`, `fieldGradientStop`, `fieldGradientAngle`
are reused unchanged.

## OpenAPI

`src/api/openapi.ts:761-783`'s `ColorValue` schema gains `gradientType` (enum `linear`/`radial`,
required), changes `stops` from `array of string, minItems 2, maxItems 3` to an array of
`{ color: string; offset: number }` with `minItems: 2, maxItems: 6`, and the description drops the
word "linear". `TrackOverlayOverride` and `TemplateElement` reference it by `$ref` and need no
change.

## Testing approach

- `test/templates/templateTypes.test.ts` — extend the existing
  `describe('isValidTemplateElement — ColorValue and TextStyle')` block (line 84): valid
  linear/radial, 2 and 6 stops, rejects 1 stop, rejects 7 stops, rejects a missing/unknown
  `gradientType`, rejects a non-hex stop color, rejects an offset outside 0-100, rejects a
  non-numeric offset, rejects the **old** `stops: string[]` shape (this is the strict-on-write
  decision, asserted). Plus a new `describe('normalizeColorValue')`: passes a valid new value
  through unchanged, maps a bare hex string to solid, maps the gen-1 gradient to evenly-spread
  offsets + `linear`, falls back to white on garbage.
- `test/render/sceneRenderer.test.ts` — this file already renders for real (no mocked
  satori/resvg), so add real-render cases: a radial gradient title, a 6-stop linear gradient, a
  legacy string color, and a legacy `stops: string[]` gradient — each asserting a valid,
  non-trivial PNG. Plus pure-function assertions on `gradientCss`: the emitted string for
  linear/radial, and that **unsorted input comes out sorted**.
- `frontend/src/components/TemplateFormFields.test.tsx` — the existing `ColorValueField` block
  (line 137) needs its expected payloads updated (the mode-toggle default becomes a 2-stop
  `GradientStop[]` with `gradientType: 'linear'`), plus new cases: the linear/radial toggle, Add
  raises the stop count and re-spreads offsets, Remove lowers it, Add hidden at 6 stops, Remove
  hidden at 2 stops, the angle field hidden for radial.
- `frontend/src/pages/TemplateEditor.test.tsx` — ~15 fixtures embed
  `color: { mode: 'solid', color: '#ffffff' }` (unaffected), but the gradient cases at lines 296,
  597 and 637 carry the old gradient shape and must be updated. Add one case: opening a template
  whose title carries a legacy string color renders the picker in solid mode without throwing.
- **Real-render verification before calling it done** (this project's own repeated lesson): the
  Satori capability matrix above is already done and is the load-bearing part. Still to do once
  the code exists — drive `POST /templates/{id}/preview` with a radial 6-stop gradient against a
  real running backend and look at the returned PNG, since that is the one path where a wrong CSS
  string produces a 500 rather than a test failure.

## Out of scope (deliberately deferred)

- **The equalizer.** `EqualizerElement.colors: string[]`, `src/audio/pulseEngine.ts`,
  `src/render/pulseSvg.ts` and the equalizer's own editor controls are untouched, per the user's
  explicit instruction.
- **`conic-gradient`.** Verified to throw in satori 0.33.4 — offering it would blank a live
  overlay layer.
- **Gradients on `timer.color`, `style.stroke.color`, `style.shadow.color`.** Each maps to a
  renderer that takes exactly one color (ffmpeg `drawtext`, `-webkit-text-stroke-color`,
  `text-shadow`).
- **Radial center / shape / size fields.** Fixed at CSS's default; purely additive later.
- **A draggable gradient bar** (drag a stop along the strip to set its offset, click the strip to
  insert one). The v1 strip is display-only; offsets are set with a numeric field. Making the
  strip interactive is a self-contained follow-up that changes no data shape.
- **Reordering stops by drag.** Sorting is by `offset` at render time, so the array order is not
  user-visible except as the tie-break for equal offsets.
- **A database migration.** `StreamTemplate.elements` is `Json` and `Track.overlayOverride` is
  `Json`; the shape change needs no schema migration, and `normalizeColorValue` handles the old
  rows in place.
