import * as fs from 'fs';
import { Spawner } from './types';
import { buildCanvasFrameArgs, NowPlayingOverlay, TimerOverlay } from './segmentArgs';

export interface CanvasFeederOptions {
  spawner: Spawner;
  backgroundPath: string;
  // Fixed on-disk path this feeder writes the current overlay PNG to before every render — same
  // pattern SegmentFeeder always used, just now feeding a one-shot render instead of a continuous
  // encode.
  overlayImagePath: string;
  fontFile: string;
  width: number;
  height: number;
  // How often the last-rendered frame is resent to the video pipe, regardless of whether content
  // changed — this fixed cadence is what keeps the persistent encoder's declared input framerate
  // (see persistentEncoderArgs.ts's heartbeatFps) matching real wall-clock time. Re-rendering
  // (spawning a new one-shot ffmpeg) only happens on an actual call to render(); the heartbeat
  // itself never re-renders, only resends the existing buffer.
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
    this.heartbeatTimer = setInterval(() => {
      if (this.cachedFrame) this.videoPipe!.write(this.cachedFrame);
    }, this.options.heartbeatMs);
    // Don't let this timer alone keep the process alive. In production the real HTTP server
    // listener keeps the process running regardless, so this has no effect there -- it's
    // specifically what lets a test process exit cleanly once its other handles are closed,
    // without every single test needing to remember to call manager.stop()/canvasFeeder.close().
    this.heartbeatTimer.unref();
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
      backgroundPath: this.options.backgroundPath,
      overlayPngPath: this.options.overlayImagePath,
      fontFile: this.options.fontFile,
      timer,
      width: this.options.width,
      height: this.options.height,
    });

    this.cachedFrame = await this.runOneShot(args);
    this.videoPipe?.write(this.cachedFrame);
  }

  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    try {
      fs.unlinkSync(this.options.overlayImagePath);
    } catch {
      // Never written, or already gone — either way there's nothing left to clean up.
    }
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
