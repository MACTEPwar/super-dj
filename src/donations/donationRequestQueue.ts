export const DONATION_TASK_TIMEOUT_MS = 90_000;

// ONE queue for every donation-triggered action (free-text song requests AND exact library-track
// requests): "whoever donated first plays first". A task is not even started until every task
// enqueued ahead of it has settled, so a donation's place in the play queue is fixed by when the
// webhook (or the rule Test button) dispatched it — never by which task happened to finish first.
// An exact-track task is two indexed queries and resolves almost at once when its turn comes; a
// free-text task waits on the external media-search download. Deliberately fully sequential.
//
// Head-of-line timeout: HttpMediaSearchClient sets no timeout of its own, so a stuck download is
// bounded only by Node fetch's default (~300s), and would hold up every later donation of BOTH
// types for that long. After taskTimeoutMs the queue moves on. The timed-out task is not
// cancelled: if it completes later it still inserts — one request out of order (logged), instead
// of every later donation delayed by minutes. 90s is well above a normal download, and above the
// point at which the media-search service normally answers with its own 504; retune it if that
// service's own timeout changes.
//
// The caller's OWN promise is never affected by this timeout: it settles when its task does. So
// the rule "Test" button's HTTP request simply waits for its own task — up to fetch's ~300s in the
// worst case — and then reports the real outcome. Accepted as-is: it's a manual, one-person
// diagnostic tool, and a real result beats a synthetic "timed out".
export class DonationRequestQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly taskTimeoutMs: number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  constructor(options: { taskTimeoutMs?: number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout } = {}) {
    this.taskTimeoutMs = options.taskTimeoutMs ?? DONATION_TASK_TIMEOUT_MS;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  // The timeout is armed when the task STARTS (inside the tail callback), not at enqueue time, so
  // time spent waiting behind other donations never counts against a task's own budget.
  enqueue<R>(task: () => Promise<R>): Promise<R> {
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const result = this.tail.then(() => {
      const timer = this.setTimer(() => {
        console.error(`donation task still running after ${this.taskTimeoutMs}ms; releasing the queue so later donations aren't blocked (this one may now land out of order)`);
        release();
      }, this.taskTimeoutMs);
      let run: Promise<R>;
      try {
        run = task();
      } catch (err) {
        // A synchronous throw: clear the timer too, or it would log a bogus "still running" later.
        this.clearTimer(timer);
        release();
        throw err;
      }
      run.then(() => undefined, () => undefined).finally(() => { this.clearTimer(timer); release(); });
      return run;
    });
    result.catch(() => release()); // defensive; release() is idempotent
    this.tail = released;
    return result;
  }
}
