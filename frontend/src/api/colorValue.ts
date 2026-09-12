import type { ColorValue, GradientStop, GradientType } from './templates';

// Hand-kept mirror of src/render/sceneRenderer.ts's gradientCss and
// src/templates/templateTypes.ts's normalizeColorValue — kept in sync by hand, like every other
// frontend mirror of backend logic in this project (see PulseEqualizerPreview.tsx). The point of
// the gradientCss mirror is that the picker's live gradient strip shows the EXACT string the
// backend will render, rather than an approximation of it.

export const MIN_GRADIENT_STOPS = 2;
export const MAX_GRADIENT_STOPS = 6;
const MAX_GRADIENT_OFFSET = 100;
const GRADIENT_TYPE_VALUES: GradientType[] = ['linear', 'radial'];
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export const FALLBACK_COLOR_VALUE: ColorValue = { mode: 'solid', color: '#ffffff' };

export function gradientCss(color: Extract<ColorValue, { mode: 'gradient' }>): string {
  const stops = [...color.stops]
    .sort((a, b) => a.offset - b.offset)
    .map((s) => `${s.color} ${s.offset}%`)
    .join(', ');
  return color.gradientType === 'radial'
    ? `radial-gradient(${stops})`
    : `linear-gradient(${color.angleDeg}deg, ${stops})`;
}

// Adding a stop inserts it at the MIDPOINT of the widest gap between two adjacent existing stops
// (by offset), leaving every existing stop's offset untouched. Deliberately not an even re-spread
// of the whole array: the author may have already positioned stops precisely (e.g. via the
// draggable strip), and a structural change to the stop COUNT should not silently move stops the
// author didn't touch. Picking the widest gap (rather than always the end, or always the
// midpoint of the whole 0-100 range) is what makes this sensible for any existing layout — it's
// also always visibly different from before the click, unlike inserting at a fixed point that
// might collide with an existing stop. The new stop's color is a plain white placeholder; the
// author picks a real one afterwards.
export function insertStopAtMidpoint(stops: GradientStop[]): GradientStop[] {
  if (stops.length === 0) return [{ color: '#ffffff', offset: 0 }];
  if (stops.length === 1) return [...stops, { color: '#ffffff', offset: 100 }];
  const sorted = [...stops].sort((a, b) => a.offset - b.offset);
  let bestGapStart = 0;
  let bestGapEnd = 100;
  let bestGapSize = -1;
  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = sorted[i + 1].offset - sorted[i].offset;
    if (gap > bestGapSize) {
      bestGapSize = gap;
      bestGapStart = sorted[i].offset;
      bestGapEnd = sorted[i + 1].offset;
    }
  }
  const offset = Math.round((bestGapStart + bestGapEnd) / 2);
  return [...stops, { color: '#ffffff', offset }];
}

function isHex(v: unknown): v is string { return typeof v === 'string' && HEX_COLOR.test(v); }
function inRange(v: unknown, max: number): v is number { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max; }

export function isValidColorValue(value: unknown): value is ColorValue {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.mode === 'solid') return isHex(v.color);
  if (v.mode !== 'gradient') return false;
  if (!GRADIENT_TYPE_VALUES.includes(v.gradientType as GradientType)) return false;
  if (!Array.isArray(v.stops) || v.stops.length < MIN_GRADIENT_STOPS || v.stops.length > MAX_GRADIENT_STOPS) return false;
  if (!v.stops.every((s) => typeof s === 'object' && s !== null && isHex((s as GradientStop).color) && inRange((s as GradientStop).offset, MAX_GRADIENT_OFFSET))) return false;
  return inRange(v.angleDeg, 360);
}

/**
 * Absorbs the two older stored shapes so opening an old template neither crashes the editor nor
 * silently 400s its save / its debounced preview request (the backend validates the draft body
 * with isValidTemplateElements — a legacy-shaped draft just makes the preview keep the last good
 * picture, with nothing on screen to say why).
 */
export function normalizeColorValue(value: unknown): ColorValue {
  if (isValidColorValue(value)) return value;
  if (isHex(value)) return { mode: 'solid', color: value };
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>;
    if (v.mode === 'solid' && isHex(v.color)) return { mode: 'solid', color: v.color };
    if (v.mode === 'gradient' && Array.isArray(v.stops) && v.stops.every(isHex)
      && v.stops.length >= MIN_GRADIENT_STOPS && v.stops.length <= MAX_GRADIENT_STOPS) {
      const n = v.stops.length;
      return {
        mode: 'gradient',
        gradientType: 'linear',
        stops: (v.stops as string[]).map((color, i) => ({ color, offset: n > 1 ? (i * MAX_GRADIENT_OFFSET) / (n - 1) : 0 })),
        angleDeg: inRange(v.angleDeg, 360) ? v.angleDeg : 0,
      };
    }
  }
  return FALLBACK_COLOR_VALUE;
}
