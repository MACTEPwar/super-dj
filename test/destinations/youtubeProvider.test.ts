import { YoutubeProvider } from '../../src/destinations/youtubeProvider';
import { YoutubeApiError } from '../../src/destinations/youtubeApiClient';
import { encrypt } from '../../src/crypto/streamKeyCipher';

const KEY = 'a'.repeat(64);

function fakeClient(overrides: Record<string, jest.Mock> = {}) {
  return {
    refreshAccessToken: jest.fn().mockResolvedValue('at'),
    createBroadcast: jest.fn().mockResolvedValue({ id: 'broadcast-1' }),
    createStream: jest.fn().mockResolvedValue({ id: 'stream-1', ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2', streamName: 'key-1' }),
    // Default: the persisted id (when there is one) is still valid on YouTube's side.
    getStream: jest.fn().mockResolvedValue({ id: 'stream-1', ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2', streamName: 'key-1' }),
    bind: jest.fn().mockResolvedValue(undefined),
    transition: jest.fn().mockResolvedValue(undefined),
    getStreamStatus: jest.fn().mockResolvedValue('active'),
    deleteStream: jest.fn().mockResolvedValue(undefined),
    exchangeCode: jest.fn(), revoke: jest.fn(), getChannel: jest.fn(),
    ...overrides,
  };
}

function buildProvider(client = fakeClient(), extra: Record<string, unknown> = {}, externalAccountId = 'UC123') {
  const oauthConnectionRepository = {
    findByDestinationId: jest.fn().mockResolvedValue({
      refreshTokenEncrypted: encrypt('refresh-token', KEY),
      externalAccountId,
    }),
  };
  // The liveStream is reused across toggles, so the provider now writes its id back to the row.
  const destinationRepository = { setYoutubeLiveStreamId: jest.fn().mockResolvedValue(undefined) };
  // Drives the poll loop deterministically instead of waiting on real timers.
  const scheduled: Array<() => void | Promise<void>> = [];
  const scheduleNextPoll = jest.fn((fn: () => void | Promise<void>) => { scheduled.push(fn); });
  const provider = new YoutubeProvider({
    client: client as any, encryptionKey: KEY, oauthConnectionRepository, destinationRepository, scheduleNextPoll, ...extra,
  });
  const runNextScheduledPoll = async () => {
    const fn = scheduled.shift();
    if (fn) await fn();
  };
  return { provider, client, oauthConnectionRepository, destinationRepository, runNextScheduledPoll, scheduled };
}

// The existing module-level fixture gains the new column. Every existing test keeps using `destination`.
const destination = { id: 'dest-1', youtubeLiveStreamId: null } as any;
const meta = { title: 'My Stream', description: 'desc', privacyStatus: 'private' as const };

describe('YoutubeProvider', () => {
  it('prepareSession creates and binds a broadcast+stream, returning the ingestion rtmpUrl/streamKey', async () => {
    const { provider, client } = buildProvider();

    const session = await provider.prepareSession(destination, meta);

    expect(session.rtmpUrl).toBe('rtmp://a.rtmp.youtube.com/live2');
    expect(session.streamKey).toBe('key-1');
    expect(client.createBroadcast).toHaveBeenCalledWith('at', { title: 'My Stream', description: 'desc', privacyStatus: 'private', latencyPreference: 'normal' });
    expect(client.createStream).toHaveBeenCalledWith('at', { title: 'My Stream' });
    expect(client.bind).toHaveBeenCalledWith('at', 'broadcast-1', 'stream-1');
    expect(session.lifecycle).toBeDefined();
  });

  it('passes an explicit latencyPreference through to createBroadcast', async () => {
    const { provider, client } = buildProvider();

    await provider.prepareSession(destination, { ...meta, latencyPreference: 'ultraLow' });

    expect(client.createBroadcast).toHaveBeenCalledWith('at', expect.objectContaining({ latencyPreference: 'ultraLow' }));
  });

  it('prepareSession throws a 502 if the destination has no OAuthConnection', async () => {
    const { provider, oauthConnectionRepository } = buildProvider();
    oauthConnectionRepository.findByDestinationId.mockResolvedValue(null);

    await expect(provider.prepareSession(destination, meta)).rejects.toMatchObject({ status: 502 });
  });

  it('lifecycle starts in "creating" and moves to "waitingForYoutube" once onPushStarted() is called', async () => {
    const { provider } = buildProvider();
    const session = await provider.prepareSession(destination, meta);

    expect(session.lifecycle!.phase()).toBe('creating');
    session.lifecycle!.onPushStarted();
    expect(session.lifecycle!.phase()).toBe('waitingForYoutube');
  });

  it('exposes a watchUrl built from the broadcast id', async () => {
    const { provider } = buildProvider();
    const session = await provider.prepareSession(destination, meta);
    expect(session.lifecycle!.watchUrl()).toBe('https://www.youtube.com/watch?v=broadcast-1');
  });

  it('transitions to "live" once a poll sees the stream become active', async () => {
    const client = fakeClient({ getStreamStatus: jest.fn().mockResolvedValue('active') } as any);
    const { provider, runNextScheduledPoll } = buildProvider(client as any);
    const session = await provider.prepareSession(destination, meta);
    session.lifecycle!.onPushStarted();

    await runNextScheduledPoll();

    expect(client.transition).toHaveBeenCalledWith('at', 'broadcast-1', 'live');
    expect(session.lifecycle!.phase()).toBe('live');
  });

  it('keeps polling while the stream is not yet active', async () => {
    const client = fakeClient({ getStreamStatus: jest.fn().mockResolvedValue('inactive') } as any);
    const { provider, runNextScheduledPoll, scheduled } = buildProvider(client as any);
    const session = await provider.prepareSession(destination, meta);
    session.lifecycle!.onPushStarted();

    await runNextScheduledPoll();

    expect(session.lifecycle!.phase()).toBe('waitingForYoutube');
    expect(client.transition).not.toHaveBeenCalled();
    expect(scheduled.length).toBe(1);
  });

  it('gives up after the health-check timeout, finalizing and setting phase to "error"', async () => {
    const client = fakeClient({ getStreamStatus: jest.fn().mockResolvedValue('inactive') } as any);
    let now = 0;
    const { provider, runNextScheduledPoll } = buildProvider(client as any, { clock: () => now, healthTimeoutMs: 1000, pollIntervalMs: 1000 });
    const session = await provider.prepareSession(destination, meta);
    session.lifecycle!.onPushStarted();

    now = 2000;
    await runNextScheduledPoll();

    expect(session.lifecycle!.phase()).toBe('error');
    // The liveStream is this destination's REUSABLE ingest endpoint now (persisted on the row), so
    // even a give-up leaves it alone — deleting it would cost an extra liveStreams.insert on the
    // next toggle-on (~30% of a toggle cycle's quota) for no gain.
    expect(client.deleteStream).not.toHaveBeenCalled();
  });

  it('short-circuits on an auth-class failure (a revoked/expired grant) instead of retrying for the rest of the health-check timeout', async () => {
    const authError = new YoutubeApiError(401, null, 'getStreamStatus', {});
    const client = fakeClient({ getStreamStatus: jest.fn().mockRejectedValue(authError) } as any);
    let now = 0;
    const { provider, runNextScheduledPoll, scheduled } = buildProvider(client as any, { clock: () => now, healthTimeoutMs: 90_000, pollIntervalMs: 3000 });
    const session = await provider.prepareSession(destination, meta);
    session.lifecycle!.onPushStarted();

    // Only a few ms have passed — nowhere near the 90s timeout — yet a single poll must still
    // give up immediately rather than scheduling another one.
    now = 100;
    await runNextScheduledPoll();

    expect(session.lifecycle!.phase()).toBe('error');
    // Reusable ingest endpoint — not deleted here either (see the quota note above).
    expect(client.deleteStream).not.toHaveBeenCalled();
    expect(scheduled.length).toBe(0);
    expect(session.lifecycle!.isAuthError!()).toBe(true);
  });

  it('isAuthError stays false when the poll only ever saw non-auth failures', async () => {
    const client = fakeClient({ getStreamStatus: jest.fn().mockRejectedValue(new Error('network blip')) } as any);
    const { provider, runNextScheduledPoll } = buildProvider(client as any);
    const session = await provider.prepareSession(destination, meta);
    session.lifecycle!.onPushStarted();

    await runNextScheduledPoll();

    expect(session.lifecycle!.isAuthError!()).toBe(false);
  });

  it('a poll already in flight when finalize() runs does not transition to live or overwrite the phase', async () => {
    let resolveStreamStatus: (status: string) => void;
    const streamStatusPromise = new Promise<string>((resolve) => {
      resolveStreamStatus = resolve;
    });
    const client = fakeClient({ getStreamStatus: jest.fn().mockReturnValue(streamStatusPromise) } as any);
    const { provider, runNextScheduledPoll } = buildProvider(client as any);
    const session = await provider.prepareSession(destination, meta);
    session.lifecycle!.onPushStarted();

    // Kick off the poll — it suspends on the getStreamStatus await, which we control.
    const pollPromise = runNextScheduledPoll();

    // While the poll is in flight, the user stops the stream: finalize() runs to completion.
    await session.lifecycle!.finalize();
    expect(session.lifecycle!.phase()).toBe('complete');

    // Now let the suspended poll's getStreamStatus resolve to 'active'.
    resolveStreamStatus!('active');
    await pollPromise;

    expect(client.transition).not.toHaveBeenCalledWith('at', 'broadcast-1', 'live');
    expect(session.lifecycle!.phase()).toBe('complete');
  });

  it('finalize() transitions the broadcast to complete and keeps the reusable stream', async () => {
    const { provider, client } = buildProvider();
    const session = await provider.prepareSession(destination, meta);
    session.lifecycle!.onPushStarted();

    await session.lifecycle!.finalize();

    expect(client.transition).toHaveBeenCalledWith('at', 'broadcast-1', 'complete');
    // Only the BROADCAST is ephemeral. Deleting the liveStream on every toggle-off used to cost an
    // extra liveStreams.insert+delete per cycle (~30% of its quota) and could orphan the stream
    // whenever finalize's own token refresh failed.
    expect(client.deleteStream).not.toHaveBeenCalled();
    expect(session.lifecycle!.phase()).toBe('complete');
  });

  it('finalize() is idempotent — a second call makes no further API calls', async () => {
    const { provider, client } = buildProvider();
    const session = await provider.prepareSession(destination, meta);
    await session.lifecycle!.finalize();
    client.transition.mockClear();
    client.deleteStream.mockClear();

    await session.lifecycle!.finalize();

    expect(client.transition).not.toHaveBeenCalled();
    expect(client.deleteStream).not.toHaveBeenCalled();
  });

  it('finalize() skips the "complete" transition when the broadcast never left "creating"', async () => {
    const { provider, client } = buildProvider();
    const session = await provider.prepareSession(destination, meta);

    await session.lifecycle!.finalize();

    expect(client.transition).not.toHaveBeenCalled();
    // Reusable ingest endpoint — never deleted on finalize (see the quota note above).
    expect(client.deleteStream).not.toHaveBeenCalled();
  });

  it('invokes a registered onPhaseChange listener at every phase transition', async () => {
    const client = fakeClient({ getStreamStatus: jest.fn().mockResolvedValue('active') } as any);
    const { provider, runNextScheduledPoll } = buildProvider(client as any);
    const session = await provider.prepareSession(destination, meta);
    const onPhaseChange = jest.fn();
    session.lifecycle!.onPhaseChange!(onPhaseChange);

    session.lifecycle!.onPushStarted(); // creating -> waitingForYoutube
    expect(onPhaseChange).toHaveBeenCalledTimes(1);

    await runNextScheduledPoll(); // waitingForYoutube -> live
    expect(onPhaseChange).toHaveBeenCalledTimes(2);

    await session.lifecycle!.finalize(); // live -> complete
    expect(onPhaseChange).toHaveBeenCalledTimes(3);
  });
});

describe('YoutubeProvider — reusable liveStream and a stable watch URL', () => {
  it('creates a liveStream on the first toggle and persists its id', async () => {
    const { provider, client, destinationRepository } = buildProvider();

    await provider.prepareSession(destination, meta);

    expect(client.getStream).not.toHaveBeenCalled();
    expect(client.createStream).toHaveBeenCalledTimes(1);
    expect(destinationRepository.setYoutubeLiveStreamId).toHaveBeenCalledWith('dest-1', 'stream-1');
  });

  it('reuses the persisted liveStream on every later toggle instead of creating a new one', async () => {
    const { provider, client, destinationRepository } = buildProvider();

    const session = await provider.prepareSession({ id: 'dest-1', youtubeLiveStreamId: 'stream-1' } as any, meta);

    expect(client.getStream).toHaveBeenCalledWith('at', 'stream-1');
    expect(client.createStream).not.toHaveBeenCalled();
    expect(destinationRepository.setYoutubeLiveStreamId).not.toHaveBeenCalled();
    expect(session.rtmpUrl).toBe('rtmp://a.rtmp.youtube.com/live2');
    expect(session.streamKey).toBe('key-1');
    // Only the BROADCAST is ephemeral.
    expect(client.createBroadcast).toHaveBeenCalledTimes(1);
    expect(client.bind).toHaveBeenCalledWith('at', 'broadcast-1', 'stream-1');
  });

  // A stream the user deleted in YouTube Studio comes back as an empty result, not an error.
  it('creates and re-persists a liveStream when the persisted one is gone from YouTube', async () => {
    const client = fakeClient({ getStream: jest.fn().mockResolvedValue(null) });
    const { provider, destinationRepository } = buildProvider(client);

    await provider.prepareSession({ id: 'dest-1', youtubeLiveStreamId: 'deleted-1' } as any, meta);

    expect(client.createStream).toHaveBeenCalledTimes(1);
    expect(destinationRepository.setYoutubeLiveStreamId).toHaveBeenCalledWith('dest-1', 'stream-1');
  });

  // Deleting the reusable stream on every toggle-off is exactly what this change exists to stop.
  it('finalize completes the broadcast and never deletes the liveStream', async () => {
    const { provider, client } = buildProvider();
    const session = await provider.prepareSession(destination, meta);

    session.lifecycle!.onPushStarted();
    await session.lifecycle!.finalize();

    expect(client.transition).toHaveBeenCalledWith('at', 'broadcast-1', 'complete');
    expect(client.deleteStream).not.toHaveBeenCalled();
  });

  // Spec: "the single best fix for 'my viewers' link keeps dying'" — one link that survives every
  // toggle, instead of a fresh per-broadcast URL each time. Only true for a PUBLIC broadcast: the
  // channel /live page never resolves an unlisted or private one, so this needs its own `meta`
  // (the module-level fixture defaults to 'private' — see the next two tests for that case).
  it('reports the channel\'s stable live URL for a public broadcast', async () => {
    const { provider } = buildProvider();
    const session = await provider.prepareSession(destination, { ...meta, privacyStatus: 'public' });

    expect(session.lifecycle!.watchUrl()).toBe('https://www.youtube.com/channel/UC123/live');
  });

  it('falls back to the per-broadcast URL when the connection has no channel id', async () => {
    const { provider } = buildProvider(fakeClient(), {}, '');
    const session = await provider.prepareSession(destination, { ...meta, privacyStatus: 'public' });

    expect(session.lifecycle!.watchUrl()).toBe('https://www.youtube.com/watch?v=broadcast-1');
  });

  // The module-level `meta` fixture defaults to privacyStatus: 'private' — exercise that default
  // explicitly here so this case is asserted by name, not just incidentally by every other test in
  // this file that doesn't override it. The pre-existing `'exposes a watchUrl built from the
  // broadcast id'` test above already covers this input; this test names WHY that's the right
  // answer (a channel id IS known here, and the fallback still wins on privacy grounds).
  it('falls back to the per-broadcast URL for a private broadcast even when a channel id is known', async () => {
    const { provider } = buildProvider();
    const session = await provider.prepareSession(destination, meta);

    expect(session.lifecycle!.watchUrl()).toBe('https://www.youtube.com/watch?v=broadcast-1');
  });

  it('classifies an auth-class rejection for DestinationForward', () => {
    const { provider } = buildProvider();
    expect(provider.isAuthError(new YoutubeApiError(401, null, 'createBroadcast', {}))).toBe(true);
    expect(provider.isAuthError(new Error('network'))).toBe(false);
  });
});
