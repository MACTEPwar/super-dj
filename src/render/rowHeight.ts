import { PlaylistElement } from '../templates/templateTypes';
import { renderPlaylistWindowPixels } from './sceneRenderer';
import { settledRows } from '../ffmpeg/playlistWindowTransition';

// Cached by the four things that actually change a font's own line-height — never by anything
// per-session (x/y/width don't affect it). A distinct playlist element sharing the same style
// reuses this entry for free.
const cache = new Map<string, number>();

function cacheKey(element: PlaylistElement): string {
  return `${element.style.fontFamily}|${element.style.bold}|${element.style.italic}|${element.fontSize}`;
}

// Contiguous vertical bands of non-transparent pixels, top to bottom. Two rows of identical text
// at the same size produce two bands whose START-to-START distance is exactly the flex column's
// per-row allocated height (line-height), regardless of glyph-specific ink shape — see the design
// spec's "Row geometry: measured once, not estimated".
function inkBands(pixels: Uint8Array, width: number, height: number): Array<{ first: number }> {
  const bands: Array<{ first: number }> = [];
  let inBand = false;
  for (let y = 0; y < height; y += 1) {
    let hasInk = false;
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3] > 0) { hasInk = true; break; }
    }
    if (hasInk && !inBand) bands.push({ first: y });
    inBand = hasInk;
  }
  return bands;
}

/**
 * The real, rendered pixel height of one row in this playlist element's own font/size — measured
 * once via a real Satori+resvg render (two rows of representative text, both ascenders and
 * descenders present via 'Ag'), not estimated. Used to compute the current row's exact Y position
 * for the marquee layer (see src/ffmpeg/marqueeFeeder.ts) — every row shares this same height,
 * since sceneRenderer.ts's per-row ellipsis truncation forces every row in one playlist element to
 * a single line at the element's own fontSize.
 */
export async function measureRowHeight(
  element: PlaylistElement,
  loadFont?: (family: string, bold: boolean, italic: boolean) => Promise<Buffer>,
): Promise<number> {
  const key = cacheKey(element);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const probeWidth = Math.max(40, Math.ceil(element.fontSize * 3));
  const probeHeight = Math.ceil(element.fontSize * 6);
  const region = { x: 0, y: 0, width: probeWidth, height: probeHeight, originX: 0, originY: 0 };
  const probeElement: PlaylistElement = { ...element, x: 0, y: 0, width: probeWidth };
  const rows = settledRows([
    { key: 'a', text: 'Ag', isCurrent: false },
    { key: 'b', text: 'Ag', isCurrent: false },
  ]);
  const { pixels, width, height } = await renderPlaylistWindowPixels({ element: probeElement, rows, region }, loadFont);
  const bands = inkBands(pixels, width, height);
  if (bands.length < 2) {
    throw new Error(`measureRowHeight: expected 2 ink bands for a 2-row probe, found ${bands.length}`);
  }
  const rowHeight = bands[1].first - bands[0].first;
  cache.set(key, rowHeight);
  return rowHeight;
}
