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
      // NOT piscina's default (true). This was a real ~2.3GB/min RSS leak on a deployed stream,
      // reproduced locally against the real pipeline at ~60MB/s for a 1000x300 element:
      // piscina's Atomics-based dispatch blocks the worker in Atomics.wait() (no timeout) and
      // pulls the next task straight off the port via receiveMessageOnPort(), so as long as
      // frames keep coming — 30/s per stream here — the WORKER'S EVENT LOOP NEVER TURNS. Node-API
      // runs native finalizers on that loop (SetImmediate), and resvg's per-frame native memory
      // (the RenderedImage's Rust pixmap plus the external `pixels` buffer, ~2.8MB per frame at
      // that size) is only ever freed by those finalizers. V8 sees none of it as external memory
      // either, so even a forced full GC inside the worker freed nothing; only worker teardown
      // did. Measured: 1889MB RSS after 30s of renders with the default, flat ~200MB with this
      // off, everything else identical. The per-task cost of dispatching through the loop
      // instead is microseconds against a ~15ms render. (piscina 5 renames this knob to
      // `atomics: 'disabled'`.)
      useAtomics: false,
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
