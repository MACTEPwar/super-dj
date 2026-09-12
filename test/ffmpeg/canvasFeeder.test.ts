import { PassThrough, Writable } from 'stream';
import { CanvasFeeder } from '../../src/ffmpeg/canvasFeeder';
import { Spawner, ChildProcessLike } from '../../src/ffmpeg/types';
import { NowPlayingOverlay } from '../../src/ffmpeg/segmentArgs';

type FakeChild = ChildProcessLike & { stdout: PassThrough; emitClose: (code: number | null) => void };

// Exposes an explicit emitClose() the test calls itself, synchronously, instead of scheduling
// the fake completion via process.nextTick/setTimeout — this keeps the test correct whether or
// not jest.useFakeTimers() is active (some fake-timer configurations also intercept
// process.nextTick, which silently hangs a test relying on it to eventually fire on its own).
function fakeChild(outputChunks: string[] = ['fake-frame-bytes']): FakeChild {
  const stdout = new PassThrough();
  let closeListener: ((code: number | null) => void) | null = null;
  return {
    pid: 1,
    stdout,
    stderr: null,
    kill: jest.fn(),
    once: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'close') closeListener = listener as (code: number | null) => void;
    }),
    emitClose: (code = 0) => {
      for (const chunk of outputChunks) stdout.write(chunk);
      stdout.end();
      closeListener?.(code);
    },
  };
}

const overlay: NowPlayingOverlay = { durationSeconds: 65, overlayPng: Buffer.from('fake-png-bytes'), timer: null };
const overlayWithTimer: NowPlayingOverlay = {
  durationSeconds: 65,
  overlayPng: Buffer.from('fake-png-bytes'),
  timer: { x: 10, y: 660, fontSize: 20, color: '#ffffff', style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } },
};

function buildFeeder(overrides: Partial<{ spawner: Spawner; writeFileSync: jest.Mock; heartbeatMs: number }> = {}) {
  const writeFileSync = overrides.writeFileSync ?? jest.fn();
  const feeder = new CanvasFeeder({
    spawner: overrides.spawner ?? (jest.fn().mockReturnValue(fakeChild()) as Spawner),
    overlayImagePath: '/tmp/overlay-dest-1.png',
    fontFile: '/fonts/DejaVuSans-Bold.ttf',
    width: 1280,
    height: 720,
    heartbeatMs: overrides.heartbeatMs ?? 200,
    writeFileSync,
  });
  return { feeder, writeFileSync };
}

// render()'s synchronous portion (spawn + attach listeners) runs to completion before it hits
// its first real await, so the fake child is ready to have its close event emitted immediately
// after calling render() and before awaiting the promise it returned.
async function renderAndClose(feeder: CanvasFeeder, child: FakeChild, overlay: NowPlayingOverlay, timerText: string | null): Promise<void> {
  const promise = feeder.render(overlay, timerText);
  child.emitClose(0);
  await promise;
}

describe('CanvasFeeder', () => {
  it('render() writes the overlay PNG to the fixed path, spawns a one-shot canvas-frame render, and writes the resulting bytes to the attached video pipe', async () => {
    const child = fakeChild(['frame-one']);
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const { feeder, writeFileSync } = buildFeeder({ spawner });
    const chunks: Buffer[] = [];
    const videoPipe = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
    feeder.attach(videoPipe);

    await renderAndClose(feeder, child, overlay, null);

    expect(writeFileSync).toHaveBeenCalledWith('/tmp/overlay-dest-1.png', overlay.overlayPng);
    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-i', '/tmp/overlay-dest-1.png']));
    expect(Buffer.concat(chunks).toString()).toBe('frame-one');
  });

  it('render() with a timer element passes the given plain text through as a static drawtext, not a live pts expression', async () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const { feeder } = buildFeeder({ spawner });
    feeder.attach(new PassThrough());

    await renderAndClose(feeder, child, overlayWithTimer, '0:37 / 1:05');

    const args = (spawner as jest.Mock).mock.calls[0][1] as string[];
    const filterComplex = args[args.indexOf('-filter_complex') + 1];
    expect(filterComplex).toContain("text='0\\:37 / 1\\:05'");
    expect(filterComplex).not.toContain('%{pts');
  });

  it('render() with a timer element but null timerText omits the drawtext (used when the caller has no live/frozen text yet)', async () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const { feeder } = buildFeeder({ spawner });
    feeder.attach(new PassThrough());

    await renderAndClose(feeder, child, overlayWithTimer, null);

    const args = (spawner as jest.Mock).mock.calls[0][1] as string[];
    const filterComplex = args[args.indexOf('-filter_complex') + 1];
    expect(filterComplex).not.toContain('drawtext');
  });

  it('attach() starts a heartbeat that resends the last rendered frame at the configured interval', async () => {
    jest.useFakeTimers();
    try {
      const child = fakeChild(['frame-a']);
      const spawner: Spawner = jest.fn().mockReturnValue(child);
      const { feeder } = buildFeeder({ spawner, heartbeatMs: 200 });
      const chunks: Buffer[] = [];
      const videoPipe = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
      feeder.attach(videoPipe);

      await renderAndClose(feeder, child, overlay, null);
      chunks.length = 0; // clear the initial render's own write, isolate the heartbeat's writes

      jest.advanceTimersByTime(600); // 3 heartbeat ticks at 200ms

      expect(chunks.length).toBe(3);
      expect(chunks.every((c) => c.toString() === 'frame-a')).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('the heartbeat writes nothing before the first render() call resolves', () => {
    jest.useFakeTimers();
    try {
      const { feeder } = buildFeeder();
      const chunks: Buffer[] = [];
      const videoPipe = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
      feeder.attach(videoPipe);

      jest.advanceTimersByTime(1000);

      expect(chunks.length).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('close() stops the heartbeat and removes the overlay image file', () => {
    const unlinkSync = jest.spyOn(require('fs'), 'unlinkSync').mockImplementation(() => {});
    const { feeder } = buildFeeder();
    feeder.attach(new PassThrough());

    feeder.close();

    expect(unlinkSync).toHaveBeenCalledWith('/tmp/overlay-dest-1.png');
    unlinkSync.mockRestore();
  });

  it('render() does not add an extra frame on top of the heartbeat — the total write cadence stays exactly one frame per heartbeatMs even across a render() call', async () => {
    jest.useFakeTimers();
    try {
      const child = fakeChild(['frame-a']);
      const spawner = jest.fn().mockReturnValue(child);
      const { feeder } = buildFeeder({ spawner, heartbeatMs: 200 });
      const chunks: Buffer[] = [];
      const videoPipe = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
      feeder.attach(videoPipe);

      // Let time pass PARTWAY through a heartbeat period before the render lands (130ms into
      // the first 200ms period) — a render landing at the exact same instant as attach() can't
      // distinguish "reset the phase" from "leave the original schedule alone", since both
      // produce the same future firing times. No cached frame exists yet, so no write happens
      // on this leg.
      jest.advanceTimersByTime(130);
      expect(chunks.length).toBe(0);

      await renderAndClose(feeder, child, overlay, null); // write #1, at t=130; cadence resyncs from here
      chunks.length = 0; // isolate what follows from this render's own write

      // 900ms is deliberately NOT a multiple of heartbeatMs (200ms) — this is what makes the
      // window sensitive to the phase shift. Resynced from t=130: ticks at 330/530/730/930 fall
      // inside (130, 1030] — 4 of them. Unpatched (original schedule from attach() never reset):
      // ticks at 200/400/600/800/1000 — 5 of them. If this test still passed against the
      // pre-fix code, that would mean the resync isn't actually happening.
      jest.advanceTimersByTime(900);

      expect(chunks.length).toBe(4);
    } finally {
      jest.useRealTimers();
    }
  });

  // A template whose elements straddle its first animated-gif element needs the baked canvas in
  // TWO layers, one composited under the gifs and one over them (see CanvasPlacement in
  // persistentEncoderArgs.ts). Both are fed by this one feeder rather than a second instance,
  // specifically so they share one heartbeat: two independent heartbeats would each drive their
  // own pipe's frame count, and ffmpeg synthesizes each pipe's PTS from that count alone, so any
  // write one made and the other skipped would slide the two layers permanently out of register.
  describe('the second ("above") canvas layer', () => {
    const splitOverlay: NowPlayingOverlay = {
      ...overlay,
      overlayPngAbove: Buffer.from('fake-above-png-bytes'),
    };

    function buildSplitFeeder(spawner: Spawner, heartbeatMs = 200) {
      const writeFileSync = jest.fn();
      const feeder = new CanvasFeeder({
        spawner,
        overlayImagePath: '/tmp/overlay-dest-1.png',
        aboveOverlayImagePath: '/tmp/overlay-dest-1-above.png',
        fontFile: '/fonts/DejaVuSans-Bold.ttf',
        width: 1280,
        height: 720,
        heartbeatMs,
        writeFileSync,
      });
      const belowChunks: Buffer[] = [];
      const aboveChunks: Buffer[] = [];
      const videoPipe = new Writable({ write(chunk, _enc, cb) { belowChunks.push(chunk); cb(); } });
      const abovePipe = new Writable({ write(chunk, _enc, cb) { aboveChunks.push(chunk); cb(); } });
      return { feeder, writeFileSync, videoPipe, abovePipe, belowChunks, aboveChunks };
    }

    it('renders both layers and writes each to its own pipe', async () => {
      const below = fakeChild(['below-frame']);
      const above = fakeChild(['above-frame']);
      const spawner: Spawner = jest.fn().mockReturnValueOnce(below).mockReturnValueOnce(above);
      const { feeder, writeFileSync, videoPipe, abovePipe, belowChunks, aboveChunks } = buildSplitFeeder(spawner);
      feeder.attach(videoPipe, abovePipe);

      const promise = feeder.render(splitOverlay, null);
      below.emitClose(0);
      above.emitClose(0);
      await promise;

      expect(writeFileSync).toHaveBeenCalledWith('/tmp/overlay-dest-1.png', splitOverlay.overlayPng);
      expect(writeFileSync).toHaveBeenCalledWith('/tmp/overlay-dest-1-above.png', splitOverlay.overlayPngAbove);
      expect(Buffer.concat(belowChunks).toString()).toBe('below-frame');
      expect(Buffer.concat(aboveChunks).toString()).toBe('above-frame');
    });

    it('puts the timer drawtext on the above layer only, so a gif can never cover the ticking timer', async () => {
      const below = fakeChild();
      const above = fakeChild();
      const spawner: Spawner = jest.fn().mockReturnValueOnce(below).mockReturnValueOnce(above);
      const { feeder, videoPipe, abovePipe } = buildSplitFeeder(spawner);
      feeder.attach(videoPipe, abovePipe);

      const promise = feeder.render({ ...overlayWithTimer, overlayPngAbove: Buffer.from('above') }, '0:37 / 1:05');
      below.emitClose(0);
      above.emitClose(0);
      await promise;

      const calls = (spawner as jest.Mock).mock.calls;
      const filterOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1];
      expect(filterOf(calls[0][1] as string[])).not.toContain('drawtext');
      expect(filterOf(calls[1][1] as string[])).toContain("text='0\\:37 / 1\\:05'");
    });

    it('feeds both pipes on the same heartbeat tick, one frame each, so the two layers can never drift apart', async () => {
      jest.useFakeTimers();
      try {
        const below = fakeChild(['below-frame']);
        const above = fakeChild(['above-frame']);
        const spawner: Spawner = jest.fn().mockReturnValueOnce(below).mockReturnValueOnce(above);
        const { feeder, videoPipe, abovePipe, belowChunks, aboveChunks } = buildSplitFeeder(spawner);
        feeder.attach(videoPipe, abovePipe);

        const promise = feeder.render(splitOverlay, null);
        below.emitClose(0);
        above.emitClose(0);
        await promise;
        belowChunks.length = 0;
        aboveChunks.length = 0;

        jest.advanceTimersByTime(600); // 3 heartbeat ticks at 200ms

        expect(belowChunks.length).toBe(3);
        expect(aboveChunks.length).toBe(3);
        expect(belowChunks.every((c) => c.toString() === 'below-frame')).toBe(true);
        expect(aboveChunks.every((c) => c.toString() === 'above-frame')).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it('skips BOTH pipes when either one reports backpressure, rather than letting one run ahead', async () => {
      jest.useFakeTimers();
      try {
        const below = fakeChild(['below-frame']);
        const above = fakeChild(['above-frame']);
        const spawner: Spawner = jest.fn().mockReturnValueOnce(below).mockReturnValueOnce(above);
        const { feeder, videoPipe, abovePipe, belowChunks, aboveChunks } = buildSplitFeeder(spawner);
        Object.defineProperty(abovePipe, 'writableNeedDrain', { get: () => true });
        feeder.attach(videoPipe, abovePipe);

        const promise = feeder.render(splitOverlay, null);
        below.emitClose(0);
        above.emitClose(0);
        await promise;
        belowChunks.length = 0;
        aboveChunks.length = 0;

        jest.advanceTimersByTime(600);

        expect(belowChunks.length).toBe(0);
        expect(aboveChunks.length).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('close() removes both overlay image files', () => {
      const unlinkSync = jest.spyOn(require('fs'), 'unlinkSync').mockImplementation(() => {});
      const { feeder, videoPipe, abovePipe } = buildSplitFeeder(jest.fn().mockReturnValue(fakeChild()) as Spawner);
      feeder.attach(videoPipe, abovePipe);

      feeder.close();

      expect(unlinkSync).toHaveBeenCalledWith('/tmp/overlay-dest-1.png');
      expect(unlinkSync).toHaveBeenCalledWith('/tmp/overlay-dest-1-above.png');
      unlinkSync.mockRestore();
    });

    it('is a no-op for a feeder with no above layer configured, even when a second pipe is attached', async () => {
      const child = fakeChild(['frame-one']);
      const spawner: Spawner = jest.fn().mockReturnValue(child);
      const { feeder } = buildFeeder({ spawner });
      const aboveChunks: Buffer[] = [];
      const abovePipe = new Writable({ write(chunk, _enc, cb) { aboveChunks.push(chunk); cb(); } });
      feeder.attach(new PassThrough(), abovePipe);

      await renderAndClose(feeder, child, splitOverlay, null);

      expect(spawner).toHaveBeenCalledTimes(1);
      expect(aboveChunks.length).toBe(0);
    });
  });

  it('skips a heartbeat write when the video pipe reports backpressure, instead of buffering unboundedly', async () => {
    jest.useFakeTimers();
    try {
      const child = fakeChild(['frame-a']);
      const spawner = jest.fn().mockReturnValue(child);
      const { feeder } = buildFeeder({ spawner, heartbeatMs: 200 });
      const chunks: Buffer[] = [];
      const videoPipe = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
      Object.defineProperty(videoPipe, 'writableNeedDrain', { get: () => true });
      feeder.attach(videoPipe);

      await renderAndClose(feeder, child, overlay, null);
      chunks.length = 0;

      jest.advanceTimersByTime(600);

      expect(chunks.length).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
