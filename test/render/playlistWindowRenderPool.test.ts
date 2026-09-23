const runMock = jest.fn();
const piscinaCtor = jest.fn().mockImplementation(() => ({ run: runMock }));
jest.mock('piscina', () => piscinaCtor);

import { renderPlaylistWindowFrame } from '../../src/render/playlistWindowRenderPool';

const REQ: any = { element: {}, rows: [], region: { x: 0, y: 0, width: 2, height: 2, originX: 0, originY: 0 } };

describe('renderPlaylistWindowFrame (pool wrapper)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates its own small pool with useAtomics disabled', async () => {
    runMock.mockResolvedValue(new Uint8Array(10));
    await renderPlaylistWindowFrame(REQ);
    expect(piscinaCtor).toHaveBeenCalledWith(expect.objectContaining({ useAtomics: false }));
    expect(piscinaCtor.mock.calls[0][0].maxThreads).toBeLessThanOrEqual(2);
    expect(piscinaCtor.mock.calls[0][0].filename).toMatch(/playlistWindowRenderWorker\.js$/);
  });

  it('returns a real Buffer, not the plain Uint8Array structured clone hands back', async () => {
    runMock.mockResolvedValue(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    const result = await renderPlaylistWindowFrame(REQ);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(10);
  });

  it('passes an abort signal (render timeout)', async () => {
    runMock.mockResolvedValue(new Uint8Array(10));
    await renderPlaylistWindowFrame(REQ);
    expect(runMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
