# Foundation: DB + Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PostgreSQL-backed user accounts and email/password authentication (register/login/logout/me) to super-dj, as the foundation the later multi-tenant and web-frontend phases build on — without touching the existing single-tenant streaming code.

**Architecture:** Prisma + PostgreSQL for `User`/`Session` storage. `bcryptjs` for password hashing. Sessions are opaque UUID tokens stored in a `Session` table and handed to the browser as an `httpOnly` cookie (no JWT, no Redis) — logout/expiry actually revoke access immediately. A thin `UserRepository`/`SessionRepository` wrap Prisma Client calls; `AuthService` holds all business logic (register/login/logout/getCurrentUser) and is injected with repository interfaces so it's fully unit-testable without a real database, matching the project's existing dependency-injection pattern (`Spawner`, `StreamControllerDeps`).

**Tech Stack:** PostgreSQL, Prisma (ORM + migrations), bcryptjs, the `cookie` package for cookie serialization, Express (existing).

**Spec:** [docs/superpowers/specs/2026-08-31-foundation-db-auth-design.md](../specs/2026-08-31-foundation-db-auth-design.md)

## Global Constraints

- Scope is strictly `users`/`sessions`/auth. Do NOT modify `src/stream/`, `src/playlist/`, `src/ffmpeg/`, `src/api/streamRoutes.ts`, or `src/api/libraryRoutes.ts` — the existing single-tenant streaming code must keep working unchanged.
- PostgreSQL via Prisma; `bcryptjs` for hashing (not native `bcrypt` — avoids native compilation in the Docker build); DB-backed sessions + `httpOnly` cookie (not JWT, not Redis) so logout/expiry actually revoke access.
- Session TTL is 30 days, fixed — no sliding renewal in this phase.
- Login and register failures return generic messages (`'invalid email or password'` for login) — never reveal whether a given email exists.
- `DATABASE_URL` is a required env var with no default; the service must fail fast (`prisma.$connect()` at boot) if the database is unreachable, mirroring the existing `RTMP_URL`/`STREAM_KEY` requirement.
- `UserRepository`/`SessionRepository` (the Prisma-backed classes) are intentionally NOT unit-tested — per spec §6, their correctness is verified via manual smoke test with a real Postgres (`docker compose up`), the same way `SegmentFeeder`'s real ffmpeg behavior is smoke-tested rather than unit-tested. Do not flag this as a coverage gap.
- No email verification and no password-reset flow in this phase — out of scope (would need email-sending infrastructure).

---

### Task 1: Prisma schema, dependencies & config extension

**Files:**
- Create: `prisma/schema.prisma`
- Modify: `package.json` (add dependencies)
- Modify: `src/config/env.ts`
- Modify: `test/config/env.test.ts`

**Interfaces:**
- Produces: `AppConfig` gains `databaseUrl: string` and `sessionTtlDays: number`; a generated `@prisma/client` exporting `PrismaClient`, `User`, `Session` types.

- [ ] **Step 1: Create `prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id           String    @id @default(uuid())
  email        String    @unique
  passwordHash String
  createdAt    DateTime  @default(now())
  sessions     Session[]
}

model Session {
  id        String   @id @default(uuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  expiresAt DateTime
  createdAt DateTime @default(now())
}
```

- [ ] **Step 2: Add dependencies to `package.json`**

Add to `"dependencies"`: `"bcryptjs": "^2.4.3"`, `"cookie": "^0.6.0"`, `"@prisma/client": "^5.18.0"`.
Add to `"devDependencies"`: `"prisma": "^5.18.0"`, `"@types/bcryptjs": "^2.4.6"`.

- [ ] **Step 3: Install and generate the Prisma client**

Run: `npm install`
Run: `npx prisma generate`
Expected: generates `node_modules/.prisma/client` with `PrismaClient`, `User`, `Session` types. `prisma generate` does not need a reachable database — it only needs `DATABASE_URL` to be a syntactically present env var. If it fails because `DATABASE_URL` isn't set in your shell, run with a placeholder: `DATABASE_URL="postgresql://user:pass@localhost:5432/superdj" npx prisma generate` (Windows PowerShell: `$env:DATABASE_URL="postgresql://user:pass@localhost:5432/superdj"; npx prisma generate`).

- [ ] **Step 4: Write the failing config tests**

Add to `test/config/env.test.ts` (new `describe` block, keep the existing tests):

```ts
describe('loadConfig — database', () => {
  const base = { RTMP_URL: 'rtmp://example.com/live', STREAM_KEY: 'key123' } as NodeJS.ProcessEnv;

  it('throws when DATABASE_URL is missing', () => {
    expect(() => loadConfig(base)).toThrow('DATABASE_URL environment variable is required');
  });

  it('applies a default sessionTtlDays of 30', () => {
    const config = loadConfig({ ...base, DATABASE_URL: 'postgresql://u:p@localhost:5432/db' } as NodeJS.ProcessEnv);
    expect(config.databaseUrl).toBe('postgresql://u:p@localhost:5432/db');
    expect(config.sessionTtlDays).toBe(30);
  });

  it('honors an overridden SESSION_TTL_DAYS', () => {
    const config = loadConfig({
      ...base, DATABASE_URL: 'postgresql://u:p@localhost:5432/db', SESSION_TTL_DAYS: '7',
    } as NodeJS.ProcessEnv);
    expect(config.sessionTtlDays).toBe(7);
  });
});
```

Note: the existing tests in this file call `loadConfig(base)` / `loadConfig({...base, ...})` without `DATABASE_URL` — once `loadConfig` requires it, those existing calls will start throwing. Update every existing test's `base`/override object in this file to include `DATABASE_URL: 'postgresql://u:p@localhost:5432/db'` so they keep testing what they were testing before.

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx jest test/config/env.test.ts`
Expected: FAIL — `databaseUrl`/`sessionTtlDays` don't exist yet, `DATABASE_URL` isn't validated

- [ ] **Step 6: Implement the `AppConfig` extension in `src/config/env.ts`**

```ts
export interface AppConfig {
  port: number;
  rtmpUrl: string;
  streamKey: string;
  audioDir: string;
  defaultCoverPath: string;
  backgroundImagePath: string;
  fifoPath: string;
  databaseUrl: string;
  sessionTtlDays: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rtmpUrl = env.RTMP_URL;
  const streamKey = env.STREAM_KEY;
  const databaseUrl = env.DATABASE_URL;

  if (!rtmpUrl) {
    throw new Error('RTMP_URL environment variable is required');
  }
  if (!streamKey) {
    throw new Error('STREAM_KEY environment variable is required');
  }
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  return {
    port: env.PORT ? parseInt(env.PORT, 10) : 3000,
    rtmpUrl,
    streamKey,
    audioDir: env.AUDIO_DIR ?? '/data/audio',
    defaultCoverPath: env.DEFAULT_COVER_PATH ?? path.join(process.cwd(), 'assets', 'default-cover.png'),
    backgroundImagePath: env.BACKGROUND_IMAGE_PATH ?? path.join(process.cwd(), 'assets', 'background.png'),
    fifoPath: env.FIFO_PATH ?? '/tmp/super-dj-stream.fifo',
    databaseUrl,
    sessionTtlDays: env.SESSION_TTL_DAYS ? parseInt(env.SESSION_TTL_DAYS, 10) : 30,
  };
}
```

(`import { posix as path } from 'path';` already exists at the top of this file — keep it.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx jest test/config/env.test.ts`
Expected: PASS (all tests, old and new)

- [ ] **Step 8: Run the full suite and build to confirm nothing else broke**

Run: `npx jest && npm run build`
Expected: all suites PASS, `tsc` clean

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma package.json package-lock.json src/config/env.ts test/config/env.test.ts
git commit -m "feat: add Prisma schema and DATABASE_URL/SESSION_TTL_DAYS config"
```

---

### Task 2: Password hashing helper

**Files:**
- Create: `src/auth/passwordHash.ts`
- Test: `test/auth/passwordHash.test.ts`

**Interfaces:**
- Produces: `hashPassword(password: string): Promise<string>`, `verifyPassword(password: string, hash: string): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

```ts
// test/auth/passwordHash.test.ts
import { hashPassword, verifyPassword } from '../../src/auth/passwordHash';

describe('passwordHash', () => {
  it('hashes a password and verifies it against the same password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).not.toBe('correct horse battery staple');
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
  });

  it('rejects an incorrect password against a hash', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('wrong password', hash)).resolves.toBe(false);
  });

  it('produces different hashes for the same password (random salt)', async () => {
    const hash1 = await hashPassword('same-password');
    const hash2 = await hashPassword('same-password');
    expect(hash1).not.toBe(hash2);
  });
});
```

These use the real `bcryptjs` (no mocking) — it's pure JS, fast enough for tests, and this is exactly the kind of small pure logic the project already tests directly (cf. `overlayText.test.ts`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/auth/passwordHash.test.ts`
Expected: FAIL — `Cannot find module '../../src/auth/passwordHash'`

- [ ] **Step 3: Implement `src/auth/passwordHash.ts`**

```ts
import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/auth/passwordHash.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/auth/passwordHash.ts test/auth/passwordHash.test.ts
git commit -m "feat: bcryptjs password hashing helper"
```

---

### Task 3: Session cookie helpers

**Files:**
- Create: `src/auth/sessionCookie.ts`
- Test: `test/auth/sessionCookie.test.ts`

**Interfaces:**
- Produces: `SESSION_COOKIE_NAME: string`, `buildSessionCookie(sessionId: string, expiresAt: Date): string`, `clearSessionCookie(): string`, `getSessionIdFromCookieHeader(cookieHeader: string | undefined): string | null`

- [ ] **Step 1: Write the failing tests**

```ts
// test/auth/sessionCookie.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/auth/sessionCookie.test.ts`
Expected: FAIL — `Cannot find module '../../src/auth/sessionCookie'`

- [ ] **Step 3: Implement `src/auth/sessionCookie.ts`**

```ts
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
```

If `tsc` complains that the `cookie` module has no type declarations, add `"@types/cookie": "^0.6.0"` to `package.json` devDependencies and re-run `npm install` — recent `cookie` versions ship their own types, but pin the fallback if needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/auth/sessionCookie.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the build to confirm the `cookie` types resolve**

Run: `npm run build`
Expected: `tsc` clean

- [ ] **Step 6: Commit**

```bash
git add src/auth/sessionCookie.ts test/auth/sessionCookie.test.ts package.json package-lock.json
git commit -m "feat: session cookie build/parse helpers"
```

---

### Task 4: UserRepository & SessionRepository (Prisma-backed)

**Files:**
- Create: `src/db/prismaTypes.ts` (re-export point, see below)
- Create: `src/auth/userRepository.ts`
- Create: `src/auth/sessionRepository.ts`

**Interfaces:**
- Consumes: `PrismaClient`, `User`, `Session` from `@prisma/client` (Task 1).
- Produces: `class UserRepository { constructor(prisma: PrismaClient); create(email: string, passwordHash: string): Promise<User>; findByEmail(email: string): Promise<User | null>; findById(id: string): Promise<User | null>; }`, `interface SessionWithUser extends Session { user: User }`, `class SessionRepository { constructor(prisma: PrismaClient); create(userId: string, expiresAt: Date): Promise<Session>; findValid(id: string, now: Date): Promise<SessionWithUser | null>; deleteById(id: string): Promise<void>; }`

No test file for this task — per the plan's Global Constraints, these thin Prisma wrappers are verified by manual smoke test (Task 8's Docker Compose), not unit tests.

- [ ] **Step 1: Implement `src/auth/userRepository.ts`**

```ts
import { PrismaClient, User } from '@prisma/client';

export class UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(email: string, passwordHash: string): Promise<User> {
    return this.prisma.user.create({ data: { email, passwordHash } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }
}
```

- [ ] **Step 2: Implement `src/auth/sessionRepository.ts`**

```ts
import { PrismaClient, Session, User } from '@prisma/client';

export type SessionWithUser = Session & { user: User };

export class SessionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(userId: string, expiresAt: Date): Promise<Session> {
    return this.prisma.session.create({ data: { userId, expiresAt } });
  }

  findValid(id: string, now: Date): Promise<SessionWithUser | null> {
    return this.prisma.session.findFirst({
      where: { id, expiresAt: { gt: now } },
      include: { user: true },
    });
  }

  async deleteById(id: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { id } });
  }
}
```

(`deleteMany` rather than `delete` deliberately — it makes `deleteById` idempotent: deleting an already-gone or never-existed session id doesn't throw, so `AuthService.logout` doesn't need a try/catch.)

- [ ] **Step 3: Verify the build compiles**

Run: `npm run build`
Expected: `tsc` clean (this confirms the generated `@prisma/client` types from Task 1 match the field names used here)

- [ ] **Step 4: Commit**

```bash
git add src/auth/userRepository.ts src/auth/sessionRepository.ts
git commit -m "feat: Prisma-backed user and session repositories"
```

(Delete the empty `src/db/prismaTypes.ts` placeholder if you created one and didn't end up needing it — it isn't required if the repositories import directly from `@prisma/client`.)

---

### Task 5: AuthService

**Files:**
- Create: `src/auth/authService.ts`
- Test: `test/auth/authService.test.ts`

**Interfaces:**
- Consumes: `hashPassword`, `verifyPassword` (Task 2), `ApiError` (`src/errors.ts`, existing).
- Produces: `interface AuthUser { id: string; email: string; }`, `interface UserRepositoryLike { create(email, passwordHash): Promise<{id,email,passwordHash}>; findByEmail(email): Promise<{id,email,passwordHash}|null>; }`, `interface SessionRepositoryLike { create(userId, expiresAt): Promise<{id,expiresAt}>; findValid(id, now): Promise<{id,expiresAt,user:AuthUser}|null>; deleteById(id): Promise<void>; }`, `interface AuthResult { user: AuthUser; sessionId: string; expiresAt: Date; }`, `interface AuthServiceDeps { userRepository: UserRepositoryLike; sessionRepository: SessionRepositoryLike; sessionTtlDays: number; }`, `class AuthService { constructor(deps: AuthServiceDeps); register(email, password): Promise<AuthResult>; login(email, password): Promise<AuthResult>; logout(sessionId: string): Promise<void>; getCurrentUser(sessionId: string | null): Promise<AuthUser | null>; }`

The real `UserRepository`/`SessionRepository` (Task 4) satisfy these `*Like` interfaces structurally (Prisma's generated `User`/`Session` objects are supersets of the fields used here) — no adapter needed.

- [ ] **Step 1: Write the failing tests**

```ts
// test/auth/authService.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/auth/authService.test.ts`
Expected: FAIL — `Cannot find module '../../src/auth/authService'`

- [ ] **Step 3: Implement `src/auth/authService.ts`**

```ts
import { ApiError } from '../errors';
import { hashPassword, verifyPassword } from './passwordHash';

export interface AuthUser {
  id: string;
  email: string;
}

export interface UserRepositoryLike {
  create(email: string, passwordHash: string): Promise<{ id: string; email: string; passwordHash: string }>;
  findByEmail(email: string): Promise<{ id: string; email: string; passwordHash: string } | null>;
}

export interface SessionRepositoryLike {
  create(userId: string, expiresAt: Date): Promise<{ id: string; expiresAt: Date }>;
  findValid(id: string, now: Date): Promise<{ id: string; expiresAt: Date; user: AuthUser } | null>;
  deleteById(id: string): Promise<void>;
}

export interface AuthResult {
  user: AuthUser;
  sessionId: string;
  expiresAt: Date;
}

export interface AuthServiceDeps {
  userRepository: UserRepositoryLike;
  sessionRepository: SessionRepositoryLike;
  sessionTtlDays: number;
}

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  async register(email: string, password: string): Promise<AuthResult> {
    const existing = await this.deps.userRepository.findByEmail(email);
    if (existing) throw new ApiError(409, 'email is already registered');

    const passwordHash = await hashPassword(password);
    const user = await this.deps.userRepository.create(email, passwordHash);
    return this.createSession({ id: user.id, email: user.email });
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const user = await this.deps.userRepository.findByEmail(email);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new ApiError(401, 'invalid email or password');
    }
    return this.createSession({ id: user.id, email: user.email });
  }

  async logout(sessionId: string): Promise<void> {
    await this.deps.sessionRepository.deleteById(sessionId);
  }

  async getCurrentUser(sessionId: string | null): Promise<AuthUser | null> {
    if (!sessionId) return null;
    const session = await this.deps.sessionRepository.findValid(sessionId, new Date());
    return session ? session.user : null;
  }

  private async createSession(user: AuthUser): Promise<AuthResult> {
    const expiresAt = new Date(Date.now() + this.deps.sessionTtlDays * 24 * 60 * 60 * 1000);
    const session = await this.deps.sessionRepository.create(user.id, expiresAt);
    return { user, sessionId: session.id, expiresAt: session.expiresAt };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/auth/authService.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/auth/authService.ts test/auth/authService.test.ts
git commit -m "feat: AuthService (register/login/logout/getCurrentUser)"
```

---

### Task 6: requireAuth middleware

**Files:**
- Create: `src/auth/authMiddleware.ts`
- Test: `test/auth/authMiddleware.test.ts`

**Interfaces:**
- Consumes: `AuthService`, `AuthUser` (Task 5), `getSessionIdFromCookieHeader` (Task 3), `ApiError` (existing).
- Produces: `interface AuthenticatedRequest extends Request { user?: AuthUser }`, `requireAuth(authService: AuthService): RequestHandler`

- [ ] **Step 1: Write the failing tests**

```ts
// test/auth/authMiddleware.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/auth/authMiddleware.test.ts`
Expected: FAIL — `Cannot find module '../../src/auth/authMiddleware'`

- [ ] **Step 3: Implement `src/auth/authMiddleware.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/auth/authMiddleware.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/auth/authMiddleware.ts test/auth/authMiddleware.test.ts
git commit -m "feat: requireAuth middleware"
```

---

### Task 7: authRoutes, app.ts wiring, and server.ts/main.ts wiring

This task is intentionally larger than the others — splitting it at the
`app.ts`/`server.ts` boundary would leave `npm run build` red for a whole
task-review cycle (`AppDeps` gaining a required field breaks `server.ts`
until it's updated too), which would be the first task in this plan to
break the project's established rule that every commit compiles and
passes its tests. Keep it as one task with one final green commit.

**Files:**
- Create: `src/auth/authRoutes.ts`
- Test: `test/auth/authRoutes.test.ts`
- Modify: `src/api/app.ts`
- Modify: `test/api/openapi.test.ts` (its `createApp(...)` call needs a fake `authService` once `AppDeps` requires one)
- Modify: `src/server.ts`
- Modify: `src/main.ts`
- Modify: `test/server.test.ts`

**Interfaces:**
- Consumes: `AuthService` (Task 5), `requireAuth`, `AuthenticatedRequest` (Task 6), `buildSessionCookie`, `clearSessionCookie`, `getSessionIdFromCookieHeader` (Task 3), `ApiError`, `wrapAsync` (existing `src/errors.ts`, `src/api/errorHandler.ts`), `UserRepository`, `SessionRepository` (Task 4), `AppConfig.databaseUrl`/`sessionTtlDays` (Task 1).
- Produces: `createAuthRouter(authService: AuthService): Router`; `AppDeps` (in `src/api/app.ts`) gains `authService: AuthService`; `buildServer(...)` return value gains `prisma: PrismaClient`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/auth/authRoutes.test.ts
import express from 'express';
import request from 'supertest';
import { createAuthRouter } from '../../src/auth/authRoutes';
import { errorHandler } from '../../src/api/errorHandler';
import { ApiError } from '../../src/errors';
import { SESSION_COOKIE_NAME } from '../../src/auth/sessionCookie';

function buildApp(authService: any) {
  const app = express();
  app.use(express.json());
  app.use('/auth', createAuthRouter(authService));
  app.use(errorHandler);
  return app;
}

describe('auth routes', () => {
  it('POST /auth/register creates a user and sets a session cookie', async () => {
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60);
    const authService = {
      register: jest.fn().mockResolvedValue({ user: { id: 'u1', email: 'a@example.com' }, sessionId: 'sess-1', expiresAt }),
    };

    const res = await request(buildApp(authService)).post('/auth/register').send({ email: 'a@example.com', password: 'pw' });

    expect(authService.register).toHaveBeenCalledWith('a@example.com', 'pw');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'u1', email: 'a@example.com' });
    expect(res.headers['set-cookie'][0]).toContain(`${SESSION_COOKIE_NAME}=sess-1`);
  });

  it('POST /auth/register requires email and password in the body', async () => {
    const authService = { register: jest.fn() };
    const res = await request(buildApp(authService)).post('/auth/register').send({ email: 'a@example.com' });

    expect(res.status).toBe(400);
    expect(authService.register).not.toHaveBeenCalled();
  });

  it('POST /auth/login maps a 401 ApiError from the service', async () => {
    const authService = { login: jest.fn().mockRejectedValue(new ApiError(401, 'invalid email or password')) };
    const res = await request(buildApp(authService)).post('/auth/login').send({ email: 'a@example.com', password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid email or password' });
  });

  it('POST /auth/logout clears the cookie', async () => {
    const authService = { logout: jest.fn().mockResolvedValue(undefined) };
    const res = await request(buildApp(authService)).post('/auth/logout').set('Cookie', `${SESSION_COOKIE_NAME}=sess-1`);

    expect(authService.logout).toHaveBeenCalledWith('sess-1');
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie'][0]).toContain(`${SESSION_COOKIE_NAME}=;`);
  });

  it('GET /auth/me returns 401 without a valid session', async () => {
    const authService = { getCurrentUser: jest.fn().mockResolvedValue(null) };
    const res = await request(buildApp(authService)).get('/auth/me');

    expect(res.status).toBe(401);
  });

  it('GET /auth/me returns the current user with a valid session', async () => {
    const authService = { getCurrentUser: jest.fn().mockResolvedValue({ id: 'u1', email: 'a@example.com' }) };
    const res = await request(buildApp(authService)).get('/auth/me').set('Cookie', `${SESSION_COOKIE_NAME}=sess-1`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'u1', email: 'a@example.com' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/auth/authRoutes.test.ts`
Expected: FAIL — `Cannot find module '../../src/auth/authRoutes'`

- [ ] **Step 3: Implement `src/auth/authRoutes.ts`**

```ts
import { Router } from 'express';
import { AuthService } from './authService';
import { ApiError } from '../errors';
import { wrapAsync } from '../api/errorHandler';
import { buildSessionCookie, clearSessionCookie, getSessionIdFromCookieHeader } from './sessionCookie';
import { requireAuth, AuthenticatedRequest } from './authMiddleware';

function readCredentials(body: unknown): { email: string; password: string } {
  const { email, password } = (body ?? {}) as { email?: unknown; password?: unknown };
  if (typeof email !== 'string' || email.length === 0) throw new ApiError(400, 'body.email is required');
  if (typeof password !== 'string' || password.length === 0) throw new ApiError(400, 'body.password is required');
  return { email, password };
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/auth/authRoutes.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Wire `authRouter` into `src/api/app.ts`**

Modify `AppDeps` and `createApp`:

```ts
import express, { Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import { StreamController } from '../stream/streamController';
import { Library } from '../playlist/library';
import { PlaylistQueue } from '../playlist/queue';
import { AuthService } from '../auth/authService';
import { createStreamRouter } from './streamRoutes';
import { createLibraryRouter } from './libraryRoutes';
import { createAuthRouter } from '../auth/authRoutes';
import { errorHandler } from './errorHandler';
import { openApiSpec } from './openapi';

export interface AppDeps {
  streamController: StreamController;
  library: Library;
  queue: PlaylistQueue;
  authService: AuthService;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json());
  app.use('/stream', createStreamRouter(deps.streamController));
  app.use('/library', createLibraryRouter(deps.library, deps.queue));
  app.use('/auth', createAuthRouter(deps.authService));
  app.get('/openapi.json', (_req, res) => res.json(openApiSpec));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
  app.use(errorHandler);
  return app;
}
```

- [ ] **Step 6: Fix `test/api/openapi.test.ts`'s now-broken `createApp` call**

`AppDeps` now requires `authService`. Add a minimal fake to its `buildApp()` helper:

```ts
const authService: any = { register: jest.fn(), login: jest.fn(), logout: jest.fn(), getCurrentUser: jest.fn() };
return createApp({ streamController, library, queue, authService });
```

- [ ] **Step 7: Modify `src/server.ts`**

Add imports and construct the auth stack, passing `authService` into `createApp`:

```ts
import { PrismaClient } from '@prisma/client';
import { UserRepository } from './auth/userRepository';
import { SessionRepository } from './auth/sessionRepository';
import { AuthService } from './auth/authService';
// ...(existing imports stay)

export function buildServer(config: AppConfig, spawner: Spawner = createSpawner()) {
  const library = new Library(config.audioDir, config.defaultCoverPath);
  const queue = new PlaylistQueue([]);

  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  const userRepository = new UserRepository(prisma);
  const sessionRepository = new SessionRepository(prisma);
  const authService = new AuthService({ userRepository, sessionRepository, sessionTtlDays: config.sessionTtlDays });

  const buildOverlay = async (track: Track): Promise<NowPlayingOverlay> => {
    // ...(unchanged — do not touch this function's body)
  };

  const streamController = new StreamController({
    // ...(unchanged)
  });

  const app = createApp({ streamController, library, queue, authService });

  return { app, library, queue, streamController, prisma };
}
```

Only add the new imports/construction/`authService` argument/`prisma` in the return value — do not otherwise restructure this file. `buildOverlay` and `streamController` construction stay exactly as they were.

- [ ] **Step 8: Modify `src/main.ts`** to fail fast on an unreachable database and disconnect on shutdown

```ts
import { loadConfig } from './config/env';
import { buildServer } from './server';

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, library, queue, streamController, prisma } = buildServer(config);

  await prisma.$connect();
  await library.scan();
  queue.setTracks(library.list());

  const server = app.listen(config.port, () => {
    console.log(`super-dj listening on port ${config.port}`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      if (streamController.status().state !== 'idle') {
        streamController.stop();
      }
    } catch (err) {
      console.error('error stopping stream during shutdown', err);
    }
    await prisma.$disconnect();
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('failed to start super-dj', err);
  process.exit(1);
});
```

If `src/main.ts` already had a `SIGTERM`/`SIGINT` handler from an earlier phase (it does, per `CLAUDE.md`), merge this `prisma.$connect()`/`$disconnect()` logic into the EXISTING handler rather than adding a second one — read the current file first and adapt precisely; the snippet above shows the intended end state, not a literal diff.

- [ ] **Step 9: Fix `test/server.test.ts`**

`buildServer` now constructs a real `PrismaClient` internally. Since these tests never call any auth endpoint, the `PrismaClient` never actually connects to a database (Prisma is lazy — it only connects on first query), so no real Postgres is needed for these existing tests to keep passing. Just confirm `npx jest test/server.test.ts` still passes unmodified; if the existing config fixture object in this file's `config: AppConfig` literal doesn't yet include `databaseUrl`/`sessionTtlDays`, add them:

```ts
const config: AppConfig = {
  port: 3000,
  rtmpUrl: 'rtmp://example.com/live',
  streamKey: 'key',
  audioDir: '/music',
  defaultCoverPath: '/assets/default-cover.png',
  backgroundImagePath: '/assets/background.png',
  fifoPath: '/tmp/test.fifo',
  databaseUrl: 'postgresql://u:p@localhost:5432/db',
  sessionTtlDays: 30,
};
```

- [ ] **Step 10: Run the full test suite and build**

Run: `npx jest && npm run build`
Expected: all suites PASS (including the new `test/auth/authRoutes.test.ts` and the fixed `test/api/openapi.test.ts`/`test/server.test.ts`), `tsc` clean

- [ ] **Step 11: Commit**

```bash
git add src/auth/authRoutes.ts test/auth/authRoutes.test.ts src/api/app.ts test/api/openapi.test.ts src/server.ts src/main.ts test/server.test.ts
git commit -m "feat: auth REST routes, mount /auth, wire Prisma/AuthService into the composition root"
```

---

### Task 8: Docker / infra for Postgres

**Files:**
- Modify: `docker-compose.yml`
- Modify: `Dockerfile`

**Interfaces:**
- Consumes: `prisma/schema.prisma` (Task 1), `DATABASE_URL` config (Task 1).

- [ ] **Step 1: Modify `docker-compose.yml`** to add a `postgres` service

```yaml
services:
  super-dj:
    build: .
    ports:
      - "3000:3000"
    environment:
      RTMP_URL: ${RTMP_URL}
      STREAM_KEY: ${STREAM_KEY}
      AUDIO_DIR: /data/audio
      DATABASE_URL: postgresql://superdj:superdj@postgres:5432/superdj
    volumes:
      - ./music:/data/audio:ro
    depends_on:
      - postgres
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: superdj
      POSTGRES_PASSWORD: superdj
      POSTGRES_DB: superdj
    volumes:
      - postgres-data:/var/lib/postgresql/data

volumes:
  postgres-data:
```

- [ ] **Step 2: Modify `Dockerfile`** to generate the Prisma client in the build stage and carry it into the runtime stage

```dockerfile
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY prisma ./prisma
RUN npx prisma generate
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=build /app/dist ./dist
COPY assets ./assets
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "require('http').get('http://localhost:3000/stream/status', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "dist/main.js"]
```

`--ignore-scripts` on the runtime-stage `npm ci` is deliberate: `@prisma/client`'s own `postinstall` script runs `prisma generate`, which would fail in the runtime stage because the `prisma` CLI (a devDependency) isn't installed there. The already-generated client is copied in explicitly instead from the build stage, where `prisma` was available.

Preserve whatever else is already in the existing `Dockerfile` (the `fonts-dejavu-core`/`ffmpeg` install and `HEALTHCHECK` already exist from an earlier phase) — read the current file first and integrate these changes into it rather than replacing it wholesale.

- [ ] **Step 3: Attempt to build the image**

Run: `docker build -t super-dj:test .`
Expected: image builds successfully. If Docker is unavailable in this environment (no daemon reachable), report that clearly as an environment limitation — this has happened before in this project and is an accepted, documented gap; verify on the remote Docker test host instead when available.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml Dockerfile
git commit -m "chore: add Postgres service and Prisma client generation to Docker build"
```

---

## Self-Review Notes

- **Spec coverage:** the data model, all 4 auth endpoints, session TTL/cookie mechanics, generic login error messages, fail-fast DB connect, and the Docker/Prisma build changes from the spec each map to a task above.
- **Scope discipline verified:** no task in this plan touches `src/stream/`, `src/playlist/`, `src/ffmpeg/`, `src/api/streamRoutes.ts`, or `src/api/libraryRoutes.ts` — confirmed by re-reading each task's Files list against the Global Constraints.
- **Cross-task interface check:** `AuthService`'s `UserRepositoryLike`/`SessionRepositoryLike` (Task 5) are structurally satisfied by the real `UserRepository`/`SessionRepository` (Task 4) without an adapter — verified by comparing the Prisma model fields (Task 1) against the `*Like` interfaces' required fields. `AppDeps.authService` and `server.ts`'s construction of it (both Task 7) match.
- **Task-sizing fix during drafting:** an earlier draft split `app.ts` wiring and `server.ts` wiring into separate tasks (7 and 8), which would have left `npm run build` red for a whole task-review cycle in between — the first task in this plan to break the project's established rule that every commit compiles and passes its tests. Merged into one Task 7 with a single green commit at the end instead.
