// resvg's raw pixel buffer is premultiplied alpha (color channels already multiplied by
// alpha/255) — verified against real resvg + ffmpeg binaries during this feature's design (see
// the design spec's alpha spike). ffmpeg's rawvideo `rgba` pix_fmt expects STRAIGHT alpha;
// feeding it premultiplied bytes directly applies alpha a second time during compositing,
// visibly darkening every translucent glow layer. This reverses that, in place.
export function unpremultiplyRgbaInPlace(pixels: Buffer): void {
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3];
    if (a === 0 || a === 255) continue; // 0: nothing to recover; 255: a/255 == 1, already correct
    pixels[i] = Math.min(255, Math.round((pixels[i] * 255) / a));
    pixels[i + 1] = Math.min(255, Math.round((pixels[i + 1] * 255) / a));
    pixels[i + 2] = Math.min(255, Math.round((pixels[i + 2] * 255) / a));
  }
}
