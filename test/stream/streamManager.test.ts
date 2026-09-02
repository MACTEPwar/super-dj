jest.mock('../../src/ffmpeg/fifo', () => ({
  createFifo: jest.fn(),
  removeFifo: jest.fn(),
}));
jest.mock('../../src/ffmpeg/duration', () => ({
  getAudioDurationSeconds: jest.fn().mockResolvedValue(100),
}));

import { PassThrough } from 'stream';
import { StreamManager } from '../../src/stream/streamManager';
import { ApiError } from '../../src/errors';

function fakeChild() {
  return { pid: 1, stdout: null, stderr: null, kill: jest.fn(), once: jest.fn() };
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
  const spawner = jest.fn().mockReturnValue(fakeChild());
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
  // SegmentFeeder opens a real fs.createWriteStream on the fifo path unless overridden;
  // fake it so start()/tests never touch the real filesystem (same rationale as the
  // fifo/duration module mocks above — no real fs/subprocess touches in a unit test).
  const createWriteStream = jest.fn().mockImplementation(() => new PassThrough());
  return {
    deps: {
      spawner, fifoDir: '/tmp', defaultCoverPath: '/assets/default.png', backgroundImagePath: '/assets/bg.png',
      fontFile: '/fonts/x.ttf', playlistRepository, destinationRepository, trackRepository,
      providers: { custom: customProvider, youtube: youtubeProvider }, createWriteStream,
    },
    destinationRepository, playlistRepository, trackRepository, createWriteStream, customProvider, youtubeProvider, youtubeLifecycle, spawner,
  };
}

describe('StreamManager', () => {
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
    const { deps, createWriteStream } = buildDeps();
    const manager = new StreamManager(deps as any);

    await manager.start('dest-1', 'playlist-1');

    expect(manager.get('dest-1')).toBeDefined();
    expect(manager.status('dest-1').state).toBe('streaming');
    expect(manager.status('dest-1').currentTrack).toBe('a');
    expect(createWriteStream).toHaveBeenCalledWith('/tmp/super-dj-stream-dest-1.fifo');
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
    const crashed = { status: () => ({ state: 'error', currentTrack: null, nextTrack: null }) };
    (manager as any).controllers.set('dest-1', crashed);

    await expect(manager.start('dest-1', 'playlist-1')).resolves.toBeUndefined();

    expect(manager.get('dest-1')).toBeDefined();
    expect(manager.get('dest-1')).not.toBe(crashed);
    expect(manager.status('dest-1').state).toBe('streaming');
  });

  it('start() finalizes a stale lifecycle left behind by a crashed controller instead of dropping it', async () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any);
    const crashed = { status: () => ({ state: 'error', currentTrack: null, nextTrack: null }) };
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

  it('playByName() finds a track across ALL of the owning user\'s tracks, not just the current playlist', async () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any);
    await manager.start('dest-1', 'playlist-1');

    expect(() => manager.playByName('dest-1', 'c')).not.toThrow();
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
      const { deps, destinationRepository, youtubeLifecycle, spawner } = buildDeps() as any;
      const manager = new StreamManager(withYoutubeDestination(deps as any, destinationRepository) as any);
      await manager.start('dest-1', 'playlist-1');

      // StreamController.start() calls createRtmpPusher().start(...) — which spawns the pusher's
      // ffmpeg — BEFORE it ever feeds a track (which spawns the segment feeder's producer ffmpeg).
      // So the pusher's child is always the FIRST spawner() call, regardless of how many segments
      // get fed afterward. RtmpPusher.start() registers `child.once('exit', onExitCallback)` — grab
      // that same callback and invoke it directly to simulate the pusher's ffmpeg dying unexpectedly.
      const pusherChild = spawner.mock.results[0].value;
      const onExit = pusherChild.once.mock.calls.find((call: any[]) => call[0] === 'exit')?.[1];
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
