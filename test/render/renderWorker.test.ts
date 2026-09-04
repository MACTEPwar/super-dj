jest.mock('../../src/render/sceneRenderer', () => ({ renderScene: jest.fn().mockResolvedValue(Buffer.from('fake-png')) }));

import render from '../../src/render/renderWorker';
import { renderScene } from '../../src/render/sceneRenderer';

describe('renderWorker', () => {
  it('forwards its task fields to renderScene and returns its result', async () => {
    // Font loading now happens inside renderScene() itself (see sceneRenderer.ts) — the font
    // bytes never cross the postMessage boundary into or out of this worker any more, so there
    // is nothing left for this wrapper to rewrap. This test only needs to prove the wrapper
    // delegates its task fields correctly and passes the result through; real font-loading
    // correctness (including the historical Cyrillic-glyph regression) is covered end to end by
    // sceneRenderer.test.ts's real satori+resvg tests via the loadFont injection point.
    const elements: never[] = [];
    const scene = { title: 't', playlistLines: [], coverDataUri: null };
    const options = { width: 10, height: 10 };

    const result = await render({ elements, scene, options });

    expect(renderScene).toHaveBeenCalledWith(elements, scene, options);
    expect(result).toEqual(Buffer.from('fake-png'));
  });
});
