import Piscina from 'piscina';
import * as path from 'path';
import * as os from 'os';
import { TemplateElement } from '../templates/templateTypes';
import { SceneData, SceneRendererOptions } from './sceneRenderer';
import { RenderTask } from './renderWorker';

const RENDER_TIMEOUT_MS = 5000;

// Piscina needs the worker's *compiled* JS entry point (dist/render/renderWorker.js) — only
// present once `npm run build` has run, same as every other piece of this pipeline that only
// really works inside the built Docker image (real ffmpeg, real fonts). The pool is constructed
// lazily so importing this module from a unit test — which mocks renderViaPool at the module
// boundary rather than exercising the real pool, matching how ffmpeg itself is never really
// spawned in unit tests either (see CLAUDE.md's testing strategy) — never tries to resolve a
// dist/ path that doesn't exist yet.
let pool: Piscina | null = null;

function getPool(): Piscina {
  if (!pool) {
    pool = new Piscina({
      filename: path.join(__dirname, 'renderWorker.js'),
      maxThreads: Math.max(1, Math.min(4, os.cpus().length)),
      idleTimeout: 60000,
    });
  }
  return pool;
}

export async function renderViaPool(elements: TemplateElement[], scene: SceneData, options: SceneRendererOptions): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  const task: RenderTask = { elements, scene, options };
  try {
    // Structured clone (what postMessage — and so piscina — uses to hand the worker's return
    // value back across the thread boundary) has no concept of Node's Buffer subclass, only the
    // standard Uint8Array; the PNG comes back a plain Uint8Array even though renderScene()
    // returns a real Buffer inside the worker. Buffer.from() here (no copy — it wraps the same
    // underlying ArrayBuffer) is what makes Buffer.isBuffer() true again for every caller
    // downstream — notably Express's res.send(), which silently JSON-serializes ({"0":137,...})
    // instead of sending raw bytes for anything that isn't a real Buffer.
    const result = await getPool().run(task, { signal: controller.signal });
    return Buffer.from(result.buffer, result.byteOffset, result.byteLength);
  } finally {
    clearTimeout(timer);
  }
}
