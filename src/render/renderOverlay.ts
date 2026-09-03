import { renderViaPool } from './renderWorkerPool';
import { readImageAsDataUri } from './imageDataUri';
import { loadFontData } from './fontCache';
import { TemplateElement } from '../templates/templateTypes';

export interface RenderOverlayParams {
  elements: TemplateElement[];
  title: string;
  playlistLines: string[];
  coverPath: string;
  width: number;
  height: number;
  fontPath: string;
  fontFamily: string;
}

// Renders a template through the shared worker pool. Used by both the interactive
// POST /templates/{id}/preview endpoint (which lets a render error propagate as a real HTTP
// error, so someone testing a template layout can see what broke) and the live stream
// pipeline (which instead catches a failure here and falls back to a blank overlay — see
// StreamManager's buildOverlay — because keeping the RTMP connection alive matters more than
// one segment's picture). Keeping this function happy-path-only, with each caller owning its
// own failure policy, is what makes that split possible without duplicating the render call.
export async function renderTemplatePng(params: RenderOverlayParams): Promise<Buffer> {
  const [coverDataUri, fontData] = await Promise.all([
    readImageAsDataUri(params.coverPath),
    loadFontData(params.fontPath),
  ]);
  return renderViaPool(
    params.elements,
    { title: params.title, playlistLines: params.playlistLines, coverDataUri },
    { width: params.width, height: params.height, fontData, fontFamily: params.fontFamily },
  );
}
