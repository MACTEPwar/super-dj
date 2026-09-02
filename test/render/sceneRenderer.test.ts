import * as fs from 'fs';
import * as path from 'path';
import { renderScene } from '../../src/render/sceneRenderer';
import { TemplateElement } from '../../src/templates/templateTypes';

// A real, small local font so the renderer's actual output gets exercised end to end (no
// fake/mocked satori or resvg here) — deliberately not the production DejaVu Sans path (only
// present inside the Linux container), any valid TTF proves the pipeline works.
const FONT_CANDIDATES = [
  'C:\\Windows\\Fonts\\arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
];

function findFont(): Buffer {
  for (const candidate of FONT_CANDIDATES) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate);
  }
  throw new Error(`No test font found — tried: ${FONT_CANDIDATES.join(', ')}`);
}

const elements: TemplateElement[] = [
  { type: 'cover', x: 40, y: 40, width: 200, height: 200 },
  { type: 'title', x: 280, y: 40, width: 800, fontSize: 42, color: '#ffffff' },
  { type: 'playlist', x: 280, y: 120, width: 800, fontSize: 24, color: '#cccccc' },
];

describe('renderScene', () => {
  it('renders a valid, correctly-sized PNG from a template + scene data', async () => {
    const fontData = findFont();

    const png = await renderScene(
      elements,
      { title: 'Тестовый трек — Ммм...', playlistLines: ['▶ Тестовый трек', '  Следующий трек'], coverDataUri: null },
      { width: 1280, height: 720, fontData, fontFamily: 'TestFont' },
    );

    // PNG signature + a sane, non-trivial size (a blank/broken render would be near-empty).
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.length).toBeGreaterThan(1000);
  });

  it('renders with a real cover image embedded as a data URI', async () => {
    const fontData = findFont();
    const coverPath = path.join(__dirname, '..', '..', 'assets', 'default-cover.png');
    const coverDataUri = `data:image/png;base64,${fs.readFileSync(coverPath).toString('base64')}`;

    const png = await renderScene(
      elements,
      { title: 'Cover test', playlistLines: ['▶ Cover test'], coverDataUri },
      { width: 1280, height: 720, fontData, fontFamily: 'TestFont' },
    );

    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('renders an empty element list as a blank canvas of the requested size, without throwing', async () => {
    const fontData = findFont();

    const png = await renderScene(
      [],
      { title: '', playlistLines: [], coverDataUri: null },
      { width: 640, height: 360, fontData, fontFamily: 'TestFont' },
    );

    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
});
