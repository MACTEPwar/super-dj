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

/**
 * The engine's value range is one-directional (`v` in `[0, MAX_VALUE]`, pushing the line UP from
 * a resting baseline, never down — see `pulseEngine.ts`), and `globalPulse` routinely pins many
 * bands to that same ceiling at once. A margin sized only to clear the stroke itself (the old
 * `EDGE_CLEARANCE_PX`-flat rule) put the loudest value's flat plateau right at the thinnest
 * possible inset from the top edge — reading as clipping even though nothing was technically
 * drawn past the box. This is the extra share of the glow's own half-width kept as additional
 * empty space between its hard outer edge and the top/bottom edges, so the margin scales with how
 * wide the glow actually is rather than staying a flat few px regardless.
 */
const EDGE_CLEARANCE_SHARE = 0.75;

/**
 * The smallest share of the box height the drawable amplitude (the line's actual travel) may be
 * shrunk to, no matter how aggressively the configured glow would otherwise demand the vertical
 * margin grow. Without this a wide, tall glow on a short box could eat the entire box as margin
 * before ever shrinking itself.
 */
const MIN_AMPLITUDE_SHARE = 0.45;

/** The inset, and the stroke widths, one element's box actually gets — see pulseGeometry. */
export interface PulseGeometry {
  sideMargin: number;
  verticalMargin: number;
  glowRadius: number;
  coreWidth: number;
}

/**
 * The single source of truth for "how big is this element's box, how far in does the line sit,
 * and how wide may the strokes be" — read by BOTH layoutPulsePoints (for the inset) and
 * buildPulseSvg (for the stroke widths).
 *
 * That sharing is the point. They used to derive their geometry independently: the layout capped
 * its inset when the configured glow was too wide to fit, but the renderer went on drawing that
 * glow at its full configured width — so a box that could not hold its glow got the brightest
 * layers painted straight onto its outermost rows and columns. Verified on real resvg rasters
 * before that fix: alpha 13-27 on row 0 and on both outermost columns for a 1280x120 bar at
 * glowRadius 70, and for a 600x60 bar at the default glowRadius 42 — both entirely ordinary
 * element sizes (the visual editor's own default new element is 400x150, and the default style's
 * 42px glow stops fitting below 92px of height).
 *
 * So when the configured glow doesn't fit, the STROKES shrink to what the box can hold rather
 * than being drawn at full width and chopped at the edge by the rasterizer — solving for the
 * largest half-stroke that satisfies both the vertical rule (keeps at least MIN_AMPLITUDE_SHARE
 * of the height drawable) and the horizontal rule (unchanged: a quarter of the width, less the
 * flat clearance). Below the degenerate sizes that pushes to zero (no editor produces these) the
 * line degrades to a hairline instead.
 */
export function pulseGeometry(style: PulseLayout): PulseGeometry {
  const halfStroke = halfStrokePx(style);
  // The largest half-stroke the box can hold while still keeping MIN_AMPLITUDE_SHARE of its
  // height as drawable amplitude, and while still fitting the (unchanged) horizontal rule.
  const halfStrokeFitV = (style.height * (1 - MIN_AMPLITUDE_SHARE) / 2 - EDGE_CLEARANCE_PX) / (1 + EDGE_CLEARANCE_SHARE);
  const halfStrokeFitH = style.width / 4 - EDGE_CLEARANCE_PX;
  const halfStrokeMax = Math.max(0, Math.min(halfStrokeFitV, halfStrokeFitH));
  if (halfStroke <= halfStrokeMax) {
    return {
      sideMargin: sideMarginFor(halfStroke),
      verticalMargin: verticalMarginFor(halfStroke),
      glowRadius: style.glowRadius,
      coreWidth: style.coreWidth,
    };
  }
  // The widest stroke this box can hold with the clearance intact. Round caps and joins reach
  // exactly half a stroke's width in every direction, so half of this is the drawn reach.
  const widest = Math.max(0, 2 * halfStrokeMax);
  return {
    sideMargin: sideMarginFor(halfStrokeMax),
    verticalMargin: verticalMarginFor(halfStrokeMax),
    glowRadius: Math.max(0, widest - GLOW_LAYER_PAD),
    coreWidth: Math.min(style.coreWidth, widest),
  };
}

/**
 * Half of the widest stroke drawn (the outermost glow layer, `glowRadius + GLOW_LAYER_PAD` wide —
 * see widthsFor — or the core if that is wider): how far past the polyline itself the drawn paint
 * reaches on every side.
 */
function halfStrokePx(style: Pick<PulseStyle, 'glowRadius' | 'coreWidth'>): number {
  return Math.max(style.glowRadius + GLOW_LAYER_PAD, style.coreWidth) / 2;
}

/** The left/right inset: the stroke's reach plus a flat clearance — unchanged from before. */
function sideMarginFor(halfStroke: number): number {
  return Math.ceil(halfStroke) + EDGE_CLEARANCE_PX;
}

/**
 * The top/bottom inset: the stroke's reach plus a clearance that is itself a share of that
 * reach — proportional, not flat, so a wide glow's hard edge stays visibly clear of the top/
 * bottom edges instead of sitting the bare minimum away from them. See EDGE_CLEARANCE_SHARE.
 */
function verticalMarginFor(halfStroke: number): number {
  return Math.ceil(halfStroke * (1 + EDGE_CLEARANCE_SHARE)) + EDGE_CLEARANCE_PX;
}

/**
 * The inset a configured style asks for on the left/right: half of the widest stroke (the
 * outermost glow layer, `glowRadius + GLOW_LAYER_PAD` wide — see widthsFor — or the core if that
 * is wider), plus EDGE_CLEARANCE_PX. Whether the box can actually afford it is pulseGeometry's
 * decision.
 */
export function strokeMarginPx(style: Pick<PulseStyle, 'glowRadius' | 'coreWidth'>): number {
  return sideMarginFor(halfStrokePx(style));
}

/**
 * Maps the engine's per-band values (0..MAX_VALUE) onto polyline points inside the element's box.
 * The polyline is inset from the left/right edges by pulseGeometry's sideMargin and from the
 * top/bottom by its verticalMargin, so that the WHOLE stroke — the glow included — lands inside
 * [0, width] x [0, height] with real room to spare rather than the bare minimum.
 *
 * The engine's value range is one-directional (v in [0, MAX_VALUE], only ever pushing the line UP
 * from a resting position, never down), so the layout is bottom-anchored, not centered: the
 * baseline sits at `height - verticalMargin` and the loudest value reaches exactly the top margin.
 * Centering the baseline (the original design) put the resting/silent line in the middle of the
 * box while permanently leaving 30-50%+ of the box below it empty (v never goes negative) — bottom-
 * anchoring reclaims that dead space as usable amplitude instead. This was a deliberate choice
 * (over keeping the baseline centered with a smaller amplitude), made explicitly by the user
 * during this fix's design.
 */
export function layoutPulsePoints(values: readonly number[], style: PulseLayout): PulsePoint[] {
  const { sideMargin, verticalMargin } = pulseGeometry(style);
  const n = values.length;
  const usableWidth = style.width - 2 * sideMargin;
  const baseline = style.height - verticalMargin;
  const amplitude = style.height - 2 * verticalMargin;
  return values.map((v, i) => ({
    x: sideMargin + (n > 1 ? i / (n - 1) : 0.5) * usableWidth,
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
