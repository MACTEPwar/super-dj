import { renderPlaylistWindowPixels, renderMarqueeStripPixels, PlaylistWindowFrameRequest, MarqueeStripFrameRequest } from './sceneRenderer';
import { unpremultiplyRgbaInPlace } from './unpremultiply';
import { rgbaToYuva420p } from './yuva420p';

// Piscina worker entry for pipe:7 burst frames. Everything CPU-heavy happens here, off the main
// thread: Satori layout, resvg rasterization, unpremultiply, and the yuva420p conversion. Fonts
// load in this thread (fontCache), so no font bytes cross the postMessage boundary.
export default async function render(task: PlaylistWindowFrameRequest): Promise<Uint8Array> {
  const { pixels, width, height } = await renderPlaylistWindowPixels(task);
  const straight = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  unpremultiplyRgbaInPlace(straight);
  return rgbaToYuva420p(straight, width, height);
}

// A second, named export sharing this same worker file (and so this same pool — see
// playlistWindowRenderPool.ts) rather than a third pool: a marquee activation is roughly as
// infrequent as a canvas re-render, not the ~20-renders-per-second-during-a-burst shape pipe:7's
// own pool exists to isolate. Returns STRAIGHT RGBA, not yuva420p — MarqueeFeeder converts only
// the small cropped slice it actually needs each frame, not the whole wide strip.
export async function renderMarqueeStrip(task: MarqueeStripFrameRequest): Promise<Uint8Array> {
  const { pixels } = await renderMarqueeStripPixels(task);
  const straight = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  unpremultiplyRgbaInPlace(straight);
  // A plain view rewrap for the postMessage boundary — this returns straight RGBA, not yuva420p
  // (unlike the default export above), so there's no conversion call needing width/height.
  return new Uint8Array(straight.buffer, straight.byteOffset, straight.byteLength);
}
