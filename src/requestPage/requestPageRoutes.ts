import { Router } from 'express';
import { randomBytes } from 'crypto';
import { AuthService } from '../auth/authService';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { UserRepository } from '../auth/userRepository';
import { wrapAsync } from '../api/errorHandler';
import { ApiError } from '../errors';

// Same shape as LocalRelayTarget's MediaMTX path token: 128 random bits, lowercase hex. The public
// route rejects anything else by shape before touching the database.
export const REQUEST_PAGE_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

export function generateRequestPageToken(): string {
  return randomBytes(16).toString('hex');
}

function requireJsonRequest(req: AuthenticatedRequest, _res: unknown, next: (err?: unknown) => void) {
  if (!req.is('application/json')) {
    next(new ApiError(400, 'Content-Type: application/json is required'));
    return;
  }
  next();
}

// The owner's own share-link management. No id in any URL: the token belongs to req.user.
export function createRequestPageRouter(
  authService: AuthService,
  users: Pick<UserRepository, 'findById' | 'setRequestPageToken'>,
  generateToken: () => string = generateRequestPageToken,
): Router {
  const router = Router();
  const auth = requireAuth(authService);
  const userId = (req: AuthenticatedRequest) => req.user!.id;

  router.get('/', auth, wrapAsync(async (req, res) => {
    const user = await users.findById(userId(req as AuthenticatedRequest));
    res.status(200).json({ token: user?.requestPageToken ?? null });
  }));

  // Mints a fresh token, replacing any existing one — the old link 404s from the next request on.
  router.post('/token', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const token = generateToken();
    await users.setRequestPageToken(userId(req as AuthenticatedRequest), token);
    res.status(200).json({ token });
  }));

  // No requireJsonRequest here, matching every other DELETE route in the app (tracks, playlists,
  // destinations, templates, presets, interaction rules): a bodiless DELETE carries no
  // Content-Length, so req.is('application/json') is null whatever the header says, and the guard
  // would 400 every real browser call. DELETE isn't a CORS "simple" method, so it is always
  // preflighted anyway — the guard's CSRF purpose is already met.
  router.delete('/token', auth, wrapAsync(async (req, res) => {
    await users.setRequestPageToken(userId(req as AuthenticatedRequest), null);
    res.status(200).json({ token: null });
  }));

  return router;
}
