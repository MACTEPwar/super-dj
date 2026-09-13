import { LocalStreamManager } from '../../src/stream/localStreamManager';
import { LocalRelaySession } from '../../src/stream/localRelayTarget';
import { ApiError } from '../../src/errors';

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

function buildManager(overrides: Partial<Record<string, unknown>> = {}) {
  const parts = fakeScene();
  const buildScene = jest.fn().mockResolvedValue(parts.scene);
  const relayTarget = { create: jest.fn((userId: string) => relaySession(userId)) };
  const authRegistry = { register: jest.fn(), unregister: jest.fn() };
  const manager = new LocalStreamManager({
    sceneDeps: {} as never,
    relayTarget,
    authRegistry,
    maxConcurrentStreams: 10,
    maxSessionDurationMs: 12 * 60 * 60 * 1000,
    buildScene,
    ...overrides,
  } as never);
  return { manager, buildScene, relayTarget, authRegistry, ...parts };
}

describe('LocalStreamManager.start', () => {
  it('builds the scene for the calling user and starts a controller in the streaming state', async () => {
    const { manager, buildScene } = buildManager();
    await manager.start('user-1', 'playlist-1', { templateId: 'tpl-1' });
    expect(buildScene).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: 'user-1', playlistId: 'playlist-1', templateId: 'tpl-1', sceneId: 'user-1',
    }));
    expect(manager.status('user-1').state).toBe('streaming');
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

  it('passes no overlay cache or session id — one queue drives one encode, so there is nothing to share', async () => {
    const { manager, buildScene } = buildManager();
    await manager.start('user-1', 'playlist-1');
    const params = buildScene.mock.calls[0][1];
    expect(params.overlayCache).toBeUndefined();
    expect(params.sessionId).toBeUndefined();
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
    manager.stop('user-1');
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
    expect(manager.status('user-1').state).toBe('idle');
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
    expect(manager.status('user-1').state).toBe('idle');
  });
});

describe('LocalStreamManager lifecycle and status', () => {
  it('reports idle with nulls for a user who has never streamed', () => {
    const { manager } = buildManager();
    expect(manager.status('nobody')).toEqual({
      state: 'idle', currentTrack: null, nextTrack: null,
      previewReady: false, playlistId: null, templateId: null, startedAt: null,
    });
  });

  it('reports the playlist, template and start time of a running stream, and marks the preview ready', async () => {
    const { manager } = buildManager();
    await manager.start('user-1', 'playlist-1', { templateId: 'tpl-1' });
    const status = manager.status('user-1');
    expect(status).toEqual(expect.objectContaining({
      state: 'streaming', currentTrack: 'a', nextTrack: 'b',
      previewReady: true, playlistId: 'playlist-1', templateId: 'tpl-1',
    }));
    expect(Date.parse(status.startedAt!)).not.toBeNaN();
  });

  // Pause never stops the local publish — only the audio changes — so the preview stays watchable.
  it('keeps the preview ready while paused', async () => {
    const { manager } = buildManager();
    await manager.start('user-1', 'playlist-1');
    manager.pause('user-1');
    expect(manager.status('user-1')).toEqual(expect.objectContaining({ state: 'paused', previewReady: true }));
  });

  it('exposes the preview target only while a stream is running', async () => {
    const { manager } = buildManager();
    expect(manager.previewTarget('user-1')).toBeNull();
    await manager.start('user-1', 'playlist-1');
    expect(manager.previewTarget('user-1')).toEqual({
      hlsBaseUrl: `http://mediamtx:8888/live/${TOKEN}`,
      authorization: 'Basic c3ViOnJlYWQtc2VjcmV0',
    });
    manager.stop('user-1');
    expect(manager.previewTarget('user-1')).toBeNull();
  });

  it('revokes the MediaMTX credentials on stop', async () => {
    const { manager, authRegistry, encoder } = buildManager();
    await manager.start('user-1', 'playlist-1');
    manager.stop('user-1');
    expect(encoder.stop).toHaveBeenCalled();
    expect(authRegistry.unregister).toHaveBeenCalledWith(`live/${TOKEN}`);
    expect(manager.status('user-1').state).toBe('idle');
  });

  it('throws 409 for every command when the user has no active stream', async () => {
    const { manager } = buildManager();
    expect(() => manager.stop('user-1')).toThrow('local stream is not active');
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
      expect(manager.status('user-1').state).toBe('idle');
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
      manager.stop('user-1');
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
      expect(manager.status('user-1').state).toBe('reconnecting');
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
      expect(manager.status('user-1').state).toBe('error');
      expect(manager.previewTarget('user-1')).toBeNull();
      expect(authRegistry.unregister).toHaveBeenCalledWith(`live/${TOKEN}`);

      await expect(manager.start('user-1', 'playlist-1')).resolves.toBeUndefined();
      expect(manager.status('user-1').state).toBe('streaming');
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
    expect(manager.status('user-1').state).toBe('streaming');
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
      expect(manager.status('user-1').state).toBe('error');

      await expect(manager.start('user-2', 'playlist-1')).resolves.toBeUndefined();
    } finally {
      errorSpy.mockRestore();
      jest.useRealTimers();
    }
  });
});
