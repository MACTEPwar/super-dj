import { buildPulseSvg } from '../../src/render/pulseSvg';

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
