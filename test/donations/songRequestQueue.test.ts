import { SongRequestQueue } from '../../src/donations/songRequestQueue';
import { SongRequestResult } from '../../src/donations/songRequestAction';

describe('SongRequestQueue', () => {
  it('processes requests strictly in enqueue order, even when a later one would resolve faster', async () => {
    const order: string[] = [];
    const delays: Record<string, number> = { first: 50, second: 5 }; // second "downloads" faster
    const execute = jest.fn((query: string): Promise<SongRequestResult> => new Promise((resolve) => {
      setTimeout(() => {
        order.push(query);
        resolve({ ok: true });
      }, delays[query]);
    }));
    const queue = new SongRequestQueue(execute);

    const p1 = queue.enqueue('first');
    const p2 = queue.enqueue('second');
    await Promise.all([p1, p2]);

    expect(order).toEqual(['first', 'second']);
    // Fully sequential: 'second' must not even START downloading until 'first' has resolved.
    expect(execute).toHaveBeenNthCalledWith(1, 'first');
  });

  it('does not start the next request until the previous one has fully resolved', async () => {
    const execute = jest.fn();
    let resolveFirst!: (result: SongRequestResult) => void;
    execute.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    execute.mockImplementationOnce(() => Promise.resolve({ ok: true }));
    const queue = new SongRequestQueue(execute);

    queue.enqueue('first');
    queue.enqueue('second');
    await Promise.resolve();
    await Promise.resolve();

    expect(execute).toHaveBeenCalledTimes(1);

    resolveFirst({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('a rejecting request does not stall requests queued behind it', async () => {
    const execute = jest.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: true } as SongRequestResult);
    const queue = new SongRequestQueue(execute);

    const p1 = queue.enqueue('first').catch((err) => err as Error);
    const p2 = queue.enqueue('second');

    await expect(p1).resolves.toBeInstanceOf(Error);
    await expect(p2).resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('returns each call\'s own result to its own caller', async () => {
    const execute = jest.fn()
      .mockResolvedValueOnce({ ok: false, reason: 'mediaSearchFailed', message: 'not found' } as SongRequestResult)
      .mockResolvedValueOnce({ ok: true } as SongRequestResult);
    const queue = new SongRequestQueue(execute);

    const [r1, r2] = await Promise.all([queue.enqueue('first'), queue.enqueue('second')]);

    expect(r1).toEqual({ ok: false, reason: 'mediaSearchFailed', message: 'not found' });
    expect(r2).toEqual({ ok: true });
  });
});
