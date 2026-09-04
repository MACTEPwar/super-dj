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

// #RGB / #RGBA / #RRGGBB / #RRGGBBAA only — this value can reach an ffmpeg drawtext filter
// string (a future 'timer' element's fontcolor), so it's validated strictly rather than
// accepted as any non-empty string, closing off filter-string injection via stray `:`/`'`/`\`.
const HEX_COLOR_PATTERN = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const MAX_FONT_SIZE = 300;

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
