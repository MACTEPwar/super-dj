import { renderViaPool } from './renderWorkerPool';
import { readImageAsDataUri } from './imageDataUri';
import { TemplateElement, ColorValue } from '../templates/templateTypes';

export interface RenderOverlayParams {
  elements: TemplateElement[];
  title: string;
  playlistLines: string[];
  coverPath: string;
  width: number;
  height: number;
  fontPath: string;
  fontFamily: string;
  // assetId -> on-disk renderable PNG path (TemplateImageService.resolvePath's return value),
  // one entry per 'image' element actually present in `elements`. Absent/empty is fine — image
  // elements just fall back to their black-rect placeholder (see sceneRenderer.ts).
  imageAssets?: Record<string, string>;
  // The per-track overlayOverride's backgroundColor, if any — applied to the whole canvas
  // behind every element. Absent means "use the template's own background," i.e. none (today's
  // existing behavior, unchanged).
  background?: ColorValue;
}

// Renders a template through the shared worker pool. Used by both the interactive
// POST /templates/{id}/preview endpoint (which lets a render error propagate as a real HTTP
// error, so someone testing a template layout can see what broke) and the live stream
// pipeline (which instead catches a failure here and falls back to a blank overlay — see
// StreamManager's buildOverlay — because keeping the RTMP connection alive matters more than
// one segment's picture). Keeping this function happy-path-only, with each caller owning its
// own failure policy, is what makes that split possible without duplicating the render call.
export async function renderTemplatePng(params: RenderOverlayParams): Promise<Buffer> {
  const imageAssetEntries = Object.entries(params.imageAssets ?? {});
  const [coverDataUri, imageResults] = await Promise.all([
    readImageAsDataUri(params.coverPath),
    // Each asset is resolved independently (not one all-or-nothing Promise.all) so a single
    // missing/unreadable file — e.g. an assetId a draft template references that was never
    // actually uploaded, or one orphaned by a since-deleted template — doesn't take the whole
    // render down with it. A rejected entry is simply omitted from imageDataUris below, which
    // makes sceneRenderer.ts's elementNode() render that one 'image' element as its existing
    // black-rect placeholder (the same fallback it already uses for a missing cover image)
    // instead of failing cover/title/playlist/everything else too.
    Promise.allSettled(imageAssetEntries.map(([, filePath]) => readImageAsDataUri(filePath))),
  ]);
  const imageDataUris: Record<string, string> = {};
  imageAssetEntries.forEach(([assetId, filePath], i) => {
    const result = imageResults[i];
    if (result.status === 'fulfilled') {
      imageDataUris[assetId] = result.value;
    } else {
      // Matches StreamManager.buildOverlay's "falling back to a blank overlay" logging
      // convention for this same class of non-fatal render degradation.
      console.error(`image asset '${assetId}' (${filePath}) failed to read, rendering its element as a placeholder instead`, result.reason);
    }
  });

  return renderViaPool(
    params.elements,
    { title: params.title, playlistLines: params.playlistLines, coverDataUri, imageDataUris },
    { width: params.width, height: params.height, background: params.background },
  );
}
