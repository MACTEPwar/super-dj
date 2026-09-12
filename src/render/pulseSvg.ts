import { MAX_VALUE } from '../audio/pulseEngine';

export interface PulsePoint { x: number; y: number; }

export interface PulseStyle {
  width: number;
  height: number;
  colors: string[];
  glowLayers: number;
  glowRadius: number;
  coreWidth: number;
}

// The geometry layoutPulsePoints needs: the box plus the two stroke widths that decide how far
// the drawn strokes reach past the polyline itself.
export type PulseLayout = Pick<PulseStyle, 'width' | 'height' | 'glowRadius' | 'coreWidth'>;

/**
 * How far the drawn strokes extend past the polyline on every side: half of the widest stroke
 * (the outermost glow layer, `glowRadius + 0.4` wide — see widthsFor — or the core if that is
 * wider; round caps and joins reach exactly half the width in every direction), plus one pixel
 * for anti-aliasing.
 */
export function strokeMarginPx(style: Pick<PulseStyle, 'glowRadius' | 'coreWidth'>): number {
  return Math.ceil(Math.max(style.glowRadius + 0.4, style.coreWidth) / 2) + 1;
}

/**
 * Maps the engine's per-band values (0..MAX_VALUE) onto polyline points inside the element's box.
 * The polyline is inset from every edge by strokeMarginPx so that the WHOLE stroke — the glow
 * included — lands inside [0, width] x [0, height]: the baseline sits at the vertical centre and
 * the loudest value reaches exactly the top margin. The previous layout ran the line from x=0
 * to x=width and up to y=0 and let the strokes paint past the canvas on every side, where the
 * rasterizer chopped them flat at the box edge (a real deployed stream showed the glow cut off
 * at / reaching past the element's rectangle). A box smaller than its own glow can't hold it:
 * the margin is capped at a quarter of the box's smaller side so a line is still drawn there,
 * and that glow clips, unavoidably.
 */
export function layoutPulsePoints(values: readonly number[], style: PulseLayout): PulsePoint[] {
  const margin = Math.min(strokeMarginPx(style), Math.floor(Math.min(style.width, style.height) / 4));
  const n = values.length;
  const usableWidth = style.width - 2 * margin;
  const baseline = style.height / 2;
  const amplitude = baseline - margin;
  return values.map((v, i) => ({
    x: margin + (n > 1 ? i / (n - 1) : 0.5) * usableWidth,
    y: baseline - (Math.min(MAX_VALUE, Math.max(0, v)) / MAX_VALUE) * amplitude,
  }));
}

function pathD(points: PulsePoint[]): string {
  return 'M ' + points.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' L ');
}

// Low exponent keeps the mid layers relatively wide, so the glow itself rounds off the
// polyline's angular joints instead of tracing them sharply — validated in the browser prototype
// during this feature's design.
function widthsFor(glowRadius: number, glowLayers: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < glowLayers; i++) {
    const f = i / (glowLayers - 1);
    out.push(glowRadius * Math.pow(1 - f, 1.5) + 0.4);
  }
  return out;
}

// Renders the approved "neon pulse" look: several layered, increasingly-narrow, increasingly-
// opaque translucent strokes (the glow) plus one bright thin core stroke, all following the same
// angular (straight-segment) path. See PulseVisualizer for how `points` gets computed from real
// audio, and pulseRenderWorker.ts for how this string gets rasterized.
export function buildPulseSvg(points: PulsePoint[], style: PulseStyle): string {
  const { width, height, colors, glowLayers, glowRadius, coreWidth } = style;
  const d = pathD(points);
  const widths = widthsFor(glowRadius, glowLayers);
  const stops = colors
    .map((color, i) => `<stop offset="${(i / (colors.length - 1)).toFixed(3)}" stop-color="${color}"/>`)
    .join('');
  const layers = widths
    .map((w, i) => {
      const t = i / (widths.length - 1);
      const alpha = Math.min(1, 0.05 + 0.45 * Math.pow(t, 2.2));
      return `<path d="${d}" fill="none" stroke="url(#g)" stroke-width="${w.toFixed(2)}" stroke-opacity="${alpha.toFixed(3)}" stroke-linejoin="round" stroke-linecap="round"/>`;
    })
    .join('');
  const core = `<path d="${d}" fill="none" stroke="#fbf3ff" stroke-width="${coreWidth}" stroke-linejoin="round" stroke-linecap="round"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">${stops}</linearGradient></defs>${layers}${core}</svg>`;
}
