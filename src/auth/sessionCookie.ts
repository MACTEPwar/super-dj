import { serialize, parse } from 'cookie';

export const SESSION_COOKIE_NAME = 'sdj_session';

export function buildSessionCookie(sessionId: string, expiresAt: Date): string {
  return serialize(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
    secure: process.env.NODE_ENV === 'production',
  });
}

export function clearSessionCookie(): string {
  return serialize(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    expires: new Date(0),
    secure: process.env.NODE_ENV === 'production',
  });
}

export function getSessionIdFromCookieHeader(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const cookies = parse(cookieHeader);
  return cookies[SESSION_COOKIE_NAME] ?? null;
}
