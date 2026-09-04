import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { resolveFontFile, FONT_FAMILIES } from './fontRegistry';
import { loadFontData } from './fontCache';
import { ColorValue, TextStyle, TemplateElement } from '../templates/templateTypes';

export interface SceneData {
  title: string;
  playlistLines: string[];
  coverDataUri: string | null;
  imageDataUris?: Record<string, string>; // assetId -> data: URI, for 'image' elements
}

// Plain-object Satori node — deliberately not JSX/React (this is a backend service; pulling in
// a whole React runtime just to build a handful of positioned boxes would be a strange
// dependency to carry). Satori accepts this same shape either way.
type SatoriNode = { type: string; props: { style: Record<string, unknown>; children?: SatoriNode | SatoriNode[] | string } };

function colorValueToCss(color: ColorValue): Record<string, unknown> {
  if (color.mode === 'solid') return { color: color.color };
  return {
    backgroundImage: `linear-gradient(${color.angleDeg}deg, ${color.stops.join(', ')})`,
    backgroundClip: 'text',
    color: 'transparent',
  };
}

function textStyleToCss(style: TextStyle, color: ColorValue): Record<string, unknown> {
  const css: Record<string, unknown> = {
    ...colorValueToCss(color),
    fontFamily: style.fontFamily,
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? 'italic' : 'normal',
  };
  if (style.stroke) {
    css.WebkitTextStrokeWidth = style.stroke.width;
    css.WebkitTextStrokeColor = style.stroke.color;
  }
  if (style.shadow) {
    css.textShadow = `${style.shadow.offsetX}px ${style.shadow.offsetY}px ${style.shadow.blur}px ${style.shadow.color}`;
  }
  // Applied unconditionally here even though this helper is also called from the 'playlist'
  // case below (multi-line, where wrapping is intentional) — TextStyle.overflow is a field on
  // the one shared style type used by title/playlist/text, not a per-type variant, so there's no
  // type-safe way to special-case it here without either splitting textStyleToCss in two or
  // threading an extra "is this multi-line" parameter through every caller for one narrow field.
  // Instead this is kept out of a playlist author's hands at the editor-UI level (see
  // TemplateEditor.tsx's properties panel: the overflow checkbox only renders for title/text) —
  // a playlist element could technically still carry `overflow: 'ellipsis'` if set via a direct
  // API call, producing a confusing single-line-truncated playlist window, but that's an
  // accepted, deliberate gap rather than an oversight.
  if (style.overflow === 'ellipsis') {
    css.whiteSpace = 'nowrap';
    css.overflow = 'hidden';
    css.textOverflow = 'ellipsis';
  }
  return css;
}

function elementNode(el: TemplateElement, scene: SceneData): SatoriNode | null {
  const position = { position: 'absolute' as const, left: el.x, top: el.y };
  switch (el.type) {
    case 'cover':
      // satori throws if an <img> has no src. The caller normally always resolves a real cover
      // (the track's own, or default-cover.png) before getting here, so this is a last-resort
      // guard, not the common path — draw a plain black rect instead of silently omitting the
      // slot, so a broken cover read doesn't look like a broken template.
      if (!scene.coverDataUri) {
        return {
          type: 'div',
          props: { style: { ...position, width: el.width, height: el.height, backgroundColor: '#000000' } },
        };
      }
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
          style: { ...position, width: el.width, fontSize: el.fontSize, display: 'flex', ...textStyleToCss(el.style, el.color) },
          children: scene.title,
        },
      };
    case 'playlist':
      return {
        type: 'div',
        props: {
          style: { ...position, width: el.width, fontSize: el.fontSize, display: 'flex', flexDirection: 'column', ...textStyleToCss(el.style, el.color) },
          children: scene.playlistLines.map((line): SatoriNode => ({
            type: 'div',
            props: { style: { display: 'flex' }, children: line },
          })),
        },
      };
    case 'text':
      return {
        type: 'div',
        props: {
          style: { ...position, width: el.width, fontSize: el.fontSize, display: 'flex', ...textStyleToCss(el.style, el.color) },
          children: el.text,
        },
      };
    case 'image': {
      const src = scene.imageDataUris?.[el.assetId];
      if (!src) {
        return { type: 'div', props: { style: { ...position, width: el.width, height: el.height, backgroundColor: '#000000' } } };
      }
      return {
        type: 'img',
        props: { style: { ...position, width: el.width, height: el.height, objectFit: 'contain' }, ...({ src } as Record<string, unknown>) },
      };
    }
    case 'timer':
      // Native element (a ticking value ffmpeg draws per-frame, not a static picture) — the
      // caller (StreamManager.buildOverlay) filters these out before calling renderScene at
      // all; this is a defensive no-op, not the expected path. See StreamController.timerText()
      // and src/ffmpeg/canvasFeeder.ts for how the timer's text is actually produced/drawn.
      return null;
    case 'equalizer':
      // Native element (audio-reactive visualization drawn by ffmpeg's showfreqs filter, not a
      // static picture) — the caller (StreamManager.buildOverlay/start) filters these out before
      // calling renderScene at all; this is a defensive no-op, not the expected path. See
      // StreamManager's equalizerElement handling and src/ffmpeg/persistentEncoderArgs.ts's
      // showfreqs/asplit/overlay filter_complex for how it's actually rendered.
      return null;
  }
}

// Collects every distinct (family, weight, style) combination actually used across a scene's
// elements, so satori() registers exactly the font files it needs — not a fixed single entry.
function collectFontVariants(elements: TemplateElement[]): { family: string; bold: boolean; italic: boolean }[] {
  const seen = new Map<string, { family: string; bold: boolean; italic: boolean }>();
  for (const el of elements) {
    if (el.type !== 'title' && el.type !== 'playlist' && el.type !== 'text') continue;
    const key = `${el.style.fontFamily}|${el.style.bold}|${el.style.italic}`;
    if (!seen.has(key)) seen.set(key, { family: el.style.fontFamily, bold: el.style.bold, italic: el.style.italic });
  }
  if (seen.size === 0) seen.set('default', { family: FONT_FAMILIES[0], bold: false, italic: false });
  return [...seen.values()];
}

// Default font loader: real registry path + real fs read, exactly what production uses.
// The optional 4th parameter below exists ONLY so this file's own tests can substitute a
// cross-platform-safe loader (e.g. a real local Windows/macOS .ttf for dev-machine test runs)
// without mocking satori/resvg themselves or the production code path — production never
// passes this argument, so it always gets the real registry.
async function defaultLoadFont(family: string, bold: boolean, italic: boolean): Promise<Buffer> {
  return loadFontData(resolveFontFile(family, bold, italic));
}

// A named, exported interface (not an inline `{width,height}` type) deliberately — Task 9 adds
// the `background` field below, and renderWorker.ts/renderWorkerPool.ts import and reuse this
// interface by reference rather than duplicating the shape, so that addition doesn't require
// touching those two files by hand.
export interface SceneRendererOptions {
  width: number;
  height: number;
  // The per-track overlayOverride's backgroundColor (see StreamManager.buildOverlay), applied
  // behind every element. Absent means "use the template's own background" — today's existing
  // behavior, unchanged.
  background?: ColorValue;
}

function backgroundToCss(background: ColorValue): Record<string, unknown> {
  if (background.mode === 'solid') return { backgroundColor: background.color };
  return { backgroundImage: `linear-gradient(${background.angleDeg}deg, ${background.stops.join(', ')})` };
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
  loadFont: (family: string, bold: boolean, italic: boolean) => Promise<Buffer> = defaultLoadFont,
): Promise<Buffer> {
  const variants = collectFontVariants(elements);
  const fonts = await Promise.all(variants.map(async (v) => ({
    name: v.family,
    data: await loadFont(v.family, v.bold, v.italic),
    weight: (v.bold ? 700 : 400) as 400 | 700,
    style: (v.italic ? 'italic' : 'normal') as 'italic' | 'normal',
  })));

  const root: SatoriNode = {
    type: 'div',
    props: {
      style: {
        width: options.width, height: options.height, display: 'flex', position: 'relative',
        ...(options.background ? backgroundToCss(options.background) : {}),
      },
      children: elements.map((el) => elementNode(el, scene)).filter((node): node is SatoriNode => node !== null),
    },
  };

  const svg = await satori(root as unknown as Parameters<typeof satori>[0], {
    width: options.width, height: options.height, fonts,
  });

  return new Resvg(svg).render().asPng();
}
