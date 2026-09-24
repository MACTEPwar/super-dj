import { planWindowTransition, InsertTransition } from '../ffmpeg/playlistWindowTransition';
import { FeederCancelled } from '../ffmpeg/playlistWindowFeeder';
import { WindowRow } from '../playlist/window';

// = 2 x CANVAS_HEARTBEAT_MS (streamScene.ts) — asserted by a test, keep in sync.
export const HANDOFF_HOLD_MS = 400;

export interface PlaylistWindowAnimatorDeps {
  feeder: { showRows(rows: WindowRow[]): Promise<void>; animate(plan: InsertTransition): Promise<void>; goIdle(): void };
  bakeCanvas(rows: WindowRow[], opts: { omitLivePlaylist: boolean }): Promise<boolean>;
  getBakedRows(): WindowRow[];
  sleep(ms: number): Promise<void>;
  holdMs?: number;
}

class Stale extends Error {}

/**
 * Runs one playlist-window burst at a time, handing the window between the baked canvas (pipe:3,
 * 5fps heartbeat, one-shot render latency) and the burst layer (pipe:7, 30fps). The two inputs are
 * never frame-synchronized, so the protocol never relies on it: every switch overlaps IDENTICAL
 * content for a hold, so whichever input ffmpeg picks up first, the picture is the same.
 *   frame 0 (== baked window) → hold → canvas A (window omitted) → hold → animate
 *   → canvas B (window with new rows) → hold → idle
 * Queue changes during a burst coalesce into one follow-up. abort() (a track change, a resume,
 * teardown) makes every pending step bail and the layer go transparent at once.
 */
export class PlaylistWindowAnimator {
  private generation = 0;
  private running = false;
  private pendingRows: WindowRow[] | null = null;
  private readonly holdMs: number;

  constructor(private readonly deps: PlaylistWindowAnimatorDeps) {
    this.holdMs = deps.holdMs ?? HANDOFF_HOLD_MS;
  }

  get busy(): boolean {
    return this.running;
  }

  queueChanged(nextRows: WindowRow[]): void {
    if (this.running) {
      this.pendingRows = nextRows;
      return;
    }
    void this.run(nextRows);
  }

  abort(): void {
    this.generation += 1;
    this.running = false;
    this.pendingRows = null;
    this.deps.feeder.goIdle();
  }

  private async run(to: WindowRow[]): Promise<void> {
    const generation = ++this.generation;
    const check = () => { if (generation !== this.generation) throw new Stale(); };
    const step = async <T>(p: Promise<T>): Promise<T> => { const v = await p; check(); return v; };
    this.running = true;
    const from = this.deps.getBakedRows();
    try {
      const plan = planWindowTransition(from, to);
      if (plan.kind === 'none') return;
      if (plan.kind === 'snap') {
        await step(this.deps.bakeCanvas(to, { omitLivePlaylist: false }));
        return;
      }
      await step(this.deps.feeder.showRows(from));
      await step(this.deps.sleep(this.holdMs));
      await step(this.deps.bakeCanvas(from, { omitLivePlaylist: true }));
      await step(this.deps.sleep(this.holdMs));
      await step(this.deps.feeder.animate(plan));
      await step(this.deps.bakeCanvas(to, { omitLivePlaylist: false }));
      await step(this.deps.sleep(this.holdMs));
      this.deps.feeder.goIdle();
    } catch (err) {
      if (err instanceof Stale || err instanceof FeederCancelled) return;
      // Never leave the window missing: fall back to the plain bake.
      console.error('playlist window burst failed, falling back to a plain re-bake', err);
      this.deps.feeder.goIdle();
      if (generation === this.generation) await this.deps.bakeCanvas(to, { omitLivePlaylist: false }).catch(() => undefined);
    } finally {
      if (generation === this.generation) {
        this.running = false;
        const pending = this.pendingRows;
        this.pendingRows = null;
        if (pending) this.queueChanged(pending);
      }
    }
  }
}
