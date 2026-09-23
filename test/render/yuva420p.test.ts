import { rgbaToYuva420p, transparentYuva420p, yuva420pFrameSize } from '../../src/render/yuva420p';

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
