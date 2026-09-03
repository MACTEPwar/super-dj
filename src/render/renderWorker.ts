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
  return renderScene(task.elements, task.scene, task.options);
}
