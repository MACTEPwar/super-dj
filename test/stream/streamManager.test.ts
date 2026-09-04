jest.mock('../../src/ffmpeg/duration', () => ({
  getAudioDurationSeconds: jest.fn().mockResolvedValue(100),
}));
jest.mock('../../src/render/renderOverlay', () => ({
  renderTemplatePng: jest.fn().mockResolvedValue(Buffer.from('fake-png')),
}));

import { PassThrough } from 'stream';
import { StreamManager } from '../../src/stream/streamManager';
import { ApiError } from '../../src/errors';
import { renderTemplatePng } from '../../src/render/renderOverlay';
import { DEFAULT_TEMPLATE_ELEMENTS } from '../../src/templates/templateTypes';
import { PlaylistQueue } from '../../src/playlist/queue';

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
  });
  const templateRepository = { findById: jest.fn() };
  const templateImageService = { resolvePath: jest.fn().mockReturnValue('/uploads/user-1/templates/tpl-1/images/asset-1.png') };
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

    it('an unexpected pusher exit finalizes the lifecycle via the onError hook', async () => {
      const { deps, destinationRepository, youtubeLifecycle, pipeSpawner } = buildDeps() as any;
      const manager = new StreamManager(withYoutubeDestination(deps as any, destinationRepository) as any);
      await manager.start('dest-1', 'playlist-1');

      // StreamController.start() calls createPersistentEncoder().start(...) — which spawns the
      // encoder's ffmpeg via pipeSpawner — before anything else touches the regular spawner
      // (feeding a track's AudioRelay/CanvasFeeder calls). PersistentEncoder.start() registers
      // `child.once('exit', onExitCallback)` — grab that same callback and invoke it directly to
      // simulate the persistent encoder's ffmpeg dying unexpectedly.
      const encoderChild = pipeSpawner.mock.results[0].value;
      const onExit = encoderChild.once.mock.calls.find((call: any[]) => call[0] === 'exit')?.[1];
      onExit(1);

      expect(youtubeLifecycle.finalize).toHaveBeenCalledTimes(1);
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
