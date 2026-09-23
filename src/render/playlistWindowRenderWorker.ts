import { renderPlaylistWindowPixels, PlaylistWindowFrameRequest } from './sceneRenderer';
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
