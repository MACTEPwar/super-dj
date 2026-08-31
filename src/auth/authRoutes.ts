import { Router } from 'express';
import { AuthService } from './authService';
import { ApiError } from '../errors';
import { wrapAsync } from '../api/errorHandler';
import { buildSessionCookie, clearSessionCookie, getSessionIdFromCookieHeader } from './sessionCookie';
import { requireAuth, AuthenticatedRequest } from './authMiddleware';

function readCredentials(body: unknown): { email: string; password: string } {
  const { email, password } = (body ?? {}) as { email?: unknown; password?: unknown };
  if (typeof email !== 'string' || email.trim().length === 0) throw new ApiError(400, 'body.email is required');
  if (typeof password !== 'string' || password.length === 0) throw new ApiError(400, 'body.password is required');
  return { email: email.trim().toLowerCase(), password };
}

export function createAuthRouter(authService: AuthService): Router {
  const router = Router();

  router.post('/register', wrapAsync(async (req, res) => {
    const { email, password } = readCredentials(req.body);
    const { user, sessionId, expiresAt } = await authService.register(email, password);
    res.setHeader('Set-Cookie', buildSessionCookie(sessionId, expiresAt));
    res.status(200).json(user);
  }));

  router.post('/login', wrapAsync(async (req, res) => {
    const { email, password } = readCredentials(req.body);
    const { user, sessionId, expiresAt } = await authService.login(email, password);
    res.setHeader('Set-Cookie', buildSessionCookie(sessionId, expiresAt));
    res.status(200).json(user);
  }));

  router.post('/logout', wrapAsync(async (req, res) => {
    const sessionId = getSessionIdFromCookieHeader(req.headers.cookie);
    if (sessionId) await authService.logout(sessionId);
    res.setHeader('Set-Cookie', clearSessionCookie());
    res.status(200).json({});
  }));

  router.get('/me', requireAuth(authService), wrapAsync(async (req, res) => {
    res.status(200).json((req as AuthenticatedRequest).user);
  }));

  return router;
}
