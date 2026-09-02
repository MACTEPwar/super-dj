import { Router } from 'express';
import { StreamManager } from './streamManager';
import { StreamSessionManager, StreamSessionStatus } from './streamSessionManager';
import { ApiError } from '../errors';
import { wrapAsync } from '../api/errorHandler';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { AuthService } from '../auth/authService';

export function createStreamSessionRouter(
  authService: AuthService,
  streamSessionManager: StreamSessionManager,
  streamManager: Pick<StreamManager, 'on' | 'off' | 'status'>,
): Router {
  const router = Router();
  const auth = requireAuth(authService);
  const userId = (req: AuthenticatedRequest) => req.user!.id;

  router.post('/', auth, wrapAsync(async (req, res) => {
    const { playlistId, destinationIds, title, description, privacyStatus, latencyPreference } = req.body ?? {};
    if (typeof playlistId !== 'string' || playlistId.length === 0) throw new ApiError(400, 'body.playlistId is required');
    if (!Array.isArray(destinationIds) || destinationIds.some((id: unknown) => typeof id !== 'string')) {
      throw new ApiError(400, 'body.destinationIds must be an array of strings');
    }
    if (title !== undefined && typeof title !== 'string') throw new ApiError(400, 'body.title must be a string');
    if (description !== undefined && typeof description !== 'string') throw new ApiError(400, 'body.description must be a string');
    if (privacyStatus !== undefined && !['public', 'unlisted', 'private'].includes(privacyStatus)) {
      throw new ApiError(400, "body.privacyStatus must be 'public', 'unlisted', or 'private'");
    }
    if (latencyPreference !== undefined && !['normal', 'low', 'ultraLow'].includes(latencyPreference)) {
      throw new ApiError(400, "body.latencyPreference must be 'normal', 'low', or 'ultraLow'");
    }
    const result = await streamSessionManager.create(
      userId(req as AuthenticatedRequest), playlistId, destinationIds, { title, description, privacyStatus, latencyPreference },
    );
    res.status(200).json(result);
  }));

  router.get('/', auth, wrapAsync(async (req, res) => {
    const result = await streamSessionManager.list(userId(req as AuthenticatedRequest));
    res.status(200).json(result);
  }));

  router.get('/:id/status', auth, wrapAsync(async (req, res) => {
    const result = await streamSessionManager.status(userId(req as AuthenticatedRequest), req.params.id);
    res.status(200).json(result);
  }));

  router.post('/:id/pause', auth, wrapAsync(async (req, res) => {
    const result = await streamSessionManager.pause(userId(req as AuthenticatedRequest), req.params.id);
    res.status(200).json(result);
  }));

  router.post('/:id/resume', auth, wrapAsync(async (req, res) => {
    const result = await streamSessionManager.resume(userId(req as AuthenticatedRequest), req.params.id);
    res.status(200).json(result);
  }));

  router.post('/:id/next', auth, wrapAsync(async (req, res) => {
    const result = await streamSessionManager.next(userId(req as AuthenticatedRequest), req.params.id);
    res.status(200).json(result);
  }));

  router.post('/:id/previous', auth, wrapAsync(async (req, res) => {
    const result = await streamSessionManager.previous(userId(req as AuthenticatedRequest), req.params.id);
    res.status(200).json(result);
  }));

  router.post('/:id/stop', auth, wrapAsync(async (req, res) => {
    const result = await streamSessionManager.stop(userId(req as AuthenticatedRequest), req.params.id);
    res.status(200).json(result);
  }));

  router.delete('/:id', auth, wrapAsync(async (req, res) => {
    await streamSessionManager.deleteById(userId(req as AuthenticatedRequest), req.params.id);
    res.status(200).json({});
  }));

  router.get('/:id/events', auth, wrapAsync(async (req, res) => {
    const sessionId = req.params.id;
    // Validates ownership (404/403) and captures the fixed set of member destinations —
    // a session's destinationIds never change after creation, so this list doesn't need
    // to be re-read from the DB on every event tick below.
    const initial = await streamSessionManager.status(userId(req as AuthenticatedRequest), sessionId);
    const destinationIds = initial.destinations.map((d) => d.destinationId);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const buildStatus = (): StreamSessionStatus => ({
      id: sessionId,
      playlistId: initial.playlistId,
      destinations: destinationIds.map((destinationId) => ({ destinationId, status: streamManager.status(destinationId) })),
    });

    const send = (): void => { res.write(`data: ${JSON.stringify(buildStatus())}\n\n`); };
    send();

    const listener = (destinationId: string): void => {
      if (destinationIds.includes(destinationId)) send();
    };
    streamManager.on('statusChanged', listener);

    // Keeps intermediary proxies/load balancers from timing out an otherwise-idle connection.
    const heartbeat = setInterval(() => { res.write(':heartbeat\n\n'); }, 20000);

    req.on('close', () => {
      streamManager.off('statusChanged', listener);
      clearInterval(heartbeat);
    });
  }));

  return router;
}
