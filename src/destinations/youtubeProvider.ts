import { StreamDestination } from '@prisma/client';
import { ApiError } from '../errors';
import { decrypt } from '../crypto/streamKeyCipher';
import { YoutubeApiClient, YoutubeStream, isAuthClassError } from './youtubeApiClient';
import { OAuthConnectionRepository } from './oauthConnectionRepository';
import { DestinationRepository } from './destinationRepository';
import { BroadcastMeta, DestinationLifecycle, DestinationLifecyclePhase, PreparedSession, StreamDestinationProvider } from './streamDestinationProvider';

export interface YoutubeProviderDeps {
  client: YoutubeApiClient;
  encryptionKey: string;
  oauthConnectionRepository: Pick<OAuthConnectionRepository, 'findByDestinationId'>;
  // Needed because the liveStream (the ingest endpoint) is now REUSED across toggles and therefore
  // has to be remembered on the destination row. Only the liveBroadcast stays ephemeral.
  destinationRepository: Pick<DestinationRepository, 'setYoutubeLiveStreamId'>;
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

  // Lets DestinationForward show "reconnect your YouTube account" instead of a generic failure,
  // and stops it retrying a grant that will never come back, without knowing anything about the
  // YouTube API itself.
  isAuthError(err: unknown): boolean {
    return isAuthClassError(err);
  }

  async prepareSession(destination: StreamDestination, meta: BroadcastMeta): Promise<PreparedSession> {
    const connection = await this.deps.oauthConnectionRepository.findByDestinationId(destination.id);
    if (!connection) throw new ApiError(502, 'no YouTube connection for this destination');
    const refreshToken = decrypt(connection.refreshTokenEncrypted, this.deps.encryptionKey);

    const accessToken = await this.deps.client.refreshAccessToken(refreshToken);

    // The liveStream is reused across every toggle of this destination; only the broadcast below is
    // ephemeral. A persisted id can still be stale (the user deleted the stream in YouTube Studio),
    // which YouTube reports as an empty result rather than an error — so verify, then fall back to
    // creating a fresh one and re-persisting it.
    let stream: YoutubeStream | null = null;
    if (destination.youtubeLiveStreamId) {
      stream = await this.deps.client.getStream(accessToken, destination.youtubeLiveStreamId);
    }
    if (!stream) {
      stream = await this.deps.client.createStream(accessToken, { title: meta.title });
      await this.deps.destinationRepository.setYoutubeLiveStreamId(destination.id, stream.id);
    }

    const broadcast = await this.deps.client.createBroadcast(accessToken, {
      title: meta.title, description: meta.description ?? '', privacyStatus: meta.privacyStatus ?? 'private',
      latencyPreference: meta.latencyPreference ?? 'normal',
    });
    await this.deps.client.bind(accessToken, broadcast.id, stream.id);

    let phase: DestinationLifecyclePhase = 'creating';
    let pushStarted = false;
    let finalized = false;
    let authErrorSeen = false;
    let phaseChangeListener: (() => void) | null = null;

    // Finalizes and leaves phase at the terminal 'error' (not finalize()'s own 'complete') —
    // shared by the health-check timeout and the auth-class short-circuit below, both of which
    // mean "this destination is done, stop polling and don't let anything (including a reconnect
    // attempt) try to keep using it." finalize() itself sets phase to 'complete' and notifies
    // (that's the right outcome for a normal user-initiated stop) — this overwrites it with
    // 'error' afterward and notifies again, so a listener reacting to the phase (DestinationForward
    // stopping the owning relay — see its onProviderPhaseChanged) observes the terminal-failure
    // phase, not the "user stopped it on purpose" one.
    const giveUp = async (): Promise<void> => {
      await lifecycle.finalize();
      phase = 'error';
      phaseChangeListener?.();
    };

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
            if (isAuthClassError(err)) {
              // A revoked/expired grant will never resolve itself by waiting — short-circuit
              // instead of retrying silently for the rest of the (up to 90s) timeout window.
              authErrorSeen = true;
              await giveUp();
              return;
            }
          }
          if (finalized) return;
          if (this.clock() >= deadline) {
            await giveUp();
            return;
          }
          this.scheduleNextPoll(() => poll(), this.pollIntervalMs);
        };
        this.scheduleNextPoll(() => poll(), this.pollIntervalMs);
      },

      phase: () => phase,
      // One link that survives every toggle. A per-broadcast watch?v= URL dies the moment the user
      // toggles this destination off, and nobody following the old link migrates automatically —
      // the channel's own /live page always points at whatever that channel is broadcasting now.
      // BUT the channel /live page only ever resolves to a PUBLIC broadcast — YouTube does not
      // surface an unlisted or private one there at all, so for anything but 'public' the stable
      // link would 404 for the owner's own viewers, replacing a watch?v= URL that worked. Fall
      // back to the per-broadcast URL for exactly that case; this is also why the fallback for "no
      // channel id known" reuses the same expression rather than needing a second one.
      watchUrl: () => (connection.externalAccountId && meta.privacyStatus === 'public'
        ? `https://www.youtube.com/channel/${connection.externalAccountId}/live`
        : `https://www.youtube.com/watch?v=${broadcast.id}`),
      onPhaseChange: (cb) => { phaseChangeListener = cb; },
      isAuthError: () => authErrorSeen,

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
        // The liveStream is deliberately NOT deleted: it is this destination's reusable ingest
        // endpoint, persisted on the row and reused by the next toggle-on. Deleting it here is what
        // used to cost an extra insert+delete per toggle and what used to leave an orphaned stream
        // behind whenever finalize's own token refresh failed.
        phase = 'complete';
        phaseChangeListener?.();
      },
    };

    return { rtmpUrl: stream.ingestionAddress, streamKey: stream.streamName, lifecycle };
  }
}
