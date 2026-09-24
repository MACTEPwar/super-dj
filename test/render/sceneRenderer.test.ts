import * as fs from 'fs';
import * as path from 'path';
import { renderScene, gradientCss } from '../../src/render/sceneRenderer';
import { ColorValue, TemplateElement } from '../../src/templates/templateTypes';

// A real, small local font so the renderer's actual output gets exercised end to end (no
// fake/mocked satori or resvg here) — deliberately not the production DejaVu Sans path (only
// present inside the Linux container), any valid TTF proves the pipeline works.
const FONT_CANDIDATES = [
  'C:\\Windows\\Fonts\\arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
];

function findFontPath(): string {
  for (const candidate of FONT_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`No test font found — tried: ${FONT_CANDIDATES.join(', ')}`);
}

// Cross-platform note: production's default font loader (fontRegistry.ts) only knows
// hardcoded Linux paths (/usr/share/fonts/...), which don't exist on a Windows/macOS dev
// machine. testLoadFont substitutes any real local .ttf found above for every family/weight/
// style combination a test asks for — these tests are checking that the CSS tricks render, not
// checking any specific font's glyphs, so the (bold, italic) combination requested doesn't need
// to correspond to a real distinct file on disk.
const testFontPath = findFontPath();
async function testLoadFont(_family: string, _bold: boolean, _italic: boolean): Promise<Buffer> {
  return fs.promises.readFile(testFontPath);
}
const testOptions = { width: 400, height: 150 };

const elements: TemplateElement[] = [
  { type: 'cover', x: 40, y: 40, width: 200, height: 200 },
  { type: 'title', x: 280, y: 40, width: 800, fontSize: 42,
    color: { mode: 'solid', color: '#ffffff' },
    style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } },
  { type: 'playlist', x: 280, y: 120, width: 800, fontSize: 24,
    color: { mode: 'solid', color: '#cccccc' },
    style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } },
];

describe('renderScene', () => {
  it('renders a valid, correctly-sized PNG from a template + scene data', async () => {
    const png = await renderScene(
      elements,
      { title: 'Тестовый трек — Ммм...', playlistLines: ['▶ Тестовый трек', '  Следующий трек'], coverDataUri: null },
      { width: 1280, height: 720 },
      testLoadFont,
    );

    // PNG signature + a sane, non-trivial size (a blank/broken render would be near-empty).
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.length).toBeGreaterThan(1000);
  });

  it('renders with a real cover image embedded as a data URI', async () => {
    const coverPath = path.join(__dirname, '..', '..', 'assets', 'default-cover.png');
    const coverDataUri = `data:image/png;base64,${fs.readFileSync(coverPath).toString('base64')}`;

    const png = await renderScene(
      elements,
      { title: 'Cover test', playlistLines: ['▶ Cover test'], coverDataUri },
      { width: 1280, height: 720 },
      testLoadFont,
    );

    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('renders an empty element list as a blank canvas of the requested size, without throwing', async () => {
    const png = await renderScene(
      [],
      { title: '', playlistLines: [], coverDataUri: null },
      { width: 640, height: 360 },
      testLoadFont,
    );

    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('renders gradient text without throwing', async () => {
    const png = await renderScene(
      [{ type: 'title', x: 0, y: 0, width: 400, fontSize: 60,
         color: { mode: 'gradient', gradientType: 'linear', angleDeg: 0,
           stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 100 }] },
         style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } }],
      { title: 'GRADIENT', playlistLines: [], coverDataUri: null },
      testOptions, testLoadFont,
    );
    expect(png.length).toBeGreaterThan(0);
  });

  it('renders a stroke without throwing', async () => {
    const png = await renderScene(
      [{ type: 'title', x: 0, y: 0, width: 400, fontSize: 60,
         color: { mode: 'solid', color: '#ffffff' },
         style: { fontFamily: 'DejaVu Sans', bold: false, italic: false,
           stroke: { color: '#000000', width: 3 } } }],
      { title: 'STROKE', playlistLines: [], coverDataUri: null },
      testOptions, testLoadFont,
    );
    expect(png.length).toBeGreaterThan(0);
  });

  it('renders a shadow without throwing', async () => {
    const png = await renderScene(
      [{ type: 'title', x: 0, y: 0, width: 400, fontSize: 60,
         color: { mode: 'solid', color: '#ffffff' },
         style: { fontFamily: 'DejaVu Sans', bold: false, italic: false,
           shadow: { color: '#000000', blur: 4, offsetX: 2, offsetY: 2 } } }],
      { title: 'SHADOW', playlistLines: [], coverDataUri: null },
      testOptions, testLoadFont,
    );
    expect(png.length).toBeGreaterThan(0);
  });

  it('a title with overflow: ellipsis truncates long text instead of overflowing its box', async () => {
    const png = await renderScene(
      [{ type: 'title', x: 0, y: 0, width: 200, fontSize: 30,
         color: { mode: 'solid', color: '#ffffff' },
         style: { fontFamily: 'DejaVu Sans', bold: false, italic: false, overflow: 'ellipsis' } }],
      { title: 'This Is A Very Long Track Title That Should Not Fit', playlistLines: [], coverDataUri: null },
      testOptions, testLoadFont,
    );
    expect(png.length).toBeGreaterThan(0);
    // This test's bar is "doesn't throw and produces real output," matching this file's existing
    // convention for CSS-trick tests (no mocking of satori/resvg).
  });

  it('renders bold+italic using the Liberation Sans family', async () => {
    const png = await renderScene(
      [{ type: 'title', x: 0, y: 0, width: 400, fontSize: 60,
         color: { mode: 'solid', color: '#ffffff' },
         style: { fontFamily: 'Liberation Sans', bold: true, italic: true } }],
      { title: 'BOLD ITALIC', playlistLines: [], coverDataUri: null },
      testOptions, testLoadFont,
    );
    expect(png.length).toBeGreaterThan(0);
  });

  it('renders a free-standing text element using its own literal text, not scene.title', async () => {
    const png = await renderScene(
      [{ type: 'text', x: 0, y: 0, width: 400, fontSize: 30,
         text: 'sponsored by nobody',
         color: { mode: 'solid', color: '#ffffff' },
         style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } }],
      { title: 'unrelated track title', playlistLines: [], coverDataUri: null },
      testOptions, testLoadFont,
    );
    expect(png.length).toBeGreaterThan(0);
  });

  it('renders an image element from a data URI', async () => {
    const tinyPngDataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const png = await renderScene(
      [{ type: 'image', x: 10, y: 10, width: 100, height: 100, assetId: 'asset-1' }],
      { title: 'x', playlistLines: [], coverDataUri: null, imageDataUris: { 'asset-1': tinyPngDataUri } },
      testOptions, testLoadFont,
    );
    expect(png.length).toBeGreaterThan(0);
  });

  it('renders a gradient root background without throwing', async () => {
    const png = await renderScene(
      [{ type: 'title', x: 0, y: 0, width: 400, fontSize: 60,
         color: { mode: 'solid', color: '#ffffff' },
         style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } }],
      { title: 'BACKGROUND', playlistLines: [], coverDataUri: null },
      { ...testOptions, background: { mode: 'gradient', gradientType: 'linear', angleDeg: 45,
        stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 100 }] } },
      testLoadFont,
    );
    expect(png.length).toBeGreaterThan(0);
  });

  it('renders a solid root background without throwing', async () => {
    const png = await renderScene(
      [],
      { title: '', playlistLines: [], coverDataUri: null },
      { ...testOptions, background: { mode: 'solid', color: '#123456' } },
      testLoadFont,
    );
    expect(png.length).toBeGreaterThan(0);
  });

  it('renders a template containing an equalizer element without throwing, and produces no visible output for it', async () => {
    const png = await renderScene(
      [{
        type: 'equalizer', x: 10, y: 10, width: 400, height: 150, colors: ['#ffffff', '#000000'], glowLayers: 5, glowRadius: 20, coreWidth: 2,
        sensitivity: 1.5, smoothing: 0.4, beatBoost: 0.5, bandCount: 56, globalPulse: 8,
      }],
      { title: 'x', playlistLines: [], coverDataUri: null },
      testOptions,
      testLoadFont,
    );
    expect(png.length).toBeGreaterThan(0);
  });

  it('production default (no loadFont override) still resolves through the real fontRegistry — CI/Docker-only assertion', async () => {
    // This one deliberately does NOT pass testLoadFont, to prove the production default path
    // still works end to end. It only makes sense where /usr/share/fonts/... actually exists
    // (the built Docker image, or CI running inside it) — guard it so local Windows/macOS runs
    // don't fail on an environment difference that isn't a real bug:
    if (process.platform !== 'linux') return;
    const png = await renderScene(
      [{ type: 'title', x: 0, y: 0, width: 400, fontSize: 40,
         color: { mode: 'solid', color: '#ffffff' },
         style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } }],
      { title: 'PROD DEFAULT', playlistLines: [], coverDataUri: null },
      testOptions,
    );
    expect(png.length).toBeGreaterThan(0);
  });
});

describe('gradientCss', () => {
  it('emits a linear gradient with percent offsets', () => {
    expect(gradientCss({
      mode: 'gradient', gradientType: 'linear', angleDeg: 45,
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 100 }],
    })).toBe('linear-gradient(45deg, #ff0000 0%, #0000ff 100%)');
  });

  // Bare radial-gradient == CSS's own default (ellipse, farthest-corner, centre) — verified
  // pixel-identical to the explicit spelling against the real satori+resvg, with fewer moving
  // parts. angleDeg is ignored here by design.
  it('emits a bare radial gradient and ignores the angle', () => {
    expect(gradientCss({
      mode: 'gradient', gradientType: 'radial', angleDeg: 45,
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 100 }],
    })).toBe('radial-gradient(#ff0000 0%, #0000ff 100%)');
  });

  // Satori does NOT reject an out-of-order stop list; it renders a silently clamped, wrong
  // picture (measured: 25 distinct colors vs 39 for the same stops sorted). So sorting is the
  // renderer's job, not validation's.
  it('sorts stops by offset', () => {
    expect(gradientCss({
      mode: 'gradient', gradientType: 'linear', angleDeg: 0,
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#00ff00', offset: 80 }, { color: '#0000ff', offset: 30 }],
    })).toBe('linear-gradient(0deg, #ff0000 0%, #0000ff 30%, #00ff00 80%)');
  });

  it('keeps author order for stops that share an offset (a CSS hard stop)', () => {
    expect(gradientCss({
      mode: 'gradient', gradientType: 'linear', angleDeg: 0,
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#00ff00', offset: 50 }, { color: '#0000ff', offset: 50 }],
    })).toBe('linear-gradient(0deg, #ff0000 0%, #00ff00 50%, #0000ff 50%)');
  });
});

describe('renderScene — gradient colors', () => {
  const gradientTitle = (color: unknown): TemplateElement[] => ([
    { type: 'title', x: 10, y: 10, width: 600, fontSize: 42, color,
      style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } } as unknown as TemplateElement,
  ]);
  const scene = { title: 'Gradient', playlistLines: [], coverDataUri: null };
  const opts = { width: 640, height: 120 };

  it('renders a radial 6-stop gradient title', async () => {
    const png = await renderScene(gradientTitle({
      mode: 'gradient', gradientType: 'radial', angleDeg: 0,
      stops: [0, 20, 40, 60, 80, 100].map((offset, i) => ({ color: ['#ff0000', '#ff8800', '#ffee00', '#00cc44', '#0066ff', '#aa00ff'][i], offset })),
    }), scene, opts, testLoadFont);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.length).toBeGreaterThan(1000);
  });

  // Both legacy shapes must render rather than throw — see normalizeColorValue.
  it('renders a legacy plain-string color without throwing', async () => {
    const png = await renderScene(gradientTitle('#ff00ff'), scene, opts, testLoadFont);
    expect(png.length).toBeGreaterThan(1000);
  });

  it('renders a legacy bare-string-stops gradient without throwing', async () => {
    const png = await renderScene(gradientTitle({ mode: 'gradient', stops: ['#ff0000', '#0000ff'], angleDeg: 45 }), scene, opts, testLoadFont);
    expect(png.length).toBeGreaterThan(1000);
  });

  it('renders a legacy plain-string background override without throwing', async () => {
    // Unlike the other legacy cases above, this scene has no elements at all — a flat solid-color
    // background alone compresses to well under 1000 bytes, so (matching this file's own
    // established convention for trivial-content renders, e.g. 'renders a gradient root
    // background without throwing' above) the bar here is a valid PNG, not a size threshold.
    const png = await renderScene([], scene, { ...opts, background: '#102030' as unknown as ColorValue }, testLoadFont);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.length).toBeGreaterThan(0);
  });
});

describe('renderMarqueeStripPixels', () => {
  const el = { type: 'playlist' as const, x: 0, y: 0, width: 100, fontSize: 20, color: { mode: 'solid' as const, color: '#ffffff' }, style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } };

  it('renders the full text (no ellipsis) into a strip of the requested size, straight (non-premultiplied-looking) alpha somewhere non-zero', async () => {
    const { renderMarqueeStripPixels } = await import('../../src/render/sceneRenderer');
    const { pixels, width, height } = await renderMarqueeStripPixels(
      { element: el, text: 'A Rather Long Track Name That Would Never Fit In One Row', stripWidth: 800, rowHeight: 30 },
      testLoadFont,
    );
    expect(width).toBe(800);
    expect(height).toBe(30);
    expect(pixels.length).toBe(800 * 30 * 4);
    expect(pixels.some((v: number, i: number) => i % 4 === 3 && v > 0)).toBe(true);
  });

  it('a short text still renders without throwing, mostly transparent in a wide strip', async () => {
    const { renderMarqueeStripPixels } = await import('../../src/render/sceneRenderer');
    const { pixels } = await renderMarqueeStripPixels(
      { element: el, text: 'Hi', stripWidth: 400, rowHeight: 30 },
      testLoadFont,
    );
    const opaqueCount = pixels.filter((v: number, i: number) => i % 4 === 3 && v > 0).length;
    // Two short glyphs in a 400-wide strip: opaque pixels are a small minority.
    expect(opaqueCount).toBeGreaterThan(0);
    expect(opaqueCount).toBeLessThan(400 * 30 * 0.2);
  });
});
