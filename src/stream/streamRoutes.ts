import { Router } from 'express';
import { StreamManager } from './streamManager';
import { DestinationRepository } from '../destinations/destinationRepository';
import { ApiError } from '../errors';
import { wrapAsync } from '../api/errorHandler';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { AuthService } from '../auth/authService';

async function requireOwnedDestination(
  destinationRepository: Pick<DestinationRepository, 'findById'>,
  destinationId: string,
  userId: string,
): Promise<void> {
  const destination = await destinationRepository.findById(destinationId);
  if (!destination) throw new ApiError(404, 'destination not found');
  if (destination.userId !== userId) throw new ApiError(403, 'not your destination');
}

export function createStreamRouter(
  authService: AuthService,
  streamManager: StreamManager,
  destinationRepository: Pick<DestinationRepository, 'findById'>,
): Router {
  const router = Router({ mergeParams: true });
  const auth = requireAuth(authService);
  const userId = (req: AuthenticatedRequest) => req.user!.id;

  router.post('/start', auth, wrapAsync(async (req, res) => {
    const destinationId = req.params.destinationId;
    await requireOwnedDestination(destinationRepository, destinationId, userId(req as AuthenticatedRequest));
    const { playlistId, title, description, privacyStatus } = req.body ?? {};
    if (typeof playlistId !== 'string' || playlistId.length === 0) throw new ApiError(400, 'body.playlistId is required');
    if (title !== undefined && typeof title !== 'string') throw new ApiError(400, 'body.title must be a string');
    if (description !== undefined && typeof description !== 'string') throw new ApiError(400, 'body.description must be a string');
    if (privacyStatus !== undefined && !['public', 'unlisted', 'private'].includes(privacyStatus)) {
      throw new ApiError(400, "body.privacyStatus must be 'public', 'unlisted', or 'private'");
    }
    await streamManager.start(destinationId, playlistId, { title, description, privacyStatus });
    res.status(200).json(streamManager.status(destinationId));
  }));

  router.post('/stop', auth, wrapAsync(async (req, res) => {
    const destinationId = req.params.destinationId;
    await requireOwnedDestination(destinationRepository, destinationId, userId(req as AuthenticatedRequest));
    await streamManager.stop(destinationId);
    res.status(200).json(streamManager.status(destinationId));
  }));

  router.post('/pause', auth, wrapAsync(async (req, res) => {
    const destinationId = req.params.destinationId;
    await requireOwnedDestination(destinationRepository, destinationId, userId(req as AuthenticatedRequest));
    streamManager.pause(destinationId);
    res.status(200).json(streamManager.status(destinationId));
  }));

  router.post('/resume', auth, wrapAsync(async (req, res) => {
    const destinationId = req.params.destinationId;
    await requireOwnedDestination(destinationRepository, destinationId, userId(req as AuthenticatedRequest));
    await streamManager.resume(destinationId);
    res.status(200).json(streamManager.status(destinationId));
  }));

  router.post('/next', auth, wrapAsync(async (req, res) => {
    const destinationId = req.params.destinationId;
    await requireOwnedDestination(destinationRepository, destinationId, userId(req as AuthenticatedRequest));
    await streamManager.next(destinationId);
    res.status(200).json(streamManager.status(destinationId));
  }));

  router.post('/previous', auth, wrapAsync(async (req, res) => {
    const destinationId = req.params.destinationId;
    await requireOwnedDestination(destinationRepository, destinationId, userId(req as AuthenticatedRequest));
    await streamManager.previous(destinationId);
    res.status(200).json(streamManager.status(destinationId));
  }));

  router.post('/play', auth, wrapAsync(async (req, res) => {
    const destinationId = req.params.destinationId;
    await requireOwnedDestination(destinationRepository, destinationId, userId(req as AuthenticatedRequest));
    const { name } = req.body ?? {};
    if (typeof name !== 'string' || name.length === 0) throw new ApiError(400, 'body.name is required');
    streamManager.playByName(destinationId, name);
    res.status(200).json(streamManager.status(destinationId));
  }));

  router.get('/status', auth, wrapAsync(async (req, res) => {
    const destinationId = req.params.destinationId;
    await requireOwnedDestination(destinationRepository, destinationId, userId(req as AuthenticatedRequest));
    res.status(200).json(streamManager.status(destinationId));
  }));

  return router;
}
