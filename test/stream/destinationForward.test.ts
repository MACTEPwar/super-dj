import { StreamDestination } from '@prisma/client';
import { DestinationForward, DestinationForwardDeps } from '../../src/stream/destinationForward';
import { createForwardReconnectPolicy, SHORT_LIVED_UPTIME_MS } from '../../src/stream/reconnectPolicy';
import { DestinationLifecycle, PreparedSession } from '../../src/destinations/streamDestinationProvider';

const SOURCE_URL = 'rtmp://mediamtx:1935/live/abcdef0123456789abcdef0123456789?user=sub&pass=r';

function destination(overrides: Partial<StreamDestination> = {}): StreamDestination {
  return {
    id: 'dest-1', userId: 'user-1', name: 'My channel', rtmpUrl: 'rtmp://dest.example/app',
    streamKeyEncrypted: null, provider: 'custom', youtubeLiveStreamId: null, createdAt: new Date(),
    ...overrides,
  } as StreamDestination;
}

function fakeLifecycle(): DestinationLifecycle & { setPhase: (p: string) => void; finalized: jest.Mock } {
  let phase = 'creating';
  let listener: (() => void) | null = null;
  const finalized = jest.fn().mockResolvedValue(undefined);
  return {
    onPushStarted: jest.fn(() => { phase = 'waitingForYoutube'; listener?.(); }),
    phase: () => phase,
    watchUrl: () => 'https://www.youtube.com/channel/UC123/live',
    finalize: finalized,
    onPhaseChange: (cb: () => void) => { listener = cb; },
    isAuthError: () => false,
    setPhase: (p: string) => { phase = p; listener?.(); },
    finalized,
  } as never;
}

function fakeRelay() {
  const relay = {
    start: jest.fn(),
    stop: jest.fn(),
    exit: (code: number | null) => { (relay.start.mock.calls.at(-1)![0] as (c: number | null) => void)(code); },
  };
  return relay;
}

interface Harness {
  forward: DestinationForward;
  prepareSession: jest.Mock;
  relays: ReturnType<typeof fakeRelay>[];
  createRelay: jest.Mock;
  lastRelay: () => ReturnType<typeof fakeRelay>;
  onStatusChanged: jest.Mock;
  setSource: (url: string | null, publishing?: boolean) => void;
  timers: { fn: () => void; delayMs: number }[];
  runTimers: () => void;
  clock: { now: number };
}

function buildForward(options: {
  lifecycle?: DestinationLifecycle | null;
  destination?: StreamDestination;
  isAuthError?: (err: unknown) => boolean;
} = {}): Harness {
  const relays: ReturnType<typeof fakeRelay>[] = [];
  const timers: { fn: () => void; delayMs: number }[] = [];
  const clock = { now: 1_000_000 };
  let sourceUrl: string | null = SOURCE_URL;
  let publishing = true;

  const lifecycle = options.lifecycle === undefined ? null : options.lifecycle;
  const prepareSession = jest.fn(async (): Promise<PreparedSession> => ({
    rtmpUrl: 'rtmp://dest.example/app', streamKey: 'secret-key', lifecycle: lifecycle ?? undefined,
  }));
  const createRelay = jest.fn(() => { const relay = fakeRelay(); relays.push(relay); return relay; });
  const onStatusChanged = jest.fn();

  const deps: DestinationForwardDeps = {
    destination: options.destination ?? destination(),
    provider: { prepareSession, isAuthError: options.isAuthError } as never,
    meta: () => ({ title: 'Friday Mix' }),
    sourceUrl: () => sourceUrl,
    isSourcePublishing: () => publishing && sourceUrl !== null,
    createRelay: createRelay as never,
    reconnectPolicy: createForwardReconnectPolicy({ random: () => 0.5 }),
    onStatusChanged,
    now: () => clock.now,
    // The handle IS the entry, and clearTimer really removes it — load-bearing, not cosmetic: the
    // forward legitimately holds two timers at once (a custom-RTMP promotion timer and a relay
    // respawn timer), and a no-op clearTimer would leave the cancelled one in this array and make
    // every "expect exactly one pending timer" assertion below read the wrong entry.
    setTimer: ((fn: () => void, delayMs: number) => {
      const handle = { fn, delayMs };
      timers.push(handle);
      return handle as never;
    }) as never,
    clearTimer: ((handle: { fn: () => void; delayMs: number }) => {
      const index = timers.indexOf(handle);
      if (index >= 0) timers.splice(index, 1);
    }) as never,
  };

  return {
    forward: new DestinationForward(deps),
    prepareSession, relays, createRelay, onStatusChanged, timers, clock,
    lastRelay: () => relays[relays.length - 1],
    setSource: (url, isPublishing = true) => { sourceUrl = url; publishing = isPublishing; },
    runTimers: () => { const pending = timers.splice(0, timers.length); for (const t of pending) t.fn(); },
  };
}

describe('DestinationForward — pending and toggling', () => {
  it('starts off, with no side effects at all', () => {
    const h = buildForward();
    expect(h.forward.status()).toEqual({ destinationId: 'dest-1', name: 'My channel', desired: 'off', state: 'off' });
    expect(h.prepareSession).not.toHaveBeenCalled();
  });

  // Spec open question #3: toggle-on-while-idle is `pending`, not a 409 — so "start with these
  // three pre-checked" and "check a box mid-stream" are one code path.
  it('parks at pending with zero external side effects when nothing is publishing yet', async () => {
    const h = buildForward();
    h.setSource(null);
    h.forward.setDesired('on');
    await h.forward.reconcile();
    expect(h.forward.status().state).toBe('pending');
    expect(h.prepareSession).not.toHaveBeenCalled();
    expect(h.createRelay).not.toHaveBeenCalled();
  });

  it('prepares the provider session and starts a relay once the source is publishing', async () => {
    const h = buildForward();
    h.forward.setDesired('on');
    await h.forward.reconcile();
    expect(h.prepareSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'dest-1' }), { title: 'Friday Mix' });
    expect(h.createRelay).toHaveBeenCalledWith({ inputUrl: SOURCE_URL, outputUrl: 'rtmp://dest.example/app/secret-key' });
    expect(h.lastRelay().start).toHaveBeenCalled();
    expect(h.forward.status().state).toBe('connecting');
  });

  it('is idempotent: setting the same desired state twice changes nothing', async () => {
    const h = buildForward();
    h.forward.setDesired('on');
    await h.forward.reconcile();
    h.forward.setDesired('on');
    await h.forward.reconcile();
    expect(h.prepareSession).toHaveBeenCalledTimes(1);
    expect(h.createRelay).toHaveBeenCalledTimes(1);
  });

  it('stops the relay and finalizes the broadcast on toggle-off', async () => {
    const lifecycle = fakeLifecycle();
    const h = buildForward({ lifecycle });
    h.forward.setDesired('on');
    await h.forward.reconcile();
    const relay = h.lastRelay();
    h.forward.setDesired('off');
    await h.forward.reconcile();
    expect(relay.stop).toHaveBeenCalled();
    expect(lifecycle.finalize).toHaveBeenCalled();
    expect(h.forward.status()).toEqual({ destinationId: 'dest-1', name: 'My channel', desired: 'off', state: 'off' });
  });

  // Spec, "preparing": a desired->off arriving mid-prepare must not drop the returned lifecycle on
  // the floor — the broadcast is already live on YouTube by then and nothing else can ever end it.
  it('finalizes a broadcast whose prepareSession resolved after the user toggled off', async () => {
    const lifecycle = fakeLifecycle();
    const h = buildForward({ lifecycle });
    let releasePrepare!: () => void;
    h.prepareSession.mockImplementationOnce(() => new Promise<PreparedSession>((resolve) => {
      releasePrepare = () => resolve({ rtmpUrl: 'rtmp://dest.example/app', streamKey: 'secret-key', lifecycle });
    }));
    h.forward.setDesired('on');
    const settling = h.forward.reconcile();
    expect(h.forward.status().state).toBe('preparing');

    h.forward.setDesired('off');
    releasePrepare();
    await settling;
    await h.forward.reconcile();

    expect(lifecycle.finalize).toHaveBeenCalledTimes(1);
    expect(h.createRelay).not.toHaveBeenCalled();
    expect(h.forward.status().state).toBe('off');
  });

  // Spec, "stopping": without this state a re-toggle-on mid-finalize races a second broadcast
  // against the first.
  it('re-toggling on while a finalize is in flight does not start a second broadcast underneath it', async () => {
    const lifecycle = fakeLifecycle();
    const h = buildForward({ lifecycle });
    let releaseFinalize!: () => void;
    (lifecycle.finalize as jest.Mock).mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseFinalize = resolve;
    }));
    h.forward.setDesired('on');
    await h.forward.reconcile();
    h.forward.setDesired('off');
    const stopping = h.forward.reconcile();
    expect(h.forward.status().state).toBe('stopping');

    h.forward.setDesired('on');
    expect(h.prepareSession).toHaveBeenCalledTimes(1);
    releaseFinalize();
    await stopping;
    await h.forward.reconcile();

    expect(lifecycle.finalize).toHaveBeenCalledTimes(1);
    expect(h.prepareSession).toHaveBeenCalledTimes(2);
    expect(h.forward.status().state).toBe('connecting');
  });
});

describe('DestinationForward — source availability', () => {
  // Spec: forwards HOLD while the local stream is reconnecting. Finalizing there would burn ~330
  // quota units and hand viewers a new watch URL for what is a few seconds of ingest gap.
  it('holds without finalizing while the local stream is reconnecting', async () => {
    const lifecycle = fakeLifecycle();
    const h = buildForward({ lifecycle });
    h.forward.setDesired('on');
    await h.forward.reconcile();
    const relay = h.lastRelay();

    h.setSource(SOURCE_URL, false); // encoder died; MediaMTX will drop this reader within ~1s
    relay.exit(1);
    await h.forward.reconcile();

    expect(lifecycle.finalize).not.toHaveBeenCalled();
    expect(h.forward.status().state).toBe('connecting');
    expect(h.timers).toHaveLength(0); // no retry scheduled: not this destination's problem
  });

  it('starts a fresh relay against the same broadcast once the source comes back', async () => {
    const lifecycle = fakeLifecycle();
    const h = buildForward({ lifecycle });
    h.forward.setDesired('on');
    await h.forward.reconcile();
    h.setSource(SOURCE_URL, false);
    h.lastRelay().exit(1);
    await h.forward.reconcile();

    h.setSource(SOURCE_URL, true);
    await h.forward.reconcile();

    expect(h.prepareSession).toHaveBeenCalledTimes(1); // same broadcast, no second one
    expect(h.createRelay).toHaveBeenCalledTimes(2);
  });

  // Only when the local stream is definitively over (idle, or reconnect gave up) does a forward
  // finalize — and it goes back to `pending`, not `off`, because the user still wants it.
  it('finalizes and returns to pending when the local session is gone for good', async () => {
    const lifecycle = fakeLifecycle();
    const h = buildForward({ lifecycle });
    h.forward.setDesired('on');
    await h.forward.reconcile();

    h.setSource(null);
    await h.forward.reconcile();

    expect(lifecycle.finalize).toHaveBeenCalledTimes(1);
    expect(h.forward.status()).toEqual({ destinationId: 'dest-1', name: 'My channel', desired: 'on', state: 'pending' });
  });
});

describe('DestinationForward — relay failure', () => {
  it('schedules a respawn on an unexpected relay exit while the source is healthy', async () => {
    const h = buildForward();
    h.forward.setDesired('on');
    await h.forward.reconcile();
    h.clock.now += 60_000; // a long-lived relay: a real drop, not a startup failure
    h.lastRelay().exit(1);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].delayMs).toBe(500);
    expect(h.forward.status().state).toBe('connecting');

    h.runTimers();
    await h.forward.reconcile();
    expect(h.createRelay).toHaveBeenCalledTimes(2);
  });

  // The terminal-phase check must win even while a respawn is merely SCHEDULED, not yet running —
  // branch 6 (`if (!this.relay) { if (this.retryTimer) return; ... }`) used to return before ever
  // reaching the old single call site of the terminal check (branch 7, `syncProviderPhase()`,
  // reachable only once a relay is actually up). Without the earlier check, the pending timer would
  // fire later and push into a broadcast the provider had already ended.
  it('does not respawn into a broadcast the provider ended while a retry was pending', async () => {
    const lifecycle = fakeLifecycle();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = buildForward({ lifecycle });
      h.forward.setDesired('on');
      await h.forward.reconcile();
      h.clock.now += 60_000; // a long-lived relay: a real drop, not a startup failure
      h.lastRelay().exit(1);
      expect(h.timers).toHaveLength(1); // the respawn timer, scheduled but not yet fired

      // The provider ends the broadcast (YouTube's own health-check timeout, or an auth failure)
      // while that timer is still pending. setPhase() synchronously starts a NEW reconcile loop
      // (branch 3's giveUp() -> again() -> reconcile()), but reaching 'error' takes several more
      // passes after that (branch 2's own setState('stopping') -> await finalizeSession() ->
      // finalize()'s promise -> another pass to setState('error')) — a single microtask hop is not
      // enough to observe the end state, only the first pass's effects. await the forward's own
      // reconcile() (which resolves once its whole run() loop drains, same pattern as the sibling
      // "stays in error" test below) rather than a bare microtask.
      lifecycle.setPhase('error');
      await h.forward.reconcile();

      expect(h.forward.status().state).toBe('error');
      expect(lifecycle.finalize).toHaveBeenCalledTimes(1);
      expect(h.timers).toHaveLength(0); // the now-irrelevant respawn timer was cleared, not left to fire later

      // Even if it somehow still fired, it must not create a second relay into a dead broadcast.
      h.runTimers();
      await h.forward.reconcile();
      expect(h.createRelay).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('gives up with a relay error after two consecutive short-lived failures, and finalizes', async () => {
    const lifecycle = fakeLifecycle();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = buildForward({ lifecycle });
      h.forward.setDesired('on');
      await h.forward.reconcile();
      h.lastRelay().exit(1);        // short-lived #1 -> retry
      h.runTimers();
      await h.forward.reconcile();
      h.lastRelay().exit(1);        // short-lived #2 -> crash-loop threshold
      await h.forward.reconcile();

      const status = h.forward.status();
      expect(status.state).toBe('error');
      expect(status.error?.reason).toBe('relay');
      expect(lifecycle.finalize).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('stays in error until the user toggles it off and on again', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = buildForward();
      h.forward.setDesired('on');
      await h.forward.reconcile();
      h.lastRelay().exit(1);
      h.runTimers();
      await h.forward.reconcile();
      h.lastRelay().exit(1);
      await h.forward.reconcile();
      expect(h.forward.status().state).toBe('error');

      await h.forward.reconcile(); // an unrelated status change must not re-arm it
      expect(h.createRelay).toHaveBeenCalledTimes(2);

      h.forward.setDesired('off');
      await h.forward.reconcile();
      h.forward.setDesired('on');
      await h.forward.reconcile();
      expect(h.createRelay).toHaveBeenCalledTimes(3);
      expect(h.forward.status().error).toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }
  });

  // A custom-RTMP destination has no lifecycle to poll, so surviving SHORT_LIVED_UPTIME_MS is the
  // only "connected" signal there is.
  it('promotes a lifecycle-less destination from connecting to live once the relay has survived', async () => {
    const h = buildForward();
    h.forward.setDesired('on');
    await h.forward.reconcile();
    expect(h.timers[0].delayMs).toBe(SHORT_LIVED_UPTIME_MS);
    h.runTimers();
    expect(h.forward.status().state).toBe('live');
  });
});

describe('DestinationForward — provider lifecycle', () => {
  it('reports the provider phase and watch URL, and goes live when the provider does', async () => {
    const lifecycle = fakeLifecycle();
    const h = buildForward({ lifecycle });
    h.forward.setDesired('on');
    await h.forward.reconcile();
    expect(lifecycle.onPushStarted).toHaveBeenCalled();
    expect(h.forward.status().provider).toEqual({
      type: 'custom', phase: 'waitingForYoutube', watchUrl: 'https://www.youtube.com/channel/UC123/live',
    });

    (lifecycle as never as { setPhase: (p: string) => void }).setPhase('live');
    await h.forward.reconcile();
    expect(h.forward.status().state).toBe('live');
  });

  // The YouTube health-check timeout (or an auth short-circuit) puts the lifecycle in a terminal
  // phase. That must stop THIS forward's relay — which used to keep pushing at a dead ingest until
  // a human intervened — and must never touch the local encode or a sibling forward.
  it('gives up and stops its relay when the provider ends the broadcast on its own', async () => {
    const lifecycle = fakeLifecycle();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = buildForward({ lifecycle });
      h.forward.setDesired('on');
      await h.forward.reconcile();
      const relay = h.lastRelay();

      (lifecycle as never as { setPhase: (p: string) => void }).setPhase('error');
      await h.forward.reconcile();

      expect(relay.stop).toHaveBeenCalled();
      expect(h.forward.status().state).toBe('error');
      expect(h.forward.status().error?.reason).toBe('provider');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('classifies a prepareSession rejection through the provider\'s own isAuthError', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = buildForward({ isAuthError: () => true });
      h.prepareSession.mockRejectedValueOnce(new Error('invalid_grant'));
      h.forward.setDesired('on');
      await h.forward.reconcile();
      expect(h.forward.status()).toEqual(expect.objectContaining({
        state: 'error', error: { reason: 'auth', message: 'invalid_grant' },
      }));
      expect(h.createRelay).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('falls back to a provider error when the provider cannot classify it', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = buildForward();
      h.prepareSession.mockRejectedValueOnce(new Error('503 from YouTube'));
      h.forward.setDesired('on');
      await h.forward.reconcile();
      expect(h.forward.status().error).toEqual({ reason: 'provider', message: '503 from YouTube' });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('DestinationForward — shutdown', () => {
  it('shutdown turns it off, kills the relay and awaits the finalize', async () => {
    const lifecycle = fakeLifecycle();
    const h = buildForward({ lifecycle });
    h.forward.setDesired('on');
    await h.forward.reconcile();
    const relay = h.lastRelay();

    await h.forward.shutdown();

    expect(relay.stop).toHaveBeenCalled();
    expect(lifecycle.finalize).toHaveBeenCalledTimes(1);
    expect(h.forward.isInactive()).toBe(true);
  });

  it('reports inactive only when it wants nothing and holds nothing', async () => {
    const h = buildForward();
    expect(h.forward.isInactive()).toBe(true);
    h.forward.setDesired('on');
    expect(h.forward.isInactive()).toBe(false);
  });
});
