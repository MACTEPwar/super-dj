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

  it('handles asymmetric offset x != y (x=2, y=0)', () => {
    const dest = transparentYuva420p(4, 4);
    const px = (r: number, g: number, b: number, a: number) => Uint8Array.from([r, g, b, a, r, g, b, a, r, g, b, a, r, g, b, a]);
    const src = rgbaToYuva420p(px(255, 0, 0, 200), 2, 2); // Red with alpha=200

    blitYuva420p(dest, 4, 4, src, 2, 2, 2, 0); // x=2, y=0: top-right 2x2 quadrant

    // Y plane: rows 0-1, cols 2-3 should be red (approx 81)
    const y = (x: number, yy: number) => dest[yy * 4 + x];
    expect(y(2, 0)).toBe(81);
    expect(y(3, 1)).toBe(81);
    expect(y(0, 0)).toBe(16); // unchanged
    expect(y(1, 0)).toBe(16); // unchanged, adjacent to blit

    // A plane at (2,0) and (3,1)
    const aOff = 16 + 4 + 4;
    expect(dest[aOff + 0 * 4 + 2]).toBe(200); // (2, 0)
    expect(dest[aOff + 1 * 4 + 3]).toBe(200); // (3, 1)
    expect(dest[aOff + 0 * 4 + 1]).toBe(0);  // (1, 0) adjacent, unchanged
  });

  it('handles non-2x dest/src size ratio (dest 6x4, src 2x2)', () => {
    const dest = transparentYuva420p(6, 4); // Y=24, U=V=6 each, A=24; destCw=3
    const px = (r: number, g: number, b: number, a: number) => Uint8Array.from([r, g, b, a, r, g, b, a, r, g, b, a, r, g, b, a]);
    const src = rgbaToYuva420p(px(0, 255, 0, 150), 2, 2); // Green with alpha=150

    blitYuva420p(dest, 6, 4, src, 2, 2, 2, 2); // offset (2, 2)

    // Y plane: rows 2-3, cols 2-3 should be green (approx 145)
    const y = (x: number, yy: number) => dest[yy * 6 + x];
    expect(y(2, 2)).toBe(145);
    expect(y(3, 3)).toBe(145);
    expect(y(0, 0)).toBe(16); // unchanged
    expect(y(1, 2)).toBe(16); // adjacent, unchanged

    // A plane: offset = 24 (Y) + 6 (U) + 6 (V) = 36
    const aOff = 24 + 6 + 6;
    expect(dest[aOff + 2 * 6 + 2]).toBe(150); // (2, 2)
    expect(dest[aOff + 2 * 6 + 1]).toBe(0);  // (1, 2) adjacent, unchanged

    // U/V planes: exercises odd chroma stride (destCw=3, not a power of two).
    // dest is 6x4 -> chroma is 3x2. The blit's chroma (1x1 for src 2x2) is placed at chroma
    // position (1, 1) of dest's 3x2 chroma plane (offset = baseOff + 1*destCw + 1 = baseOff + 4).
    // Green (0, 255, 0) with BT.601 gives U ≈ 54, V ≈ 34.
    expect(dest[24 + 1 * 3 + 1]).toBe(54); // U plane
    expect(dest[30 + 1 * 3 + 1]).toBe(34); // V plane
    expect(dest[24 + 0 * 3 + 0]).toBe(128); // U (0,0) unchanged
    expect(dest[30 + 0 * 3 + 0]).toBe(128); // V (0,0) unchanged
  });

  it('handles placement at (0,0)', () => {
    const dest = transparentYuva420p(4, 4);
    const px = (r: number, g: number, b: number, a: number) => Uint8Array.from([r, g, b, a, r, g, b, a, r, g, b, a, r, g, b, a]);
    const src = rgbaToYuva420p(px(0, 0, 255, 100), 2, 2); // Blue with alpha=100

    blitYuva420p(dest, 4, 4, src, 2, 2, 0, 0); // top-left corner

    // Y plane: rows 0-1, cols 0-1 should be blue (approx 41)
    const y = (x: number, yy: number) => dest[yy * 4 + x];
    expect(y(0, 0)).toBe(41);
    expect(y(1, 1)).toBe(41);
    expect(y(2, 0)).toBe(16); // outside, unchanged

    // A plane
    const aOff = 16 + 4 + 4;
    expect(dest[aOff + 0]).toBe(100); // (0, 0)
    expect(dest[aOff + 1]).toBe(100); // (1, 0)
  });
});
