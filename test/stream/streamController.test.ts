import { StreamController } from '../../src/stream/streamController';
import { ApiError } from '../../src/errors';
import { Track } from '../../src/playlist/types';

const track = (name: string): Track => ({ name, audioPath: `/music/${name}.mp3`, coverPath: null });
const overlayFor = (t: Track) => ({ title: t.name, playlistLines: [`▶ ${t.name}`], durationSeconds: 100 });

type FakeChild = {
  pid: number;
  stdout: null;
  stderr: null;
  kill: jest.Mock;
  once: jest.Mock;
  emitExit: (code?: number | null) => void;
};

function fakeChild(): FakeChild {
  let exitListener: ((code: number | null) => void) | null = null;
  return {
    pid: 1,
    stdout: null,
    stderr: null,
    kill: jest.fn(),
    once: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'exit') exitListener = listener as (code: number | null) => void;
    }),
    emitExit: (code = 0) => exitListener && exitListener(code),
  };
}

function buildDeps() {
  const tracks = [track('a'), track('b')];
  const library = {
    list: jest.fn().mockReturnValue(tracks),
    findByName: jest.fn((name: string) => tracks.find((t) => t.name === name)),
  };
  const queue = {
    current: jest.fn().mockReturnValue(tracks[0]),
    next: jest.fn().mockReturnValue(tracks[1]),
    previous: jest.fn().mockReturnValue(tracks[0]),
    insertNext: jest.fn(),
    peekNext: jest.fn().mockReturnValue(tracks[1]),
  };
  const children: FakeChild[] = [];
  const feeder = {
    feedTrack: jest.fn(() => {
      const child = fakeChild();
      children.push(child);
      return child;
    }),
    feedPause: jest.fn(() => fakeChild()),
    stopCurrent: jest.fn(),
    close: jest.fn(),
  };
  const pusher = { start: jest.fn(), stop: jest.fn() };
  const deps: any = {
    library, queue, fifoPath: '/tmp/fifo',
    createFifo: jest.fn(), removeFifo: jest.fn(),
    createSegmentFeeder: jest.fn().mockReturnValue(feeder),
    createRtmpPusher: jest.fn().mockReturnValue(pusher),
    buildOverlay: jest.fn((t: Track) => Promise.resolve(overlayFor(t))),
  };
  return { deps, library, queue, feeder, pusher, children };
}

describe('StreamController', () => {
  it('start() creates the fifo, starts the pusher and feeds the current track with no offset', async () => {
    const { deps, feeder, pusher } = buildDeps();
    const controller = new StreamController(deps);

    await controller.start();

    expect(deps.createFifo).toHaveBeenCalledWith('/tmp/fifo');
    expect(pusher.start).toHaveBeenCalled();
    expect(feeder.feedTrack).toHaveBeenCalledWith(
      { name: 'a', audioPath: '/music/a.mp3', coverPath: null },
      overlayFor(track('a')),
      0,
      expect.any(Number),
    );
    expect(controller.status().state).toBe('streaming');
  });

  it('start() throws 409 when already streaming', async () => {
    const { deps } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();
    await expect(controller.start()).rejects.toThrow(ApiError);
  });

  it('start() throws 409 when the library is empty', async () => {
    const { deps } = buildDeps();
    deps.library.list.mockReturnValue([]);
    const controller = new StreamController(deps);
    await expect(controller.start()).rejects.toThrow('library is empty');
  });

  it('start() flips state to streaming synchronously, before awaiting buildOverlay (regression: must not block the event loop on ffprobe)', async () => {
    const { deps, feeder } = buildDeps();
    let resolveOverlay!: (overlay: unknown) => void;
    deps.buildOverlay = jest.fn(() => new Promise((resolve) => { resolveOverlay = resolve; }));
    const controller = new StreamController(deps);

    const startPromise = controller.start();

    // Other synchronous work (e.g. a concurrent GET /stream/status handler)
    // must be able to run immediately, without waiting for the duration probe.
    expect(controller.status().state).toBe('streaming');
    expect(feeder.feedTrack).not.toHaveBeenCalled();

    resolveOverlay(overlayFor(track('a')));
    await startPromise;

    expect(feeder.feedTrack).toHaveBeenCalled();
  });

  it('does not feed a track if the pusher dies while the overlay is still being probed', async () => {
    const { deps, feeder, pusher } = buildDeps();
    let resolveOverlay!: (overlay: unknown) => void;
    deps.buildOverlay = jest.fn(() => new Promise((resolve) => { resolveOverlay = resolve; }));
    const controller = new StreamController(deps);

    const startPromise = controller.start();
    const onExit = pusher.start.mock.calls[0][0] as (code: number | null) => void;
    onExit(1); // pusher crashes while we're still awaiting the duration probe

    resolveOverlay(overlayFor(track('a')));
    await startPromise;

    expect(feeder.feedTrack).not.toHaveBeenCalled();
    expect(controller.status().state).toBe('error');
  });

  it('invokes deps.onError when the pusher exits unexpectedly', async () => {
    const { deps, pusher } = buildDeps();
    const onError = jest.fn();
    deps.onError = onError;
    const controller = new StreamController(deps);
    await controller.start();

    const onExit = pusher.start.mock.calls[0][0] as (code: number | null) => void;
    onExit(1);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(controller.status().state).toBe('error');
  });

  it('pause() then resume() seeks feedTrack to the elapsed position', async () => {
    const { deps, feeder } = buildDeps();
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000);
    const controller = new StreamController(deps);
    await controller.start();

    nowSpy.mockReturnValue(1_000 + 12_345);
    controller.pause();
    expect(feeder.feedPause).toHaveBeenCalledWith(12.345);
    expect(controller.status().state).toBe('paused');

    nowSpy.mockReturnValue(1_000 + 20_000);
    await controller.resume();

    expect(feeder.feedTrack).toHaveBeenLastCalledWith(
      { name: 'a', audioPath: '/music/a.mp3', coverPath: null },
      overlayFor(track('a')),
      12.345,
      20,
    );
    expect(controller.status().state).toBe('streaming');

    nowSpy.mockRestore();
  });

  it('next() advances the queue, resets elapsed time and feeds the new track while streaming', async () => {
    const { deps, queue, feeder } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();

    await controller.next();

    expect(queue.next).toHaveBeenCalled();
    expect(feeder.feedTrack).toHaveBeenLastCalledWith(
      { name: 'b', audioPath: '/music/b.mp3', coverPath: null },
      overlayFor(track('b')),
      0,
      expect.any(Number),
    );
  });

  it('next() throws 409 when idle', async () => {
    const { deps } = buildDeps();
    const controller = new StreamController(deps);
    await expect(controller.next()).rejects.toThrow(ApiError);
  });

  it('playByName() inserts into the queue without switching immediately', async () => {
    const { deps, queue, feeder } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();
    feeder.feedTrack.mockClear();

    controller.playByName('b');

    expect(queue.insertNext).toHaveBeenCalledWith({ name: 'b', audioPath: '/music/b.mp3', coverPath: null });
    expect(feeder.feedTrack).not.toHaveBeenCalled();
  });

  it('playByName() throws 404 for an unknown track', () => {
    const { deps } = buildDeps();
    const controller = new StreamController(deps);
    expect(() => controller.playByName('missing')).toThrow(ApiError);
  });

  it('stop() tears down the feeder, pusher and fifo', async () => {
    const { deps, feeder, pusher } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();

    controller.stop();

    expect(feeder.stopCurrent).toHaveBeenCalled();
    expect(feeder.close).toHaveBeenCalled();
    expect(pusher.stop).toHaveBeenCalled();
    expect(deps.removeFifo).toHaveBeenCalledWith('/tmp/fifo');
    expect(controller.status().state).toBe('idle');
  });

  it('start() removes any stale fifo before creating it', async () => {
    const { deps } = buildDeps();
    const controller = new StreamController(deps);

    await controller.start();

    expect(deps.removeFifo).toHaveBeenCalledWith('/tmp/fifo');
    expect(deps.removeFifo.mock.invocationCallOrder[0])
      .toBeLessThan(deps.createFifo.mock.invocationCallOrder[0]);
  });

  it('auto-advances to the next track when the current segment exits naturally', async () => {
    const { deps, queue, feeder, children } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();

    expect(children).toHaveLength(1);
    children[0].emitExit(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(queue.next).toHaveBeenCalled();
    expect(feeder.feedTrack).toHaveBeenLastCalledWith(
      { name: 'b', audioPath: '/music/b.mp3', coverPath: null },
      overlayFor(track('b')),
      0,
      expect.any(Number),
    );
    expect(controller.status().state).toBe('streaming');
  });

  it('does not double-advance when a superseded segment exits late after next()', async () => {
    const { deps, queue, feeder, children } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();

    await controller.next();
    expect(queue.next).toHaveBeenCalledTimes(1);
    expect(feeder.feedTrack).toHaveBeenCalledTimes(2);

    // The killed first segment's ffmpeg exits asynchronously afterwards.
    children[0].emitExit(null);
    await Promise.resolve();
    await Promise.resolve();

    expect(queue.next).toHaveBeenCalledTimes(1);
    expect(feeder.feedTrack).toHaveBeenCalledTimes(2);
  });

  it('does not advance when a segment exits after stop()', async () => {
    const { deps, queue, feeder, children } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();

    controller.stop();
    children[0].emitExit(null);
    await Promise.resolve();
    await Promise.resolve();

    expect(queue.next).not.toHaveBeenCalled();
    expect(feeder.feedTrack).toHaveBeenCalledTimes(1);
    expect(controller.status().state).toBe('idle');
  });

  it('start() recovers from the error state instead of rejecting with 409', async () => {
    const { deps, pusher } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();

    // Simulate the pusher dying unexpectedly.
    const onExit = pusher.start.mock.calls[0][0] as (code: number | null) => void;
    onExit(1);
    expect(controller.status().state).toBe('error');

    await controller.start();

    expect(controller.status().state).toBe('streaming');
  });

  it('supports a full start() -> stop() -> start() cycle without getting stuck in error', async () => {
    const { deps, pusher } = buildDeps();
    const controller = new StreamController(deps);

    await controller.start();
    controller.stop();
    // RtmpPusher swallows the post-stop exit, so no onExit fires here.
    await controller.start();

    expect(controller.status().state).toBe('streaming');
    expect(pusher.start).toHaveBeenCalledTimes(2);
  });

  it('invokes deps.onStatusChanged after start(), pause(), resume(), next(), previous(), playByName(), and stop()', async () => {
    const { deps } = buildDeps();
    const onStatusChanged = jest.fn();
    deps.onStatusChanged = onStatusChanged;
    const controller = new StreamController(deps);

    await controller.start();
    expect(onStatusChanged).toHaveBeenCalledTimes(1);

    controller.pause();
    expect(onStatusChanged).toHaveBeenCalledTimes(2);

    await controller.resume();
    expect(onStatusChanged).toHaveBeenCalledTimes(3);

    await controller.next();
    expect(onStatusChanged).toHaveBeenCalledTimes(4);

    await controller.previous();
    expect(onStatusChanged).toHaveBeenCalledTimes(5);

    controller.playByName('a');
    expect(onStatusChanged).toHaveBeenCalledTimes(6);

    controller.stop();
    expect(onStatusChanged).toHaveBeenCalledTimes(7);
  });

  it('invokes deps.onStatusChanged when a track auto-advances', async () => {
    const { deps, children } = buildDeps();
    const onStatusChanged = jest.fn();
    deps.onStatusChanged = onStatusChanged;
    const controller = new StreamController(deps);
    await controller.start();
    onStatusChanged.mockClear();

    children[0].emitExit(0);

    expect(onStatusChanged).toHaveBeenCalledTimes(1);
  });
});
