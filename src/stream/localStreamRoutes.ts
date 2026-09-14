import { Router } from 'express';
import { LocalStreamManager } from './localStreamManager';
import { createLocalStreamPreviewRouter, PreviewFetch } from './localStreamPreviewRoutes';
import { ApiError } from '../errors';
import { wrapAsync } from '../api/errorHandler';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { AuthService } from '../auth/authService';

/**
 * The whole local-stream API surface. Every route is scoped to the authenticated user and takes no
 * id of any kind: there is exactly one local stream per account (see LocalStreamManager), so there
 * is nothing to address and therefore no ownership check to get wrong.
 *
 * Deliberately absent: title/description/privacyStatus/latencyPreference. Those configure a
 * provider's live broadcast, and Phase A has no destinations at all — accepting them here would
 * tell a caller it had configured something that does not exist.
 */
// The session cookie is `SameSite=None; Secure` in production (sessionCookie.ts), so it rides on
// cross-site requests. A route with no id and no ownership check to get wrong (see doc comment
// above) also has no accidental CSRF token — unlike /destinations/{id}/... or /stream-sessions/
// {id}/..., which at least require an unguessable id an attacker's page wouldn't know. A plain
// cross-origin HTML form POST is a CORS "simple request" (no preflight; only the RESPONSE is
// blocked by CORS, not the side effect) unless the request either carries a body Express won't
// parse as one of the three form-safelisted content types, or triggers a preflight some other way.
// Requiring JSON does both: `express.json()` only populates `req.body` for
// `application/json`, and a JSON content-type is not one of the three CORS-safelisted form types,
// so the browser preflights it — which our CORS config then has to actually approve.
function requireJsonRequest(req: AuthenticatedRequest, _res: unknown, next: (err?: unknown) => void) {
  if (!req.is('application/json')) {
    next(new ApiError(400, 'Content-Type: application/json is required'));
    return;
  }
  next();
}

export function createLocalStreamRouter(
  authService: AuthService,
  localStreamManager: LocalStreamManager,
  previewFetch: PreviewFetch,
): Router {
  const router = Router();
  const auth = requireAuth(authService);
  const userId = (req: AuthenticatedRequest) => req.user!.id;

  router.post('/start', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const { playlistId, templateId } = req.body ?? {};
    if (typeof playlistId !== 'string' || playlistId.length === 0) throw new ApiError(400, 'body.playlistId is required');
    if (templateId !== undefined && (typeof templateId !== 'string' || templateId.length === 0)) {
      throw new ApiError(400, 'body.templateId must be a non-empty string');
    }
    const id = userId(req as AuthenticatedRequest);
    await localStreamManager.start(id, playlistId, { templateId });
    res.status(200).json(localStreamManager.status(id));
  }));

  router.post('/stop', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const id = userId(req as AuthenticatedRequest);
    // Awaited because stop() is async as of Phase B: it also shuts every destination forward down
    // and waits for each provider-side finalize. Unawaited, its 409 for an inactive stream would
    // escape wrapAsync as an unhandled rejection (fatal under Node 20's default) instead of a
    // response. Task 7 rewrites this handler; the await must not wait for it.
    await localStreamManager.stop(id);
    res.status(200).json(localStreamManager.status(id));
  }));

  router.post('/pause', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const id = userId(req as AuthenticatedRequest);
    localStreamManager.pause(id);
    res.status(200).json(localStreamManager.status(id));
  }));

  router.post('/resume', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const id = userId(req as AuthenticatedRequest);
    await localStreamManager.resume(id);
    res.status(200).json(localStreamManager.status(id));
  }));

  router.post('/next', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const id = userId(req as AuthenticatedRequest);
    await localStreamManager.next(id);
    res.status(200).json(localStreamManager.status(id));
  }));

  router.post('/previous', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const id = userId(req as AuthenticatedRequest);
    await localStreamManager.previous(id);
    res.status(200).json(localStreamManager.status(id));
  }));

  router.post('/play', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const { name } = req.body ?? {};
    if (typeof name !== 'string' || name.length === 0) throw new ApiError(400, 'body.name is required');
    const id = userId(req as AuthenticatedRequest);
    localStreamManager.playByName(id, name);
    res.status(200).json(localStreamManager.status(id));
  }));

  router.get('/status', auth, wrapAsync(async (req, res) => {
    res.status(200).json(localStreamManager.status(userId(req as AuthenticatedRequest)));
  }));

  router.get('/events', auth, wrapAsync(async (req, res) => {
    const id = userId(req as AuthenticatedRequest);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (): void => { res.write(`data: ${JSON.stringify(localStreamManager.status(id))}\n\n`); };
    send();

    const listener = (changedUserId: string): void => {
      if (changedUserId === id) send();
    };
    localStreamManager.on('statusChanged', listener);

    // Keeps intermediary proxies/load balancers from timing out an otherwise-idle connection.
    const heartbeat = setInterval(() => { res.write(':heartbeat\n\n'); }, 20000);

    req.on('close', () => {
      localStreamManager.off('statusChanged', listener);
      clearInterval(heartbeat);
    });
  }));

  router.use('/preview', createLocalStreamPreviewRouter(authService, localStreamManager, previewFetch));

  return router;
}
