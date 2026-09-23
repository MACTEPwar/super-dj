import * as fs from 'fs';
import { playlistWindowNode, renderPlaylistWindowPixels } from '../../src/render/sceneRenderer';
import { settledRows } from '../../src/ffmpeg/playlistWindowTransition';

// Cross-platform note: production's default font loader (fontRegistry.ts) only knows
// hardcoded Linux paths (/usr/share/fonts/...), which don't exist on a Windows/macOS dev
// machine. testLoadFont substitutes any real local .ttf found below for every family/weight/
// style combination a test asks for — same approach as sceneRenderer.test.ts.
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

const testFontPath = findFontPath();
async function testLoadFont(_family: string, _bold: boolean, _italic: boolean): Promise<Buffer> {
  return fs.promises.readFile(testFontPath);
}

const el = { type: 'playlist' as const, x: 512, y: 160, width: 700, fontSize: 22, color: { mode: 'solid' as const, color: '#ffffff' }, style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } };

it('with settled rows it is exactly the pre-Phase-C baked node', () => {
  const lines = ['  a', '▶ b', '  c'];
  const node = playlistWindowNode(el, settledRows(lines.map((text, i) => ({ key: String(i), text, isCurrent: false }))), { x: el.x, y: el.y });
  expect(node).toEqual({
    type: 'div',
    props: {
      style: { position: 'absolute', left: 512, top: 160, width: 700, fontSize: 22, display: 'flex', flexDirection: 'column', color: '#ffffff', fontFamily: 'DejaVu Sans', fontWeight: 400, fontStyle: 'normal' },
      children: lines.map((line) => ({ type: 'div', props: { style: { display: 'flex' }, children: line } })),
    },
  });
});

it('animation props only ever ADD style keys to a row', () => {
  const node: any = playlistWindowNode(el, [{ key: 'i:0', text: '  new', opacity: 0.5, offsetX: 12, maxHeightFactor: 0.75 }], { x: 2, y: 2 });
  expect(node.props.style.left).toBe(2);
  expect(node.props.children[0].props.style).toEqual({ display: 'flex', opacity: 0.5, marginLeft: 12, maxHeight: 16.5, overflow: 'hidden' });
});

it('renderPlaylistWindowPixels: w*h*4 bytes; nothing drawn for no rows; opacity 0 draws nothing', async () => {
  const region = { x: 0, y: 0, width: 200, height: 100, originX: 0, originY: 0 };
  const small = { ...el, x: 0, y: 0, width: 120, fontSize: 20 };
  const empty = await renderPlaylistWindowPixels({ element: small, region, rows: [] }, testLoadFont);
  expect(empty.pixels.length).toBe(200 * 100 * 4);
  expect(empty.pixels.every((v, i) => i % 4 !== 3 || v === 0)).toBe(true);
  const hidden = await renderPlaylistWindowPixels({ element: small, region, rows: [{ key: 'a', text: '▶ b', opacity: 0 }] }, testLoadFont);
  expect(hidden.pixels.every((v, i) => i % 4 !== 3 || v === 0)).toBe(true);
  const shown = await renderPlaylistWindowPixels({ element: small, region, rows: [{ key: 'a', text: '▶ b' }] }, testLoadFont);
  expect(shown.pixels.some((v, i) => i % 4 === 3 && v > 0)).toBe(true);
});
