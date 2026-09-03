// The canvas coordinate space every template's elements are positioned in — matches the pinned
// video params in src/stream/streamManager.ts (VIDEO_WIDTH/VIDEO_HEIGHT).
export const CANVAS_WIDTH = 1280;
export const CANVAS_HEIGHT = 720;

export interface CoverElement {
  type: 'cover';
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TitleElement {
  type: 'title';
  x: number;
  y: number;
  width: number;
  fontSize: number;
  color: string;
}

export interface PlaylistElement {
  type: 'playlist';
  x: number;
  y: number;
  width: number;
  fontSize: number;
  color: string;
}

export type TemplateElement = CoverElement | TitleElement | PlaylistElement;

const ELEMENT_TYPES = ['cover', 'title', 'playlist'] as const;

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

// Validates the shape of one element from an untrusted request body. Deliberately permissive
// on which fields are required per type rather than a full schema library — this is expected
// to grow (more element types, more style fields) as the visual editor (Stage 3) matures, and
// a hand-rolled check keeps that growth low-ceremony.
export function isValidTemplateElement(value: unknown): value is TemplateElement {
  if (typeof value !== 'object' || value === null) return false;
  const el = value as Record<string, unknown>;
  if (typeof el.type !== 'string' || !ELEMENT_TYPES.includes(el.type as (typeof ELEMENT_TYPES)[number])) return false;
  if (!isValidPosition(el.x, el.y)) return false;
  if (el.type === 'cover') {
    return isValidSize(el.width, CANVAS_WIDTH) && isValidSize(el.height, CANVAS_HEIGHT);
  }
  // title / playlist
  return isValidSize(el.width, CANVAS_WIDTH) && isValidSize(el.fontSize, MAX_FONT_SIZE) && isValidColor(el.color);
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
  { type: 'title', x: 512, y: 40, width: 700, fontSize: 42, color: '#ffffff' },
  { type: 'playlist', x: 512, y: 160, width: 700, fontSize: 22, color: '#ffffff' },
];
