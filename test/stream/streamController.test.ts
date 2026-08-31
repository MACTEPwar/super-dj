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
    buildOverlay: jest.fn(overlayFor),
  };
  return { deps, library, queue, feeder, pusher, children };
}

describe('StreamController', () => {
  it('start() creates the fifo, starts the pusher and feeds the current track with no offset', () => {
    const { deps, feeder, pusher } = buildDeps();
    const controller = new StreamController(deps);

    controller.start();

    expect(deps.createFifo).toHaveBeenCalledWith('/tmp/fifo');
    expect(pusher.start).toHaveBeenCalled();
    expect(feeder.feedTrack).toHaveBeenCalledWith(
      { name: 'a', audioPath: '/music/a.mp3', coverPath: null },
      overlayFor(track('a')),
    );
    expect(controller.status().state).toBe('streaming');
  });

  it('start() throws 409 when already streaming', () => {
    const { deps } = buildDeps();
    const controller = new StreamController(deps);
    controller.start();
    expect(() => controller.start()).toThrow(ApiError);
  });

  it('start() throws 409 when the library is empty', () => {
    const { deps } = buildDeps();
    deps.library.list.mockReturnValue([]);
    const controller = new StreamController(deps);
    expect(() => controller.start()).toThrow('library is empty');
  });

  it('pause() then resume() seeks feedTrack to the elapsed position', () => {
    const { deps, feeder } = buildDeps();
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000);
    const controller = new StreamController(deps);
    controller.start();

    nowSpy.mockReturnValue(1_000 + 12_345);
    controller.pause();
    expect(feeder.feedPause).toHaveBeenCalled();
    expect(controller.status().state).toBe('paused');

    nowSpy.mockReturnValue(1_000 + 20_000);
    controller.resume();

    expect(feeder.feedTrack).toHaveBeenLastCalledWith(
      { name: 'a', audioPath: '/music/a.mp3', coverPath: null },
      overlayFor(track('a')),
      12.345,
    );
    expect(controller.status().state).toBe('streaming');

    nowSpy.mockRestore();
  });

  it('next() advances the queue, resets elapsed time and feeds the new track while streaming', () => {
    const { deps, queue, feeder } = buildDeps();
    const controller = new StreamController(deps);
    controller.start();

    controller.next();

    expect(queue.next).toHaveBeenCalled();
    expect(feeder.feedTrack).toHaveBeenLastCalledWith(
      { name: 'b', audioPath: '/music/b.mp3', coverPath: null },
      overlayFor(track('b')),
    );
  });

  it('next() throws 409 when idle', () => {
    const { deps } = buildDeps();
    const controller = new StreamController(deps);
    expect(() => controller.next()).toThrow(ApiError);
  });

  it('playByName() inserts into the queue without switching immediately', () => {
    const { deps, queue, feeder } = buildDeps();
    const controller = new StreamController(deps);
    controller.start();
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

  it('stop() tears down the feeder, pusher and fifo', () => {
    const { deps, feeder, pusher } = buildDeps();
    const controller = new StreamController(deps);
    controller.start();

    controller.stop();

    expect(feeder.stopCurrent).toHaveBeenCalled();
    expect(feeder.close).toHaveBeenCalled();
    expect(pusher.stop).toHaveBeenCalled();
    expect(deps.removeFifo).toHaveBeenCalledWith('/tmp/fifo');
    expect(controller.status().state).toBe('idle');
  });

  it('start() removes any stale fifo before creating it', () => {
    const { deps } = buildDeps();
    const controller = new StreamController(deps);

    controller.start();

    expect(deps.removeFifo).toHaveBeenCalledWith('/tmp/fifo');
    expect(deps.removeFifo.mock.invocationCallOrder[0])
      .toBeLessThan(deps.createFifo.mock.invocationCallOrder[0]);
  });

  it('auto-advances to the next track when the current segment exits naturally', () => {
    const { deps, queue, feeder, children } = buildDeps();
    const controller = new StreamController(deps);
    controller.start();

    expect(children).toHaveLength(1);
    children[0].emitExit(0);

    expect(queue.next).toHaveBeenCalled();
    expect(feeder.feedTrack).toHaveBeenLastCalledWith(
      { name: 'b', audioPath: '/music/b.mp3', coverPath: null },
      overlayFor(track('b')),
    );
    expect(controller.status().state).toBe('streaming');
  });

  it('does not double-advance when a superseded segment exits late after next()', () => {
    const { deps, queue, feeder, children } = buildDeps();
    const controller = new StreamController(deps);
    controller.start();

    controller.next();
    expect(queue.next).toHaveBeenCalledTimes(1);
    expect(feeder.feedTrack).toHaveBeenCalledTimes(2);

    // The killed first segment's ffmpeg exits asynchronously afterwards.
    children[0].emitExit(null);

    expect(queue.next).toHaveBeenCalledTimes(1);
    expect(feeder.feedTrack).toHaveBeenCalledTimes(2);
  });

  it('does not advance when a segment exits after stop()', () => {
    const { deps, queue, feeder, children } = buildDeps();
    const controller = new StreamController(deps);
    controller.start();

    controller.stop();
    children[0].emitExit(null);

    expect(queue.next).not.toHaveBeenCalled();
    expect(feeder.feedTrack).toHaveBeenCalledTimes(1);
    expect(controller.status().state).toBe('idle');
  });

  it('start() recovers from the error state instead of rejecting with 409', () => {
    const { deps, pusher } = buildDeps();
    const controller = new StreamController(deps);
    controller.start();

    // Simulate the pusher dying unexpectedly.
    const onExit = pusher.start.mock.calls[0][0] as (code: number | null) => void;
    onExit(1);
    expect(controller.status().state).toBe('error');

    controller.start();

    expect(controller.status().state).toBe('streaming');
  });

  it('supports a full start() -> stop() -> start() cycle without getting stuck in error', () => {
    const { deps, pusher } = buildDeps();
    const controller = new StreamController(deps);

    controller.start();
    controller.stop();
    // RtmpPusher swallows the post-stop exit, so no onExit fires here.
    controller.start();

    expect(controller.status().state).toBe('streaming');
    expect(pusher.start).toHaveBeenCalledTimes(2);
  });
});
