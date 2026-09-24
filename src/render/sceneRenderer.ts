import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { resolveFontFile, FONT_FAMILIES } from './fontRegistry';
import { loadFontData } from './fontCache';
import { ColorValue, TextStyle, TemplateElement, PlaylistElement, normalizeColorValue } from '../templates/templateTypes';
import { AnimatedRow, settledRows } from '../ffmpeg/playlistWindowTransition';
import { PlaylistWindowRegion } from './playlistWindowGeometry';

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

/**
 * The CSS one gradient ColorValue becomes. Extracted so colorValueToCss (a text fill) and
 * backgroundToCss (the scene background) can never drift apart, and so the frontend's live
 * gradient-strip preview has one exact shape to mirror.
 */
export function gradientCss(color: Extract<ColorValue, { mode: 'gradient' }>): string {
  // Sorted, because SVG gradient stops must be non-decreasing and satori does NOT reject an
  // out-of-order CSS stop list — it renders a silently clamped, wrong picture (verified against
  // the real satori+resvg: offsets 0/80/30/100 produced 25 distinct colors vs 39 sorted). A
  // STABLE sort, so two stops sharing an offset keep author order, which is exactly CSS's
  // "hard stop" semantics.
  const stops = [...color.stops]
    .sort((a, b) => a.offset - b.offset)
    .map((s) => `${s.color} ${s.offset}%`)
    .join(', ');
  // Bare radial-gradient is CSS's own default (ellipse, farthest-corner, centre) — verified
  // pixel-identical to the explicit `ellipse farthest-corner at 50% 50%` spelling.
  return color.gradientType === 'radial'
    ? `radial-gradient(${stops})`
    : `linear-gradient(${color.angleDeg}deg, ${stops})`;
}

function colorValueToCss(rawColor: ColorValue): Record<string, unknown> {
  // Normalized here rather than at every caller: this and backgroundToCss are the only two places
  // a STORED (never re-validated on read) ColorValue reaches the renderer, so one call here
  // covers the live stream, the preview endpoint and the per-track override alike.
  const color = normalizeColorValue(rawColor);
  if (color.mode === 'solid') return { color: color.color };
  return {
    backgroundImage: gradientCss(color),
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
      return playlistWindowNode(el, settledRows(scene.playlistLines.map((text, i) => ({ key: String(i), text, isCurrent: false }))), { x: el.x, y: el.y });
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
      // caller (buildStreamScene()'s buildOverlay in streamScene.ts) filters these out before
      // calling renderScene at all; this is a defensive no-op, not the expected path. See
      // StreamController.timerText() and src/ffmpeg/canvasFeeder.ts for how the timer's text is
      // actually produced/drawn.
      return null;
    case 'equalizer':
      // Native element (audio-reactive visualization drawn by ffmpeg's showfreqs filter, not a
      // static picture) — the caller (buildStreamScene() in streamScene.ts) filters these out
      // before calling renderScene at all; this is a defensive no-op, not the expected path. See
      // buildStreamScene()'s equalizerElement handling and src/ffmpeg/persistentEncoderArgs.ts's
      // showfreqs/asplit/overlay filter_complex for how it's actually rendered.
      return null;
  }
}

// The ONE playlist-window node: the baked canvas and the template preview call it with settled
// rows (no animation props); pipe:7's burst frames call it with animation props, which only ever
// ADD row style keys on top of the same base (see the ellipsis-truncation note below) — so a
// burst's first and last frames are the baked window's own pixels, which is what makes the
// handoff overlaps invisible (spec, "The handoff protocol"). (Byte-identity with the pre-Phase-C
// node ended 2026-09-24 when per-row single-line truncation landed — see
// test/render/playlistWindowNode.test.ts.)
export function playlistWindowNode(el: PlaylistElement, rows: AnimatedRow[], origin: { x: number; y: number }): SatoriNode {
  return {
    type: 'div',
    props: {
      style: { position: 'absolute', left: origin.x, top: origin.y, width: el.width, fontSize: el.fontSize, display: 'flex', flexDirection: 'column', ...textStyleToCss(el.style, el.color) },
      children: rows.map((r): SatoriNode => {
        // Every row is single-line, ellipsis-truncated: a name wider than the window must never
        // wrap onto a second line (a row's div otherwise defaults to `white-space: normal` while
        // still stretching to the container's width via flex's `align-items: stretch`, which is
        // exactly what let a long name wrap — "▶" alone on one line, the name below).
        const style: Record<string, unknown> = {
          display: 'flex', maxWidth: el.width, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
        };
        if (r.opacity !== undefined) style.opacity = r.opacity;
        if (r.offsetX !== undefined) style.marginLeft = r.offsetX;
        if (r.maxHeightFactor !== undefined) {
          // Growing the new row's box is what opens the gap: the flex column pushes every row below
          // down by the row's REAL height — no row-height model, so wrapping and natural line height
          // behave exactly as in the baked window. overflow is already 'hidden' above, which this
          // height clip shares harmlessly with the ellipsis truncation.
          style.maxHeight = r.maxHeightFactor * el.fontSize;
        }
        return { type: 'div', props: { style, children: r.text } };
      }),
    },
  };
}

// Collects every distinct (family, weight, style) combination actually used across a scene's
// elements, so satori() registers exactly the font files it needs — not a fixed single entry.
export function collectFontVariants(elements: TemplateElement[]): { family: string; bold: boolean; italic: boolean }[] {
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
  // The per-track overlayOverride's backgroundColor (see buildStreamScene()'s buildOverlay in
  // streamScene.ts), applied behind every element. Absent means "use the template's own
  // background" — today's existing behavior, unchanged.
  background?: ColorValue;
}

function backgroundToCss(rawBackground: ColorValue): Record<string, unknown> {
  const background = normalizeColorValue(rawBackground);
  if (background.mode === 'solid') return { backgroundColor: background.color };
  return { backgroundImage: gradientCss(background) };
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

export interface PlaylistWindowFrameRequest { element: PlaylistElement; rows: AnimatedRow[]; region: PlaylistWindowRegion }

// One pipe:7 burst frame: ONLY the playlist element, in region coordinates (origin shifted by an
// integer offset, so rasterization is identical to the baked canvas's), as raw PREMULTIPLIED RGBA.
// loadSystemFonts: false — satori already turned every glyph into a path, and the scan costs
// ~130ms per call (pulse spike).
export async function renderPlaylistWindowPixels(
  req: PlaylistWindowFrameRequest,
  loadFont: (family: string, bold: boolean, italic: boolean) => Promise<Buffer> = defaultLoadFont,
): Promise<{ pixels: Uint8Array; width: number; height: number }> {
  const variants = collectFontVariants([req.element]);
  const fonts = await Promise.all(variants.map(async (v) => ({
    name: v.family, data: await loadFont(v.family, v.bold, v.italic),
    weight: (v.bold ? 700 : 400) as 400 | 700, style: (v.italic ? 'italic' : 'normal') as 'italic' | 'normal',
  })));
  const root: SatoriNode = {
    type: 'div',
    props: {
      style: { width: req.region.width, height: req.region.height, display: 'flex', position: 'relative' },
      children: [playlistWindowNode(req.element, req.rows, { x: req.region.originX, y: req.region.originY })],
    },
  };
  const svg = await satori(root as unknown as Parameters<typeof satori>[0], { width: req.region.width, height: req.region.height, fonts });
  const pixmap = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
  return { pixels: pixmap.pixels, width: pixmap.width, height: pixmap.height };
}

export interface MarqueeStripFrameRequest {
  element: PlaylistElement;
  text: string;
  stripWidth: number;
  rowHeight: number;
  // How much blank space to leave BEFORE the text starts, within the strip — the row's own
  // width, so a crop window sliding across the strip shows a full row-width of blank before the
  // text is first revealed (a clean "gliding in from the right" start) and, symmetrically, a
  // full row-width of blank after it (the strip is sized to exactly fit `paddingLeft + text +
  // paddingLeft` — see MarqueeFeeder.activate()). Without this, the text starts at the strip's
  // own left edge, so the visible loop pops the name in and out at full width instead of easing
  // through a blank gap on both sides.
  paddingLeft: number;
}

// A single row's FULL text (no ellipsis, no wrap constraint) rendered into a fixed-size, padded
// strip — the one-shot Satori/resvg render MarqueeFeeder uses to build the source bitmap it crops
// per frame for the current track's marquee (see src/ffmpeg/marqueeFeeder.ts and the design
// spec's "Chosen approach: pre-rendered text strip + per-frame crop"). Called ONCE per marquee
// activation, never per frame. The caller sizes stripWidth generously around the text's own
// measured width (measureTextWidth) plus the row's own width on both sides — this render's own
// width doesn't need to be pixel-exact, any extra blank space is harmless.
export async function renderMarqueeStripPixels(
  req: MarqueeStripFrameRequest,
  loadFont: (family: string, bold: boolean, italic: boolean) => Promise<Buffer> = defaultLoadFont,
): Promise<{ pixels: Uint8Array; width: number; height: number }> {
  const { element, text, stripWidth, rowHeight, paddingLeft } = req;
  const variants = collectFontVariants([element]);
  const fonts = await Promise.all(variants.map(async (v) => ({
    name: v.family, data: await loadFont(v.family, v.bold, v.italic),
    weight: (v.bold ? 700 : 400) as 400 | 700, style: (v.italic ? 'italic' : 'normal') as 'italic' | 'normal',
  })));
  const root: SatoriNode = {
    type: 'div',
    props: {
      style: {
        width: stripWidth, height: rowHeight, display: 'flex', position: 'relative',
        whiteSpace: 'nowrap', fontSize: element.fontSize, paddingLeft,
        ...textStyleToCss(element.style, element.color),
      },
      children: text,
    },
  };
  const svg = await satori(root as unknown as Parameters<typeof satori>[0], { width: stripWidth, height: rowHeight, fonts });
  const pixmap = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
  return { pixels: pixmap.pixels, width: pixmap.width, height: pixmap.height };
}
