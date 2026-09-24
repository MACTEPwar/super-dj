import { PlaylistWindowAnimator, HANDOFF_HOLD_MS } from '../../src/stream/playlistWindowAnimator';
import { CANVAS_HEARTBEAT_MS } from '../../src/stream/streamScene';
import { WindowRow } from '../../src/playlist/window';

const row = (key: string, isCurrent = false): WindowRow => ({ key, text: key, isCurrent });
const BASE = [row('b:0', true), row('b:1'), row('b:2')];
const ONE = [row('b:0', true), row('i:0'), row('b:1'), row('b:2')];
const TWO = [row('b:0', true), row('i:0'), row('i:1'), row('b:1'), row('b:2')];

function setup() {
  const log: string[] = [];
  let baked = BASE;
  const gates: Array<() => void> = [];
  const deps = {
    feeder: {
      showRows: jest.fn(async (rows: WindowRow[]) => { log.push(`show ${rows.length}`); }),
      animate: jest.fn(async () => { log.push('animate'); }),
      goIdle: jest.fn(() => { log.push('idle'); }),
    },
    bakeCanvas: jest.fn(async (rows: WindowRow[], opts: { omitLivePlaylist: boolean }) => {
      log.push(opts.omitLivePlaylist ? 'bake A' : `bake B ${rows.length}`);
      if (!opts.omitLivePlaylist) baked = rows;
      return true;
    }),
    getBakedRows: () => baked,
    sleep: jest.fn((ms: number) => new Promise<void>((r) => { log.push(`hold ${ms}`); gates.push(r); })),
  };
  const releaseAll = async () => { for (let i = 0; i < 50; i++) { while (gates.length) gates.shift()!(); await Promise.resolve(); } };
  return { animator: new PlaylistWindowAnimator(deps), deps, log, releaseAll };
}

describe('PlaylistWindowAnimator', () => {
  it('HANDOFF_HOLD_MS is two canvas heartbeats', () => {
    expect(HANDOFF_HOLD_MS).toBe(2 * CANVAS_HEARTBEAT_MS);
  });

  it('runs the handoff in exactly this order', async () => {
    const { animator, log, releaseAll } = setup();
    animator.queueChanged(ONE);
    await releaseAll();
    expect(log).toEqual([
      'show 3', `hold ${HANDOFF_HOLD_MS}`,   // frame 0 == baked window, overlapped
      'bake A', `hold ${HANDOFF_HOLD_MS}`,   // canvas without the window
      'animate',
      'bake B 4', `hold ${HANDOFF_HOLD_MS}`, // canvas with the new rows, overlapped
      'idle',
    ]);
    expect(animator.busy).toBe(false);
  });

  it('none: nothing at all', async () => {
    const { animator, log, releaseAll } = setup();
    animator.queueChanged(BASE.map((r) => ({ ...r })));
    await releaseAll();
    expect(log).toEqual([]);
  });

  it('snap-shaped change (not an insert): a plain re-bake, no burst', async () => {
    const { animator, log, releaseAll } = setup();
    animator.queueChanged([row('b:0'), row('b:1', true), row('b:2')]);
    await releaseAll();
    expect(log).toEqual(['bake B 3']);
  });

  it('inserts during a burst coalesce into ONE follow-up burst from the newly baked rows (C3)', async () => {
    const { animator, deps, log, releaseAll } = setup();
    animator.queueChanged(ONE);
    await Promise.resolve();
    animator.queueChanged(TWO);   // arrives mid-burst
    animator.queueChanged(TWO);   // and again
    await releaseAll();
    expect(deps.feeder.animate).toHaveBeenCalledTimes(2);
    expect(log.filter((l) => l.startsWith('bake B'))).toEqual(['bake B 4', 'bake B 5']);
    expect(log[log.length - 1]).toBe('idle');
  });

  it('abort mid-burst: idle at once, no further steps, not busy (C2)', async () => {
    const { animator, deps, log, releaseAll } = setup();
    animator.queueChanged(ONE);
    await Promise.resolve(); await Promise.resolve();
    animator.abort();
    await releaseAll();
    expect(log).toContain('idle');
    expect(deps.bakeCanvas).not.toHaveBeenCalledWith(expect.anything(), { omitLivePlaylist: false });
    expect(animator.busy).toBe(false);
  });

  it('abort drops pending coalesced rows', async () => {
    const { animator, deps, releaseAll } = setup();
    animator.queueChanged(ONE);
    animator.queueChanged(TWO);
    animator.abort();
    await releaseAll();
    expect(deps.feeder.animate).toHaveBeenCalledTimes(0);
  });

  it('a feeder failure mid-burst: idle, then a plain re-bake so the window is never left missing (C9)', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { animator, deps, log, releaseAll } = setup();
    deps.feeder.animate.mockRejectedValueOnce(new Error('render pool died'));
    animator.queueChanged(ONE);
    await releaseAll();
    expect(log.slice(-2)).toEqual(['idle', 'bake B 4']);
    errorSpy.mockRestore();
  });
});
