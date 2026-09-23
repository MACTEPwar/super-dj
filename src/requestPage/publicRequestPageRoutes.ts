import { Router } from 'express';
import { wrapAsync } from '../api/errorHandler';
import { ApiError } from '../errors';
import { UserRepository } from '../auth/userRepository';
import { PlaylistRepository } from '../playlists/playlistRepository';
import { InteractionRuleRepository } from '../donations/interactionRuleRepository';
import { LocalStreamManager } from '../stream/localStreamManager';
import { REQUEST_PAGE_TOKEN_PATTERN } from './requestPageRoutes';

export interface PublicRequestPageDeps {
  users: Pick<UserRepository, 'findByRequestPageToken'>;
  streams: Pick<LocalStreamManager, 'status'>;
  playlists: Pick<PlaylistRepository, 'findById' | 'listTracks'>;
  rules: Pick<InteractionRuleRepository, 'listEnabledByUser'>;
}

export type PublicRequestPage =
  | { live: false }
  | {
      live: true;
      playlistName: string;
      tracks: { id: string; name: string; durationSeconds: number | null }[];
      request: { keyword: string; minAmount: number } | null;
    };

const LIVE_STATES = new Set(['streaming', 'paused', 'reconnecting']);

/**
 * The ONE unauthenticated read in the app besides auth itself. The token is the access control:
 * it resolves to exactly one user, and the playlist is read from THAT user's own in-memory stream
 * entry — nothing in the request names a playlist, track or user id, so there is nothing to swap.
 * Only names/ids/durations leave this route; never paths, covers, emails or queue state.
 */
export function createPublicRequestPageRouter(deps: PublicRequestPageDeps): Router {
  const router = Router();

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  router.get('/:token', wrapAsync(async (req, res) => {
    const { token } = req.params;
    // Reject by shape before any DB call; same 404 as an unknown token so the two are indistinguishable.
    if (!REQUEST_PAGE_TOKEN_PATTERN.test(token)) throw new ApiError(404, 'request page not found');
    const user = await deps.users.findByRequestPageToken(token);
    if (!user) throw new ApiError(404, 'request page not found');

    const { local } = deps.streams.status(user.id);
    if (!LIVE_STATES.has(local.state) || !local.playlistId) {
      const body: PublicRequestPage = { live: false };
      res.status(200).json(body);
      return;
    }

    const [playlist, tracks, rules] = await Promise.all([
      deps.playlists.findById(local.playlistId),
      deps.playlists.listTracks(local.playlistId),
      deps.rules.listEnabledByUser(user.id),
    ]);
    const cheapest = rules
      .filter((r) => r.actionType === 'libraryTrackRequest')
      .sort((a, b) => a.minAmount - b.minAmount)[0];

    const body: PublicRequestPage = {
      live: true,
      playlistName: playlist?.name ?? '',
      tracks: tracks.map((t) => ({ id: t.id, name: t.name, durationSeconds: t.durationSeconds })),
      request: cheapest ? { keyword: cheapest.commandKeyword, minAmount: cheapest.minAmount } : null,
    };
    res.status(200).json(body);
  }));

  return router;
}
