import { renderScene, SceneData, SceneRendererOptions } from './sceneRenderer';
import { TemplateElement } from '../templates/templateTypes';

export interface RenderTask {
  elements: TemplateElement[];
  scene: SceneData;
  options: SceneRendererOptions;
}

// Piscina's worker entry point — runs inside a worker_thread, off the main event loop. Resvg's
// SVG->PNG rasterization is synchronous native CPU work; running it here (rather than inline in
// the request/segment-build path) is what keeps one stream's overlay render from stalling every
// other active stream's ffmpeg feeding and every other in-flight HTTP request on the same
// process. See renderWorkerPool.ts for the pool this feeds into.
export default function render(task: RenderTask): Promise<Buffer> {
  // Structured clone (what postMessage uses to hand task data INTO the worker, same as it does
  // for the return value on the way OUT — see renderWorkerPool.ts) has no concept of Node's
  // Buffer subclass, only the standard Uint8Array: fontData arrives here a plain Uint8Array even
  // though it was read via fs.readFile() (a real Buffer) on the main thread. Satori's font
  // parsing silently produces missing-glyph boxes for anything outside ASCII (discovered via a
  // live smoke test with real Cyrillic text — a plain Uint8Array-vs-Buffer bug like this doesn't
  // throw, it just quietly mis-renders) unless it's rewrapped as a real Buffer here first.
  const raw = task.options.fontData;
  const fontData = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  return renderScene(task.elements, task.scene, { ...task.options, fontData });
}
