import * as fs from 'fs';
import { Spawner } from './types';
import { buildCanvasFrameArgs, NowPlayingOverlay, TimerOverlay } from './segmentArgs';

export interface CanvasFeederOptions {
  spawner: Spawner;
  // Fixed on-disk path this feeder writes the current overlay PNG to before every render — same
  // pattern the earlier per-segment pipeline always used, just now feeding a one-shot render
  // instead of a continuous encode.
  overlayImagePath: string;
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
  private videoPipe: NodeJS.WritableStream | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: CanvasFeederOptions) {
    this.writeFileSync = options.writeFileSync ?? fs.writeFileSync;
  }

  /** Called once, right after the persistent encoder starts — see StreamController.start(). */
  attach(videoPipe: NodeJS.WritableStream): void {
    this.videoPipe = videoPipe;
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
    this.writeFileSync(this.options.overlayImagePath, overlay.overlayPng);

    const timer: TimerOverlay | null = overlay.timer && timerText !== null
      ? { ...overlay.timer, text: timerText }
      : null;

    const args = buildCanvasFrameArgs({
      overlayPngPath: this.options.overlayImagePath,
      fontFile: this.options.fontFile,
      timer,
      width: this.options.width,
      height: this.options.height,
    });

    this.cachedFrame = await this.runOneShot(args);
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
  }

  close(): void {
    this.stopHeartbeat();
    try {
      fs.unlinkSync(this.options.overlayImagePath);
    } catch {
      // Never written, or already gone — either way there's nothing left to clean up.
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
    // Backpressure: if Node's own write buffer for this pipe is already backed up, skip this
    // tick rather than piling more ~1.3MB raw frames into unbounded memory — ffmpeg will just
    // hold the last frame it has a little longer, which is harmless since the content hasn't
    // changed anyway.
    if ((this.videoPipe as unknown as { writableNeedDrain?: boolean }).writableNeedDrain) return;
    this.videoPipe.write(this.cachedFrame);
  }

  private runOneShot(args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = this.options.spawner('ffmpeg', args);
      const chunks: Buffer[] = [];
      child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.once('close', (code: unknown) => {
        if (code === 0 || code === null) resolve(Buffer.concat(chunks));
        else reject(new Error(`canvas frame render failed with exit code ${String(code)}`));
      });
    });
  }
}
