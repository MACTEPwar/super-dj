import { StreamDestination } from '@prisma/client';
import { LocalStreamManager } from '../../src/stream/localStreamManager';
import { LocalRelaySession } from '../../src/stream/localRelayTarget';
import { ApiError } from '../../src/errors';
import { Track } from '../../src/playlist/types';

const TOKEN = 'c'.repeat(32);

function relaySession(userId: string, token = TOKEN): LocalRelaySession {
  return {
    userId,
    pathToken: token,
    path: `live/${token}`,
    publishSecret: 'pub-secret',
    readSecret: 'read-secret',
    publishRtmpUrl: 'rtmp://mediamtx:1935/live',
    publishStreamKey: `${token}?user=pub&pass=pub-secret`,
    readRtmpUrl: `rtmp://mediamtx:1935/live/${token}?user=sub&pass=read-secret`,
    hlsBaseUrl: `http://mediamtx:8888/live/${token}`,
    readAuthorization: 'Basic c3ViOnJlYWQtc2VjcmV0',
  };
}

function fakeScene() {
  const encoderChild = { videoPipe: {}, audioPipe: {}, pulsePipe: {}, aboveCanvasPipe: {} };
  const encoder = { start: jest.fn().mockReturnValue(encoderChild), stop: jest.fn() };
  const canvasFeeder = { attach: jest.fn(), render: jest.fn().mockResolvedValue(undefined), close: jest.fn() };
  const audioRelay = {
    attach: jest.fn(), attachTap: jest.fn(), close: jest.fn(), stopCurrent: jest.fn(),
    switchToSilence: jest.fn(() => ({ once: jest.fn() })),
    switchTrack: jest.fn(() => ({ once: jest.fn() })),
  };
  const tracks = [
    { name: 'a', audioPath: '/music/a.mp3', coverPath: null },
    { name: 'b', audioPath: '/music/b.mp3', coverPath: null },
  ];
  const createPersistentEncoder = jest.fn().mockReturnValue(encoder);
  const scene = {
    playlistName: 'Mix',
    tracks,
    library: { list: () => tracks, findByName: (n: string) => tracks.find((t) => t.name === n) },
    buildOverlay: jest.fn().mockResolvedValue({ durationSeconds: 100, overlayPng: Buffer.from('png'), timer: null }),
    createCanvasFeeder: () => canvasFeeder,
    createAudioRelay: () => audioRelay,
    createPersistentEncoder,
    createPulseVisualizer: undefined,
  };
  return { scene, encoder, canvasFeeder, audioRelay, createPersistentEncoder };
}

function destinationRow(overrides: Partial<StreamDestination> = {}): StreamDestination {
  return {
    id: 'dest-1', userId: 'user-1', name: 'Twitch', rtmpUrl: 'rtmp://live.twitch.tv/app',
    streamKeyEncrypted: null, provider: 'custom', youtubeLiveStreamId: null, createdAt: new Date(),
    ...overrides,
  };
}

function buildManager(overrides: Partial<Record<string, unknown>> = {}) {
  const parts = fakeScene();
  const buildScene = jest.fn().mockResolvedValue(parts.scene);
  const relayTarget = { create: jest.fn((userId: string) => relaySession(userId)) };
  const authRegistry = { register: jest.fn(), unregister: jest.fn() };
  const rows = new Map<string, StreamDestination>([['dest-1', destinationRow()]]);
  const destinationRepository = { findById: jest.fn(async (id: string) => rows.get(id) ?? null) };
  const prepareSession = jest.fn().mockResolvedValue({ rtmpUrl: 'rtmp://live.twitch.tv/app', streamKey: 'key' });
  const relays: { start: jest.Mock; stop: jest.Mock }[] = [];
  const createRelay = jest.fn(() => {
    const relay = { start: jest.fn(), stop: jest.fn() };
    relays.push(relay);
    return relay;
  });
  const manager = new LocalStreamManager({
    sceneDeps: { spawner: jest.fn() } as never,
    relayTarget,
    authRegistry,
    destinationRepository,
    providers: { custom: { prepareSession } },
    maxConcurrentStreams: 10,
    maxSessionDurationMs: 12 * 60 * 60 * 1000,
    buildScene,
    createRelay,
    ...overrides,
  } as never);
  return { manager, buildScene, relayTarget, authRegistry, destinationRepository, prepareSession, createRelay, relays, rows, ...parts };
}

// Everything the loop below awaits is already resolved; one macrotask hop lets every queued
// reconcile pass settle without reaching for fake timers.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('LocalStreamManager.start', () => {
  it('builds the scene for the calling user and starts a controller in the streaming state', async () => {
    const { manager, buildScene } = buildManager();
    await manager.start('user-1', 'playlist-1', { templateId: 'tpl-1' });
    expect(buildScene).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: 'user-1', playlistId: 'playlist-1', templateId: 'tpl-1', sceneId: 'user-1',
    }));
    expect(manager.status('user-1').local.state).toBe('streaming');
  });

  // The whole premise of the rework: the encoder pushes into MediaMTX, never at a real platform.
  it('points the encoder at the minted MediaMTX publish URL', async () => {
    const { manager, createPersistentEncoder } = buildManager();
    await manager.start('user-1', 'playlist-1');
    expect(createPersistentEncoder).toHaveBeenCalledWith({
      rtmpUrl: 'rtmp://mediamtx:1935/live',
      streamKey: `${TOKEN}?user=pub&pass=pub-secret`,
    });
  });

  it('registers the session credentials before the encoder can connect', async () => {
    const { manager, authRegistry, encoder } = buildManager();
    await manager.start('user-1', 'playlist-1');
    expect(authRegistry.register).toHaveBeenCalledWith(expect.objectContaining({ path: `live/${TOKEN}` }));
    expect(authRegistry.register.mock.invocationCallOrder[0]).toBeLessThan(encoder.start.mock.invocationCallOrder[0]);
  });

  it('rejects with 409 when this user already has an active stream', async () => {
    const { manager } = buildManager();
    await manager.start('user-1', 'playlist-1');
    await expect(manager.start('user-1', 'playlist-2')).rejects.toThrow(ApiError);
    await expect(manager.start('user-1', 'playlist-2')).rejects.toThrow('a local stream is already active');
  });

  it('rejects a second concurrent start for the same user before either registers, without leaking a pipeline', async () => {
    const { manager, buildScene } = buildManager();
    let resolveScene!: (scene: unknown) => void;
    buildScene.mockImplementation(() => new Promise((resolve) => { resolveScene = resolve; }));
    const first = manager.start('user-1', 'playlist-1');
    await expect(manager.start('user-1', 'playlist-1')).rejects.toThrow('a local stream is already starting');
    resolveScene(fakeScene().scene);
    await first;
  });

  it('rejects with 429 once the per-host cap is reached, and frees a slot again on stop', async () => {
    const { manager } = buildManager({ maxConcurrentStreams: 2 });
    await manager.start('user-1', 'playlist-1');
    await manager.start('user-2', 'playlist-1');
    await expect(manager.start('user-3', 'playlist-1')).rejects.toThrow('too many local streams');
    await manager.stop('user-1');
    await expect(manager.start('user-3', 'playlist-1')).resolves.toBeUndefined();
  });

  it('does not hold a slot or register credentials when the scene fails to build', async () => {
    const { manager, buildScene, authRegistry } = buildManager({ maxConcurrentStreams: 1 });
    buildScene.mockRejectedValueOnce(new ApiError(404, 'playlist not found'));
    await expect(manager.start('user-1', 'playlist-1')).rejects.toThrow('playlist not found');
    expect(authRegistry.register).not.toHaveBeenCalled();
    await expect(manager.start('user-2', 'playlist-1')).resolves.toBeUndefined();
  });

  // StreamController.start() rejects an empty library before spawning anything at all (an early
  // guard) — nothing was ever running, so there is nothing to stop().
  it('unregisters the path when the controller rejects before spawning anything (empty library)', async () => {
    const { manager, authRegistry, scene } = buildManager();
    scene.library.list = () => [];
    await expect(manager.start('user-1', 'playlist-1')).rejects.toThrow('library is empty');
    expect(authRegistry.unregister).toHaveBeenCalledWith(`live/${TOKEN}`);
    expect(manager.status('user-1').local.state).toBe('idle');
  });

  // Distinct from the case above: here the library is non-empty, so StreamController.start()
  // spawns the encoder/CanvasFeeder/AudioRelay pipeline BEFORE the first track's overlay build
  // rejects (buildOverlay is only awaited after the pipeline is already running). Without an
  // explicit controller.stop() in this catch, the ffmpeg encoder and CanvasFeeder's 200ms
  // heartbeat would keep running forever as a genuine orphan — its MediaMTX credentials get
  // revoked by discard() right below while it is still connected and publishing.
  it('stops an already-spawned pipeline when the first track fails to build its overlay', async () => {
    const { manager, authRegistry, encoder, canvasFeeder, scene } = buildManager();
    (scene.buildOverlay as jest.Mock).mockRejectedValue(new Error('boom'));
    await expect(manager.start('user-1', 'playlist-1')).rejects.toThrow('boom');
    expect(encoder.stop).toHaveBeenCalled();
    expect(canvasFeeder.close).toHaveBeenCalled();
    expect(authRegistry.unregister).toHaveBeenCalledWith(`live/${TOKEN}`);
    expect(manager.status('user-1').local.state).toBe('idle');
  });
});

describe('LocalStreamManager lifecycle and status', () => {
  it('reports idle with nulls for a user who has never streamed', () => {
    const { manager } = buildManager();
    expect(manager.status('nobody')).toEqual({
      local: {
        state: 'idle', currentTrack: null, nextTrack: null,
        previewReady: false, playlistId: null, templateId: null, startedAt: null,
      },
      destinations: [],
    });
  });

  it('reports the playlist, template and start time of a running stream, and marks the preview ready', async () => {
    const { manager } = buildManager();
    await manager.start('user-1', 'playlist-1', { templateId: 'tpl-1' });
    const status = manager.status('user-1');
    expect(status.local).toEqual(expect.objectContaining({
      state: 'streaming', currentTrack: 'a', nextTrack: 'b',
      previewReady: true, playlistId: 'playlist-1', templateId: 'tpl-1',
    }));
    expect(Date.parse(status.local.startedAt!)).not.toBeNaN();
  });

  // Pause never stops the local publish — only the audio changes — so the preview stays watchable.
  it('keeps the preview ready while paused', async () => {
    const { manager } = buildManager();
    await manager.start('user-1', 'playlist-1');
    manager.pause('user-1');
    expect(manager.status('user-1').local).toEqual(expect.objectContaining({ state: 'paused', previewReady: true }));
  });

  it('exposes the preview target only while a stream is running', async () => {
    const { manager } = buildManager();
    expect(manager.previewTarget('user-1')).toBeNull();
    await manager.start('user-1', 'playlist-1');
    expect(manager.previewTarget('user-1')).toEqual({
      hlsBaseUrl: `http://mediamtx:8888/live/${TOKEN}`,
      authorization: 'Basic c3ViOnJlYWQtc2VjcmV0',
    });
    await manager.stop('user-1');
    expect(manager.previewTarget('user-1')).toBeNull();
  });

  it('revokes the MediaMTX credentials on stop', async () => {
    const { manager, authRegistry, encoder } = buildManager();
    await manager.start('user-1', 'playlist-1');
    await manager.stop('user-1');
    expect(encoder.stop).toHaveBeenCalled();
    expect(authRegistry.unregister).toHaveBeenCalledWith(`live/${TOKEN}`);
    expect(manager.status('user-1').local.state).toBe('idle');
  });

  it('throws 409 for every command when the user has no active stream', async () => {
    const { manager } = buildManager();
    await expect(manager.stop('user-1')).rejects.toThrow('local stream is not active');
    expect(() => manager.pause('user-1')).toThrow('local stream is not active');
    await expect(manager.resume('user-1')).rejects.toThrow('local stream is not active');
    await expect(manager.next('user-1')).rejects.toThrow('local stream is not active');
    await expect(manager.previous('user-1')).rejects.toThrow('local stream is not active');
    expect(() => manager.playByName('user-1', 'a')).toThrow('local stream is not active');
  });

  it('delegates pause/resume/next/previous/playByName to this user\'s own controller', async () => {
    const { manager, audioRelay, scene } = buildManager();
    await manager.start('user-1', 'playlist-1');
    manager.pause('user-1');
    expect(audioRelay.switchToSilence).toHaveBeenCalled();
    await manager.resume('user-1');
    await manager.next('user-1');
    expect(audioRelay.switchTrack).toHaveBeenLastCalledWith('/music/b.mp3', 0);
    manager.playByName('user-1', 'a');
    expect(scene.buildOverlay).toHaveBeenCalled();
  });

  it('delegates insertEphemeralTrack to this user\'s own controller, and it plays on the next advance', async () => {
    const { manager, audioRelay } = buildManager();
    await manager.start('user-1', 'playlist-1');
    const ephemeralTrack: Track = { name: 'donation track', audioPath: '/tmp/donation.mp3', coverPath: null };

    manager.insertEphemeralTrack('user-1', ephemeralTrack);
    await manager.next('user-1');

    expect(audioRelay.switchTrack).toHaveBeenLastCalledWith('/tmp/donation.mp3', 0);
  });

  it('insertEphemeralTrack throws when no local stream is active for that user', () => {
    const { manager } = buildManager();
    const ephemeralTrack: Track = { name: 'donation track', audioPath: '/tmp/donation.mp3', coverPath: null };
    expect(() => manager.insertEphemeralTrack('user-1', ephemeralTrack)).toThrow('local stream is not active');
  });

  it('emits statusChanged with the userId whenever that user\'s controller changes state', async () => {
    const { manager } = buildManager();
    const listener = jest.fn();
    manager.on('statusChanged', listener);
    await manager.start('user-1', 'playlist-1');
    expect(listener).toHaveBeenCalledWith('user-1');
  });

  // Spec open question #7: an unwatched local stream still costs a full encode, so it cannot run
  // forever. No viewer-based idle timeout — MediaMTX's control API is the only viewer signal and
  // Layer 0 keeps it disabled.
  it('stops a stream that has run past the maximum session duration', async () => {
    jest.useFakeTimers();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { manager, authRegistry, encoder } = buildManager({ maxSessionDurationMs: 60_000 });
      await manager.start('user-1', 'playlist-1');
      await jest.advanceTimersByTimeAsync(60_000);
      expect(encoder.stop).toHaveBeenCalled();
      expect(authRegistry.unregister).toHaveBeenCalledWith(`live/${TOKEN}`);
      expect(manager.status('user-1').local.state).toBe('idle');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('maximum session duration'));
    } finally {
      warnSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('cancels the duration timer when the stream is stopped first', async () => {
    jest.useFakeTimers();
    try {
      const { manager, encoder } = buildManager({ maxSessionDurationMs: 60_000 });
      await manager.start('user-1', 'playlist-1');
      await manager.stop('user-1');
      encoder.stop.mockClear();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(encoder.stop).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  // createReconnectPolicy() only gives up after CRASH_LOOP_THRESHOLD (2) CONSECUTIVE short-lived
  // (<10s uptime) failures — a single exit schedules a respawn ('reconnecting'), it does not go
  // straight to 'error'. See reconnectPolicy.ts and test/stream/streamManager.test.ts's own
  // "an unexpected pusher exit ... also schedules a reconnect" test for the same mechanism this
  // one relies on: LocalStreamManager passes no isRetryableDestination veto (there is no
  // destination at this layer), so the decision is purely this uptime/crash-loop bookkeeping.
  it('revokes credentials only once two consecutive short-lived failures exhaust the reconnect budget, and lets start() recover from that state', async () => {
    jest.useFakeTimers();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { manager, authRegistry, encoder, scene } = buildManager();
      await manager.start('user-1', 'playlist-1');

      const firstExit = encoder.start.mock.calls[0][0] as (code: number | null) => void;
      firstExit(1);
      expect(manager.status('user-1').local.state).toBe('reconnecting');
      expect(authRegistry.unregister).not.toHaveBeenCalled();
      // A pending respawn still needs the credentials it's about to reconnect with.
      expect(manager.previewTarget('user-1')).not.toBeNull();

      // The respawned encoder's first overlay build is deliberately left PENDING, because that is
      // the real ordering of a genuine crash loop: ffmpeg dies at startup within tens of ms, while
      // the first feed's ffprobe + Satori render takes hundreds. It is load-bearing here, not
      // decoration — StreamController.performReconnect() clears its reconnect bookkeeping (see its
      // "A full recovery" comment) only once that first feed RESOLVES, so a respawn whose feed had
      // already completed would have reset consecutiveShortLivedFailures back to 0 and the exit
      // below would schedule a third retry instead of hitting CRASH_LOOP_THRESHOLD. Only this
      // next call is stubbed, so the recovery start() at the end of the test still works normally.
      (scene.buildOverlay as jest.Mock).mockImplementationOnce(() => new Promise(() => {}));
      // Let the scheduled respawn fire (backoff is 2s +/- 20% jitter; 3s clears the jittered max).
      await jest.advanceTimersByTimeAsync(3000);
      expect(encoder.start).toHaveBeenCalledTimes(2);

      // A second consecutive short-lived exit hits CRASH_LOOP_THRESHOLD: the policy gives up.
      const secondExit = encoder.start.mock.calls[1][0] as (code: number | null) => void;
      secondExit(1);
      expect(manager.status('user-1').local.state).toBe('error');
      expect(manager.previewTarget('user-1')).toBeNull();
      expect(authRegistry.unregister).toHaveBeenCalledWith(`live/${TOKEN}`);

      await expect(manager.start('user-1', 'playlist-1')).resolves.toBeUndefined();
      expect(manager.status('user-1').local.state).toBe('streaming');
    } finally {
      errorSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  // The capacity check reads `streams.size`, which only grows AFTER buildScene's await — so two
  // concurrent start() calls for two DIFFERENT users must not both slip through it. Guards against
  // the race in LocalStreamManager.start()'s "Synchronous check-and-reserve" comment.
  it('does not let two concurrent starts from different users both slip past the concurrency cap', async () => {
    const { manager, buildScene } = buildManager({ maxConcurrentStreams: 1 });
    let releaseFirst!: () => void;
    buildScene.mockImplementationOnce(() => new Promise((resolve) => {
      releaseFirst = () => resolve(fakeScene().scene);
    }));
    const first = manager.start('user-1', 'playlist-1');
    // user-1's start() is now suspended inside buildScene's await, having already reserved its
    // slot in `starting` synchronously before that await — user-2 must see that reservation.
    await expect(manager.start('user-2', 'playlist-1')).rejects.toThrow('too many local streams');
    releaseFirst();
    await first;
    expect(manager.status('user-1').local.state).toBe('streaming');
  });

  // A stream stuck in 'error' has already stopped costing real CPU (its encoder is dead), so it
  // must not permanently pin a concurrency slot with no way to evict it — Layer 0 disables the
  // control API that a viewer-count-based eviction would otherwise use. Reaches 'error' via the
  // same two-consecutive-short-lived-failures path as the reconnect test above.
  it('does not let a stream stuck in the error state pin a concurrency slot forever', async () => {
    jest.useFakeTimers();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { manager, encoder, scene } = buildManager({ maxConcurrentStreams: 1 });
      await manager.start('user-1', 'playlist-1');

      (encoder.start.mock.calls[0][0] as (code: number | null) => void)(1);
      // Same pending-first-feed stub as the reconnect test above, and for the same reason: the
      // respawned encoder has to die before performReconnect() resets the crash-loop counter.
      (scene.buildOverlay as jest.Mock).mockImplementationOnce(() => new Promise(() => {}));
      await jest.advanceTimersByTimeAsync(3000);
      (encoder.start.mock.calls[1][0] as (code: number | null) => void)(1);
      expect(manager.status('user-1').local.state).toBe('error');

      await expect(manager.start('user-2', 'playlist-1')).resolves.toBeUndefined();
    } finally {
      errorSpy.mockRestore();
      jest.useRealTimers();
    }
  });
});

describe('LocalStreamManager — destination forwards', () => {
  it('reports the local stream and its (empty) destination list as one payload', async () => {
    const { manager } = buildManager();
    await manager.start('user-1', 'playlist-1', { templateId: 'tpl-1' });
    expect(manager.status('user-1')).toEqual({
      local: {
        state: 'streaming', currentTrack: 'a', nextTrack: 'b', previewReady: true,
        playlistId: 'playlist-1', templateId: 'tpl-1', startedAt: expect.any(String),
      },
      destinations: [],
    });
  });

  // Zero destinations is a fully valid running state, not a degenerate one.
  it('runs happily with nothing forwarded', async () => {
    const { manager, createRelay } = buildManager();
    await manager.start('user-1', 'playlist-1');
    await settle();
    expect(createRelay).not.toHaveBeenCalled();
    expect(manager.status('user-1').local.state).toBe('streaming');
  });

  it('starts a relay for a destination toggled on before start', async () => {
    const { manager, prepareSession, createRelay } = buildManager();
    await manager.setDestinationDesired('user-1', 'dest-1', 'on');
    await manager.start('user-1', 'playlist-1');
    await settle();
    expect(prepareSession).toHaveBeenCalled();
    expect(createRelay).toHaveBeenCalledWith({
      inputUrl: `rtmp://mediamtx:1935/live/${TOKEN}?user=sub&pass=read-secret`,
      outputUrl: 'rtmp://live.twitch.tv/app/key',
    });
    expect(manager.status('user-1').destinations[0]).toEqual(expect.objectContaining({
      destinationId: 'dest-1', desired: 'on', state: 'connecting',
    }));
  });

  it('toggles a destination on and off mid-stream without touching the encode', async () => {
    const { manager, encoder, createRelay, relays } = buildManager();
    await manager.start('user-1', 'playlist-1');
    await manager.setDestinationDesired('user-1', 'dest-1', 'on');
    await settle();
    expect(createRelay).toHaveBeenCalledTimes(1);

    await manager.setDestinationDesired('user-1', 'dest-1', 'off');
    await settle();
    expect(relays[0].stop).toHaveBeenCalled();
    expect(encoder.stop).not.toHaveBeenCalled();
    expect(manager.status('user-1').local.state).toBe('streaming');
  });

  // The hazard the spec names by name: "without this state, a re-toggle-on mid-finalize would race
  // a second broadcast against the first." A forward with a real (YouTube-shaped) lifecycle takes
  // real, controllable time to finalize — long enough for a fast off-then-on to arrive while it's
  // still 'stopping'. If isInactive() (or the pruning it feeds) ever regresses to ignore `actual`,
  // this test starts a SECOND prepareSession() while the first's finalize() is still pending.
  it('does not start a second broadcast when re-toggled on before the first finalize completes', async () => {
    const { manager, prepareSession, createRelay } = buildManager();
    let resolveFinalize!: () => void;
    const finalize = jest.fn(() => new Promise<void>((resolve) => { resolveFinalize = resolve; }));
    prepareSession.mockResolvedValue({
      rtmpUrl: 'rtmp://a.example/live', streamKey: 'key',
      // onPushStarted is REQUIRED on DestinationLifecycle (src/destinations/
      // streamDestinationProvider.ts) — `session.lifecycle?.onPushStarted()` in pass() branch 6
      // guards a null lifecycle, not a missing method, so omitting it throws inside pass(), gets
      // swallowed by run()'s catch, and silently aborts the reconcile loop this test depends on.
      lifecycle: { finalize, phase: () => 'live', watchUrl: () => null, onPushStarted: jest.fn() },
    });
    await manager.start('user-1', 'playlist-1');
    await manager.setDestinationDesired('user-1', 'dest-1', 'on');
    await settle();
    expect(prepareSession).toHaveBeenCalledTimes(1);

    // Toggle off (finalize() starts and hangs on the unresolved promise above), then immediately
    // toggle back on, all before finalize resolves.
    await manager.setDestinationDesired('user-1', 'dest-1', 'off');
    await settle();
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(manager.status('user-1').destinations[0].state).toBe('stopping');

    await manager.setDestinationDesired('user-1', 'dest-1', 'on');
    await settle();
    // Still only ONE prepareSession call — the toggle-on found the SAME still-settling forward
    // (state 'stopping'), not a freshly constructed one, and its own reconcile() will start a new
    // session only once the pending finalize actually resolves.
    expect(prepareSession).toHaveBeenCalledTimes(1);

    resolveFinalize();
    await settle();
    await settle(); // finalize's own .then() plus the reconcile it triggers, two macrotask hops
    expect(prepareSession).toHaveBeenCalledTimes(2);
    expect(createRelay).toHaveBeenCalledTimes(2);
  });

  // The SIBLING-triggered half of the same hazard, and the ONLY test anywhere that actually
  // exercises isInactive()'s `actual === 'off'` clause. The single-destination test above does not:
  // pruning only ever runs from a forward's own onStatusChanged, and a forward hung inside
  // finalize() fires none of its own between `session = null` and the hang — so with one
  // destination, deleting that clause changes nothing observable. pruneForwards() sweeps EVERY
  // forward of the user, though, so a SECOND destination settling to 'off' is what drives a prune
  // pass across the hung one. Delete `this.actual === 'off'` from isInactive() and dest-1 (session
  // and relay both already nulled, actual still 'stopping') is swept out from under its own
  // in-flight finalize — after which the re-toggle-on below constructs a BRAND NEW forward and
  // races a second prepareSession against that still-running finalize, which is exactly the
  // spec-named hazard.
  it('does not prune a forward mid-finalize when a sibling forward settles off', async () => {
    const { manager, prepareSession, rows } = buildManager();
    rows.set('dest-2', destinationRow({ id: 'dest-2', name: 'YouTube' }));
    let resolveFinalize!: () => void;
    const finalize = jest.fn(() => new Promise<void>((resolve) => { resolveFinalize = resolve; }));
    prepareSession.mockImplementation(async (destination: StreamDestination) => (
      destination.id === 'dest-1'
        ? {
          rtmpUrl: 'rtmp://a.example/live',
          streamKey: 'key',
          lifecycle: { finalize, phase: () => 'live', watchUrl: () => null, onPushStarted: jest.fn() },
        }
        : { rtmpUrl: 'rtmp://b.example/live', streamKey: 'key2' }
    ));
    const preparesFor = (id: string) => prepareSession.mock.calls.filter((call) => call[0].id === id).length;
    const forwardFor = (id: string) => manager.status('user-1').destinations.find((d) => d.destinationId === id);

    await manager.start('user-1', 'playlist-1');
    await manager.setDestinationDesired('user-1', 'dest-1', 'on');
    await manager.setDestinationDesired('user-1', 'dest-2', 'on');
    await settle();
    expect(preparesFor('dest-1')).toBe(1);
    expect(preparesFor('dest-2')).toBe(1);

    // dest-1's finalize() starts and hangs; dest-2 has no lifecycle at all, so its own toggle-off
    // settles all the way to 'off' and triggers the prune sweep.
    await manager.setDestinationDesired('user-1', 'dest-1', 'off');
    await settle();
    await manager.setDestinationDesired('user-1', 'dest-2', 'off');
    await settle();
    expect(forwardFor('dest-2')).toBeUndefined(); // genuinely settled and pruned
    expect(forwardFor('dest-1')).toEqual(expect.objectContaining({ state: 'stopping' }));

    await manager.setDestinationDesired('user-1', 'dest-1', 'on');
    await settle();
    // The surviving forward was reused, so nothing has raced the hung finalize.
    expect(preparesFor('dest-1')).toBe(1);

    resolveFinalize();
    await settle();
    await settle();
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(preparesFor('dest-1')).toBe(2);
  });

  // A forward object is reused across many prepareSession() calls (respawn, toggle-off-then-on).
  // YoutubeProvider.prepareSession() persists youtubeLiveStreamId to the DATABASE, not back onto
  // whatever row the caller passed in — so the reused forward must be handed a FRESH row on every
  // lookup, or it keeps reading its own stale (pre-persist) copy and reuse never actually happens.
  //
  // This MUST reuse the SAME forward object across the toggle cycle to mean anything — a naive
  // version of this test that lets the off-toggle fully settle (actual: 'off') before toggling
  // back on gets PRUNED by the C1 fix's own onStatusChanged-driven cleanup, so the second toggle-on
  // constructs a brand-new forward from an already-fresh row and passes whether setDestination()
  // exists or not. Borrow the same hanging-finalize trick as the test above to keep this forward's
  // `actual` at 'stopping' (never reaching 'off', so isInactive() stays false and pruning never
  // fires) across the whole toggle-off-then-on sequence.
  it('re-reads the destination row on every toggle, so a later prepareSession sees an earlier one\'s persisted id', async () => {
    const { manager, prepareSession, rows } = buildManager();
    let resolveFinalize!: () => void;
    const finalize = jest.fn(() => new Promise<void>((resolve) => { resolveFinalize = resolve; }));
    prepareSession.mockImplementation(async (destination: StreamDestination) => {
      // Simulate YoutubeProvider persisting the reusable liveStream id to the repository — a real
      // DB write the row object passed in does NOT observe unless the caller re-reads it.
      if (!destination.youtubeLiveStreamId) {
        rows.set(destination.id, { ...destination, youtubeLiveStreamId: 'ls-1' });
      }
      return {
        rtmpUrl: 'rtmp://a.example/live', streamKey: 'key',
        lifecycle: { finalize, phase: () => 'live', watchUrl: () => null, onPushStarted: jest.fn() },
      };
    });

    await manager.start('user-1', 'playlist-1');
    await manager.setDestinationDesired('user-1', 'dest-1', 'on');
    await settle();
    expect(prepareSession.mock.calls[0][0].youtubeLiveStreamId).toBeNull();

    // Toggle off — finalize() starts and hangs, so this forward's actual stays 'stopping', never
    // reaching 'off'. Toggle back on immediately, before finalize resolves.
    await manager.setDestinationDesired('user-1', 'dest-1', 'off');
    await settle();
    expect(manager.status('user-1').destinations[0].state).toBe('stopping');
    await manager.setDestinationDesired('user-1', 'dest-1', 'on');
    await settle();
    expect(prepareSession).toHaveBeenCalledTimes(1); // still the same, still-settling forward

    resolveFinalize();
    await settle();
    await settle(); // finalize's own .then() plus the reconcile it triggers, two macrotask hops
    // The SAME forward object's second prepareSession() must see the id the first call persisted —
    // proving getOrCreateForward() re-applied the freshly-read row rather than reusing the one
    // captured when the forward was first constructed.
    expect(prepareSession).toHaveBeenCalledTimes(2);
    expect(prepareSession.mock.calls[1][0].youtubeLiveStreamId).toBe('ls-1');
  });

  // The same stale-row hazard as the test above, reached from a DIFFERENT path: a forward that
  // SURVIVES a stop/restart (parked at 'pending' by an encoder crash, never pruned since desired
  // is still 'on') without ever going through getOrCreateForward's toggle-route refresh. start()
  // itself has no destination list of its own at all now — every forward it might reconcile into
  // life is either toggled on before this call or already sitting in the manager's own forward
  // map from before, so refreshForwardRows() must cover BOTH without being told which is which.
  it('refreshes a surviving forward\'s row on restart, with no destination list for start() to consult', async () => {
    const { manager, prepareSession, rows, encoder } = buildManager();
    prepareSession.mockImplementation(async (destination: StreamDestination) => {
      if (!destination.youtubeLiveStreamId) rows.set(destination.id, { ...destination, youtubeLiveStreamId: 'ls-1' });
      return { rtmpUrl: 'rtmp://a.example/live', streamKey: 'key' };
    });

    await manager.setDestinationDesired('user-1', 'dest-1', 'on');
    await manager.start('user-1', 'playlist-1');
    await settle();
    expect(prepareSession.mock.calls[0][0].youtubeLiveStreamId).toBeNull();

    // The encoder dies for good; the forward parks at 'pending' (still desired: 'on', never
    // pruned) rather than being torn down by a user-initiated stop(). Two consecutive short-lived
    // exits cross CRASH_LOOP_THRESHOLD. Unlike the crash-loop tests higher up this file, this one
    // fires the SAME captured onExit callback twice instead of waiting for a real respawn:
    // encoder.start.mock.calls[1] only exists once the scheduled respawn has actually fired, which
    // needs fake timers — and fake timers would also fake the setImmediate that `settle()` (and so
    // every forward assertion in this describe block) depends on. Re-entering
    // handleUnexpectedExit() while the first exit's respawn is still only SCHEDULED is a real
    // shape anyway: its teardown() clears that pending timer, so nothing is left dangling.
    const onExit = encoder.start.mock.calls[0][0] as (code: number | null) => void;
    onExit(1);
    await settle();
    onExit(1);
    await settle();
    expect(manager.status('user-1').local.state).toBe('error');
    expect(manager.status('user-1').destinations[0].desired).toBe('on');

    // Restart — the surviving forward is only in the manager's own forward map from before, never
    // named to this call at all.
    await manager.start('user-1', 'playlist-1');
    await settle();
    expect(prepareSession).toHaveBeenCalledTimes(2);
    expect(prepareSession.mock.calls[1][0].youtubeLiveStreamId).toBe('ls-1');
  });

  // Spec open question #3: toggling before anything is running is `pending`, not a 409 — and it has
  // zero external side effects until a stream actually starts.
  it('accepts a toggle while nothing is running and starts that destination with the next start', async () => {
    const { manager, prepareSession, createRelay } = buildManager();
    const status = await manager.setDestinationDesired('user-1', 'dest-1', 'on');
    expect(status.local.state).toBe('idle');
    expect(status.destinations[0]).toEqual(expect.objectContaining({ desired: 'on', state: 'pending' }));
    expect(prepareSession).not.toHaveBeenCalled();

    await manager.start('user-1', 'playlist-1');
    await settle();
    expect(createRelay).toHaveBeenCalledTimes(1);
  });

  it('404s/403s a toggle for an unknown or foreign destination', async () => {
    const { manager } = buildManager();
    await expect(manager.setDestinationDesired('user-1', 'nope', 'on')).rejects.toThrow(ApiError);
    await expect(manager.setDestinationDesired('user-2', 'dest-1', 'on')).rejects.toThrow('not your destination');
  });

  it('reports starting while a start is in flight, so the UI never shows idle mid-start', async () => {
    const { manager, buildScene } = buildManager();
    let release!: (scene: unknown) => void;
    buildScene.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const starting = manager.start('user-1', 'playlist-1');
    expect(manager.status('user-1').local.state).toBe('starting');
    release(fakeScene().scene);
    await starting;
  });

  it('stops every forward and finalizes before reporting the stream stopped', async () => {
    const { manager, relays, encoder } = buildManager();
    await manager.setDestinationDesired('user-1', 'dest-1', 'on');
    await manager.start('user-1', 'playlist-1');
    await settle();
    await manager.stop('user-1');
    expect(relays[0].stop).toHaveBeenCalled();
    expect(encoder.stop).toHaveBeenCalled();
    expect(manager.status('user-1')).toEqual({
      local: {
        state: 'idle', currentTrack: null, nextTrack: null, previewReady: false,
        playlistId: null, templateId: null, startedAt: null,
      },
      destinations: [],
    });
  });

  // Spec: "DELETE /destinations/{id} while forwarded — must toggle that forward off and finalize
  // its lifecycle WITHOUT touching the local stream."
  it('removeDestination stops only that forward, never the encode', async () => {
    const { manager, relays, encoder } = buildManager();
    await manager.setDestinationDesired('user-1', 'dest-1', 'on');
    await manager.start('user-1', 'playlist-1');
    await settle();
    await manager.removeDestination('user-1', 'dest-1');
    expect(relays[0].stop).toHaveBeenCalled();
    expect(encoder.stop).not.toHaveBeenCalled();
    expect(manager.status('user-1').local.state).toBe('streaming');
    expect(manager.status('user-1').destinations).toEqual([]);
  });

  it('removeDestination is a no-op for a destination that was never forwarded', async () => {
    const { manager } = buildManager();
    await manager.start('user-1', 'playlist-1');
    await expect(manager.removeDestination('user-1', 'dest-1')).resolves.toBeUndefined();
  });

  // The whole point of this rework: broadcast settings are THIS destination's own, chosen right at
  // toggle-on time — not a session-wide default start() used to hand every forward alike.
  it('passes the broadcast metadata given at toggle-on time to that forward\'s prepareSession', async () => {
    const { manager, prepareSession } = buildManager();
    await manager.setDestinationDesired('user-1', 'dest-1', 'on', {
      title: 'Late night', privacyStatus: 'unlisted', latencyPreference: 'low',
    });
    await manager.start('user-1', 'playlist-1');
    await settle();
    expect(prepareSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'dest-1' }), {
      title: 'Late night', description: undefined, privacyStatus: 'unlisted', latencyPreference: 'low',
    });
  });

  // No playlist name to default to any more (a toggle has no playlist context at all) — the
  // destination's own name is the fallback, whether no meta was given (the forward's own bare
  // default) or a partial one was (this manager's own title ?? destination.name resolution).
  it('defaults the broadcast title to the destination\'s own name when the toggle omits it', async () => {
    const { manager, prepareSession } = buildManager();
    await manager.setDestinationDesired('user-1', 'dest-1', 'on', { privacyStatus: 'unlisted' });
    await manager.start('user-1', 'playlist-1');
    await settle();
    expect(prepareSession.mock.calls[0][1]).toEqual({
      title: 'Twitch', description: undefined, privacyStatus: 'unlisted', latencyPreference: undefined,
    });
  });

  it('rejects a toggle for a destination whose provider is not registered', async () => {
    const { manager, rows } = buildManager();
    rows.set('dest-1', destinationRow({ provider: 'nonsense' }));
    await expect(manager.setDestinationDesired('user-1', 'dest-1', 'on'))
      .rejects.toThrow('unsupported destination provider');
  });

  // Spec: "Pause gets strictly safer than today: it no longer needs to keep any destination-facing
  // RTMP connection alive through a silence swap, because the local publish to MediaMTX never stops
  // regardless of pause state." Concretely: pausing must not look like a source outage to a forward,
  // or every destination would drop the moment the user hit pause.
  it('keeps every forward running across a pause and resume', async () => {
    const { manager, relays } = buildManager();
    await manager.setDestinationDesired('user-1', 'dest-1', 'on');
    await manager.start('user-1', 'playlist-1');
    await settle();

    manager.pause('user-1');
    await settle();
    expect(relays[0].stop).not.toHaveBeenCalled();
    expect(manager.status('user-1').destinations[0].state).not.toBe('pending');

    await manager.resume('user-1');
    await settle();
    expect(relays).toHaveLength(1); // the same relay, never respawned
  });
});
