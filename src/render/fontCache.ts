import * as fs from 'fs/promises';

// Shared across every caller (the /templates/{id}/preview route and the live stream
// pipeline's buildOverlay) so the font is only ever read from disk once per process, not
// once per caller — same font file, same bytes, no reason to duplicate the read or the
// cached buffer in memory.
let cached: { path: string; data: Promise<Buffer> } | null = null;

export function loadFontData(fontPath: string): Promise<Buffer> {
  if (!cached || cached.path !== fontPath) {
    cached = { path: fontPath, data: fs.readFile(fontPath) };
  }
  return cached.data;
}
