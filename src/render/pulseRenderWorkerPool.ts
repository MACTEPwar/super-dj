import Piscina from 'piscina';
import * as path from 'path';
import * as os from 'os';
import { PulseRenderTask } from './pulseRenderWorker';

const RENDER_TIMEOUT_MS = 200; // generous vs. the ~5ms measured cost — see the design spec's spike

let pool: Piscina | null = null;

function getPool(): Piscina {
  if (!pool) {
    pool = new Piscina({
      filename: path.join(__dirname, 'pulseRenderWorker.js'),
      maxThreads: Math.max(1, Math.min(4, os.cpus().length)),
      idleTimeout: 60000,
    });
  }
  return pool;
}

// Raw RGBA pixels, not a PNG — PulseVisualizer writes these straight to a raw-video ffmpeg pipe,
// so there's no reason to pay for PNG encode/decode on every frame the way the Satori/resvg
// preview path does (that one has to cross an HTTP response boundary; this one doesn't).
export async function renderPulseFrame(svg: string): Promise<{ pixels: Buffer; width: number; height: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  const task: PulseRenderTask = { svg };
  try {
    const result = await getPool().run(task, { signal: controller.signal });
    return {
      pixels: Buffer.from(result.pixels.buffer, result.pixels.byteOffset, result.pixels.byteLength),
      width: result.width,
      height: result.height,
    };
  } finally {
    clearTimeout(timer);
  }
}
