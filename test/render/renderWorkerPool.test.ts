const runMock = jest.fn();

jest.mock('piscina', () => jest.fn().mockImplementation(() => ({ run: runMock })));

import { renderViaPool } from '../../src/render/renderWorkerPool';

describe('renderViaPool', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns a real Buffer, not the plain Uint8Array structured clone hands back across the worker boundary', async () => {
    // postMessage's structured clone has no concept of Node's Buffer subclass — a worker
    // returning a real Buffer comes back on the main thread as a plain Uint8Array. Express's
    // res.send() silently JSON-serializes anything that isn't Buffer.isBuffer() === true
    // ({"0":137,"1":80,...} instead of raw bytes) rather than erroring, so this regression is
    // invisible unless specifically asserted for.
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    runMock.mockResolvedValue(pngBytes);

    const result = await renderViaPool([], { title: 't', playlistLines: [], coverDataUri: null }, { width: 10, height: 10, fontData: Buffer.alloc(0), fontFamily: 'X' });

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('passes an AbortSignal to the pool so a hung render eventually rejects instead of hanging forever', async () => {
    runMock.mockResolvedValue(new Uint8Array([1]));

    await renderViaPool([], { title: 't', playlistLines: [], coverDataUri: null }, { width: 10, height: 10, fontData: Buffer.alloc(0), fontFamily: 'X' });

    expect(runMock).toHaveBeenCalledWith(expect.anything(), { signal: expect.any(AbortSignal) });
  });
});
