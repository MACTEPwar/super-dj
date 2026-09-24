import * as fs from 'fs';
import { measureTextWidth } from '../../src/render/textWidth';

// Cross-platform note: resolveFontFile only knows hardcoded Linux paths
// (/usr/share/fonts/...), which don't exist on a Windows/macOS dev machine — same convention as
// sceneRenderer.test.ts/playlistWindowNode.test.ts: substitute any real local .ttf for whatever
// path is requested.
const FONT_CANDIDATES = [
  'C:\\Windows\\Fonts\\arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
];

function findFontPath(): string {
  for (const candidate of FONT_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`No test font found — tried: ${FONT_CANDIDATES.join(', ')}`);
}

const testFontPath = findFontPath();
async function testLoadFont(_path: string): Promise<Buffer> {
  return fs.promises.readFile(testFontPath);
}

it('measures a real, positive pixel width for real text', async () => {
  const width = await measureTextWidth('Hello world', 'DejaVu Sans', false, false, 24, testLoadFont);
  expect(width).toBeGreaterThan(0);
});

it('a longer string measures wider than a shorter one, at the same font size', async () => {
  const short = await measureTextWidth('Hi', 'DejaVu Sans', false, false, 24, testLoadFont);
  const long = await measureTextWidth('Hello world, this is a much longer string', 'DejaVu Sans', false, false, 24, testLoadFont);
  expect(long).toBeGreaterThan(short);
});

it('measures Cyrillic text without throwing, with a positive width', async () => {
  const width = await measureTextWidth('Маленький енотик', 'DejaVu Sans', false, false, 24, testLoadFont);
  expect(width).toBeGreaterThan(0);
});

it('scales linearly with font size (double the size, double the width)', async () => {
  const small = await measureTextWidth('scaling test', 'DejaVu Sans', false, false, 20, testLoadFont);
  const large = await measureTextWidth('scaling test', 'DejaVu Sans', false, false, 40, testLoadFont);
  expect(large).toBeCloseTo(small * 2, 1);
});

it('parses each distinct font file only once, even across repeated measureTextWidth calls', async () => {
  let calls = 0;
  const countingLoadFont = async (_path: string): Promise<Buffer> => {
    calls++;
    return fs.promises.readFile(testFontPath);
  };
  await measureTextWidth('first call', 'DejaVu Sans', false, false, 20, countingLoadFont);
  const callsAfterFirst = calls;
  await measureTextWidth('second call, same font', 'DejaVu Sans', false, false, 20, countingLoadFont);
  expect(calls).toBe(callsAfterFirst);
});
