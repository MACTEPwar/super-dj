import renderPulseFrame from '../../src/render/pulseRenderWorker';
import { buildPulseSvg } from '../../src/render/pulseSvg';

describe('renderPulseFrame (real resvg, no piscina)', () => {
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
