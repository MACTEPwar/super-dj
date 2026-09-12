import { buildPulseSvg, layoutPulsePoints, strokeMarginPx } from '../../src/render/pulseSvg';
import { MAX_VALUE } from '../../src/audio/pulseEngine';

describe('strokeMarginPx', () => {
  it('covers half of the widest glow layer (glowRadius + 0.4) plus a pixel of anti-aliasing', () => {
    expect(strokeMarginPx({ glowRadius: 40, coreWidth: 2 })).toBe(22); // ceil(40.4 / 2) + 1
    expect(strokeMarginPx({ glowRadius: 42, coreWidth: 1 })).toBe(23);
  });

  it('is governed by the core when that is wider than the glow', () => {
    expect(strokeMarginPx({ glowRadius: 10, coreWidth: 50 })).toBe(26);
  });
});

describe('layoutPulsePoints', () => {
  const box = { width: 400, height: 150, glowRadius: 42, coreWidth: 1 }; // margin 23

  it('insets the polyline by the stroke margin on every side so the whole glow lands inside the box', () => {
    const points = layoutPulsePoints([MAX_VALUE, 0, MAX_VALUE], box);
    expect(points[0].x).toBe(23);
    expect(points[2].x).toBe(377);
    expect(points[0].y).toBe(23); // the loudest value reaches exactly the top margin, never above it
    expect(points[1].y).toBe(75); // the baseline stays at the vertical centre
  });

  it('keeps the line proportions of the un-inset layout: a level of 1.0 sits at 80% of the usable amplitude', () => {
    const [p] = layoutPulsePoints([1], box);
    expect(p.y).toBeCloseTo(75 - 0.8 * (75 - 23), 6);
  });

  it('spreads the points evenly across the inset width', () => {
    const points = layoutPulsePoints([0, 0, 0, 0, 0], box);
    expect(points.map((p) => p.x)).toEqual([23, 111.5, 200, 288.5, 377]);
  });

  it('caps the margin for a box smaller than its own glow so a line is still drawn (that one clips, unavoidably)', () => {
    const points = layoutPulsePoints([MAX_VALUE, MAX_VALUE], { width: 60, height: 40, glowRadius: 70, coreWidth: 1 });
    expect(points[0].x).toBe(10); // floor(min(60, 40) / 4), not the 37px the glow would need
    expect(points[1].x).toBe(50);
    expect(points[0].y).toBe(10);
  });

  it('never maps a value above MAX_VALUE past the top margin', () => {
    const [p] = layoutPulsePoints([MAX_VALUE * 4], box);
    expect(p.y).toBe(23);
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
});
