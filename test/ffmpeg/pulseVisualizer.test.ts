import { PassThrough, Writable } from 'stream';
import { MAX_CATCH_UP_FRAMES, PCM_BYTES_PER_SECOND, PCM_RING_SECONDS, PulseVisualizer, PulseVisualizerOptions } from '../../src/ffmpeg/pulseVisualizer';

const SAMPLE_RATE = 44100;
const WINDOW_SAMPLES = 2048;

// Stereo s16le PCM whose every sample encodes its own absolute position in the stream (left =
// the stereo-frame index mod 30000, right = a marker), so a captured analysis window reveals
// exactly which slice of the stream it came from — the position, not just "something changed".
function positionEncodedPcm(fromFrame: number, frameCount: number): Buffer {
  const out = Buffer.alloc(frameCount * 4);
  for (let i = 0; i < frameCount; i++) {
    out.writeInt16LE((fromFrame + i) % 30000, i * 4);
    out.writeInt16LE(1234, i * 4 + 2);
  }
  return out;
}

// Where the window handed to the FFT should start for pulse frame #k: centered on the interval
// [k, k+1)/fps that frame is on screen for (mirrors PulseVisualizer.loadAnalysisWindow).
function expectedWindowStartFrame(frameIndex: number, fps: number): number {
  const center = ((frameIndex + 0.5) / fps) * SAMPLE_RATE;
  return Math.round(center + WINDOW_SAMPLES / 2) - WINDOW_SAMPLES;
}

// Ticks a visualizer `count` times, one frame interval apart on both the fake clock and the fake
// timers, settling each render in between — so each tick writes exactly one frame.
async function tickFrames(clock: { nowS: number }, fps: number, count: number) {
  for (let i = 0; i < count; i++) {
    clock.nowS += 1 / fps;
    jest.advanceTimersByTime(Math.ceil(1000 / fps));
    for (let j = 0; j < 3; j++) await Promise.resolve();
  }
}

function buildVisualizer(overrides: Partial<PulseVisualizerOptions> = {}) {
  const renderFrame = jest.fn().mockResolvedValue({ pixels: Buffer.from([1, 2, 3, 4]), width: 4, height: 1 });
  const visualizer = new PulseVisualizer({
    width: 400, height: 150, fps: 30,
    colors: ['#3b6fff', '#ff2f6e'], glowLayers: 5, glowRadius: 20, coreWidth: 2,
    renderFrame,
    now: () => Date.now() / 1000,
    ...overrides,
  });
  return { visualizer, renderFrame };
}

describe('PulseVisualizer', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('attach() starts ticking at the configured fps and renders an SVG each tick', async () => {
    const { visualizer, renderFrame } = buildVisualizer({ fps: 10 });
    const pipe = new PassThrough();
    visualizer.attach(pipe);

    jest.advanceTimersByTime(100);
    await Promise.resolve(); await Promise.resolve();

    expect(renderFrame).toHaveBeenCalledTimes(1);
    expect(renderFrame.mock.calls[0][0]).toContain('<svg');
  });

  it('writes the rendered (and unpremultiplied) pixel buffer to the attached pipe', async () => {
    const { visualizer } = buildVisualizer({
      fps: 10,
      renderFrame: jest.fn().mockResolvedValue({ pixels: Buffer.from([128, 0, 0, 128]), width: 1, height: 1 }),
    });
    const chunks: Buffer[] = [];
    const pipe = new Writable({ write: (chunk, _e, cb) => { chunks.push(chunk); cb(); } });
    visualizer.attach(pipe);

    jest.advanceTimersByTime(100);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(chunks).toHaveLength(1);
    // (128,0,0,128) premultiplied -> (255,0,0,128) once unpremultiplied — see unpremultiply.test.ts.
    expect([...chunks[0]]).toEqual([255, 0, 0, 128]);
  });

  it('resends the last frame instead of overlapping a second render when one is still pending', async () => {
    let resolveRender!: (v: { pixels: Buffer; width: number; height: number }) => void;
    const renderFrame = jest.fn().mockReturnValue(new Promise((resolve) => { resolveRender = resolve; }));
    const { visualizer } = buildVisualizer({ fps: 10, renderFrame });
    const chunks: Buffer[] = [];
    const pipe = new Writable({ write: (chunk, _e, cb) => { chunks.push(chunk); cb(); } });
    visualizer.attach(pipe);

    jest.advanceTimersByTime(100); // first tick starts a render that never resolves yet
    await Promise.resolve();
    expect(renderFrame).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(100); // second tick — must not start a second overlapping render
    await Promise.resolve();
    expect(renderFrame).toHaveBeenCalledTimes(1);

    resolveRender({ pixels: Buffer.from([10, 20, 30, 255]), width: 1, height: 1 });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  // Settles the renderFrame promise chain (.then -> .catch -> .finally) after a tick.
  const settle = async () => { for (let i = 0; i < 3; i++) await Promise.resolve(); };

  // Why the frame COUNT matters, not just "a frame per tick": pipe:5 is declared to ffmpeg at a
  // fixed -r fps with no timestamps, so its timeline is synthesized purely from how many frames
  // arrived, and ffmpeg's overlay filter can't emit an output frame until this pipe has a newer
  // one. Every frame this class fails to write stalls the whole stream by one frame interval,
  // permanently — measured against a real ffmpeg binary: with a late-firing 30fps timer the
  // encoder's output ran at 0.7x real time on an idle CPU, which a viewer sees as the picture's
  // only moving element (this one) periodically freezing.
  it('catches up the frame count after a late tick instead of silently losing the missed frames', async () => {
    let nowS = 0;
    const renderFrame = jest.fn().mockResolvedValue({ pixels: Buffer.from([1, 2, 3, 255]), width: 1, height: 1 });
    const { visualizer } = buildVisualizer({ fps: 10, renderFrame, now: () => nowS });
    const chunks: Buffer[] = [];
    const pipe = new Writable({ write: (chunk, _e, cb) => { chunks.push(chunk); cb(); } });
    visualizer.attach(pipe);

    nowS = 0.1; jest.advanceTimersByTime(100);
    await settle();
    expect(chunks).toHaveLength(1);

    // The next interval fires 300ms late by wall-clock (a busy event loop). Node's setInterval
    // never fires catch-up ticks for missed intervals, so this one tick must account for all four
    // frames now owed — by resending the latest frame, a hold no viewer can see.
    nowS = 0.5; jest.advanceTimersByTime(100);
    await settle();
    expect(chunks).toHaveLength(5);
  });

  it("resumes a write skipped under backpressure on the pipe's drain event, with the newest frame, instead of losing it", async () => {
    let nowS = 0;
    const renderFrame = jest.fn()
      .mockResolvedValueOnce({ pixels: Buffer.from([1, 1, 1, 255]), width: 1, height: 1 })
      .mockResolvedValueOnce({ pixels: Buffer.from([2, 2, 2, 255]), width: 1, height: 1 });
    const { visualizer } = buildVisualizer({ fps: 10, renderFrame, now: () => nowS });
    const chunks: Buffer[] = [];
    const pipe = new Writable({ write: (chunk, _e, cb) => { chunks.push(chunk); cb(); } });
    let needDrain = false;
    Object.defineProperty(pipe, 'writableNeedDrain', { get: () => needDrain });
    visualizer.attach(pipe);

    nowS = 0.1; jest.advanceTimersByTime(100);
    await settle();
    expect(chunks).toHaveLength(1);

    // Backed-up pipe: this tick's write must be skipped (never piled onto Node's buffer)...
    needDrain = true;
    nowS = 0.2; jest.advanceTimersByTime(100);
    await settle();
    expect(chunks).toHaveLength(1);

    // ...but the frame it owed is written as soon as the pipe drains — and it's the newest render,
    // not the stale one that was skipped: the point is keeping the count right, not replaying history.
    needDrain = false;
    pipe.emit('drain');
    expect(chunks).toHaveLength(2);
    expect([...chunks[1]]).toEqual([2, 2, 2, 255]);
  });

  // Found against a real ffmpeg binary, not by reasoning: ffmpeg consumes this pipe in bursts (its
  // fps= stage releases a canvas frame's copies only when the NEXT canvas frame lands), so a
  // backed-up pipe means ffmpeg is waiting on the canvas, not on us. Replaying every frame that
  // came due during such a wait as duplicates produced a 4-frame hold followed by a 4-frame jump
  // on every single heartbeat — a brand-new visible stutter in place of the one being fixed.
  it('forgives the frames that came due while the pipe was backed up — drain writes one, not a burst of duplicates', async () => {
    let nowS = 0;
    const { visualizer } = buildVisualizer({ fps: 10, now: () => nowS });
    const chunks: Buffer[] = [];
    const pipe = new Writable({ write: (chunk, _e, cb) => { chunks.push(chunk); cb(); } });
    let needDrain = false;
    Object.defineProperty(pipe, 'writableNeedDrain', { get: () => needDrain });
    visualizer.attach(pipe);

    nowS = 0.1; jest.advanceTimersByTime(100);
    await settle();
    expect(chunks).toHaveLength(1);

    needDrain = true;
    for (const t of [0.2, 0.3, 0.4]) { nowS = t; jest.advanceTimersByTime(100); await settle(); }
    expect(chunks).toHaveLength(1);

    needDrain = false;
    pipe.emit('drain');
    expect(chunks).toHaveLength(2);
  });

  it('caps catch-up after a long stall, never replaying an unbounded backlog', async () => {
    let nowS = 0;
    const { visualizer } = buildVisualizer({ fps: 10, now: () => nowS });
    const chunks: Buffer[] = [];
    const pipe = new Writable({ write: (chunk, _e, cb) => { chunks.push(chunk); cb(); } });
    visualizer.attach(pipe);

    nowS = 0.1; jest.advanceTimersByTime(100);
    await settle();
    expect(chunks).toHaveLength(1);

    // A 5s stall (process suspended, encoder wedged) owes 50 frames. The canvas heartbeat lost
    // that time too and has no catch-up of its own, so replaying all 50 would only push this pipe
    // five seconds ahead of the canvas and pin it against backpressure. MAX_CATCH_UP_FRAMES is
    // the most a resumed session replays; the rest is forgiven.
    nowS = 5.1; jest.advanceTimersByTime(100);
    await settle();
    expect(chunks).toHaveLength(1 + MAX_CATCH_UP_FRAMES);
  });

  it('close() stops ticking — no further renders after close', async () => {
    const { visualizer, renderFrame } = buildVisualizer({ fps: 10 });
    visualizer.attach(new PassThrough());
    jest.advanceTimersByTime(100);
    await Promise.resolve();
    visualizer.close();
    renderFrame.mockClear();

    jest.advanceTimersByTime(500);
    await Promise.resolve();

    expect(renderFrame).not.toHaveBeenCalled();
  });

  it('exposes audioSink as a writable stream that accepts PCM bytes without throwing', () => {
    const { visualizer } = buildVisualizer();
    const sink = visualizer.audioSink;
    expect(() => sink.write(Buffer.alloc(2048 * 2 * 2))).not.toThrow();
  });

  // Real templates saved before colors[]/glowLayers/glowRadius/coreWidth existed still carry the
  // old {color: string} shape in the database — normalizeEqualizerElement (templateTypes.ts) is
  // the actual fix, but this is defense in depth against ANY future way `tick()` could throw:
  // a bare setInterval callback has nothing to catch a synchronous throw, which would otherwise
  // kill the whole process (every tenant's active stream), not just log an error.
  it('does not let a synchronous render-input error (e.g. missing colors) escape the tick and crash the process', async () => {
    const { visualizer } = buildVisualizer({
      fps: 10,
      // Simulates exactly what an unnormalized legacy equalizer element produces at runtime,
      // despite the type saying `colors: string[]`.
      colors: undefined as unknown as string[],
    });
    const pipe = new PassThrough();
    visualizer.attach(pipe);

    expect(() => jest.advanceTimersByTime(100)).not.toThrow();
    await expect(Promise.resolve()).resolves.toBeUndefined();
  });

  it('audioSink does not throw on a chunk whose accumulated length lands on an odd byte offset', () => {
    const { visualizer } = buildVisualizer();
    const sink = visualizer.audioSink;
    // Fills the window, then feeds a single odd-length byte on top — the exact shape that used to
    // throw a RangeError constructing an Int16Array at an odd byteOffset (Node requires an even
    // one), crashing the whole process since a Writable's `_write` throw becomes an unlistened
    // 'error' event.
    expect(() => {
      sink.write(Buffer.alloc(2048 * 2 * 2));
      sink.write(Buffer.alloc(1));
      sink.write(Buffer.alloc(2048 * 2 * 2));
    }).not.toThrow();
  });

  // The audio the viewer hears alongside pulse frame #k is the audio at k/fps seconds of the
  // encoder's audio pipe — a fixed POSITION in the tapped byte stream (both pipes are declared
  // to ffmpeg without timestamps, so frame count and byte offset ARE their timelines). The tap
  // itself runs well ahead of that position (`-re` paces ffmpeg's reads, not the decoder's
  // writes), by an amount measured at 0.3-5s and varying within one session — so analyzing the
  // newest audio put the picture ~0.9s AHEAD of the sound (measured against a real encoder).
  describe('analysis window position', () => {
    function buildCapturing(fps: number, clock: { nowS: number }) {
      const windows: Int16Array[] = [];
      const analyzeSpectrum = jest.fn((pcm: Int16Array, bandCount: number) => {
        windows.push(Int16Array.from(pcm));
        return new Array(bandCount).fill(0);
      });
      const { visualizer } = buildVisualizer({ fps, now: () => clock.nowS, analyzeSpectrum });
      const pipe = new Writable({ write: (_c, _e, cb) => cb() });
      visualizer.attach(pipe);
      return { visualizer, windows };
    }

    it('analyzes the audio that will play alongside the frame being written, not the newest audio received', async () => {
      const fps = 10;
      const clock = { nowS: 0 };
      const { visualizer, windows } = buildCapturing(fps, clock);
      // Three whole seconds of audio arrive at once, up front — as they really do (the tap saw
      // ~5s in the first 60ms of a real session) — so "newest" is far ahead of every frame here.
      visualizer.audioSink.write(positionEncodedPcm(0, 3 * SAMPLE_RATE));

      await tickFrames(clock, fps, 15);

      expect(windows).toHaveLength(15);
      windows.forEach((window, tick) => {
        // Tick N renders pulse frame #N (N frames were written before it).
        const start = expectedWindowStartFrame(tick, fps);
        expect(window[0]).toBe(start % 30000);
        expect(window[1]).toBe(1234);
        expect(window[(WINDOW_SAMPLES - 1) * 2]).toBe((start + WINDOW_SAMPLES - 1) % 30000);
      });
      // Frame #14 is on screen at 1.4-1.5s: nowhere near the 3s of audio that had arrived.
      expect(expectedWindowStartFrame(14, fps)).toBeLessThan(1.6 * SAMPLE_RATE);
    });

    it('advances the window by exactly one frame interval per tick, regardless of how the audio was chunked', async () => {
      const fps = 30;
      const clock = { nowS: 0 };
      const { visualizer, windows } = buildCapturing(fps, clock);
      // The same 2s of audio, once as a single burst and once in awkward 777-byte pieces (not
      // stereo-frame aligned), must produce identical windows: chunk boundaries mean nothing.
      const pcm = positionEncodedPcm(0, 2 * SAMPLE_RATE);
      for (let at = 0; at < pcm.length; at += 777) visualizer.audioSink.write(pcm.subarray(at, Math.min(pcm.length, at + 777)));

      await tickFrames(clock, fps, 20);

      expect(windows).toHaveLength(20);
      // From tick 2 on: frame #0's window starts before the stream does (it's centered on the
      // first 33ms), so its leading samples are the ring's pre-stream silence, not positions.
      for (let tick = 2; tick < windows.length; tick++) {
        const hop = windows[tick][0] - windows[tick - 1][0];
        expect(hop).toBe(expectedWindowStartFrame(tick, fps) - expectedWindowStartFrame(tick - 1, fps));
        expect(hop).toBeGreaterThan(0); // never the same window twice
      }
      visualizer.close();
      const burstClock = { nowS: 0 };
      const singleBurst = buildCapturing(fps, burstClock);
      singleBurst.visualizer.audioSink.write(pcm);
      await tickFrames(burstClock, fps, 20);
      expect(singleBurst.windows.map((w) => w[0])).toEqual(windows.map((w) => w[0]));
    });

    it('falls back to the newest audio when the audio for this frame has not arrived yet', async () => {
      const fps = 10;
      const clock = { nowS: 0 };
      const { visualizer, windows } = buildCapturing(fps, clock);
      // Only 0.5s has arrived; frame #9 (0.9-1.0s) is beyond it.
      const available = Math.round(0.5 * SAMPLE_RATE);
      visualizer.audioSink.write(positionEncodedPcm(0, available));

      await tickFrames(clock, fps, 10);

      const last = windows[9];
      expect(last[(WINDOW_SAMPLES - 1) * 2]).toBe((available - 1) % 30000); // ends at the newest frame
      expect(last[0]).toBe((available - WINDOW_SAMPLES) % 30000);
    });

    it('reads silence, not garbage, before any audio has arrived', async () => {
      const fps = 10;
      const clock = { nowS: 0 };
      const { windows } = buildCapturing(fps, clock);
      await tickFrames(clock, fps, 2);
      expect(windows).toHaveLength(2);
      expect(windows.every((w) => w.every((s) => s === 0))).toBe(true);
    });

    it('keeps enough history for the tap to run several seconds ahead of playback', () => {
      // Measured against a real encoder: up to ~5s ahead right after start on Windows.
      expect(PCM_RING_SECONDS).toBeGreaterThanOrEqual(8);
      expect(PCM_BYTES_PER_SECOND).toBe(44100 * 4);
    });
  });
});
