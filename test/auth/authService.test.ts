import { AuthService } from '../../src/auth/authService';
import { ApiError } from '../../src/errors';

function buildDeps() {
  const users = new Map<string, { id: string; email: string; passwordHash: string }>();
  let nextUserId = 1;
  const sessions = new Map<string, { id: string; userId: string; expiresAt: Date }>();
  let nextSessionId = 1;

  const userRepository = {
    create: jest.fn(async (email: string, passwordHash: string) => {
      const user = { id: `user-${nextUserId++}`, email, passwordHash };
      users.set(email, user);
      return user;
    }),
    findByEmail: jest.fn(async (email: string) => users.get(email) ?? null),
  };

  const sessionRepository = {
    create: jest.fn(async (userId: string, expiresAt: Date) => {
      const session = { id: `session-${nextSessionId++}`, userId, expiresAt };
      sessions.set(session.id, session);
      return session;
    }),
    findValid: jest.fn(async (id: string, now: Date) => {
      const session = sessions.get(id);
      if (!session || session.expiresAt <= now) return null;
      const user = [...users.values()].find((u) => u.id === session.userId)!;
      return { id: session.id, expiresAt: session.expiresAt, user: { id: user.id, email: user.email } };
    }),
    deleteById: jest.fn(async (id: string) => { sessions.delete(id); }),
  };

  return { deps: { userRepository, sessionRepository, sessionTtlDays: 30 }, userRepository, sessionRepository };
}

describe('AuthService', () => {
  it('register() creates a user and a session', async () => {
    const { deps } = buildDeps();
    const service = new AuthService(deps);

    const result = await service.register('a@example.com', 'password123');

    expect(result.user.email).toBe('a@example.com');
    expect(result.sessionId).toBeTruthy();
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('register() throws 409 for a duplicate email', async () => {
    const { deps } = buildDeps();
    const service = new AuthService(deps);
    await service.register('a@example.com', 'password123');

    await expect(service.register('a@example.com', 'other-password')).rejects.toThrow(ApiError);
  });

  it('login() succeeds with the correct password', async () => {
    const { deps } = buildDeps();
    const service = new AuthService(deps);
    await service.register('a@example.com', 'password123');

    const result = await service.login('a@example.com', 'password123');

    expect(result.user.email).toBe('a@example.com');
  });

  it('login() throws 401 for an unknown email', async () => {
    const { deps } = buildDeps();
    const service = new AuthService(deps);
    await expect(service.login('missing@example.com', 'password123')).rejects.toThrow(ApiError);
  });

  it('login() throws 401 for a wrong password', async () => {
    const { deps } = buildDeps();
    const service = new AuthService(deps);
    await service.register('a@example.com', 'password123');

    await expect(service.login('a@example.com', 'wrong-password')).rejects.toThrow(ApiError);
  });

  it('getCurrentUser() returns the user for a valid session', async () => {
    const { deps } = buildDeps();
    const service = new AuthService(deps);
    const { sessionId } = await service.register('a@example.com', 'password123');

    const user = await service.getCurrentUser(sessionId);

    expect(user).toEqual({ id: expect.any(String), email: 'a@example.com' });
  });

  it('getCurrentUser() returns null for a missing or null session id', async () => {
    const { deps } = buildDeps();
    const service = new AuthService(deps);

    expect(await service.getCurrentUser(null)).toBeNull();
    expect(await service.getCurrentUser('does-not-exist')).toBeNull();
  });

  it('logout() deletes the session so it is no longer valid', async () => {
    const { deps, sessionRepository } = buildDeps();
    const service = new AuthService(deps);
    const { sessionId } = await service.register('a@example.com', 'password123');

    await service.logout(sessionId);

    expect(sessionRepository.deleteById).toHaveBeenCalledWith(sessionId);
    expect(await service.getCurrentUser(sessionId)).toBeNull();
  });
});
