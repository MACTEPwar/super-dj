import {
  buildSessionCookie, clearSessionCookie, getSessionIdFromCookieHeader, SESSION_COOKIE_NAME,
} from '../../src/auth/sessionCookie';

describe('sessionCookie', () => {
  it('builds an httpOnly cookie string with the session id and expiry', () => {
    const cookie = buildSessionCookie('abc-123', new Date('2030-01-01T00:00:00.000Z'));
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=abc-123`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Expires=Tue, 01 Jan 2030 00:00:00 GMT');
  });

  it('clearSessionCookie expires the cookie immediately', () => {
    const cookie = clearSessionCookie();
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(cookie).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  });

  it('extracts the session id from a cookie header', () => {
    expect(getSessionIdFromCookieHeader(`foo=bar; ${SESSION_COOKIE_NAME}=abc-123; baz=qux`)).toBe('abc-123');
  });

  it('returns null when the cookie is missing or the header is undefined', () => {
    expect(getSessionIdFromCookieHeader(undefined)).toBeNull();
    expect(getSessionIdFromCookieHeader('foo=bar')).toBeNull();
  });
});
