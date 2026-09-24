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

// Copies a smaller yuva420p frame's Y/U/V/A planes into a sub-rectangle of a larger one, in
// place. x/y/srcWidth/srcHeight/destWidth/destHeight must all be even — this is a raw plane
// copy at the same 2x2 chroma-subsampling grid both buffers already share (see rgbaToYuva420p
// above), so an odd offset or odd destination dimensions would misalign the chroma planes exactly
// the way an odd ffmpeg `overlay` position does (see GIF_OVERLAY_FORMAT in
// persistentEncoderArgs.ts) — except here nothing catches it, so callers (MarqueeFeeder) round
// their own coordinates and use even-dimension buffers before calling this. Additionally, the
// sub-rectangle must fit entirely within dest: x + srcWidth <= destWidth and y + srcHeight <=
// destHeight. If violated, Buffer.copy silently clips to the target buffer's length instead of
// throwing, producing quietly-wrong output rather than a loud failure.
export function blitYuva420p(
  dest: Buffer, destWidth: number, destHeight: number,
  src: Buffer, srcWidth: number, srcHeight: number,
  x: number, y: number,
): void {
  const destYSize = destWidth * destHeight;
  const destCw = destWidth / 2;
  const destCSize = destCw * (destHeight / 2);
  const destUOff = destYSize;
  const destVOff = destYSize + destCSize;
  const destAOff = destYSize + 2 * destCSize;

  const srcYSize = srcWidth * srcHeight;
  const srcCw = srcWidth / 2;
  const srcCSize = srcCw * (srcHeight / 2);
  const srcUOff = srcYSize;
  const srcVOff = srcYSize + srcCSize;
  const srcAOff = srcYSize + 2 * srcCSize;

  for (let sy = 0; sy < srcHeight; sy += 1) {
    src.copy(dest, (y + sy) * destWidth + x, sy * srcWidth, sy * srcWidth + srcWidth);
    src.copy(dest, destAOff + (y + sy) * destWidth + x, srcAOff + sy * srcWidth, srcAOff + sy * srcWidth + srcWidth);
  }
  const cx = x / 2;
  const cy = y / 2;
  for (let scy = 0; scy < srcHeight / 2; scy += 1) {
    src.copy(dest, destUOff + (cy + scy) * destCw + cx, srcUOff + scy * srcCw, srcUOff + scy * srcCw + srcCw);
    src.copy(dest, destVOff + (cy + scy) * destCw + cx, srcVOff + scy * srcCw, srcVOff + scy * srcCw + srcCw);
  }
}
