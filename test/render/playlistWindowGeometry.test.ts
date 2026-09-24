import { computePlaylistWindowRegion } from '../../src/render/playlistWindowGeometry';

const el = (over: any = {}) => ({ type: 'playlist' as const, x: 512, y: 160, width: 700, fontSize: 22,
  color: { mode: 'solid' as const, color: '#fff' }, style: { fontFamily: 'DejaVu Sans', bold: false, italic: false }, ...over });
const CANVAS = { width: 1280, height: 720 };

describe('computePlaylistWindowRegion', () => {
  it('default template: 704x342 at (510,158)', () => {
    expect(computePlaylistWindowRegion(el(), CANVAS, 10)).toEqual({ x: 510, y: 158, width: 704, height: 342, originX: 2, originY: 2 });
  });
  it('odd origin -> even origin and even size, element origin preserved', () => {
    const r = computePlaylistWindowRegion(el({ x: 141, y: 501 }), CANVAS, 10)!;
    expect([r.x % 2, r.y % 2, r.width % 2, r.height % 2]).toEqual([0, 0, 0, 0]);
    expect(r.x + r.originX).toBe(141);
    expect(r.y + r.originY).toBe(501);
  });
  it('clamps to the canvas', () => {
    const r = computePlaylistWindowRegion(el({ x: 1000, y: 600 }), CANVAS, 10)!;
    expect(r.x + r.width).toBeLessThanOrEqual(1280);
    expect(r.y + r.height).toBeLessThanOrEqual(720);
  });
  it('pads for stroke and shadow', () => {
    const r = computePlaylistWindowRegion(el({ style: { fontFamily: 'DejaVu Sans', bold: false, italic: false, stroke: { width: 3, color: '#000' }, shadow: { offsetX: 4, offsetY: -2, blur: 6, color: '#000' } } }), CANVAS, 10)!;
    expect(r.originX).toBeGreaterThanOrEqual(15);
  });
  it('null when entirely off-canvas', () => {
    expect(computePlaylistWindowRegion(el({ x: 1400 }), CANVAS, 10)).toBeNull();
  });
});
