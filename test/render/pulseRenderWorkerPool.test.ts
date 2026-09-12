const runMock = jest.fn();
const piscinaCtor = jest.fn().mockImplementation(() => ({ run: runMock }));

jest.mock('piscina', () => piscinaCtor);

import { renderPulseFrame } from '../../src/render/pulseRenderWorkerPool';

describe('renderPulseFrame (pool wrapper)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates the pool with useAtomics disabled so the worker event loop keeps turning between tasks', async () => {
    // Piscina's default Atomics.wait()-based dispatch loop pulls the next task straight off the
    // port without ever returning to the worker's event loop — and Node-API defers native
    // finalizers (resvg's pixmap + the external pixels buffer, ~2.8MB per frame) to that loop.
    // At 30 renders/s per stream that retained ~2.3GB/min of RSS on a real deployment until
    // the host fell over; the pool option is the actual fix (see pulseRenderWorkerPool.ts).
    runMock.mockResolvedValue({ pixels: new Uint8Array(4), width: 1, height: 1 });

    await renderPulseFrame('<svg/>');

    expect(piscinaCtor).toHaveBeenCalledTimes(1);
    expect(piscinaCtor).toHaveBeenCalledWith(expect.objectContaining({ useAtomics: false }));
  });

  it('returns pixels as a real Buffer, not the plain Uint8Array structured clone hands back', async () => {
    runMock.mockResolvedValue({ pixels: new Uint8Array([1, 2, 3, 4]), width: 1, height: 1 });

    const result = await renderPulseFrame('<svg/>');

    expect(Buffer.isBuffer(result.pixels)).toBe(true);
    expect([...result.pixels]).toEqual([1, 2, 3, 4]);
  });
});
