# Template Overlay Extensions (Part A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the overlay-template system with typography (bold/italic/font
family), stroke, shadow, gradient color, two new element types
(`text`/`image`), and an optional per-track color/background override — all
baked into the existing render-once-per-track-switch pipeline, no new
runtime/animation mechanism.

**Architecture:** `ColorValue`/`TextStyle` become shared shapes attached to
every text-bearing element except `timer` (which keeps a plain solid color —
`drawtext` can't render gradient text). A small bundled font registry
(Debian apt font packages already available in the container, no file
downloads, no user-uploaded fonts) replaces today's single hardcoded font.
Satori's `fonts:[...]` array grows to register every `(family, weight,
style)` combination actually used in a scene instead of one fixed entry.
Uploaded template images are normalized to a single renderable PNG at
upload time (via ffmpeg, one code path for PNG/JPEG/GIF-first-frame alike)
plus the original file kept alongside for a later, separate "Part B"
animated-GIF feature. Per-track override is a nullable JSON column on
`Track`, merged into the resolved elements right before rendering.

**Tech Stack:** TypeScript/Express/Prisma backend (existing), Satori +
@resvg/resvg-js rendering (existing), ffmpeg (existing, for GIF first-frame
extraction and drawtext), React + Vite frontend (existing), react-i18next
(existing).

**Spec:** `docs/superpowers/specs/2026-09-04-template-overlay-extensions-design.md`
— read it before this plan; it has the full rationale for every decision
below (why timer can't do gradients, why fonts are bundled not uploaded,
why SVG upload is rejected, why per-track override targeting is left open
until this plan, etc.). This plan argues from that spec.

## Global Constraints

- Every hex color string (`ColorValue.solid.color`, each `gradient.stops`
  entry, `timer.color`, `stroke.color`, `shadow.color`) validates against
  the existing `HEX_COLOR_PATTERN` in `src/templates/templateTypes.ts`
  (`#RGB`/`#RGBA`/`#RRGGBB`/`#RRGGBBAA`) — never a looser check.
- `angleDeg` on a gradient is `0-360` inclusive. `stroke.width` and every
  `shadow.*` numeric field are canvas pixels, same unit as `x`/`y`/`width`/
  `height`/`fontSize`.
- No new element-type validation may use a schema library — hand-rolled
  checks in `isValidTemplateElement`, matching the file's existing,
  deliberate style.
- No font file is ever downloaded from the network by any task — fonts
  come only from Debian apt packages installed in the Dockerfile (see
  Task 2). If a task's implementer thinks a downloaded font file is
  needed, that is a signal the task was misread — stop and re-check
  Task 2 before proceeding.
- `image/svg+xml` uploads are rejected — never add SVG to any allowed-
  mimetype list in this plan.
- Every new backend route follows the existing `requireAuth` + ownership-
  check pattern already used throughout `templateRoutes.ts`/`trackRoutes.ts`
  (404 if the resource doesn't exist, 403 if it exists but isn't the
  caller's) — never skip the ownership check "for now."
- **`src/templates/templateRoutes.ts`'s real, verified route pattern —
  every task adding a route to this file (6, 7, 9) must match it exactly,
  not the generic Express `(req, res, next) => { try {...} catch(err) {
  next(err) } }` shape used elsewhere in earlier drafts of this plan:**
  `createTemplateRouter(authService, templateRepository, trackRepository,
  rendererDeps)` takes four positional parameters, not one `deps` object.
  Inside it: `const auth = requireAuth(authService)` once, reused as
  middleware (`router.get('/x', auth, ...)`, never bare `requireAuth`).
  `const userId = (req: AuthenticatedRequest) => req.user!.id` — the
  caller's id is `userId(req as AuthenticatedRequest)`, **not**
  `req.session.userId`. Handlers are wrapped in `wrapAsync(async (req,
  res) => { ... })` (imported from `../api/errorHandler`) and simply
  `throw new ApiError(...)` on failure — there is no `next` parameter and
  no manual try/catch. An existing helper,
  `requireOwnedTemplate(id, ownerId): Promise<Template>` (throws 404/403
  itself), already exists in this file's closure — reuse it for any new
  route that needs to load-and-check-ownership of a template, don't
  re-implement the check inline.

---

### Task 1: Data model — `ColorValue`, `TextStyle`, new element types, validation

**Files:**
- Modify: `src/templates/templateTypes.ts`
- Test: `test/templates/templateTypes.test.ts`

**Interfaces:**
- Produces: `ColorValue`, `TextStyle`, extended `TitleElement`/
  `PlaylistElement`/`TimerElement`, new `TextElement`/`ImageElement`,
  extended `TemplateElement` union, extended `isValidTemplateElement`/
  `isValidTemplateElements`, and the exported `isValidColorValue` helper
  (Task 8 imports and reuses this exact function — it must be exported,
  not module-private). Every later task that touches an element's shape
  imports these from this file — no task redefines them locally.

- [ ] **Step 1: Write the failing tests for the new types' validation**

```typescript
// test/templates/templateTypes.test.ts — add alongside the existing describe block
import { isValidTemplateElement } from '../../src/templates/templateTypes';

describe('isValidTemplateElement — ColorValue and TextStyle', () => {
  const baseStyle = { fontFamily: 'DejaVu Sans', bold: false, italic: false };

  it('accepts a title with a solid color and minimal style', () => {
    expect(isValidTemplateElement({
      type: 'title', x: 10, y: 10, width: 200, fontSize: 20,
      color: { mode: 'solid', color: '#ffffff' },
      style: baseStyle,
    })).toBe(true);
  });

  it('accepts a title with a 3-stop gradient', () => {
    expect(isValidTemplateElement({
      type: 'title', x: 10, y: 10, width: 200, fontSize: 20,
      color: { mode: 'gradient', stops: ['#ff0000', '#00ff00', '#0000ff'], angleDeg: 45 },
      style: baseStyle,
    })).toBe(true);
  });

  it('rejects a gradient with an out-of-range angle', () => {
    expect(isValidTemplateElement({
      type: 'title', x: 10, y: 10, width: 200, fontSize: 20,
      color: { mode: 'gradient', stops: ['#ff0000', '#00ff00'], angleDeg: 361 },
      style: baseStyle,
    })).toBe(false);
  });

  it('rejects a gradient with an invalid stop color', () => {
    expect(isValidTemplateElement({
      type: 'title', x: 10, y: 10, width: 200, fontSize: 20,
      color: { mode: 'gradient', stops: ['#ff0000', 'not-a-color'], angleDeg: 0 },
      style: baseStyle,
    })).toBe(false);
  });

  it('accepts a style with stroke and shadow', () => {
    expect(isValidTemplateElement({
      type: 'title', x: 10, y: 10, width: 200, fontSize: 20,
      color: { mode: 'solid', color: '#ffffff' },
      style: { ...baseStyle, bold: true, italic: true,
        stroke: { color: '#000000', width: 2 },
        shadow: { color: '#000000', blur: 4, offsetX: 1, offsetY: 1 } },
    })).toBe(true);
  });

  it('rejects a half-filled shadow', () => {
    expect(isValidTemplateElement({
      type: 'title', x: 10, y: 10, width: 200, fontSize: 20,
      color: { mode: 'solid', color: '#ffffff' },
      style: { ...baseStyle, shadow: { color: '#000000', blur: 4 } as unknown },
    })).toBe(false);
  });

  it('rejects a timer with a gradient color (timer color must be a plain string)', () => {
    expect(isValidTemplateElement({
      type: 'timer', x: 10, y: 10, fontSize: 20,
      color: { mode: 'solid', color: '#ffffff' },
      style: baseStyle,
    })).toBe(false);
  });

  it('accepts a timer with a plain hex color string and a style', () => {
    expect(isValidTemplateElement({
      type: 'timer', x: 10, y: 10, fontSize: 20,
      color: '#ffffff',
      style: baseStyle,
    })).toBe(true);
  });

  it('accepts a text element', () => {
    expect(isValidTemplateElement({
      type: 'text', x: 10, y: 10, width: 300, fontSize: 24,
      text: 'now streaming',
      color: { mode: 'solid', color: '#ffffff' },
      style: baseStyle,
    })).toBe(true);
  });

  it('rejects a text element with an empty text field', () => {
    expect(isValidTemplateElement({
      type: 'text', x: 10, y: 10, width: 300, fontSize: 24,
      text: '',
      color: { mode: 'solid', color: '#ffffff' },
      style: baseStyle,
    })).toBe(false);
  });

  it('accepts an image element', () => {
    expect(isValidTemplateElement({
      type: 'image', x: 10, y: 10, width: 200, height: 200,
      assetId: '3fa2c1e0-1234-4a5b-9c0d-abcdef123456',
    })).toBe(true);
  });

  it('rejects an image element with a non-string assetId', () => {
    expect(isValidTemplateElement({
      type: 'image', x: 10, y: 10, width: 200, height: 200, assetId: 123,
    })).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/templates/templateTypes.test.ts`
Expected: FAIL — new types/branches don't exist yet.

- [ ] **Step 3: Implement the types and validation**

```typescript
// src/templates/templateTypes.ts — replace the existing element interfaces
// and isValidTemplateElement with the below (keep CANVAS_WIDTH/HEIGHT,
// HEX_COLOR_PATTERN, MAX_FONT_SIZE, isFiniteNumber, isValidPosition,
// isValidSize, isValidColor exactly as they are today).

export type ColorValue =
  | { mode: 'solid'; color: string }
  | { mode: 'gradient'; stops: [string, string] | [string, string, string]; angleDeg: number };

export interface TextStyle {
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  stroke?: { color: string; width: number };
  shadow?: { color: string; blur: number; offsetX: number; offsetY: number };
}

export interface CoverElement {
  type: 'cover';
  x: number; y: number; width: number; height: number;
}

export interface TitleElement {
  type: 'title';
  x: number; y: number; width: number; fontSize: number;
  color: ColorValue;
  style: TextStyle;
}

export interface PlaylistElement {
  type: 'playlist';
  x: number; y: number; width: number; fontSize: number;
  color: ColorValue;
  style: TextStyle;
}

// timer keeps a plain string color (not ColorValue) — ffmpeg drawtext can't
// render gradient text. See the design spec's "Timer's drawtext ceiling".
export interface TimerElement {
  type: 'timer';
  x: number; y: number; fontSize: number;
  color: string;
  style: TextStyle;
}

export interface TextElement {
  type: 'text';
  x: number; y: number; width: number; fontSize: number;
  text: string;
  color: ColorValue;
  style: TextStyle;
}

export interface ImageElement {
  type: 'image';
  x: number; y: number; width: number; height: number;
  assetId: string;
}

export type TemplateElement =
  | CoverElement | TitleElement | PlaylistElement | TimerElement | TextElement | ImageElement;

const ELEMENT_TYPES = ['cover', 'title', 'playlist', 'timer', 'text', 'image'] as const;
const MAX_TEXT_LENGTH = 500;

// Exported (not module-private) — Task 8's Track.overlayOverride validation reuses this
// exact function rather than re-implementing gradient/solid validation a second time.
export function isValidColorValue(value: unknown): value is ColorValue {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.mode === 'solid') return isValidColor(v.color);
  if (v.mode === 'gradient') {
    if (!Array.isArray(v.stops) || (v.stops.length !== 2 && v.stops.length !== 3)) return false;
    if (!v.stops.every((s) => isValidColor(s))) return false;
    return isFiniteNumber(v.angleDeg) && v.angleDeg >= 0 && v.angleDeg <= 360;
  }
  return false;
}

function isValidTextStyle(value: unknown): value is TextStyle {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.fontFamily !== 'string' || v.fontFamily.length === 0) return false;
  if (typeof v.bold !== 'boolean' || typeof v.italic !== 'boolean') return false;
  if (v.stroke !== undefined) {
    if (typeof v.stroke !== 'object' || v.stroke === null) return false;
    const s = v.stroke as Record<string, unknown>;
    if (!isValidColor(s.color) || !isFiniteNumber(s.width) || s.width <= 0) return false;
  }
  if (v.shadow !== undefined) {
    if (typeof v.shadow !== 'object' || v.shadow === null) return false;
    const s = v.shadow as Record<string, unknown>;
    if (!isValidColor(s.color)) return false;
    if (!isFiniteNumber(s.blur) || s.blur < 0) return false;
    if (!isFiniteNumber(s.offsetX) || !isFiniteNumber(s.offsetY)) return false;
  }
  return true;
}

// Validates the shape of one element from an untrusted request body. Deliberately permissive
// on which fields are required per type rather than a full schema library — this is expected
// to grow (more element types, more style fields) as the visual editor matures, and a
// hand-rolled check keeps that growth low-ceremony.
export function isValidTemplateElement(value: unknown): value is TemplateElement {
  if (typeof value !== 'object' || value === null) return false;
  const el = value as Record<string, unknown>;
  if (typeof el.type !== 'string' || !ELEMENT_TYPES.includes(el.type as (typeof ELEMENT_TYPES)[number])) return false;

  if (el.type === 'image') {
    return isValidPosition(el.x, el.y)
      && isValidSize(el.width, CANVAS_WIDTH) && isValidSize(el.height, CANVAS_HEIGHT)
      && typeof el.assetId === 'string' && el.assetId.length > 0;
  }

  if (!isValidPosition(el.x, el.y)) return false;

  if (el.type === 'cover') {
    return isValidSize(el.width, CANVAS_WIDTH) && isValidSize(el.height, CANVAS_HEIGHT);
  }
  if (el.type === 'timer') {
    return isValidSize(el.fontSize, MAX_FONT_SIZE) && isValidColor(el.color) && isValidTextStyle(el.style);
  }
  if (el.type === 'text') {
    if (typeof el.text !== 'string' || el.text.length === 0 || el.text.length > MAX_TEXT_LENGTH) return false;
  }
  // title / playlist / text share the same remaining shape
  return isValidSize(el.width, CANVAS_WIDTH)
    && isValidSize(el.fontSize, MAX_FONT_SIZE)
    && isValidColorValue(el.color)
    && isValidTextStyle(el.style);
}

export function isValidTemplateElements(value: unknown): value is TemplateElement[] {
  return Array.isArray(value) && value.every(isValidTemplateElement);
}
```

Update `DEFAULT_TEMPLATE_ELEMENTS` (unchanged in spirit, just the new
required fields):

```typescript
export const DEFAULT_TEMPLATE_ELEMENTS: TemplateElement[] = [
  { type: 'cover', x: 40, y: 40, width: 432, height: 432 },
  { type: 'title', x: 512, y: 40, width: 700, fontSize: 42,
    color: { mode: 'solid', color: '#ffffff' },
    style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } },
  { type: 'playlist', x: 512, y: 160, width: 700, fontSize: 22,
    color: { mode: 'solid', color: '#ffffff' },
    style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } },
];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/templates/templateTypes.test.ts`
Expected: PASS, all cases above.

- [ ] **Step 5: Run the full suite to check for fallout**

Run: `npx jest`
Expected: failures only in files that construct `TitleElement`/
`PlaylistElement`/`TimerElement` literals without the new required fields
(e.g. `test/render/sceneRenderer.test.ts`, `test/templates/templateRoutes.test.ts`)
— **do not fix those here**, they belong to Task 4/6/7's own scope. Note
which files fail in your task report so later tasks aren't surprised.

- [ ] **Step 6: Commit**

```bash
git add src/templates/templateTypes.ts test/templates/templateTypes.test.ts
git commit -m "feat: ColorValue/TextStyle + text/image element types"
```

---

### Task 2: Font registry (Debian apt packages, no downloads)

**Files:**
- Create: `src/render/fontRegistry.ts`
- Test: `test/render/fontRegistry.test.ts`
- Modify: `Dockerfile`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `resolveFontFile(family: string, bold: boolean, italic: boolean): string`
  and `FONT_FAMILIES: readonly string[]` — Task 4 (Satori), Task 5 (timer
  drawtext), and Task 7 (`GET /templates/fonts`) all import these.

- [ ] **Step 1: Add the font packages to the Dockerfile**

Find this line in `Dockerfile` (the runtime stage, where
`fonts-dejavu-core` is already installed per CLAUDE.md):

```dockerfile
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
```

Change to:

```dockerfile
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
```

`fonts-liberation` (Liberation Sans/Serif/Mono) is a standard, small
Debian package — no network fetch beyond the existing `apt-get install`
this Dockerfile already does, and no license/upload concerns (it's the
same trust boundary as `fonts-dejavu-core` already crossed). This gives
two distinct families, each with real regular/bold/italic/bold-italic
files, without downloading anything from outside apt.

- [ ] **Step 2: Write the failing test**

```typescript
// test/render/fontRegistry.test.ts
import { resolveFontFile, FONT_FAMILIES } from '../../src/render/fontRegistry';

describe('resolveFontFile', () => {
  it('lists DejaVu Sans and Liberation Sans as available families', () => {
    expect(FONT_FAMILIES).toContain('DejaVu Sans');
    expect(FONT_FAMILIES).toContain('Liberation Sans');
  });

  it('resolves DejaVu Sans regular', () => {
    expect(resolveFontFile('DejaVu Sans', false, false))
      .toBe('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
  });

  it('resolves DejaVu Sans bold+italic', () => {
    expect(resolveFontFile('DejaVu Sans', true, true))
      .toBe('/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf');
  });

  it('resolves Liberation Sans bold', () => {
    expect(resolveFontFile('Liberation Sans', true, false))
      .toBe('/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf');
  });

  it('falls back to the family default when a variant file does not exist on disk', () => {
    // Simulate an unknown combination by requesting an unlisted family — falls back to the
    // first entry in FONT_FAMILIES rather than throwing, so a stale/edited template referencing
    // a since-removed family never breaks rendering.
    expect(resolveFontFile('Comic Sans MS', false, false))
      .toBe(resolveFontFile(FONT_FAMILIES[0], false, false));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest test/render/fontRegistry.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement the registry**

```typescript
// src/render/fontRegistry.ts
interface FontVariants {
  regular: string;
  bold: string;
  italic: string;
  boldItalic: string;
}

const REGISTRY: Record<string, FontVariants> = {
  'DejaVu Sans': {
    regular: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    bold: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    italic: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf',
    boldItalic: '/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf',
  },
  'Liberation Sans': {
    regular: '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    bold: '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    italic: '/usr/share/fonts/truetype/liberation/LiberationSans-Italic.ttf',
    boldItalic: '/usr/share/fonts/truetype/liberation/LiberationSans-BoldItalic.ttf',
  },
};

export const FONT_FAMILIES: readonly string[] = Object.keys(REGISTRY);

export function resolveFontFile(family: string, bold: boolean, italic: boolean): string {
  const variants = REGISTRY[family] ?? REGISTRY[FONT_FAMILIES[0]];
  if (bold && italic) return variants.boldItalic;
  if (bold) return variants.bold;
  if (italic) return variants.italic;
  return variants.regular;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest test/render/fontRegistry.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile src/render/fontRegistry.ts test/render/fontRegistry.test.ts
git commit -m "feat: font registry backed by apt-installed DejaVu + Liberation families"
```

**Note for the task reviewer:** the exact on-disk paths for `fonts-liberation`
(`/usr/share/fonts/truetype/liberation/Liberation*.ttf`) and DejaVu's
non-bold variants (`DejaVuSans.ttf`, `DejaVuSans-Oblique.ttf`,
`DejaVuSans-BoldOblique.ttf`) are the standard Debian bookworm package
layout — confirm them against a real container (`docker run --rm
node:20-bookworm-slim sh -c "apt-get update -q && apt-get install -y
fonts-dejavu-core fonts-liberation -q && find /usr/share/fonts -name
'*.ttf'"`) rather than trusting this plan text alone, since a wrong path
here silently breaks every render that isn't the one hardcoded weight
already in production today.

---

### Task 3: `fontCache.ts` — multi-file cache

**Files:**
- Modify: `src/render/fontCache.ts`
- Test: `test/render/fontCache.test.ts` (check if this file already exists — if so, extend it in place rather than assuming its current shape)

**Interfaces:**
- Consumes: nothing new.
- Produces: `loadFontData(fontPath: string): Promise<Buffer>` — **same
  signature as today**, callers in Task 4 don't change how they call it,
  only that calling it with several different paths across a session now
  correctly caches each independently instead of evicting the previous one.

- [ ] **Step 1: Read the current file and its existing test (if any) first**

Read `src/render/fontCache.ts` and `test/render/fontCache.test.ts` before
writing anything — the current implementation caches exactly one
`{path, data}` pair and silently replaces it if called with a different
path. Confirm this understanding against the real file before proceeding.

- [ ] **Step 2: Write the failing test**

```typescript
// test/render/fontCache.test.ts
import { loadFontData } from '../../src/render/fontCache';
import * as fs from 'fs/promises';

jest.mock('fs/promises');

describe('loadFontData', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reads each distinct path from disk only once, even when called out of order', async () => {
    (fs.readFile as jest.Mock)
      .mockImplementation((p: string) => Promise.resolve(Buffer.from(p)));

    await loadFontData('/fonts/a.ttf');
    await loadFontData('/fonts/b.ttf');
    const a2 = await loadFontData('/fonts/a.ttf');

    expect(fs.readFile).toHaveBeenCalledTimes(2);
    expect(a2.toString()).toBe('/fonts/a.ttf');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest test/render/fontCache.test.ts`
Expected: FAIL (current implementation drops `a.ttf`'s cache entry once
`b.ttf` is loaded, so the second `loadFontData('/fonts/a.ttf')` call
re-reads from disk — 3 calls to `fs.readFile`, not 2).

- [ ] **Step 4: Implement the multi-file cache**

```typescript
// src/render/fontCache.ts
import * as fs from 'fs/promises';

// Shared across every caller (the /templates/{id}/preview route and the live stream
// pipeline's buildOverlay) so each distinct font file is only ever read from disk once per
// process. Keyed by path now that a scene can register several font files at once (see
// fontRegistry.ts / sceneRenderer.ts), not just the one hardcoded font this used to be.
const cache = new Map<string, Promise<Buffer>>();

export function loadFontData(fontPath: string): Promise<Buffer> {
  let entry = cache.get(fontPath);
  if (!entry) {
    entry = fs.readFile(fontPath);
    cache.set(fontPath, entry);
  }
  return entry;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest test/render/fontCache.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/render/fontCache.ts test/render/fontCache.test.ts
git commit -m "fix: fontCache caches every distinct font path, not just the last one"
```

---

### Task 4: `sceneRenderer.ts` — gradient/stroke/shadow/bold/italic/image rendering

**Files:**
- Modify: `src/render/sceneRenderer.ts`, `src/render/renderWorker.ts`
- Test: `test/render/sceneRenderer.test.ts` (extend the existing real
  satori+resvg end-to-end test file — do not mock satori/resvg here, this
  file's whole purpose is catching exactly the class of bug a mocked test
  would miss, per CLAUDE.md's piscina-Buffer lesson), extend
  `test/render/renderWorker.test.ts`

**A real, verified cross-file consequence this task must handle (found by
a fresh review of an earlier draft, which scoped this task to
`sceneRenderer.ts` alone and would have broken the build):**
`src/render/renderWorker.ts` is the actual piscina worker entry point —
it currently does `const raw = task.options.fontData; const fontData =
Buffer.from(raw.buffer, ...); return renderScene(task.elements, task.scene,
{ ...task.options, fontData });`, rewrapping `fontData` because
`postMessage`'s structured clone strips it down to a plain `Uint8Array`
crossing the piscina thread boundary (the documented Cyrillic-glyph bug
from CLAUDE.md). Once `renderScene` stops taking `fontData` as an input
(this task's whole point — it loads fonts itself now), that rewrap has
nothing left to rewrap: `task.options` no longer has a `fontData` field at
all, so this line is a compile error, not just dead code. **This is also
a genuine simplification, not just a fix:** because `renderScene` (running
*inside* the worker thread, per `renderWorker.ts` calling it) now calls
`loadFontData` itself, the font bytes never cross the `postMessage`
boundary in the first place — the entire Buffer-rewrap concern this file
existed to solve is now moot for fonts specifically (the *separate*,
still-necessary PNG-rewrap-on-the-way-out in `renderWorkerPool.ts` is
untouched by this task — that's the render *result* crossing the boundary
on its way back, an unrelated call site).

**Interfaces:**
- Consumes: `ColorValue`/`TextStyle`/`TextElement`/`ImageElement` (Task 1),
  `resolveFontFile`/`FONT_FAMILIES` (Task 2), `loadFontData` (Task 3).
  **Architecture shift from today:** `renderScene` now calls `loadFontData`
  itself, for however many font files the scene's elements actually need —
  it no longer receives a single pre-loaded `fontData` buffer from its
  caller. `renderOverlay.ts` (today's one caller) stops loading/passing
  font data entirely; see Step 4's note on updating it.
- Produces: `renderScene(elements, scene, options: SceneRendererOptions,
  loadFont?)` — the exported `SceneRendererOptions` interface (currently
  just `{width, height}`) is what Task 9 later widens with `background`;
  `renderWorker.ts`/`renderWorkerPool.ts` import and reuse it by
  reference rather than duplicating the shape. See Step 4 for the new
  optional 4th `loadFont` parameter, added specifically so this task's own
  tests can run on a non-Linux dev machine without touching production
  behavior. `SceneData` grows an optional `imageDataUris` field (see
  below) that later tasks (9) populate. `renderWorker.ts`'s `RenderTask`
  shrinks — its `options` field's type follows whatever `sceneRenderer.ts`
  exports for it, and the fontData-rewrap code this task removes is not
  replaced by anything.

- [ ] **Step 1: Read `renderOverlay.ts` and the current `sceneRenderer.test.ts` first**

Read both files before changing anything — `renderOverlay.ts` is what
currently calls `loadFontData` with the single hardcoded font path and
passes `fontData`/`fontFamily` into `renderScene`'s options; this task
needs to know exactly how many font files it now needs to gather and pass
through, and the existing test file's structure (real satori+resvg, no
mocks) is the pattern every new test case here must follow.

- [ ] **Step 2: Write the failing tests — one real-render assertion per new capability**

```typescript
// test/render/sceneRenderer.test.ts — add these cases to the existing describe block.
//
// Cross-platform note: production's default font loader (fontRegistry.ts) only knows
// hardcoded Linux paths (/usr/share/fonts/...), which don't exist on a Windows/macOS dev
// machine. Read the file's CURRENT test setup first — it may already solve this with its own
// FONT_CANDIDATES-style local-file search; if so, adapt testLoadFont below to reuse that same
// discovered path instead of hardcoding a second one. Where 'DejaVu Sans'/'Liberation Sans' are
// used as family NAMES below, testLoadFont only cares about the (bold, italic) combination, not
// the family string — any real local .ttf file stands in for "a font", since these tests are
// checking that the CSS tricks render, not checking any specific font's glyphs.
const testFontPath = /* whatever real local .ttf path the file's existing tests already use, or
  a small set of files under a checked-in test-fixtures directory if none exists yet */;
async function testLoadFont(_family: string, _bold: boolean, _italic: boolean): Promise<Buffer> {
  return fs.promises.readFile(testFontPath);
}
const testOptions = { width: 400, height: 150 };

it('renders gradient text without throwing', async () => {
  const png = await renderScene(
    [{ type: 'title', x: 0, y: 0, width: 400, fontSize: 60,
       color: { mode: 'gradient', stops: ['#ff0000', '#0000ff'], angleDeg: 0 },
       style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } }],
    { title: 'GRADIENT', playlistLines: [], coverDataUri: null },
    testOptions, testLoadFont,
  );
  expect(png.length).toBeGreaterThan(0);
});

it('renders a stroke without throwing', async () => {
  const png = await renderScene(
    [{ type: 'title', x: 0, y: 0, width: 400, fontSize: 60,
       color: { mode: 'solid', color: '#ffffff' },
       style: { fontFamily: 'DejaVu Sans', bold: false, italic: false,
         stroke: { color: '#000000', width: 3 } } }],
    { title: 'STROKE', playlistLines: [], coverDataUri: null },
    testOptions, testLoadFont,
  );
  expect(png.length).toBeGreaterThan(0);
});

it('renders a shadow without throwing', async () => {
  const png = await renderScene(
    [{ type: 'title', x: 0, y: 0, width: 400, fontSize: 60,
       color: { mode: 'solid', color: '#ffffff' },
       style: { fontFamily: 'DejaVu Sans', bold: false, italic: false,
         shadow: { color: '#000000', blur: 4, offsetX: 2, offsetY: 2 } } }],
    { title: 'SHADOW', playlistLines: [], coverDataUri: null },
    testOptions, testLoadFont,
  );
  expect(png.length).toBeGreaterThan(0);
});

it('renders bold+italic using the Liberation Sans family', async () => {
  const png = await renderScene(
    [{ type: 'title', x: 0, y: 0, width: 400, fontSize: 60,
       color: { mode: 'solid', color: '#ffffff' },
       style: { fontFamily: 'Liberation Sans', bold: true, italic: true } }],
    { title: 'BOLD ITALIC', playlistLines: [], coverDataUri: null },
    testOptions, testLoadFont,
  );
  expect(png.length).toBeGreaterThan(0);
});

it('renders a free-standing text element using its own literal text, not scene.title', async () => {
  const png = await renderScene(
    [{ type: 'text', x: 0, y: 0, width: 400, fontSize: 30,
       text: 'sponsored by nobody',
       color: { mode: 'solid', color: '#ffffff' },
       style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } }],
    { title: 'unrelated track title', playlistLines: [], coverDataUri: null },
    testOptions, testLoadFont,
  );
  expect(png.length).toBeGreaterThan(0);
});

it('renders an image element from a data URI', async () => {
  const tinyPngDataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const png = await renderScene(
    [{ type: 'image', x: 10, y: 10, width: 100, height: 100, assetId: 'asset-1' }],
    { title: 'x', playlistLines: [], coverDataUri: null, imageDataUris: { 'asset-1': tinyPngDataUri } },
    testOptions, testLoadFont,
  );
  expect(png.length).toBeGreaterThan(0);
});

it('production default (no loadFont override) still resolves through the real fontRegistry — CI/Docker-only assertion', async () => {
  // This one deliberately does NOT pass testLoadFont, to prove the production default path
  // still works end to end. It only makes sense where /usr/share/fonts/... actually exists
  // (the built Docker image, or CI running inside it) — guard it so local Windows/macOS runs
  // don't fail on an environment difference that isn't a real bug:
  if (process.platform !== 'linux') return;
  const png = await renderScene(
    [{ type: 'title', x: 0, y: 0, width: 400, fontSize: 40,
       color: { mode: 'solid', color: '#ffffff' },
       style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } }],
    { title: 'PROD DEFAULT', playlistLines: [], coverDataUri: null },
    testOptions,
  );
  expect(png.length).toBeGreaterThan(0);
});
```

Fill in `testFontPath` by reading the file's *current* test setup first — it
may already have a real local font path wired up for its existing passing
tests; reuse that exact value rather than inventing a second one. If it
doesn't, add one small checked-in fixture font (a single small permissively-
licensed `.ttf`) under a `test/fixtures/` directory instead of depending on
OS-specific system paths like `C:\Windows\Fonts\...`, so the test suite
doesn't silently break on a machine that happens not to have Arial
installed.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest test/render/sceneRenderer.test.ts`
Expected: FAIL — new branches/fields don't exist in `elementNode`/`SceneData`.

- [ ] **Step 4: Implement**

```typescript
// src/render/sceneRenderer.ts — key changes (keep the file's existing SatoriNode type,
// keep the existing 'cover' case in elementNode unchanged)

import { resolveFontFile, FONT_FAMILIES } from './fontRegistry';
import { loadFontData } from './fontCache';
import { ColorValue, TextStyle, TemplateElement } from '../templates/templateTypes';

export interface SceneData {
  title: string;
  playlistLines: string[];
  coverDataUri: string | null;
  imageDataUris?: Record<string, string>; // assetId -> data: URI, for 'image' elements
}

function colorValueToCss(color: ColorValue): Record<string, unknown> {
  if (color.mode === 'solid') return { color: color.color };
  return {
    backgroundImage: `linear-gradient(${color.angleDeg}deg, ${color.stops.join(', ')})`,
    backgroundClip: 'text',
    color: 'transparent',
  };
}

function textStyleToCss(style: TextStyle, color: ColorValue): Record<string, unknown> {
  const css: Record<string, unknown> = {
    ...colorValueToCss(color),
    fontFamily: style.fontFamily,
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? 'italic' : 'normal',
  };
  if (style.stroke) {
    css.WebkitTextStrokeWidth = style.stroke.width;
    css.WebkitTextStrokeColor = style.stroke.color;
  }
  if (style.shadow) {
    css.textShadow = `${style.shadow.offsetX}px ${style.shadow.offsetY}px ${style.shadow.blur}px ${style.shadow.color}`;
  }
  return css;
}

function elementNode(el: TemplateElement, scene: SceneData): SatoriNode | null {
  const position = { position: 'absolute' as const, left: el.x, top: el.y };
  switch (el.type) {
    case 'cover':
      // ...unchanged, keep the file's existing implementation exactly as-is
      break;
    case 'title':
      return {
        type: 'div',
        props: {
          style: { ...position, width: el.width, fontSize: el.fontSize, display: 'flex', ...textStyleToCss(el.style, el.color) },
          children: scene.title,
        },
      };
    case 'playlist':
      return {
        type: 'div',
        props: {
          style: { ...position, width: el.width, fontSize: el.fontSize, display: 'flex', flexDirection: 'column', ...textStyleToCss(el.style, el.color) },
          children: scene.playlistLines.map((line): SatoriNode => ({
            type: 'div',
            props: { style: { display: 'flex' }, children: line },
          })),
        },
      };
    case 'text':
      return {
        type: 'div',
        props: {
          style: { ...position, width: el.width, fontSize: el.fontSize, display: 'flex', ...textStyleToCss(el.style, el.color) },
          children: el.text,
        },
      };
    case 'image': {
      const src = scene.imageDataUris?.[el.assetId];
      if (!src) {
        return { type: 'div', props: { style: { ...position, width: el.width, height: el.height, backgroundColor: '#000000' } } };
      }
      return {
        type: 'img',
        props: { style: { ...position, width: el.width, height: el.height, objectFit: 'contain' }, ...({ src } as Record<string, unknown>) },
      };
    }
    case 'timer':
      return null; // unchanged — see the file's existing comment on this case
  }
}

// Collects every distinct (family, weight, style) combination actually used across a scene's
// elements, so satori() registers exactly the font files it needs — not a fixed single entry.
function collectFontVariants(elements: TemplateElement[]): { family: string; bold: boolean; italic: boolean }[] {
  const seen = new Map<string, { family: string; bold: boolean; italic: boolean }>();
  for (const el of elements) {
    if (el.type !== 'title' && el.type !== 'playlist' && el.type !== 'text') continue;
    const key = `${el.style.fontFamily}|${el.style.bold}|${el.style.italic}`;
    if (!seen.has(key)) seen.set(key, { family: el.style.fontFamily, bold: el.style.bold, italic: el.style.italic });
  }
  if (seen.size === 0) seen.set('default', { family: FONT_FAMILIES[0], bold: false, italic: false });
  return [...seen.values()];
}

// Default font loader: real registry path + real fs read, exactly what production uses.
// The optional 4th parameter below exists ONLY so this file's own tests can substitute a
// cross-platform-safe loader (e.g. a real local Windows/macOS .ttf for dev-machine test runs)
// without mocking satori/resvg themselves or the production code path — production never
// passes this argument, so it always gets the real registry.
async function defaultLoadFont(family: string, bold: boolean, italic: boolean): Promise<Buffer> {
  return loadFontData(resolveFontFile(family, bold, italic));
}

// A named, exported interface (not an inline `{width,height}` type) deliberately — Task 9
// later adds a `background` field to THIS interface, and renderWorker.ts/renderWorkerPool.ts
// import and reuse it by reference rather than duplicating the shape, so that later addition
// doesn't require touching those two files by hand.
export interface SceneRendererOptions {
  width: number;
  height: number;
}

export async function renderScene(
  elements: TemplateElement[],
  scene: SceneData,
  options: SceneRendererOptions,
  loadFont: (family: string, bold: boolean, italic: boolean) => Promise<Buffer> = defaultLoadFont,
): Promise<Buffer> {
  const variants = collectFontVariants(elements);
  const fonts = await Promise.all(variants.map(async (v) => ({
    name: v.family,
    data: await loadFont(v.family, v.bold, v.italic),
    weight: (v.bold ? 700 : 400) as 400 | 700,
    style: (v.italic ? 'italic' : 'normal') as 'italic' | 'normal',
  })));

  const root: SatoriNode = {
    type: 'div',
    props: {
      style: { width: options.width, height: options.height, display: 'flex', position: 'relative' },
      children: elements.map((el) => elementNode(el, scene)).filter((node): node is SatoriNode => node !== null),
    },
  };

  const svg = await satori(root as unknown as Parameters<typeof satori>[0], {
    width: options.width, height: options.height, fonts,
  });

  return new Resvg(svg).render().asPng();
}
```

**Note:** `SceneRendererOptions`'s `fontData`/`fontFamily` fields are
removed — `renderScene` now resolves every font itself via
`fontRegistry`/`fontCache`. Update `renderOverlay.ts` (the one caller of
`renderScene`) to stop loading font data and stop passing `fontData`/
`fontFamily` into that specific call — this is Task 4's own
responsibility since it's the direct consequence of this signature change.

**Explicitly out of scope for this task (do not chase further):**
`renderOverlay.ts`'s own `renderTemplatePng()` signature, `RendererDeps` in
`templateRoutes.ts`, `StreamManagerDeps.fontFile`/`fontFamily` in
`streamManager.ts`, and the `FONT_FILE`/`OVERLAY_FONT_FAMILY` constants in
`server.ts` all still exist and still get threaded through as before —
they just become unused by the one call site this task actually changes.
Ripping out that entire now-dead plumbing chain is a separate, purely
mechanical cleanup task not worth bundling into this one (it risks
touching wiring this plan doesn't otherwise need to touch, for a
correctness-neutral change — unused parameters aren't a bug). Leave them
in place. **This does NOT include `renderWorker.ts`** — that file's
`fontData` rewrap is not "unused plumbing that's fine to leave," it is a
compile error once `SceneRendererOptions`/`RenderTask['options']` stops
having a `fontData` field. Fix it now, in this task (Step 4b below).

- [ ] **Step 4b: Fix `renderWorker.ts` — remove the now-obsolete fontData rewrap**

```typescript
// src/render/renderWorker.ts — full replacement
import { renderScene, SceneData, SceneRendererOptions } from './sceneRenderer';
import { TemplateElement } from '../templates/templateTypes';

export interface RenderTask {
  elements: TemplateElement[];
  scene: SceneData;
  options: SceneRendererOptions; // imported by reference — when Task 9 later adds a
    // `background` field to SceneRendererOptions, this type widens automatically, no edit
    // needed here.
}

// Piscina's worker entry point — runs inside a worker_thread, off the main event loop. Resvg's
// SVG->PNG rasterization is synchronous native CPU work; running it here (rather than inline in
// the request/segment-build path) is what keeps one stream's overlay render from stalling every
// other active stream's ffmpeg feeding and every other in-flight HTTP request on the same
// process. See renderWorkerPool.ts for the pool this feeds into.
//
// Font loading now happens inside renderScene() itself (see sceneRenderer.ts), reading font
// files directly from disk in THIS worker thread — the font bytes never cross the postMessage
// boundary into or out of this function, so there is no Buffer/Uint8Array rewrap needed here
// any more (contrast with renderWorkerPool.ts's renderViaPool(), which still rewraps the PNG
// *return value* crossing back out — that boundary is unrelated and still real).
export default function render(task: RenderTask): Promise<Buffer> {
  return renderScene(task.elements, task.scene, task.options);
}
```

Update `test/render/renderWorker.test.ts` — read it first. Its existing
case(s) construct a `RenderTask` with `options: { width, height, fontData,
fontFamily }` and likely assert on the Buffer-rewrap behavior for
`fontData` specifically (the documented Cyrillic-glyph regression). That
specific assertion no longer applies (there's nothing to rewrap — this
task's own `sceneRenderer.ts` tests, via the `loadFont` injection point,
are what now cover real-font-loading correctness). Replace it with a
simpler test confirming `render()` just forwards its arguments to
`renderScene` and returns its result (mock `sceneRenderer.ts`'s
`renderScene` export for this one test file only — this file's job is
"does the worker wrapper delegate correctly," not "does rendering work,"
which `sceneRenderer.test.ts` already covers with the real thing).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest test/render/sceneRenderer.test.ts test/render/renderWorker.test.ts`
Expected: PASS. (Note: `test/render/renderOverlay.test.ts` does not
currently exist in this repo — an earlier draft of this plan referenced
it by mistake; don't create it speculatively here, `renderOverlay.ts`'s
own signature is untouched by this task per the out-of-scope note above.)
**This risk is already resolved, not open:** during
planning, a throwaway script ran all three CSS tricks through the real
installed `satori@^0.33.4` + `@resvg/resvg-js@^2.6.2` pair (this project's
actual pinned versions, not just satori's docs) and confirmed all three
work — gradient text produces a real `<linearGradient>` def with the text
filled via `fill="url(#...)"`, `WebkitTextStrokeWidth`/`Color` produce real
`stroke`/`stroke-width` SVG attributes, and `textShadow` produces a real
`feDropShadow`/`feGaussianBlur` SVG filter — verified both structurally
(regex over the SVG output) and visually (rendered PNGs inspected by eye:
gradient text visibly red-to-blue, shadow visibly offset). If this task's
own tests still somehow fail on one of these, that means something is
different between the spike's minimal repro and this task's actual
integration (e.g. an interaction with `position:absolute` or the
multi-font `fonts:[...]` array) — treat that as a real regression to debug,
not evidence the trick itself doesn't work.

- [ ] **Step 6: Run the full suite**

Run: `npx jest`
Expected: PASS, no regressions. `renderWorkerPool.test.ts` should be
unaffected (its own `SceneRendererOptions`-typed parameter just narrows,
nothing in that file's own logic touches `fontData` directly).

- [ ] **Step 7: Commit**

```bash
git add src/render/sceneRenderer.ts src/render/renderOverlay.ts src/render/renderWorker.ts test/render/sceneRenderer.test.ts test/render/renderWorker.test.ts
git commit -m "feat: gradient/stroke/shadow/bold/italic/text/image rendering via Satori"
```

---

### Task 5: Timer's native `drawtext` — font resolution, stroke, shadow

**Files:**
- Modify: `src/ffmpeg/segmentArgs.ts`, `src/stream/streamManager.ts`
- Test: `test/ffmpeg/segmentArgs.test.ts`, extend `test/stream/streamManager.test.ts`

**Interfaces:**
- Consumes: `resolveFontFile` (Task 2), `TimerElement`/`TextStyle` (Task 1).
- Produces: `overlayFilterComplex`/`buildCanvasFrameArgs` keep their
  existing exported signatures — only the drawtext string they build
  changes shape internally. `NowPlayingOverlay.timer` gains `style`.

**Confirmed by reading the current file (not guessed):**
`src/ffmpeg/segmentArgs.ts` today has `TimerElementPosition { x, y,
fontSize, color }` and `TimerOverlay extends TimerElementPosition { text }`
— `text` is already a plain, pre-formatted string (Stage 2 removed the old
live-pts-expression path entirely, per the file's own comment), so there
is no double-colon drawtext escaping left to preserve here — the earlier
brainstorming note about that was based on a stale assumption; disregard
it. `style: TextStyle` is added to `TimerElementPosition`, which
`TimerOverlay` then inherits automatically via `extends` — do not add it
to `TimerOverlay` directly.

**The wiring gap this task must also close:** `TimerElement` (Task 1) gets
a `style` field, but nothing currently threads it through to
`NowPlayingOverlay.timer`. `src/stream/streamManager.ts` (around where
`timerElement` is found and `NowPlayingOverlay.timer` is built) constructs
that object by listing fields explicitly:
```typescript
timer: timerElement
  ? { x: timerElement.x, y: timerElement.y, fontSize: timerElement.fontSize, color: timerElement.color }
  : null,
```
This must become:
```typescript
timer: timerElement
  ? { x: timerElement.x, y: timerElement.y, fontSize: timerElement.fontSize, color: timerElement.color, style: timerElement.style }
  : null,
```
Without this change, everything else in this task is correct but
unreachable from real production code — it would only ever be exercised
by this task's own unit tests, never by an actual stream. Confirm the
current line numbers in the file before editing (this plan's line numbers
may drift as earlier tasks touch nearby code).

- [ ] **Step 1: Read the current `overlayFilterComplex`/`TimerElementPosition` shape and the `streamManager.ts` construction site**

Read both files in full before changing anything, to confirm the above
against the real code at execution time (earlier tasks in this plan may
have shifted line numbers).

- [ ] **Step 2: Write the failing tests**

```typescript
// test/ffmpeg/segmentArgs.test.ts — add to the existing overlayFilterComplex/buildCanvasFrameArgs describe block
it('drawtext includes fontfile resolved from the timer style, not the hardcoded default', () => {
  const args = buildCanvasFrameArgs({
    backgroundPath: 'bg.png', overlayPngPath: 'overlay.png', fontFile: '/unused-legacy-param.ttf',
    width: 1280, height: 720,
    timer: { x: 10, y: 10, fontSize: 20, color: '#ffffff', text: '1:23 / 4:56',
      style: { fontFamily: 'Liberation Sans', bold: true, italic: false } },
  });
  const filterArg = args[args.indexOf('-filter_complex') + 1];
  expect(filterArg).toContain('fontfile=/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf');
});

it('drawtext includes borderw/bordercolor when the timer style has a stroke', () => {
  const args = buildCanvasFrameArgs({
    backgroundPath: 'bg.png', overlayPngPath: 'overlay.png', fontFile: '/unused-legacy-param.ttf',
    width: 1280, height: 720,
    timer: { x: 10, y: 10, fontSize: 20, color: '#ffffff', text: 'x',
      style: { fontFamily: 'DejaVu Sans', bold: false, italic: false, stroke: { color: '#000000', width: 2 } } },
  });
  const filterArg = args[args.indexOf('-filter_complex') + 1];
  expect(filterArg).toContain('borderw=2');
  expect(filterArg).toContain('bordercolor=#000000');
});

it('drawtext includes shadowx/shadowy/shadowcolor when the timer style has a shadow (blur is ignored, drawtext has no equivalent)', () => {
  const args = buildCanvasFrameArgs({
    backgroundPath: 'bg.png', overlayPngPath: 'overlay.png', fontFile: '/unused-legacy-param.ttf',
    width: 1280, height: 720,
    timer: { x: 10, y: 10, fontSize: 20, color: '#ffffff', text: 'x',
      style: { fontFamily: 'DejaVu Sans', bold: false, italic: false, shadow: { color: '#333333', blur: 10, offsetX: 3, offsetY: 4 } } },
  });
  const filterArg = args[args.indexOf('-filter_complex') + 1];
  expect(filterArg).toContain('shadowx=3');
  expect(filterArg).toContain('shadowy=4');
  expect(filterArg).toContain('shadowcolor=#333333');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest test/ffmpeg/segmentArgs.test.ts`
Expected: FAIL — `style` field doesn't exist on `TimerOverlay` yet.

- [ ] **Step 4: Implement**

Extend `TimerElementPosition` (in this same file) with a `style: TextStyle`
field (import `TextStyle` from `../templates/templateTypes`) —
`TimerOverlay` inherits it automatically via `extends`. Then extend
`overlayFilterComplex`'s drawtext string construction:

```typescript
// Inside overlayFilterComplex, where the drawtext filter string is built — extend it:
import { resolveFontFile } from '../render/fontRegistry';
// ...
const fontfile = resolveFontFile(timer.style.fontFamily, timer.style.bold, timer.style.italic);
let drawtext = `[base]drawtext=fontfile=${fontfile}:text='${timer.text}':x=${timer.x}:y=${timer.y}:fontsize=${timer.fontSize}:fontcolor=${timer.color}`;
if (timer.style.stroke) {
  drawtext += `:borderw=${timer.style.stroke.width}:bordercolor=${timer.style.stroke.color}`;
}
if (timer.style.shadow) {
  drawtext += `:shadowx=${timer.style.shadow.offsetX}:shadowy=${timer.style.shadow.offsetY}:shadowcolor=${timer.style.shadow.color}`;
}
drawtext += '[outv]';
```

`timer.text` needs no escaping changes — it's already a plain string with
no live pts-expression (confirmed above), untouched by this task.

Also apply the `streamManager.ts` one-line wiring fix described above so
`NowPlayingOverlay.timer` actually carries `style`.

- [ ] **Step 5: Run tests to verify they pass, then run the file's full suite**

Run: `npx jest test/ffmpeg/segmentArgs.test.ts test/stream/streamManager.test.ts`
Expected: PASS, including every pre-existing test in both files. The
`buildCanvasFrameArgs`/`overlayFilterComplex` `fontFile` parameter becomes
dead for the timer-drawtext path specifically once font resolution goes
through the registry — check whether it's still used for anything else in
this file (it composites the background+overlay PNG regardless of timer,
so confirm before assuming it's fully dead) before removing it; if it's
now unused everywhere, removing it is this task's job, not a "known
follow-up".

- [ ] **Step 6: Real-binary check**

Run the generated filter string through a real local `ffmpeg` process (not
just asserting the string shape) — this exact class of bug (double-colon
escaping) was already caught this way once in this project and missed by
string-only tests. A quick throwaway: `ffmpeg -f lavfi -i color=c=black:s=1280x720:d=1 -filter_complex "<paste the generated string>" -frames:v 1 -y /tmp/check.png` and confirm it exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/ffmpeg/segmentArgs.ts src/stream/streamManager.ts test/ffmpeg/segmentArgs.test.ts test/stream/streamManager.test.ts
git commit -m "feat: timer drawtext resolves font family/weight/style, stroke, shadow"
```

---

### Task 6: Image upload — service + routes

**Files:**
- Create: `src/templates/templateImageService.ts`
- Modify: `src/templates/templateRoutes.ts`, `src/server.ts`, `src/api/app.ts`
- Test: `test/templates/templateImageService.test.ts`, extend `test/templates/templateRoutes.test.ts`

**Interfaces:**
- Consumes: `TemplateRepository` and the existing `requireOwnedTemplate`/
  `userId`/`auth`/`wrapAsync` helpers already in `templateRoutes.ts`'s
  closure (see the Global Constraints section for the verified pattern).
- Produces: `TemplateImageService.upload(userId, templateId, file): Promise<{ assetId: string }>`
  and `TemplateImageService.resolvePath(userId, templateId, assetId): string`
  (the renderable `.png` path) — Task 9 (buildOverlay/preview wiring the
  `imageDataUris` scene field) and Task 10 (frontend) both depend on the
  exact route shapes below. `createTemplateRouter` gains a 5th parameter,
  `templateImageService: TemplateImageService`.

**This task must fully wire `TemplateImageService` end to end through
`server.ts`/`app.ts` itself — do not leave it half-built for a later
task to finish.** (An earlier draft of this plan split this wiring across
Task 6 and Task 9, which would leave the codebase in a
non-compiling/non-running state at the end of Task 6 — every task must
leave `npm run build` and the full test suite green.) Concretely, in
`src/server.ts`: construct `const templateImageService = new
TemplateImageService({ uploadsDir: config.uploadsDir });` **early**,
alongside `trackUploadService` (both are upload-related services keyed off
`config.uploadsDir`, and — importantly — this must be declared *before*
`new StreamManager({...})` is constructed a bit further down in this same
file, so Task 9 can later add it to `StreamManagerDeps` without having to
reorder anything). Add `templateImageService: TemplateImageService` to
`AppDeps` (`src/api/app.ts`) and pass it as `createTemplateRouter`'s 5th
argument at that file's one call site; pass `templateImageService` into
the `createApp({...})` call in `server.ts` alongside every other dep.
Task 9 later reuses this exact same `templateImageService` variable for
`StreamManagerDeps` — it does not construct a second instance.

- [ ] **Step 1: Read `trackUploadService.ts` and `trackRoutes.ts`'s cover-upload/cover-get routes first**

This task mirrors that exact pattern — read both files completely before
writing anything, including how multer is configured (file size limit,
temp dir) in whichever router file wires it up for tracks, so the same
limit is reused here rather than invented fresh.

- [ ] **Step 2: Write the failing service test**

```typescript
// test/templates/templateImageService.test.ts
import { TemplateImageService } from '../../src/templates/templateImageService';

describe('TemplateImageService', () => {
  it('normalizes a PNG upload to {assetId}.png via ffmpeg and keeps the original alongside it', async () => {
    const moveFile = jest.fn().mockResolvedValue(undefined);
    const runFfmpeg = jest.fn().mockResolvedValue(undefined);
    const generateId = () => 'asset-123';
    const service = new TemplateImageService({ uploadsDir: '/data/uploads', moveFile, runFfmpeg, generateId });

    const result = await service.upload('user-1', 'tpl-1', { originalname: 'logo.png', path: '/tmp/upload-abc', size: 1000 });

    expect(result).toEqual({ assetId: 'asset-123' });
    expect(moveFile).toHaveBeenCalledWith('/tmp/upload-abc', '/data/uploads/user-1/templates/tpl-1/images/asset-123.original.png');
    expect(runFfmpeg).toHaveBeenCalledWith(
      '/data/uploads/user-1/templates/tpl-1/images/asset-123.original.png',
      '/data/uploads/user-1/templates/tpl-1/images/asset-123.png',
    );
  });

  it('resolvePath points at the renderable .png regardless of the original upload extension', () => {
    const service = new TemplateImageService({ uploadsDir: '/data/uploads', moveFile: jest.fn(), runFfmpeg: jest.fn(), generateId: () => 'x' });
    expect(service.resolvePath('user-1', 'tpl-1', 'asset-123'))
      .toBe('/data/uploads/user-1/templates/tpl-1/images/asset-123.png');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest test/templates/templateImageService.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement the service**

```typescript
// src/templates/templateImageService.ts
import { posix as path } from 'path';
import { randomUUID } from 'crypto';
import * as fsPromises from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface UploadedFile {
  originalname: string;
  path: string;
  size: number;
}

export interface TemplateImageServiceDeps {
  uploadsDir: string;
  moveFile?: (from: string, to: string) => Promise<void>;
  runFfmpeg?: (originalPath: string, outPngPath: string) => Promise<void>;
  generateId?: () => string;
}

export class TemplateImageService {
  private readonly moveFile: (from: string, to: string) => Promise<void>;
  private readonly runFfmpeg: (originalPath: string, outPngPath: string) => Promise<void>;
  private readonly generateId: () => string;

  constructor(private readonly deps: TemplateImageServiceDeps) {
    this.moveFile = deps.moveFile ?? (async (from, to) => {
      await fsPromises.mkdir(path.dirname(to), { recursive: true });
      try {
        await fsPromises.rename(from, to);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
          await fsPromises.copyFile(from, to);
          await fsPromises.unlink(from);
        } else {
          throw err;
        }
      }
    });
    // -update 1 is required so ffmpeg writes a single PNG file rather than treating the output
    // path as an image-sequence pattern (which -frames:v 1 alone does not prevent). One code
    // path handles PNG/JPEG/GIF-first-frame alike this way.
    this.runFfmpeg = deps.runFfmpeg ?? (async (originalPath, outPngPath) => {
      await execFileAsync('ffmpeg', ['-y', '-i', originalPath, '-frames:v', '1', '-update', '1', outPngPath]);
    });
    this.generateId = deps.generateId ?? randomUUID;
  }

  private imagesDir(userId: string, templateId: string): string {
    return path.join(this.deps.uploadsDir, userId, 'templates', templateId, 'images');
  }

  async upload(userId: string, templateId: string, file: UploadedFile): Promise<{ assetId: string }> {
    const assetId = this.generateId();
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    const dir = this.imagesDir(userId, templateId);
    const originalPath = path.join(dir, `${assetId}.original${ext}`);
    const pngPath = path.join(dir, `${assetId}.png`);

    await this.moveFile(file.path, originalPath);
    await this.runFfmpeg(originalPath, pngPath);

    return { assetId };
  }

  resolvePath(userId: string, templateId: string, assetId: string): string {
    return path.join(this.imagesDir(userId, templateId), `${assetId}.png`);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest test/templates/templateImageService.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire the routes**

**Confirmed by reading the real files:** `multer` is NOT shared across
routers in this codebase — `trackRoutes.ts` configures its own local
`const upload = multer({ dest: os.tmpdir(), limits: { fileSize:
MAX_AUDIO_BYTES } })`. Add an equivalent local instance to
`templateRoutes.ts` with an image-appropriate size limit (images are much
smaller than audio uploads — a `MAX_IMAGE_BYTES` constant, e.g. 10MB, not
`trackRoutes.ts`'s audio limit).

**`createTemplateRouter`'s real signature is four positional parameters,
not a `deps` object** (see the Global Constraints section above for the
full verified pattern — `wrapAsync`, `throw new ApiError(...)`, the
existing `requireOwnedTemplate`/`userId` helpers). It gains a 5th
parameter, `templateImageService: TemplateImageService`:

```typescript
// src/templates/templateRoutes.ts
import multer from 'multer';
import * as os from 'os';
import { TemplateImageService } from './templateImageService';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: MAX_IMAGE_BYTES } });
const ALLOWED_IMAGE_MIMETYPES = ['image/png', 'image/jpeg', 'image/gif'];

export function createTemplateRouter(
  authService: AuthService,
  templateRepository: TemplateRepository,
  trackRepository: Pick<TrackRepository, 'findById'>,
  rendererDeps: TemplateRendererDeps,
  templateImageService: TemplateImageService,
): Router {
  // ...existing router/auth/userId/requireOwnedTemplate setup, unchanged...

  router.post('/:id/images', auth, upload.single('image'), wrapAsync(async (req, res) => {
    const owner = userId(req as AuthenticatedRequest);
    const template = await requireOwnedTemplate(req.params.id, owner);
    if (!req.file) throw new ApiError(400, 'image file is required');
    if (!ALLOWED_IMAGE_MIMETYPES.includes(req.file.mimetype)) throw new ApiError(400, 'unsupported image type');
    const result = await templateImageService.upload(owner, template.id, {
      originalname: req.file.originalname, path: req.file.path, size: req.file.size,
    });
    res.status(200).json(result);
  }));

  router.get('/:id/images/:assetId', auth, wrapAsync(async (req, res) => {
    const owner = userId(req as AuthenticatedRequest);
    const template = await requireOwnedTemplate(req.params.id, owner);
    const filePath = templateImageService.resolvePath(owner, template.id, req.params.assetId);
    res.sendFile(filePath);
  }));

  return router;
}
```

**Matches the existing, real pattern exactly** — `trackRoutes.ts`'s
`GET /:id/cover` calls `res.sendFile(track.coverPath)` with **no**
callback (confirmed by reading that file), relying on Express's documented
default behavior of forwarding a missing-file error to `next()`
automatically when no callback is given; wrapped in `wrapAsync`, that
still reaches `errorHandler.ts`. Don't add a callback here — it would
diverge from the codebase's one existing precedent for this exact kind of
route for no reason (an earlier draft of this plan added an unnecessary
`next`-calling callback here before this was checked against the real
file). Also worth knowing: `errorHandler.ts` already 400s a
`multer.MulterError` automatically (e.g. `LIMIT_FILE_SIZE` from
`MAX_IMAGE_BYTES`) — no manual file-size check is needed in the upload
handler above.

- [ ] **Step 7: Write route tests, following the existing fake-repository pattern in `templateRoutes.test.ts`**

Cover: 200 + `{assetId}` on a valid upload by the template's owner; 404 for
a nonexistent template; 403 for another user's template; 400 for a missing
file; 400 for a disallowed mimetype (e.g. `image/svg+xml`); GET returns
the file for the owner, 404 for a wrong assetId, 403 for another user's
template. Whatever this test file's existing setup does to construct a
router for testing (it calls `createTemplateRouter(...)` with fakes for
its first four params) now needs a 5th argument too — a fake/stub
`TemplateImageService` (e.g. `{ upload: jest.fn(), resolvePath: jest.fn() }`).

- [ ] **Step 8: Run the full suite, and the build**

Run: `npx jest && npm run build`
Expected: both PASS — `npm run build` matters here specifically because
this task changes `AppDeps`/`createApp`'s call site and `server.ts`'s
construction order (see the `templateImageService` wiring note above); a
type error in that wiring wouldn't necessarily show up in `jest` alone if
no test exercises the real `createApp`/`server.ts` composition root.

- [ ] **Step 9: Commit**

```bash
git add src/templates/templateImageService.ts src/templates/templateRoutes.ts src/server.ts src/api/app.ts test/templates/templateImageService.test.ts test/templates/templateRoutes.test.ts
git commit -m "feat: template image upload (POST/GET /templates/:id/images)"
```

---

### Task 7: `GET /templates/fonts`

**Files:**
- Modify: `src/templates/templateRoutes.ts`
- Test: extend `test/templates/templateRoutes.test.ts`

**Interfaces:**
- Consumes: `FONT_FAMILIES` (Task 2).
- Produces: `GET /templates/fonts` → `200 { families: string[] }`. Frontend
  Task 11 depends on this exact response shape.

- [ ] **Step 1: Write the failing test**

```typescript
it('GET /templates/fonts returns the available font families', async () => {
  const res = await request(app).get('/templates/fonts').set('Cookie', sessionCookie);
  expect(res.status).toBe(200);
  expect(res.body.families).toEqual(expect.arrayContaining(['DejaVu Sans', 'Liberation Sans']));
});
```

Match whatever auth/session setup the rest of this test file already uses
(`sessionCookie` above is illustrative — copy the file's real pattern).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/templates/templateRoutes.test.ts`
Expected: FAIL — route doesn't exist.

- [ ] **Step 3: Implement**

```typescript
import { FONT_FAMILIES } from '../render/fontRegistry';
// ...inside createTemplateRouter, using the already-bound `auth` middleware
// (const auth = requireAuth(authService)) — not bare `requireAuth`, matching every
// other route in this file:
router.get('/fonts', auth, (_req, res) => {
  res.status(200).json({ families: FONT_FAMILIES });
});
```

Mount this **before** the `/:id` routes in the router (an unparameterized
`/fonts` path must not be shadowed by `/:id` matching the literal string
"fonts" as an id — check the router's current route order and place it
correctly).

- [ ] **Step 4: Run test to verify it passes, then the full suite**

Run: `npx jest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/templates/templateRoutes.ts test/templates/templateRoutes.test.ts
git commit -m "feat: GET /templates/fonts"
```

---

### Task 8: `Track.overlayOverride` — migration + repository + route + read-path plumbing

**Files:**
- Modify: `prisma/schema.prisma`, `src/tracks/trackRepository.ts`, `src/tracks/trackRoutes.ts`,
  `src/playlists/playlistRepository.ts`, `src/playlist/types.ts`, `src/stream/streamManager.ts`
- Test: extend `test/tracks/trackRoutes.test.ts`, extend `test/playlists/playlistRepository.test.ts` if one exists (check), extend `test/stream/streamManager.test.ts`
- Create: `prisma/migrations/<timestamp>_track_overlay_override/migration.sql` (generated, not hand-written)

**Confirmed by reading the current files (this is not a hypothetical
risk — it is a real, necessary step, verified against the real code):**
`StreamManager.buildOverlay` only ever sees a `Track` (from
`src/playlist/types.ts`, today `{ name, audioPath, coverPath }`) sourced
from `PlaylistRepository.listTracks()` — never a full Prisma `Track` row.
`listTracks()` (`src/playlists/playlistRepository.ts`) does `include:
{ track: true }` (which *would* pull the new `overlayOverride` column once
the migration lands) but then manually re-maps each row into
`PlaylistTrackView { id, name, audioPath, coverPath }` — `overlayOverride`
is silently dropped right there. Task 9 cannot read a track's override at
all unless this task closes that gap. This is not "check whether the Track
type already carries this field" (that phrasing in an earlier draft of
this plan was too hedgy) — it does not, and this task adds it.

**Interfaces:**
- Consumes: `ColorValue`, `isValidColorValue` (both Task 1) for defining
  and validating the override's shape.
- Produces: `TrackOverlayOverride` (defined and exported from
  `src/tracks/trackRepository.ts` — the natural home since there's no
  separate `tracks/types.ts` in the current layout; import it from there
  in every later task/file that needs it, never redeclare it),
  `TrackRepository.updateOverlayOverride(trackId, override: TrackOverlayOverride | null): Promise<void>`,
  `PATCH /tracks/{id}` accepting `{ overlayOverride }`. Task 9 depends on
  the repository method's exact name and the shape it reads back.

```typescript
// src/tracks/trackRepository.ts — add near the top, alongside this file's existing exported types
import { ColorValue } from '../templates/templateTypes';

export interface TrackOverlayOverride {
  color?: ColorValue;
  backgroundColor?: ColorValue;
}
```

- [ ] **Step 1: Add the schema field**

```prisma
model Track {
  // ...existing fields, unchanged
  overlayOverride Json?
}
```

- [ ] **Step 2: Generate the migration**

Follow CLAUDE.md's documented remote-throwaway-Postgres workflow exactly
(stage `schema.prisma` + the **existing** `prisma/migrations/` directory +
`package.json`/`package-lock.json`, throwaway `postgres:16-alpine` +
`node:20-bookworm-slim` containers on 192.168.14.26, `npm ci` before
`npx prisma migrate dev --name track_overlay_override --skip-generate`,
copy the generated migration directory back, tear everything down). Do
not hand-write the migration SQL.

- [ ] **Step 3: Write the failing repository test**

```typescript
it('updateOverlayOverride sets the field, and passing null clears it', async () => {
  // follow this file's existing manual-smoke-test-with-real-Postgres convention
  // (per CLAUDE.md: repositories are verified this way, not unit-tested against fakes)
});
```

- [ ] **Step 4: Implement the repository method**

```typescript
// src/tracks/trackRepository.ts — add alongside the existing methods
import { Prisma } from '@prisma/client';
// ...
async updateOverlayOverride(trackId: string, override: TrackOverlayOverride | null): Promise<void> {
  await this.prisma.track.update({ where: { id: trackId }, data: { overlayOverride: override ?? Prisma.DbNull } });
}
```

**Use `Prisma.DbNull`, not `Prisma.JsonNull`, here.** Prisma's nullable
`Json?` columns need one of these two distinct sentinels instead of a
plain `null` literal, and they are NOT interchangeable: `Prisma.JsonNull`
writes the literal JSON value `null` *into* the column (the column is
still non-NULL at the SQL level, storing the 4-byte JSON token `null`);
`Prisma.DbNull` writes a true SQL `NULL`. Both currently deserialize back
to JS `null` on a plain read, so the difference is easy to miss in a quick
test — but `DbNull` is the one that actually means "no override," and
becomes real correctness (not just style) the moment anything ever
queries with `where: { overlayOverride: null }` (a true SQL `NULL`
matches that Prisma filter; a stored JSON `null` token does not).

- [ ] **Step 5: Write the failing route test**

```typescript
// test/tracks/trackRoutes.test.ts
it('PATCH /tracks/:id sets overlayOverride for the owner', async () => {
  const res = await request(app).patch(`/tracks/${trackId}`).set('Cookie', sessionCookie)
    .send({ overlayOverride: { color: { mode: 'solid', color: '#ff0000' } } });
  expect(res.status).toBe(200);
});

it('PATCH /tracks/:id 400s on an invalid overlayOverride shape', async () => {
  const res = await request(app).patch(`/tracks/${trackId}`).set('Cookie', sessionCookie)
    .send({ overlayOverride: { color: { mode: 'solid', color: 'not-a-hex-color' } } });
  expect(res.status).toBe(400);
});

it('PATCH /tracks/:id 403s for a track owned by someone else', async () => {
  // mirror this file's existing ownership-check test pattern
});

it('PATCH /tracks/:id with overlayOverride: null clears it', async () => {
  const res = await request(app).patch(`/tracks/${trackId}`).set('Cookie', sessionCookie)
    .send({ overlayOverride: null });
  expect(res.status).toBe(200);
});
```

- [ ] **Step 6: Implement the route**

**Confirmed by reading the real `src/tracks/trackRoutes.ts`:** it uses the
exact same `wrapAsync`/`throw new ApiError(...)` pattern as
`templateRoutes.ts` (see Global Constraints), but inlines the caller's id
as `(req as AuthenticatedRequest).user!.id` at each use rather than a
shared `userId()` helper function — `createTrackRouter`'s existing routes
(`GET /:id/cover`, `DELETE /:id`) are the exact model to copy for the
ownership check, not a generic `deps.x`/`next(err)` shape:

```typescript
// src/tracks/trackRoutes.ts
import { isValidColorValue } from '../templates/templateTypes';
import { TrackOverlayOverride } from './trackRepository';

function isValidOverlayOverride(value: unknown): value is TrackOverlayOverride | null {
  if (value === null) return true;
  if (typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.color !== undefined && !isValidColorValue(v.color)) return false;
  if (v.backgroundColor !== undefined && !isValidColorValue(v.backgroundColor)) return false;
  return true;
}

router.patch('/:id', auth, wrapAsync(async (req, res) => {
  const track = await trackRepository.findById(req.params.id);
  if (!track) throw new ApiError(404, 'track not found');
  if (track.userId !== (req as AuthenticatedRequest).user!.id) throw new ApiError(403, 'not your track');
  if (!('overlayOverride' in (req.body ?? {})) || !isValidOverlayOverride(req.body.overlayOverride)) {
    throw new ApiError(400, 'invalid overlayOverride');
  }
  await trackRepository.updateOverlayOverride(track.id, req.body.overlayOverride);
  res.status(200).json({});
}));
```

- [ ] **Step 7: Thread `overlayOverride` through the read path Task 9 depends on**

```typescript
// src/playlist/types.ts
import { TrackOverlayOverride } from '../tracks/trackRepository';

export interface Track {
  name: string;
  audioPath: string;
  coverPath: string | null;
  overlayOverride?: TrackOverlayOverride | null;
}
```

```typescript
// src/playlists/playlistRepository.ts
import { TrackOverlayOverride } from '../tracks/trackRepository';

export interface PlaylistTrackView {
  id: string;
  name: string;
  audioPath: string;
  coverPath: string | null;
  overlayOverride: TrackOverlayOverride | null;
}
// ...
  async listTracks(playlistId: string): Promise<PlaylistTrackView[]> {
    const rows = await this.prisma.playlistTrack.findMany({
      where: { playlistId },
      orderBy: { position: 'asc' },
      include: { track: true },
    });
    return rows.map((row) => ({
      id: row.track.id,
      name: row.track.name,
      audioPath: row.track.audioPath,
      coverPath: row.track.coverPath,
      overlayOverride: row.track.overlayOverride as TrackOverlayOverride | null,
    }));
  }
```

Write a test for `listTracks` asserting `overlayOverride` round-trips
through — match whatever this repository's existing test file does today
(per CLAUDE.md, `PlaylistRepository` is a thin Prisma wrapper normally
verified by manual smoke test with a real Postgres, not unit tests against
a fake — follow that same convention here rather than introducing a new
one; check `test/playlists/playlistRepository.test.ts` for whether one
already exists before assuming its shape).

- [ ] **Step 7b: Fix the SECOND place this exact same stripping bug exists — `StreamManager.start()`'s `allUserTracks`**

**Found by a fresh review of an earlier draft of this plan, which fixed
`PlaylistRepository.listTracks()` (Step 7 above) but missed an identical
bug three lines away in a different file.** `src/stream/streamManager.ts`,
inside `start()`, builds the library used for the `play`-by-name command:

```typescript
const allUserTracks: Track[] = allUserTracksRaw.map((t) => ({ name: t.name, audioPath: t.audioPath, coverPath: t.coverPath }));
```

This drops `overlayOverride` exactly the way `listTracks()` did — a track
reached via `POST /destinations/{id}/stream/play` would render with its
override silently missing, even after Step 7's fix, because this is a
*second*, independent read path. Fix it the same way:

```typescript
const allUserTracks: Track[] = allUserTracksRaw.map((t) => ({
  name: t.name, audioPath: t.audioPath, coverPath: t.coverPath,
  overlayOverride: t.overlayOverride as TrackOverlayOverride | null,
}));
```

(`allUserTracksRaw` comes from `trackRepository.listByUser(destination.userId)`
— confirm its return type already carries the raw `overlayOverride` column
now that the migration has landed, which it should since it's presumably a
full Prisma row read, not a hand-projected view like `PlaylistTrackView`
was.) Add `src/stream/streamManager.ts` to this task's Files list; extend
`test/stream/streamManager.test.ts` with a case asserting a `play`-command
track carries its override through to `LibraryLike.findByName`'s result.

- [ ] **Step 7c: Expose `overlayOverride` on `GET /tracks` — the Library UI (Task 12) cannot function without this**

**Also found by the same review.** `trackRoutes.ts`'s `toSummary()`
returns `{ id, name, durationSeconds, hasCover }` only — Step 6 above adds
the *write* side (`PATCH`) but nothing exposes the *current* value, so
Task 12's on/off override toggle would have no way to initialize its
checked state and risks silently clobbering an existing override the
first time a user opens the Library page and saves anything. Fix:

```typescript
// src/tracks/trackRoutes.ts
function toSummary(track: { id: string; name: string; durationSeconds: number | null; coverPath: string | null; overlayOverride: TrackOverlayOverride | null }) {
  return {
    id: track.id, name: track.name, durationSeconds: track.durationSeconds,
    hasCover: track.coverPath !== null, overlayOverride: track.overlayOverride,
  };
}
```

Update this task's route tests (`GET /tracks`) to assert the field is
present. Task 10's frontend `Track` type (`frontend/src/api/tracks.ts`)
must include `overlayOverride: TrackOverlayOverride | null` to match —
flag this for Task 10 explicitly since Task 10 was written before this
gap was found; if executing Task 10 from an earlier snapshot of this
plan, add the field there too.

- [ ] **Step 8: Run tests, then the full suite**

Run: `npx jest`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/tracks/trackRepository.ts src/tracks/trackRoutes.ts src/playlist/types.ts src/playlists/playlistRepository.ts src/stream/streamManager.ts test/tracks/trackRoutes.test.ts test/stream/streamManager.test.ts
git commit -m "feat: per-track overlayOverride (PATCH/GET /tracks/:id), threaded through both StreamManager read paths"
```

---

### Task 9: Wire `overlayOverride` + image elements into BOTH render call sites (live stream and preview)

**Files:**
- Modify: `src/stream/streamManager.ts`, `src/render/sceneRenderer.ts`,
  `src/render/renderOverlay.ts`, `src/templates/templateRoutes.ts`, `src/server.ts`
- Test: extend `test/stream/streamManager.test.ts`, extend `test/render/sceneRenderer.test.ts`,
  extend `test/templates/templateRoutes.test.ts`

**Two real gaps a fresh review found in an earlier draft of this task —
both are fixed by the design below, read this before the steps:**

1. **`backgroundColor` was designed (Step 2, old draft) but never actually
   reached the renderer.** The old draft added `sceneRenderer.ts` support
   for a root `backgroundColor`, but `applyOverlayOverride()` only ever
   read `override.color` — `override.backgroundColor` was computed
   nowhere and passed nowhere. `RenderOverlayParams`
   (`src/render/renderOverlay.ts`, the shared type both this task's
   `buildOverlay` call and `templateRoutes.ts`'s `/preview` handler build)
   had no field for it to flow through even if it had been read. Fixed
   below by threading a `background?: ColorValue` field end to end:
   `TrackOverlayOverride.backgroundColor` → `RenderOverlayParams.background`
   → `renderViaPool`'s options → `renderScene`'s options → the root
   `SatoriNode`'s style.
2. **`image` elements were never resolved on the `/templates/{id}/preview`
   path at all** — only on the live-stream path this task builds. Without
   this, `TemplateEditor.tsx`'s live preview (its *only* feedback
   mechanism for the new `image` element type) would always show the
   black-rect fallback. Fixed below by extending
   `templateRoutes.ts`'s `/preview` handler too, not just
   `StreamManager.buildOverlay` — this is why this task's scope grew to
   include `templateRoutes.ts`.

**Confirmed by reading `src/render/renderOverlay.ts` and
`src/templates/templateRoutes.ts` in full (not guessed):** after Task 4,
`renderTemplatePng(params: RenderOverlayParams): Promise<Buffer>` looks
like this (Task 4 already removed the `fontData`/`fontFamily` loading and
passing — `fontPath`/`fontFamily` remain as unused fields on
`RenderOverlayParams` per Task 4's explicit "leave this dead plumbing in
place" decision):

```typescript
// src/render/renderOverlay.ts, as Task 4 leaves it
export async function renderTemplatePng(params: RenderOverlayParams): Promise<Buffer> {
  const coverDataUri = await readImageAsDataUri(params.coverPath);
  return renderViaPool(
    params.elements,
    { title: params.title, playlistLines: params.playlistLines, coverDataUri },
    { width: params.width, height: params.height },
  );
}
```

`templateRoutes.ts`'s `/preview` handler (`router.post('/:id/preview', ...)`)
is the ONE other real call site — it builds a `RenderOverlayParams` object
from either the saved template's elements or a draft posted in the request
body, and does not currently touch images or backgrounds at all.

- [ ] **Step 1: Read the current `buildOverlay` closure and the `/preview` handler in full**

Read `src/stream/streamManager.ts`'s `buildOverlay` and
`src/templates/templateRoutes.ts`'s `/preview` handler fresh — re-confirm
against the files, not memory, since Tasks 1-8 changed several of the
types both touch. By this point in the plan, the `track: Track` parameter
`buildOverlay` receives already carries `overlayOverride?: TrackOverlayOverride | null`
(Task 8, Steps 7/7b) — no additional repository read is needed for that
part.

- [ ] **Step 2: Extend `RenderOverlayParams` and `renderTemplatePng`**

```typescript
// src/render/renderOverlay.ts — full replacement
import { renderViaPool } from './renderWorkerPool';
import { readImageAsDataUri } from './imageDataUri';
import { TemplateElement, ColorValue } from '../templates/templateTypes';

export interface RenderOverlayParams {
  elements: TemplateElement[];
  title: string;
  playlistLines: string[];
  coverPath: string;
  width: number;
  height: number;
  fontPath: string;
  fontFamily: string;
  // assetId -> on-disk renderable PNG path (TemplateImageService.resolvePath's return value),
  // one entry per 'image' element actually present in `elements`. Absent/empty is fine — image
  // elements just fall back to their black-rect placeholder (see sceneRenderer.ts).
  imageAssets?: Record<string, string>;
  // The per-track overlayOverride's backgroundColor, if any — applied to the whole canvas
  // behind every element. Absent means "use the template's own background," i.e. none (today's
  // existing behavior, unchanged).
  background?: ColorValue;
}

export async function renderTemplatePng(params: RenderOverlayParams): Promise<Buffer> {
  const imageAssetEntries = Object.entries(params.imageAssets ?? {});
  const [coverDataUri, ...imageDataUriValues] = await Promise.all([
    readImageAsDataUri(params.coverPath),
    ...imageAssetEntries.map(([, filePath]) => readImageAsDataUri(filePath)),
  ]);
  const imageDataUris = Object.fromEntries(imageAssetEntries.map(([assetId], i) => [assetId, imageDataUriValues[i]]));

  return renderViaPool(
    params.elements,
    { title: params.title, playlistLines: params.playlistLines, coverDataUri, imageDataUris },
    { width: params.width, height: params.height, background: params.background },
  );
}
```

- [ ] **Step 3: Extend `sceneRenderer.ts`'s root background support**

```typescript
// src/render/sceneRenderer.ts — extends what Task 4 already built. `SceneRendererOptions` is
// the SAME named interface Task 4 exported (renderWorker.ts/renderWorkerPool.ts already import
// it by reference) — widen it in place, don't redefine renderScene's parameter as a new inline
// type:
export interface SceneRendererOptions {
  width: number;
  height: number;
  background?: ColorValue;
}

function backgroundToCss(background: ColorValue): Record<string, unknown> {
  if (background.mode === 'solid') return { backgroundColor: background.color };
  return { backgroundImage: `linear-gradient(${background.angleDeg}deg, ${background.stops.join(', ')})` };
}

// Inside renderScene's existing body (signature itself is unchanged — still
// `(elements, scene, options: SceneRendererOptions, loadFont = defaultLoadFont)`), the root
// SatoriNode's style gains the background:
const root: SatoriNode = {
  type: 'div',
  props: {
    style: {
      width: options.width, height: options.height, display: 'flex', position: 'relative',
      ...(options.background ? backgroundToCss(options.background) : {}),
    },
    children: elements.map((el) => elementNode(el, scene)).filter((node): node is SatoriNode => node !== null),
  },
};
```

Add a test asserting a gradient `background` renders without throwing
(mirrors Task 4's own gradient-text test, applied to the root instead of
one element's text).

- [ ] **Step 4: Write the failing `buildOverlay` tests**

```typescript
it('buildOverlay applies the track overlayOverride color to title/text elements and backgroundColor to the canvas', async () => {
  // construct a StreamManager the way this file's other tests already do, with a track that has
  // overlayOverride: { color: { mode: 'solid', color: '#ff0000' }, backgroundColor: { mode: 'solid', color: '#000000' } }
  // assert renderTemplatePng was called with: every title/text element's color replaced with
  // the override color (playlist/timer untouched), AND params.background === the override's
  // backgroundColor
});

it('buildOverlay passes no background and unmodified elements when overlayOverride is null', async () => {
  // same setup, overlayOverride: null — renderTemplatePng called with background: undefined and
  // elements exactly as the template defines
});

it('buildOverlay resolves image elements to on-disk paths via templateImageService.resolvePath', async () => {
  // a template with one 'image' element (assetId: 'asset-1') — assert renderTemplatePng was
  // called with imageAssets: { 'asset-1': <whatever the mocked templateImageService.resolvePath returned> }
});
```

Match this file's existing mocking style for `renderTemplatePng` (a jest
mock capturing call arguments) rather than inventing a new one.

- [ ] **Step 5: Implement `buildOverlay`'s changes**

```typescript
// src/stream/streamManager.ts — inside the buildOverlay closure, before calling renderTemplatePng
function applyOverlayOverride(elements: TemplateElement[], override: TrackOverlayOverride | null | undefined): TemplateElement[] {
  if (!override?.color) return elements;
  return elements.map((el) => ((el.type === 'title' || el.type === 'text') ? { ...el, color: override.color! } : el));
}

function resolveImageAssets(
  elements: TemplateElement[],
  templateImageService: Pick<TemplateImageService, 'resolvePath'>,
  userId: string,
  templateId: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const el of elements) {
    if (el.type === 'image') result[el.assetId] = templateImageService.resolvePath(userId, templateId, el.assetId);
  }
  return result;
}
```

Wire both into the existing `renderTemplatePng({...})` call inside
`buildOverlay` — pass `elements: applyOverlayOverride(bakedElements, track.overlayOverride)`
instead of the raw `bakedElements`, add
`imageAssets: resolveImageAssets(bakedElements, this.deps.templateImageService, destination.userId, options.templateId!)`,
and add `background: track.overlayOverride?.backgroundColor`. (Match the
surrounding function's real current variable names — `bakedElements`/
`destination`/`options.templateId` above are illustrative of the
mechanism given how much of this function Tasks 1-8 have already changed,
not a guaranteed literal match; the *shape* of what to pass is exact.)

- [ ] **Step 6: Wire `TemplateImageService` into `StreamManagerDeps`**

```typescript
// src/stream/streamManager.ts
import { TemplateImageService } from '../templates/templateImageService';

export interface StreamManagerDeps {
  // ...existing fields...
  templateImageService: Pick<TemplateImageService, 'resolvePath'>;
}
```

In `src/server.ts`, add `templateImageService,` to the `new StreamManager({...})`
construction — **reuse the exact same `templateImageService` instance
Task 6 already constructed** (declared earlier in that same file,
alongside `trackUploadService`), do not construct a second one.

- [ ] **Step 7: Extend `templateRoutes.ts`'s `/preview` handler — the second real render call site**

Read the handler's current body (Step 1) — it builds a `RenderOverlayParams`-
shaped object today with `elements`, `title`, `playlistLines`, `coverPath`,
`width`, `height`, `fontPath`, `fontFamily`. Add, using the same
`templateImageService` this file already received as `createTemplateRouter`'s
5th parameter (Task 6):

```typescript
const imageAssets: Record<string, string> = {};
for (const el of previewElements) {
  if (el.type === 'image') imageAssets[el.assetId] = templateImageService.resolvePath(owner, template.id, el.assetId);
}

const png = await renderTemplatePng({
  elements: previewElements,
  title: title ?? 'Sample Track',
  playlistLines: playlistLines ?? ['▶ Sample Track', '  Next Track'],
  coverPath,
  width: CANVAS_WIDTH,
  height: CANVAS_HEIGHT,
  fontPath: rendererDeps.fontPath,
  fontFamily: rendererDeps.fontFamily,
  imageAssets,
  // no `background` here — the preview endpoint has no concept of a per-track override (there's
  // no specific track being "played"), so it always shows the template's own look, matching
  // today's existing preview behavior for everything else.
});
```

Add a test: preview a draft with one `image` element and a mocked
`templateImageService.resolvePath`, assert `renderTemplatePng` (or, if
this test file mocks at the `renderViaPool`/HTTP-response level instead,
whatever the equivalent existing assertion style is) receives the
resolved path.

- [ ] **Step 8: Run tests, then the full suite and the build**

Run: `npx jest && npm run build`
Expected: PASS. The build check matters here for the same reason as Task
6 — this task touches `StreamManagerDeps`/`server.ts`'s construction
again.

- [ ] **Step 9: Commit**

```bash
git add src/stream/streamManager.ts src/render/sceneRenderer.ts src/render/renderOverlay.ts src/templates/templateRoutes.ts src/server.ts test/stream/streamManager.test.ts test/render/sceneRenderer.test.ts test/templates/templateRoutes.test.ts
git commit -m "feat: wire overlayOverride (color+background) and image elements into both the live-stream and preview render paths"
```

---

### Task 10: Frontend API client — templates, images, fonts, track override

**Files:**
- Modify: `frontend/src/api/templates.ts`, `frontend/src/api/tracks.ts`
- Test: extend the existing test files for both

**Interfaces:**
- Consumes: every backend route shape from Tasks 1, 6, 7, 8 exactly as
  specified there — including Task 8 Step 7c's addition of
  `overlayOverride` to `GET /tracks`'s response shape.
- Produces: TypeScript types + fetch wrappers Task 11/12 import directly —
  no task after this one talks to `fetch`/routes directly, only to these
  wrappers.

- [ ] **Step 1: Read both existing API client files completely first**

Match their existing conventions (error handling via `ApiError`, request
shape) exactly — do not introduce a second style.

- [ ] **Step 2: Extend `frontend/src/api/templates.ts`'s `TemplateElement` union**

Mirror the backend types from Task 1 exactly (`ColorValue`, `TextStyle`,
`TextElement`, `ImageElement`, extended `TitleElement`/`PlaylistElement`/
`TimerElement`) — this file already documents itself as "mirrors
`src/templates/templateTypes.ts` on the backend... kept in sync by hand"
(see `TemplateEditor.tsx`'s existing comment) — same discipline here.

Add:
```typescript
export async function uploadTemplateImage(templateId: string, file: File): Promise<{ assetId: string }> { /* ... */ }
export function templateImageUrl(templateId: string, assetId: string): string { /* returns the GET url */ }
export async function getFontFamilies(): Promise<string[]> { /* GET /templates/fonts */ }
```

- [ ] **Step 3: Extend `frontend/src/api/tracks.ts`**

Mirror `TrackOverlayOverride` from the backend (`src/tracks/trackRepository.ts`,
Task 8) — `{ color?: ColorValue; backgroundColor?: ColorValue }`, reusing
the `ColorValue` type this file (or `templates.ts`, wherever it's already
imported from for this frontend) defines per Step 2. **Add
`overlayOverride: TrackOverlayOverride | null` to this file's existing
`Track` type** — `GET /tracks` now returns it (Task 8, Step 7c) and
Task 12's override UI needs it to initialize its on/off toggle correctly;
this is a real, necessary field, not optional cleanup.

```typescript
export interface TrackOverlayOverride {
  color?: ColorValue;
  backgroundColor?: ColorValue;
}

// Track's existing fields (id, name, durationSeconds, hasCover, ...) unchanged, plus:
// overlayOverride: TrackOverlayOverride | null;

export async function updateTrackOverlayOverride(trackId: string, override: TrackOverlayOverride | null): Promise<void> { /* PATCH /tracks/{id} */ }
```

- [ ] **Step 4: Write/extend tests matching each file's existing test style**

- [ ] **Step 5: Run the frontend test suite**

Run: `cd frontend && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd frontend && git add src/api/templates.ts src/api/tracks.ts src/api/templates.test.ts src/api/tracks.test.ts
git commit -m "feat: frontend API client for template images, fonts, track overlay override"
```

---

### Task 11: `TemplateEditor.tsx` — text/image elements, extended properties panel

**Files:**
- Modify: `frontend/src/pages/TemplateEditor.tsx`
- Create: `frontend/src/components/TemplateFormFields.tsx`
- Modify: `frontend/src/i18n/locales/{en,ru,uk}.json` (new keys for every
  new label this task introduces — add them in all three files in the
  same commit, matching the existing key-naming convention already used
  for `templateEditor.*` keys)
- Test: extend `frontend/src/pages/TemplateEditor.test.tsx`, add
  `frontend/src/components/TemplateFormFields.test.tsx`

**Interfaces:**
- Consumes: `templatesApi` (Task 10), `TemplateElement`/`ColorValue` union (Task 10).
- Produces: `NumberField`/`ColorField`/`ColorValueField` exported from
  `frontend/src/components/TemplateFormFields.tsx` — Task 12 imports
  `ColorValueField` from here directly, does not reimplement it.

- [ ] **Step 1: Read the current file completely (already read once during
  brainstorming — re-read now, several things below assume its exact
  current structure: `defaultElement`, `displayWidth`/`displayHeight`,
  the properties panel's conditional rendering by `selected.type`).**

- [ ] **Step 2: Add `text`/`image` to `addElement`'s type list and `defaultElement`**

```typescript
case 'text':
  return { type: 'text', x: 100, y: 100, width: 400, fontSize: 24,
    text: t('templateEditor.defaultText'), // new i18n key
    color: { mode: 'solid', color: '#ffffff' },
    style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } };
case 'image':
  // handled specially — see Step 4, addElement does not call defaultElement for 'image'
```

- [ ] **Step 3: Extend `displayWidth`/`displayHeight` for the new types**

`text` behaves like `title` (has `width`, height derived from `fontSize`).
`image` behaves like `cover` (has both `width`/`height` directly).

- [ ] **Step 4: Image upload flow**

```typescript
const imageInputRef = useRef<HTMLInputElement>(null);
const uploadImageMutation = useMutation({
  mutationFn: (file: File) => templatesApi.uploadTemplateImage(templateId, file),
  onSuccess: ({ assetId }) => {
    setElements((els) => [...els, { type: 'image', x: 100, y: 100, width: 200, height: 200, assetId }]);
    setSelectedIndex(elements.length);
  },
  onError: (err) => toast.error(err instanceof ApiError ? err.message : t('templateEditor.imageUploadFailed')),
});

function onAddImageClick() { imageInputRef.current?.click(); }
function onImageFileChosen(e: ChangeEvent<HTMLInputElement>) {
  const file = e.target.files?.[0];
  if (file) uploadImageMutation.mutate(file);
  e.target.value = '';
}
```

Add the hidden input near the other add-element buttons:
```tsx
<input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/gif" className="hidden" onChange={onImageFileChosen} />
<button onClick={onAddImageClick}>{t('templateEditor.addElement', { type: t('templateEditor.elementType.image') })}</button>
```

(`'image'` is handled by this dedicated button, not folded into the
existing generic `(['cover','title','playlist','timer'] as const).map(...)`
loop, since it needs the upload side-effect before an element can exist at
all — `'text'` DOES fold into that generic loop, since it needs no upload.)

- [ ] **Step 5: Properties panel — font family, bold/italic, gradient toggle, stroke, shadow**

Add a `fontFamiliesQuery = useQuery({ queryKey: ['fontFamilies'], queryFn: templatesApi.getFontFamilies })`
near the top of the component. In the properties panel, for any element
with a `style`/`color: ColorValue` (i.e. `title`/`playlist`/`text`, and a
reduced version for `timer` — see below), add:

```tsx
{'style' in selected && (
  <>
    <label className="block text-xs text-gray-600">
      {t('templateEditor.fieldFontFamily')}
      <select value={selected.style.fontFamily} onChange={(e) => updateElement(selectedIndex!, { style: { ...selected.style, fontFamily: e.target.value } })} className="mt-1 w-full rounded border px-2 py-1 text-sm">
        {fontFamiliesQuery.data?.map((f) => <option key={f} value={f}>{f}</option>)}
      </select>
    </label>
    <div className="flex gap-2">
      <button onClick={() => updateElement(selectedIndex!, { style: { ...selected.style, bold: !selected.style.bold } })} className={selected.style.bold ? 'font-bold underline' : ''}>{t('templateEditor.bold')}</button>
      <button onClick={() => updateElement(selectedIndex!, { style: { ...selected.style, italic: !selected.style.italic } })} className={selected.style.italic ? 'italic underline' : ''}>{t('templateEditor.italic')}</button>
    </div>
    <label className="flex items-center gap-2 text-xs text-gray-600">
      <input
        type="checkbox"
        checked={selected.style.stroke !== undefined}
        onChange={(e) => updateElement(selectedIndex!, {
          style: { ...selected.style, stroke: e.target.checked ? { color: '#000000', width: 2 } : undefined },
        })}
      />
      {t('templateEditor.fieldStroke')}
    </label>
    {selected.style.stroke && (
      <>
        <ColorField label={t('templateEditor.fieldColor')} value={selected.style.stroke.color} onChange={(v) => updateElement(selectedIndex!, { style: { ...selected.style, stroke: { ...selected.style.stroke!, color: v } } })} />
        <NumberField label={t('templateEditor.fieldStrokeWidth')} value={selected.style.stroke.width} min={1} max={20} onChange={(v) => updateElement(selectedIndex!, { style: { ...selected.style, stroke: { ...selected.style.stroke!, width: v } } })} />
      </>
    )}
    <label className="flex items-center gap-2 text-xs text-gray-600">
      <input
        type="checkbox"
        checked={selected.style.shadow !== undefined}
        onChange={(e) => updateElement(selectedIndex!, {
          style: { ...selected.style, shadow: e.target.checked ? { color: '#000000', blur: 4, offsetX: 2, offsetY: 2 } : undefined },
        })}
      />
      {t('templateEditor.fieldShadow')}
    </label>
    {selected.style.shadow && (
      <>
        <ColorField label={t('templateEditor.fieldColor')} value={selected.style.shadow.color} onChange={(v) => updateElement(selectedIndex!, { style: { ...selected.style, shadow: { ...selected.style.shadow!, color: v } } })} />
        <NumberField label={t('templateEditor.fieldShadowBlur')} value={selected.style.shadow.blur} min={0} max={50} onChange={(v) => updateElement(selectedIndex!, { style: { ...selected.style, shadow: { ...selected.style.shadow!, blur: v } } })} />
        <NumberField label={t('templateEditor.fieldShadowOffsetX')} value={selected.style.shadow.offsetX} min={-50} max={50} onChange={(v) => updateElement(selectedIndex!, { style: { ...selected.style, shadow: { ...selected.style.shadow!, offsetX: v } } })} />
        <NumberField label={t('templateEditor.fieldShadowOffsetY')} value={selected.style.shadow.offsetY} min={-50} max={50} onChange={(v) => updateElement(selectedIndex!, { style: { ...selected.style, shadow: { ...selected.style.shadow!, offsetY: v } } })} />
      </>
    )}
  </>
)}
{(selected.type === 'title' || selected.type === 'playlist' || selected.type === 'text') && (
  <>
    <div className="flex gap-2 text-xs">
      <button
        onClick={() => updateElement(selectedIndex!, { color: { mode: 'solid', color: selected.color.mode === 'solid' ? selected.color.color : '#ffffff' } })}
        className={selected.color.mode === 'solid' ? 'font-semibold underline' : ''}
      >{t('templateEditor.colorModeSolid')}</button>
      <button
        onClick={() => updateElement(selectedIndex!, { color: { mode: 'gradient', stops: selected.color.mode === 'gradient' ? selected.color.stops : ['#ffffff', '#000000'], angleDeg: selected.color.mode === 'gradient' ? selected.color.angleDeg : 0 } })}
        className={selected.color.mode === 'gradient' ? 'font-semibold underline' : ''}
      >{t('templateEditor.colorModeGradient')}</button>
    </div>
    {selected.color.mode === 'solid' && (
      <ColorField label={t('templateEditor.fieldColor')} value={selected.color.color} onChange={(v) => updateElement(selectedIndex!, { color: { mode: 'solid', color: v } })} />
    )}
    {selected.color.mode === 'gradient' && (
      <>
        {selected.color.stops.map((stop, i) => (
          <ColorField
            key={i}
            label={t('templateEditor.fieldGradientStop', { n: i + 1 })}
            value={stop}
            onChange={(v) => {
              const stops = [...selected.color.stops] as [string, string] | [string, string, string];
              stops[i] = v;
              updateElement(selectedIndex!, { color: { mode: 'gradient', stops, angleDeg: (selected.color as { angleDeg: number }).angleDeg } });
            }}
          />
        ))}
        <NumberField label={t('templateEditor.fieldGradientAngle')} value={(selected.color as { angleDeg: number }).angleDeg} max={360} onChange={(v) => updateElement(selectedIndex!, { color: { ...selected.color, angleDeg: v } as ColorValue })} />
      </>
    )}
  </>
)}
{selected.type === 'timer' && (
  <ColorField label={t('templateEditor.fieldColor')} value={selected.color} onChange={(v) => updateElement(selectedIndex!, { color: v })} />
)}
```

Write this out in full in the actual file (the plan gives the mechanism
and the exact conditions; the implementer writes the complete JSX,
following this file's existing `NumberField`/`ColorField` component
patterns for every new field rather than inventing new input components).

**Extract the solid/gradient toggle block above into a shared component,
not a `TemplateEditor.tsx`-local one.** Today, `NumberField` and
`ColorField` are plain function components declared locally at the top of
`TemplateEditor.tsx` (module-private, not exported) — read the file's
current top section to confirm this before proceeding. Move both of them,
plus the new `ColorValueField`, into a new
`frontend/src/components/TemplateFormFields.tsx`:

```typescript
export function NumberField(/* exact current signature/body from TemplateEditor.tsx, moved as-is */) { /* ... */ }
export function ColorField(/* exact current signature/body from TemplateEditor.tsx, moved as-is */) { /* ... */ }
export function ColorValueField({ label, value, onChange }: { label: string; value: ColorValue; onChange: (v: ColorValue) => void }) {
  // exactly the solid/gradient toggle + fields JSX shown above (the button pair, the solid
  // ColorField, the gradient stops + angle), built on the ColorField/NumberField in this same file
}
```

`TemplateEditor.tsx` then imports all three from
`../components/TemplateFormFields` instead of defining `NumberField`/
`ColorField` itself. This is required, not optional polish — Task 12 (the
per-track override UI) needs the identical solid/gradient picker for
`overlayOverride.color`/`.backgroundColor`, and duplicating ~30 lines of
gradient-picker JSX (plus its two supporting field components) across two
files instead of sharing one module would be exactly the kind of
avoidable duplication this codebase's conventions argue against
elsewhere. Update `TemplateEditor.test.tsx` for the moved import path if
any test imports `NumberField`/`ColorField` directly rather than only
through the page component.

- [ ] **Step 6: `text` element's textarea for its literal content**

```tsx
{selected.type === 'text' && (
  <label className="block text-xs text-gray-600">
    {t('templateEditor.fieldText')}
    <textarea value={selected.text} onChange={(e) => updateElement(selectedIndex!, { text: e.target.value })} className="mt-1 w-full rounded border px-2 py-1 text-sm" />
  </label>
)}
```

- [ ] **Step 7: `image` element's thumbnail + replace-file control**

```tsx
{selected.type === 'image' && (
  <>
    <img src={templatesApi.templateImageUrl(templateId, selected.assetId)} alt="" className="w-full rounded border" />
    <button onClick={onAddImageClick}>{t('templateEditor.replaceImage')}</button>
    {/* replacing should upload a NEW assetId via the same mutation, then patch this element's
        assetId in place rather than appending a new element — track which index is "pending
        replace" so onImageFileChosen's mutation.onSuccess knows to updateElement instead of
        appending; the implementer designs this small piece of local state, it isn't prescribed
        further here */}
  </>
)}
```

- [ ] **Step 8: Add every new i18n key used above to all three locale files**

`templateEditor.defaultText`, `fieldFontFamily`, `bold`, `italic`,
`fieldStroke`, `fieldStrokeWidth`, `fieldShadow`, `fieldShadowBlur`,
`fieldShadowOffsetX`, `fieldShadowOffsetY`, `fieldText`, `replaceImage`,
`imageUploadFailed`, `elementType.text`, `elementType.image`,
`fieldGradientAngle`, `fieldGradientStop` (with an `{{n}}` interpolation
placeholder, matching the existing `addElement` key's `{{type}}` pattern),
`colorModeSolid`, `colorModeGradient` — English, then
Russian, then Ukrainian, matching the existing tone/style of each locale
file's current `templateEditor.*` entries (read all three before writing
the new ones, don't just translate the English ones through a single
pass without checking the existing files' conventions).

- [ ] **Step 9: Write/extend component tests**

Cover: adding a text element inserts it with default text; clicking "add
image" triggers the hidden file input; a successful upload appends an
image element with the returned `assetId`; selecting a title element shows
the font-family select populated from the (mocked) fonts query; toggling
gradient mode shows/hides the stop color fields; timer selection never
shows a gradient toggle.

- [ ] **Step 10: Run the frontend suite**

Run: `cd frontend && npx vitest run`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
cd frontend && git add src/pages/TemplateEditor.tsx src/pages/TemplateEditor.test.tsx src/components/TemplateFormFields.tsx src/components/TemplateFormFields.test.tsx src/i18n/locales
git commit -m "feat: text/image elements + typography/gradient/stroke/shadow controls in the template editor"
```

---

### Task 12: Per-track overlay override UI (Library page)

**Files:**
- Modify: `frontend/src/pages/Library.tsx` (or wherever a track's own
  edit/detail surface currently lives — read the file first, this plan
  doesn't assume its exact current shape since it wasn't touched by any
  prior task)
- Modify: `frontend/src/i18n/locales/{en,ru,uk}.json`
- Test: extend that page's existing test file

**Interfaces:**
- Consumes: `updateTrackOverlayOverride`, `TrackOverlayOverride` (Task 10),
  `ColorValueField` (Task 11's `frontend/src/components/TemplateFormFields.tsx`).

- [ ] **Step 1: Read `Library.tsx` and its test file completely first**

Confirm where/how a single track's own settings are currently exposed
(inline row controls, a drawer, a detail page) before deciding where this
new control fits — follow whatever pattern already exists rather than
introducing a new UI surface (e.g. a new drawer) if an existing per-track
edit affordance can just grow one more field.

- [ ] **Step 2: Add a small color-override control**

A compact form: an off/on toggle for `color` and, separately, for
`backgroundColor` — off means that field is absent from the
`TrackOverlayOverride` object entirely (not present, not an empty value);
on reveals `ColorValueField` (from `frontend/src/components/TemplateFormFields.tsx`,
Task 11 — import it directly, do not reimplement the solid/gradient
picker here). Sending `overlayOverride: null` (both toggles off) via
`updateTrackOverlayOverride` clears any existing override.

- [ ] **Step 3: Write component tests**

Cover: setting a solid override calls the API with the right shape;
clearing it sends `null`; a save failure shows a toast error (mirror
whatever error-toast pattern this page's other mutations already use).

- [ ] **Step 4: Add the new i18n keys to all three locale files**

- [ ] **Step 5: Run the frontend suite**

Run: `cd frontend && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd frontend && git add <the files this task actually touched> src/i18n/locales
git commit -m "feat: per-track overlay color/background override UI"
```

---

## Final Verification (after all 12 tasks)

- [ ] Full backend suite: `npx jest` — all green.
- [ ] Backend build: `npm run build` — clean.
- [ ] Frontend suite: `cd frontend && npx vitest run` — all green.
- [ ] Frontend build: `cd frontend && npm run build` — clean.
- [ ] Real-binary smoke test (per this project's established discipline —
  see [[feedback-verify-against-real-binaries]]): create a template with
  at least one gradient title, one stroke+shadow playlist, one bold-italic
  text element, and one uploaded PNG-with-transparency image element;
  render it via `/templates/{id}/preview` against the real deployed
  container; inspect the resulting PNG by eye, not just "didn't throw."
- [ ] Deploy to the 192.168.14.26 demo stand (per CLAUDE.md's established
  git-archive+scp workflow) and re-verify the preview + a live track
  switch showing a per-track override, end to end.
