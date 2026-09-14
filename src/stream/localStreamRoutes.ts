import { Router } from 'express';
import { LocalStreamManager } from './localStreamManager';
import { createLocalStreamPreviewRouter, PreviewFetch } from './localStreamPreviewRoutes';
import { ApiError } from '../errors';
import { wrapAsync } from '../api/errorHandler';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { AuthService } from '../auth/authService';

/**
 * The whole local-stream API surface. Every route is scoped to the authenticated user; there is
 * exactly one local stream per account (see LocalStreamManager), so most routes take no id of any
 * kind and have nothing to address, hence no ownership check to get wrong. The one exception is the
 * destination toggle below, which necessarily carries a destinationId and is ownership-checked by
 * LocalStreamManager itself (404/403 straight through).
 *
 * title/description/privacyStatus/latencyPreference configure a broadcast for any destination
 * provider that creates one (YouTube); custom RTMP destinations ignore them. Phase A omitted these
 * fields because it had no destinations at all — Phase B (this file, from here on) reinstates them.
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

  // Every field except playlistId is optional. destinationIds pre-checks destinations — exactly the
  // same intents a later PUT /destinations/:id would set, so there is one orchestration path rather
  // than two. title/description/privacyStatus/latencyPreference configure any broadcast a
  // destination provider creates (YouTube); they are accepted again here because, unlike Phase A,
  // this API now has destinations. Custom RTMP destinations ignore them.
  router.post('/start', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const { playlistId, templateId, destinationIds, title, description, privacyStatus, latencyPreference } = req.body ?? {};
    if (typeof playlistId !== 'string' || playlistId.length === 0) throw new ApiError(400, 'body.playlistId is required');
    if (templateId !== undefined && (typeof templateId !== 'string' || templateId.length === 0)) {
      throw new ApiError(400, 'body.templateId must be a non-empty string');
    }
    if (destinationIds !== undefined) {
      if (!Array.isArray(destinationIds) || destinationIds.some((id: unknown) => typeof id !== 'string' || id.length === 0)) {
        throw new ApiError(400, 'body.destinationIds must be an array of non-empty strings');
      }
      if (new Set(destinationIds).size !== destinationIds.length) {
        throw new ApiError(400, 'body.destinationIds must not contain duplicates');
      }
    }
    if (title !== undefined && typeof title !== 'string') throw new ApiError(400, 'body.title must be a string');
    if (description !== undefined && typeof description !== 'string') throw new ApiError(400, 'body.description must be a string');
    if (privacyStatus !== undefined && !['public', 'unlisted', 'private'].includes(privacyStatus)) {
      throw new ApiError(400, "body.privacyStatus must be 'public', 'unlisted', or 'private'");
    }
    if (latencyPreference !== undefined && !['normal', 'low', 'ultraLow'].includes(latencyPreference)) {
      throw new ApiError(400, "body.latencyPreference must be 'normal', 'low', or 'ultraLow'");
    }
    const id = userId(req as AuthenticatedRequest);
    await localStreamManager.start(id, playlistId, {
      templateId,
      destinationIds,
      meta: { title, description, privacyStatus, latencyPreference },
    });
    res.status(200).json(localStreamManager.status(id));
  }));

  // Awaited: stop() now also shuts every destination forward down and waits for each provider-side
  // finalize (a YouTube transition-to-complete takes seconds), so the response is truthful about
  // what actually stopped.
  router.post('/stop', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const id = userId(req as AuthenticatedRequest);
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

  // The checkbox. PUT rather than POST because it sets a value idempotently rather than issuing a
  // command, and it carries the destination id in the URL — but it still goes through
  // requireJsonRequest, because a PUT with a JSON content-type is what forces the browser preflight
  // this app's CORS policy then has to approve.
  router.put('/destinations/:destinationId', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const { desired } = req.body ?? {};
    if (desired !== 'on' && desired !== 'off') throw new ApiError(400, "body.desired must be 'on' or 'off'");
    const id = userId(req as AuthenticatedRequest);
    const status = await localStreamManager.setDestinationDesired(id, req.params.destinationId, desired);
    res.status(200).json(status);
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
