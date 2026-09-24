function needsDrain(pipe: NodeJS.WritableStream): boolean {
  return (pipe as unknown as { writableNeedDrain?: boolean }).writableNeedDrain === true;
}

// The most frames a single tick will write to catch the frame count up after the event loop was
// stalled — ~1/3s at 30fps, longer than CanvasFeeder's 200ms heartbeat, so any stall the canvas
// heartbeat itself rides out without losing a frame is caught up fully here too. A longer stall
// cost the canvas frames as well (it has no catch-up), so replaying it all here would only push
// this pipe ahead of the canvas and pin it against backpressure — and this also bounds how much
// raw RGBA a catch-up can ever park in Node's write buffer at once (see writeDueFrames).
export const MAX_CATCH_UP_FRAMES = 10;

/**
 * Keeps a raw-video pipe declared to ffmpeg at a fixed `-r fps` (with no timestamps) fed with
 * exactly as many frames as wall-clock time says it should have received. ffmpeg synthesizes that
 * pipe's timeline purely from the frame count, and its overlay frame-sync stalls the WHOLE encode
 * on an input that falls behind — so the count, not any render, is what must track real time.
 * This is the same invariant as CanvasFeeder's "every write lands exactly heartbeatMs apart" rule,
 * in the form that holds at 30fps; and a render can never add an extra frame, because renders only
 * call setFrame() and this class alone writes. Extracted from PulseVisualizer (behaviour-identical)
 * so PlaylistWindowFeeder shares it instead of copying it.
 */
export class RawFramePacer {
  private pipe: NodeJS.WritableStream | null = null;
  private frame: Buffer | null = null;
  private attachedAtSeconds = 0;
  // Frames written plus frames deliberately forgiven — see writeDueFrames() for the distinction.
  private framesAccounted = 0;
  // Frames actually written to the pipe — i.e. the index ffmpeg will give the next one, which is
  // what fixes its place on the output timeline. Deliberately NOT framesAccounted: a forgiven
  // frame was never written, so ffmpeg never numbered it.
  private written = 0;
  private readonly onDrain = () => {
    // The pipe just came unblocked. Everything that came due while it was blocked is forgiven
    // except the one frame the blocked tick left owed — see writeDueFrames() for why.
    this.framesAccounted = Math.max(this.framesAccounted, this.framesDue() - 1);
    this.writeDueFrames();
  };

  constructor(private readonly options: { fps: number; now: () => number }) {}

  /** Called once, right after the persistent encoder starts — see StreamController.start(). */
  attach(pipe: NodeJS.WritableStream): void {
    this.pipe = pipe;
    this.attachedAtSeconds = this.options.now();
    this.framesAccounted = 0;
    this.written = 0;
    pipe.on('drain', this.onDrain);
  }

  detach(): void {
    this.pipe?.removeListener('drain', this.onDrain);
    this.pipe = null;
  }

  setFrame(frame: Buffer): void {
    this.frame = frame;
  }

  get framesWritten(): number {
    return this.written;
  }

  // How many frames the pipe should have received by now. The pipe is declared to ffmpeg at a
  // fixed `-r fps` with no timestamps, so ffmpeg synthesizes its timeline purely from this count —
  // and its overlay filter can't emit any output frame until this pipe has a NEWER one. That makes
  // the count, not the tick, the thing that has to track wall-clock time: every frame this class
  // fails to deliver stalls the whole stream (canvas, audio, everything) by one frame interval,
  // permanently, because nothing downstream ever catches up. Measured against a real ffmpeg
  // binary: with a late-firing 30fps timer the encoder ran at 0.7x real time on an idle CPU, and a
  // viewer sees that as the picture's only moving element — this one — periodically freezing.
  // (The +1e-6 keeps e.g. 0.1 * 10 = 0.9999... from rounding a frame that is due down to zero.)
  private framesDue(): number {
    return Math.floor((this.options.now() - this.attachedAtSeconds) * this.options.fps + 1e-6);
  }

  // Brings the frame count up to date. Unlike CanvasFeeder's writeCachedFrame(), which can simply
  // skip a tick under backpressure because its content is near-static and ffmpeg holding the
  // last canvas frame a little longer changes nothing, a frame this class never writes is not
  // harmless: it's a permanently missing slot in a count-derived timeline (see framesDue()).
  // Which of two things a missed write means depends on the pipe's own state:
  //
  // - Pipe free: ffmpeg is reading as fast as we write, i.e. it's waiting on US, and the whole
  //   stream stalls for every frame we're short. So a tick that fired late writes every frame it
  //   owes now — resends of the latest frame, a one-interval hold no viewer can see — bounded by
  //   MAX_CATCH_UP_FRAMES, which is also what bounds the raw RGBA parked in Node's buffer.
  //
  // - Pipe backed up: ffmpeg is NOT reading this pipe, so it's waiting on something else — the
  //   canvas, whose frames it consumes in one-heartbeat bursts (its fps= stage only releases a
  //   canvas frame's copies once the next canvas frame lands). Frames that come due meanwhile
  //   stall nothing and are forgiven, all but one, which the pipe's 'drain' event then writes so
  //   a momentary stall while ffmpeg IS waiting on us never loses a frame. Forgiving (rather
  //   than deferring and replaying as duplicates) is deliberate and verified against a real
  //   ffmpeg binary: replaying produced a 4-frame hold then a 4-frame jump on every heartbeat,
  //   whereas each forgiven frame nudges this pipe's timeline to just behind the canvas bursts,
  //   where consumption is frame-by-frame and the pipe stops backing up at all.
  writeDueFrames(): void {
    if (!this.frame || !this.pipe) return;
    const due = this.framesDue();
    if (needsDrain(this.pipe)) {
      this.framesAccounted = Math.max(this.framesAccounted, due - 1);
      return;
    }
    if (due - this.framesAccounted > MAX_CATCH_UP_FRAMES) this.framesAccounted = due - MAX_CATCH_UP_FRAMES;
    while (this.framesAccounted < due) {
      this.pipe.write(this.frame);
      this.framesAccounted += 1;
      this.written += 1;
    }
  }
}
