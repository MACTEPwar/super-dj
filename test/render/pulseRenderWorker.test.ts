import renderPulseFrame from '../../src/render/pulseRenderWorker';
import { buildPulseSvg, layoutPulsePoints, EDGE_CLEARANCE_PX } from '../../src/render/pulseSvg';
import { MAX_VALUE } from '../../src/audio/pulseEngine';

// Max alpha over one row / one column of a rasterized RGBA frame.
function rowAlphaMax(pixels: Uint8Array, width: number, row: number): number {
  let m = 0;
  for (let x = 0; x < width; x++) m = Math.max(m, pixels[(row * width + x) * 4 + 3]);
  return m;
}
function colAlphaMax(pixels: Uint8Array, width: number, height: number, col: number): number {
  let m = 0;
  for (let y = 0; y < height; y++) m = Math.max(m, pixels[(y * width + col) * 4 + 3]);
  return m;
}

describe('renderPulseFrame (real resvg, no piscina)', () => {
  // A real deployed stream showed the glow chopped flat at / reaching past the element's box: the
  // polyline used to run from x=0 to x=width and up to y=0, so the strokes (up to glowRadius/2
  // wide on each side) painted past the declared canvas on every edge. Everything drawn must land
  // inside [0,width]x[0,height], for any glow/value combination — checked here on the actual
  // rasterized pixels, not on the coordinates, at the most extreme settings a template allows.
  it('never paints on the outermost row or column of the box, even at the loudest value with the widest glow', () => {
    const width = 400, height = 150;
    const style = { width, height, colors: ['#3b6fff', '#ff2f6e'], glowLayers: 9, glowRadius: 70, coreWidth: 6 };
    const cases = [
      new Array(56).fill(MAX_VALUE),                                // everything pinned to the top
      new Array(56).fill(0),                                        // flat baseline: glow below the line
      new Array(56).fill(0.1).map((v, i) => (i % 7 === 0 ? MAX_VALUE : v)), // needles, including the end points
    ];
    for (const values of cases) {
      const { pixels } = renderPulseFrame({ svg: buildPulseSvg(layoutPulsePoints(values, style), style) });
      expect(rowAlphaMax(pixels, width, 0)).toBe(0);
      expect(rowAlphaMax(pixels, width, height - 1)).toBe(0);
      expect(colAlphaMax(pixels, width, height, 0)).toBe(0);
      expect(colAlphaMax(pixels, width, height, width - 1)).toBe(0);
      // ...and it did actually draw something.
      let anyAlpha = 0;
      for (let y = 0; y < height; y++) anyAlpha = Math.max(anyAlpha, rowAlphaMax(pixels, width, y));
      expect(anyAlpha).toBeGreaterThan(0);
    }
  });

  // The fix above only moved the chop-off 1-2px inward: `strokeMarginPx` was the stroke's exact
  // geometric half-width plus a single pixel of anti-aliasing, and the widest glow layer is a
  // HARD-edged stroke (there is no blur that tapers to nothing), so its outer boundary still
  // landed a pixel or two from the box on every beat — which, composited over a background that
  // continues past the box, reads as the line spilling out of it. Worse, `layoutPulsePoints`
  // capped the margin for a box that can't hold its own glow while `buildPulseSvg` went on
  // drawing the full configured stroke widths, so those boxes painted right onto row/column 0.
  // Measured against this same real resvg path before the fix: clearance 0 with alpha 13-27 on
  // the outermost row and both outermost columns for a 1280x120 / glowRadius 70 bar, and 1-2px
  // for every box that did fit. Every configuration must now keep its paint at least
  // EDGE_CLEARANCE_PX away from every edge.
  it.each([
    ['the editor\'s own default new-equalizer box', 400, 150, 42, 1],
    ['that box with the glow turned up to the maximum', 400, 150, 70, 6],
    ['a short bar whose configured glow does not fit its height', 1280, 120, 70, 6],
    ['a small box far too short for its glow', 600, 60, 42, 1],
    ['a box only just wide enough to hold a hairline', 80, 20, 70, 6],
  ])('keeps every painted pixel clear of the box edge: %s', (_label, width, height, glowRadius, coreWidth) => {
    const style = { width, height, colors: ['#3b6fff', '#ff2f6e'], glowLayers: 9, glowRadius, coreWidth };
    const cases = [
      new Array(56).fill(MAX_VALUE),                                        // every band pinned to the top
      new Array(56).fill(0),                                                // flat baseline: glow below the line
      new Array(56).fill(0.1).map((v, i) => (i % 7 === 0 ? MAX_VALUE : v)), // needles, including the end points
    ];
    for (const values of cases) {
      const { pixels } = renderPulseFrame({ svg: buildPulseSvg(layoutPulsePoints(values, style), style) });
      let closest = Infinity;
      let anyAlpha = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const alpha = pixels[(y * width + x) * 4 + 3];
          anyAlpha = Math.max(anyAlpha, alpha);
          if (alpha === 0) continue;
          closest = Math.min(closest, y, height - 1 - y, x, width - 1 - x);
        }
      }
      expect(anyAlpha).toBeGreaterThan(0); // ...and it did actually draw something
      // One px of slack below the nominal clearance for the rasterizer's own anti-aliasing.
      expect(closest).toBeGreaterThanOrEqual(EDGE_CLEARANCE_PX - 1);
    }
  });

  const svg = buildPulseSvg(
    [{ x: 0, y: 75 }, { x: 200, y: 20 }, { x: 400, y: 75 }],
    { width: 400, height: 150, colors: ['#3b6fff', '#b23bff', '#ff2f6e', '#b23bff', '#3bdcff'], glowLayers: 9, glowRadius: 42, coreWidth: 1 },
  );

  it('rasterizes to the expected pixel dimensions with a real RGBA alpha channel', () => {
    const result = renderPulseFrame({ svg });
    expect(result.width).toBe(400);
    expect(result.height).toBe(150);
    expect(result.pixels.length).toBe(400 * 150 * 4);
  });

  // Regression guard for the design spec's real spike: Resvg's constructor scans every system
  // font by default (~130ms measured on the spec-writing machine), even for an SVG with zero
  // <text>. Without `font: { loadSystemFonts: false }` in the implementation, this fails on any
  // machine with a non-trivial font catalog — exactly how the original 141ms/frame regression
  // was found in the first place.
  it('renders well within a single 30fps frame budget (regression guard for loadSystemFonts)', () => {
    renderPulseFrame({ svg }); // warm up
    const start = process.hrtime.bigint();
    renderPulseFrame({ svg });
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    expect(ms).toBeLessThan(20);
  });
});
