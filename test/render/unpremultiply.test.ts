import { unpremultiplyRgbaInPlace } from '../../src/render/unpremultiply';

describe('unpremultiplyRgbaInPlace', () => {
  it('scales up a premultiplied color channel by 255/alpha', () => {
    // Verified against a real resvg + ffmpeg round-trip during design (see the design spec's
    // alpha spike): a 50%-alpha red renders as premultiplied (128, 0, 0, 128), and must become
    // (255, 0, 0, 128) for ffmpeg's straight-alpha rgba pix_fmt to composite it correctly.
    const pixels = Buffer.from([128, 0, 0, 128]);
    unpremultiplyRgbaInPlace(pixels);
    expect([...pixels]).toEqual([255, 0, 0, 128]);
  });

  it('leaves a fully opaque pixel unchanged', () => {
    const pixels = Buffer.from([10, 20, 30, 255]);
    unpremultiplyRgbaInPlace(pixels);
    expect([...pixels]).toEqual([10, 20, 30, 255]);
  });

  it('leaves a fully transparent pixel unchanged (nothing to recover)', () => {
    const pixels = Buffer.from([0, 0, 0, 0]);
    unpremultiplyRgbaInPlace(pixels);
    expect([...pixels]).toEqual([0, 0, 0, 0]);
  });

  it('processes every pixel in a multi-pixel buffer', () => {
    const pixels = Buffer.from([128, 0, 0, 128, 0, 64, 0, 128]);
    unpremultiplyRgbaInPlace(pixels);
    expect([...pixels]).toEqual([255, 0, 0, 128, 0, 128, 0, 128]);
  });
});
