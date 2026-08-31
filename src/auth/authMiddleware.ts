import { NextFunction, Request, RequestHandler, Response } from 'express';
import { AuthService, AuthUser } from './authService';
import { getSessionIdFromCookieHeader } from './sessionCookie';
import { ApiError } from '../errors';

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
}

export function requireAuth(authService: AuthService): RequestHandler {
  return async (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    try {
      const sessionId = getSessionIdFromCookieHeader(req.headers.cookie);
      const user = await authService.getCurrentUser(sessionId);
      if (!user) throw new ApiError(401, 'unauthorized');
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}
