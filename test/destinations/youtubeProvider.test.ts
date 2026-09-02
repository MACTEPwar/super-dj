import { YoutubeProvider } from '../../src/destinations/youtubeProvider';
import { encrypt } from '../../src/crypto/streamKeyCipher';

const KEY = 'a'.repeat(64);

function fakeClient(overrides: Record<string, jest.Mock> = {}) {
  return {
    refreshAccessToken: jest.fn().mockResolvedValue('at'),
    createBroadcast: jest.fn().mockResolvedValue({ id: 'broadcast-1' }),
    createStream: jest.fn().mockResolvedValue({ id: 'stream-1', ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2', streamName: 'key-1' }),
    bind: jest.fn().mockResolvedValue(undefined),
    transition: jest.fn().mockResolvedValue(undefined),
    getStreamStatus: jest.fn().mockResolvedValue('active'),
    deleteStream: jest.fn().mockResolvedValue(undefined),
    exchangeCode: jest.fn(), revoke: jest.fn(), getChannel: jest.fn(),
    ...overrides,
  };
}

function buildProvider(client = fakeClient(), extra: Record<string, unknown> = {}) {
  const oauthConnectionRepository = {
    findByDestinationId: jest.fn().mockResolvedValue({ refreshTokenEncrypted: encrypt('refresh-token', KEY) }),
  };
  // Drives the poll loop deterministically instead of waiting on real timers.
  const scheduled: Array<() => void | Promise<void>> = [];
  const scheduleNextPoll = jest.fn((fn: () => void | Promise<void>) => { scheduled.push(fn); });
  const provider = new YoutubeProvider({ client: client as any, encryptionKey: KEY, oauthConnectionRepository, scheduleNextPoll, ...extra });
  const runNextScheduledPoll = async () => {
    const fn = scheduled.shift();
    if (fn) await fn();
  };
  return { provider, client, oauthConnectionRepository, runNextScheduledPoll, scheduled };
}

const destination = { id: 'dest-1' } as any;
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
    expect(client.deleteStream).toHaveBeenCalledWith('at', 'stream-1');
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

  it('finalize() transitions the broadcast to complete and deletes the ephemeral stream', async () => {
    const { provider, client } = buildProvider();
    const session = await provider.prepareSession(destination, meta);
    session.lifecycle!.onPushStarted();

    await session.lifecycle!.finalize();

    expect(client.transition).toHaveBeenCalledWith('at', 'broadcast-1', 'complete');
    expect(client.deleteStream).toHaveBeenCalledWith('at', 'stream-1');
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
    expect(client.deleteStream).toHaveBeenCalled();
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
