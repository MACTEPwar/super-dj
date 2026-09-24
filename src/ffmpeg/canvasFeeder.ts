import * as fs from 'fs';
import { Spawner } from './types';
import { buildCanvasFrameArgs, NowPlayingOverlay, TimerOverlay } from './segmentArgs';
import { BLANK_OVERLAY_PNG } from '../render/blankOverlay';

function needsDrain(pipe: NodeJS.WritableStream): boolean {
  return (pipe as unknown as { writableNeedDrain?: boolean }).writableNeedDrain === true;
}

export interface CanvasFeederOptions {
  spawner: Spawner;
  // Fixed on-disk path this feeder writes the current overlay PNG to before every render — same
  // pattern the earlier per-segment pipeline always used, just now feeding a one-shot render
  // instead of a continuous encode.
  overlayImagePath: string;
  // Set only for a template whose baked elements straddle its first animated-gif element — see
  // NowPlayingOverlay.overlayPngAbove and CanvasPlacement in persistentEncoderArgs.ts. Its
  // presence is what makes this feeder a two-layer one for the life of the session: the overlay's
  // `overlayPngAbove` is rendered to its own frame and written to a second pipe, and the timer
  // drawtext moves onto that upper layer so a gif can never end up covering it.
  //
  // Both layers are owned by ONE feeder rather than two instances on purpose. ffmpeg synthesizes
  // each raw pipe's PTS purely from how many frames it has received (both are declared at a fixed
  // `-r heartbeatFps` with no timestamps), so two independent heartbeats — each with its own
  // backpressure check and its own timer drift — would slide the two layers permanently out of
  // register with each other. One heartbeat writing both, or neither, cannot.
  aboveOverlayImagePath?: string;
  fontFile: string;
  width: number;
  height: number;
  // How often the last-rendered frame is resent to the video pipe, regardless of whether content
  // changed — this fixed cadence is what keeps the persistent encoder's declared input framerate
  // (see persistentEncoderArgs.ts's heartbeatFps) matching real wall-clock time. Every actual
  // write — whether from this heartbeat or from render() below — must be exactly heartbeatMs
  // apart; see writeCachedFrame()/render()'s heartbeat-resync comment for why.
  heartbeatMs: number;
  writeFileSync?: (path: string, data: Buffer) => void;
}

export class CanvasFeeder {
  private readonly writeFileSync: (path: string, data: Buffer) => void;
  private cachedFrame: Buffer | null = null;
  private cachedAboveFrame: Buffer | null = null;
  private videoPipe: NodeJS.WritableStream | null = null;
  private aboveVideoPipe: NodeJS.WritableStream | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  // Two independent callers can both call render() close together — a once-a-second timer tick
  // (streamController.ts's timerTicker) and, since the playlist-window burst layer landed, a
  // burst's own canvas-A/canvas-B re-bakes (PlaylistWindowAnimator). Neither awaits the other, so
  // without this pair, two render() calls could run their write-then-ffmpeg-read cycle
  // concurrently against the SAME fixed overlayImagePath — one call's write landing in the middle
  // of the other's ffmpeg reading it, corrupting that frame with a blend of both renders' content
  // (reported live: the outgoing row's text visibly doubled/overlapped with the incoming one for
  // a frame). `rendering`/`pendingQueue` serialize the actual write+spawn+read work so two never
  // overlap, in a way that costs the FIRST/only caller nothing (see the `if (this.rendering)`
  // guard in render() — the common case never touches the queue or an extra microtask tick, which
  // is what keeps every existing render()-then-emitClose()-synchronously test passing unmodified).
  // Strict FIFO, no "skip a stale queued call" shortcut: an earlier design tried discarding a
  // call's finished result whenever a newer one had been ISSUED (not finished) in the meantime,
  // reasoned to be a "latest wins" safety net — real review caught that this discards a call's
  // OWN valid, just-finished render for no reason (issuing a newer call doesn't mean it has a
  // result yet), which under any host load worse than instant could discard EVERY render in a
  // burst and freeze the canvas for the whole session. Plain FIFO already guarantees the last
  // call to actually finish is the most recently issued one, in order, with nothing to skip.
  // `finally` hands the lock directly to the next queued waiter instead of releasing then letting
  // it re-acquire — that release-then-reacquire gap is exactly where a fresh, unqueued render()
  // call could slip in and run concurrently with the waiter that was about to resume, recreating
  // the very file race this exists to close (also caught in review, not by the original tests).
  private rendering = false;
  private pendingQueue: Array<() => void> = [];
  private closed = false;

  constructor(private readonly options: CanvasFeederOptions) {
    this.writeFileSync = options.writeFileSync ?? fs.writeFileSync;
  }

  /**
   * Called once, right after the persistent encoder starts — see StreamController.start().
   * `aboveVideoPipe` is the encoder's second canvas pipe; it is only ever written to when this
   * feeder was configured with an `aboveOverlayImagePath`, so a single-layer session passing it
   * in changes nothing.
   */
  attach(videoPipe: NodeJS.WritableStream, aboveVideoPipe?: NodeJS.WritableStream): void {
    this.videoPipe = videoPipe;
    this.aboveVideoPipe = this.options.aboveOverlayImagePath ? aboveVideoPipe ?? null : null;
    this.startHeartbeat();
  }

  /**
   * Renders one new frame and writes it immediately. `timerText` is always a plain, already-
   * formatted string (or null for "no timer element on this template") — there's no live
   * pts-expression any more, since there's no continuous per-track encode process for one to run
   * against. The caller (StreamController) computes the right string for both the live-ticking
   * case (elapsed time, called once a second) and the frozen-on-pause case (same code path).
   */
  async render(overlay: NowPlayingOverlay, timerText: string | null): Promise<void> {
    if (this.rendering) {
      // Woken by the previous holder's `finally` handing the lock directly to us (see there) —
      // `rendering` is already true throughout, so there is no release-then-reacquire gap here
      // for a fresh, unqueued caller to slip into.
      await new Promise<void>((resolve) => this.pendingQueue.push(resolve));
    } else {
      this.rendering = true;
    }
    try {
      if (this.closed) return;

      const abovePath = this.options.aboveOverlayImagePath;
      this.writeFileSync(this.options.overlayImagePath, overlay.overlayPng);
      if (abovePath) this.writeFileSync(abovePath, overlay.overlayPngAbove ?? BLANK_OVERLAY_PNG);

      const timer: TimerOverlay | null = overlay.timer && timerText !== null
        ? { ...overlay.timer, text: timerText }
        : null;

      const frameArgs = (overlayPngPath: string, frameTimer: TimerOverlay | null) => buildCanvasFrameArgs({
        overlayPngPath,
        fontFile: this.options.fontFile,
        timer: frameTimer,
        width: this.options.width,
        height: this.options.height,
      });

      // The timer belongs on whichever layer ends up on top, so nothing composited between the two
      // layers (i.e. a gif) can cover it — it has always rendered above everything else.
      const [frame, aboveFrame] = await Promise.all([
        this.runOneShot(frameArgs(this.options.overlayImagePath, abovePath ? null : timer)),
        abovePath ? this.runOneShot(frameArgs(abovePath, timer)) : Promise.resolve(null),
      ]);
      if (this.closed) return; // torn down while this render's ffmpeg was still running
      this.cachedFrame = frame;
      this.cachedAboveFrame = aboveFrame;
      // This write IS this cycle's frame — resync the heartbeat's phase from here (kill the old
      // timer, start a fresh one) so the total write cadence stays exactly one frame per
      // heartbeatMs. Without this resync, this write would be an EXTRA frame on top of whatever
      // the heartbeat was already about to send on its own schedule, silently inflating the
      // video's frame count relative to real elapsed time — this was a real bug (found in final
      // review, not caught by task-scoped review against fakes): every render() call — every
      // track switch, pause, resume, and once-a-second timer tick — was adding a frame the
      // encoder's declared input rate didn't account for, causing the video timeline to run
      // ahead of real time.
      this.writeCachedFrame();
      this.startHeartbeat();
    } finally {
      // Hand the lock straight to the next waiter (rendering stays true) rather than releasing it
      // and letting that waiter re-acquire on its own next microtask — a fresh, never-queued
      // render() call arriving in that gap would see `rendering === false` and take the fast
      // path, running concurrently with the waiter now resuming. Only actually release when
      // nobody is waiting.
      const next = this.pendingQueue.shift();
      if (next) next();
      else this.rendering = false;
    }
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    // Wake every queued render() right away, rather than leaving them to the normal one-at-a-time
    // finally-wakes-the-next chain. Not strictly required for correctness — a return inside try
    // still runs finally, so that chain would eventually wake everyone anyway — but there's no
    // reason to make every queued caller wait through N-1 other calls' own I/O just to find out
    // they're all closed; waking them all at once costs nothing since each bails immediately.
    const queued = this.pendingQueue;
    this.pendingQueue = [];
    for (const resolve of queued) resolve();
    for (const path of [this.options.overlayImagePath, this.options.aboveOverlayImagePath]) {
      if (!path) continue;
      try {
        fs.unlinkSync(path);
      } catch {
        // Never written, or already gone — either way there's nothing left to clean up.
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.writeCachedFrame(), this.options.heartbeatMs);
    // Doesn't hold the process open on its own — in production the real HTTP server listener
    // keeps the process running regardless; this is specifically what lets a test process exit
    // cleanly when nothing else is holding it open, without needing every test to remember to
    // call stop()/close().
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private writeCachedFrame(): void {
    if (!this.cachedFrame || !this.videoPipe) return;
    const split = this.aboveVideoPipe !== null;
    if (split && !this.cachedAboveFrame) return;
    // Backpressure: if Node's own write buffer for this pipe is already backed up, skip this
    // tick rather than piling more ~1.3MB raw frames into unbounded memory — ffmpeg will just
    // hold the last frame it has a little longer, which is harmless since the content hasn't
    // changed anyway. With two layers it's both pipes or neither: each pipe's PTS is synthesized
    // from its own frame count, so writing one while skipping the other would leave the layers
    // permanently one frame further apart for the rest of the session.
    if (needsDrain(this.videoPipe)) return;
    if (split && needsDrain(this.aboveVideoPipe!)) return;
    this.videoPipe.write(this.cachedFrame);
    if (split) this.aboveVideoPipe!.write(this.cachedAboveFrame!);
  }

  // A one-shot canvas render that never closes would, since render() calls are now serialized
  // (see the class-level comment on `rendering`/`pendingQueue`), block every later render() call
  // for the rest of the session, not just its own caller as before serialization landed — a
  // stuck-forever ffmpeg process used to freeze only whatever awaited it directly. This timeout
  // is that safety valve: kill it and let the queue move on rather than freeze the whole canvas.
  private static readonly RENDER_TIMEOUT_MS = 5000;

  private runOneShot(args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = this.options.spawner('ffmpeg', args);
      const chunks: Buffer[] = [];
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`canvas frame render timed out after ${CanvasFeeder.RENDER_TIMEOUT_MS}ms`));
      }, CanvasFeeder.RENDER_TIMEOUT_MS);
      timer.unref(); // never itself keeps the process alive, matching the heartbeat timer
      child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.once('close', (code: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0 || code === null) resolve(Buffer.concat(chunks));
        else reject(new Error(`canvas frame render failed with exit code ${String(code)}`));
      });
    });
  }
}
