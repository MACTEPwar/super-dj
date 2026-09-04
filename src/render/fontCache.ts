import * as fs from 'fs/promises';

// Shared across every caller (the /templates/{id}/preview route and the live stream
// pipeline's buildOverlay) so each distinct font file is only ever read from disk once per
// process. Keyed by path now that a scene can register several font files at once (see
// fontRegistry.ts / sceneRenderer.ts), not just the one hardcoded font this used to be.
const cache = new Map<string, Promise<Buffer>>();

export function loadFontData(fontPath: string): Promise<Buffer> {
  let entry = cache.get(fontPath);
  if (!entry) {
    entry = fs.readFile(fontPath);
    cache.set(fontPath, entry);
  }
  return entry;
}
