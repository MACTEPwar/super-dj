import { renderScene, SceneData, SceneRendererOptions } from './sceneRenderer';
import { TemplateElement } from '../templates/templateTypes';

export interface RenderTask {
  elements: TemplateElement[];
  scene: SceneData;
  options: SceneRendererOptions; // imported by reference — when a later task adds a
    // `background` field to SceneRendererOptions, this type widens automatically, no edit
    // needed here.
}

// Piscina's worker entry point — runs inside a worker_thread, off the main event loop. Resvg's
// SVG->PNG rasterization is synchronous native CPU work; running it here (rather than inline in
// the request/segment-build path) is what keeps one stream's overlay render from stalling every
// other active stream's ffmpeg feeding and every other in-flight HTTP request on the same
// process. See renderWorkerPool.ts for the pool this feeds into.
//
// Font loading now happens inside renderScene() itself (see sceneRenderer.ts), reading font
// files directly from disk in THIS worker thread — the font bytes never cross the postMessage
// boundary into or out of this function, so there is no Buffer/Uint8Array rewrap needed here
// any more (contrast with renderWorkerPool.ts's renderViaPool(), which still rewraps the PNG
// *return value* crossing back out — that boundary is unrelated and still real).
export default function render(task: RenderTask): Promise<Buffer> {
  return renderScene(task.elements, task.scene, task.options);
}
