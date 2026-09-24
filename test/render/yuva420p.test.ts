import { rgbaToYuva420p, transparentYuva420p, yuva420pFrameSize, blitYuva420p } from '../../src/render/yuva420p';

describe('yuva420p', () => {
  it('frame size is 2.5 bytes per pixel', () => {
    expect(yuva420pFrameSize(4, 2)).toBe(20);
  });
  it('transparent frame: Y=16, U=V=128, A=0', () => {
    const f = transparentYuva420p(4, 2);
    expect([...f.subarray(0, 8)]).toEqual(Array(8).fill(16));
    expect([...f.subarray(8, 10)]).toEqual([128, 128]);
    expect([...f.subarray(10, 12)]).toEqual([128, 128]);
    expect([...f.subarray(12, 20)]).toEqual(Array(8).fill(0));
  });
  it('BT.601 limited range: white, black, pure red', () => {
    const px = (r: number, g: number, b: number, a = 255) => Uint8Array.from([r, g, b, a, r, g, b, a, r, g, b, a, r, g, b, a]);
    const white = rgbaToYuva420p(px(255, 255, 255), 2, 2);
    expect([white[0], white[4], white[5], white[6]]).toEqual([235, 128, 128, 255]);
    const black = rgbaToYuva420p(px(0, 0, 0), 2, 2);
    expect([black[0], black[4], black[5]]).toEqual([16, 128, 128]);
    const red = rgbaToYuva420p(px(255, 0, 0), 2, 2);
    expect([red[0], red[4], red[5]]).toEqual([81, 90, 240]);
  });
  it('alpha copied at full resolution', () => {
    const rgba = Uint8Array.from([0, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0, 30, 0, 0, 0, 40]);
    const f = rgbaToYuva420p(rgba, 2, 2);
    expect([...f.subarray(6, 10)]).toEqual([10, 20, 30, 40]);
  });
});

describe('blitYuva420p', () => {
  it('copies a small yuva420p frame\'s Y/U/V/A planes into a sub-rectangle of a larger one, at an even offset', () => {
    const dest = transparentYuva420p(4, 4); // Y=16 x16, U=V=128 x4, A=0 x16
    const px = (r: number, g: number, b: number, a: number) => Uint8Array.from([r, g, b, a, r, g, b, a, r, g, b, a, r, g, b, a]);
    const src = rgbaToYuva420p(px(255, 255, 255, 255), 2, 2); // Y=235 x4, U=V=128 x1, A=255 x4

    blitYuva420p(dest, 4, 4, src, 2, 2, 2, 2); // bottom-right 2x2 quadrant

    // Y plane: 4x4, row-major. Rows 2-3, cols 2-3 should now be 235; everything else stays 16.
    const y = (x: number, yy: number) => dest[yy * 4 + x];
    expect(y(2, 2)).toBe(235);
    expect(y(3, 2)).toBe(235);
    expect(y(2, 3)).toBe(235);
    expect(y(3, 3)).toBe(235);
    expect(y(0, 0)).toBe(16);
    expect(y(1, 3)).toBe(16);

    // A plane: dest's A plane starts at offset 16 (Y) + 4 (U) + 4 (V) = 24.
    const aOff = 16 + 4 + 4;
    expect(dest[aOff + 2 * 4 + 2]).toBe(255);
    expect(dest[aOff + 0]).toBe(0);

    // U/V planes: dest is 4x4 -> chroma is 2x2 (offsets 16 for U, 20 for V). The blit's own
    // chroma is 1x1 (src is 2x2), placed at chroma position (1,1) of dest's 2x2 chroma plane.
    expect(dest[16 + 1 * 2 + 1]).toBe(128); // U
    expect(dest[20 + 1 * 2 + 1]).toBe(128); // V
  });
});
