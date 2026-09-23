import Piscina from 'piscina';
import * as path from 'path';
import * as os from 'os';
import { PlaylistWindowFrameRequest } from './sceneRenderer';

const RENDER_TIMEOUT_MS = 500;
let pool: Piscina | null = null;

// Its own small pool, NOT renderWorkerPool's: a burst fires ~20 renders in under a second, and must
// neither queue behind another tenant's full 1280x720 canvas render nor delay one.
function getPool(): Piscina {
  if (!pool) {
    pool = new Piscina({
      filename: path.join(__dirname, 'playlistWindowRenderWorker.js'),
      maxThreads: Math.max(1, Math.min(2, os.cpus().length)),
      idleTimeout: 60000,
      // Same RSS leak as pulseRenderWorkerPool.ts (read its comment): with Atomics dispatch the
      // worker's event loop never turns during a burst, and resvg's native memory is never freed.
      useAtomics: false,
    });
  }
  return pool;
}

export async function renderPlaylistWindowFrame(req: PlaylistWindowFrameRequest): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  try {
    const result: Uint8Array = await getPool().run(req, { signal: controller.signal });
    // Structured clone hands back a plain Uint8Array, never a Buffer (CLAUDE.md, Stage 1a scar).
    return Buffer.from(result.buffer, result.byteOffset, result.byteLength);
  } finally {
    clearTimeout(timer);
  }
}
