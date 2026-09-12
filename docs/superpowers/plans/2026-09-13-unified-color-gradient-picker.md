# Unified Color / Gradient Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every gradient-capable template color field ONE consistent control — solid vs
gradient, linear vs radial, and 2–6 add/removable stops each with its own color and position —
without touching the equalizer.

**Architecture:** `ColorValue` (already a shared discriminated union in
`src/templates/templateTypes.ts`) grows `gradientType` and turns `stops` from a fixed 2-or-3 tuple
of bare color strings into a `GradientStop[]` of `{ color, offset }`. `sceneRenderer.ts` gets one
shared `gradientCss()` helper both its color call sites use, plus a `normalizeColorValue()` guard
at the boundary so templates saved in either older shape keep rendering. The frontend's existing
shared `ColorValueField` is rewritten in place — same export name, same props — so its two call
sites (`TemplateEditor.tsx`, `Library.tsx`) need no change and every element that already uses it
gets the new capability for free.

**Tech Stack:** TypeScript/Node, `satori` 0.33.4 + `@resvg/resvg-js` (both already dependencies),
React/Vite frontend, Jest (backend) / Vitest + Testing Library (frontend).

**Spec:** `docs/superpowers/specs/2026-09-13-unified-color-gradient-picker-design.md` — read this
first. Its "Spike: what can Satori actually render?" section is a **completed, real-binary
verification**; its findings are settled decisions baked into the code below, not open questions.

## Global Constraints

- **Do not touch the equalizer.** `EqualizerElement.colors: string[]`, `src/audio/pulseEngine.ts`,
  `src/render/pulseSvg.ts`, `src/ffmpeg/pulseVisualizer.ts`, `PulseEqualizerPreview.tsx` and the
  equalizer branch of `TemplateEditor.tsx`'s properties panel are all out of scope.
- **Never emit `conic-gradient`.** Verified against the installed satori: it throws
  `Invalid background image`, which blanks the whole live overlay layer and 500s the preview
  endpoint.
- **Gradient stops must be sorted by offset before they reach CSS.** Satori does not reject an
  out-of-order stop list — it silently renders a clamped, wrong picture. Sorting lives in
  `gradientCss()`, not in validation.
- `isValidColorValue` stays **strict on write** (new shape only). Older shapes are tolerated only
  on read, via `normalizeColorValue`. This mirrors `normalizeEqualizerElement`'s existing
  strict-write / patch-read split.
- Keep `ColorValueField`'s export name and prop signature
  (`{ label, value, onChange, onFocus, onBlur }`) — `Library.tsx` passes no `onFocus`/`onBlur` and
  must keep working.
- Keep the i18n key `templateEditor.fieldGradientStop` and its `"Stop {{n}}"` format — three
  existing tests query `getByLabelText('Stop 1')`.
- `en.json` / `ru.json` / `uk.json` must stay key-identical (they are today: 53 keys each under
  `templateEditor`, same order).
- Follow the existing hand-rolled-validator style in `templateTypes.ts`; do not introduce a schema
  library.
- Frontend mirrors of backend logic are kept in sync **by hand** in this project — say so in a
  comment, the way `PulseEqualizerPreview.tsx` does.
- Commit trailer: use whatever `Co-Authored-By:` attribution line your own session's instructions
  specify. The `Co-Authored-By: Claude <noreply@anthropic.com>` lines below are placeholders.

---

### Task 1: `ColorValue` schema — gradient type, positioned stops, legacy normalization

**Files:**
- Modify: `src/templates/templateTypes.ts`
- Modify: `src/api/openapi.ts`
- Test: `test/templates/templateTypes.test.ts`

**Interfaces:**
- Produces: `GradientStop { color: string; offset: number }`, the extended `ColorValue` union,
  `isValidColorValue` (existing export, tightened), `normalizeColorValue` (new export).
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

In `test/templates/templateTypes.test.ts`, the existing block
`describe('isValidTemplateElement — ColorValue and TextStyle', ...)` starts at line 84 and contains
three gradient cases (around lines 98, 106, 114) built on the OLD `stops: string[]` shape. Replace
those three `it(...)` blocks with the set below, and append a new `describe('normalizeColorValue')`
block at the end of the file.

Add `normalizeColorValue` to the import on line 1.

```typescript
  const titleWith = (color: unknown) => ({
    type: 'title', x: 0, y: 0, width: 400, fontSize: 24, color,
    style: { fontFamily: 'DejaVu Sans', bold: false, italic: false },
  });

  it('accepts a linear gradient with positioned stops', () => {
    expect(isValidTemplateElement(titleWith({
      mode: 'gradient', gradientType: 'linear',
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 100 }],
      angleDeg: 45,
    }))).toBe(true);
  });

  it('accepts a radial gradient', () => {
    expect(isValidTemplateElement(titleWith({
      mode: 'gradient', gradientType: 'radial',
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 100 }],
      angleDeg: 0,
    }))).toBe(true);
  });

  it('accepts the maximum of 6 stops', () => {
    const stops = new Array(6).fill(null).map((_, i) => ({ color: '#ffffff', offset: i * 20 }));
    expect(isValidTemplateElement(titleWith({ mode: 'gradient', gradientType: 'linear', stops, angleDeg: 0 }))).toBe(true);
  });

  it('rejects a gradient with fewer than 2 stops', () => {
    expect(isValidTemplateElement(titleWith({
      mode: 'gradient', gradientType: 'linear', stops: [{ color: '#ff0000', offset: 0 }], angleDeg: 0,
    }))).toBe(false);
  });

  it('rejects a gradient with more than 6 stops', () => {
    const stops = new Array(7).fill(null).map((_, i) => ({ color: '#ffffff', offset: i * 10 }));
    expect(isValidTemplateElement(titleWith({ mode: 'gradient', gradientType: 'linear', stops, angleDeg: 0 }))).toBe(false);
  });

  // conic-gradient throws inside satori (verified against the installed binary) — a value that
  // reaches the renderer blanks the whole overlay layer, so it must never validate.
  it('rejects an unknown gradientType', () => {
    expect(isValidTemplateElement(titleWith({
      mode: 'gradient', gradientType: 'conic',
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 100 }], angleDeg: 0,
    }))).toBe(false);
  });

  it('rejects a gradient with no gradientType', () => {
    expect(isValidTemplateElement(titleWith({
      mode: 'gradient',
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 100 }], angleDeg: 0,
    }))).toBe(false);
  });

  it('rejects a stop offset outside 0-100', () => {
    expect(isValidTemplateElement(titleWith({
      mode: 'gradient', gradientType: 'linear',
      stops: [{ color: '#ff0000', offset: -1 }, { color: '#0000ff', offset: 100 }], angleDeg: 0,
    }))).toBe(false);
    expect(isValidTemplateElement(titleWith({
      mode: 'gradient', gradientType: 'linear',
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 101 }], angleDeg: 0,
    }))).toBe(false);
  });

  it('rejects a stop with a non-hex color', () => {
    expect(isValidTemplateElement(titleWith({
      mode: 'gradient', gradientType: 'linear',
      stops: [{ color: '#ff0000', offset: 0 }, { color: 'not-a-color', offset: 100 }], angleDeg: 0,
    }))).toBe(false);
  });

  it('rejects an angleDeg outside 0-360', () => {
    expect(isValidTemplateElement(titleWith({
      mode: 'gradient', gradientType: 'linear',
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 100 }], angleDeg: 361,
    }))).toBe(false);
  });

  // Strict on WRITE: the pre-positioned-stops shape is tolerated on read (normalizeColorValue)
  // but must not be re-savable, so the union doesn't have to carry it forever.
  it('rejects the legacy bare-string stops array', () => {
    expect(isValidTemplateElement(titleWith({
      mode: 'gradient', stops: ['#ff0000', '#0000ff'], angleDeg: 45,
    }))).toBe(false);
  });

  it('rejects a legacy plain-string color', () => {
    expect(isValidTemplateElement(titleWith('#ffffff'))).toBe(false);
  });
```

And the new block:

```typescript
describe('normalizeColorValue', () => {
  it('passes a valid new-shape gradient through unchanged', () => {
    const value = {
      mode: 'gradient' as const, gradientType: 'radial' as const,
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 100 }], angleDeg: 0,
    };
    expect(normalizeColorValue(value)).toBe(value);
  });

  it('passes a valid solid through unchanged', () => {
    const value = { mode: 'solid' as const, color: '#123456' };
    expect(normalizeColorValue(value)).toBe(value);
  });

  // Pre-ColorValue templates stored a bare hex string. Today that reaches colorValueToCss, misses
  // the solid branch and throws on `color.stops.join(...)` of undefined.
  it('wraps a legacy plain hex string as a solid color', () => {
    expect(normalizeColorValue('#abcdef')).toEqual({ mode: 'solid', color: '#abcdef' });
  });

  // Offsets spread evenly == exactly what CSS already does for an offset-less stop list, so these
  // templates keep rendering the picture they render today.
  it('migrates a legacy bare-string gradient to linear with evenly spread offsets', () => {
    expect(normalizeColorValue({ mode: 'gradient', stops: ['#ff0000', '#00ff00', '#0000ff'], angleDeg: 45 })).toEqual({
      mode: 'gradient', gradientType: 'linear', angleDeg: 45,
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#00ff00', offset: 50 }, { color: '#0000ff', offset: 100 }],
    });
  });

  it('defaults a legacy gradient with a missing/invalid angle to 0', () => {
    const out = normalizeColorValue({ mode: 'gradient', stops: ['#ff0000', '#0000ff'] });
    expect(out).toEqual({
      mode: 'gradient', gradientType: 'linear', angleDeg: 0,
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 100 }],
    });
  });

  it('falls back to white for anything unrecognisable', () => {
    expect(normalizeColorValue(null)).toEqual({ mode: 'solid', color: '#ffffff' });
    expect(normalizeColorValue(42)).toEqual({ mode: 'solid', color: '#ffffff' });
    expect(normalizeColorValue({ mode: 'rainbow' })).toEqual({ mode: 'solid', color: '#ffffff' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/templates/templateTypes.test.ts`
Expected: FAIL — `normalizeColorValue` is not exported yet, and `isValidColorValue` still accepts
the legacy shape / rejects the new one.

- [ ] **Step 3: Implement the schema, validation and normalization**

In `src/templates/templateTypes.ts`, replace the `ColorValue` type (currently lines 6-8) with:

```typescript
// One gradient stop: a color plus where along the gradient axis it sits.
//
// `offset` is a PERCENT (0-100), not a 0-1 fraction, for two concrete reasons: the CSS string
// satori consumes is percent-based (`#00ff00 33.333%`), so the number goes straight into it with
// no conversion or float-formatting decision at the boundary; and the editor's NumberField
// primitive is integer-stepped and min/max-bounded, which 0-100 lands on as-is. `angleDeg` is
// already a "human" 0-360 number in this same union, so this keeps the whole shape in one idiom.
export interface GradientStop {
  color: string;
  offset: number; // 0-100
}

export type ColorValue =
  | { mode: 'solid'; color: string }
  | {
      // `gradientType` is deliberately only 'linear' | 'radial': verified against the installed
      // satori (0.33.4) that both render — as a text fill and as an element background — while
      // `conic-gradient` THROWS ("Invalid background image"), which in the live pipeline means
      // StreamManager.buildOverlay blanks the WHOLE overlay layer, and on the preview endpoint a
      // 500. See the design spec's Satori capability matrix.
      mode: 'gradient';
      gradientType: GradientType;
      stops: GradientStop[]; // MIN_GRADIENT_STOPS..MAX_GRADIENT_STOPS
      // 0-360. Meaningful for 'linear' only; retained (and still validated) for 'radial' so
      // toggling linear -> radial -> linear in the editor never loses the author's angle, and so
      // the validator below stays a flat sequence of checks rather than branching on the type.
      angleDeg: number;
    };

export type GradientType = 'linear' | 'radial';
export const GRADIENT_TYPES: GradientType[] = ['linear', 'radial'];
```

Add bounds constants next to the equalizer's own stop bounds (currently lines 151-152):

```typescript
// Same 2-6 window as the equalizer's colors[] — deliberately, so there is one mental model for
// "how many color stops can I have" across the whole editor. Satori renders 8 stops fine, so 6 is
// a product ceiling, not a renderer limit. Below 2 is not a gradient (that is what 'solid' is).
export const MIN_GRADIENT_STOPS = 2;
export const MAX_GRADIENT_STOPS = 6;
const MAX_GRADIENT_OFFSET = 100;
```

Replace `isValidColorValue` (currently lines 250-260) with:

```typescript
function isValidGradientStop(value: unknown): value is GradientStop {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return isValidColor(s.color) && isNumberInRange(s.offset, 0, MAX_GRADIENT_OFFSET);
}

// Exported (not module-private) — Track.overlayOverride validation reuses this exact function
// rather than re-implementing gradient/solid validation a second time.
//
// Deliberately STRICT: it accepts only the current shape, never the two older generations
// normalizeColorValue below absorbs. Writes only ever come from the editor (which normalizes on
// load), so keeping this strict is what stops the old shapes from being re-saved forever.
export function isValidColorValue(value: unknown): value is ColorValue {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.mode === 'solid') return isValidColor(v.color);
  if (v.mode === 'gradient') {
    if (!GRADIENT_TYPES.includes(v.gradientType as GradientType)) return false;
    if (!Array.isArray(v.stops)) return false;
    if (v.stops.length < MIN_GRADIENT_STOPS || v.stops.length > MAX_GRADIENT_STOPS) return false;
    if (!v.stops.every(isValidGradientStop)) return false;
    return isNumberInRange(v.angleDeg, 0, 360);
  }
  return false;
}
```

(`isNumberInRange` already exists at line 218. `isValidGradientStop` must be declared before
`isValidColorValue` reads it only at call time, so ordering is free — but keep it adjacent for
readability.)

Add `normalizeColorValue` immediately after `isValidColorValue`:

```typescript
export const FALLBACK_COLOR_VALUE: ColorValue = { mode: 'solid', color: '#ffffff' };

// Nothing re-validates a stored template's elements on READ, only on write (templateRoutes.ts) —
// so the database still holds two older ColorValue generations, and one of them is already a
// latent crash: a pre-ColorValue `color: '#ffffff'` string misses colorValueToCss's solid branch
// and throws on `color.stops.join(...)` of undefined, which live means a blank overlay layer and
// on the preview endpoint a 500. Same strict-on-write / patch-on-read split
// normalizeEqualizerElement already uses.
export function normalizeColorValue(value: unknown): ColorValue {
  if (isValidColorValue(value)) return value;
  // Pre-ColorValue: a bare hex string.
  if (isValidColor(value)) return { mode: 'solid', color: value };
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>;
    if (v.mode === 'solid' && isValidColor(v.color)) return { mode: 'solid', color: v.color };
    // Gen-1 gradient: bare-string stops, no gradientType, no offsets. Spreading the offsets
    // evenly is exactly what CSS already does for an offset-less stop list, so these templates
    // render byte-identically to what they render today — this migration is invisible.
    if (v.mode === 'gradient' && Array.isArray(v.stops) && v.stops.every((s) => isValidColor(s))
      && v.stops.length >= MIN_GRADIENT_STOPS && v.stops.length <= MAX_GRADIENT_STOPS) {
      const n = v.stops.length;
      return {
        mode: 'gradient',
        gradientType: 'linear',
        stops: (v.stops as string[]).map((color, i) => ({ color, offset: n > 1 ? (i * MAX_GRADIENT_OFFSET) / (n - 1) : 0 })),
        angleDeg: isNumberInRange(v.angleDeg, 0, 360) ? v.angleDeg : 0,
      };
    }
  }
  console.warn('[templates] unrecognisable color value, falling back to solid white');
  return FALLBACK_COLOR_VALUE;
}
```

Finally, update `DEFAULT_TEMPLATE_ELEMENTS` (from line 368) if any entry uses a gradient — check;
today they are all `{ mode: 'solid', color: ... }`, so no change is expected.

- [ ] **Step 4: Update the OpenAPI schema**

In `src/api/openapi.ts`, replace the `ColorValue` schema (currently lines 761-783):

```typescript
      ColorValue: {
        type: 'object',
        description: 'A solid color, or a linear/radial gradient with 2-6 positioned stops. Every color component is a hex string (#RGB / #RGBA / #RRGGBB / #RRGGBBAA) — other CSS color syntaxes are rejected. `conic` is deliberately not offered: the renderer cannot draw it.',
        oneOf: [
          {
            type: 'object',
            required: ['mode', 'color'],
            properties: {
              mode: { type: 'string', enum: ['solid'] },
              color: { type: 'string', example: '#ffffff' },
            },
          },
          {
            type: 'object',
            required: ['mode', 'gradientType', 'stops', 'angleDeg'],
            properties: {
              mode: { type: 'string', enum: ['gradient'] },
              gradientType: { type: 'string', enum: ['linear', 'radial'] },
              stops: {
                type: 'array',
                minItems: 2,
                maxItems: 6,
                items: {
                  type: 'object',
                  required: ['color', 'offset'],
                  properties: {
                    color: { type: 'string', example: '#ffffff' },
                    offset: { type: 'number', minimum: 0, maximum: 100, description: 'Position along the gradient axis, in percent' },
                  },
                },
              },
              angleDeg: { type: 'number', minimum: 0, maximum: 360, description: 'Applies to `linear` only; retained but ignored for `radial`' },
            },
          },
        ],
      },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest test/templates/templateTypes.test.ts test/api`
Expected: PASS. Backend `npx tsc -p tsconfig.json --noEmit` will still FAIL at this point —
`sceneRenderer.ts` has not been updated yet. That is expected and is Task 2's job.

- [ ] **Step 6: Commit**

```bash
git add src/templates/templateTypes.ts src/api/openapi.ts test/templates/templateTypes.test.ts
git commit -m "feat: ColorValue gains a gradient type and positioned, addable stops

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Renderer — one shared `gradientCss()`, normalization at the boundary

**Files:**
- Modify: `src/render/sceneRenderer.ts`
- Test: `test/render/sceneRenderer.test.ts`

**Interfaces:**
- Produces: `gradientCss(color)` (new export from `sceneRenderer.ts`).
- Consumes: `ColorValue`, `normalizeColorValue` (Task 1).

- [ ] **Step 1: Write the failing tests**

`test/render/sceneRenderer.test.ts` already renders for real (no mocked satori/resvg) and has a
`testLoadFont` helper that substitutes a local TTF. Add `gradientCss` to its import and append:

```typescript
describe('gradientCss', () => {
  it('emits a linear gradient with percent offsets', () => {
    expect(gradientCss({
      mode: 'gradient', gradientType: 'linear', angleDeg: 45,
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 100 }],
    })).toBe('linear-gradient(45deg, #ff0000 0%, #0000ff 100%)');
  });

  // Bare radial-gradient == CSS's own default (ellipse, farthest-corner, centre) — verified
  // pixel-identical to the explicit spelling against the real satori+resvg, with fewer moving
  // parts. angleDeg is ignored here by design.
  it('emits a bare radial gradient and ignores the angle', () => {
    expect(gradientCss({
      mode: 'gradient', gradientType: 'radial', angleDeg: 45,
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 100 }],
    })).toBe('radial-gradient(#ff0000 0%, #0000ff 100%)');
  });

  // Satori does NOT reject an out-of-order stop list; it renders a silently clamped, wrong
  // picture (measured: 25 distinct colors vs 39 for the same stops sorted). So sorting is the
  // renderer's job, not validation's.
  it('sorts stops by offset', () => {
    expect(gradientCss({
      mode: 'gradient', gradientType: 'linear', angleDeg: 0,
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#00ff00', offset: 80 }, { color: '#0000ff', offset: 30 }],
    })).toBe('linear-gradient(0deg, #ff0000 0%, #0000ff 30%, #00ff00 80%)');
  });

  it('keeps author order for stops that share an offset (a CSS hard stop)', () => {
    expect(gradientCss({
      mode: 'gradient', gradientType: 'linear', angleDeg: 0,
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#00ff00', offset: 50 }, { color: '#0000ff', offset: 50 }],
    })).toBe('linear-gradient(0deg, #ff0000 0%, #00ff00 50%, #0000ff 50%)');
  });
});

describe('renderScene — gradient colors', () => {
  const gradientTitle = (color: unknown): TemplateElement[] => ([
    { type: 'title', x: 10, y: 10, width: 600, fontSize: 42, color,
      style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } } as unknown as TemplateElement,
  ]);
  const scene = { title: 'Gradient', playlistLines: [], coverDataUri: null };
  const opts = { width: 640, height: 120 };

  it('renders a radial 6-stop gradient title', async () => {
    const png = await renderScene(gradientTitle({
      mode: 'gradient', gradientType: 'radial', angleDeg: 0,
      stops: [0, 20, 40, 60, 80, 100].map((offset, i) => ({ color: ['#ff0000', '#ff8800', '#ffee00', '#00cc44', '#0066ff', '#aa00ff'][i], offset })),
    }), scene, opts, testLoadFont);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.length).toBeGreaterThan(1000);
  });

  // Both legacy shapes must render rather than throw — see normalizeColorValue.
  it('renders a legacy plain-string color without throwing', async () => {
    const png = await renderScene(gradientTitle('#ff00ff'), scene, opts, testLoadFont);
    expect(png.length).toBeGreaterThan(1000);
  });

  it('renders a legacy bare-string-stops gradient without throwing', async () => {
    const png = await renderScene(gradientTitle({ mode: 'gradient', stops: ['#ff0000', '#0000ff'], angleDeg: 45 }), scene, opts, testLoadFont);
    expect(png.length).toBeGreaterThan(1000);
  });

  it('renders a legacy plain-string background override without throwing', async () => {
    const png = await renderScene([], scene, { ...opts, background: '#102030' as unknown as ColorValue }, testLoadFont);
    expect(png.length).toBeGreaterThan(1000);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/render/sceneRenderer.test.ts`
Expected: FAIL — `gradientCss` is not exported, and the legacy cases throw
`Cannot read properties of undefined (reading 'join')`.

- [ ] **Step 3: Implement**

In `src/render/sceneRenderer.ts`, change the import on line 5 to also bring in
`normalizeColorValue`, then replace `colorValueToCss` (lines 19-26) with:

```typescript
/**
 * The CSS one gradient ColorValue becomes. Extracted so colorValueToCss (a text fill) and
 * backgroundToCss (the scene background) can never drift apart, and so the frontend's live
 * gradient-strip preview has one exact shape to mirror.
 */
export function gradientCss(color: Extract<ColorValue, { mode: 'gradient' }>): string {
  // Sorted, because SVG gradient stops must be non-decreasing and satori does NOT reject an
  // out-of-order CSS stop list — it renders a silently clamped, wrong picture (verified against
  // the real satori+resvg: offsets 0/80/30/100 produced 25 distinct colors vs 39 sorted). A
  // STABLE sort, so two stops sharing an offset keep author order, which is exactly CSS's
  // "hard stop" semantics.
  const stops = [...color.stops]
    .sort((a, b) => a.offset - b.offset)
    .map((s) => `${s.color} ${s.offset}%`)
    .join(', ');
  // Bare radial-gradient is CSS's own default (ellipse, farthest-corner, centre) — verified
  // pixel-identical to the explicit `ellipse farthest-corner at 50% 50%` spelling.
  return color.gradientType === 'radial'
    ? `radial-gradient(${stops})`
    : `linear-gradient(${color.angleDeg}deg, ${stops})`;
}

function colorValueToCss(rawColor: ColorValue): Record<string, unknown> {
  // Normalized here rather than at every caller: this and backgroundToCss are the only two places
  // a STORED (never re-validated on read) ColorValue reaches the renderer, so one call here
  // covers the live stream, the preview endpoint and the per-track override alike.
  const color = normalizeColorValue(rawColor);
  if (color.mode === 'solid') return { color: color.color };
  return {
    backgroundImage: gradientCss(color),
    backgroundClip: 'text',
    color: 'transparent',
  };
}
```

And replace `backgroundToCss` (lines 172-175) with:

```typescript
function backgroundToCss(rawBackground: ColorValue): Record<string, unknown> {
  const background = normalizeColorValue(rawBackground);
  if (background.mode === 'solid') return { backgroundColor: background.color };
  return { backgroundImage: gradientCss(background) };
}
```

Nothing else in the file changes. Note for reassurance, not action: `ColorValue` crosses the
piscina `postMessage` structured-clone boundary inside `elements` and inside
`SceneRendererOptions.background` — plain objects and arrays clone losslessly, unlike the `Buffer`
problem this project hit twice; no re-wrapping is needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest test/render` then the whole backend suite: `npx jest`
Expected: PASS. `npx tsc -p tsconfig.json --noEmit` should now be clean.

- [ ] **Step 5: Commit**

```bash
git add src/render/sceneRenderer.ts test/render/sceneRenderer.test.ts
git commit -m "feat: render linear/radial gradients with positioned stops, and normalize legacy color values

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Frontend types mirror + `colorValue` helpers + load-time normalization

**Files:**
- Modify: `frontend/src/api/templates.ts`
- Create: `frontend/src/api/colorValue.ts`
- Create: `frontend/src/api/colorValue.test.ts`
- Modify: `frontend/src/pages/TemplateEditor.tsx` (only `normalizeElements`, lines 119-134)

**Interfaces:**
- Produces: frontend `GradientStop`/`GradientType`/`ColorValue` mirrors, `gradientCss`,
  `normalizeColorValue`, `MIN_GRADIENT_STOPS`, `MAX_GRADIENT_STOPS`, `spreadStopOffsets`.
- Consumes: the Task 1 backend shapes (mirrored by hand).

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/api/colorValue.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { gradientCss, normalizeColorValue, spreadStopOffsets } from './colorValue';

describe('gradientCss (frontend mirror)', () => {
  it('matches the backend linear spelling', () => {
    expect(gradientCss({ mode: 'gradient', gradientType: 'linear', angleDeg: 45,
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 100 }] }))
      .toBe('linear-gradient(45deg, #ff0000 0%, #0000ff 100%)');
  });

  it('matches the backend radial spelling and ignores the angle', () => {
    expect(gradientCss({ mode: 'gradient', gradientType: 'radial', angleDeg: 45,
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 100 }] }))
      .toBe('radial-gradient(#ff0000 0%, #0000ff 100%)');
  });

  it('sorts stops by offset, like the backend', () => {
    expect(gradientCss({ mode: 'gradient', gradientType: 'linear', angleDeg: 0,
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#00ff00', offset: 80 }, { color: '#0000ff', offset: 30 }] }))
      .toBe('linear-gradient(0deg, #ff0000 0%, #0000ff 30%, #00ff00 80%)');
  });
});

describe('normalizeColorValue (frontend mirror)', () => {
  it('wraps a legacy plain hex string as a solid color', () => {
    expect(normalizeColorValue('#abcdef')).toEqual({ mode: 'solid', color: '#abcdef' });
  });

  it('migrates a legacy bare-string gradient', () => {
    expect(normalizeColorValue({ mode: 'gradient', stops: ['#ff0000', '#0000ff'], angleDeg: 45 })).toEqual({
      mode: 'gradient', gradientType: 'linear', angleDeg: 45,
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 100 }],
    });
  });

  it('falls back to white for anything unrecognisable', () => {
    expect(normalizeColorValue(undefined)).toEqual({ mode: 'solid', color: '#ffffff' });
  });
});

describe('spreadStopOffsets', () => {
  it('spreads offsets evenly across 0-100, keeping colors', () => {
    expect(spreadStopOffsets([
      { color: '#a00000', offset: 12 }, { color: '#00a000', offset: 13 }, { color: '#0000a0', offset: 99 },
    ])).toEqual([
      { color: '#a00000', offset: 0 }, { color: '#00a000', offset: 50 }, { color: '#0000a0', offset: 100 },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/api/colorValue.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

In `frontend/src/api/templates.ts`, replace the `ColorValue` declaration (lines 5-7):

```typescript
export type GradientType = 'linear' | 'radial';
export const GRADIENT_TYPES: GradientType[] = ['linear', 'radial'];

export interface GradientStop {
  color: string;
  offset: number; // 0-100 (percent), matching the backend
}

// ColorValue represents both solid colors and gradients. `angleDeg` applies to 'linear' only —
// it is retained (and still sent) for 'radial' so toggling between the two never loses it.
export type ColorValue =
  | { mode: 'solid'; color: string }
  | { mode: 'gradient'; gradientType: GradientType; stops: GradientStop[]; angleDeg: number };
```

Create `frontend/src/api/colorValue.ts`:

```typescript
import type { ColorValue, GradientStop, GradientType } from './templates';

// Hand-kept mirror of src/render/sceneRenderer.ts's gradientCss and
// src/templates/templateTypes.ts's normalizeColorValue — kept in sync by hand, like every other
// frontend mirror of backend logic in this project (see PulseEqualizerPreview.tsx). The point of
// the gradientCss mirror is that the picker's live gradient strip shows the EXACT string the
// backend will render, rather than an approximation of it.

export const MIN_GRADIENT_STOPS = 2;
export const MAX_GRADIENT_STOPS = 6;
const MAX_GRADIENT_OFFSET = 100;
const GRADIENT_TYPE_VALUES: GradientType[] = ['linear', 'radial'];
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export const FALLBACK_COLOR_VALUE: ColorValue = { mode: 'solid', color: '#ffffff' };

export function gradientCss(color: Extract<ColorValue, { mode: 'gradient' }>): string {
  const stops = [...color.stops]
    .sort((a, b) => a.offset - b.offset)
    .map((s) => `${s.color} ${s.offset}%`)
    .join(', ');
  return color.gradientType === 'radial'
    ? `radial-gradient(${stops})`
    : `linear-gradient(${color.angleDeg}deg, ${stops})`;
}

/** Evenly spaced offsets across 0-100 — the default whenever the stop COUNT changes. */
export function spreadStopOffsets(stops: GradientStop[]): GradientStop[] {
  const n = stops.length;
  return stops.map((s, i) => ({ ...s, offset: n > 1 ? Math.round((i * MAX_GRADIENT_OFFSET) / (n - 1)) : 0 }));
}

function isHex(v: unknown): v is string { return typeof v === 'string' && HEX_COLOR.test(v); }
function inRange(v: unknown, max: number): v is number { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max; }

export function isValidColorValue(value: unknown): value is ColorValue {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.mode === 'solid') return isHex(v.color);
  if (v.mode !== 'gradient') return false;
  if (!GRADIENT_TYPE_VALUES.includes(v.gradientType as GradientType)) return false;
  if (!Array.isArray(v.stops) || v.stops.length < MIN_GRADIENT_STOPS || v.stops.length > MAX_GRADIENT_STOPS) return false;
  if (!v.stops.every((s) => typeof s === 'object' && s !== null && isHex((s as GradientStop).color) && inRange((s as GradientStop).offset, MAX_GRADIENT_OFFSET))) return false;
  return inRange(v.angleDeg, 360);
}

/**
 * Absorbs the two older stored shapes so opening an old template neither crashes the editor nor
 * silently 400s its save / its debounced preview request (the backend validates the draft body
 * with isValidTemplateElements — a legacy-shaped draft just makes the preview keep the last good
 * picture, with nothing on screen to say why).
 */
export function normalizeColorValue(value: unknown): ColorValue {
  if (isValidColorValue(value)) return value;
  if (isHex(value)) return { mode: 'solid', color: value };
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>;
    if (v.mode === 'solid' && isHex(v.color)) return { mode: 'solid', color: v.color };
    if (v.mode === 'gradient' && Array.isArray(v.stops) && v.stops.every(isHex)
      && v.stops.length >= MIN_GRADIENT_STOPS && v.stops.length <= MAX_GRADIENT_STOPS) {
      const n = v.stops.length;
      return {
        mode: 'gradient',
        gradientType: 'linear',
        stops: (v.stops as string[]).map((color, i) => ({ color, offset: n > 1 ? (i * MAX_GRADIENT_OFFSET) / (n - 1) : 0 })),
        angleDeg: inRange(v.angleDeg, 360) ? v.angleDeg : 0,
      };
    }
  }
  return FALLBACK_COLOR_VALUE;
}
```

In `frontend/src/pages/TemplateEditor.tsx`, extend `normalizeElements` (lines 119-134) so it also
normalizes text colors. Add `import { normalizeColorValue } from '../api/colorValue';` and change
the first line of the `map` callback from an equalizer-only early return to:

```typescript
  return elements.map((el) => {
    // A template saved before ColorValue gained a gradientType/positioned stops (or before
    // ColorValue existed at all, when `color` was a bare hex string) still sits in the database
    // exactly as saved. Normalizing on LOAD is what keeps such a template openable, previewable
    // and re-savable: the backend's isValidColorValue is strict on write, and the preview
    // endpoint validates the draft body too.
    if (el.type === 'title' || el.type === 'playlist' || el.type === 'text') {
      return { ...el, color: normalizeColorValue(el.color) };
    }
    if (el.type !== 'equalizer') return el;
    // ... existing equalizer branch unchanged ...
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/api/colorValue.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: the new tests PASS. `tsc` will still FAIL in `TemplateFormFields.tsx` (it still builds
the old tuple shape) — that is Task 4's job.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/templates.ts frontend/src/api/colorValue.ts frontend/src/api/colorValue.test.ts frontend/src/pages/TemplateEditor.tsx
git commit -m "feat: mirror the new ColorValue shape on the frontend and normalize legacy colors on load

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: The shared picker — gradient type, add/remove stops, per-stop position, live strip

**Files:**
- Modify: `frontend/src/components/TemplateFormFields.tsx`
- Modify: `frontend/src/components/TemplateFormFields.test.tsx`
- Modify: `frontend/src/i18n/locales/en.json`, `ru.json`, `uk.json`

**Interfaces:**
- Produces: the rewritten `ColorValueField` — **same export name, same props**
  (`{ label, value, onChange, onFocus, onBlur }`).
- Consumes: `gradientCss`, `spreadStopOffsets`, `MIN_GRADIENT_STOPS`, `MAX_GRADIENT_STOPS`
  (Task 3); `ColorField`, `NumberField` (unchanged, same file).

- [ ] **Step 1: Write the failing tests**

In `frontend/src/components/TemplateFormFields.test.tsx`, replace the whole
`describe('ColorValueField', ...)` block (starts line 137) with:

```typescript
describe('ColorValueField', () => {
  const solid: ColorValue = { mode: 'solid', color: '#ff0000' };
  const gradient: ColorValue = {
    mode: 'gradient', gradientType: 'linear', angleDeg: 45,
    stops: [{ color: '#ffffff', offset: 0 }, { color: '#000000', offset: 100 }],
  };

  it('shows the solid color field and no gradient stops when value.mode is solid', () => {
    render(<ColorValueField label="Fill" value={solid} onChange={() => {}} />);
    expect(screen.getByLabelText('Color')).toBeInTheDocument();
    expect(screen.queryByLabelText('Stop 1')).not.toBeInTheDocument();
  });

  it('switching to gradient mode calls onChange with a default two-stop linear gradient', async () => {
    const onChange = vi.fn();
    render(<ColorValueField label="Fill" value={solid} onChange={onChange} />);
    await userEvent.click(screen.getByText('Gradient'));
    expect(onChange).toHaveBeenCalledWith({
      mode: 'gradient', gradientType: 'linear', angleDeg: 0,
      stops: [{ color: '#ffffff', offset: 0 }, { color: '#000000', offset: 100 }],
    });
  });

  it('shows a color field and a position field per stop, plus an angle field, in linear mode', () => {
    render(<ColorValueField label="Fill" value={gradient} onChange={() => {}} />);
    expect(screen.getByLabelText('Stop 1')).toHaveValue('#ffffff');
    expect(screen.getByLabelText('Stop 2')).toHaveValue('#000000');
    expect(screen.getByLabelText('Stop 1 position')).toHaveValue(0);
    expect(screen.getByLabelText('Stop 2 position')).toHaveValue(100);
    expect(screen.getByLabelText('Gradient angle')).toHaveValue(45);
  });

  it('switching to radial hides the angle field and keeps the stops', async () => {
    const onChange = vi.fn();
    render(<ColorValueField label="Fill" value={gradient} onChange={onChange} />);
    await userEvent.click(screen.getByText('Radial'));
    expect(onChange).toHaveBeenCalledWith({ ...gradient, gradientType: 'radial' });
    // Re-render at the new value to assert the angle field is gone.
    render(<ColorValueField label="Fill2" value={{ ...gradient, gradientType: 'radial' }} onChange={() => {}} />);
    expect(screen.queryAllByLabelText('Gradient angle')).toHaveLength(1); // only the linear instance above
  });

  it('adding a stop appends a white stop and re-spreads every offset evenly', async () => {
    const onChange = vi.fn();
    render(<ColorValueField label="Fill" value={gradient} onChange={onChange} />);
    await userEvent.click(screen.getByText('+ Add stop'));
    expect(onChange).toHaveBeenCalledWith({
      mode: 'gradient', gradientType: 'linear', angleDeg: 45,
      stops: [{ color: '#ffffff', offset: 0 }, { color: '#000000', offset: 50 }, { color: '#ffffff', offset: 100 }],
    });
  });

  it('removing a stop drops it and leaves the remaining offsets untouched', async () => {
    const onChange = vi.fn();
    const three: ColorValue = {
      mode: 'gradient', gradientType: 'linear', angleDeg: 0,
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#00ff00', offset: 20 }, { color: '#0000ff', offset: 100 }],
    };
    render(<ColorValueField label="Fill" value={three} onChange={onChange} />);
    await userEvent.click(screen.getAllByText('Remove')[1]);
    expect(onChange).toHaveBeenCalledWith({
      mode: 'gradient', gradientType: 'linear', angleDeg: 0,
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 100 }],
    });
  });

  it('hides Remove at the 2-stop minimum and Add at the 6-stop maximum', () => {
    const { unmount } = render(<ColorValueField label="Fill" value={gradient} onChange={() => {}} />);
    expect(screen.queryByText('Remove')).not.toBeInTheDocument();
    expect(screen.getByText('+ Add stop')).toBeInTheDocument();
    unmount();
    const six: ColorValue = {
      mode: 'gradient', gradientType: 'linear', angleDeg: 0,
      stops: [0, 20, 40, 60, 80, 100].map((offset) => ({ color: '#ffffff', offset })),
    };
    render(<ColorValueField label="Fill" value={six} onChange={() => {}} />);
    expect(screen.queryByText('+ Add stop')).not.toBeInTheDocument();
    expect(screen.getAllByText('Remove')).toHaveLength(6);
  });

  it('editing a stop position calls onChange with that stop moved', () => {
    const onChange = vi.fn();
    render(<ColorValueField label="Fill" value={gradient} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Stop 2 position'), { target: { value: '70' } });
    expect(onChange).toHaveBeenCalledWith({
      ...gradient,
      stops: [{ color: '#ffffff', offset: 0 }, { color: '#000000', offset: 70 }],
    });
  });

  it('switching back to solid mode resets to white', async () => {
    const onChange = vi.fn();
    render(<ColorValueField label="Fill" value={gradient} onChange={onChange} />);
    await userEvent.click(screen.getByText('Solid'));
    expect(onChange).toHaveBeenCalledWith({ mode: 'solid', color: '#ffffff' });
  });

  // The mode/type toggles and the add/remove buttons are one-shot clicks, so each must produce
  // exactly one undo entry via the onFocus -> onChange -> onBlur trick.
  it('brackets every one-shot action in a zero-duration gesture', async () => {
    const onFocus = vi.fn(); const onBlur = vi.fn();
    render(<ColorValueField label="Fill" value={gradient} onChange={() => {}} onFocus={onFocus} onBlur={onBlur} />);
    await userEvent.click(screen.getByText('+ Add stop'));
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it('does not throw when onFocus/onBlur are omitted (Library.tsx passes neither)', async () => {
    render(<ColorValueField label="Fill" value={gradient} onChange={() => {}} />);
    await userEvent.click(screen.getByText('+ Add stop'));
    await userEvent.click(screen.getByText('Radial'));
  });
});
```

Make sure `fireEvent` is imported in this file (it already is, for the `ColorField` tests).

- [ ] **Step 2: Add the i18n keys**

Add to `frontend/src/i18n/locales/en.json` under `templateEditor`, next to the existing
`fieldGradientStop` / `fieldGradientAngle` keys:

```json
      "gradientTypeLinear": "Linear",
      "gradientTypeRadial": "Radial",
      "fieldGradientStopOffset": "Stop {{n}} position",
      "addGradientStop": "+ Add stop",
      "removeGradientStop": "Remove",
```

Add the same five keys, in the same position, to `ru.json`:

```json
      "gradientTypeLinear": "Линейный",
      "gradientTypeRadial": "Радиальный",
      "fieldGradientStopOffset": "Позиция точки {{n}}",
      "addGradientStop": "+ Добавить точку",
      "removeGradientStop": "Удалить",
```

and to `uk.json`:

```json
      "gradientTypeLinear": "Лінійний",
      "gradientTypeRadial": "Радіальний",
      "fieldGradientStopOffset": "Позиція точки {{n}}",
      "addGradientStop": "+ Додати точку",
      "removeGradientStop": "Видалити",
```

All three files must end up with the same key set in the same order.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/TemplateFormFields.test.tsx`
Expected: FAIL — no `Linear`/`Radial` toggles, no `+ Add stop`, no `Stop 1 position` field, and
the gradient default payload is still the old tuple shape.

- [ ] **Step 4: Implement**

In `frontend/src/components/TemplateFormFields.tsx`, add to the imports:

```typescript
import { gradientCss, spreadStopOffsets, MIN_GRADIENT_STOPS, MAX_GRADIENT_STOPS } from '../api/colorValue';
import type { GradientStop, GradientType } from '../api/templates';
```

Leave `NumberField` and `ColorField` exactly as they are. Replace `ColorValueField` (lines 73-132)
with:

```typescript
const DEFAULT_GRADIENT_STOPS: GradientStop[] = [
  { color: '#ffffff', offset: 0 },
  { color: '#000000', offset: 100 },
];

// Solid/gradient toggle, gradient-type toggle, and the fields for whichever mode is active.
// Built on ColorField/NumberField above so both stay in one file — a caller with several
// ColorValue fields on one element (overlayOverride.color/.backgroundColor) passes a distinct
// `label` per instance.
export function ColorValueField({ label, value, onChange, onFocus, onBlur }: { label: string; value: ColorValue; onChange: (v: ColorValue) => void; onFocus?: () => void; onBlur?: () => void }) {
  const { t } = useTranslation();

  // Every button in this component is an instantaneous, one-shot click — there's no separate
  // "user is mid-edit" moment to bracket the way a focus-then-blur gesture has one. Firing
  // onFocus() immediately followed by onBlur() around the onChange reuses the exact same
  // gesture-grouping prop plumbing every ColorField/NumberField call below already gets, so a
  // click still produces exactly one undo-stack entry (a zero-duration gesture) instead of
  // needing a third callback prop just for this. Library.tsx passes neither prop, hence `?.`.
  function commitOneShot(next: ColorValue) {
    onFocus?.();
    onChange(next);
    onBlur?.();
  }

  function patchGradient(patch: Partial<Extract<ColorValue, { mode: 'gradient' }>>, oneShot = false) {
    if (value.mode !== 'gradient') return;
    const next: ColorValue = { ...value, ...patch };
    if (oneShot) commitOneShot(next); else onChange(next);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-gray-600">
        <span>{label}</span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => commitOneShot({ mode: 'solid', color: value.mode === 'solid' ? value.color : '#ffffff' })}
            className={value.mode === 'solid' ? 'font-semibold underline' : ''}
          >{t('templateEditor.colorModeSolid')}</button>
          <button
            type="button"
            onClick={() => commitOneShot(value.mode === 'gradient' ? value : {
              mode: 'gradient', gradientType: 'linear', stops: DEFAULT_GRADIENT_STOPS, angleDeg: 0,
            })}
            className={value.mode === 'gradient' ? 'font-semibold underline' : ''}
          >{t('templateEditor.colorModeGradient')}</button>
        </div>
      </div>

      {value.mode === 'solid' && (
        <ColorField label={t('templateEditor.fieldColor')} value={value.color} onChange={(v) => onChange({ mode: 'solid', color: v })} onFocus={onFocus} onBlur={onBlur} />
      )}

      {value.mode === 'gradient' && (
        <>
          <div className="flex gap-2 text-xs text-gray-600">
            {(['linear', 'radial'] as GradientType[]).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => patchGradient({ gradientType: type }, true)}
                className={value.gradientType === type ? 'font-semibold underline' : ''}
              >{t(type === 'linear' ? 'templateEditor.gradientTypeLinear' : 'templateEditor.gradientTypeRadial')}</button>
            ))}
          </div>

          {/* The exact CSS the backend will render (see colorValue.ts's hand-kept gradientCss
              mirror), so the author sees the gradient immediately instead of waiting out the
              editor's 400ms debounce and a backend round trip. */}
          <div className="h-4 w-full rounded border" style={{ background: gradientCss(value) }} aria-hidden="true" />

          {value.stops.map((stop, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="flex-1">
                <ColorField
                  label={t('templateEditor.fieldGradientStop', { n: i + 1 })}
                  value={stop.color}
                  onChange={(v) => patchGradient({ stops: value.stops.map((s, j) => (j === i ? { ...s, color: v } : s)) })}
                  onFocus={onFocus}
                  onBlur={onBlur}
                />
              </div>
              <div className="w-20">
                <NumberField
                  label={t('templateEditor.fieldGradientStopOffset', { n: i + 1 })}
                  value={stop.offset}
                  max={100}
                  onChange={(v) => patchGradient({ stops: value.stops.map((s, j) => (j === i ? { ...s, offset: v } : s)) })}
                  onFocus={onFocus}
                  onBlur={onBlur}
                />
              </div>
              {value.stops.length > MIN_GRADIENT_STOPS && (
                <button
                  type="button"
                  onClick={() => patchGradient({ stops: value.stops.filter((_, j) => j !== i) }, true)}
                  className="pb-1 text-xs text-red-600"
                >{t('templateEditor.removeGradientStop')}</button>
              )}
            </div>
          ))}

          {value.stops.length < MAX_GRADIENT_STOPS && (
            // Adding a stop re-spreads EVERY offset evenly; removing one leaves the remaining
            // offsets alone. Adding is a deliberate structural change where "evenly spaced" is the
            // only sensible default (and is exactly what the offset-less legacy shape meant),
            // whereas removing must not silently move stops the author positioned. It also
            // guarantees the click is always visibly different from before, unlike appending a
            // stop at an offset that collides with an existing one.
            <button
              type="button"
              onClick={() => patchGradient({ stops: spreadStopOffsets([...value.stops, { color: '#ffffff', offset: 100 }]) }, true)}
              className="text-xs text-blue-600"
            >{t('templateEditor.addGradientStop')}</button>
          )}

          {value.gradientType === 'linear' && (
            <NumberField label={t('templateEditor.fieldGradientAngle')} value={value.angleDeg} max={360} onChange={(v) => patchGradient({ angleDeg: v })} onFocus={onFocus} onBlur={onBlur} />
          )}
        </>
      )}
    </div>
  );
}
```

Note the one deliberate behaviour change to the Gradient toggle: it is now a no-op when the value
is *already* a gradient (previously it rebuilt the value from its own fields), so clicking it
twice does not reset anything.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/TemplateFormFields.test.tsx && npx tsc -p tsconfig.json --noEmit`
Expected: the `TemplateFormFields` suite PASSES and `tsc` is clean.
`src/pages/TemplateEditor.test.tsx` will still FAIL — its fixtures carry the old gradient shape.
That is Task 5's job.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/TemplateFormFields.tsx frontend/src/components/TemplateFormFields.test.tsx frontend/src/i18n/locales/en.json frontend/src/i18n/locales/ru.json frontend/src/i18n/locales/uk.json
git commit -m "feat: one shared color picker with gradient type, addable stops and per-stop position

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Editor regression pass + real-render verification

**Files:**
- Modify: `frontend/src/pages/TemplateEditor.test.tsx`
- Modify: `CLAUDE.md` (the HTTP API section's `ColorValue` description, if it names the gradient shape)

**Interfaces:**
- Consumes: everything from Tasks 1-4. Produces no new interface.

- [ ] **Step 1: Update the editor's gradient fixtures and add a legacy case**

Three cases in `frontend/src/pages/TemplateEditor.test.tsx` carry the old gradient shape and must
be updated to `{ mode: 'gradient', gradientType: 'linear', stops: [{ color, offset }, …],
angleDeg }`:

- line ~296 `'toggling gradient mode shows/hides the stop color fields'`
- line ~597 `'undo/redo round-trips a gradient stop color edit made through ColorValueField'`
- line ~637 `'the solid/gradient mode-toggle click on ColorValueField produces exactly one undo step'`

The ~15 fixtures using `color: { mode: 'solid', color: '#ffffff' }` are unaffected.
`'timer selection never shows a gradient toggle'` (line ~315) and the equalizer case (line ~354)
must keep passing **unchanged** — they are the regression guard that this change did not leak into
the timer or the equalizer.

Add one new case:

```typescript
  it('opens a template whose title carries a legacy plain-string color without crashing', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'Legacy', createdAt: '', updatedAt: '',
      elements: [{ type: 'title', x: 0, y: 0, width: 400, fontSize: 24,
        color: '#ff00ff' as unknown as ColorValue,
        style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } }],
    });
    renderEditor();
    await userEvent.click(await screen.findByText(/title/i));
    // normalizeElements turned the string into a solid ColorValue, so the picker renders in
    // solid mode with that color rather than throwing.
    expect(await screen.findByLabelText('Color')).toHaveValue('#ff00ff');
    expect(screen.queryByLabelText('Stop 1')).not.toBeInTheDocument();
  });
```

(Adapt the mock/render helpers to whatever this file already uses — see its `beforeEach`.)

- [ ] **Step 2: Run the full suites**

```bash
npx jest
cd frontend && npx vitest run && npx tsc -p tsconfig.json --noEmit
```
Expected: everything PASSES, both `tsc` runs clean.

- [ ] **Step 3: Real-render verification (required — do not skip)**

Unit tests cannot catch a wrong CSS string: satori accepts almost anything and either throws at
render time or draws the wrong picture. Verify for real:

1. Start the backend and frontend locally (or against the demo stand), open `/templates/:id`.
2. On a `title` element, switch to Gradient, switch to **Radial**, add stops up to 6, and move a
   couple of positions. Confirm the strip and the debounced backend preview agree, and that the
   preview `<img>` actually updates (a 500 would silently keep the last good picture — check the
   network tab for a 200 on `POST /templates/{id}/preview`).
3. Repeat with **Linear** at a non-zero angle.
4. Confirm the timer element still shows a plain color field with no gradient toggle, and the
   equalizer still shows its own `#1`/`#2`… color list with `+ Add color` / `Remove`.

- [ ] **Step 4: Update CLAUDE.md if needed**

If CLAUDE.md's HTTP API section describes `ColorValue` as linear-only or as a 2-3 stop tuple,
update that sentence. Do not restate the whole schema there — OpenAPI is the reference.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/TemplateEditor.test.tsx CLAUDE.md
git commit -m "test: cover the new gradient shape and legacy color migration in the template editor

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Why five tasks and not one (or fifteen)

- **Not one task.** The change crosses three independently-testable seams — a validated data
  shape, a renderer that turns it into CSS, and a React control — and each has its own test file
  and its own failure mode. A single commit would make the "which layer broke" question
  unanswerable, and the backend is releasable on its own (it renders both old and new shapes
  before the frontend can produce a new one).
- **Not per-element-type.** The key scope finding: `ColorValueField` is already the one shared
  control, used from exactly two call sites, both of which already pass a whole `ColorValue`.
  Keeping its prop signature means `title`/`playlist`/`text` and the per-track override all pick
  the new capability up for free, so there is no per-element rollout to fragment into.
- **Tasks 1 and 2 are separate** because Task 1 leaves `tsc` failing by design (the renderer still
  reads the old shape) — splitting them is what lets Task 1's tests be genuinely red-then-green on
  validation alone, without the renderer's behaviour muddying the result.
- **Tasks 3 and 4 are separate** because Task 3's pure helpers (`gradientCss`,
  `normalizeColorValue`, `spreadStopOffsets`) are what Task 4's component is built on, and they
  are testable with no DOM at all. It also isolates the one genuinely subtle piece — the
  backend-mirroring CSS string — from the JSX churn.
- **Task 5 is separate** because it is the only task whose failures are *other people's tests*
  (fixtures written before this change) plus the manual real-render pass, which is not a
  red-green cycle at all.
