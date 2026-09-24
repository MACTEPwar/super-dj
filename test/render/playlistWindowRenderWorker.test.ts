jest.mock('../../src/render/sceneRenderer', () => ({
  // 2x2 opaque white, premultiplied (= straight for alpha 255)
  renderPlaylistWindowPixels: jest.fn().mockResolvedValue({ pixels: new Uint8Array(Array(16).fill(255)), width: 2, height: 2 }),
  renderMarqueeStripPixels: jest.fn().mockResolvedValue({ pixels: new Uint8Array(Array(16).fill(255)), width: 2, height: 2 }),
}));
import render, { renderMarqueeStrip } from '../../src/render/playlistWindowRenderWorker';

it('unpremultiplies and converts to a yuva420p frame of 2.5*w*h bytes', async () => {
  const frame = await render({ element: {} as any, rows: [], region: { x: 0, y: 0, width: 2, height: 2, originX: 0, originY: 0 } });
  expect(frame.length).toBe(10);
  expect([frame[0], frame[4], frame[5], frame[6]]).toEqual([235, 128, 128, 255]);
});

it('renderMarqueeStrip unpremultiplies but returns STRAIGHT RGBA (4 bytes/pixel), not yuva420p', async () => {
  const strip = await renderMarqueeStrip({ element: {} as any, text: 'x', stripWidth: 2, rowHeight: 2, paddingLeft: 0 });
  expect(strip.length).toBe(16); // 2*2*4
  expect(strip[3]).toBe(255); // alpha preserved
});
