import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { TemplateElement } from '../templates/templateTypes';

export interface SceneData {
  title: string;
  playlistLines: string[];
  coverDataUri: string | null;
}

export interface SceneRendererOptions {
  width: number;
  height: number;
  fontData: Buffer;
  fontFamily: string;
}

// Plain-object Satori node — deliberately not JSX/React (this is a backend service; pulling in
// a whole React runtime just to build a handful of positioned boxes would be a strange
// dependency to carry). Satori accepts this same shape either way.
type SatoriNode = { type: string; props: { style: Record<string, unknown>; children?: SatoriNode | SatoriNode[] | string } };

function elementNode(el: TemplateElement, scene: SceneData): SatoriNode | null {
  const position = { position: 'absolute' as const, left: el.x, top: el.y };
  switch (el.type) {
    case 'cover':
      // satori throws if an <img> has no src — omit the element rather than guess a fallback
      // image here; the caller (which already knows about default-cover.png) decides that.
      if (!scene.coverDataUri) return null;
      return {
        type: 'img',
        props: {
          style: { ...position, width: el.width, height: el.height, objectFit: 'cover' },
          // satori reads the image source itself from a `src` prop, but its type only models
          // `style`/`children` generically — cast is safe since satori's own img handling reads
          // whatever `src` is present on props at render time.
          ...( { src: scene.coverDataUri } as Record<string, unknown>),
        },
      };
    case 'title':
      return {
        type: 'div',
        props: {
          style: { ...position, width: el.width, fontSize: el.fontSize, color: el.color, display: 'flex' },
          children: scene.title,
        },
      };
    case 'playlist':
      return {
        type: 'div',
        props: {
          style: { ...position, width: el.width, fontSize: el.fontSize, color: el.color, display: 'flex', flexDirection: 'column' },
          children: scene.playlistLines.map((line): SatoriNode => ({
            type: 'div',
            props: { style: { display: 'flex' }, children: line },
          })),
        },
      };
  }
}

// Renders a template's elements + the current scene data (title, playlist window, cover) into
// a PNG buffer — the picture ffmpeg composites onto the video via a plain `overlay` filter,
// replacing hand-built drawtext filter strings. See CLAUDE.md's overlay-rework notes for why:
// drawtext string-building doesn't scale to user-configurable, arbitrarily-positioned elements
// (font handling, escaping, layering), whereas this is a normal HTML/CSS-shaped layout problem.
export async function renderScene(
  elements: TemplateElement[],
  scene: SceneData,
  options: SceneRendererOptions,
): Promise<Buffer> {
  const root: SatoriNode = {
    type: 'div',
    props: {
      style: { width: options.width, height: options.height, display: 'flex', position: 'relative' },
      children: elements.map((el) => elementNode(el, scene)).filter((node): node is SatoriNode => node !== null),
    },
  };

  const svg = await satori(root as unknown as Parameters<typeof satori>[0], {
    width: options.width,
    height: options.height,
    fonts: [{ name: options.fontFamily, data: options.fontData, weight: 400, style: 'normal' }],
  });

  return new Resvg(svg).render().asPng();
}
