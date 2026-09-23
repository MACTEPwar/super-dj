import { DonationRequestQueue } from '../../src/donations/donationRequestQueue';

const later = <T>(ms: number, value: T, log?: string[], tag?: string) =>
  new Promise<T>((resolve) => setTimeout(() => { log?.push(tag!); resolve(value); }, ms));

describe('DonationRequestQueue', () => {
  it('processes tasks strictly in enqueue order, even when a later one would resolve faster', async () => {
    const order: string[] = [];
    const queue = new DonationRequestQueue();
    const p1 = queue.enqueue(() => later(50, 'slow free-text', order, 'first'));
    const p2 = queue.enqueue(() => later(0, 'instant exact-track', order, 'second'));
    expect(await Promise.all([p1, p2])).toEqual(['slow free-text', 'instant exact-track']);
    expect(order).toEqual(['first', 'second']);
  });

  it('does not START the next task until the previous one has settled', async () => {
    const queue = new DonationRequestQueue();
    let resolveFirst!: (v: string) => void;
    const second = jest.fn(() => Promise.resolve('b'));
    queue.enqueue(() => new Promise<string>((r) => { resolveFirst = r; }));
    queue.enqueue(second);
    await Promise.resolve(); await Promise.resolve();
    expect(second).not.toHaveBeenCalled();
    resolveFirst('a');
    await new Promise((r) => setImmediate(r));
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('a rejecting task never stalls the ones behind it', async () => {
    const queue = new DonationRequestQueue();
    const failing = queue.enqueue(() => Promise.reject(new Error('boom')));
    const next = queue.enqueue(() => Promise.resolve('ok'));
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });

  it('head-of-line timeout: a hung task stops blocking the queue after taskTimeoutMs (knock-on of one shared queue)', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const queue = new DonationRequestQueue({ taskTimeoutMs: 1000 });
      const hung = queue.enqueue(() => new Promise<string>(() => {}));
      const behind = jest.fn(() => Promise.resolve('ran'));
      const p = queue.enqueue(behind);
      await Promise.resolve();
      expect(behind).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1000);
      await expect(p).resolves.toBe('ran');
      expect(warn).toHaveBeenCalled();
      void hung; // never settles; the caller's own promise stays pending, which is fine
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  it('a task that resolves AFTER its timeout still resolves its own promise (inserting late, out of order) and disturbs nothing queued after it', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const queue = new DonationRequestQueue({ taskTimeoutMs: 1000 });
      const inserted: string[] = [];
      let finishSlow!: () => void;
      const slow = queue.enqueue(() => new Promise<string>((r) => { finishSlow = () => { inserted.push('slow'); r('slow done'); }; }));
      const second = queue.enqueue(async () => { inserted.push('second'); return 'second done'; });
      const third = queue.enqueue(async () => { inserted.push('third'); return 'third done'; });
      await Promise.resolve();
      jest.advanceTimersByTime(1000); // slow times out -> queue moves on
      await expect(second).resolves.toBe('second done');
      await expect(third).resolves.toBe('third done');
      finishSlow(); // completes late
      await expect(slow).resolves.toBe('slow done');
      expect(inserted).toEqual(['second', 'third', 'slow']); // documented: that one request lands out of order
      jest.advanceTimersByTime(5000);
      expect(warn).toHaveBeenCalledTimes(1); // only the one real timeout was logged
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  it('a task that throws SYNCHRONOUSLY rejects its own promise, releases the queue at once, and leaves no stray timeout log', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const queue = new DonationRequestQueue({ taskTimeoutMs: 1000 });
      const bad = queue.enqueue(() => { throw new Error('sync'); });
      const next = queue.enqueue(() => Promise.resolve('ok'));
      await expect(bad).rejects.toThrow('sync');
      await expect(next).resolves.toBe('ok');
      jest.advanceTimersByTime(5000);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });
});
