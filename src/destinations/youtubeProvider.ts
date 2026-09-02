import { StreamDestination } from '@prisma/client';
import { ApiError } from '../errors';
import { decrypt } from '../crypto/streamKeyCipher';
import { YoutubeApiClient } from './youtubeApiClient';
import { OAuthConnectionRepository } from './oauthConnectionRepository';
import { BroadcastMeta, DestinationLifecycle, DestinationLifecyclePhase, PreparedSession, StreamDestinationProvider } from './streamDestinationProvider';

export interface YoutubeProviderDeps {
  client: YoutubeApiClient;
  encryptionKey: string;
  oauthConnectionRepository: Pick<OAuthConnectionRepository, 'findByDestinationId'>;
  pollIntervalMs?: number;
  healthTimeoutMs?: number;
  scheduleNextPoll?: (fn: () => void | Promise<void>, delayMs: number) => void;
  clock?: () => number;
}

export class YoutubeProvider implements StreamDestinationProvider {
  private readonly pollIntervalMs: number;
  private readonly healthTimeoutMs: number;
  private readonly scheduleNextPoll: (fn: () => void | Promise<void>, delayMs: number) => void;
  private readonly clock: () => number;

  constructor(private readonly deps: YoutubeProviderDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? 3000;
    this.healthTimeoutMs = deps.healthTimeoutMs ?? 90000;
    this.scheduleNextPoll = deps.scheduleNextPoll ?? ((fn, delayMs) => { setTimeout(fn, delayMs); });
    this.clock = deps.clock ?? Date.now;
  }

  async prepareSession(destination: StreamDestination, meta: BroadcastMeta): Promise<PreparedSession> {
    const connection = await this.deps.oauthConnectionRepository.findByDestinationId(destination.id);
    if (!connection) throw new ApiError(502, 'no YouTube connection for this destination');
    const refreshToken = decrypt(connection.refreshTokenEncrypted, this.deps.encryptionKey);

    const accessToken = await this.deps.client.refreshAccessToken(refreshToken);
    const broadcast = await this.deps.client.createBroadcast(accessToken, {
      title: meta.title, description: meta.description ?? '', privacyStatus: meta.privacyStatus ?? 'private',
    });
    const stream = await this.deps.client.createStream(accessToken, { title: meta.title });
    await this.deps.client.bind(accessToken, broadcast.id, stream.id);

    let phase: DestinationLifecyclePhase = 'creating';
    let pushStarted = false;
    let finalized = false;
    let phaseChangeListener: (() => void) | null = null;

    const lifecycle: DestinationLifecycle = {
      onPushStarted: () => {
        if (pushStarted) return;
        pushStarted = true;
        phase = 'waitingForYoutube';
        phaseChangeListener?.();
        const deadline = this.clock() + this.healthTimeoutMs;

        const poll = async (): Promise<void> => {
          if (finalized) return;
          try {
            const freshAccessToken = await this.deps.client.refreshAccessToken(refreshToken);
            const status = await this.deps.client.getStreamStatus(freshAccessToken, stream.id);
            // Re-check after every await: finalize() (e.g. the user hit /stream/stop) may have
            // completed while this poll was suspended above. Without this, a poll that was
            // already in flight when finalize() ran would still transition the broadcast to
            // 'live' and overwrite the 'complete' phase finalize() just set — the same class of
            // stale-async-result hazard StreamController.feedCurrentTrack already guards against.
            if (finalized) return;
            if (status === 'active') {
              await this.deps.client.transition(freshAccessToken, broadcast.id, 'live');
              phase = 'live';
              phaseChangeListener?.();
              return;
            }
          } catch (err) {
            console.error('YouTube health-check poll failed', err);
          }
          if (this.clock() >= deadline) {
            await lifecycle.finalize();
            phase = 'error';
            return;
          }
          this.scheduleNextPoll(() => poll(), this.pollIntervalMs);
        };
        this.scheduleNextPoll(() => poll(), this.pollIntervalMs);
      },

      phase: () => phase,
      watchUrl: () => `https://www.youtube.com/watch?v=${broadcast.id}`,
      onPhaseChange: (cb) => { phaseChangeListener = cb; },

      finalize: async () => {
        if (finalized) return;
        finalized = true;
        if (pushStarted) {
          try {
            const accessToken2 = await this.deps.client.refreshAccessToken(refreshToken);
            await this.deps.client.transition(accessToken2, broadcast.id, 'complete');
          } catch (err) {
            console.error('failed to transition YouTube broadcast to complete', err);
          }
        }
        try {
          const accessToken3 = await this.deps.client.refreshAccessToken(refreshToken);
          await this.deps.client.deleteStream(accessToken3, stream.id);
        } catch (err) {
          console.error('failed to delete ephemeral YouTube liveStream', err);
        }
        phase = 'complete';
        phaseChangeListener?.();
      },
    };

    return { rtmpUrl: stream.ingestionAddress, streamKey: stream.streamName, lifecycle };
  }
}
