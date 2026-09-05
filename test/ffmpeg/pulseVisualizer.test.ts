import { PassThrough, Writable } from 'stream';
import { PulseVisualizer, PulseVisualizerOptions } from '../../src/ffmpeg/pulseVisualizer';

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
});
