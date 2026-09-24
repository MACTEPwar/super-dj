# Playlist window marquee Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The currently-playing track's row in the on-screen playlist window scrolls like a
continuous-loop marquee whenever its name doesn't fit, while every other row stays a static,
ellipsis-truncated single line.

**Architecture:** A new dedicated raw-pixel pipe (`pipe:8`) into the one persistent, never-
restarted ffmpeg encoder, fed by a `MarqueeFeeder` that renders the current row's full text
through Satori **once per track switch** (not per frame) into a padded strip, then produces each
output frame by cropping and compositing a moving slice of that strip — pure byte copies, no
Satori/resvg call on the per-frame path. Mirrors the existing `pipe:7`/`PlaylistWindowFeeder`
shape throughout.

**Tech Stack:** TypeScript/Node, Satori + `@resvg/resvg-js` (rendering), `@shuding/opentype.js`
(text-width measurement), `piscina` (worker pool), Jest.

**Spec:** `docs/superpowers/specs/2026-09-24-playlist-marquee-truncation-design.md`

## Global Constraints

- Every row in `playlistWindowNode` (`src/render/sceneRenderer.ts`) is single-line, ellipsis-
  truncated (`overflow:hidden; white-space:nowrap; text-overflow:ellipsis; maxWidth:el.width`) —
  already implemented; do not re-derive it.
- `measureTextWidth` (`src/render/textWidth.ts`) is the one source of truth for "does this text
  fit" — real glyph-advance measurement via `@shuding/opentype.js`, already implemented.
- The marquee lives entirely inside `PersistentEncoder`'s own filter graph via a new pipe — never
  a per-track-switch ffmpeg restart, never a live `drawtext` expression (ruled out in the spec:
  `overlay`'s position cannot change at runtime in this ffmpeg build, and the row's Y is not
  session-constant).
- `MARQUEE_SPEED_PX_PER_SEC = 80` — fixed, not user-configurable.
- Row geometry (height) is **measured**, never estimated — `computePlaylistWindowRegion`'s
  `ROW_HEIGHT_BOUND_FACTOR` is a generous *bound* for a different purpose and must not be reused
  for exact row positioning.
- Every yuva420p byte-level utility (`rgbaToYuva420p`, `blitYuva420p`) requires even width/height/
  offsets — round with `floorEven`/`ceilEven` at the call site, never inside `overlay` (ffmpeg
  itself is never asked to move anything at runtime here).
- Follow this codebase's fake-child/fake-repository testing convention (`Spawner`/
  `ChildProcessLike` fakes, no real ffmpeg spawn in unit tests) — see CLAUDE.md's "Testing
  strategy".

## Review Focus

- **A track name that is EXACTLY the row's width, to the pixel.** `measureTextWidth(...) <=
  el.width` must not flap between activating and not activating for a name that just barely fits —
  Task 9's tests pin `<=` (fits, no marquee) vs a text one unit wider (marquee).
- **Two rapid track switches, the second overflowing while the first is still resolving
  `resolveMarqueeRow`/`activate`.** A user hammering "next" must never leave a stale marquee
  active for a track that's no longer current, nor leave `currentRowOverrideText` blanking a row
  that no longer needs it — Task 10's generation-guard tests pin this.
- **A template with a playlist element but the CURRENT track's row not found in `windowRows` at
  all** (defensive — `PlaylistQueue.windowSnapshot()` always includes the current row today, but a
  future caller could pass an empty array). Task 10 pins that `feedCurrentTrack` deactivates the
  marquee and never throws when `rows.findIndex(r => r.isCurrent)` is `-1`.
- **`stopCurrent`/`teardown` while a marquee's strip render is still in flight.** Mirrors the
  established `close()`-during-`showRows()` race `PlaylistWindowFeeder` already guards — Task 7
  pins that a strip render resolving after `close()` never writes to the pipe.
- **A template whose playlist element has `fontSize`/font so small that `measureRowHeight`'s
  2-row probe renders the two rows touching (zero-height gap) or the ink bands merge into one.**
  Task 2 pins that a too-small gap still yields two distinct bands, using a real render with a
  realistic fontSize (this is a real-render test, not a synthetic pixel array, so the ink layout
  is whatever Satori/resvg actually produce).

---

## Task 1: Commit Part A (single-line truncation + text-width measurement — already implemented)

This task exists because Part A of the spec was already implemented and tested in an earlier
session but never committed. Confirm it, then commit it as its own clean baseline before any new
work in this plan touches the same files.

**Files:** (already present on disk, uncommitted)
- `src/render/sceneRenderer.ts` (per-row ellipsis truncation)
- `src/render/textWidth.ts` (new)
- `src/render/shuding-opentype.d.ts` (new)
- `test/render/playlistWindowNode.test.ts`
- `test/render/textWidth.test.ts` (new)
- `package.json`, `package-lock.json` (`@shuding/opentype.js` added as a direct dependency)

**Interfaces:**
- Produces: `measureTextWidth(text: string, family: string, bold: boolean, italic: boolean,
  fontSize: number, loadFont?): Promise<number>` (`src/render/textWidth.ts`) — every later task
  that needs "does this text fit" uses this, unmodified.

- [ ] **Step 1: Confirm the working tree state**

Run: `git status --porcelain`
Expected: the files listed above show as modified/untracked, nothing else.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS, all suites (this codebase was at 969 passing tests before this plan; confirm the
count matches or exceeds that — a lower count means something regressed since Part A landed).

- [ ] **Step 3: Type-check the whole project**

Run: `npm run build`
Expected: exits 0, no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/render/sceneRenderer.ts src/render/textWidth.ts src/render/shuding-opentype.d.ts test/render/playlistWindowNode.test.ts test/render/textWidth.test.ts package.json package-lock.json
git commit -m "fix(render): truncate every playlist-window row to one line with ellipsis

Add measureTextWidth (real glyph-advance measurement via @shuding/opentype.js,
pinned to satori's own dependency version) as the foundation for the marquee
feature that follows."
```

---

## Task 2: `measureRowHeight` — real, measured row height

**Files:**
- Create: `src/render/rowHeight.ts`
- Test: `test/render/rowHeight.test.ts`

**Interfaces:**
- Consumes: `renderPlaylistWindowPixels` (`src/render/sceneRenderer.ts`, existing), `settledRows`
  (`src/ffmpeg/playlistWindowTransition.ts`, existing), `PlaylistElement`
  (`src/templates/templateTypes.ts`, existing).
- Produces: `measureRowHeight(element: PlaylistElement, loadFont?: (family: string, bold:
  boolean, italic: boolean) => Promise<Buffer>): Promise<number>` — used by Task 9
  (`streamScene.ts`'s `resolveMarqueeRow`).

- [ ] **Step 1: Write the failing tests**

Create `test/render/rowHeight.test.ts`:

```typescript
import * as fs from 'fs';
import { measureRowHeight } from '../../src/render/rowHeight';

// Cross-platform note: production's default font loader only knows hardcoded Linux paths — same
// convention as every other test under test/render/.
const FONT_CANDIDATES = [
  'C:\\Windows\\Fonts\\arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
];
function findFontPath(): string {
  for (const candidate of FONT_CANDIDATES) if (fs.existsSync(candidate)) return candidate;
  throw new Error(`No test font found — tried: ${FONT_CANDIDATES.join(', ')}`);
}
const testFontPath = findFontPath();
async function testLoadFont(_family: string, _bold: boolean, _italic: boolean): Promise<Buffer> {
  return fs.promises.readFile(testFontPath);
}

const el = (fontSize: number) => ({
  type: 'playlist' as const, x: 0, y: 0, width: 300, fontSize,
  color: { mode: 'solid' as const, color: '#ffffff' },
  style: { fontFamily: 'DejaVu Sans', bold: false, italic: false },
});

it('measures a real, positive row height, roughly proportional to fontSize', async () => {
  const height = await measureRowHeight(el(20), testLoadFont);
  expect(height).toBeGreaterThan(0);
  // Real fonts land around 1.1-1.3x fontSize for a natural CSS line-height — a generous band,
  // not a hardcoded exact value, since this is a REAL render and different fonts vary slightly.
  expect(height).toBeGreaterThan(20);
  expect(height).toBeLessThan(40);
});

it('a larger fontSize measures a larger row height', async () => {
  const small = await measureRowHeight(el(16), testLoadFont);
  const large = await measureRowHeight(el(32), testLoadFont);
  expect(large).toBeGreaterThan(small);
});

it('caches by (fontFamily, bold, italic, fontSize) — a second call for the same style does not re-render', async () => {
  let calls = 0;
  const countingLoadFont = async (_f: string, _b: boolean, _i: boolean): Promise<Buffer> => {
    calls++;
    return fs.promises.readFile(testFontPath);
  };
  await measureRowHeight(el(24), countingLoadFont);
  const after1 = calls;
  await measureRowHeight(el(24), countingLoadFont);
  expect(calls).toBe(after1);
});

it('a distinct fontSize is measured independently (not served from another size\'s cache entry)', async () => {
  const h18 = await measureRowHeight(el(18), testLoadFont);
  const h19 = await measureRowHeight(el(19), testLoadFont);
  // Not asserting a specific relationship beyond "both are real, positive, independently
  // measured" — real font hinting can make adjacent sizes round to the same integer height.
  expect(h18).toBeGreaterThan(0);
  expect(h19).toBeGreaterThan(0);
});

it('a very small fontSize still yields two distinct ink bands, not a merged one', async () => {
  // A real render at a small size: proportional line-height still leaves a real gap between two
  // rows for any real font, but this is exactly the case most likely to merge if that assumption
  // were ever wrong (rounding, tight leading) — a real render, not a synthetic pixel array, is
  // what actually proves it, per this codebase's "verify against real binaries" convention.
  const height = await measureRowHeight(el(8), testLoadFont);
  expect(height).toBeGreaterThan(0);
  expect(height).toBeLessThan(20);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/render/rowHeight.test.ts`
Expected: FAIL with "Cannot find module '../../src/render/rowHeight'".

- [ ] **Step 3: Implement**

Create `src/render/rowHeight.ts`:

```typescript
import { PlaylistElement } from '../templates/templateTypes';
import { renderPlaylistWindowPixels } from './sceneRenderer';
import { settledRows } from '../ffmpeg/playlistWindowTransition';

// Cached by the four things that actually change a font's own line-height — never by anything
// per-session (x/y/width don't affect it). A distinct playlist element sharing the same style
// reuses this entry for free.
const cache = new Map<string, number>();

function cacheKey(element: PlaylistElement): string {
  return `${element.style.fontFamily}|${element.style.bold}|${element.style.italic}|${element.fontSize}`;
}

// Contiguous vertical bands of non-transparent pixels, top to bottom. Two rows of identical text
// at the same size produce two bands whose START-to-START distance is exactly the flex column's
// per-row allocated height (line-height), regardless of glyph-specific ink shape — see the design
// spec's "Row geometry: measured once, not estimated".
function inkBands(pixels: Uint8Array, width: number, height: number): Array<{ first: number }> {
  const bands: Array<{ first: number }> = [];
  let inBand = false;
  for (let y = 0; y < height; y += 1) {
    let hasInk = false;
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3] > 0) { hasInk = true; break; }
    }
    if (hasInk && !inBand) bands.push({ first: y });
    inBand = hasInk;
  }
  return bands;
}

/**
 * The real, rendered pixel height of one row in this playlist element's own font/size — measured
 * once via a real Satori+resvg render (two rows of representative text, both ascenders and
 * descenders present via 'Ag'), not estimated. Used to compute the current row's exact Y position
 * for the marquee layer (see src/ffmpeg/marqueeFeeder.ts) — every row shares this same height,
 * since sceneRenderer.ts's per-row ellipsis truncation forces every row in one playlist element to
 * a single line at the element's own fontSize.
 */
export async function measureRowHeight(
  element: PlaylistElement,
  loadFont?: (family: string, bold: boolean, italic: boolean) => Promise<Buffer>,
): Promise<number> {
  const key = cacheKey(element);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const probeWidth = Math.max(40, Math.ceil(element.fontSize * 3));
  const probeHeight = Math.ceil(element.fontSize * 6);
  const region = { x: 0, y: 0, width: probeWidth, height: probeHeight, originX: 0, originY: 0 };
  const probeElement: PlaylistElement = { ...element, x: 0, y: 0, width: probeWidth };
  const rows = settledRows([
    { key: 'a', text: 'Ag', isCurrent: false },
    { key: 'b', text: 'Ag', isCurrent: false },
  ]);
  const { pixels, width, height } = await renderPlaylistWindowPixels({ element: probeElement, rows, region }, loadFont);
  const bands = inkBands(pixels, width, height);
  if (bands.length < 2) {
    throw new Error(`measureRowHeight: expected 2 ink bands for a 2-row probe, found ${bands.length}`);
  }
  const rowHeight = bands[1].first - bands[0].first;
  cache.set(key, rowHeight);
  return rowHeight;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/render/rowHeight.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/render/rowHeight.ts test/render/rowHeight.test.ts
git commit -m "feat(render): measure a playlist row's real rendered height

Two-row probe render + ink-band detection, cached by font style — the
marquee layer (next tasks) needs the CURRENT row's exact Y position, and
the existing ROW_HEIGHT_BOUND_FACTOR estimate in playlistWindowGeometry.ts
is a deliberately generous bound for a different purpose, not exact."
```

---

## Task 3: `renderMarqueeStripPixels` — the one-shot wide-strip render

**Files:**
- Modify: `src/render/sceneRenderer.ts`
- Test: `test/render/sceneRenderer.test.ts`

**Interfaces:**
- Consumes: `satori`, `Resvg`, `collectFontVariants`, `textStyleToCss`, `defaultLoadFont` (all
  already in `sceneRenderer.ts`), `PlaylistElement`.
- Produces: `MarqueeStripFrameRequest` type and `renderMarqueeStripPixels(req:
  MarqueeStripFrameRequest, loadFont?): Promise<{ pixels: Uint8Array; width: number; height:
  number }>` — consumed by Task 5's worker.

- [ ] **Step 1: Write the failing test**

Add to `test/render/sceneRenderer.test.ts`, inside a new `describe` block (after the existing
`describe('renderScene — gradient colors', ...)` block, so it's a top-level sibling):

```typescript
describe('renderMarqueeStripPixels', () => {
  const el = { type: 'playlist' as const, x: 0, y: 0, width: 100, fontSize: 20, color: { mode: 'solid' as const, color: '#ffffff' }, style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } };

  it('renders the full text (no ellipsis) into a strip of the requested size, straight (non-premultiplied-looking) alpha somewhere non-zero', async () => {
    const { renderMarqueeStripPixels } = await import('../../src/render/sceneRenderer');
    const { pixels, width, height } = await renderMarqueeStripPixels(
      { element: el, text: 'A Rather Long Track Name That Would Never Fit In One Row', stripWidth: 800, rowHeight: 30 },
      testLoadFont,
    );
    expect(width).toBe(800);
    expect(height).toBe(30);
    expect(pixels.length).toBe(800 * 30 * 4);
    expect(pixels.some((v, i) => i % 4 === 3 && v > 0)).toBe(true);
  });

  it('a short text still renders without throwing, mostly transparent in a wide strip', async () => {
    const { renderMarqueeStripPixels } = await import('../../src/render/sceneRenderer');
    const { pixels } = await renderMarqueeStripPixels(
      { element: el, text: 'Hi', stripWidth: 400, rowHeight: 30 },
      testLoadFont,
    );
    const opaqueCount = pixels.filter((v, i) => i % 4 === 3 && v > 0).length;
    // Two short glyphs in a 400-wide strip: opaque pixels are a small minority.
    expect(opaqueCount).toBeGreaterThan(0);
    expect(opaqueCount).toBeLessThan(400 * 30 * 0.2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/render/sceneRenderer.test.ts -t "renderMarqueeStripPixels"`
Expected: FAIL — `renderMarqueeStripPixels` is not exported.

- [ ] **Step 3: Implement**

In `src/render/sceneRenderer.ts`, add after the existing `renderPlaylistWindowPixels` function
(end of file):

```typescript
export interface MarqueeStripFrameRequest {
  element: PlaylistElement;
  text: string;
  stripWidth: number;
  rowHeight: number;
}

// A single row's FULL text (no ellipsis, no wrap constraint) rendered into a fixed-size strip —
// the one-shot Satori/resvg render MarqueeFeeder uses to build the source bitmap it crops per
// frame for the current track's marquee (see src/ffmpeg/marqueeFeeder.ts and the design spec's
// "Chosen approach: pre-rendered text strip + per-frame crop"). Called ONCE per marquee
// activation, never per frame. The caller sizes stripWidth generously around the text's own
// measured width (measureTextWidth) plus the row's own width on both sides — this render's own
// width doesn't need to be pixel-exact, any extra blank space is harmless.
export async function renderMarqueeStripPixels(
  req: MarqueeStripFrameRequest,
  loadFont: (family: string, bold: boolean, italic: boolean) => Promise<Buffer> = defaultLoadFont,
): Promise<{ pixels: Uint8Array; width: number; height: number }> {
  const { element, text, stripWidth, rowHeight } = req;
  const variants = collectFontVariants([element]);
  const fonts = await Promise.all(variants.map(async (v) => ({
    name: v.family, data: await loadFont(v.family, v.bold, v.italic),
    weight: (v.bold ? 700 : 400) as 400 | 700, style: (v.italic ? 'italic' : 'normal') as 'italic' | 'normal',
  })));
  const root: SatoriNode = {
    type: 'div',
    props: {
      style: {
        width: stripWidth, height: rowHeight, display: 'flex', position: 'relative',
        whiteSpace: 'nowrap', fontSize: element.fontSize,
        ...textStyleToCss(element.style, element.color),
      },
      children: text,
    },
  };
  const svg = await satori(root as unknown as Parameters<typeof satori>[0], { width: stripWidth, height: rowHeight, fonts });
  const pixmap = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
  return { pixels: pixmap.pixels, width: pixmap.width, height: pixmap.height };
}
```

`testLoadFont` in `test/render/sceneRenderer.test.ts` is already defined at the top of that file
(same file, existing) — no import changes needed in the test beyond the inline dynamic imports
shown (kept local to the new `describe` block so the new functions don't need adding to the
file's top-level `import { renderScene, gradientCss } from ...` line, though adding them there
directly is equally correct if preferred).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/render/sceneRenderer.test.ts`
Expected: PASS, all tests in the file (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/render/sceneRenderer.ts test/render/sceneRenderer.test.ts
git commit -m "feat(render): add renderMarqueeStripPixels — one-shot wide-strip text render

The marquee's per-frame path never calls Satori; this is the once-per-
activation render whose output MarqueeFeeder crops for every frame."
```

---

## Task 4: `blitYuva420p` — composite a small yuva420p frame into a larger one

**Files:**
- Modify: `src/render/yuva420p.ts`
- Test: `test/render/yuva420p.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `blitYuva420p(dest: Buffer, destWidth: number, destHeight: number, src: Buffer,
  srcWidth: number, srcHeight: number, x: number, y: number): void` — consumed by Task 7's
  `MarqueeFeeder`.

- [ ] **Step 1: Write the failing test**

Add to `test/render/yuva420p.test.ts`:

```typescript
import { rgbaToYuva420p, transparentYuva420p, yuva420pFrameSize, blitYuva420p } from '../../src/render/yuva420p';

// (existing describe block above is unchanged; add this as a sibling describe)
describe('blitYuva420p', () => {
  it('copies a small yuva420p frame\'s Y/U/V/A planes into a sub-rectangle of a larger one, at an even offset', () => {
    const dest = transparentYuva420p(4, 4); // Y=16 x16, U=V=128 x4, A=0 x16
    const px = (r: number, g: number, b: number, a: number) => Uint8Array.from([r, g, b, a, r, g, b, a, r, g, b, a, r, g, b, a]);
    const src = rgbaToYuva420p(px(255, 255, 255, 255), 2, 2); // Y=235 x4, U=V=128 x1, A=255 x4

    blitYuva420p(dest, 4, 4, src, 2, 2, 2, 2); // bottom-right 2x2 quadrant

    // Y plane: 4x4, row-major. Rows 2-3, cols 2-3 should now be 235; everything else stays 16.
    const y = (x: number, yy: number) => dest[yy * 4 + x];
    expect(y(2, 2)).toBe(235);
    expect(y(3, 2)).toBe(235);
    expect(y(2, 3)).toBe(235);
    expect(y(3, 3)).toBe(235);
    expect(y(0, 0)).toBe(16);
    expect(y(1, 3)).toBe(16);

    // A plane: dest's A plane starts at offset 16 (Y) + 4 (U) + 4 (V) = 24.
    const aOff = 16 + 4 + 4;
    expect(dest[aOff + 2 * 4 + 2]).toBe(255);
    expect(dest[aOff + 0]).toBe(0);

    // U/V planes: dest is 4x4 -> chroma is 2x2 (offsets 16 for U, 20 for V). The blit's own
    // chroma is 1x1 (src is 2x2), placed at chroma position (1,1) of dest's 2x2 chroma plane.
    expect(dest[16 + 1 * 2 + 1]).toBe(128); // U
    expect(dest[20 + 1 * 2 + 1]).toBe(128); // V
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/render/yuva420p.test.ts`
Expected: FAIL — `blitYuva420p` is not exported.

- [ ] **Step 3: Implement**

In `src/render/yuva420p.ts`, add at the end of the file:

```typescript
// Copies a smaller yuva420p frame's Y/U/V/A planes into a sub-rectangle of a larger one, in
// place. x/y/srcWidth/srcHeight must all be even — this is a raw plane copy at the same 2x2
// chroma-subsampling grid both buffers already share (see rgbaToYuva420p above), so an odd
// offset would misalign the chroma planes exactly the way an odd ffmpeg `overlay` position does
// (see GIF_OVERLAY_FORMAT in persistentEncoderArgs.ts) — except here nothing catches it, so
// callers (MarqueeFeeder) round their own coordinates before calling this.
export function blitYuva420p(
  dest: Buffer, destWidth: number, destHeight: number,
  src: Buffer, srcWidth: number, srcHeight: number,
  x: number, y: number,
): void {
  const destYSize = destWidth * destHeight;
  const destCw = destWidth / 2;
  const destCSize = destCw * (destHeight / 2);
  const destUOff = destYSize;
  const destVOff = destYSize + destCSize;
  const destAOff = destYSize + 2 * destCSize;

  const srcYSize = srcWidth * srcHeight;
  const srcCw = srcWidth / 2;
  const srcCSize = srcCw * (srcHeight / 2);
  const srcUOff = srcYSize;
  const srcVOff = srcYSize + srcCSize;
  const srcAOff = srcYSize + 2 * srcCSize;

  for (let sy = 0; sy < srcHeight; sy += 1) {
    src.copy(dest, (y + sy) * destWidth + x, sy * srcWidth, sy * srcWidth + srcWidth);
    src.copy(dest, destAOff + (y + sy) * destWidth + x, srcAOff + sy * srcWidth, srcAOff + sy * srcWidth + srcWidth);
  }
  const cx = x / 2;
  const cy = y / 2;
  for (let scy = 0; scy < srcHeight / 2; scy += 1) {
    src.copy(dest, destUOff + (cy + scy) * destCw + cx, srcUOff + scy * srcCw, srcUOff + scy * srcCw + srcCw);
    src.copy(dest, destVOff + (cy + scy) * destCw + cx, srcVOff + scy * srcCw, srcVOff + scy * srcCw + srcCw);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/render/yuva420p.test.ts`
Expected: PASS, all tests (existing + 1 new).

- [ ] **Step 5: Commit**

```bash
git add src/render/yuva420p.ts test/render/yuva420p.test.ts
git commit -m "feat(render): add blitYuva420p — composite a small yuva420p frame into a larger one

Used by MarqueeFeeder to place a cropped marquee slice into a region-sized
frame without a full-region rgbaToYuva420p conversion every tick."
```

---

## Task 5: `playlistWindowRenderWorker`/`Pool` — route the strip render off the main thread

**Files:**
- Modify: `src/render/playlistWindowRenderWorker.ts`
- Modify: `src/render/playlistWindowRenderPool.ts`
- Test: `test/render/playlistWindowRenderWorker.test.ts`
- Test: `test/render/playlistWindowRenderPool.test.ts`

**Interfaces:**
- Consumes: `renderMarqueeStripPixels`, `MarqueeStripFrameRequest` (Task 3),
  `unpremultiplyRgbaInPlace` (existing).
- Produces: named export `renderMarqueeStrip(task: MarqueeStripFrameRequest): Promise<Uint8Array>`
  (worker-side) and `renderMarqueeStripFrame(req: MarqueeStripFrameRequest): Promise<Buffer>`
  (pool wrapper, main-thread-facing) — consumed by Task 7's `MarqueeFeeder`. Returns **straight
  RGBA**, not yuva420p — `MarqueeFeeder` crops per frame in RGBA space and converts only the small
  cropped slice, not the whole wide strip.

- [ ] **Step 1: Write the failing tests**

Add to `test/render/playlistWindowRenderWorker.test.ts` (the file already mocks
`../../src/render/sceneRenderer` for `renderPlaylistWindowPixels` — extend that same mock to also
cover `renderMarqueeStripPixels`, and import the new named export):

```typescript
jest.mock('../../src/render/sceneRenderer', () => ({
  // 2x2 opaque white, premultiplied (= straight for alpha 255)
  renderPlaylistWindowPixels: jest.fn().mockResolvedValue({ pixels: new Uint8Array(Array(16).fill(255)), width: 2, height: 2 }),
  renderMarqueeStripPixels: jest.fn().mockResolvedValue({ pixels: new Uint8Array(Array(16).fill(255)), width: 2, height: 2 }),
}));
import render, { renderMarqueeStrip } from '../../src/render/playlistWindowRenderWorker';

it('unpremultiplies and converts to a yuva420p frame of 2.5*w*h bytes', async () => {
  const frame = await render({ element: {} as any, rows: [], region: { x: 0, y: 0, width: 2, height: 2, originX: 0, originY: 0 } });
  expect(frame.length).toBe(10);
  expect([frame[0], frame[4], frame[5], frame[6]]).toEqual([235, 128, 128, 255]);
});

it('renderMarqueeStrip unpremultiplies but returns STRAIGHT RGBA (4 bytes/pixel), not yuva420p', async () => {
  const strip = await renderMarqueeStrip({ element: {} as any, text: 'x', stripWidth: 2, rowHeight: 2 });
  expect(strip.length).toBe(16); // 2*2*4
  expect(strip[3]).toBe(255); // alpha preserved
});
```

Add to `test/render/playlistWindowRenderPool.test.ts` (extend the existing file — same mocked
`piscina`):

```typescript
import { renderPlaylistWindowFrame, renderMarqueeStripFrame } from '../../src/render/playlistWindowRenderPool';

// (existing describe('renderPlaylistWindowFrame (pool wrapper)', ...) block stays as-is; add
// this as a new top-level describe in the same file)
describe('renderMarqueeStripFrame (pool wrapper)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('routes through the same pool, named "renderMarqueeStrip"', async () => {
    runMock.mockResolvedValue(new Uint8Array(16));
    const req: any = { element: {}, text: 'x', stripWidth: 2, rowHeight: 2 };
    await renderMarqueeStripFrame(req);
    expect(runMock.mock.calls[0][0]).toBe(req);
    expect(runMock.mock.calls[0][1].name).toBe('renderMarqueeStrip');
    expect(runMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('returns a real Buffer', async () => {
    runMock.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    const result = await renderMarqueeStripFrame({ element: {}, text: 'x', stripWidth: 1, rowHeight: 1 } as any);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(4);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/render/playlistWindowRenderWorker.test.ts test/render/playlistWindowRenderPool.test.ts`
Expected: FAIL — `renderMarqueeStrip`/`renderMarqueeStripFrame` are not exported.

- [ ] **Step 3: Implement**

Replace `src/render/playlistWindowRenderWorker.ts` in full:

```typescript
import { renderPlaylistWindowPixels, renderMarqueeStripPixels, PlaylistWindowFrameRequest, MarqueeStripFrameRequest } from './sceneRenderer';
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

// A second, named export sharing this same worker file (and so this same pool — see
// playlistWindowRenderPool.ts) rather than a third pool: a marquee activation is roughly as
// infrequent as a canvas re-render, not the ~20-renders-per-second-during-a-burst shape pipe:7's
// own pool exists to isolate. Returns STRAIGHT RGBA, not yuva420p — MarqueeFeeder converts only
// the small cropped slice it actually needs each frame, not the whole wide strip.
export async function renderMarqueeStrip(task: MarqueeStripFrameRequest): Promise<Uint8Array> {
  const { pixels } = await renderMarqueeStripPixels(task);
  const straight = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  unpremultiplyRgbaInPlace(straight);
  // A plain view rewrap for the postMessage boundary — this returns straight RGBA, not yuva420p
  // (unlike the default export above), so there's no conversion call needing width/height.
  return new Uint8Array(straight.buffer, straight.byteOffset, straight.byteLength);
}
```

Modify `src/render/playlistWindowRenderPool.ts` — add after the existing
`renderPlaylistWindowFrame` function:

```typescript
import { PlaylistWindowFrameRequest, MarqueeStripFrameRequest } from './sceneRenderer';
// (add MarqueeStripFrameRequest to the existing import line from './sceneRenderer' rather than a
// second import statement)

export async function renderMarqueeStripFrame(req: MarqueeStripFrameRequest): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  try {
    const result: Uint8Array = await getPool().run(req, { signal: controller.signal, name: 'renderMarqueeStrip' });
    return Buffer.from(result.buffer, result.byteOffset, result.byteLength);
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/render/playlistWindowRenderWorker.test.ts test/render/playlistWindowRenderPool.test.ts`
Expected: PASS, all tests (existing + new).

- [ ] **Step 5: Run the full build**

Run: `npm run build`
Expected: exits 0 (this task's worker file is compiled to `dist/render/playlistWindowRenderWorker.js`, which piscina resolves by filename at runtime).

- [ ] **Step 6: Commit**

```bash
git add src/render/playlistWindowRenderWorker.ts src/render/playlistWindowRenderPool.ts test/render/playlistWindowRenderWorker.test.ts test/render/playlistWindowRenderPool.test.ts
git commit -m "feat(render): route the marquee strip render through the pipe:7 worker pool

Shares the existing small pool (playlistWindowRenderPool.ts) via a second
named export — a marquee activation is canvas-re-render-frequency work,
not burst-frequency work, so it doesn't need its own pool."
```

---

## Task 6: `ChildProcessWithPipes.marqueePipe` — the pipe:8 plumbing

**Files:**
- Modify: `src/ffmpeg/types.ts`
- Modify: `src/server.ts`
- Modify: `test/ffmpeg/persistentEncoder.test.ts`

**Interfaces:**
- Produces: `ChildProcessWithPipes.marqueePipe: NodeJS.WritableStream` — consumed by Task 10
  (`streamController.ts`).

No new automated test for the pipe-spawner wiring itself — `createPipeSpawner` spawns a REAL
child process and is exercised only by real-binary verification (Task 11), matching this
codebase's existing convention (see CLAUDE.md's "Testing strategy": ffmpeg is always a fake in
unit tests, and `createPipeSpawner`/`createSpawner` themselves have no dedicated fake-based test
today either). This task DOES need one small fixture fix (Step 3 below), found during the plan's
own pre-flight scan: `ChildProcessWithPipes` is a strictly-typed interface, and
`test/ffmpeg/persistentEncoder.test.ts`'s `fakeChild()` helper returns a literal typed exactly as
`ChildProcessWithPipes & {...}` — adding a new required field to the interface without also
adding it to that literal fails `npm run build`, not `npm test` (a missing-property error, not a
runtime failure), so it would otherwise go unnoticed until Task 6's own build step below.

- [ ] **Step 1: Modify `src/ffmpeg/types.ts`**

Add to the `ChildProcessWithPipes` interface, after the existing `playlistWindowPipe` field:

```typescript
  // The current-track marquee layer (fd 8) — see MarqueeFeeder. Same "always present, sometimes
  // written" arrangement as pulsePipe/playlistWindowPipe above.
  readonly marqueePipe: NodeJS.WritableStream;
```

- [ ] **Step 2: Modify `src/server.ts`**

In `createPipeSpawner()`:

1. Change the `stdio` array (line ~75) from
   `{ stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'] }` to
   `{ stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'] }` (one
   more `'pipe'` entry).
2. After the existing `const playlistWindowPipe = stdio[7];` line, add:
   ```typescript
   const marqueePipe = stdio[8];
   ```
3. After the existing `playlistWindowPipe.on('error', ...)` line, add:
   ```typescript
   marqueePipe.on('error', (err) => { console.error('marquee pipe write error', err); });
   ```
4. Change the final `return Object.assign(...)` line's object literal from
   `{ videoPipe, audioPipe, pulsePipe, aboveCanvasPipe, playlistWindowPipe }` to
   `{ videoPipe, audioPipe, pulsePipe, aboveCanvasPipe, playlistWindowPipe, marqueePipe }`.

Also update the comment above the `stdio:` line (currently says "fd3/fd4/fd5/fd6/fd7 are the
video/audio/pulse/above-canvas/playlist-window pipes") to read "fd3/fd4/fd5/fd6/fd7/fd8 are the
video/audio/pulse/above-canvas/playlist-window/marquee pipes".

- [ ] **Step 3: Modify `test/ffmpeg/persistentEncoder.test.ts`**

`ChildProcessWithPipes` is now missing a required field from this file's `fakeChild()` helper's
return type. Add one line to it, right after the existing `playlistWindowPipe: new
PassThrough(),` line:

```typescript
    marqueePipe: new PassThrough(),
```

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS — `test/stream/streamController.test.ts`'s `encoderChild` fixture doesn't reference
`types.ts` directly (it's a plain object literal), so this change alone doesn't break it; Task 10
below is what adds `marqueePipe: {}` to that fixture, since only `streamController.ts` (Task 10)
starts reading `child.marqueePipe`.

- [ ] **Step 5: Run the full build**

Run: `npm run build`
Expected: exits 0 (`tsc -p tsconfig.json`, the authoritative whole-project type check; ts-jest's
own default config also type-checks each file it runs, so Step 4 above already exercised Step 3's
fix — this step confirms the rest of the project, outside test files, is equally clean).

- [ ] **Step 6: Commit**

```bash
git add src/ffmpeg/types.ts src/server.ts test/ffmpeg/persistentEncoder.test.ts
git commit -m "feat(ffmpeg): add pipe:8 (marqueePipe) to the persistent encoder's pipe set

Wiring only — nothing writes to it yet until MarqueeFeeder/streamController
(next tasks) attach a real feeder."
```

---

## Task 7: `MarqueeFeeder` — the pipe:8 frame player

**Files:**
- Create: `src/ffmpeg/marqueeFeeder.ts`
- Test: `test/ffmpeg/marqueeFeeder.test.ts`

**Interfaces:**
- Consumes: `RawFramePacer` (`src/ffmpeg/rawFramePacer.ts`, existing, unmodified),
  `transparentYuva420p`/`rgbaToYuva420p`/`blitYuva420p` (Task 4 + existing),
  `renderMarqueeStripFrame` (Task 5), `PlaylistWindowRegion` (existing), `PlaylistElement`
  (existing).
- Produces: `MarqueeFeeder` class, `MarqueeRowRect` interface, `MARQUEE_SPEED_PX_PER_SEC` constant
  — consumed by Task 9 (`streamScene.ts`'s `createMarqueeFeeder`) and Task 10
  (`streamController.ts`'s `MarqueeFeederLike`).

- [ ] **Step 1: Write the failing tests**

Create `test/ffmpeg/marqueeFeeder.test.ts`:

```typescript
import { EventEmitter } from 'events';
import { MarqueeFeeder } from '../../src/ffmpeg/marqueeFeeder';

const REGION = { x: 100, y: 50, width: 20, height: 10, originX: 0, originY: 0 };
const ELEMENT: any = { type: 'playlist', x: 100, y: 50, width: 20, fontSize: 8, color: { mode: 'solid', color: '#fff' }, style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } };
// The row rect sits inside the region at (0,0) offset (element.x/y == region.x/y here), 20x10.
const RECT = { x: 100, y: 50, width: 20, height: 10 };

function fakePipe() {
  const pipe: any = new EventEmitter();
  pipe.writes = [] as Buffer[];
  pipe.write = (b: Buffer) => { pipe.writes.push(b); return true; };
  return pipe;
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function fakeStrip(stripWidth: number, height: number): Buffer {
  // Opaque red everywhere, so every crop is trivially detectable (alpha=255, R=200).
  const buf = Buffer.alloc(stripWidth * height * 4);
  for (let i = 0; i < buf.length; i += 4) { buf[i] = 200; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 255; }
  return buf;
}

function setup() {
  jest.useFakeTimers();
  const clock = { ms: 0 };
  const renderCalls: any[] = [];
  const renderStrip = jest.fn(async (element: any, text: string, stripWidth: number, rowHeight: number) => {
    renderCalls.push({ element, text, stripWidth, rowHeight });
    return fakeStrip(stripWidth, rowHeight);
  });
  const feeder = new MarqueeFeeder({ element: ELEMENT, region: REGION, fps: 30, renderStrip, nowMs: () => clock.ms });
  const pipe = fakePipe();
  const advance = async (ms: number) => { for (let t = 0; t < ms; t += 10) { clock.ms += 10; jest.advanceTimersByTime(10); await flush(); } };
  return { feeder, pipe, renderStrip, renderCalls, advance, clock };
}

// dest's alpha plane offset for a WxH yuva420p frame: Y (W*H) + U (W/2*H/2) + V (W/2*H/2).
function alphaAt(frame: Buffer, width: number, height: number, x: number, y: number): number {
  const ySize = width * height;
  const cSize = (width / 2) * (height / 2);
  return frame[ySize + 2 * cSize + y * width + x];
}

describe('MarqueeFeeder', () => {
  afterEach(() => jest.useRealTimers());

  it('idle: writes the transparent region frame from attach(), no strip renders', async () => {
    const { feeder, pipe, renderStrip, advance } = setup();
    feeder.attach(pipe);
    await advance(200);
    expect(pipe.writes.length).toBeGreaterThanOrEqual(5);
    const f = pipe.writes[0];
    expect(f.length).toBe(2.5 * REGION.width * REGION.height);
    expect(alphaAt(f, REGION.width, REGION.height, 5, 5)).toBe(0);
    expect(renderStrip).not.toHaveBeenCalled();
    feeder.close();
  });

  it('activate() renders the strip once, sized around 2*rowWidth + textWidth, and subsequent frames are opaque within the row rect', async () => {
    const { feeder, pipe, renderCalls, advance } = setup();
    feeder.attach(pipe);
    await feeder.activate('a long track name', RECT, 100); // estimatedTextWidth 100
    await advance(50);
    expect(renderCalls.length).toBe(1);
    expect(renderCalls[0].text).toBe('a long track name');
    // stripWidth = floorEven(2*20 + ceil(100) + 2) = floorEven(142) = 142
    expect(renderCalls[0].stripWidth).toBe(142);
    expect(renderCalls[0].rowHeight).toBe(10);

    const last = pipe.writes[pipe.writes.length - 1];
    // Row rect is the whole region here (0,0 offset, 20x10) — some pixel inside it must now be
    // opaque, where the idle frame was fully transparent.
    expect(alphaAt(last, REGION.width, REGION.height, 5, 5)).toBe(255);
    feeder.close();
  });

  it('the visible crop moves over time (motion), and wraps back to fully-blank at the loop boundary', async () => {
    const { feeder, pipe, advance, clock } = setup();
    feeder.attach(pipe);
    await feeder.activate('x', RECT, 40); // small strip: stripWidth = floorEven(2*20+40+2) = 102, textPlusBox = 82
    // At t=0 (just activated), cropX=0 -> the crop window shows the STRIP's own leading blank
    // region (transparent), matching the "about to enter" reveal state.
    await advance(10);
    const atStart = pipe.writes[pipe.writes.length - 1];
    expect(alphaAt(atStart, REGION.width, REGION.height, 5, 5)).toBe(0);
    // Well into the loop (but not past it: 82px / 80px/s ≈ 1.025s), the crop has moved onto the
    // opaque text region.
    await advance(500);
    const mid = pipe.writes[pipe.writes.length - 1];
    expect(alphaAt(mid, REGION.width, REGION.height, 5, 5)).toBe(255);
    feeder.close();
  });

  it('deactivate() returns to fully transparent and stops further motion', async () => {
    const { feeder, pipe, advance } = setup();
    feeder.attach(pipe);
    await feeder.activate('x', RECT, 40);
    await advance(500);
    feeder.deactivate();
    await advance(50);
    const last = pipe.writes[pipe.writes.length - 1];
    expect(alphaAt(last, REGION.width, REGION.height, 5, 5)).toBe(0);
    feeder.close();
  });

  it('a strip render resolving after deactivate()/close() never becomes active (generation guard)', async () => {
    const { feeder, pipe, advance } = setup();
    let resolveStrip!: (b: Buffer) => void;
    (feeder as any).options.renderStrip = jest.fn(() => new Promise<Buffer>((r) => { resolveStrip = r; }));
    feeder.attach(pipe);
    const activating = feeder.activate('x', RECT, 40);
    await advance(10);
    feeder.close();
    resolveStrip(fakeStrip(102, 10));
    await activating;
    await advance(50);
    // Nothing but the idle frame was ever written after close().
    expect(pipe.writes.every((f: Buffer) => alphaAt(f, REGION.width, REGION.height, 5, 5) === 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/ffmpeg/marqueeFeeder.test.ts`
Expected: FAIL — `Cannot find module '../../src/ffmpeg/marqueeFeeder'`.

- [ ] **Step 3: Implement**

Create `src/ffmpeg/marqueeFeeder.ts`:

```typescript
import { RawFramePacer } from './rawFramePacer';
import { transparentYuva420p, rgbaToYuva420p, blitYuva420p } from '../render/yuva420p';
import { PlaylistWindowRegion } from '../render/playlistWindowGeometry';
import { PlaylistElement } from '../templates/templateTypes';
import { renderMarqueeStripFrame } from '../render/playlistWindowRenderPool';

// The spike's own value (real local ffmpeg, visually confirmed smooth and readable) — see the
// design spec. Not user-configurable in this iteration.
export const MARQUEE_SPEED_PX_PER_SEC = 80;

const floorEven = (n: number) => Math.floor(n / 2) * 2;

export interface MarqueeRowRect { x: number; y: number; width: number; height: number }

export interface MarqueeFeederOptions {
  element: PlaylistElement;
  region: PlaylistWindowRegion;
  fps: number;
  renderStrip?: (element: PlaylistElement, text: string, stripWidth: number, rowHeight: number) => Promise<Buffer>;
  nowMs?: () => number;
}

interface ActiveMarquee {
  stripRgba: Buffer;
  stripWidth: number;
  rect: MarqueeRowRect; // already floored to even
  activatedAtMs: number;
}

function extractRgbaSlice(strip: Buffer, stripWidth: number, height: number, offsetX: number, width: number): Buffer {
  const out = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const srcStart = (row * stripWidth + offsetX) * 4;
    strip.copy(out, row * width * 4, srcStart, srcStart + width * 4);
  }
  return out;
}

/**
 * The pipe:8 frame player for the current track's marquee. Unlike PlaylistWindowFeeder, there is
 * no per-frame Satori/resvg render: activate() renders the row's FULL text once into a wide,
 * padded strip (see src/render/sceneRenderer.ts's renderMarqueeStripPixels), and every tick after
 * that just crops a moving window out of that strip and composites it into a region-sized
 * transparent yuva420p frame — plain byte copies. See the design spec's "Chosen approach:
 * pre-rendered text strip + per-frame crop" for why.
 */
export class MarqueeFeeder {
  private readonly pacer: RawFramePacer;
  private readonly nowMs: () => number;
  private readonly idleFrame: Buffer;
  private generation = 0;
  private closed = false;
  private tickTimer: NodeJS.Timeout | null = null;
  private active: ActiveMarquee | null = null;

  constructor(private readonly options: MarqueeFeederOptions) {
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

  // estimatedTextWidth: the caller's own measureTextWidth() result for `text` — sizes the strip
  // generously; doesn't need to be pixel-exact (see renderMarqueeStripPixels's doc comment).
  async activate(text: string, rect: MarqueeRowRect, estimatedTextWidth: number): Promise<void> {
    const generation = ++this.generation;
    const evenRect: MarqueeRowRect = {
      x: floorEven(rect.x), y: floorEven(rect.y),
      width: floorEven(rect.width), height: floorEven(rect.height),
    };
    const stripWidth = floorEven(2 * evenRect.width + Math.ceil(estimatedTextWidth) + 2);
    const renderStrip = this.options.renderStrip
      ?? ((el, t, w, h) => renderMarqueeStripFrame({ element: el, text: t, stripWidth: w, rowHeight: h }));
    const stripRgba = await renderStrip(this.options.element, text, stripWidth, evenRect.height);
    if (this.closed || generation !== this.generation) return;
    this.active = { stripRgba, stripWidth, rect: evenRect, activatedAtMs: this.nowMs() };
  }

  deactivate(): void {
    this.generation += 1;
    this.active = null;
    this.pacer.setFrame(this.idleFrame);
  }

  close(): void {
    this.deactivate();
    this.closed = true;
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    this.pacer.detach();
  }

  private tick(): void {
    try {
      if (this.active) this.pacer.setFrame(this.composeFrame(this.active));
      this.pacer.writeDueFrames();
    } catch (err) {
      // A bare setInterval callback: an uncaught throw would kill every tenant's stream.
      console.error('marquee tick failed', err);
    }
  }

  private composeFrame(active: ActiveMarquee): Buffer {
    const { rect, stripRgba, stripWidth, activatedAtMs } = active;
    const textPlusBox = stripWidth - rect.width;
    const elapsedSec = Math.max(0, (this.nowMs() - activatedAtMs) / 1000);
    const cropX = Math.floor((elapsedSec * MARQUEE_SPEED_PX_PER_SEC) % textPlusBox);
    const slice = extractRgbaSlice(stripRgba, stripWidth, rect.height, cropX, rect.width);
    const sliceYuva = rgbaToYuva420p(slice, rect.width, rect.height);
    const frame = Buffer.from(this.idleFrame);
    blitYuva420p(
      frame, this.options.region.width, this.options.region.height,
      sliceYuva, rect.width, rect.height,
      rect.x - this.options.region.x, rect.y - this.options.region.y,
    );
    return frame;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/ffmpeg/marqueeFeeder.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ffmpeg/marqueeFeeder.ts test/ffmpeg/marqueeFeeder.test.ts
git commit -m "feat(ffmpeg): add MarqueeFeeder — the pipe:8 frame player

Renders the current row's text once per activation, crops a moving window
out of it every tick with plain byte copies. No Satori/resvg call on the
per-frame path."
```

---

## Task 8: `persistentEncoderArgs.ts` — declare and composite pipe:8

**Files:**
- Modify: `src/ffmpeg/persistentEncoderArgs.ts`
- Test: `test/ffmpeg/persistentEncoderArgs.test.ts`

**Interfaces:**
- Consumes: nothing new (reuses the existing `playlistWindow` region shape).
- Produces: `buildPersistentEncoderArgs`'s new optional `marquee?: { x: number; y: number; width:
  number; height: number; fps: number }` parameter — consumed by Task 9
  (`streamScene.ts`'s `createPersistentEncoder`).

- [ ] **Step 1: Write the failing tests**

Add to `test/ffmpeg/persistentEncoderArgs.test.ts`, as a new `describe` block placed right after
the existing `describe('playlist window burst layer (pipe:7)', ...)` block closes:

```typescript
  describe('current-track marquee layer (pipe:8)', () => {
    const base = { width: 1280, height: 720, fps: 30, heartbeatFps: 5, rtmpUrl: 'rtmp://h/live', streamKey: 'k', backgroundPath: '/bg.png' };
    const PW = { x: 510, y: 158, width: 704, height: 342, fps: 30, layer: 'top' as const };
    const MQ = { x: 510, y: 158, width: 704, height: 342, fps: 30 };
    const graphOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1];

    it('absent unless configured: args byte-identical to today', () => {
      expect(buildPersistentEncoderArgs({ ...base, playlistWindow: PW })).toEqual(buildPersistentEncoderArgs({ ...base, playlistWindow: PW, marquee: undefined }));
      expect(buildPersistentEncoderArgs({ ...base, playlistWindow: PW }).join(' ')).not.toContain('pipe:8');
    });

    it('declares pipe:8 as yuva420p at its own fps, right after pipe:7', () => {
      const args = buildPersistentEncoderArgs({ ...base, playlistWindow: PW, marquee: MQ });
      const i7 = args.indexOf('pipe:7');
      const i8 = args.indexOf('pipe:8');
      expect(args.slice(i8 - 9, i8 + 1)).toEqual(['-f', 'rawvideo', '-pix_fmt', 'yuva420p', '-s', '704x342', '-r', '30', '-i', 'pipe:8']);
      expect(i8).toBeGreaterThan(i7);
      expect(args.lastIndexOf('-i')).toBe(i8 - 1);
    });

    it('composites right after the playlist window stage, before the equalizer', () => {
      const g = graphOf(buildPersistentEncoderArgs({ ...base, playlistWindow: PW, marquee: MQ, equalizer: { x: 0, y: 600, width: 400, height: 100 } }));
      // inputs: 0 canvas, 1 audio, 2 bg, 3 pulse, 4 playlist window, 5 marquee
      expect(g).toContain('[4:v]format=yuva420p[plwin]');
      expect(g).toContain('[vcanvas_top][plwin]overlay=510:158[vplwin]');
      expect(g).toContain('[5:v]format=yuva420p[mqwin]');
      expect(g).toContain('[vplwin][mqwin]overlay=510:158[vmqwin]');
      expect(g).toContain('[vmqwin][pulse]overlay=0:600[vout]');
    });

    it('is absent when playlistWindow itself is absent, even if marquee were somehow passed', () => {
      const withoutPW = buildPersistentEncoderArgs({ ...base, marquee: MQ });
      expect(withoutPW.join(' ')).not.toContain('pipe:8');
      expect(withoutPW).toEqual(buildPersistentEncoderArgs({ ...base }));
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/ffmpeg/persistentEncoderArgs.test.ts -t "current-track marquee"`
Expected: FAIL — `marquee` param has no effect yet (no `pipe:8` in output).

- [ ] **Step 3: Implement**

In `src/ffmpeg/persistentEncoderArgs.ts`:

1. Add a new exported type, right after `PlaylistWindowLayerConfig`:

```typescript
// The current-track marquee layer (MarqueeFeeder, pipe:8) — reuses the SAME region
// playlistWindow does (computePlaylistWindowRegion), since the marquee's own row position is
// decided by Node per-frame within that region, not by this filter graph. Present only when the
// template has a playlist element (same gate as playlistWindow) AND the current track's own name
// overflows its row — see streamScene.ts's resolveMarqueeRow.
export type MarqueeLayerConfig = { x: number; y: number; width: number; height: number; fps: number };
```

2. Add `marquee?: MarqueeLayerConfig;` to `buildPersistentEncoderArgs`'s `params` object type,
   right after the existing `playlistWindow?: PlaylistWindowLayerConfig;` line.

3. Destructure it in the function body: change
   `const { width, height, fps, heartbeatFps, rtmpUrl, streamKey, backgroundPath, equalizer, gifOverlays = [], canvasPlacement = 'top', playlistWindow } = params;`
   to
   `const { width, height, fps, heartbeatFps, rtmpUrl, streamKey, backgroundPath, equalizer, gifOverlays = [], canvasPlacement = 'top', playlistWindow, marquee } = params;`

4. Add a new input index, right after the existing `playlistWindowInputIndex` line:

```typescript
  // Appended after the playlist-window input, so declaring the marquee's own burst layer never
  // renumbers anything declared before it.
  const marqueeInputIndex = playlistWindowInputIndex + (playlistWindow ? 1 : 0);
```

5. Add the new input declaration, right after the existing `playlistWindow ? [...] : []` array
   spread in the `inputs` array (i.e. as the LAST entry of `inputs`, after the playlist-window
   block):

```typescript
    // The current-track marquee layer (MarqueeFeeder). Present only when the template has a
    // playlist element AND a marquee config was resolved for it — see streamScene.ts. Gated on
    // BOTH marquee and playlistWindow (not marquee alone): the marquee composites relative to
    // videoPad AFTER compositePlaylistWindow() has run (step 6 below), and its input index is
    // computed relative to playlistWindowInputIndex — neither is meaningful without a real
    // playlist-window layer underneath it. Declared last, same non-renumbering reason as the
    // playlist-window input above.
    ...(marquee && playlistWindow
      ? ['-f', 'rawvideo', '-pix_fmt', 'yuva420p', '-s', `${marquee.width}x${marquee.height}`, '-r', String(marquee.fps), '-i', 'pipe:8']
      : []),
```

6. Add the compositing stage. Right after the existing block:
   ```typescript
   if (playlistWindow && (playlistWindow.layer === 'top' || canvasPlacement === 'top')) compositePlaylistWindow();
   ```
   add:
   ```typescript
   if (marquee && playlistWindow) {
     filterLines.push(`[${marqueeInputIndex}:v]format=yuva420p[mqwin]`);
     filterLines.push(`[${videoPad}][mqwin]overlay=${marquee.x}:${marquee.y}[vmqwin]`);
     videoPad = 'vmqwin';
   }
   ```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/ffmpeg/persistentEncoderArgs.test.ts`
Expected: PASS, all tests in the file (existing + 4 new).

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/ffmpeg/persistentEncoderArgs.ts test/ffmpeg/persistentEncoderArgs.test.ts
git commit -m "feat(ffmpeg): declare and composite pipe:8 (marquee) right above pipe:7

Reuses playlistWindow's own region — the marquee's exact row position is
decided by Node per frame, not by this filter graph's overlay position."
```

---

## Task 9: `streamScene.ts` — wire `resolveMarqueeRow`, `createMarqueeFeeder`, `currentRowOverrideText`

**Files:**
- Modify: `src/stream/streamScene.ts`
- Test: `test/stream/streamScene.test.ts`

**Interfaces:**
- Consumes: `measureTextWidth` (Task 1), `measureRowHeight` (Task 2), `MarqueeFeeder`,
  `MarqueeRowRect` (Task 7), `buildPersistentEncoderArgs`'s new `marquee` param (Task 8).
- Produces: `StreamScene.createMarqueeFeeder?: () => MarqueeFeeder`, `StreamScene
  .resolveMarqueeRow?: (currentRowText: string, rowIndex: number) => Promise<{ rect:
  MarqueeRowRect; textWidth: number } | null>`, and `buildOverlay`'s new
  `currentRowOverrideText?: string` opt — consumed by Task 10 (`streamController.ts`).

- [ ] **Step 1: Write the failing tests**

`measureTextWidth`/`measureRowHeight` do REAL font file I/O by default (same as
`renderTemplatePng`, which this file already avoids exercising for real via a whole-module
`jest.mock`) — so these two also need whole-module mocks, added to the existing mock block at the
top of the file (do NOT mock `renderMarqueeStripPixels`/`sceneRenderer.ts` here — `streamScene.ts`
never calls those directly, only `measureTextWidth`/`measureRowHeight`/`MarqueeFeeder`'s own
constructor, none of which touch a font file at construction time).

Add these two `jest.mock(...)` calls at the top of `test/stream/streamScene.test.ts`, as two more
statements alongside the existing three (`duration`/`imageFrameCount`/`renderOverlay`) — each
`jest.mock` call is its own top-level statement, not a shared object:

```typescript
jest.mock('../../src/render/textWidth', () => ({ measureTextWidth: jest.fn() }));
jest.mock('../../src/render/rowHeight', () => ({ measureRowHeight: jest.fn() }));
```

And add these two imports alongside the file's existing `import { renderTemplatePng } from
'../../src/render/renderOverlay';` line:

```typescript
import { measureTextWidth } from '../../src/render/textWidth';
import { measureRowHeight } from '../../src/render/rowHeight';
```

Then add a new `describe` block, as a sibling of the existing `describe('buildStreamScene —
playlist window burst layer (pipe:7)', ...)` block, reusing that block's own `playlistEl`/`style`/
`encoderArgs` helpers (copy them into this new block exactly as they're defined there, or hoist
them to file scope if the existing block doesn't already export them — either is fine as long as
both blocks end up using the identical helper shapes):

```typescript
describe('buildStreamScene — current-track marquee', () => {
  const style = { fontFamily: 'DejaVu Sans', bold: false, italic: false };
  const playlistEl = (x: number, y: number) => ({ type: 'playlist', x, y, width: 400, fontSize: 20, color: { mode: 'solid', color: '#ffffff' }, style });
  const titleEl = { type: 'title', x: 0, y: 0, width: 100, fontSize: 20, color: { mode: 'solid', color: '#ffffff' }, style };
  const ROWS = [{ key: 'b:0', text: '▶ a', isCurrent: true }, { key: 'b:1', text: '  b', isCurrent: false }];

  beforeEach(() => {
    jest.clearAllMocks();
    (renderTemplatePng as jest.Mock).mockResolvedValue(Buffer.from('fake-png'));
    (getImageFrameCount as jest.Mock).mockResolvedValue(1);
  });

  it('resolveMarqueeRow returns null at exactly the element width (the <= boundary, not flapping)', async () => {
    (measureTextWidth as jest.Mock).mockResolvedValue(400); // exactly playlistEl's own width, 400
    const { deps, templateRepository } = buildDeps();
    templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [playlistEl(10, 10)] });
    const scene = await buildStreamScene(deps, { ...params, templateId: 'tpl-1' });
    const result = await scene.resolveMarqueeRow!('▶ a', 0);
    expect(result).toBeNull();
    expect(measureRowHeight).not.toHaveBeenCalled();
  });

  it('resolveMarqueeRow activates one unit past the element width (the > boundary)', async () => {
    (measureTextWidth as jest.Mock).mockResolvedValue(401); // one unit past playlistEl's width, 400
    (measureRowHeight as jest.Mock).mockResolvedValue(26);
    const { deps, templateRepository } = buildDeps();
    templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [playlistEl(10, 10)] });
    const scene = await buildStreamScene(deps, { ...params, templateId: 'tpl-1' });
    const result = await scene.resolveMarqueeRow!('▶ a', 0);
    expect(result).not.toBeNull();
    expect(result!.textWidth).toBe(401);
  });

  it('resolveMarqueeRow returns a rect + textWidth when the measured text width overflows', async () => {
    (measureTextWidth as jest.Mock).mockResolvedValue(500); // wider than playlistEl's width, 400
    (measureRowHeight as jest.Mock).mockResolvedValue(26);
    const { deps, templateRepository } = buildDeps();
    templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [playlistEl(10, 10)] });
    const scene = await buildStreamScene(deps, { ...params, templateId: 'tpl-1' });
    const result = await scene.resolveMarqueeRow!('▶ a much longer name', 2);
    expect(result).toEqual({ rect: { x: 10, y: 10 + 2 * 26, width: 400, height: 26 }, textWidth: 500 });
  });

  it('createMarqueeFeeder is present exactly when createPlaylistWindowFeeder is', async () => {
    const { deps, templateRepository } = buildDeps();
    templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [playlistEl(10, 10)] });
    const withPlaylist = await buildStreamScene(deps, { ...params, templateId: 'tpl-1' });
    expect(withPlaylist.createMarqueeFeeder).toBeDefined();
    expect(withPlaylist.resolveMarqueeRow).toBeDefined();

    templateRepository.findById.mockResolvedValue({ id: 'tpl-2', userId: 'user-1', elements: [titleEl] });
    const withoutPlaylist = await buildStreamScene(deps, { ...params, templateId: 'tpl-2' });
    expect(withoutPlaylist.createMarqueeFeeder).toBeUndefined();
    expect(withoutPlaylist.createPlaylistWindowFeeder).toBeUndefined();
    expect(withoutPlaylist.resolveMarqueeRow).toBeUndefined();
  });

  it("buildOverlay with currentRowOverrideText replaces only the isCurrent row's text before rendering", async () => {
    const { deps } = buildDeps();
    const scene = await buildStreamScene(deps, params);
    const rows = [
      { key: 'b:0', text: '  before', isCurrent: false },
      { key: 'b:1', text: '▶ the real long name', isCurrent: true },
    ];
    await scene.buildOverlay(scene.tracks[0], rows, { currentRowOverrideText: '▶' });
    const call = (renderTemplatePng as jest.Mock).mock.calls[0][0];
    expect(call.playlistLines).toEqual(['  before', '▶']);
  });

  it('buildOverlay without currentRowOverrideText renders the real row text, unchanged', async () => {
    const { deps } = buildDeps();
    const scene = await buildStreamScene(deps, params);
    await scene.buildOverlay(scene.tracks[0], ROWS);
    const call = (renderTemplatePng as jest.Mock).mock.calls[0][0];
    expect(call.playlistLines).toEqual(['▶ a', '  b']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/stream/streamScene.test.ts -t "marquee"`
Expected: FAIL — `resolveMarqueeRow`/`createMarqueeFeeder` undefined, `currentRowOverrideText` has
no effect.

- [ ] **Step 3: Implement**

In `src/stream/streamScene.ts`:

1. Add imports at the top:

```typescript
import { measureTextWidth } from '../render/textWidth';
import { measureRowHeight } from '../render/rowHeight';
import { MarqueeFeeder, MarqueeRowRect } from '../ffmpeg/marqueeFeeder';
```

2. In the `StreamScene` interface, change `buildOverlay`'s type and add the two new fields:

```typescript
  buildOverlay: (track: Track, windowRows: WindowRow[], opts?: { omitLivePlaylist?: boolean; currentRowOverrideText?: string }) => Promise<NowPlayingOverlay>;
  createCanvasFeeder: () => CanvasFeeder;
  createAudioRelay: () => AudioRelay;
  createPersistentEncoder: (target: RtmpTarget) => PersistentEncoder;
  createPulseVisualizer?: () => PulseVisualizer;
  createPlaylistWindowFeeder?: () => PlaylistWindowFeeder;
  // Present only when the template has an on-canvas playlist element — same gate as
  // createPlaylistWindowFeeder.
  createMarqueeFeeder?: () => MarqueeFeeder;
  // Given the current row's own rendered text (already prefixed "▶ ...") and its index within the
  // window, decides whether it overflows the playlist element's width and, if so, its exact rect
  // plus the measured text width (MarqueeFeeder.activate's own sizing hint). Returns null when it
  // fits. Absent when the template has no playlist element.
  resolveMarqueeRow?: (currentRowText: string, rowIndex: number) => Promise<{ rect: MarqueeRowRect; textWidth: number } | null>;
```

3. Inside `buildOverlay`, change:
   ```typescript
   const playlistLines = windowRowLines(windowRows);
   ```
   to:
   ```typescript
   const effectiveRows = opts.currentRowOverrideText !== undefined
     ? windowRows.map((r) => (r.isCurrent ? { ...r, text: opts.currentRowOverrideText! } : r))
     : windowRows;
   const playlistLines = windowRowLines(effectiveRows);
   ```
   and change the `opts` parameter's own type annotation from
   `opts: { omitLivePlaylist?: boolean } = {}` to
   `opts: { omitLivePlaylist?: boolean; currentRowOverrideText?: string } = {}`.

4. After the existing `livePlaylist` computation (the block ending in `: null;`), add:

```typescript
  const resolveMarqueeRow = livePlaylist
    ? async (currentRowText: string, rowIndex: number): Promise<{ rect: MarqueeRowRect; textWidth: number } | null> => {
        const el = livePlaylist.element;
        const textWidth = await measureTextWidth(currentRowText, el.style.fontFamily, el.style.bold, el.style.italic, el.fontSize);
        if (textWidth <= el.width) return null;
        const rowHeight = await measureRowHeight(el);
        return {
          rect: { x: el.x, y: el.y + rowIndex * rowHeight, width: el.width, height: rowHeight },
          textWidth,
        };
      }
    : undefined;
```

5. In the returned object, add (right after `createPlaylistWindowFeeder: ...`):

```typescript
    createMarqueeFeeder: livePlaylist
      ? () => new MarqueeFeeder({ element: livePlaylist.element, region: livePlaylist.region, fps: PLAYLIST_WINDOW_FPS })
      : undefined,
    resolveMarqueeRow,
```

6. In `createPersistentEncoder`'s call to `new PersistentEncoder({...})`, pass the marquee layer
   config too. Change the existing `playlistWindow: livePlaylist ? {...} : undefined,` block to
   also add, right after it:

```typescript
      marquee: livePlaylist
        ? { x: livePlaylist.region.x, y: livePlaylist.region.y, width: livePlaylist.region.width, height: livePlaylist.region.height, fps: PLAYLIST_WINDOW_FPS }
        : undefined,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/stream/streamScene.test.ts`
Expected: PASS, all tests in the file (existing + new).

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/stream/streamScene.ts test/stream/streamScene.test.ts
git commit -m "feat(stream): wire resolveMarqueeRow/createMarqueeFeeder into buildStreamScene

buildOverlay gains currentRowOverrideText, used to blank the current row's
baked text while the marquee layer supplies it live."
```

---

## Task 10: `streamController.ts` — activate/deactivate the marquee on every track switch

**Files:**
- Modify: `src/stream/streamController.ts`
- Test: `test/stream/streamController.test.ts`

**Interfaces:**
- Consumes: `MarqueeRowRect` (Task 7), `StreamScene.createMarqueeFeeder`/`resolveMarqueeRow`
  (Task 9).
- Produces: `MarqueeFeederLike` interface — this is the terminal task; nothing else consumes its
  output.

- [ ] **Step 1: Write the failing tests**

First, update the shared `buildDeps()` fixture at the top of `test/stream/streamController.test.ts`:
change `const encoderChild = { videoPipe: {}, audioPipe: {}, pulsePipe: {}, aboveCanvasPipe: {}, playlistWindowPipe: {} };`
to add `marqueePipe: {}` to that object literal (this is required for the EXISTING tests to keep
passing once `streamController.ts` starts reading `child.marqueePipe` unconditionally — see Task 6's
"always present on the child" comment).

Then add a new `describe` block, as a sibling of the existing `describe('playlist window burst
layer', ...)` block:

```typescript
  describe('current-track marquee', () => {
    function withMarquee() {
      const ctx = buildDeps();
      const marqueeFeeder = { attach: jest.fn(), activate: jest.fn().mockResolvedValue(undefined), deactivate: jest.fn(), close: jest.fn() };
      ctx.deps.createMarqueeFeeder = jest.fn().mockReturnValue(marqueeFeeder);
      ctx.deps.resolveMarqueeRow = jest.fn();
      return { ...ctx, marqueeFeeder };
    }

    it('attaches the marquee feeder to pipe:8 on start', async () => {
      const { deps, marqueeFeeder, encoderChild } = withMarquee();
      await new StreamController(deps).start();
      expect(marqueeFeeder.attach).toHaveBeenCalledWith(encoderChild.marqueePipe);
    });

    it('when resolveMarqueeRow returns a rect, activate()s the feeder and bakes with currentRowOverrideText', async () => {
      const { deps, marqueeFeeder } = withMarquee();
      const rect = { x: 0, y: 0, width: 100, height: 20 };
      deps.resolveMarqueeRow.mockResolvedValue({ rect, textWidth: 500 });
      await new StreamController(deps).start();
      expect(marqueeFeeder.activate).toHaveBeenCalledWith('▶ a', rect, 500);
      expect(deps.buildOverlay).toHaveBeenLastCalledWith(expect.anything(), BASE_ROWS, { currentRowOverrideText: '▶' });
    });

    it('when resolveMarqueeRow returns null, deactivate()s the feeder and bakes normally (no opts)', async () => {
      const { deps, marqueeFeeder } = withMarquee();
      deps.resolveMarqueeRow.mockResolvedValue(null);
      await new StreamController(deps).start();
      expect(marqueeFeeder.deactivate).toHaveBeenCalled();
      expect(deps.buildOverlay).toHaveBeenLastCalledWith(expect.anything(), BASE_ROWS);
    });

    it('without resolveMarqueeRow configured, buildOverlay is called exactly as before (no opts arg at all)', async () => {
      const { deps } = buildDeps(); // no createMarqueeFeeder/resolveMarqueeRow set
      await new StreamController(deps).start();
      expect(deps.buildOverlay).toHaveBeenCalledWith(expect.anything(), BASE_ROWS);
    });

    it('a track change that arrives while resolveMarqueeRow is still resolving does not activate a stale marquee', async () => {
      const { deps, queue, marqueeFeeder, library } = withMarquee();
      let resolveFirst!: (v: any) => void;
      deps.resolveMarqueeRow.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
      const controller = new StreamController(deps);
      const starting = controller.start(); // begins resolving marquee for track 'a'
      queue.current.mockReturnValue(library.list()[1]);
      deps.resolveMarqueeRow.mockResolvedValue(null);
      await controller.next(); // supersedes the in-flight start() before it resolves
      resolveFirst({ rect: { x: 0, y: 0, width: 1, height: 1 }, textWidth: 999 });
      await starting;
      expect(marqueeFeeder.activate).not.toHaveBeenCalled();
    });

    it('windowRows with no isCurrent row: deactivates the feeder and never throws (defensive — PlaylistQueue.windowSnapshot() always includes one today)', async () => {
      const { deps, queue, marqueeFeeder } = withMarquee();
      queue.windowSnapshot.mockReturnValue([{ key: 'b:0', text: '  a', isCurrent: false }]);
      await expect(new StreamController(deps).start()).resolves.toBeUndefined();
      expect(marqueeFeeder.deactivate).toHaveBeenCalled();
      expect(deps.resolveMarqueeRow).not.toHaveBeenCalled();
    });

    it('teardown closes the marquee feeder', async () => {
      const { deps, marqueeFeeder } = withMarquee();
      const controller = new StreamController(deps);
      await controller.start();
      controller.stop();
      expect(marqueeFeeder.close).toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/stream/streamController.test.ts -t "current-track marquee"`
Expected: FAIL — `createMarqueeFeeder`/`resolveMarqueeRow` have no effect; the "without
resolveMarqueeRow" test may already pass (nothing changed for that path yet), which is fine.

- [ ] **Step 3: Implement**

In `src/stream/streamController.ts`:

1. Add near the top, after the existing `PlaylistWindowFeederLike` interface:

```typescript
import { MarqueeRowRect } from '../ffmpeg/marqueeFeeder';

// The structural subset of MarqueeFeeder this controller drives.
export interface MarqueeFeederLike {
  attach(pipe: NodeJS.WritableStream): void;
  activate(text: string, rect: MarqueeRowRect, estimatedTextWidth: number): Promise<void>;
  deactivate(): void;
  close(): void;
}
```

(Place the `import` line alongside this file's other existing imports at the top of the file, not
inline where shown above — shown here next to the interface only for readability.)

2. In `StreamControllerDeps`, add after `createPlaylistWindowFeeder?: ...`:

```typescript
  createMarqueeFeeder?: () => MarqueeFeederLike;
  resolveMarqueeRow?: (currentRowText: string, rowIndex: number) => Promise<{ rect: MarqueeRowRect; textWidth: number } | null>;
```

And change `buildOverlay`'s type the same way Task 9 changed it on the `StreamScene` side:

```typescript
  buildOverlay: (track: Track, windowRows: WindowRow[], opts?: { omitLivePlaylist?: boolean; currentRowOverrideText?: string }) => Promise<NowPlayingOverlay>;
```

3. Add two new private fields, alongside the existing `playlistWindowFeeder`/`playlistAnimator`
   fields:

```typescript
  private marqueeFeeder: MarqueeFeederLike | null = null;
  private marqueeOverrideText: string | undefined = undefined;
```

4. In `spawnPipeline()`, right after the existing `if (this.deps.createPlaylistWindowFeeder) {
   ... }` block, add:

```typescript
    if (this.deps.createMarqueeFeeder) {
      this.marqueeFeeder = this.deps.createMarqueeFeeder();
      this.marqueeFeeder.attach(child.marqueePipe);
    }
```

5. In `teardown()`, right after the existing `this.playlistWindowFeeder = null;` line, add:

```typescript
    this.marqueeFeeder?.close();
    this.marqueeFeeder = null;
    this.marqueeOverrideText = undefined;
```

6. Replace `feedCurrentTrack`'s body from its start through the `const overlay = await
   this.deps.buildOverlay(track, rows);` line with:

```typescript
  private async feedCurrentTrack(track: Track, startOffsetSeconds = 0): Promise<void> {
    this.playlistAnimator?.abort();
    this.overlayGeneration += 1;
    const rows = this.windowRows();
    const generation = ++this.sessionGeneration;

    if (this.deps.resolveMarqueeRow) {
      const rowIndex = rows.findIndex((r) => r.isCurrent);
      const currentRow = rowIndex >= 0 ? rows[rowIndex] : undefined;
      if (currentRow) {
        const resolved = await this.deps.resolveMarqueeRow(currentRow.text, rowIndex);
        if (generation !== this.sessionGeneration) return;
        if (resolved) {
          await this.marqueeFeeder?.activate(currentRow.text, resolved.rect, resolved.textWidth);
          if (generation !== this.sessionGeneration) return;
          this.marqueeOverrideText = '▶';
        } else {
          this.marqueeFeeder?.deactivate();
          this.marqueeOverrideText = undefined;
        }
      } else {
        this.marqueeFeeder?.deactivate();
        this.marqueeOverrideText = undefined;
      }
    }

    const overlay = this.marqueeOverrideText !== undefined
      ? await this.deps.buildOverlay(track, rows, { currentRowOverrideText: this.marqueeOverrideText })
      : await this.deps.buildOverlay(track, rows);
```

   (Everything from `if (generation !== this.sessionGeneration) return;` onward, i.e. the rest of
   the original method body, is unchanged — leave it exactly as it is today.)

7. In `bakeCanvas`, change:
   ```typescript
   const overlay = await this.deps.buildOverlay(track, rows, opts);
   ```
   to:
   ```typescript
   const buildOpts = this.marqueeOverrideText !== undefined
     ? { omitLivePlaylist: opts.omitLivePlaylist, currentRowOverrideText: this.marqueeOverrideText }
     : opts;
   const overlay = await this.deps.buildOverlay(track, rows, buildOpts);
   ```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/stream/streamController.test.ts`
Expected: PASS, all tests in the file (existing + new).

- [ ] **Step 5: Run the full test suite and build**

Run: `npm test && npm run build`
Expected: both PASS/exit 0, no regressions anywhere.

- [ ] **Step 6: Commit**

```bash
git add src/stream/streamController.ts test/stream/streamController.test.ts
git commit -m "feat(stream): activate/deactivate the marquee on every track switch

feedCurrentTrack resolves whether the new current row overflows, activates
MarqueeFeeder and bakes with currentRowOverrideText when it does; bakeCanvas
(the burst-handoff re-bake) carries the same override so a pipe:7 burst
during an active marquee never re-reveals the full static name."
```

---

## Task 11: Real-binary verification on the demo stand + documentation

**Files:**
- Modify: `CLAUDE.md`

This codebase's own repeatedly-proven rule (see CLAUDE.md's "Verify against real binaries" note):
unit tests cannot catch bugs in generated ffmpeg filter strings or values crossing worker_threads
boundaries. Every prior feature that touched this same filter graph (pipe:5, pipe:6, pipe:7) was
verified against a real ffmpeg + real MediaMTX + a real captured HLS segment before being called
done, and this one reuses the exact same pipe:7 pattern plus one already-spiked ffmpeg technique
(the crop-and-composite marquee-in-a-box design) — but the SPECIFIC new pieces (pipe:8's own
compositing order, MarqueeFeeder's real per-frame output, the `currentRowOverrideText` blanking)
have not yet been run against real binaries.

- [ ] **Step 1: Deploy to the demo stand**

Follow this session's established deploy workflow (see the project's own memory note
`project_super_dj_remote_test_host.md` / CLAUDE.md's remote-host conventions): `git archive` →
`scp` to 192.168.14.26:/tmp → extract → re-apply the local-only `8088:3000` port mapping →
`docker compose build super-dj frontend` → `docker compose up -d --no-deps super-dj frontend` →
verify via `curl.exe .../openapi.json` (expect 200) and `docker compose ps`.

- [ ] **Step 2: Start a real stream with a template whose playlist element is narrow enough that a real track name overflows**

Use the same technique established earlier in this project for authenticated smoke testing
without browser automation: insert a `Session` row directly into the remote Postgres, then drive
`POST /local-stream/start` (and, if needed, `PUT /local-stream/...`) via `curl.exe` with a
`Cookie: sdj_session=<uuid>` header. Pick or create a template whose `playlist` element's `width`
is narrow relative to the test account's track names (e.g. 300-400px), and a playlist that
includes at least one long name.

- [ ] **Step 3: Capture and inspect real frames**

Download two HLS `.ts` segments a few seconds apart via the authenticated preview proxy (`GET
/local-stream/preview/{file}?session=<uuid>`), and extract frames with a local real `ffmpeg`,
cropped to the playlist window's region (matching the technique already used for the Phase C
donation-insert verification). Confirm, by eye:
- The current row's text is genuinely moving between the two captured frames (not the same static
  position).
- The moving text stays within the row's own horizontal bounds — no bleeding into the row above or
  below, no bleeding past the window's own edges.
- A SHORT track name (one that fits) shows NO motion, and no double/duplicated text.
- The static baked row underneath a scrolling name is genuinely blank (no ghosted/overlapping
  text) — if `currentRowOverrideText` wiring has a bug, this is where it would show.

- [ ] **Step 4: Check the encoder's steady-state health**

Sample the encoder process's CPU (via `/proc/<pid>/stat`, the same technique used for the pipe:7
verification, since there's no `ps` binary in the deploy image) with the marquee active vs. with
only short names (no marquee), and check the backend log for any dropped-frame or `speed=`
regression signal. Record the numbers either way — this codebase's convention is to record real
measurements, not just "seemed fine."

- [ ] **Step 5: Update `CLAUDE.md`**

Add a new bullet under "Overlay templates" (or a new top-level subsection, matching the existing
"Playlist window's insert animation" bullet's own depth) documenting:
- The single-line truncation fix (Part A) and the marquee (Part B), their file locations, and the
  key design decision (strip-and-crop, not live drawtext, and why — the `overlay`-can't-move-at-
  runtime constraint this shares with pipe:7).
- The real measurements from Steps 3-4 above, stated plainly, in the same style as the pipe:7
  section's own "Cost, stated plainly" and "Verified against real binaries" bullets.
- Any deviation between what was spiked/planned and what the real run actually showed — if
  everything matched, say so explicitly (this codebase's own convention, e.g. "no backend defect
  was found" in the HLS-player investigation write-ups).

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record the playlist marquee's real-binary verification

Single-line truncation + current-track marquee, both now live-verified on
the demo stand: real deploy, real narrow-window overflow, real captured
frames showing motion within the row's bounds and no doubled text."
```
