import { StreamController } from '../../src/stream/streamController';
import { ApiError } from '../../src/errors';
import { Track } from '../../src/playlist/types';

const BASE_ROWS = [{ key: 'b:0', text: '▶ a', isCurrent: true }, { key: 'b:1', text: '  b', isCurrent: false }];
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
    positionInBase: jest.fn().mockReturnValue(0),
    windowSnapshot: jest.fn().mockReturnValue(BASE_ROWS),
  };
  const children: FakeChild[] = [];
  const audioRelay = {
    attach: jest.fn(),
    attachTap: jest.fn(),
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
  const encoderChild = { videoPipe: {}, audioPipe: {}, pulsePipe: {}, aboveCanvasPipe: {}, playlistWindowPipe: {} };
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
    // The second canvas pipe is handed over unconditionally, exactly like pulsePipe — CanvasFeeder
    // only writes to it when buildStreamScene() (src/stream/streamScene.ts) configured it with an
    // above layer (see CanvasPlacement).
    expect(canvasFeeder.attach).toHaveBeenCalledWith(encoderChild.videoPipe, encoderChild.aboveCanvasPipe);
    expect(audioRelay.attach).toHaveBeenCalledWith(encoderChild.audioPipe);
    expect(audioRelay.switchTrack).toHaveBeenCalledWith('/music/a.mp3', 0);
    // overlayFor()'s tracks have no timer element, so timerText() is null, not a formatted
    // string — see the timer-specific tests further down for the non-null case.
    expect(canvasFeeder.render).toHaveBeenCalledWith(overlayFor(track('a')), null);
    expect(controller.status().state).toBe('streaming');
  });

  it('start() does nothing pulse-related when the deps have no createPulseVisualizer (no equalizer element)', async () => {
    const { deps } = buildDeps();
    const controller = new StreamController(deps);
    await expect(controller.start()).resolves.toBeUndefined();
  });

  it('start() creates and attaches a PulseVisualizer, and taps its audioSink into the audio relay, when createPulseVisualizer is provided', async () => {
    const { deps, encoderChild, audioRelay } = buildDeps();
    const pulseVisualizer = { attach: jest.fn(), audioSink: {}, close: jest.fn() };
    deps.createPulseVisualizer = jest.fn().mockReturnValue(pulseVisualizer);
    const controller = new StreamController(deps);

    await controller.start();

    expect(pulseVisualizer.attach).toHaveBeenCalledWith(encoderChild.pulsePipe);
    expect(audioRelay.attachTap).toHaveBeenCalledWith(pulseVisualizer.audioSink);
  });

  it('stop() closes the PulseVisualizer when one was created', async () => {
    const { deps } = buildDeps();
    const pulseVisualizer = { attach: jest.fn(), audioSink: {}, close: jest.fn() };
    deps.createPulseVisualizer = jest.fn().mockReturnValue(pulseVisualizer);
    const controller = new StreamController(deps);
    await controller.start();

    controller.stop();

    expect(pulseVisualizer.close).toHaveBeenCalled();
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
    expect(onError).toHaveBeenCalledWith(1);
    expect(controller.status().state).toBe('error');
  });

  it('an unexpected exit tears down every collaborator IMMEDIATELY, before deciding whether to retry (the resource-leak fix: previously CanvasFeeder\'s heartbeat/AudioRelay\'s decoder/PulseVisualizer kept running against a dead pipe until a human called start()/stop())', async () => {
    const { deps, encoder, canvasFeeder, audioRelay } = buildDeps();
    const pulseVisualizer = { attach: jest.fn(), audioSink: {}, close: jest.fn() };
    deps.createPulseVisualizer = jest.fn().mockReturnValue(pulseVisualizer);
    // No reconnectPolicy — this is the "give up immediately" path, but teardown must still run
    // first regardless of the eventual retry-or-not decision.
    const controller = new StreamController(deps);
    await controller.start();

    const onExit = encoder.start.mock.calls[0][0] as (code: number | null) => void;
    onExit(1);

    expect(canvasFeeder.close).toHaveBeenCalledTimes(1);
    expect(audioRelay.close).toHaveBeenCalledTimes(1);
    expect(pulseVisualizer.close).toHaveBeenCalledTimes(1);
    expect(encoder.stop).toHaveBeenCalledTimes(1);
  });

  describe('reconnect on an unexpected exit', () => {
    // A minimal fake policy — these tests are about StreamController's OWN mechanics (does it
    // compute uptime/capture the elapsed position/schedule+cancel the timer/respawn correctly),
    // not about the actual default policy's numeric thresholds (that's reconnectPolicy.test.ts).
    function fakePolicy(decide: jest.Mock) {
      return { decide };
    }

    it('schedules a reconnect (state -> reconnecting, notifies) when the policy says to retry, and does NOT call onError', async () => {
      const { deps, encoder } = buildDeps();
      const onError = jest.fn();
      const onStatusChanged = jest.fn();
      deps.onError = onError;
      deps.onStatusChanged = onStatusChanged;
      deps.reconnectPolicy = fakePolicy(jest.fn().mockReturnValue({ retry: true, delayMs: 5000 }));
      const controller = new StreamController(deps);
      await controller.start();
      onStatusChanged.mockClear();

      const onExit = encoder.start.mock.calls[0][0] as (code: number | null) => void;
      onExit(1);

      expect(controller.status().state).toBe('reconnecting');
      expect(onError).not.toHaveBeenCalled();
      expect(onStatusChanged).toHaveBeenCalledTimes(1);
    });

    it('a policy that says not to retry behaves exactly like the pre-reconnect give-up path: state -> error, onError invoked', async () => {
      const { deps, encoder } = buildDeps();
      const onError = jest.fn();
      deps.onError = onError;
      deps.reconnectPolicy = fakePolicy(jest.fn().mockReturnValue({ retry: false }));
      const controller = new StreamController(deps);
      await controller.start();

      const onExit = encoder.start.mock.calls[0][0] as (code: number | null) => void;
      onExit(1);

      expect(controller.status().state).toBe('error');
      expect(onError).toHaveBeenCalledWith(1);
    });

    it('passes the just-died encoder\'s uptime to the policy, computed from when it was spawned', async () => {
      const { deps, encoder } = buildDeps();
      const decide = jest.fn().mockReturnValue({ retry: false });
      deps.reconnectPolicy = fakePolicy(decide);
      jest.useFakeTimers();
      try {
        jest.setSystemTime(0);
        const controller = new StreamController(deps);
        await controller.start();

        jest.setSystemTime(23_000);
        const onExit = encoder.start.mock.calls[0][0] as (code: number | null) => void;
        onExit(1);

        expect(decide).toHaveBeenCalledWith(expect.objectContaining({ uptimeMs: 23_000, attempt: 1 }));
      } finally {
        jest.useRealTimers();
      }
    });

    it('after the backoff delay elapses, respawns the encoder and resumes the track that was playing at its captured elapsed position (the same -ss seek path pause/resume already use)', async () => {
      const { deps, encoder, audioRelay, canvasFeeder } = buildDeps();
      deps.reconnectPolicy = fakePolicy(jest.fn().mockReturnValue({ retry: true, delayMs: 5000 }));
      jest.useFakeTimers();
      try {
        jest.setSystemTime(0);
        const controller = new StreamController(deps);
        await controller.start(); // trackStartedAt = 0, track 'a'

        jest.setSystemTime(7_500); // 7.5s into track 'a' when the encoder dies
        const onExit = encoder.start.mock.calls[0][0] as (code: number | null) => void;
        onExit(1);
        expect(controller.status().state).toBe('reconnecting');

        audioRelay.switchTrack.mockClear();
        canvasFeeder.render.mockClear();

        await jest.advanceTimersByTimeAsync(5000);

        expect(encoder.start).toHaveBeenCalledTimes(2);
        expect(audioRelay.switchTrack).toHaveBeenCalledWith('/music/a.mp3', 7.5);
        expect(controller.status().state).toBe('streaming');
      } finally {
        jest.useRealTimers();
      }
    });

    it('a stale sessionGeneration at fire-time (stop() ran while the reconnect was pending) cancels the scheduled respawn', async () => {
      const { deps, encoder } = buildDeps();
      deps.reconnectPolicy = { decide: jest.fn().mockReturnValue({ retry: true, delayMs: 5000 }) };
      jest.useFakeTimers();
      try {
        const controller = new StreamController(deps);
        await controller.start();
        const onExit = encoder.start.mock.calls[0][0] as (code: number | null) => void;
        onExit(1);
        expect(controller.status().state).toBe('reconnecting');

        controller.stop();
        expect(controller.status().state).toBe('idle');

        await jest.advanceTimersByTimeAsync(5000);

        // stop() bumped sessionGeneration, so the pending respawn must have bailed instead of
        // reviving a session the user explicitly stopped.
        expect(encoder.start).toHaveBeenCalledTimes(1);
        expect(controller.status().state).toBe('idle');
      } finally {
        jest.useRealTimers();
      }
    });

    it('stop() while reconnecting clears the pending timer outright (belt-and-suspenders alongside the generation guard)', async () => {
      const { deps, encoder } = buildDeps();
      deps.reconnectPolicy = { decide: jest.fn().mockReturnValue({ retry: true, delayMs: 5000 }) };
      jest.useFakeTimers();
      try {
        const controller = new StreamController(deps);
        await controller.start();
        const onExit = encoder.start.mock.calls[0][0] as (code: number | null) => void;
        onExit(1);

        controller.stop();
        const pendingCountBefore = jest.getTimerCount();

        await jest.advanceTimersByTimeAsync(5000);

        expect(jest.getTimerCount()).toBeLessThanOrEqual(pendingCountBefore);
        expect(encoder.start).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('next()/previous() do not throw while reconnecting (they may mutate the queue; the pending respawn reads queue.current() when it fires)', async () => {
      const { deps, encoder, queue } = buildDeps();
      deps.reconnectPolicy = { decide: jest.fn().mockReturnValue({ retry: true, delayMs: 5000 }) };
      const controller = new StreamController(deps);
      await controller.start();
      const onExit = encoder.start.mock.calls[0][0] as (code: number | null) => void;
      onExit(1);
      expect(controller.status().state).toBe('reconnecting');

      await expect(controller.next()).resolves.toBeUndefined();
      await expect(controller.previous()).resolves.toBeUndefined();
      expect(queue.next).toHaveBeenCalled();
      expect(queue.previous).toHaveBeenCalled();
    });

    it('pause()/resume() still reject while reconnecting', async () => {
      const { deps, encoder } = buildDeps();
      deps.reconnectPolicy = { decide: jest.fn().mockReturnValue({ retry: true, delayMs: 5000 }) };
      const controller = new StreamController(deps);
      await controller.start();
      const onExit = encoder.start.mock.calls[0][0] as (code: number | null) => void;
      onExit(1);

      expect(() => controller.pause()).toThrow(ApiError);
      await expect(controller.resume()).rejects.toThrow(ApiError);
    });

    it('if next() advances the queue while reconnecting, the eventual respawn feeds the NEW current track from 0, not the old track at its stale captured offset', async () => {
      const { deps, encoder, audioRelay, queue } = buildDeps();
      deps.reconnectPolicy = { decide: jest.fn().mockReturnValue({ retry: true, delayMs: 5000 }) };
      jest.useFakeTimers();
      try {
        jest.setSystemTime(0);
        const controller = new StreamController(deps);
        await controller.start(); // track 'a'

        jest.setSystemTime(9_000);
        const onExit = encoder.start.mock.calls[0][0] as (code: number | null) => void;
        onExit(1);

        await controller.next(); // queue now points at track 'b'
        queue.current.mockReturnValue({ name: 'b', audioPath: '/music/b.mp3', coverPath: null });
        audioRelay.switchTrack.mockClear();

        await jest.advanceTimersByTimeAsync(5000);

        expect(audioRelay.switchTrack).toHaveBeenCalledWith('/music/b.mp3', 0);
      } finally {
        jest.useRealTimers();
      }
    });

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
      // Plain, UNescaped text: colon escaping for ffmpeg drawtext happens once, at the filter
      // boundary in segmentArgs.ts's overlayFilterComplex() — escaping here too double-escaped
      // it into something real ffmpeg rejects outright.
      expect(canvasFeeder.render).toHaveBeenCalledWith(overlayWithTimer, '0:06 / 1:40');
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

  describe('enqueueTrack (donation requests queue next, never interrupt)', () => {
    const donation = (onFinished = jest.fn()): Track => ({
      name: 'donation', audioPath: '/tmp/d.mp3', coverPath: null, ephemeral: true, _onFinished: onFinished,
    });

    it('inserts next without switching what is playing', async () => {
      const { deps, queue, audioRelay } = buildDeps();
      const controller = new StreamController(deps);
      await controller.start();
      audioRelay.switchTrack.mockClear();
      const d = donation();

      controller.enqueueTrack(d);

      expect(queue.insertNext).toHaveBeenCalledWith(d);
      expect(audioRelay.switchTrack).not.toHaveBeenCalled();
      expect(controller.status().state).toBe('streaming');
    });

    it('while paused it only queues — the stream stays paused', async () => {
      const { deps, audioRelay } = buildDeps();
      const controller = new StreamController(deps);
      await controller.start();
      controller.pause();
      audioRelay.switchTrack.mockClear();

      controller.enqueueTrack(donation());

      expect(audioRelay.switchTrack).not.toHaveBeenCalled();
      expect(controller.status().state).toBe('paused');
    });

    it('while idle it only queues', () => {
      const { deps, queue, audioRelay } = buildDeps();
      const controller = new StreamController(deps);
      const d = donation();
      controller.enqueueTrack(d);
      expect(queue.insertNext).toHaveBeenCalledWith(d);
      expect(audioRelay.switchTrack).not.toHaveBeenCalled();
    });

    it('notifies onStatusChanged', () => {
      const { deps } = buildDeps();
      deps.onStatusChanged = jest.fn();
      const controller = new StreamController(deps);
      controller.enqueueTrack(donation());
      expect(deps.onStatusChanged).toHaveBeenCalled();
    });

    it('playByName goes through the same insert (one insert path)', async () => {
      const { deps, queue } = buildDeps();
      const controller = new StreamController(deps);
      const spy = jest.spyOn(controller, 'enqueueTrack');
      controller.playByName('b');
      expect(spy).toHaveBeenCalledWith({ name: 'b', audioPath: '/music/b.mp3', coverPath: null });
      expect(queue.insertNext).toHaveBeenCalledTimes(1);
    });
  });

  describe('releasing a skipped ephemeral track', () => {
    it('next() off a playing ephemeral track fires its _onFinished exactly once', async () => {
      const { deps, queue } = buildDeps();
      const onFinished = jest.fn();
      const d: Track = { name: 'donation', audioPath: '/tmp/d.mp3', coverPath: null, ephemeral: true, _onFinished: onFinished };
      const controller = new StreamController(deps);
      await controller.start();
      queue.current.mockReturnValue(d);

      await controller.next();

      expect(onFinished).toHaveBeenCalledTimes(1);
      expect(d._onFinished).toBeUndefined();
    });

    it('previous() off a playing ephemeral track fires its _onFinished exactly once', async () => {
      const { deps, queue } = buildDeps();
      const onFinished = jest.fn();
      const d: Track = { name: 'donation', audioPath: '/tmp/d.mp3', coverPath: null, ephemeral: true, _onFinished: onFinished };
      const controller = new StreamController(deps);
      await controller.start();
      queue.current.mockReturnValue(d);
      queue.previous.mockReturnValueOnce(track('a'));

      await controller.previous();

      expect(onFinished).toHaveBeenCalledTimes(1);
    });

    it('previous() that stays on the same track (empty history) releases nothing', async () => {
      const { deps, queue } = buildDeps();
      const onFinished = jest.fn();
      const d: Track = { name: 'donation', audioPath: '/tmp/d.mp3', coverPath: null, ephemeral: true, _onFinished: onFinished };
      const controller = new StreamController(deps);
      await controller.start();
      queue.current.mockReturnValue(d);
      queue.previous.mockReturnValueOnce(d);

      await controller.previous();

      expect(onFinished).not.toHaveBeenCalled();
    });

    it('a throwing _onFinished on skip is logged, not thrown', async () => {
      const { deps, queue } = buildDeps();
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const d: Track = { name: 'donation', audioPath: '/tmp/d.mp3', coverPath: null, ephemeral: true, _onFinished: () => { throw new Error('boom'); } };
        const controller = new StreamController(deps);
        await controller.start();
        queue.current.mockReturnValue(d);
        await expect(controller.next()).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  describe('status().currentTrack', () => {
    it('is null before start and after stop, the current track name while streaming/paused', async () => {
      const { deps } = buildDeps();
      const controller = new StreamController(deps);
      expect(controller.status().currentTrack).toBeNull();
      await controller.start();
      expect(controller.status().currentTrack).toBe('a');
      controller.pause();
      expect(controller.status().currentTrack).toBe('a');
      controller.stop();
      expect(controller.status().currentTrack).toBeNull();
    });
  });

  it('calls a track\'s _onFinished exactly once, right when its own decode process closes', async () => {
    const { deps, queue, children } = buildDeps();
    const onFinished = jest.fn();
    const ephemeralTrack: Track = { name: 'donation track', audioPath: '/tmp/donation.mp3', coverPath: null, ephemeral: true, _onFinished: onFinished };
    const controller = new StreamController(deps);
    await controller.start(); // feeds 'a' -> children[0]

    queue.next.mockReturnValueOnce(ephemeralTrack);
    children[0].emitClose(0); // 'a' ends -> advances onto ephemeralTrack -> children[1]
    await Promise.resolve();
    await Promise.resolve();
    expect(onFinished).not.toHaveBeenCalled(); // ephemeralTrack is now playing, not finished yet

    children[1].emitClose(0); // ephemeralTrack ends
    await Promise.resolve();
    await Promise.resolve();

    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('a re-fed track whose hook already fired never fires it again (defense in depth)', async () => {
    const { deps, queue, children } = buildDeps();
    const onFinished = jest.fn();
    const ephemeralTrack: Track = { name: 'donation track', audioPath: '/tmp/donation.mp3', coverPath: null, ephemeral: true, _onFinished: onFinished };
    const controller = new StreamController(deps);
    await controller.start(); // feeds 'a' -> children[0]

    queue.next.mockReturnValueOnce(ephemeralTrack);
    children[0].emitClose(0); // 'a' ends -> advances onto ephemeralTrack -> children[1]
    await Promise.resolve();
    await Promise.resolve();

    children[1].emitClose(0); // ephemeralTrack ends -> onFinished fires (1st time) -> advances to 'b'
    await Promise.resolve();
    await Promise.resolve();
    expect(onFinished).toHaveBeenCalledTimes(1);

    // previous() pops the (mocked) ephemeralTrack back out and re-feeds it through a brand-new
    // decode child — the hook must have already disarmed itself, or this second close fires it again.
    queue.previous.mockReturnValueOnce(ephemeralTrack);
    await controller.previous();
    const replayedChild = children[children.length - 1];
    replayedChild.emitClose(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('does not let a throwing _onFinished hook skip auto-advance or crash the process', async () => {
    const { deps, queue, audioRelay, children } = buildDeps();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const onFinished = jest.fn(() => { throw new Error('boom'); });
      const ephemeralTrack: Track = { name: 'donation track', audioPath: '/tmp/donation.mp3', coverPath: null, ephemeral: true, _onFinished: onFinished };
      const controller = new StreamController(deps);
      await controller.start(); // feeds 'a' -> children[0]

      queue.next.mockReturnValueOnce(ephemeralTrack);
      children[0].emitClose(0); // 'a' ends -> advances onto ephemeralTrack -> children[1]
      await Promise.resolve();
      await Promise.resolve();

      audioRelay.switchTrack.mockClear();
      expect(() => children[1].emitClose(0)).not.toThrow(); // ephemeralTrack ends; its hook throws
      await Promise.resolve();
      await Promise.resolve();

      expect(onFinished).toHaveBeenCalledTimes(1);
      // advanceToNextTrack() must still have run despite the throw — the next track ('b', the
      // default queue.next() return) was fed rather than the stream silently stalling on 'E'.
      expect(audioRelay.switchTrack).toHaveBeenCalledWith('/music/b.mp3', 0);
      expect(controller.status().state).toBe('streaming');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('a regular library track (no _onFinished) closes without throwing, and never invokes the NEXT track\'s hook', async () => {
    const { deps, queue, children } = buildDeps();
    const onFinished = jest.fn();
    const nextTrack: Track = { name: 'b', audioPath: '/music/b.mp3', coverPath: null, _onFinished: onFinished };
    queue.next.mockReturnValueOnce(nextTrack);
    const controller = new StreamController(deps);
    await controller.start();

    expect(() => children[0].emitClose(0)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(onFinished).not.toHaveBeenCalled();
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

  describe('playlist window burst layer', () => {
    const INSERTED_ROWS = [{ key: 'b:0', text: '▶ a', isCurrent: true }, { key: 'i:0', text: '  d', isCurrent: false }, { key: 'b:1', text: '  b', isCurrent: false }];
    function withFeeder() {
      const ctx = buildDeps();
      const feeder = { attach: jest.fn(), showRows: jest.fn().mockResolvedValue(undefined), animate: jest.fn().mockResolvedValue(undefined), goIdle: jest.fn(), close: jest.fn() };
      ctx.deps.createPlaylistWindowFeeder = jest.fn().mockReturnValue(feeder);
      ctx.deps.buildOverlay = jest.fn((t: Track, _rows: unknown, opts?: { omitLivePlaylist?: boolean }) =>
        Promise.resolve({ ...overlayFor(t), variant: opts?.omitLivePlaylist ? 'A' : 'B' }));
      return { ...ctx, feeder };
    }
    const settle = async () => { for (let i = 0; i < 30; i++) { jest.advanceTimersByTime(100); await Promise.resolve(); await Promise.resolve(); } };

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('attaches the feeder to pipe:7 and bakes the snapshot rows on start', async () => {
      const { deps, feeder, encoderChild } = withFeeder();
      await new StreamController(deps).start();
      expect(feeder.attach).toHaveBeenCalledWith(encoderChild.playlistWindowPipe);
      expect(deps.buildOverlay).toHaveBeenCalledWith(expect.anything(), BASE_ROWS);
    });

    it('enqueueTrack runs a burst: A is baked (and becomes currentOverlay), then B with the new rows', async () => {
      const { deps, queue, canvasFeeder, feeder } = withFeeder();
      const controller = new StreamController(deps);
      await controller.start();
      queue.windowSnapshot.mockReturnValue(INSERTED_ROWS);
      controller.enqueueTrack({ name: 'd', audioPath: '/tmp/d.mp3', coverPath: null });
      await settle();
      expect(feeder.showRows).toHaveBeenCalledWith(BASE_ROWS);
      expect(feeder.animate).toHaveBeenCalled();
      const variants = canvasFeeder.render.mock.calls.map((c: any[]) => c[0].variant);
      expect(variants).toContain('A');
      expect(variants[variants.length - 1]).toBe('B');
      expect(deps.buildOverlay).toHaveBeenLastCalledWith(expect.anything(), INSERTED_ROWS, { omitLivePlaylist: false });
      expect(feeder.goIdle).toHaveBeenCalled();
    });

    it("the timer's once-a-second re-render uses variant A while the burst is in progress", async () => {
      const { deps, queue, canvasFeeder, feeder } = withFeeder();
      deps.buildOverlay.mockImplementation((t: Track, _r: unknown, opts?: any) => Promise.resolve({ ...overlayFor(t), variant: opts?.omitLivePlaylist ? 'A' : 'B', timer: { x: 0, y: 0, fontSize: 10, color: '#fff', style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } } }));
      let releaseAnimate!: () => void;
      feeder.animate.mockImplementation(() => new Promise<void>((r) => { releaseAnimate = r; }));
      const controller = new StreamController(deps);
      await controller.start();
      queue.windowSnapshot.mockReturnValue(INSERTED_ROWS);
      controller.enqueueTrack({ name: 'd', audioPath: '/tmp/d.mp3', coverPath: null });
      await settle(); // now parked inside animate(), canvas is A
      canvasFeeder.render.mockClear();
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(canvasFeeder.render.mock.calls.every((c: any[]) => c[0].variant === 'A')).toBe(true);
      releaseAnimate();
      await settle();
    });

    it('next() during a burst aborts it (feeder idle) and the new track bakes normally (C2)', async () => {
      const { deps, queue, canvasFeeder, feeder } = withFeeder();
      feeder.animate.mockImplementation(() => new Promise<void>(() => {}));
      const controller = new StreamController(deps);
      await controller.start();
      queue.windowSnapshot.mockReturnValue(INSERTED_ROWS);
      controller.enqueueTrack({ name: 'd', audioPath: '/tmp/d.mp3', coverPath: null });
      await settle();
      feeder.goIdle.mockClear();
      await controller.next();
      expect(feeder.goIdle).toHaveBeenCalled();
      const last = canvasFeeder.render.mock.calls[canvasFeeder.render.mock.calls.length - 1][0];
      expect(last.variant).toBe('B');
    });

    it('a track enqueued while a track change awaits its overlay is caught up once the feed lands', async () => {
      const { deps, queue, feeder, library } = withFeeder();
      const controller = new StreamController(deps);
      await controller.start();
      const b = library.list()[1];
      let resolveOverlay!: () => void;
      deps.buildOverlay.mockImplementationOnce((t: Track) => new Promise((r) => { resolveOverlay = () => r({ ...overlayFor(t), variant: 'B' }); }));
      const pending = controller.next(); // rows (BASE_ROWS) captured, now awaiting the overlay
      queue.current.mockReturnValue(b);
      queue.windowSnapshot.mockReturnValue(INSERTED_ROWS);
      controller.enqueueTrack({ name: 'd', audioPath: '/tmp/d.mp3', coverPath: null }); // skipped: b isn't on screen yet
      expect(feeder.showRows).not.toHaveBeenCalled();
      resolveOverlay();
      await pending;
      await settle();
      expect(feeder.animate).toHaveBeenCalled();
      expect(deps.buildOverlay).toHaveBeenLastCalledWith(b, INSERTED_ROWS, { omitLivePlaylist: false });
    });

    it('paused -> next() -> a donation arrives: no bake/burst until resume (the screen must not show the next track early)', async () => {
      const { deps, queue, feeder } = withFeeder();
      const controller = new StreamController(deps);
      await controller.start();
      controller.pause();
      queue.current.mockReturnValue(track('b')); // next() moved the queue while paused; nothing was fed
      await controller.next();
      deps.buildOverlay.mockClear();
      queue.windowSnapshot.mockReturnValue(INSERTED_ROWS);
      controller.enqueueTrack({ name: 'd', audioPath: '/tmp/d.mp3', coverPath: null });
      await settle();
      expect(deps.buildOverlay).not.toHaveBeenCalled();
      expect(feeder.showRows).not.toHaveBeenCalled();
    });

    it('enqueueTrack while idle/reconnecting runs no burst (C7)', () => {
      const { deps, feeder } = withFeeder();
      const controller = new StreamController(deps);
      controller.enqueueTrack({ name: 'd', audioPath: '/tmp/d.mp3', coverPath: null });
      expect(feeder.showRows).not.toHaveBeenCalled();
    });

    it('stop() closes the feeder', async () => {
      const { deps, feeder } = withFeeder();
      const controller = new StreamController(deps);
      await controller.start();
      controller.stop();
      expect(feeder.close).toHaveBeenCalled();
    });

    it('without a playlist element (no factory) enqueueTrack only queues', async () => {
      const { deps, queue } = buildDeps();
      const controller = new StreamController(deps);
      await controller.start();
      deps.buildOverlay.mockClear();
      queue.windowSnapshot.mockReturnValue(INSERTED_ROWS);
      controller.enqueueTrack({ name: 'd', audioPath: '/tmp/d.mp3', coverPath: null });
      expect(deps.buildOverlay).not.toHaveBeenCalled();
    });
  });
});
