import { Router } from 'express';
import { PlaylistRepository } from './playlistRepository';
import { ApiError } from '../errors';
import { wrapAsync } from '../api/errorHandler';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { AuthService } from '../auth/authService';

async function requireOwnedPlaylist(playlistRepository: PlaylistRepository, id: string, userId: string) {
  const playlist = await playlistRepository.findById(id);
  if (!playlist) throw new ApiError(404, 'playlist not found');
  if (playlist.userId !== userId) throw new ApiError(403, 'not your playlist');
  return playlist;
}

export function createPlaylistRouter(authService: AuthService, playlistRepository: PlaylistRepository): Router {
  const router = Router();
  const auth = requireAuth(authService);

  router.post('/', auth, wrapAsync(async (req, res) => {
    const { name } = req.body ?? {};
    if (typeof name !== 'string' || name.length === 0) throw new ApiError(400, 'body.name is required');
    const playlist = await playlistRepository.create((req as AuthenticatedRequest).user!.id, name);
    res.status(200).json({ id: playlist.id, name: playlist.name });
  }));

  router.get('/', auth, wrapAsync(async (req, res) => {
    const playlists = await playlistRepository.listByUser((req as AuthenticatedRequest).user!.id);
    res.status(200).json(playlists.map((p) => ({ id: p.id, name: p.name })));
  }));

  router.get('/:id', auth, wrapAsync(async (req, res) => {
    const playlist = await requireOwnedPlaylist(playlistRepository, req.params.id, (req as AuthenticatedRequest).user!.id);
    const tracks = await playlistRepository.listTracks(playlist.id);
    res.status(200).json({ id: playlist.id, name: playlist.name, tracks });
  }));

  router.put('/:id/tracks', auth, wrapAsync(async (req, res) => {
    const playlist = await requireOwnedPlaylist(playlistRepository, req.params.id, (req as AuthenticatedRequest).user!.id);
    const { trackIds } = req.body ?? {};
    if (!Array.isArray(trackIds) || !trackIds.every((id) => typeof id === 'string')) {
      throw new ApiError(400, 'body.trackIds must be an array of strings');
    }
    await playlistRepository.replaceTracks(playlist.id, trackIds);
    res.status(200).json({});
  }));

  router.delete('/:id', auth, wrapAsync(async (req, res) => {
    const playlist = await requireOwnedPlaylist(playlistRepository, req.params.id, (req as AuthenticatedRequest).user!.id);
    await playlistRepository.deleteById(playlist.id);
    res.status(200).json({});
  }));

  return router;
}
