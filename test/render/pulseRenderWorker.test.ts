import renderPulseFrame from '../../src/render/pulseRenderWorker';
import { buildPulseSvg, layoutPulsePoints } from '../../src/render/pulseSvg';
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
