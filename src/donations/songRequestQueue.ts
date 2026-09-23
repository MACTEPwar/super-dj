import { SongRequestResult } from './songRequestAction';

// Guarantees donation-triggered song requests are downloaded AND inserted into the play queue in
// the exact order they were enqueued — regardless of how long any individual media-search fetch
// takes. Donation tracks go through StreamController.enqueueTrack()'s single insertNext FIFO, so
// insertion order is play order. SongRequestQueue exists because insertion has to happen in
// ARRIVAL order too — the query itself is an async HTTP fetch to an external media-search
// service, and without this queue, two donations racing on that fetch could insert (and
// therefore play) in whichever order their downloads happened to finish, not the order the
// donations actually arrived in, so this has to hold even when the second donor's track
// downloads faster than the first's.
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
