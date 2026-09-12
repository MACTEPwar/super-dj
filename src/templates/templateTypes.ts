// The canvas coordinate space every template's elements are positioned in — matches the pinned
// video params in src/stream/streamManager.ts (VIDEO_WIDTH/VIDEO_HEIGHT).
export const CANVAS_WIDTH = 1280;
export const CANVAS_HEIGHT = 720;

export type ColorValue =
  | { mode: 'solid'; color: string }
  | { mode: 'gradient'; stops: [string, string] | [string, string, string]; angleDeg: number };

export interface TextStyle {
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  stroke?: { color: string; width: number };
  shadow?: { color: string; blur: number; offsetX: number; offsetY: number };
  // Single-line truncation ('nowrap' + 'hidden' + '…') — makes sense for title/text (single-
  // line by design) but not playlist (multi-line, wrapping is intentional). TextStyle is shared
  // across all three element types rather than split per-type, so this is left enabled at the
  // type/validation level for playlist too; see sceneRenderer.ts's textStyleToCss for why, and
  // TemplateEditor.tsx, which is where this is actually kept out of a playlist author's hands
  // (the properties-panel checkbox only renders for title/text).
  overflow?: 'ellipsis';
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

export interface EqualizerElement {
  type: 'equalizer';
  x: number;
  y: number;
  width: number;
  height: number;
  colors: string[]; // gradient stops across the line's width, left to right, 2-6 stops
  glowLayers: number; // 3-9
  glowRadius: number; // 10-70, px — outer glow layer's half-width
  coreWidth: number; // 1-6, px — the bright core stroke
  // Reactivity — how the line follows the audio (see PulseEngine in src/audio/pulseEngine.ts,
  // which these feed directly):
  sensitivity: number; // 0.5-3.0 — gain: how much a band's loudness translates into height
  smoothing: number; // 0-1 — 0 = snappy attack/release, 1 = smooth/slow-following
  beatBoost: number; // 0-1 — 0 = pure continuous spectrum, 1 = strong extra kick on real onsets
  bandCount: number; // 8-112, integer — independent frequency bars across the element's width
  // 0-20, integer — 0 = no whole-line "breathe" on a broadband beat, higher = a stronger one,
  // linearly. Integer like glowLayers/bandCount rather than fractional like sensitivity/
  // smoothing/beatBoost: the 0-20 range exists precisely so whole-number steps are fine-grained
  // enough on their own (one step is a tenth of the engine's strength unit — see
  // globalPulseStrength below), and a fractional step would be below what's visible anyway.
  globalPulse: number;
}

// The approved "neon pulse" look from this feature's design — used by the frontend's
// create-element factory, by normalizeEqualizerElement (below) to patch a template saved before
// a field existed, and as the reference values in tests. Not consumed by request validation
// itself (a saved element must always specify every field).
export const DEFAULT_EQUALIZER_STYLE = {
  colors: ['#3b6fff', '#b23bff', '#ff2f6e', '#b23bff', '#3bdcff'],
  glowLayers: 9,
  glowRadius: 42,
  coreWidth: 1,
  sensitivity: 1.5,
  smoothing: 0.4,
  beatBoost: 0.5,
  bandCount: 56,
  // 8 is the value that reproduces the engine strength (0.8) the global pulse was approved at
  // when it was still an internal-only A/B candidate — see globalPulseStrength below.
  globalPulse: 8,
} as const;

// The equalizer's `globalPulse` field is a UI-scale 0-20 knob; PulseEngine (src/audio/
// pulseEngine.ts) takes the same thing on its own strength scale, where 1.0 = the line scales
// x(1 + GLOBAL_PULSE_GAIN) at the envelope's peak. This is the one place the two are related:
// 10 UI steps per 1.0 of engine strength, so the field's ceiling (20) is the engine's
// MAX_GLOBAL_PULSE_STRENGTH (2), the default (8) is exactly the 0.8 the user approved in the A/B
// captures, and 0 is exactly 0 — the engine's "off, byte-identical to no option" path. A
// division, not a multiplication by 0.1: IEEE division is correctly rounded, so e.g. 12/10 is
// the double nearest 1.2, whereas 12*0.1 is 1.2000000000000002.
export const GLOBAL_PULSE_STEPS_PER_STRENGTH = 10;

export function globalPulseStrength(globalPulse: number): number {
  return globalPulse / GLOBAL_PULSE_STEPS_PER_STRENGTH;
}

export type TemplateElement =
  | CoverElement | TitleElement | PlaylistElement | TimerElement | TextElement | ImageElement | EqualizerElement;

const ELEMENT_TYPES = ['cover', 'title', 'playlist', 'timer', 'text', 'image', 'equalizer'] as const;
const MAX_TEXT_LENGTH = 500;

// #RGB / #RGBA / #RRGGBB / #RRGGBBAA only — this value can reach an ffmpeg drawtext filter
// string (a future 'timer' element's fontcolor), so it's validated strictly rather than
// accepted as any non-empty string, closing off filter-string injection via stray `:`/`'`/`\`.
const HEX_COLOR_PATTERN = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

// 6/8-digit only — for color values that reach an ffmpeg filter/option directly (EqualizerElement's
// showfreqs `colors=`, TimerElement's drawtext `fontcolor=`) rather than Satori/CSS. ffmpeg's own
// color parser (av_parse_color) has no notion of CSS's #RGB/#RGBA shorthand: verified against a
// real ffmpeg binary, `colors=#f00` logs "Invalid 0xRRGGBB[AA] color string" and silently falls
// back to black, which the equalizer's own colorkey=black filter then removes entirely — the bar
// never appears on stream, with nothing in the API response to say why. Rejecting the shorthand
// at save time turns that into a 400 instead of a silently wrong live render.
const STRICT_HEX_COLOR_PATTERN = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const MAX_FONT_SIZE = 300;

const MIN_GLOW_LAYERS = 3;
const MAX_GLOW_LAYERS = 9;
const MIN_GLOW_RADIUS = 10;
const MAX_GLOW_RADIUS = 70;
const MIN_CORE_WIDTH = 1;
const MAX_CORE_WIDTH = 6;
const MIN_EQUALIZER_COLOR_STOPS = 2;
const MAX_EQUALIZER_COLOR_STOPS = 6;
const MIN_SENSITIVITY = 0.5;
const MAX_SENSITIVITY = 3;
const MIN_SMOOTHING = 0;
const MAX_SMOOTHING = 1;
const MIN_BEAT_BOOST = 0;
const MAX_BEAT_BOOST = 1;
// Bounded above because every band is one more FFT-bin average per tick and one more polyline
// point per rasterized frame, per active stream; below because pcmSpectrum.ts's log-spaced band
// edges need a few bands to spread over at all.
const MIN_BAND_COUNT = 8;
const MAX_BAND_COUNT = 112;
// See globalPulseStrength above for how this range maps onto PulseEngine's own strength scale.
const MIN_GLOBAL_PULSE = 0;
const MAX_GLOBAL_PULSE = 20;

// Upper bounds for the text-decoration numerics. These are NOT cosmetic limits: an unbounded
// shadow blur reaches resvg/tiny-skia's native rasterizer, where an extreme value panics in Rust
// — a panic JS can't catch, which aborts the whole render worker process and with it every other
// tenant's live stream; merely-large values (a few thousand) instead take seconds to rasterize,
// starving the shared render pool (RENDER_TIMEOUT_MS can't abort synchronous native work once
// started). The visual editor clamps these to blur 0..50, offsets -50..50, stroke width 1..20,
// so these bounds sit comfortably above the whole UI range with headroom for a future wider UI.
const MAX_SHADOW_BLUR = 100;
const MAX_SHADOW_OFFSET = 100;
const MAX_STROKE_WIDTH = 50;

// assetId is only ever minted by TemplateImageService.generateId() (randomUUID by default), and
// TemplateImageService.resolvePath() throws InvalidAssetIdError on anything that isn't a plain
// filename. Constraining the shape HERE — at save time — makes that throw structurally
// unreachable for any id that got through validation, instead of surfacing later as a blanked
// live overlay or a 500 from the preview endpoint. Deliberately a little looser than a strict
// UUID regex so a future id scheme doesn't need a migration, but still filename-safe:
// no separators, no dots, no traversal.
const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidPosition(x: unknown, y: unknown): boolean {
  return isFiniteNumber(x) && x >= 0 && x <= CANVAS_WIDTH && isFiniteNumber(y) && y >= 0 && y <= CANVAS_HEIGHT;
}

function isValidSize(value: unknown, max: number): boolean {
  return isFiniteNumber(value) && value > 0 && value <= max;
}

function isValidColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value);
}

function isValidFfmpegColor(value: unknown): value is string {
  return typeof value === 'string' && STRICT_HEX_COLOR_PATTERN.test(value);
}

// Equalizer colors reach resvg's SVG gradient stops (a real CSS-color-parsing renderer), not an
// ffmpeg filter option directly — so the loose isValidColor (CSS-valid 3/4/6/8-digit hex) is the
// right check here, same reasoning as title/playlist's ColorValue, unlike the old MVP's
// STRICT_HEX_COLOR_PATTERN-gated `color` field this replaces.
function isValidEqualizerColors(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length >= MIN_EQUALIZER_COLOR_STOPS && value.length <= MAX_EQUALIZER_COLOR_STOPS
    && value.every((c) => isValidColor(c));
}

function isNumberInRange(value: unknown, min: number, max: number): value is number {
  return isFiniteNumber(value) && value >= min && value <= max;
}

type EqualizerStyleField = keyof typeof DEFAULT_EQUALIZER_STYLE;

// Per-field validators for the equalizer's style/reactivity fields (everything but position/
// size), keyed by field so normalizeEqualizerElement (below) can patch exactly the fields that
// are missing/invalid and keep the rest, and isValidEqualizerStyle can require all of them.
const EQUALIZER_STYLE_VALIDATORS: Record<EqualizerStyleField, (value: unknown) => boolean> = {
  colors: isValidEqualizerColors,
  glowLayers: (v) => isNumberInRange(v, MIN_GLOW_LAYERS, MAX_GLOW_LAYERS) && Number.isInteger(v),
  glowRadius: (v) => isNumberInRange(v, MIN_GLOW_RADIUS, MAX_GLOW_RADIUS),
  coreWidth: (v) => isNumberInRange(v, MIN_CORE_WIDTH, MAX_CORE_WIDTH),
  sensitivity: (v) => isNumberInRange(v, MIN_SENSITIVITY, MAX_SENSITIVITY),
  smoothing: (v) => isNumberInRange(v, MIN_SMOOTHING, MAX_SMOOTHING),
  beatBoost: (v) => isNumberInRange(v, MIN_BEAT_BOOST, MAX_BEAT_BOOST),
  bandCount: (v) => isNumberInRange(v, MIN_BAND_COUNT, MAX_BAND_COUNT) && Number.isInteger(v),
  globalPulse: (v) => isNumberInRange(v, MIN_GLOBAL_PULSE, MAX_GLOBAL_PULSE) && Number.isInteger(v),
};

// Just the style/reactivity fields — split out from isValidTemplateElement's equalizer branch
// so normalizeEqualizerElement (below) can check them independently of position/size, which it
// deliberately does NOT re-validate the same strict (integer) way: a fractional x/y/width/height
// is StreamManager's concern to round, not this function's to reject.
function isValidEqualizerStyle(el: Record<string, unknown>): boolean {
  return (Object.keys(EQUALIZER_STYLE_VALIDATORS) as EqualizerStyleField[])
    .every((field) => EQUALIZER_STYLE_VALIDATORS[field](el[field]));
}

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
    if (!isValidColor(s.color) || !isFiniteNumber(s.width) || s.width <= 0 || s.width > MAX_STROKE_WIDTH) return false;
  }
  if (v.shadow !== undefined) {
    if (typeof v.shadow !== 'object' || v.shadow === null) return false;
    const s = v.shadow as Record<string, unknown>;
    if (!isValidColor(s.color)) return false;
    if (!isFiniteNumber(s.blur) || s.blur < 0 || s.blur > MAX_SHADOW_BLUR) return false;
    if (!isFiniteNumber(s.offsetX) || Math.abs(s.offsetX) > MAX_SHADOW_OFFSET) return false;
    if (!isFiniteNumber(s.offsetY) || Math.abs(s.offsetY) > MAX_SHADOW_OFFSET) return false;
  }
  if (v.overflow !== undefined && v.overflow !== 'ellipsis') return false;
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
      && typeof el.assetId === 'string' && ASSET_ID_PATTERN.test(el.assetId);
  }

  if (!isValidPosition(el.x, el.y)) return false;

  if (el.type === 'cover') {
    return isValidSize(el.width, CANVAS_WIDTH) && isValidSize(el.height, CANVAS_HEIGHT);
  }
  if (el.type === 'timer') {
    return isValidSize(el.fontSize, MAX_FONT_SIZE) && isValidFfmpegColor(el.color) && isValidTextStyle(el.style);
  }
  if (el.type === 'equalizer') {
    // Position/size stay integer-constrained, not folded into the shared isValidPosition/
    // isValidSize used by every other element type: PulseVisualizer's raw video pipe declares
    // `-s <width>x<height>` to ffmpeg, which (like the old showfreqs `s=` option before it)
    // requires whole pixels — see persistentEncoderArgs.ts.
    return Number.isInteger(el.x) && Number.isInteger(el.y)
      && isValidSize(el.width, CANVAS_WIDTH) && Number.isInteger(el.width)
      && isValidSize(el.height, CANVAS_HEIGHT) && Number.isInteger(el.height)
      && isValidEqualizerStyle(el);
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

// A template's equalizer element saved before a style field existed can still sit in the
// database exactly as saved — nothing re-validates a stored template's elements on read, only on
// write (see templateRoutes.ts). Two real generations of that: the old {color: string}
// showfreqs-MVP shape with no colors[] at all, which used as-is crashes StreamManager's whole
// process on the element's first render tick (PulseVisualizer's buildPulseSvg does
// colors.map(...) on undefined, inside a bare setInterval callback with nothing to catch it —
// reproduced against a real deployed template); and neon-pulse templates saved before the
// sensitivity/smoothing/beatBoost/bandCount reactivity fields landed (and, one generation later,
// before globalPulse did), whose own colors/glow must survive. So each missing/invalid style
// field is patched with its default INDIVIDUALLY, never
// the whole style at once. Position/size stay exactly as saved (still StreamManager's job to
// round to integers — see its own EqualizerConfig comment — not re-validated the strict way
// here); the element is dropped entirely only when even the position/size is unusable (e.g.
// negative or out-of-canvas), the same "skip just the broken element" policy StreamManager's own
// resolveImageAssets already uses for a malformed image element.
export function normalizeEqualizerElement(element: EqualizerElement): EqualizerElement | null {
  if (!isValidPosition(element.x, element.y)
    || !isValidSize(element.width, CANVAS_WIDTH) || !isValidSize(element.height, CANVAS_HEIGHT)) {
    console.warn('[templates] dropping a template equalizer element with an invalid position/size');
    return null;
  }
  const raw = element as unknown as Record<string, unknown>;
  if (isValidEqualizerStyle(raw)) return element;
  const patched: Record<string, unknown> = { ...raw };
  for (const field of Object.keys(EQUALIZER_STYLE_VALIDATORS) as EqualizerStyleField[]) {
    if (EQUALIZER_STYLE_VALIDATORS[field](raw[field])) continue;
    // Spread a fresh mutable array rather than DEFAULT_EQUALIZER_STYLE.colors directly — it's a
    // readonly tuple (`as const`), not assignable to EqualizerElement's `colors: string[]`.
    patched[field] = field === 'colors' ? [...DEFAULT_EQUALIZER_STYLE.colors] : DEFAULT_EQUALIZER_STYLE[field];
  }
  return patched as unknown as EqualizerElement;
}

// Used whenever a stream starts without an explicit templateId (it's optional — see
// StreamManager.start()) — approximates the layout the hand-built drawtext overlay used to
// produce, so a user who never configures a template doesn't lose cover/title/playlist
// entirely, just the ability to reposition them.
export const DEFAULT_TEMPLATE_ELEMENTS: TemplateElement[] = [
  { type: 'cover', x: 40, y: 40, width: 432, height: 432 },
  { type: 'title', x: 512, y: 40, width: 700, fontSize: 42,
    color: { mode: 'solid', color: '#ffffff' },
    style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } },
  { type: 'playlist', x: 512, y: 160, width: 700, fontSize: 22,
    color: { mode: 'solid', color: '#ffffff' },
    style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } },
];
