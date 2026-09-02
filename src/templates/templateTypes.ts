// The canvas coordinate space every template's elements are positioned in — must match the
// pinned video params in src/stream/streamManager.ts (VIDEO_WIDTH/VIDEO_HEIGHT) once the
// renderer is wired into the actual stream pipeline (Stage 1 of the overlay rework).
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// Validates the shape of one element from an untrusted request body. Deliberately permissive
// on which fields are required per type rather than a full schema library — this is expected
// to grow (more element types, more style fields) as the visual editor (Stage 3) matures, and
// a hand-rolled check keeps that growth low-ceremony.
export function isValidTemplateElement(value: unknown): value is TemplateElement {
  if (typeof value !== 'object' || value === null) return false;
  const el = value as Record<string, unknown>;
  if (typeof el.type !== 'string' || !ELEMENT_TYPES.includes(el.type as (typeof ELEMENT_TYPES)[number])) return false;
  if (!isFiniteNumber(el.x) || !isFiniteNumber(el.y)) return false;
  if (el.type === 'cover') {
    return isFiniteNumber(el.width) && isFiniteNumber(el.height);
  }
  // title / playlist
  return isFiniteNumber(el.width) && isFiniteNumber(el.fontSize) && typeof el.color === 'string' && el.color.length > 0;
}

export function isValidTemplateElements(value: unknown): value is TemplateElement[] {
  return Array.isArray(value) && value.every(isValidTemplateElement);
}
