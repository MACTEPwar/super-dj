jest.mock('../../src/ffmpeg/duration', () => ({
  getAudioDurationSeconds: jest.fn().mockResolvedValue(100),
}));
// Defaults every image element to "static" (1 frame) so every pre-existing image-element test
// is unaffected — tests that specifically exercise gif-overlay detection override this per-call.
jest.mock('../../src/ffmpeg/imageFrameCount', () => ({
  getImageFrameCount: jest.fn().mockResolvedValue(1),
}));
jest.mock('../../src/render/renderOverlay', () => ({
  renderTemplatePng: jest.fn().mockResolvedValue(Buffer.from('fake-png')),
}));
// Wraps (never replaces) the real PulseVisualizer so every existing behavior/test in this file is
// unaffected, while letting a test assert on what StreamManager actually constructed it with —
// the only way to observe whether an equalizer element's style was normalized before reaching it.
jest.mock('../../src/ffmpeg/pulseVisualizer', () => {
  const actual = jest.requireActual('../../src/ffmpeg/pulseVisualizer');
  return {
    ...actual,
    PulseVisualizer: jest.fn().mockImplementation((opts) => new actual.PulseVisualizer(opts)),
  };
});

import { PassThrough } from 'stream';
import { StreamManager } from '../../src/stream/streamManager';
import { ApiError } from '../../src/errors';
import { renderTemplatePng } from '../../src/render/renderOverlay';
import { getImageFrameCount } from '../../src/ffmpeg/imageFrameCount';
import { DEFAULT_TEMPLATE_ELEMENTS } from '../../src/templates/templateTypes';
import { PlaylistQueue } from '../../src/playlist/queue';
import { PulseVisualizer } from '../../src/ffmpeg/pulseVisualizer';

// Captures whatever listener a real ffmpeg-wrapping class (CanvasFeeder/AudioRelay/
// PersistentEncoder — StreamManager wires the real ones, not fakes, in this integration-level
// test) registers via once(), and exposes emit() so a fake spawner can simulate that process
// finishing/exiting.
function fakeChild() {
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  return {
    pid: 1,
    stdout: null,
    stderr: null,
    kill: jest.fn(),
    once: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners[event] = listener;
    }),
    emit: (event: string, ...args: unknown[]) => listeners[event]?.(...args),
  };
}

function fakeLifecycle(overrides: Record<string, jest.Mock> = {}) {
  return {
    onPushStarted: jest.fn(),
    phase: jest.fn().mockReturnValue('waitingForYoutube'),
    watchUrl: jest.fn().mockReturnValue('https://www.youtube.com/watch?v=broadcast-1'),
    finalize: jest.fn().mockResolvedValue(undefined),
    onPhaseChange: jest.fn(),
    ...overrides,
  };
}

function buildDeps() {
  // CanvasFeeder's one-shot canvas-frame render (buildCanvasFrameArgs, identifiable by
  // -frames:v) is the only thing spawned through this fake that StreamController directly
  // awaits (render()'s returned promise) — auto-resolve just that one so start()/
  // feedCurrentTrack() don't hang forever waiting on a 'close' that never comes. AudioRelay's
  // decode/silence processes (the other consumer of this same spawner) must NOT auto-close, or
  // every start() would immediately auto-advance past the first track.
  const spawner = jest.fn().mockImplementation((_command: string, args: string[]) => {
    const child = fakeChild();
    if (args.includes('-frames:v')) {
      queueMicrotask(() => child.emit('close', 0));
    }
    return child;
  });
  const destinationRepository = {
    findById: jest.fn().mockResolvedValue({ id: 'dest-1', userId: 'user-1', provider: 'custom' }),
  };
  const playlistRepository = {
    findById: jest.fn().mockResolvedValue({ id: 'playlist-1', userId: 'user-1', name: 'Mix' }),
    listTracks: jest.fn().mockResolvedValue([
      { name: 'a', audioPath: '/music/a.mp3', coverPath: null },
      { name: 'b', audioPath: '/music/b.mp3', coverPath: null },
    ]),
  };
  const trackRepository = {
    listByUser: jest.fn().mockResolvedValue([
      { name: 'a', audioPath: '/music/a.mp3', coverPath: null },
      { name: 'b', audioPath: '/music/b.mp3', coverPath: null },
      { name: 'c', audioPath: '/music/c.mp3', coverPath: null },
    ]),
  };
  const customProvider = { prepareSession: jest.fn().mockResolvedValue({ rtmpUrl: 'rtmp://example.com/live', streamKey: 'real-stream-key' }) };
  const youtubeLifecycle = fakeLifecycle();
  const youtubeProvider = { prepareSession: jest.fn().mockResolvedValue({ rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2', streamKey: 'yt-key', lifecycle: youtubeLifecycle }) };
  const pipeSpawner = jest.fn().mockReturnValue({
    ...fakeChild(),
    videoPipe: new PassThrough(),
    audioPipe: new PassThrough(),
    // Always present on a real ChildProcessWithPipes (see createPipeSpawner) — PulseVisualizer
    // registers a 'drain' listener on it at attach().
    pulsePipe: new PassThrough(),
  });
  const templateRepository = { findById: jest.fn() };
  const templateImageService = {
    resolvePath: jest.fn().mockReturnValue('/uploads/user-1/templates/tpl-1/images/asset-1.png'),
    // Defaults to "no original found" (a plain static image, the common case) — tests exercising
    // gif-overlay detection override this to resolve a real-ish original file path instead.
    resolveOriginalPath: jest.fn().mockResolvedValue(null),
  };
  return {
    deps: {
      spawner, pipeSpawner, fifoDir: '/tmp', defaultCoverPath: '/assets/default.png', backgroundImagePath: '/assets/bg.png',
      fontFile: '/fonts/x.ttf', fontFamily: 'DejaVu Sans', playlistRepository, destinationRepository, trackRepository,
      templateRepository, templateImageService, providers: { custom: customProvider, youtube: youtubeProvider },
    },
    destinationRepository, playlistRepository, trackRepository, templateRepository, templateImageService, customProvider, youtubeProvider, youtubeLifecycle, spawner, pipeSpawner,
  };
}

describe('StreamManager', () => {
  // StreamManager wires up the REAL CanvasFeeder in this integration-level test (see buildDeps()
  // above), and CanvasFeeder.attach() starts a real setInterval heartbeat the moment start()
  // runs (see canvasFeeder.ts) — no test here calls stop() to tear it back down, so without fake
  // timers every start() in this file leaves a live 200ms OS timer running for the rest of the
  // process's life. Across 20+ tests that adds up to enough dangling intervals (each writing to
  // an unread PassThrough) to make Jest hang trying to exit at the end of the file, not just print
  // its usual open-handles warning. `doNotFake: ['queueMicrotask']` matters here — Jest's modern
  // fake timers fake queueMicrotask by default too (not just setInterval/setTimeout/Date), and
  // buildDeps()'s fake spawner resolves CanvasFeeder.render()'s promise via queueMicrotask() —
  // faked, that scheduled callback would only run on an explicit jest.advanceTimersByTime()/
  // runAllTimers() call that nothing here makes, hanging every start() until Jest's real-wall-
  // clock 5000ms test timeout. Excluding it keeps that resolution on the real microtask queue.
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('has no listener cap on the shared EventEmitter, since SSE subscribers are intentionally unbounded', () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any);
    expect(manager.getMaxListeners()).toBe(0);
  });

  it('start() throws 404 for an unknown destination', async () => {
    const { deps, destinationRepository } = buildDeps();
    destinationRepository.findById.mockResolvedValue(null);
    const manager = new StreamManager(deps as any);
    await expect(manager.start('dest-1', 'playlist-1')).rejects.toThrow(ApiError);
  });

  it('start() throws 404 when the playlist does not exist', async () => {
    const { deps, playlistRepository } = buildDeps();
    playlistRepository.findById.mockResolvedValue(null);
    const manager = new StreamManager(deps as any);
    await expect(manager.start('dest-1', 'playlist-1')).rejects.toMatchObject({ status: 404, message: 'playlist not found' });
    expect(playlistRepository.listTracks).not.toHaveBeenCalled();
  });

  it('start() throws 403 when the playlist belongs to another user than the destination owner', async () => {
    const { deps, playlistRepository } = buildDeps();
    playlistRepository.findById.mockResolvedValue({ id: 'playlist-1', userId: 'someone-else', name: 'Theirs' });
    const manager = new StreamManager(deps as any);
    await expect(manager.start('dest-1', 'playlist-1')).rejects.toMatchObject({ status: 403, message: 'not your playlist' });
    expect(playlistRepository.listTracks).not.toHaveBeenCalled();
  });

  it('start() throws 409 for an empty playlist', async () => {
    const { deps, playlistRepository } = buildDeps();
    playlistRepository.listTracks.mockResolvedValue([]);
    const manager = new StreamManager(deps as any);
    await expect(manager.start('dest-1', 'playlist-1')).rejects.toThrow('playlist is empty');
  });

  it('start() throws 400 for a destination with an unregistered provider', async () => {
    const { deps, destinationRepository } = buildDeps();
    destinationRepository.findById.mockResolvedValue({ id: 'dest-1', userId: 'user-1', provider: 'twitch' });
    const manager = new StreamManager(deps as any);
    await expect(manager.start('dest-1', 'playlist-1')).rejects.toMatchObject({ status: 400 });
  });

  it('start() creates a controller reachable via get(), and status() reflects it', async () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any);

    await manager.start('dest-1', 'playlist-1');

    expect(manager.get('dest-1')).toBeDefined();
    expect(manager.status('dest-1').state).toBe('streaming');
    expect(manager.status('dest-1').currentTrack).toBe('a');
  });

  it('start() defaults the broadcast title to the playlist name when no meta is given', async () => {
    const { deps, customProvider } = buildDeps();
    const manager = new StreamManager(deps as any);
    await manager.start('dest-1', 'playlist-1');
    expect(customProvider.prepareSession).toHaveBeenCalledWith(expect.anything(), { title: 'Mix', description: undefined, privacyStatus: undefined });
  });

  it('start() passes through an explicit title/description/privacyStatus', async () => {
    const { deps, customProvider } = buildDeps();
    const manager = new StreamManager(deps as any);
    await manager.start('dest-1', 'playlist-1', { title: 'Custom Title', description: 'D', privacyStatus: 'unlisted' });
    expect(customProvider.prepareSession).toHaveBeenCalledWith(expect.anything(), { title: 'Custom Title', description: 'D', privacyStatus: 'unlisted' });
  });

  it('start() throws 409 if a stream is already active for that destination', async () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any);
    await manager.start('dest-1', 'playlist-1');
    await expect(manager.start('dest-1', 'playlist-1')).rejects.toThrow(ApiError);
  });

  it('rejects a second concurrent start() for the same destination before either registers a controller, instead of leaking a lifecycle', async () => {
    const { deps, customProvider } = buildDeps();
    // Hold prepareSession's promise open so BOTH start() calls are kicked off — and the
    // second call's synchronous "already starting" guard actually lands — while the first
    // call is still in flight, rather than relying on real timing/setTimeout races.
    let releasePrepareSession!: (value: { rtmpUrl: string; streamKey: string }) => void;
    const prepareSessionGate = new Promise<{ rtmpUrl: string; streamKey: string }>((resolve) => {
      releasePrepareSession = resolve;
    });
    customProvider.prepareSession.mockReturnValue(prepareSessionGate);

    const manager = new StreamManager(deps as any);

    const p1 = manager.start('dest-1', 'playlist-1');
    const p2 = manager.start('dest-1', 'playlist-1');

    releasePrepareSession({ rtmpUrl: 'rtmp://example.com/live', streamKey: 'real-stream-key' });

    const results = await Promise.allSettled([p1, p2]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ApiError);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409 });

    // Only one controller ever got registered — the loser never reached this.controllers.set(),
    // so there's no orphaned StreamController/lifecycle sitting behind the winner's entry.
    expect(manager.get('dest-1')).toBeDefined();
    expect(customProvider.prepareSession).toHaveBeenCalledTimes(1);
  });

  it('start() replaces a controller stuck in error state instead of rejecting with 409', async () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any);
    const crashed = { status: () => ({ state: 'error', currentTrack: null, nextTrack: null }), stop: jest.fn() };
    (manager as any).controllers.set('dest-1', crashed);

    await expect(manager.start('dest-1', 'playlist-1')).resolves.toBeUndefined();

    expect(manager.get('dest-1')).toBeDefined();
    expect(manager.get('dest-1')).not.toBe(crashed);
    expect(manager.status('dest-1').state).toBe('streaming');
    expect(crashed.stop).toHaveBeenCalledTimes(1);
  });

  it('start() replaces a controller stuck in reconnecting state instead of rejecting with 409 (a manual restart is a deliberate user override, same as it already is for error)', async () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any);
    const reconnecting = { status: () => ({ state: 'reconnecting', currentTrack: null, nextTrack: null }), stop: jest.fn() };
    (manager as any).controllers.set('dest-1', reconnecting);

    await expect(manager.start('dest-1', 'playlist-1')).resolves.toBeUndefined();

    expect(manager.get('dest-1')).toBeDefined();
    expect(manager.get('dest-1')).not.toBe(reconnecting);
    expect(manager.status('dest-1').state).toBe('streaming');
    expect(reconnecting.stop).toHaveBeenCalledTimes(1);
  });

  it('start() finalizes a stale lifecycle left behind by a crashed controller instead of dropping it', async () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any);
    const crashed = { status: () => ({ state: 'error', currentTrack: null, nextTrack: null }), stop: jest.fn() };
    (manager as any).controllers.set('dest-1', crashed);
    const staleLifecycle = fakeLifecycle();
    (manager as any).lifecycles.set('dest-1', { providerType: 'youtube', lifecycle: staleLifecycle });

    await manager.start('dest-1', 'playlist-1');

    expect(staleLifecycle.finalize).toHaveBeenCalledTimes(1);
  });

  it('status() returns a synthetic idle status when no controller exists for a destination', () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any);
    expect(manager.status('never-started')).toEqual({ state: 'idle', currentTrack: null, nextTrack: null });
  });

  it('pause()/next()/etc. throw 409 when no controller exists for a destination', async () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any);
    expect(() => manager.pause('never-started')).toThrow(ApiError);
    await expect(manager.next('never-started')).rejects.toThrow(ApiError);
  });

  it('an unexpected pusher exit for a custom (non-YouTube) destination also schedules a reconnect — no provider/lifecycle involvement needed, just uptime/crash-loop', async () => {
    const { deps, pipeSpawner } = buildDeps();
    const manager = new StreamManager(deps as any);
    await manager.start('dest-1', 'playlist-1');
    expect(manager.status('dest-1').state).toBe('streaming');

    const encoderChild = (pipeSpawner as jest.Mock).mock.results[0].value;
    const onExit = encoderChild.once.mock.calls.find((call: any[]) => call[0] === 'exit')?.[1];
    onExit(1);

    expect(manager.status('dest-1').state).toBe('reconnecting');
  });

  it('stop() tears the controller down and removes it from the registry', async () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any);
    await manager.start('dest-1', 'playlist-1');

    await manager.stop('dest-1');

    expect(manager.get('dest-1')).toBeUndefined();
    expect(manager.status('dest-1')).toEqual({ state: 'idle', currentTrack: null, nextTrack: null });
  });

  describe('overlay template selection', () => {
    beforeEach(() => jest.clearAllMocks());

    it('renders with DEFAULT_TEMPLATE_ELEMENTS and never touches templateRepository when no templateId is given', async () => {
      const { deps, templateRepository } = buildDeps();
      const manager = new StreamManager(deps as any);

      await manager.start('dest-1', 'playlist-1');

      expect(templateRepository.findById).not.toHaveBeenCalled();
      expect(renderTemplatePng).toHaveBeenCalledWith(expect.objectContaining({ elements: DEFAULT_TEMPLATE_ELEMENTS }));
    });

    it('404s when the given templateId does not exist', async () => {
      const { deps, templateRepository } = buildDeps();
      templateRepository.findById.mockResolvedValue(null);
      const manager = new StreamManager(deps as any);

      await expect(manager.start('dest-1', 'playlist-1', undefined, { templateId: 'tpl-1' }))
        .rejects.toMatchObject({ status: 404, message: 'template not found' });
    });

    it('403s when the given templateId belongs to another user than the destination owner', async () => {
      const { deps, templateRepository } = buildDeps();
      templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'someone-else', elements: [] });
      const manager = new StreamManager(deps as any);

      await expect(manager.start('dest-1', 'playlist-1', undefined, { templateId: 'tpl-1' }))
        .rejects.toMatchObject({ status: 403, message: 'not your template' });
    });

    it('splits a timer element out of what gets rendered into the PNG, and surfaces it separately on the overlay', async () => {
      const { deps, templateRepository, spawner } = buildDeps();
      const coverEl = { type: 'cover', x: 0, y: 0, width: 10, height: 10 };
      const timerEl = { type: 'timer', x: 5, y: 5, fontSize: 20, color: '#ffffff',
        style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } };
      templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [coverEl, timerEl] });
      const manager = new StreamManager(deps as any);

      await manager.start('dest-1', 'playlist-1', undefined, { templateId: 'tpl-1' });

      expect(renderTemplatePng).toHaveBeenCalledWith(expect.objectContaining({ elements: [coverEl] }));
      // The timer isn't baked into the PNG — it reaches ffmpeg as a native drawtext, which only
      // this test suite can observe indirectly via the spawned producer's filter_complex arg.
      const producerCall = (spawner as jest.Mock).mock.calls.find((call) => call[1].includes('-filter_complex'));
      const filterComplex = producerCall![1][producerCall![1].indexOf('-filter_complex') + 1];
      expect(filterComplex).toContain('drawtext');
      expect(filterComplex).toContain('x=5:y=5:fontsize=20:fontcolor=#ffffff');
    });

    const equalizerStyle = {
      colors: ['#00ff00', '#0000ff'], glowLayers: 5, glowRadius: 20, coreWidth: 2,
      sensitivity: 2.5, smoothing: 0.8, beatBoost: 0.2, bandCount: 24, globalPulse: 12,
    };

    it('passes the equalizer element\'s reactivity fields (sensitivity/smoothing/beatBoost/bandCount) through to PulseVisualizer', async () => {
      const { deps, templateRepository } = buildDeps();
      const equalizerEl = { type: 'equalizer', x: 20, y: 30, width: 200, height: 100, ...equalizerStyle };
      templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [equalizerEl] });
      const manager = new StreamManager(deps as any);

      await manager.start('dest-1', 'playlist-1', undefined, { templateId: 'tpl-1' });

      // bandCount in particular is silent if dropped: PulseVisualizer has its own 56 default, so
      // a template's 24 would just render as 56 with nothing failing.
      expect(PulseVisualizer).toHaveBeenCalledWith(expect.objectContaining({
        sensitivity: 2.5, smoothing: 0.8, beatBoost: 0.2, bandCount: 24,
      }));
    });

    // Unlike the four above, globalPulse is NOT passed through as-is: the template field is a
    // 0-20 knob and PulseVisualizer/PulseEngine take the engine's own strength scale (10 steps
    // per 1.0). Passing the raw 12 through would be clamped to the engine's maximum (2) — every
    // template value from 2 upward would silently read as "maximum".
    it('converts the equalizer element\'s globalPulse (0-20) onto the engine strength scale before it reaches PulseVisualizer', async () => {
      const { deps, templateRepository } = buildDeps();
      const equalizerEl = { type: 'equalizer', x: 20, y: 30, width: 200, height: 100, ...equalizerStyle };
      templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [equalizerEl] });
      const manager = new StreamManager(deps as any);

      await manager.start('dest-1', 'playlist-1', undefined, { templateId: 'tpl-1' });

      expect(PulseVisualizer).toHaveBeenCalledWith(expect.objectContaining({ globalPulse: 1.2 }));
    });

    it('a template globalPulse of 0 reaches PulseVisualizer as exactly 0 (the engine\'s "off" path), and the default 8 as the approved 0.8', async () => {
      for (const [field, expected] of [[0, 0], [8, 0.8]] as const) {
        jest.clearAllMocks();
        const { deps, templateRepository } = buildDeps();
        const equalizerEl = { type: 'equalizer', x: 20, y: 30, width: 200, height: 100, ...equalizerStyle, globalPulse: field };
        templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [equalizerEl] });
        const manager = new StreamManager(deps as any);

        await manager.start('dest-1', 'playlist-1', undefined, { templateId: 'tpl-1' });

        expect(PulseVisualizer).toHaveBeenCalledWith(expect.objectContaining({ globalPulse: expected }));
      }
    });

    // A template saved before globalPulse existed goes through normalizeEqualizerElement on
    // read, which fills in the default — so the stream gets the approved 0.8, not undefined
    // (which PulseEngine would read as 0 = off, a silent regression for every older template).
    it('an equalizer element saved before globalPulse existed streams with the default strength (0.8), not off', async () => {
      const { deps, templateRepository } = buildDeps();
      const { globalPulse, ...legacyStyle } = equalizerStyle;
      const equalizerEl = { type: 'equalizer', x: 20, y: 30, width: 200, height: 100, ...legacyStyle };
      templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [equalizerEl] });
      const manager = new StreamManager(deps as any);

      await manager.start('dest-1', 'playlist-1', undefined, { templateId: 'tpl-1' });

      expect(PulseVisualizer).toHaveBeenCalledWith(expect.objectContaining({ globalPulse: 0.8 }));
    });

    it('passes the template equalizer element position/size through to PersistentEncoder, and its style through to a new PulseVisualizer', async () => {
      const { deps, templateRepository, pipeSpawner } = buildDeps();
      const coverEl = { type: 'cover', x: 0, y: 0, width: 10, height: 10 };
      const equalizerEl = { type: 'equalizer', x: 20, y: 30, width: 200, height: 100, ...equalizerStyle };
      templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [coverEl, equalizerEl] });
      const manager = new StreamManager(deps as any);

      await manager.start('dest-1', 'playlist-1', undefined, { templateId: 'tpl-1' });

      // The equalizer isn't baked into the PNG either — its position/size reach ffmpeg as a
      // pipe:5 input in PersistentEncoder's own args, which only this test suite can observe
      // indirectly via the pipe-spawned encoder's filter_complex arg (mirrors the timer test above).
      expect(renderTemplatePng).toHaveBeenCalledWith(expect.objectContaining({ elements: [coverEl] }));
      const producerCall = (pipeSpawner as jest.Mock).mock.calls.find((call) => call[1].includes('-filter_complex'));
      expect(producerCall).toBeDefined();
      expect(producerCall![1]).toEqual(expect.arrayContaining(['-i', 'pipe:5']));
      const filterComplex = producerCall![1][producerCall![1].indexOf('-filter_complex') + 1];
      expect(filterComplex).toContain('overlay=20:30');
    });

    it('rounds a fractional equalizer x/y/width/height to integers before it reaches ffmpeg args', async () => {
      // PulseVisualizer's raw video pipe declares `-s <width>x<height>`, which (like the old
      // showfreqs `s=` option before it) requires integer dimensions and crashes ffmpeg at
      // filtergraph-build time on a fractional value — a fractional width/height passes template
      // validation (isValidSize has no integer constraint) so StreamManager must round before
      // building the EqualizerConfig it hands to PersistentEncoder.
      const { deps, templateRepository, pipeSpawner } = buildDeps();
      const coverEl = { type: 'cover', x: 0, y: 0, width: 10, height: 10 };
      const equalizerEl = { type: 'equalizer', x: 20.4, y: 30.6, width: 400.5, height: 150.5, ...equalizerStyle };
      templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [coverEl, equalizerEl] });
      const manager = new StreamManager(deps as any);

      await manager.start('dest-1', 'playlist-1', undefined, { templateId: 'tpl-1' });

      const producerCall = (pipeSpawner as jest.Mock).mock.calls.find((call) => call[1].includes('-filter_complex'));
      expect(producerCall).toBeDefined();
      expect(producerCall![1]).toEqual(expect.arrayContaining(['-s', '401x151']));
      const filterComplex = producerCall![1][producerCall![1].indexOf('-filter_complex') + 1];
      expect(filterComplex).toContain('overlay=20:31');
    });

    it('starts successfully with a legacy MVP-shaped equalizer element (bare color string, no colors[]) instead of crashing', async () => {
      // Real templates saved before the neon-pulse rework still carry this exact shape in the
      // database — nothing re-validates stored elements on read, only on write (see
      // normalizeEqualizerElement in templateTypes.ts, which this exercises end to end).
      const { deps, templateRepository, pipeSpawner } = buildDeps();
      const coverEl = { type: 'cover', x: 0, y: 0, width: 10, height: 10 };
      const legacyEqualizerEl = { type: 'equalizer', x: 20, y: 30, width: 200, height: 100, color: '#ec875b' };
      templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [coverEl, legacyEqualizerEl] });
      const manager = new StreamManager(deps as any);

      await expect(manager.start('dest-1', 'playlist-1', undefined, { templateId: 'tpl-1' })).resolves.toBeUndefined();

      const producerCall = (pipeSpawner as jest.Mock).mock.calls.find((call) => call[1].includes('-filter_complex'));
      expect(producerCall).toBeDefined();
      expect(producerCall![1]).toEqual(expect.arrayContaining(['-i', 'pipe:5']));

      // The real regression: without normalization, PulseVisualizer is constructed with
      // colors/glowLayers/glowRadius/coreWidth all undefined, which crashes the whole process on
      // its first render tick (buildPulseSvg's colors.map on undefined) — not observable via the
      // pipe args above, since that crash only happens later, asynchronously, on a timer this
      // synchronous test never advances to. Assert directly on what StreamManager constructed it
      // with instead.
      expect(PulseVisualizer).toHaveBeenCalledWith(expect.objectContaining({
        colors: expect.arrayContaining([expect.stringMatching(/^#/)]),
        glowLayers: expect.any(Number),
        glowRadius: expect.any(Number),
        coreWidth: expect.any(Number),
      }));
    });

    it('passes no equalizer field when the template has none, still composites background+canvas but with no pulse pipe', async () => {
      const { deps, templateRepository, pipeSpawner } = buildDeps();
      const coverEl = { type: 'cover', x: 0, y: 0, width: 10, height: 10 };
      templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [coverEl] });
      const manager = new StreamManager(deps as any);

      await manager.start('dest-1', 'playlist-1', undefined, { templateId: 'tpl-1' });

      const producerCall = (pipeSpawner as jest.Mock).mock.calls[0];
      expect(producerCall[1]).not.toContain('pipe:5');
      expect(producerCall[1]).toEqual(expect.arrayContaining(['-map', '[vcanvas_top]', '-map', '1:a']));
    });

    it('falls back to a blank overlay, without throwing, when the render pool rejects', async () => {
      const { deps } = buildDeps();
      (renderTemplatePng as jest.Mock).mockRejectedValueOnce(new Error('pool exploded'));
      const manager = new StreamManager(deps as any);

      await expect(manager.start('dest-1', 'playlist-1')).resolves.toBeUndefined();
      expect(manager.status('dest-1').state).toBe('streaming');
    });

    it('buildOverlay applies the track overlayOverride color to title/text elements and backgroundColor to the canvas', async () => {
      const { deps, playlistRepository } = buildDeps();
      const titleEl = { type: 'title', x: 0, y: 0, width: 100, fontSize: 20,
        color: { mode: 'solid', color: '#ffffff' },
        style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } };
      const textEl = { type: 'text', x: 0, y: 50, width: 100, fontSize: 20, text: 'hi',
        color: { mode: 'solid', color: '#ffffff' },
        style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } };
      const playlistEl = { type: 'playlist', x: 0, y: 100, width: 100, fontSize: 20,
        color: { mode: 'solid', color: '#ffffff' },
        style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } };
      const override = {
        color: { mode: 'solid', color: '#ff0000' },
        backgroundColor: { mode: 'solid', color: '#000000' },
      };
      playlistRepository.listTracks.mockResolvedValue([
        { name: 'a', audioPath: '/music/a.mp3', coverPath: null, overlayOverride: override },
        { name: 'b', audioPath: '/music/b.mp3', coverPath: null },
      ]);
      deps.templateRepository.findById.mockResolvedValue({
        id: 'tpl-1', userId: 'user-1', elements: [titleEl, textEl, playlistEl],
      });
      const manager = new StreamManager(deps as any);

      await manager.start('dest-1', 'playlist-1', undefined, { templateId: 'tpl-1' });

      expect(renderTemplatePng).toHaveBeenCalledWith(expect.objectContaining({
        elements: [
          { ...titleEl, color: override.color },
          { ...textEl, color: override.color },
          playlistEl,
        ],
        background: override.backgroundColor,
      }));
    });

    it('buildOverlay passes no background and unmodified elements when overlayOverride is null', async () => {
      const { deps, playlistRepository } = buildDeps();
      const titleEl = { type: 'title', x: 0, y: 0, width: 100, fontSize: 20,
        color: { mode: 'solid', color: '#ffffff' },
        style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } };
      playlistRepository.listTracks.mockResolvedValue([
        { name: 'a', audioPath: '/music/a.mp3', coverPath: null, overlayOverride: null },
        { name: 'b', audioPath: '/music/b.mp3', coverPath: null },
      ]);
      deps.templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [titleEl] });
      const manager = new StreamManager(deps as any);

      await manager.start('dest-1', 'playlist-1', undefined, { templateId: 'tpl-1' });

      expect(renderTemplatePng).toHaveBeenCalledWith(expect.objectContaining({
        elements: [titleEl],
        background: undefined,
      }));
    });

    it('buildOverlay resolves image elements to on-disk paths via templateImageService.resolvePath', async () => {
      const { deps, templateImageService } = buildDeps();
      const imageEl = { type: 'image', x: 0, y: 0, width: 100, height: 100, assetId: 'asset-1' };
      deps.templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [imageEl] });
      templateImageService.resolvePath.mockReturnValue('/uploads/user-1/templates/tpl-1/images/asset-1.png');
      const manager = new StreamManager(deps as any);

      await manager.start('dest-1', 'playlist-1', undefined, { templateId: 'tpl-1' });

      expect(templateImageService.resolvePath).toHaveBeenCalledWith('user-1', 'tpl-1', 'asset-1');
      expect(renderTemplatePng).toHaveBeenCalledWith(expect.objectContaining({
        imageAssets: { 'asset-1': '/uploads/user-1/templates/tpl-1/images/asset-1.png' },
      }));
    });

    // resvg (the Satori render path every other 'image' element uses) decodes a GIF to exactly
    // one static frame — SVG has no concept of an animated raster embed. A multi-frame image
    // asset is therefore excluded from the Satori bake entirely and instead composited natively
    // by PersistentEncoder's own filter graph, exactly like the equalizer's showfreqs branch.
    it('excludes an animated (multi-frame) image element from the Satori bake and passes it to PersistentEncoder as a gif overlay instead', async () => {
      const { deps, templateRepository, templateImageService, pipeSpawner } = buildDeps();
      const coverEl = { type: 'cover', x: 0, y: 0, width: 10, height: 10 };
      const gifEl = { type: 'image', x: 900, y: 40, width: 150, height: 150, assetId: 'gif-1' };
      templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [coverEl, gifEl] });
      // Detection/playback must go through the ORIGINAL upload (resolveOriginalPath), never the
      // resolvePath()'d .png — TemplateImageService.upload() already flattened that .png to a
      // single frame via `ffmpeg -frames:v 1`, so probing/looping it could never find more than
      // one frame no matter how the ffmpeg args are built. This is exactly the real bug a live
      // deployed template caught: the gif overlay branch never appeared because the code was
      // (before this fix) probing resolvePath()'s already-flattened file instead of this one.
      templateImageService.resolveOriginalPath.mockResolvedValue('/uploads/user-1/templates/tpl-1/images/gif-1.original.gif');
      (getImageFrameCount as jest.Mock).mockResolvedValue(10);
      const manager = new StreamManager(deps as any);

      await manager.start('dest-1', 'playlist-1', undefined, { templateId: 'tpl-1' });

      expect(templateImageService.resolveOriginalPath).toHaveBeenCalledWith('user-1', 'tpl-1', 'gif-1');
      expect(getImageFrameCount).toHaveBeenCalledWith('/uploads/user-1/templates/tpl-1/images/gif-1.original.gif');
      // Only the static cover element reaches Satori — the gif is dropped from both `elements`
      // and `imageAssets`, or it would be rendered twice (once, wrongly, as a frozen Satori
      // image; once, correctly, as a native ffmpeg overlay).
      expect(renderTemplatePng).toHaveBeenCalledWith(expect.objectContaining({
        elements: [coverEl],
        imageAssets: {},
      }));
      const producerCall = (pipeSpawner as jest.Mock).mock.calls.find((call) => call[1].includes('-filter_complex'));
      expect(producerCall).toBeDefined();
      const filterComplex = producerCall![1][producerCall![1].indexOf('-filter_complex') + 1];
      expect(filterComplex).toContain('loop=loop=-1:size=10,fps=30,scale=150:150');
      expect(filterComplex).toContain('overlay=900:40');
    });

    it('rounds a fractional gif-overlay x/y/width/height to integers before it reaches ffmpeg args', async () => {
      // Same reasoning as the equalizer's own rounding fix: ffmpeg's `scale=` requires integer
      // dimensions, and isValidSize doesn't enforce integers for 'image' elements.
      const { deps, templateRepository, templateImageService, pipeSpawner } = buildDeps();
      const gifEl = { type: 'image', x: 20.4, y: 30.6, width: 400.5, height: 150.5, assetId: 'gif-1' };
      templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [gifEl] });
      templateImageService.resolveOriginalPath.mockResolvedValue('/uploads/user-1/templates/tpl-1/images/gif-1.original.gif');
      (getImageFrameCount as jest.Mock).mockResolvedValue(6);
      const manager = new StreamManager(deps as any);

      await manager.start('dest-1', 'playlist-1', undefined, { templateId: 'tpl-1' });

      const producerCall = (pipeSpawner as jest.Mock).mock.calls.find((call) => call[1].includes('-filter_complex'));
      expect(producerCall).toBeDefined();
      const filterComplex = producerCall![1][producerCall![1].indexOf('-filter_complex') + 1];
      expect(filterComplex).toContain('loop=loop=-1:size=6,fps=30,scale=401:151');
      expect(filterComplex).toContain('overlay=20:31');
    });

    it('does not add a gif-loop stage when every image element is static (background+canvas compositing still happens)', async () => {
      const { deps, templateRepository, templateImageService, pipeSpawner } = buildDeps();
      const imageEl = { type: 'image', x: 0, y: 0, width: 100, height: 100, assetId: 'asset-1' };
      templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [imageEl] });
      templateImageService.resolvePath.mockReturnValue('/uploads/user-1/templates/tpl-1/images/asset-1.png');
      // A real original DOES exist on disk (unlike the "predates this feature" case, which
      // resolveOriginalPath's own null-default already covers) — it's just genuinely a 1-frame
      // (static) image, so ffprobe reporting 1 frame must still suppress the gif-overlay branch.
      templateImageService.resolveOriginalPath.mockResolvedValue('/uploads/user-1/templates/tpl-1/images/asset-1.original.png');
      // jest.mock's module-level mock isn't reset between tests in this file — reassert the
      // "static" default explicitly rather than relying on it not having been overridden by an
      // earlier test in this same describe block.
      (getImageFrameCount as jest.Mock).mockResolvedValue(1);
      const manager = new StreamManager(deps as any);

      await manager.start('dest-1', 'playlist-1', undefined, { templateId: 'tpl-1' });

      const producerCall = (pipeSpawner as jest.Mock).mock.calls.find((call) => call[1].includes('-filter_complex'));
      expect(producerCall).toBeDefined();
      const filterComplex = producerCall![1][producerCall![1].indexOf('-filter_complex') + 1];
      expect(filterComplex).not.toContain('loop=loop=-1');
    });
  });

  it('playByName() finds a track across ALL of the owning user\'s tracks, not just the current playlist', async () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any);
    await manager.start('dest-1', 'playlist-1');

    expect(() => manager.playByName('dest-1', 'c')).not.toThrow();
  });

  it('playByName() carries a track\'s overlayOverride through to LibraryLike.findByName\'s result (allUserTracks must not strip it)', async () => {
    const { deps, trackRepository } = buildDeps();
    trackRepository.listByUser.mockResolvedValue([
      { name: 'a', audioPath: '/music/a.mp3', coverPath: null, overlayOverride: null },
      { name: 'b', audioPath: '/music/b.mp3', coverPath: null, overlayOverride: null },
      { name: 'c', audioPath: '/music/c.mp3', coverPath: null, overlayOverride: { color: { mode: 'solid', color: '#ff0000' } } },
    ]);
    const manager = new StreamManager(deps as any);
    await manager.start('dest-1', 'playlist-1');

    const insertNextSpy = jest.spyOn(PlaylistQueue.prototype, 'insertNext');
    manager.playByName('dest-1', 'c');

    expect(insertNextSpy).toHaveBeenCalledWith(expect.objectContaining({
      name: 'c',
      overlayOverride: { color: { mode: 'solid', color: '#ff0000' } },
    }));
    insertNextSpy.mockRestore();
  });

  describe('YouTube-backed destinations (a provider that returns a lifecycle)', () => {
    function withYoutubeDestination(deps: ReturnType<typeof buildDeps>['deps'], destinationRepository: ReturnType<typeof buildDeps>['destinationRepository']) {
      destinationRepository.findById.mockResolvedValue({ id: 'dest-1', userId: 'user-1', provider: 'youtube' });
      return deps;
    }

    it('calls lifecycle.onPushStarted() after the controller starts, and status() includes the provider phase', async () => {
      const { deps, destinationRepository, youtubeLifecycle } = buildDeps();
      const manager = new StreamManager(withYoutubeDestination(deps as any, destinationRepository) as any);

      await manager.start('dest-1', 'playlist-1');

      expect(youtubeLifecycle.onPushStarted).toHaveBeenCalledTimes(1);
      expect(manager.status('dest-1').provider).toEqual({ type: 'youtube', phase: 'waitingForYoutube', watchUrl: 'https://www.youtube.com/watch?v=broadcast-1' });
    });

    it('stop() finalizes the lifecycle', async () => {
      const { deps, destinationRepository, youtubeLifecycle } = buildDeps();
      const manager = new StreamManager(withYoutubeDestination(deps as any, destinationRepository) as any);
      await manager.start('dest-1', 'playlist-1');

      await manager.stop('dest-1');

      expect(youtubeLifecycle.finalize).toHaveBeenCalledTimes(1);
      expect(manager.status('dest-1').provider).toBeUndefined();
    });

    // Grabs the same onExit callback the "onError hook" tests below trigger directly to simulate
    // the persistent encoder's ffmpeg dying unexpectedly — see the comment at its original call
    // site (kept here since every test in this block needs it).
    function grabEncoderOnExit(pipeSpawner: jest.Mock, index = 0): (code: number | null) => void {
      const encoderChild = pipeSpawner.mock.results[index].value;
      return encoderChild.once.mock.calls.find((call: any[]) => call[0] === 'exit')?.[1];
    }

    it('an unexpected pusher exit against a destination whose lifecycle is already in a terminal phase finalizes immediately via the onError hook, instead of retrying', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const { deps, destinationRepository, youtubeLifecycle, pipeSpawner } = buildDeps() as any;
      // Simulates the destination's YouTube side already being confirmed dead (e.g. the
      // health-check timeout already ran) at the moment the local encoder also dies — the
      // reconnectPolicy's terminal-phase veto must refuse to retry regardless of uptime.
      youtubeLifecycle.phase.mockReturnValue('error');
      const manager = new StreamManager(withYoutubeDestination(deps as any, destinationRepository) as any);
      await manager.start('dest-1', 'playlist-1');

      const onExit = grabEncoderOnExit(pipeSpawner);
      onExit(1);

      expect(manager.status('dest-1').state).toBe('error');
      expect(youtubeLifecycle.finalize).toHaveBeenCalledTimes(1);
      // Previously silent — an operator had nothing in the app's own logs pointing at which
      // destination died or why, only ffmpeg's raw stderr to reverse-engineer it from.
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('dest-1: persistent encoder exited unexpectedly (code=1)'));
      errorSpy.mockRestore();
    });

    it('an unexpected pusher exit against a destination whose lifecycle has seen an auth-class error finalizes immediately, without retrying', async () => {
      const { deps, destinationRepository, youtubeLifecycle, pipeSpawner } = buildDeps() as any;
      youtubeLifecycle.phase.mockReturnValue('waitingForYoutube');
      youtubeLifecycle.isAuthError = jest.fn().mockReturnValue(true);
      const manager = new StreamManager(withYoutubeDestination(deps as any, destinationRepository) as any);
      await manager.start('dest-1', 'playlist-1');

      const onExit = grabEncoderOnExit(pipeSpawner);
      onExit(1);

      expect(manager.status('dest-1').state).toBe('error');
      expect(youtubeLifecycle.finalize).toHaveBeenCalledTimes(1);
    });

    it('an unexpected pusher exit against a destination with a healthy (non-terminal) lifecycle schedules a reconnect instead of immediately finalizing', async () => {
      const { deps, destinationRepository, youtubeLifecycle, pipeSpawner } = buildDeps() as any;
      // Default fakeLifecycle() phase is 'waitingForYoutube' — not terminal.
      const manager = new StreamManager(withYoutubeDestination(deps as any, destinationRepository) as any);
      await manager.start('dest-1', 'playlist-1');

      const onExit = grabEncoderOnExit(pipeSpawner);
      onExit(1);

      expect(manager.status('dest-1').state).toBe('reconnecting');
      expect(youtubeLifecycle.finalize).not.toHaveBeenCalled();
    });

    it('the lifecycle phase-change handler stops the owning controller once the phase becomes a terminal failure (e.g. the health-check timeout), instead of leaving it pushing to a dead ingest', async () => {
      const { deps, destinationRepository, youtubeLifecycle } = buildDeps();
      const manager = new StreamManager(withYoutubeDestination(deps as any, destinationRepository) as any);
      await manager.start('dest-1', 'playlist-1');
      expect(manager.status('dest-1').state).toBe('streaming');

      const registeredCallback = youtubeLifecycle.onPhaseChange.mock.calls[0][0];
      youtubeLifecycle.phase.mockReturnValue('error');
      registeredCallback();

      expect(manager.get('dest-1')).toBeUndefined();
      expect(manager.status('dest-1').state).toBe('idle');
    });

    it('the phase-change handler does nothing to the controller when the phase is still a normal, non-terminal one', async () => {
      const { deps, destinationRepository, youtubeLifecycle } = buildDeps();
      const manager = new StreamManager(withYoutubeDestination(deps as any, destinationRepository) as any);
      await manager.start('dest-1', 'playlist-1');

      const registeredCallback = youtubeLifecycle.onPhaseChange.mock.calls[0][0];
      youtubeLifecycle.phase.mockReturnValue('live');
      registeredCallback();

      expect(manager.get('dest-1')).toBeDefined();
      expect(manager.status('dest-1').state).toBe('streaming');
    });
  });

  it('is an EventEmitter that emits statusChanged for a custom destination on pause/stop', async () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any);
    await manager.start('dest-1', 'playlist-1');
    const listener = jest.fn();
    manager.on('statusChanged', listener);

    manager.pause('dest-1');
    expect(listener).toHaveBeenCalledWith('dest-1');

    await manager.stop('dest-1');
    expect(listener).toHaveBeenCalledWith('dest-1');
  });

  it('emits statusChanged when a YouTube destination\'s lifecycle phase changes', async () => {
    const { deps, destinationRepository, youtubeLifecycle } = buildDeps();
    destinationRepository.findById.mockResolvedValue({ id: 'dest-1', userId: 'user-1', provider: 'youtube' });
    const manager = new StreamManager(deps as any);
    const listener = jest.fn();
    manager.on('statusChanged', listener);

    await manager.start('dest-1', 'playlist-1');

    // youtubeLifecycle is the fakeLifecycle() from this file's existing YouTube-destination
    // fixture — onPhaseChange must have been registered with a callback that, when invoked,
    // emits statusChanged for this destination.
    expect(youtubeLifecycle.onPhaseChange).toHaveBeenCalled();
    const registeredCallback = youtubeLifecycle.onPhaseChange.mock.calls[0][0];
    listener.mockClear();
    registeredCallback();
    expect(listener).toHaveBeenCalledWith('dest-1');
  });
});
