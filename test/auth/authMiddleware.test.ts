import { Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../../src/auth/authMiddleware';
import { ApiError } from '../../src/errors';
import { SESSION_COOKIE_NAME } from '../../src/auth/sessionCookie';

describe('requireAuth', () => {
  function buildReq(cookieHeader?: string): AuthenticatedRequest {
    return { headers: { cookie: cookieHeader } } as AuthenticatedRequest;
  }

  it('attaches req.user and calls next() for a valid session', async () => {
    const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: 'u1', email: 'a@example.com' }) };
    const middleware = requireAuth(authService);
    const req = buildReq(`${SESSION_COOKIE_NAME}=abc-123`);
    const next = jest.fn();

    await middleware(req, {} as Response, next);

    expect(authService.getCurrentUser).toHaveBeenCalledWith('abc-123');
    expect(req.user).toEqual({ id: 'u1', email: 'a@example.com' });
    expect(next).toHaveBeenCalledWith();
  });

  it('calls next(ApiError 401) when there is no session cookie', async () => {
    const authService: any = { getCurrentUser: jest.fn().mockResolvedValue(null) };
    const middleware = requireAuth(authService);
    const req = buildReq(undefined);
    const next = jest.fn();

    await middleware(req, {} as Response, next);

    expect(authService.getCurrentUser).toHaveBeenCalledWith(null);
    expect(next).toHaveBeenCalledWith(expect.any(ApiError));
    expect((next.mock.calls[0][0] as ApiError).status).toBe(401);
  });

  it('calls next(ApiError 401) when the session is invalid or expired', async () => {
    const authService: any = { getCurrentUser: jest.fn().mockResolvedValue(null) };
    const middleware = requireAuth(authService);
    const req = buildReq(`${SESSION_COOKIE_NAME}=expired-session`);
    const next = jest.fn();

    await middleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(ApiError));
  });
});
