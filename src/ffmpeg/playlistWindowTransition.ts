import { WindowRow } from '../playlist/window';

export const INSERT_ANIMATION_MS = 600;
const GAP_END_MS = 360;
const FADE_IN_START_MS = 240;
const SLIDE_IN_PX = 24;
// The new row's box grows to 1.5 x fontSize. That is above its natural single-line height (~1.2x),
// so the gap finishes opening a little early, but no row-height model is ever needed: the flex
// column pushes everything below it down by exactly the row's real height.
const GAP_MAX_HEIGHT_FACTOR = 1.5;

export interface AnimatedRow { key: string; text: string; opacity?: number; offsetX?: number; maxHeightFactor?: number }
export type WindowTransition =
  | { kind: 'none' }
  | { kind: 'snap' }
  | { kind: 'insert'; from: WindowRow[]; to: WindowRow[]; insertedKeys: Set<string> };
export type InsertTransition = Extract<WindowTransition, { kind: 'insert' }>;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);

/**
 * `insert` ONLY when `to` is `from` with rows added after the current row, and with rows lost only
 * off the bottom — the one change worth animating. Everything else (a track advance, previous, a
 * restart, a first render) is `snap`: a cosmetic animation must never delay showing what's
 * actually playing.
 */
export function planWindowTransition(from: WindowRow[], to: WindowRow[]): WindowTransition {
  const same = from.length === to.length && from.every((r, i) => r.key === to[i].key && r.text === to[i].text && r.isCurrent === to[i].isCurrent);
  if (same) return { kind: 'none' };
  if (from.length === 0) return { kind: 'snap' };

  const fromCur = from.findIndex((r) => r.isCurrent);
  const toCur = to.findIndex((r) => r.isCurrent);
  if (fromCur < 0 || fromCur !== toCur || from[fromCur].key !== to[toCur].key) return { kind: 'snap' };

  const fromKeys = new Set(from.map((r) => r.key));
  const insertedKeys = new Set(to.filter((r) => !fromKeys.has(r.key)).map((r) => r.key));
  if (insertedKeys.size === 0) return { kind: 'snap' };
  if (to.some((r, i) => insertedKeys.has(r.key) && i <= toCur)) return { kind: 'snap' };

  const kept = to.filter((r) => !insertedKeys.has(r.key));
  if (kept.length > from.length) return { kind: 'snap' };
  for (let i = 0; i < kept.length; i += 1) {
    if (kept[i].key !== from[i].key || kept[i].text !== from[i].text) return { kind: 'snap' };
  }
  return { kind: 'insert', from, to, insertedKeys };
}

// No optional props at all: playlistWindowNode() renders these exactly like today's baked rows.
export function settledRows(rows: WindowRow[]): AnimatedRow[] {
  return rows.map((r) => ({ key: r.key, text: r.text }));
}

export function animatedRowsAt(t: InsertTransition, elapsedMs: number): AnimatedRow[] {
  if (elapsedMs >= INSERT_ANIMATION_MS) return settledRows(t.to);
  const gap = easeInOutCubic(clamp01(elapsedMs / GAP_END_MS));
  const appear = easeOutCubic(clamp01((elapsedMs - FADE_IN_START_MS) / (INSERT_ANIMATION_MS - FADE_IN_START_MS)));
  const toKeys = new Set(t.to.map((r) => r.key));
  const rows: AnimatedRow[] = t.to.map((r) => (t.insertedKeys.has(r.key)
    ? { key: r.key, text: r.text, maxHeightFactor: GAP_MAX_HEIGHT_FACTOR * gap, opacity: appear, offsetX: SLIDE_IN_PX * (1 - appear) }
    : { key: r.key, text: r.text }));
  // Rows the insert pushes out of the window stay in the column below it while they fade.
  for (const r of t.from) {
    if (!toKeys.has(r.key)) rows.push({ key: r.key, text: r.text, opacity: 1 - gap });
  }
  return rows;
}
