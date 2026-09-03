# Template Overlay Extensions (Part A: static styling) — Design

## Motivation

MVP shipped with `StreamTemplate`'s overlay editor (Stage 0-4 of the earlier
overlay-templates rework) supporting exactly four element types
(`cover`/`title`/`playlist`/`timer`), each with a small fixed set of
properties (position, size, a single font size, a single solid hex color).
The user wants two things:

1. **More configuration on the existing elements** — typography (bold,
   italic, font family choice), stroke/shadow for readability over a
   background image, gradient color instead of flat, and an optional
   per-track override of color/background so specific tracks can stand out.
2. **New element types** — a free-standing static text block (not tied to
   track data) and a custom image/logo the user uploads.

## Scope of this spec (Part A only)

This was split into two independent sub-projects during brainstorming,
because they differ sharply in architectural risk:

- **Part A (this spec):** everything here bakes into the *existing*
  render-once-per-track-switch pipeline (`StreamManager.buildOverlay` →
  `renderTemplatePng` → Satori/resvg, run once per `feedCurrentTrack()`
  call). No new runtime mechanism, no new ticking/animation loop.
- **Part B (separate, later spec):** animated color (pulsing/cycling with
  configurable frequency) and a genuinely *animated* GIF logo. Both need an
  update mechanism independent of track switches — the same category of
  problem the existing `timer` element already solves (see
  `CanvasFeeder`'s heartbeat + `StreamController.startTimerTicker()`), but
  generalized. **Explicitly out of scope here.** A GIF upload in Part A is
  accepted and stored, but only its first frame is ever rendered — Part B
  is what makes it actually loop on stream.

## Data model

### `ColorValue`

Replaces the plain `color: string` field on every element type that has a
color, except `timer` (see "Timer's drawtext ceiling" below).

```typescript
type ColorValue =
  | { mode: 'solid'; color: string }
  | { mode: 'gradient'; stops: [string, string] | [string, string, string]; angleDeg: number };
```

Every hex string here — `solid.color`, and each entry of `gradient.stops`
— uses the same format already validated today (`#RGB`/`#RGBA`/
`#RRGGBB`/`#RRGGBBAA`). `angleDeg` is `0-360` inclusive. `stroke.width` and
`shadow.blur`/`offsetX`/`offsetY` are all in canvas pixels, the same unit
`x`/`y`/`width`/`height`/`fontSize` already use.

### `TextStyle`

New shared shape, attached to every text-bearing element
(`title`/`playlist`/`text`/`timer`):

```typescript
interface TextStyle {
  fontFamily: string;   // key into the font registry, see below
  bold: boolean;
  italic: boolean;
  stroke?: { color: string; width: number };
  shadow?: { color: string; blur: number; offsetX: number; offsetY: number };
}
```

`stroke`/`shadow` absent (`undefined`) means "off" — not present in the
JSON at all, not a zero-width/zero-blur value, so validation can reject a
half-filled shadow object outright rather than guessing intent.

### Extended existing element types

```typescript
interface TitleElement {
  type: 'title';
  x: number; y: number; width: number; fontSize: number;
  color: ColorValue;
  style: TextStyle;
}

interface PlaylistElement {
  type: 'playlist';
  x: number; y: number; width: number; fontSize: number;
  color: ColorValue;
  style: TextStyle;
}

// Timer's drawtext ceiling: ffmpeg drawtext cannot render gradient text, so
// timer keeps a plain solid hex color rather than the full ColorValue union
// — the editor simply never offers the gradient toggle when a timer
// element is selected. Stroke/shadow ARE supported for timer, just mapped
// to drawtext's own borderw/bordercolor/shadowx/shadowy/shadowcolor
// instead of Satori CSS — shadow.blur has no drawtext equivalent and is
// silently ignored for timer specifically (validated as accepted but
// unused, not rejected — keeps one TextStyle shape for every element
// instead of a timer-specific variant).
interface TimerElement {
  type: 'timer';
  x: number; y: number; fontSize: number;
  color: string;
  style: TextStyle;
}
```

`cover` is unchanged (no color, no text).

### New element types

```typescript
interface TextElement {
  type: 'text';
  x: number; y: number; width: number;
  text: string;          // authored once in the editor, not derived from track data
  fontSize: number;
  color: ColorValue;
  style: TextStyle;
}

interface ImageElement {
  type: 'image';
  x: number; y: number; width: number; height: number;
  assetId: string;       // references an uploaded file, see "Image upload"
}
```

`TemplateElement` becomes the union of all six types. `isValidTemplateElement`
grows accordingly — same hand-rolled-validator approach as today (already
explicitly designed to grow with the element-type set), not a schema
library.

### Per-track override

Not a template concept — lives on `Track`:

```prisma
model Track {
  // ...existing fields
  overlayOverride Json?   // { color?: ColorValue, backgroundColor?: ColorValue } | null
}
```

New migration (`prisma migrate dev`, via the established remote-throwaway-
Postgres workflow documented in CLAUDE.md). Nullable, defaults to no
override. `StreamManager.buildOverlay` merges it into the template's
resolved elements right before calling `renderTemplatePng` when present;
absent, rendering is identical to today. Which element(s) the override
patches onto (by index, by an explicit "role" tag, etc.) is deliberately
**not** fixed here — the plan should pin this down once the real API/DB
shape is being written, not guessed in the abstract.

## Font subsystem

Today: one hardcoded system font
(`/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`, `DejaVu Sans`),
shared by both Satori rendering and the timer's native `drawtext`. Bold and
italic are not selectable at all.

**New: a small bundled font registry, not user-uploadable fonts** —
avoids license and security exposure of arbitrary font files. A curated
set of 3-4 OFL/Apache-licensed families ships under `assets/fonts/`
(mirrors the existing `assets/background.png`/`default-cover.png`
pattern), current DejaVu Sans included as the default/fallback family.
Each family provides up to 4 files (regular/bold/italic/bold-italic); a
family missing a specific variant (e.g. no italic) falls back to its
closest available file rather than erroring.

`src/render/fontRegistry.ts` (new):
```typescript
function resolveFontFile(family: string, bold: boolean, italic: boolean): string
```

**Satori side (`sceneRenderer.ts`):** currently registers exactly one font
in the `fonts:[...]` array passed to `satori()`. Changes to: collect the
distinct `(family, weight, style)` tuples actually used across the scene's
elements, resolve each through the registry, register all of them —
Satori matches the right file to each element by its own `fontWeight`/
`fontStyle` CSS properties, same mechanism it already uses today for the
one hardcoded font.

**Timer side (`segmentArgs.ts`/`canvasFeeder.ts`):** not routed through
Satori at all — `overlayFilterComplex`/`buildCanvasFrameArgs` resolve
`fontfile` through the same registry using the timer element's own
`style`, replacing today's single hardcoded `FONT_FILE` constant.

**Caching:** `fontCache.ts`'s current single-path cache
(`{path, data: Promise<Buffer>}`) becomes a `Map<path, Promise<Buffer>>` —
same "read once per process, shared across every render call" behavior,
just keyed for more than one file.

**Frontend:** `GET /templates/fonts` (new, tiny) returns the family list so
the editor's font picker has one source of truth instead of duplicating
the registry's family names in the frontend bundle.

## Image upload

New `image` element needs a place to store the file. Mirrors
`trackUploadService.ts`'s existing multer-based pattern.

**Storage:** `{UPLOADS_DIR}/{userId}/templates/{templateId}/images/{assetId}{ext}`.

**API:**
- `POST /templates/{id}/images` (multipart, single file field) — creates a
  new `assetId` (uuid), moves the uploaded file into place, returns
  `{ assetId }`. Ownership-checked (caller must own the template).
- `GET /templates/{id}/images/{assetId}` — serves the raw file bytes
  (mirrors `GET /tracks/{id}/cover`), ownership-checked.

**Validation:** file-size cap matching the existing track-cover limit;
allowed mime types `image/png`, `image/jpeg`, `image/gif`. `image/svg+xml`
is deliberately excluded — an uploaded SVG is effectively embeddable markup
and a realistic XSS/SSRF surface if it ever gets rendered or served with a
permissive content-type, not worth the feature value here.

**Transparency:** no special handling needed — a PNG with an alpha channel
passes through Satori's `<img>` → resvg without flattening, the same path
already used for track cover art (`imageDataUri.ts`, reused as-is for
template images).

**GIF, Part-A behavior only:** on upload, extract the first frame via
`ffmpeg -i input.gif -frames:v 1 -update 1 preview.png` (the `-update 1`
flag matters for a single-file PNG output rather than an image-sequence
pattern). The extracted `preview.png` is what Part A actually renders; the
original GIF file is kept alongside it (not deleted) so Part B can pick it
up later for
real looping animation without asking the user to re-upload.

**Not doing:** cleanup of orphaned image files when an element is removed
or a template deleted. Matches the already-accepted, already-documented
gap for track files (`DELETE /tracks/{id}` leaves `{UPLOADS_DIR}/...`
behind) — same trade-off, not a new one introduced by this feature.

## Rendering (`sceneRenderer.ts`)

New shared helper, used by `title`/`playlist`/`text` (all three share
identical style-building logic, differing only in what content they wrap):

```typescript
function textStyleToCss(style: TextStyle, color: ColorValue): Record<string, unknown>
```

Produces:
- `bold`/`italic` → `fontWeight: 700 | 400`, `fontStyle: 'italic' | 'normal'`
- `color.mode === 'solid'` → `color: color.color`
- `color.mode === 'gradient'` → `backgroundImage: 'linear-gradient(${angleDeg}deg, ${stops.join(', ')})'`,
  `backgroundClip: 'text'`, `color: 'transparent'` — the standard CSS
  gradient-text trick
- `style.stroke` present → `WebkitTextStrokeWidth`/`WebkitTextStrokeColor`
- `style.shadow` present → `textShadow: '${offsetX}px ${offsetY}px ${blur}px ${color}'`

`image` element's `elementNode` case reads the file via the same
`imageDataUri.ts` used for cover, keyed by `assetId` resolved to its
on-disk path.

**Resolved during planning (was an open risk):** `backgroundClip:'text'`,
`WebkitTextStroke*`, and `textShadow` were only documented Satori
behavior, unverified in this project — and this project has already been
bitten twice by "works against fakes/docs, breaks against the real binary"
(the piscina `Buffer`-rewrapping gap, drawtext's double-colon escaping) —
per [[feedback-verify-against-real-binaries]]. A throwaway spike ran all
three through the real installed `satori@^0.33.4` + `@resvg/resvg-js@^2.6.2`
pair (this project's actual pinned versions) and confirmed all three work:
gradient text produces a real `<linearGradient>` def with `fill="url(#...)"`,
the stroke properties produce real `stroke`/`stroke-width` SVG attributes,
and `textShadow` produces a real `feDropShadow`/`feGaussianBlur` filter —
confirmed both structurally and by eye on the rendered PNGs. The
implementation plan builds on this as a verified fact, not an assumption.

## Editor UI (`TemplateEditor.tsx`)

- `addElement`'s type list grows from `['cover','title','playlist','timer']`
  to include `'text'` and `'image'`.
- **`image`:** clicking "add image" immediately opens a native file picker
  (a hidden `<input type=file>` triggered programmatically); the element is
  only inserted into `elements[]` after `POST /templates/{id}/images`
  succeeds, so there's never a broken/file-less image element on the
  canvas. Properties panel shows a thumbnail (`<img src=".../images/{assetId}">`),
  a "replace file" control, and the existing width/height fields (same as
  `cover` today).
- **`text`:** same properties panel as `title`/`playlist`, plus a new
  textarea for the literal text content.
- **`title`/`playlist`/`text` properties panel additions:**
  - solid/gradient toggle — gradient reveals 2-3 `ColorField`s (stops) + a
    number field (angle)
  - bold/italic toggle buttons
  - font family `<select>`, populated from `GET /templates/fonts`
  - stroke: a checkbox that reveals color + width when enabled
  - shadow: a checkbox that reveals color + blur + offsetX + offsetY when
    enabled
- **`timer`:** the same panel additions minus the gradient toggle (never
  shown for timer — see "Timer's drawtext ceiling" above).
- No change to the editor's core interaction model — drag/resize/select
  already work uniformly across element types; this only grows the
  properties panel with conditionally-shown blocks, using the same flat
  `NumberField`/`ColorField` building blocks already in the file. No
  tabs/accordions needed at this element count.
- **Per-track override is explicitly not part of `TemplateEditor.tsx`** —
  it lives on `Track`, not `StreamTemplate`, so it needs its own small UI
  surface on the existing track-editing flow (Library page), out of this
  component's scope.

## Testing approach

Follows the project's existing conventions (see CLAUDE.md's "Testing
strategy"): `isValidTemplateElement`/`isValidTemplateElements` get
straightforward unit tests per new field/element type, same shape as
today's. `fontRegistry.ts`'s fallback behavior (missing italic/bold file)
gets unit tests against a fixture directory, not the real bundled fonts.
`sceneRenderer.ts`'s new CSS-trick output should get **both** a unit test
(shape of the Satori node tree) **and** a real end-to-end
`satori`+`resvg` test asserting actual pixel output for at least one
gradient/stroke/shadow case — mirrors `sceneRenderer.test.ts`'s existing
"doesn't go through the pool, exercises the real thing" pattern, which is
exactly what caught the two real bugs from the original overlay-templates
rework. Image upload gets the same manual-smoke-test-with-real-Postgres
treatment `trackUploadService.ts` already gets, not a unit test for the
Prisma-backed repository parts.

## Out of scope (tracked, not forgotten)

- Animated color, animated GIF playback — Part B, separate spec.
- Cleanup of unused/orphaned image files on element removal or template
  deletion.
- User-uploadable custom fonts (only the bundled registry).
- Fixing exactly which element(s) a per-track override patches — pinned
  down at plan time, not here.
