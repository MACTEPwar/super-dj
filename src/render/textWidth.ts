import { parse, Font } from '@shuding/opentype.js';
import { resolveFontFile } from './fontRegistry';
import { loadFontData } from './fontCache';

// Parsing a font file is real CPU work (opentype.js walks the whole glyf/cmap tables), and the
// same file gets re-measured on every track switch, for every user whose template has a
// playlist element — cached by resolved file path, one level below fontCache.ts's raw-bytes
// cache (which this reuses as its default loader).
const parsedFontCache = new Map<string, Font>();

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function loadParsedFont(fontFile: string, loadFont: (path: string) => Promise<Buffer>): Promise<Font> {
  const cached = parsedFontCache.get(fontFile);
  if (cached) return cached;
  const bytes = await loadFont(fontFile);
  const font = parse(toArrayBuffer(bytes));
  parsedFontCache.set(fontFile, font);
  return font;
}

/**
 * Real glyph-advance-width measurement for one row's text — the same font-metrics engine
 * (@shuding/opentype.js, pinned to satori's own dependency version) satori itself uses
 * internally for text layout, so "does this text overflow the row" agrees with what a real
 * Satori render of the row would actually produce, rather than a monospace/character-count
 * heuristic. Used to decide whether the current track's row needs the live marquee layer (see
 * src/ffmpeg/marqueeArgs.ts) — a name that already fits never gets one.
 */
export async function measureTextWidth(
  text: string,
  family: string,
  bold: boolean,
  italic: boolean,
  fontSize: number,
  loadFont: (path: string) => Promise<Buffer> = loadFontData,
): Promise<number> {
  const fontFile = resolveFontFile(family, bold, italic);
  const font = await loadParsedFont(fontFile, loadFont);
  return font.getAdvanceWidth(text, fontSize);
}
