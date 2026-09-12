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
 * How far inside the box the widest drawn stroke's outer edge is kept.
 *
 * It is NOT just anti-aliasing slack (which is what the 1px this replaced was meant to be): the
 * outermost glow layer is a HARD-edged stroke, not a blur that tapers to nothing, so wherever its
 * boundary lands is a visible straight cut across the whole element. At 1px that cut sat one or
 * two pixels from the box on every edge at every configuration (measured on real resvg rasters),
 * which — composited over a background that keeps going past the box — the eye reads as the line
 * spilling out of its box rather than living inside it. That was the residual half of the
 * "equalizer overflows its box" report the margin was first added for.
 */
export const EDGE_CLEARANCE_PX = 3;

// The outermost layer widthsFor draws is `glowRadius + GLOW_LAYER_PAD` wide (its `+ 0.4` floor,
// which also keeps the innermost, zero-radius layer from vanishing).
const GLOW_LAYER_PAD = 0.4;
// The most of its smaller side a box can give away to margin on each edge and still have an
// amplitude worth drawing a line into.
const MAX_MARGIN_SHARE = 4;

/** The inset, and the stroke widths, one element's box actually gets — see pulseGeometry. */
export interface PulseGeometry {
  margin: number;
  glowRadius: number;
  coreWidth: number;
}

/**
 * The single source of truth for "how big is this element's box, how far in does the line sit,
 * and how wide may the strokes be" — read by BOTH layoutPulsePoints (for the inset) and
 * buildPulseSvg (for the stroke widths).
 *
 * That sharing is the point. They used to derive their geometry independently: the layout capped
 * its inset at a quarter of the box's smaller side when the configured glow was too wide to fit,
 * but the renderer went on drawing that glow at its full configured width — so a box that could
 * not hold its glow got the brightest layers painted straight onto its outermost rows and
 * columns. Verified on real resvg rasters before this fix: alpha 13-27 on row 0 and on both
 * outermost columns for a 1280x120 bar at glowRadius 70, and for a 600x60 bar at the default
 * glowRadius 42 — both entirely ordinary element sizes (the visual editor's own default new
 * element is 400x150, and the default style's 42px glow stops fitting below 92px of height).
 *
 * So when the configured glow doesn't fit, the STROKES shrink to what the box can hold rather
 * than being drawn at full width and chopped at the edge by the rasterizer. Every box at least
 * 4 * (EDGE_CLEARANCE_PX + 1) px on its smaller side keeps the full clearance; below that (a
 * degenerate element no editor produces) the line degrades to a hairline instead.
 */
export function pulseGeometry(style: PulseLayout): PulseGeometry {
  const wanted = strokeMarginPx(style);
  const maxMargin = Math.floor(Math.min(style.width, style.height) / MAX_MARGIN_SHARE);
  if (wanted <= maxMargin) return { margin: wanted, glowRadius: style.glowRadius, coreWidth: style.coreWidth };
  const margin = Math.max(0, maxMargin);
  // The widest stroke this box can hold with the clearance intact. Round caps and joins reach
  // exactly half a stroke's width in every direction, so half of this is the drawn reach.
  const widest = Math.max(0, 2 * (margin - EDGE_CLEARANCE_PX));
  return {
    margin,
    glowRadius: Math.max(0, widest - GLOW_LAYER_PAD),
    coreWidth: Math.min(style.coreWidth, widest),
  };
}

/**
 * The inset a configured style asks for: half of the widest stroke (the outermost glow layer,
 * `glowRadius + GLOW_LAYER_PAD` wide — see widthsFor — or the core if that is wider), plus
 * EDGE_CLEARANCE_PX. Whether the box can actually afford it is pulseGeometry's decision.
 */
export function strokeMarginPx(style: Pick<PulseStyle, 'glowRadius' | 'coreWidth'>): number {
  return Math.ceil(Math.max(style.glowRadius + GLOW_LAYER_PAD, style.coreWidth) / 2) + EDGE_CLEARANCE_PX;
}

/**
 * Maps the engine's per-band values (0..MAX_VALUE) onto polyline points inside the element's box.
 * The polyline is inset from every edge by pulseGeometry's margin so that the WHOLE stroke — the
 * glow included — lands inside [0, width] x [0, height] with EDGE_CLEARANCE_PX to spare: the
 * baseline sits at the vertical centre and the loudest value reaches exactly the top margin. The
 * original layout ran the line from x=0 to x=width and up to y=0 and let the strokes paint past
 * the canvas on every side, where the rasterizer chopped them flat at the box edge (a real
 * deployed stream showed the glow cut off at / reaching past the element's rectangle).
 */
export function layoutPulsePoints(values: readonly number[], style: PulseLayout): PulsePoint[] {
  const { margin } = pulseGeometry(style);
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
    out.push(glowRadius * Math.pow(1 - f, 1.5) + GLOW_LAYER_PAD);
  }
  return out;
}

// Renders the approved "neon pulse" look: several layered, increasingly-narrow, increasingly-
// opaque translucent strokes (the glow) plus one bright thin core stroke, all following the same
// angular (straight-segment) path. See PulseVisualizer for how `points` gets computed from real
// audio, and pulseRenderWorker.ts for how this string gets rasterized.
export function buildPulseSvg(points: PulsePoint[], style: PulseStyle): string {
  const { width, height, colors, glowLayers } = style;
  // NOT style.glowRadius/style.coreWidth directly: a box too small for its configured glow gets a
  // shrunk one, so that what is drawn always fits inside the inset layoutPulsePoints laid the
  // points out with. See pulseGeometry for the drift this closes.
  const { glowRadius, coreWidth } = pulseGeometry(style);
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
