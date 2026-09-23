// pipe:7's pixel format. yuva420p (2.5 B/px) rather than rgba (4 B/px): this pipe is fed
// continuously even while idle, so bytes per frame are the steady-state cost. The coefficients are
// BT.601 LIMITED range — swscale's default, which is what CanvasFeeder's one-shot ffmpeg uses to
// turn the baked overlay PNG into pipe:3's yuva420p — so a burst's first and last frames match
// the baked window's colours (Task 10 checks the real deviation, spec C20).
export function yuva420pFrameSize(width: number, height: number): number {
  return width * height + 2 * ((width / 2) * (height / 2)) + width * height;
}

export function transparentYuva420p(width: number, height: number): Buffer {
  const frame = Buffer.alloc(yuva420pFrameSize(width, height));
  const ySize = width * height;
  const cSize = (width / 2) * (height / 2);
  frame.fill(16, 0, ySize);
  frame.fill(128, ySize, ySize + 2 * cSize);
  // alpha plane stays 0
  return frame;
}

const clampByte = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

// Input: STRAIGHT (unpremultiplied) RGBA, even width/height.
export function rgbaToYuva420p(rgba: Uint8Array, width: number, height: number): Buffer {
  const ySize = width * height;
  const cw = width / 2;
  const cSize = cw * (height / 2);
  const out = Buffer.alloc(yuva420pFrameSize(width, height));
  const uOff = ySize;
  const vOff = ySize + cSize;
  const aOff = ySize + 2 * cSize;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      out[y * width + x] = clampByte(16 + (65.481 * r + 128.553 * g + 24.966 * b) / 255);
      out[aOff + y * width + x] = rgba[i + 3];
    }
  }
  for (let cy = 0; cy < height / 2; cy += 1) {
    for (let cx = 0; cx < cw; cx += 1) {
      let r = 0, g = 0, b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const i = ((cy * 2 + dy) * width + (cx * 2 + dx)) * 4;
        r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2];
      }
      r /= 4; g /= 4; b /= 4;
      out[uOff + cy * cw + cx] = clampByte(128 + (-37.797 * r - 74.203 * g + 112.0 * b) / 255);
      out[vOff + cy * cw + cx] = clampByte(128 + (112.0 * r - 93.786 * g - 18.214 * b) / 255);
    }
  }
  return out;
}
