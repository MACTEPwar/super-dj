export interface PulsePoint { x: number; y: number; }

export interface PulseStyle {
  width: number;
  height: number;
  colors: string[];
  glowLayers: number;
  glowRadius: number;
  coreWidth: number;
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
