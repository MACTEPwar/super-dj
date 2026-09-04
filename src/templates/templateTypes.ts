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
  color: string; // solid hex only — the rendering mechanism (ffmpeg showfreqs) can't do gradients
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
    // Equalizer-specific, not folded into the shared isValidPosition/isValidSize used by every
    // other element type: ffmpeg's showfreqs `s=` (size) option requires integer width/height,
    // and this element's position/size should just always be whole pixels — but other element
    // types (e.g. a future fractional angle/offset) have no such requirement, so this stays a
    // narrow check in this branch rather than a change to the shared functions.
    return Number.isInteger(el.x) && Number.isInteger(el.y)
      && isValidSize(el.width, CANVAS_WIDTH) && Number.isInteger(el.width)
      && isValidSize(el.height, CANVAS_HEIGHT) && Number.isInteger(el.height)
      && isValidFfmpegColor(el.color);
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
