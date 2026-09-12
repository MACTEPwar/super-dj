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
    expect(geometry.margin - widestStroke(42, 1) / 2).toBeGreaterThanOrEqual(EDGE_CLEARANCE_PX);
  });

  it('shrinks the drawn glow — not just the inset — for a box that cannot hold the configured one', () => {
    const box = { width: 1280, height: 120, glowRadius: 70, coreWidth: 6 };
    const geometry = pulseGeometry(box);
    expect(geometry.glowRadius).toBeLessThan(box.glowRadius);
    expect(geometry.coreWidth).toBeLessThanOrEqual(box.coreWidth);
    expect(geometry.margin - widestStroke(geometry.glowRadius, geometry.coreWidth) / 2)
      .toBeGreaterThanOrEqual(EDGE_CLEARANCE_PX);
  });

  it('leaves the widest drawn stroke clear of every edge across the whole configurable range', () => {
    for (const width of [80, 200, 400, 1280]) {
      for (const height of [20, 60, 120, 150, 400, 720]) {
        for (const glowRadius of [10, 42, 70]) {
          for (const coreWidth of [1, 6]) {
            const geometry = pulseGeometry({ width, height, glowRadius, coreWidth });
            const reach = widestStroke(geometry.glowRadius, geometry.coreWidth) / 2;
            expect(geometry.margin - reach).toBeGreaterThanOrEqual(EDGE_CLEARANCE_PX);
            // A margin that ate the whole box would leave no line to draw at all.
            expect(geometry.margin).toBeLessThan(height / 2);
          }
        }
      }
    }
  });
});

describe('layoutPulsePoints', () => {
  const box = { width: 400, height: 150, glowRadius: 42, coreWidth: 1 }; // margin 25
  const margin = pulseGeometry(box).margin;

  it('insets the polyline by the stroke margin on every side so the whole glow lands inside the box', () => {
    const points = layoutPulsePoints([MAX_VALUE, 0, MAX_VALUE], box);
    expect(points[0].x).toBe(margin);
    expect(points[2].x).toBe(400 - margin);
    expect(points[0].y).toBe(margin); // the loudest value reaches exactly the top margin, never above it
    expect(points[1].y).toBe(75); // the baseline stays at the vertical centre
  });

  it('keeps the line proportions of the un-inset layout: a level of 1.0 sits at 80% of the usable amplitude', () => {
    const [p] = layoutPulsePoints([1], box);
    expect(p.y).toBeCloseTo(75 - 0.8 * (75 - margin), 6);
  });

  it('spreads the points evenly across the inset width', () => {
    const points = layoutPulsePoints([0, 0, 0, 0, 0], box);
    const usable = 400 - 2 * margin;
    expect(points.map((p) => p.x)).toEqual([0, 0.25, 0.5, 0.75, 1].map((f) => margin + f * usable));
  });

  it('caps the margin for a box smaller than its own glow (the glow itself shrinks to match)', () => {
    const smallBox = { width: 60, height: 40, glowRadius: 70, coreWidth: 1 };
    const points = layoutPulsePoints([MAX_VALUE, MAX_VALUE], smallBox);
    expect(points[0].x).toBe(10); // floor(min(60, 40) / 4), not the 40px the configured glow would want
    expect(points[1].x).toBe(50);
    expect(points[0].y).toBe(10);
    // ...and buildPulseSvg draws a glow that fits inside that 10px inset rather than the
    // configured 70px one, which is what used to paint onto the box's outermost pixels.
    expect(pulseGeometry(smallBox).glowRadius).toBeLessThan(2 * (10 - EDGE_CLEARANCE_PX));
  });

  it('never maps a value above MAX_VALUE past the top margin', () => {
    const [p] = layoutPulsePoints([MAX_VALUE * 4], box);
    expect(p.y).toBe(margin);
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
