import { buildPulseSvg, layoutPulsePoints, strokeMarginPx, pulseGeometry, EDGE_CLEARANCE_PX } from '../../src/render/pulseSvg';
import { MAX_VALUE } from '../../src/audio/pulseEngine';

// The widest thing buildPulseSvg draws, for a given effective glow/core — see widthsFor.
function widestStroke(glowRadius: number, coreWidth: number): number {
  return Math.max(glowRadius + 0.4, coreWidth);
}

describe('strokeMarginPx', () => {
  it('covers half of the widest glow layer (glowRadius + 0.4) plus the edge clearance', () => {
    expect(strokeMarginPx({ glowRadius: 40, coreWidth: 2 })).toBe(21 + EDGE_CLEARANCE_PX); // ceil(40.4 / 2) + clearance
    expect(strokeMarginPx({ glowRadius: 42, coreWidth: 1 })).toBe(22 + EDGE_CLEARANCE_PX);
  });

  it('is governed by the core when that is wider than the glow', () => {
    expect(strokeMarginPx({ glowRadius: 10, coreWidth: 50 })).toBe(25 + EDGE_CLEARANCE_PX);
  });
});

// layoutPulsePoints and buildPulseSvg used to derive their geometry independently: the layout
// capped its inset for a box that could not hold the configured glow, while the renderer went on
// drawing that glow at its full configured width — so those boxes painted their brightest layers
// right onto the outermost rows/columns (measured against a real resvg raster: alpha 13-27 on
// row 0 and both outermost columns for a 1280x120 bar at glowRadius 70). This is the one place
// either of them gets those numbers from now, so the two cannot drift apart again.
describe('pulseGeometry', () => {
  it('keeps the configured glow, and the clearance it needs, in a box that can hold both', () => {
    const geometry = pulseGeometry({ width: 400, height: 150, glowRadius: 42, coreWidth: 1 });
    expect(geometry.glowRadius).toBe(42);
    expect(geometry.coreWidth).toBe(1);
    expect(geometry.sideMargin - widestStroke(42, 1) / 2).toBeGreaterThanOrEqual(EDGE_CLEARANCE_PX);
    // The vertical margin carries the extra proportional clearance share on top of the same
    // stroke reach the side margin covers, so it's always at least as large as the side margin.
    expect(geometry.verticalMargin).toBeGreaterThanOrEqual(geometry.sideMargin);
  });

  it('shrinks the drawn glow — not just the inset — for a box that cannot hold the configured one', () => {
    const box = { width: 1280, height: 120, glowRadius: 70, coreWidth: 6 };
    const geometry = pulseGeometry(box);
    expect(geometry.glowRadius).toBeLessThan(box.glowRadius);
    expect(geometry.coreWidth).toBeLessThanOrEqual(box.coreWidth);
    expect(geometry.sideMargin - widestStroke(geometry.glowRadius, geometry.coreWidth) / 2)
      .toBeGreaterThanOrEqual(EDGE_CLEARANCE_PX);
  });

  it('never lets the auto-shrunk stroke go degenerate (zero/negative) across the realistic parameter space', () => {
    for (const width of [80, 200, 400, 1280]) {
      for (const height of [20, 60, 120, 150, 400, 720]) {
        for (const glowRadius of [10, 42, 70]) {
          for (const coreWidth of [1, 6]) {
            const geometry = pulseGeometry({ width, height, glowRadius, coreWidth });
            expect(geometry.glowRadius).toBeGreaterThanOrEqual(0);
            expect(geometry.coreWidth).toBeGreaterThanOrEqual(0);
            expect(geometry.sideMargin).toBeGreaterThan(0);
            expect(geometry.verticalMargin).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('leaves the widest drawn stroke clear of every edge across the whole configurable range', () => {
    for (const width of [80, 200, 400, 1280]) {
      for (const height of [20, 60, 120, 150, 400, 720]) {
        for (const glowRadius of [10, 42, 70]) {
          for (const coreWidth of [1, 6]) {
            const geometry = pulseGeometry({ width, height, glowRadius, coreWidth });
            const reach = widestStroke(geometry.glowRadius, geometry.coreWidth) / 2;
            expect(geometry.sideMargin - reach).toBeGreaterThanOrEqual(EDGE_CLEARANCE_PX);
            expect(geometry.verticalMargin - reach).toBeGreaterThanOrEqual(EDGE_CLEARANCE_PX);
            // The vertical margin must never eat so much of the box that no amplitude is left
            // (guaranteed by MIN_AMPLITUDE_SHARE): at least some of the height stays drawable.
            expect(2 * geometry.verticalMargin).toBeLessThan(height);
          }
        }
      }
    }
  });

  it('guarantees at least MIN_AMPLITUDE_SHARE (45%) of the box height stays drawable amplitude', () => {
    // The formula solves for exactly 45% in the continuous case; pixel-rounding (Math.ceil on
    // both the top and bottom margin) can shave a little off in practice, so allow the couple of
    // rounding pixels that costs against a short box rather than requiring an exact 45.0%.
    for (const width of [80, 200, 400, 1280]) {
      for (const height of [60, 120, 150, 400, 720]) {
        for (const glowRadius of [10, 42, 70]) {
          for (const coreWidth of [1, 6]) {
            const geometry = pulseGeometry({ width, height, glowRadius, coreWidth });
            const amplitude = height - 2 * geometry.verticalMargin;
            const roundingSlack = 4 / height; // up to ~2px of ceil() rounding on each margin
            expect(amplitude / height).toBeGreaterThanOrEqual(0.45 - roundingSlack);
          }
        }
      }
    }
  });
});

describe('layoutPulsePoints', () => {
  const box = { width: 400, height: 150, glowRadius: 42, coreWidth: 1 };
  const { sideMargin, verticalMargin } = pulseGeometry(box);

  it('insets the polyline horizontally by the side margin and vertically by the vertical margin', () => {
    const points = layoutPulsePoints([MAX_VALUE, 0, MAX_VALUE], box);
    expect(points[0].x).toBe(sideMargin);
    expect(points[2].x).toBe(400 - sideMargin);
    expect(points[0].y).toBe(verticalMargin); // the loudest value reaches exactly the top margin, never above it
    expect(points[1].y).toBe(150 - verticalMargin); // the resting/baseline value sits at the bottom-anchored baseline
  });

  it('is bottom-anchored: the baseline sits near the bottom of the box, not the vertical centre', () => {
    const [p] = layoutPulsePoints([0], box);
    expect(p.y).toBe(150 - verticalMargin);
    // Bottom-anchoring only means something if the baseline is well below the old centre (75).
    expect(p.y).toBeGreaterThan(75);
  });

  it('keeps the line proportions of the un-inset layout: a level of 1.0 sits at 80% of the usable amplitude', () => {
    const [p] = layoutPulsePoints([1], box);
    const baseline = 150 - verticalMargin;
    const amplitude = 150 - 2 * verticalMargin;
    expect(p.y).toBeCloseTo(baseline - 0.8 * amplitude, 6);
  });

  it('spreads the points evenly across the inset width', () => {
    const points = layoutPulsePoints([0, 0, 0, 0, 0], box);
    const usable = 400 - 2 * sideMargin;
    expect(points.map((p) => p.x)).toEqual([0, 0.25, 0.5, 0.75, 1].map((f) => sideMargin + f * usable));
  });

  it('caps the margin for a box smaller than its own glow (the glow itself shrinks to match)', () => {
    const smallBox = { width: 60, height: 40, glowRadius: 70, coreWidth: 1 };
    const geo = pulseGeometry(smallBox);
    const points = layoutPulsePoints([MAX_VALUE, MAX_VALUE], smallBox);
    expect(points[0].x).toBe(geo.sideMargin);
    expect(points[1].x).toBe(60 - geo.sideMargin);
    expect(points[0].y).toBe(geo.verticalMargin);
    // ...and buildPulseSvg draws a glow that fits inside that inset rather than the configured
    // 70px one, which is what used to paint onto the box's outermost pixels.
    expect(geo.glowRadius).toBeLessThan(2 * (geo.sideMargin - EDGE_CLEARANCE_PX));
  });

  it('never maps a value above MAX_VALUE past the top margin', () => {
    const [p] = layoutPulsePoints([MAX_VALUE * 4], box);
    expect(p.y).toBe(verticalMargin);
  });
});

describe('buildPulseSvg', () => {
  const points = [{ x: 0, y: 75 }, { x: 200, y: 20 }, { x: 400, y: 75 }];
  const style = { width: 400, height: 150, colors: ['#3b6fff', '#ff2f6e', '#3bdcff'], glowLayers: 3, glowRadius: 40, coreWidth: 2 };

  it('includes one gradient stop per configured color, in order', () => {
    const svg = buildPulseSvg(points, style);
    expect(svg).toContain('stop-color="#3b6fff"');
    expect(svg).toContain('stop-color="#ff2f6e"');
    expect(svg).toContain('stop-color="#3bdcff"');
    expect((svg.match(/<stop /g) || []).length).toBe(3);
  });

  it('draws one glow-layer <path> per glowLayers, plus one bright core path', () => {
    const svg = buildPulseSvg(points, style);
    expect((svg.match(/<path /g) || []).length).toBe(style.glowLayers + 1);
  });

  it('the outermost glow layer stroke-width is derived from glowRadius', () => {
    const svg = buildPulseSvg(points, style);
    expect(svg).toContain('stroke-width="40.40"');
  });

  it('the core path uses coreWidth and a solid bright color, not the gradient', () => {
    const svg = buildPulseSvg(points, style);
    expect(svg).toContain('stroke="#fbf3ff" stroke-width="2"');
  });

  it('traces a straight-segment polyline through every point (angular, not smoothed)', () => {
    const svg = buildPulseSvg(points, style);
    expect(svg).toContain('M 0.00 75.00 L 200.00 20.00 L 400.00 75.00');
  });

  it('sets the declared svg size from style.width/height', () => {
    const svg = buildPulseSvg(points, style);
    expect(svg).toContain('width="400" height="150" viewBox="0 0 400 150"');
  });

  // The half of the two-module drift that lived here: the renderer used to draw the configured
  // glow at full width no matter how little inset layoutPulsePoints had actually been able to
  // give it. Both now read the same pulseGeometry.
  it('draws the box-limited glow, not the configured one, when the box cannot hold the configured glow', () => {
    const smallBox = { ...style, width: 1280, height: 120, glowRadius: 70, coreWidth: 6 };
    const svg = buildPulseSvg(points, smallBox);
    const geometry = pulseGeometry(smallBox);
    expect(svg).toContain(`stroke-width="${(geometry.glowRadius + 0.4).toFixed(2)}"`);
    expect(svg).not.toContain('stroke-width="70.40"');
    expect(svg).toContain(`stroke="#fbf3ff" stroke-width="${geometry.coreWidth}"`);
  });
});
