import { StreamController } from '../../src/stream/streamController';
import { ApiError } from '../../src/errors';
import { Track } from '../../src/playlist/types';

const track = (name: string): Track => ({ name, audioPath: `/music/${name}.mp3`, coverPath: null });
const overlayFor = (t: Track) => ({ title: t.name, playlistLines: [`▶ ${t.name}`], durationSeconds: 100, overlayPng: Buffer.from('png'), timer: null });

type FakeChild = { pid: number; stdout: null; stderr: null; kill: jest.Mock; once: jest.Mock; emitClose: (code?: number | null) => void };

function fakeChild(): FakeChild {
  let closeListener: ((code: number | null) => void) | null = null;
  return {
    pid: 1, stdout: null, stderr: null, kill: jest.fn(),
    once: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'close') closeListener = listener as (code: number | null) => void;
    }),
    emitClose: (code = 0) => closeListener && closeListener(code),
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
  const audioRelay = {
    attach: jest.fn(),
    switchTrack: jest.fn(() => {
      const child = fakeChild();
      children.push(child);
      return child;
    }),
    switchToSilence: jest.fn(() => fakeChild()),
    stopCurrent: jest.fn(),
    close: jest.fn(),
  };
  const canvasFeeder = { attach: jest.fn(), render: jest.fn().mockResolvedValue(undefined), close: jest.fn() };
  const encoderChild = { videoPipe: {}, audioPipe: {} };
  const encoder = { start: jest.fn().mockReturnValue(encoderChild), stop: jest.fn() };
  const deps: any = {
    library, queue,
    createCanvasFeeder: jest.fn().mockReturnValue(canvasFeeder),
    createAudioRelay: jest.fn().mockReturnValue(audioRelay),
    createPersistentEncoder: jest.fn().mockReturnValue(encoder),
    buildOverlay: jest.fn((t: Track) => Promise.resolve(overlayFor(t))),
  };
  return { deps, library, queue, canvasFeeder, audioRelay, encoder, encoderChild, children };
}

describe('StreamController', () => {
  it('start() creates the persistent encoder, attaches the canvas feeder and audio relay to its pipes, and feeds the current track', async () => {
    const { deps, encoder, encoderChild, canvasFeeder, audioRelay } = buildDeps();
    const controller = new StreamController(deps);

    await controller.start();

    expect(encoder.start).toHaveBeenCalled();
    expect(canvasFeeder.attach).toHaveBeenCalledWith(encoderChild.videoPipe);
    expect(audioRelay.attach).toHaveBeenCalledWith(encoderChild.audioPipe);
    expect(audioRelay.switchTrack).toHaveBeenCalledWith('/music/a.mp3', 0);
    // overlayFor()'s tracks have no timer element, so timerText() is null, not a formatted
    // string — see the timer-specific tests further down for the non-null case.
    expect(canvasFeeder.render).toHaveBeenCalledWith(overlayFor(track('a')), null);
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
    const { deps, audioRelay } = buildDeps();
    let resolveOverlay!: (overlay: unknown) => void;
    deps.buildOverlay = jest.fn(() => new Promise((resolve) => { resolveOverlay = resolve; }));
    const controller = new StreamController(deps);

    const startPromise = controller.start();

    expect(controller.status().state).toBe('streaming');
    expect(audioRelay.switchTrack).not.toHaveBeenCalled();

    resolveOverlay(overlayFor(track('a')));
    await startPromise;

    expect(audioRelay.switchTrack).toHaveBeenCalled();
  });

  it('does not feed a track if the encoder dies while the overlay is still being probed', async () => {
    const { deps, audioRelay, encoder } = buildDeps();
    let resolveOverlay!: (overlay: unknown) => void;
    deps.buildOverlay = jest.fn(() => new Promise((resolve) => { resolveOverlay = resolve; }));
    const controller = new StreamController(deps);

    const startPromise = controller.start();
    const onExit = encoder.start.mock.calls[0][0] as (code: number | null) => void;
    onExit(1);

    resolveOverlay(overlayFor(track('a')));
    await startPromise;

    expect(audioRelay.switchTrack).not.toHaveBeenCalled();
    expect(controller.status().state).toBe('error');
  });

  it('invokes deps.onError when the encoder exits unexpectedly', async () => {
    const { deps, encoder } = buildDeps();
    const onError = jest.fn();
    deps.onError = onError;
    const controller = new StreamController(deps);
    await controller.start();

    const onExit = encoder.start.mock.calls[0][0] as (code: number | null) => void;
    onExit(1);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(controller.status().state).toBe('error');
  });

  it('pause() switches the audio relay to silence and renders a frozen timer text, then resume() seeks the audio relay back', async () => {
    const { deps, audioRelay, canvasFeeder } = buildDeps();
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000);
    const controller = new StreamController(deps);
    await controller.start();
    canvasFeeder.render.mockClear();

    nowSpy.mockReturnValue(1_000 + 12_345);
    controller.pause();

    expect(audioRelay.switchToSilence).toHaveBeenCalled();
    expect(canvasFeeder.render).toHaveBeenCalledWith(overlayFor(track('a')), null);
    expect(controller.status().state).toBe('paused');

    nowSpy.mockReturnValue(1_000 + 20_000);
    await controller.resume();

    expect(audioRelay.switchTrack).toHaveBeenLastCalledWith('/music/a.mp3', 12.345);
    expect(controller.status().state).toBe('streaming');

    nowSpy.mockRestore();
  });

  it('accumulates track-elapsed time across multiple pause/resume cycles, for a frozen timer to show while paused', async () => {
    const { deps, audioRelay } = buildDeps();
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(0);
    const controller = new StreamController(deps);
    await controller.start();

    nowSpy.mockReturnValue(5_000);
    controller.pause();

    nowSpy.mockReturnValue(8_000);
    await controller.resume();
    expect(audioRelay.switchTrack).toHaveBeenLastCalledWith('/music/a.mp3', 5);

    nowSpy.mockReturnValue(11_000);
    controller.pause();

    nowSpy.mockReturnValue(14_000);
    await controller.resume();
    expect(audioRelay.switchTrack).toHaveBeenLastCalledWith('/music/a.mp3', 8);

    nowSpy.mockRestore();
  });

  it('the ticking timer continues from the paused position after resume, instead of resetting toward zero', async () => {
    const { deps, canvasFeeder } = buildDeps();
    const overlayWithTimer = { ...overlayFor(track('a')), timer: { x: 10, y: 660, fontSize: 20, color: '#ffffff' } };
    deps.buildOverlay = jest.fn(() => Promise.resolve(overlayWithTimer));
    // jest.useFakeTimers() (modern, this project's default) replaces the global Date binding
    // itself — jest.spyOn(Date, 'now') is silently inert once it's active, whichever order
    // they're called in. jest.setSystemTime() is the correct way to control "now" here, and
    // jest.advanceTimersByTime() moves that same fake clock forward together with any timers
    // it fires, so a single advance both fires the ticker AND advances what Date.now() reads
    // inside it.
    jest.useFakeTimers();
    try {
      jest.setSystemTime(0);
      const controller = new StreamController(deps);
      await controller.start();

      jest.setSystemTime(5_000); // played 5s before pausing
      controller.pause();

      // resumed immediately — system time unchanged at 5s
      await controller.resume();
      canvasFeeder.render.mockClear();

      jest.advanceTimersByTime(1000); // fires one ticker tick; also moves Date.now() to 6_000

      // 5s (the paused position) + 1s (live since resume) = 6s — NOT 1s, which is what a ticker
      // that only measured time since the resume's own feedCurrentTrack() call would show
      // instead, visibly resetting the on-stream timer every time someone resumes.
      // formatDurationForDrawtext escapes every ':' as '\:' for ffmpeg's drawtext filter syntax
      // (see overlayText.ts) — the expected string carries that escaping too, not plain "0:06".
      expect(canvasFeeder.render).toHaveBeenCalledWith(overlayWithTimer, '0\\:06 / 1\\:40');
    } finally {
      jest.useRealTimers();
    }
  });

  it('next() advances the queue, resets elapsed time and feeds the new track while streaming', async () => {
    const { deps, queue, audioRelay, canvasFeeder } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();

    await controller.next();

    expect(queue.next).toHaveBeenCalled();
    expect(audioRelay.switchTrack).toHaveBeenLastCalledWith('/music/b.mp3', 0);
    expect(canvasFeeder.render).toHaveBeenLastCalledWith(overlayFor(track('b')), null);
  });

  it('next() throws 409 when idle', async () => {
    const { deps } = buildDeps();
    const controller = new StreamController(deps);
    await expect(controller.next()).rejects.toThrow(ApiError);
  });

  it('playByName() inserts into the queue without switching immediately', async () => {
    const { deps, queue, audioRelay } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();
    audioRelay.switchTrack.mockClear();

    controller.playByName('b');

    expect(queue.insertNext).toHaveBeenCalledWith({ name: 'b', audioPath: '/music/b.mp3', coverPath: null });
    expect(audioRelay.switchTrack).not.toHaveBeenCalled();
  });

  it('playByName() throws 404 for an unknown track', () => {
    const { deps } = buildDeps();
    const controller = new StreamController(deps);
    expect(() => controller.playByName('missing')).toThrow(ApiError);
  });

  it('stop() tears down the audio relay, canvas feeder and encoder', async () => {
    const { deps, audioRelay, canvasFeeder, encoder } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();

    controller.stop();

    expect(audioRelay.close).toHaveBeenCalled();
    expect(canvasFeeder.close).toHaveBeenCalled();
    expect(encoder.stop).toHaveBeenCalled();
    expect(controller.status().state).toBe('idle');
  });

  it('auto-advances to the next track when the current decode process closes naturally', async () => {
    const { deps, queue, audioRelay, children } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();

    expect(children).toHaveLength(1);
    children[0].emitClose(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(queue.next).toHaveBeenCalled();
    expect(audioRelay.switchTrack).toHaveBeenLastCalledWith('/music/b.mp3', 0);
    expect(controller.status().state).toBe('streaming');
  });

  it('does not double-advance when a superseded decode process closes late after next()', async () => {
    const { deps, queue, audioRelay, children } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();

    await controller.next();
    expect(queue.next).toHaveBeenCalledTimes(1);
    expect(audioRelay.switchTrack).toHaveBeenCalledTimes(2);

    children[0].emitClose(null);
    await Promise.resolve();
    await Promise.resolve();

    expect(queue.next).toHaveBeenCalledTimes(1);
    expect(audioRelay.switchTrack).toHaveBeenCalledTimes(2);
  });

  it('does not advance when a decode process closes after stop()', async () => {
    const { deps, queue, audioRelay, children } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();

    controller.stop();
    children[0].emitClose(null);
    await Promise.resolve();
    await Promise.resolve();

    expect(queue.next).not.toHaveBeenCalled();
    expect(audioRelay.switchTrack).toHaveBeenCalledTimes(1);
    expect(controller.status().state).toBe('idle');
  });

  it('start() recovers from the error state instead of rejecting with 409', async () => {
    const { deps, encoder } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();

    const onExit = encoder.start.mock.calls[0][0] as (code: number | null) => void;
    onExit(1);
    expect(controller.status().state).toBe('error');

    await controller.start();

    expect(controller.status().state).toBe('streaming');
  });

  it('supports a full start() -> stop() -> start() cycle without getting stuck in error', async () => {
    const { deps, encoder } = buildDeps();
    const controller = new StreamController(deps);

    await controller.start();
    controller.stop();
    await controller.start();

    expect(controller.status().state).toBe('streaming');
    expect(encoder.start).toHaveBeenCalledTimes(2);
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
});
