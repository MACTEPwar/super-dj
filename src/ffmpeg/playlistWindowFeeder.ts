import { RawFramePacer } from './rawFramePacer';
import { WindowRow } from '../playlist/window';
import { animatedRowsAt, settledRows, INSERT_ANIMATION_MS, InsertTransition, AnimatedRow } from './playlistWindowTransition';
import { PlaylistWindowRegion } from '../render/playlistWindowGeometry';
import { transparentYuva420p } from '../render/yuva420p';
import { PlaylistWindowFrameRequest } from '../render/sceneRenderer';
import { PlaylistElement } from '../templates/templateTypes';
import { renderPlaylistWindowFrame } from '../render/playlistWindowRenderPool';

export class FeederCancelled extends Error {
  constructor() { super('playlist window feeder: cancelled'); }
}

export interface PlaylistWindowFeederOptions {
  element: PlaylistElement;
  region: PlaylistWindowRegion;
  fps: number;
  renderFrame?: (req: PlaylistWindowFrameRequest) => Promise<Buffer>;
  nowMs?: () => number;
}

/**
 * The pipe:7 frame player. Idle, it is the same heartbeat-of-an-unchanging-frame discipline
 * CanvasFeeder uses for pipe:3 — RawFramePacer resending one precomputed transparent frame at the
 * declared rate — so ffmpeg's overlay frame-sync never waits on this pipe. On command it shows a
 * settled frame or plays one insert animation. Holds, canvas swaps and coalescing belong to
 * PlaylistWindowAnimator; this class only turns rows into paced frames.
 */
export class PlaylistWindowFeeder {
  private readonly pacer: RawFramePacer;
  private readonly nowMs: () => number;
  private readonly idleFrame: Buffer;
  private generation = 0;
  private closed = false;
  private inFlight: Promise<unknown> = Promise.resolve();
  private rendering = false;
  private tickTimer: NodeJS.Timeout | null = null;
  private animation: { plan: InsertTransition; startedAtMs: number; generation: number; resolve: () => void; reject: (e: unknown) => void } | null = null;

  constructor(private readonly options: PlaylistWindowFeederOptions) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.pacer = new RawFramePacer({ fps: options.fps, now: () => this.nowMs() / 1000 });
    this.idleFrame = transparentYuva420p(options.region.width, options.region.height);
    this.pacer.setFrame(this.idleFrame);
  }

  attach(pipe: NodeJS.WritableStream): void {
    this.pacer.attach(pipe);
    this.tickTimer = setInterval(() => this.tick(), 1000 / this.options.fps);
    this.tickTimer.unref();
    this.pacer.writeDueFrames();
  }

  async showRows(rows: WindowRow[]): Promise<void> {
    const generation = this.generation;
    await this.renderAndShow(settledRows(rows), generation);
  }

  animate(plan: InsertTransition): Promise<void> {
    if (this.closed) return Promise.reject(new FeederCancelled());
    return new Promise<void>((resolve, reject) => {
      this.animation = { plan, startedAtMs: this.nowMs(), generation: this.generation, resolve, reject };
    });
  }

  goIdle(): void {
    this.generation += 1;
    this.animation?.reject(new FeederCancelled());
    this.animation = null;
    this.pacer.setFrame(this.idleFrame);
  }

  close(): void {
    this.goIdle();
    this.closed = true;
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    this.pacer.detach();
  }

  private tick(): void {
    try {
      this.pacer.writeDueFrames();
      const anim = this.animation;
      if (!anim || this.rendering || this.closed) return;
      const elapsed = this.nowMs() - anim.startedAtMs;
      if (elapsed >= INSERT_ANIMATION_MS) {
        this.animation = null;
        this.renderAndShow(settledRows(anim.plan.to), anim.generation).then(anim.resolve, anim.reject);
        return;
      }
      this.renderAndShow(animatedRowsAt(anim.plan, elapsed), anim.generation).catch((err) => {
        if (!(err instanceof FeederCancelled)) console.error('playlist window burst frame failed, holding the last frame', err);
      });
    } catch (err) {
      // A bare setInterval callback: an uncaught throw would kill every tenant's stream.
      console.error('playlist window tick failed', err);
    }
  }

  // One render in flight at a time. The result becomes the current frame only if nothing
  // (goIdle/close/a newer command) superseded it.
  private async renderAndShow(rows: AnimatedRow[], generation: number): Promise<void> {
    await this.inFlight.catch(() => undefined);
    if (this.closed || generation !== this.generation) throw new FeederCancelled();
    const render = this.options.renderFrame ?? renderPlaylistWindowFrame;
    this.rendering = true;
    const job = render({ element: this.options.element, region: this.options.region, rows });
    this.inFlight = job;
    try {
      const frame = await job;
      if (this.closed || generation !== this.generation) throw new FeederCancelled();
      this.pacer.setFrame(frame);
      this.pacer.writeDueFrames();
    } finally {
      this.rendering = false;
    }
  }
}
