jest.mock('../../src/render/sceneRenderer', () => ({ renderScene: jest.fn().mockResolvedValue(Buffer.from('fake-png')) }));

import render from '../../src/render/renderWorker';
import { renderScene } from '../../src/render/sceneRenderer';

describe('renderWorker', () => {
  it('rewraps fontData as a real Buffer before calling renderScene, even when given a plain Uint8Array', async () => {
    // Structured clone (what postMessage uses to hand task data INTO the worker) has no concept
    // of Node's Buffer subclass — fontData read via fs.readFile() on the main thread arrives here
    // a plain Uint8Array. Satori's font parsing silently produces missing-glyph boxes for
    // anything outside ASCII if it's not rewrapped first (found via a live smoke test with real
    // Cyrillic text, not a unit test — this guards the regression going forward).
    const plainUint8Array = new Uint8Array([1, 2, 3, 4]);

    await render({
      elements: [],
      scene: { title: 't', playlistLines: [], coverDataUri: null },
      options: { width: 10, height: 10, fontData: plainUint8Array as unknown as Buffer, fontFamily: 'X' },
    });

    const passedFontData = (renderScene as jest.Mock).mock.calls[0][2].fontData;
    expect(Buffer.isBuffer(passedFontData)).toBe(true);
    expect(Buffer.from(passedFontData)).toEqual(Buffer.from([1, 2, 3, 4]));
  });
});
