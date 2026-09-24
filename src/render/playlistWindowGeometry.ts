import { PlaylistElement } from '../templates/templateTypes';

export interface PlaylistWindowRegion { x: number; y: number; width: number; height: number; originX: number; originY: number }

// A generous bound on one natural single-line row (the bundled fonts measure ~1.16-1.2 x fontSize).
// The baked window is never clipped by this; only BURST frames can be, for wrapped names (spec C14).
const ROW_HEIGHT_BOUND_FACTOR = 1.4;
const floorEven = (n: number) => Math.floor(n / 2) * 2;

/**
 * The fixed pipe:7 region for a playlist element's burst frames: the element's box plus one extra
 * row (the row an insert pushes out slides there while it fades), padded for stroke/shadow,
 * clamped to the canvas, with an EVEN origin. overlay in yuv420 snaps odd coordinates to the chroma
 * grid (see GIF_OVERLAY_FORMAT in persistentEncoderArgs.ts); an even origin places it exactly, for
 * free.
 */
export function computePlaylistWindowRegion(el: PlaylistElement, canvas: { width: number; height: number }, visibleRows: number): PlaylistWindowRegion | null {
  const s = el.style;
  const pad = Math.ceil((s.stroke?.width ?? 0) + Math.max(Math.abs(s.shadow?.offsetX ?? 0), Math.abs(s.shadow?.offsetY ?? 0)) + (s.shadow?.blur ?? 0)) + 2;
  const ex = Math.round(el.x);
  const ey = Math.round(el.y);
  const x0 = Math.max(0, floorEven(ex - pad));
  const y0 = Math.max(0, floorEven(ey - pad));
  const x1 = Math.min(canvas.width, Math.round(el.x + el.width) + pad);
  const y1 = Math.min(canvas.height, ey + Math.ceil((visibleRows + 1) * el.fontSize * ROW_HEIGHT_BOUND_FACTOR) + pad);
  const width = floorEven(x1 - x0);
  const height = floorEven(y1 - y0);
  if (width < 2 || height < 2) return null;
  return { x: x0, y: y0, width, height, originX: ex - x0, originY: ey - y0 };
}
