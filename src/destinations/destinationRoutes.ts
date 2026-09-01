import { Router } from 'express';
import { DestinationRepository } from './destinationRepository';
import { encrypt } from '../crypto/streamKeyCipher';
import { ApiError } from '../errors';
import { wrapAsync } from '../api/errorHandler';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { AuthService } from '../auth/authService';
import { StreamManager } from '../stream/streamManager';

function toPublicDestination(d: { id: string; name: string; rtmpUrl: string; provider: string }) {
  return { id: d.id, name: d.name, rtmpUrl: d.rtmpUrl, provider: d.provider };
}

export function createDestinationRouter(
  authService: AuthService,
  destinationRepository: DestinationRepository,
  encryptionKey: string,
  streamManager: Pick<StreamManager, 'stop'>,
): Router {
  const router = Router();
  const auth = requireAuth(authService);

  router.post('/', auth, wrapAsync(async (req, res) => {
    const { name, rtmpUrl, streamKey } = req.body ?? {};
    if (typeof name !== 'string' || name.length === 0) throw new ApiError(400, 'body.name is required');
    if (typeof rtmpUrl !== 'string' || rtmpUrl.length === 0) throw new ApiError(400, 'body.rtmpUrl is required');
    if (typeof streamKey !== 'string' || streamKey.length === 0) throw new ApiError(400, 'body.streamKey is required');

    const destination = await destinationRepository.create({
      userId: (req as AuthenticatedRequest).user!.id,
      name,
      rtmpUrl,
      streamKeyEncrypted: encrypt(streamKey, encryptionKey),
    });
    res.status(200).json(toPublicDestination(destination));
  }));

  router.get('/', auth, wrapAsync(async (req, res) => {
    const destinations = await destinationRepository.listByUser((req as AuthenticatedRequest).user!.id);
    res.status(200).json(destinations.map(toPublicDestination));
  }));

  router.delete('/:id', auth, wrapAsync(async (req, res) => {
    const destination = await destinationRepository.findById(req.params.id);
    if (!destination) throw new ApiError(404, 'destination not found');
    if (destination.userId !== (req as AuthenticatedRequest).user!.id) throw new ApiError(403, 'not your destination');
    // Tear down any running stream first, otherwise its StreamController/ffmpeg/FIFO
    // is orphaned: /stop would 404 once the destination row is gone.
    try {
      await streamManager.stop(destination.id);
    } catch (err) {
      // 409 from stop() just means "wasn't streaming" — not a failure.
      if (!(err instanceof ApiError && err.status === 409)) throw err;
    }
    await destinationRepository.deleteById(destination.id);
    res.status(200).json({});
  }));

  return router;
}
