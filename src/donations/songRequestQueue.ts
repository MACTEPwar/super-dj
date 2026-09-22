import { SongRequestResult } from './songRequestAction';

// Guarantees donation-triggered song requests are downloaded AND inserted into the play queue in
// the exact order they were enqueued — regardless of how long any individual media-search fetch
// takes. Without this, two donations racing on the external HTTP fetch could insert (and
// therefore play) in whichever order their downloads happened to finish in, not the order the
// donations actually arrived in — the whole point of StreamController's interrupt-and-resume
// mechanism is "whoever donated first plays first", so this has to hold even when the second
// donor's track downloads faster than the first's.
//
// Deliberately fully sequential (one request processed start-to-finish before the next one's own
// fetch even begins), not "download in parallel, deliver in order" — the simpler of the two, and
// the one actually asked for: request ordering matters here, download latency doesn't.
export class SongRequestQueue {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly execute: (query: string) => Promise<SongRequestResult>) {}

  enqueue(query: string): Promise<SongRequestResult> {
    const result = this.tail.then(() => this.execute(query));
    // execute() never rejects (see SongRequestResult) — this .catch() is defensive only, so one
    // request's own failure can never stall every request queued behind it.
    this.tail = result.catch(() => undefined);
    return result;
  }
}
