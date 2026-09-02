import { serialize, parse } from 'cookie';

export const SESSION_COOKIE_NAME = 'sdj_session';

export function buildSessionCookie(sessionId: string, expiresAt: Date): string {
  const isProduction = process.env.NODE_ENV === 'production';
  return serialize(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
    expires: expiresAt,
    secure: isProduction,
  });
}

export function clearSessionCookie(): string {
  const isProduction = process.env.NODE_ENV === 'production';
  return serialize(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
    expires: new Date(0),
    secure: isProduction,
  });
}

export function getSessionIdFromCookieHeader(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const cookies = parse(cookieHeader);
  return cookies[SESSION_COOKIE_NAME] ?? null;
}
