# Donation Library-Track Requests — Phase A (public request page + `libraryTrackRequest`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Donors open a share-token link listing the streamer's live playlist, copy an exact `!<keyword>:<name prefix> <track uuid>` command, and a donation carrying it queues that exact library track next.

**Architecture:** A nullable unique `User.requestPageToken` gates a public, unauthenticated `GET /public/request-page/:token`; the owner manages it through `requireAuth` routes at `/request-page`. A new `libraryTrackRequest` interaction-rule type resolves a matched command's last UUID to an owned library track and calls Phase B's `LocalStreamManager.enqueueTrack`. Webhook and rule-test both dispatch by `actionType` through one shared handlers object.

**Tech Stack:** TypeScript, Express 4, Prisma/PostgreSQL, Jest + supertest (backend); React, react-router, TanStack Query, react-i18next, Vitest + Testing Library (frontend).

**Spec:** `docs/superpowers/specs/2026-09-23-donation-library-track-request-design.md` — section "Phase A", edge cases A1–A16, judgment calls #2, #10–#13.

## Global Constraints

- Requires Phase B merged (`LocalStreamManager.enqueueTrack(userId, track)` exists).
- Token: `randomBytes(16).toString('hex')` — exactly `^[0-9a-f]{32}$`. Never logged; returned only by the owner's `GET /request-page` and the two mutating owner routes.
- Public route: 404 by shape *before* any DB call; identical 404 body for malformed and unknown tokens; headers `Cache-Control: no-store` and `Referrer-Policy: no-referrer` on every response of that router.
- Live = local state `streaming` | `paused` | `reconnecting`. `starting`/`idle`/`error` → `{ live: false }`.
- Command format (frontend): `!<keyword>:<prefix> <uuid>`; prefix = whitespace runs collapsed to one space, trimmed, first 20 code points (`Array.from(...)`).
- Id extraction (backend): LAST match of `/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi`, lowercased.
- Action types: exactly `'songRequest' | 'libraryTrackRequest'`.
- Keyword uniqueness per user → 409 on POST/PUT (PUT excludes itself); enforced in the route only, not the DB.
- **One arrival-ordered queue for BOTH donation types (user decision, spec A5 / judgment call #2):** `SongRequestQueue` becomes the task-generic `DonationRequestQueue` (`src/donations/donationRequestQueue.ts`, `enqueue<R>(task: () => Promise<R>): Promise<R>`), with a head-of-line timeout `DONATION_TASK_TIMEOUT_MS = 90_000` (knock-on of that decision: a hung media-search download must not block every later donation). `server.ts` builds exactly ONE instance, shared by both handlers, the webhook, and the Test button.
- Every failure of a real donation is logged and dropped — no new feedback channel.
- Mutating authenticated POST/PUT routes require `Content-Type: application/json` (400 otherwise), like every other POST/PUT in the app. DELETE routes do NOT carry that guard, matching every existing DELETE route: a bodiless browser DELETE would always fail it, and DELETE is preflighted regardless.
- Migration generated only via CLAUDE.md "Persistence" remote workflow on 192.168.14.26 — never hand-written SQL. Remote host etiquette: never stop/inspect other services there; use throwaway names and a free port.
- Commit trailer: `Co-Authored-By: Claude Opus <noreply@anthropic.com>` (or the trailer matching the model actually committing).

## Review Focus

- A donor who types extra text after the pasted command (e.g. "…<uuid> thanks!!") must still get the track — pinned in Task 4.
- A command whose id belongs to another user's track must be dropped with the same reason as a nonexistent id — pinned in Task 4.
- A streamer who creates a `libraryTrackRequest` rule with the same keyword as their existing `songRequest` rule must be refused (409), since both would fire — pinned in Task 5.
- The public page must say "not live" (not 404) for a valid token whose stream is `starting`/`idle`, and must treat `reconnecting` as live — pinned in Task 3.
- A track name with newlines/emoji must produce a single-line command with no broken surrogate pair — pinned in Task 7.
- A free-text donation that arrived first must play before an exact-track donation that arrived second, even though the second resolves instantly and the first is still downloading — pinned in Task 5.

---

### Task 1: Schema, migration, repository methods

**Files:**
- Modify: `prisma/schema.prisma` (model `User`)
- Create: `prisma/migrations/<timestamp>_add_user_request_page_token/migration.sql` (generated, not written)
- Modify: `src/auth/userRepository.ts`
- Modify: `src/playlists/playlistRepository.ts` (`PlaylistTrackView`, `listTracks`)

**Interfaces:**
- Produces: `UserRepository.findByRequestPageToken(token: string): Promise<User | null>`; `UserRepository.setRequestPageToken(userId: string, token: string | null): Promise<void>`; `PlaylistTrackView.durationSeconds: number | null`.

- [ ] **Step 1: Edit the schema** — in `model User`, after `createdAt`:

```prisma
  // Bearer token for the public "request a track" page (/r/<token>). 128-bit hex, minted only by
  // an explicit owner action, rotated by overwrite, disabled by null. Deliberately NOT the userId,
  // so it can rotate without touching account identity. See the 2026-09-23 donation
  // library-track-request design spec.
  requestPageToken   String?             @unique
```

- [ ] **Step 2: Generate the migration via the remote workflow** (CLAUDE.md "Persistence"). From the repo root:

```bash
STAGE=/tmp/superdj-mig-$$
ssh 192.168.14.26 "mkdir -p $STAGE/prisma"
scp prisma/schema.prisma 192.168.14.26:$STAGE/prisma/
scp -r prisma/migrations 192.168.14.26:$STAGE/prisma/
scp package.json package-lock.json 192.168.14.26:$STAGE/
ssh 192.168.14.26 "docker network create superdj-mig-net-$$ && \
  docker run -d --name superdj-mig-pg-$$ --network superdj-mig-net-$$ -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=mig postgres:16-alpine && \
  for i in \$(seq 1 30); do docker exec superdj-mig-pg-$$ pg_isready -U postgres -d mig && break; sleep 1; done && \
  docker run --rm --network superdj-mig-net-$$ -v $STAGE:/app -w /app -e DATABASE_URL=postgresql://postgres:pw@superdj-mig-pg-$$:5432/mig \
    -e HOST_UID=\$(id -u) -e HOST_GID=\$(id -g) node:20-bookworm-slim \
    sh -c 'apt-get update && apt-get install -y openssl && npm ci && npx prisma migrate dev --name add_user_request_page_token --skip-generate; status=\$?; chown -R \$HOST_UID:\$HOST_GID /app; exit \$status'"
scp -r "192.168.14.26:$STAGE/prisma/migrations/*_add_user_request_page_token" prisma/migrations/
# The container ran as root: its chown above hands node_modules/ and the new migration back to the
# SSH user, so this plain rm works. If it ever fails on root-owned leftovers, remove them with a
# throwaway container instead: docker run --rm -v $STAGE:/app alpine rm -rf /app/node_modules
ssh 192.168.14.26 "docker rm -f superdj-mig-pg-$$; docker network rm superdj-mig-net-$$; rm -rf $STAGE"
```

Expected: one new directory whose `migration.sql` contains only `ALTER TABLE "User" ADD COLUMN "requestPageToken" TEXT;` and a `CREATE UNIQUE INDEX "User_requestPageToken_key" ...`. If it contains anything else (e.g. recreating tables), the existing migrations weren't staged — delete it and redo. Then `npx prisma generate` locally.

- [ ] **Step 3: Repository methods** — `src/auth/userRepository.ts`, append:

```ts
  findByRequestPageToken(token: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { requestPageToken: token } });
  }

  async setRequestPageToken(userId: string, token: string | null): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { requestPageToken: token } });
  }
```

`src/playlists/playlistRepository.ts`: add `durationSeconds: number | null;` to `PlaylistTrackView` and `durationSeconds: row.track.durationSeconds,` to the `listTracks` mapping. (Prisma-backed repositories are smoke-tested, not unit-tested — CLAUDE.md "Testing strategy".)

- [ ] **Step 4: Type check and suite**

Run: `npm run build` then `npm test`
Expected: green. (`buildStreamScene` assigns `listTracks` rows to `Track[]`; the extra field is structurally fine. If a test fake for `listTracks` is typed as `PlaylistTrackView`, add `durationSeconds: null` to it.)

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/auth/userRepository.ts src/playlists/playlistRepository.ts test
git commit -m "feat(db): add User.requestPageToken and expose track duration in playlist views"
```

---

### Task 2: Owner routes `/request-page`

**Files:**
- Create: `src/requestPage/requestPageRoutes.ts`
- Modify: `src/api/app.ts`, `src/server.ts`, `src/api/openapi.ts`
- Test: `test/requestPage/requestPageRoutes.test.ts`, `test/api/openapi.test.ts`

**Interfaces:**
- Consumes: `UserRepository.findById`, `UserRepository.setRequestPageToken` (Task 1).
- Produces: `createRequestPageRouter(authService: AuthService, users: Pick<UserRepository, 'findById' | 'setRequestPageToken'>, generateToken?: () => string): Router`; `generateRequestPageToken(): string`; `REQUEST_PAGE_TOKEN_PATTERN = /^[0-9a-f]{32}$/`.

- [ ] **Step 1: Failing tests** — `test/requestPage/requestPageRoutes.test.ts`:

```ts
import express from 'express';
import request from 'supertest';
import { createRequestPageRouter, generateRequestPageToken, REQUEST_PAGE_TOKEN_PATTERN } from '../../src/requestPage/requestPageRoutes';
import { errorHandler } from '../../src/api/errorHandler';

function buildApp(initialToken: string | null = null, generate = () => 'a'.repeat(32)) {
  const user = { id: 'user-1', requestPageToken: initialToken };
  const users = {
    findById: jest.fn(async (id: string) => (id === user.id ? user : null)),
    setRequestPageToken: jest.fn(async (_id: string, token: string | null) => { user.requestPageToken = token; }),
  };
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: 'user-1', email: 'a@example.com' }) };
  const app = express();
  app.use(express.json());
  app.use('/request-page', createRequestPageRouter(authService, users as any, generate));
  app.use(errorHandler);
  return { app, users, user };
}

describe('request page owner routes', () => {
  it('generateRequestPageToken produces 32 lowercase hex chars, different each time', () => {
    const a = generateRequestPageToken();
    const b = generateRequestPageToken();
    expect(a).toMatch(REQUEST_PAGE_TOKEN_PATTERN);
    expect(a).not.toBe(b);
  });

  it('GET returns null when no link exists', async () => {
    const { app } = buildApp(null);
    const res = await request(app).get('/request-page');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ token: null });
  });

  it('GET never mints a token as a side effect', async () => {
    const { app, users } = buildApp(null);
    await request(app).get('/request-page');
    expect(users.setRequestPageToken).not.toHaveBeenCalled();
  });

  it('POST /token mints (or rotates) and returns the new token', async () => {
    const { app, user } = buildApp('b'.repeat(32), () => 'c'.repeat(32));
    const res = await request(app).post('/request-page/token').set('Content-Type', 'application/json').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ token: 'c'.repeat(32) });
    expect(user.requestPageToken).toBe('c'.repeat(32));
  });

  it('DELETE /token disables the link — with NO body and NO content-type, exactly as a browser sends it', async () => {
    const { app, user } = buildApp('b'.repeat(32));
    const res = await request(app).delete('/request-page/token');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ token: null });
    expect(user.requestPageToken).toBeNull();
  });

  it('mutating routes require application/json', async () => {
    const { app } = buildApp(null);
    const res = await request(app).post('/request-page/token').set('Content-Type', 'text/plain').send('x');
    expect(res.status).toBe(400);
  });
});
```

Add to `test/api/openapi.test.ts`'s paths assertions: `expect(res.body.paths).toHaveProperty(['/request-page']);` and `expect(res.body.paths).toHaveProperty(['/request-page/token']);`.

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/requestPage`
Expected: FAIL — cannot find module `requestPageRoutes`.

- [ ] **Step 3: Implement** — `src/requestPage/requestPageRoutes.ts`:

```ts
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
```

`src/api/app.ts`: add `userRepository: UserRepository;` to `AppDeps` (import from `../auth/userRepository`), and mount `app.use('/request-page', createRequestPageRouter(deps.authService, deps.userRepository));` next to `/interaction-rules`. `src/server.ts`: pass `userRepository` into `createApp`. Update every other `createApp(...)` call in `test/` (search with the Grep tool for `createApp(`) to pass a `userRepository` fake (`{ findById: jest.fn(), setRequestPageToken: jest.fn(), findByRequestPageToken: jest.fn() }`).

`src/api/openapi.ts`: add `'/request-page'` (get), `'/request-page/token'` (post, delete) entries in the same style as `/interaction-rules`, summaries: "The caller's own public request-page link token (null when disabled)", "Mint or rotate the request-page token — the old link stops working immediately", "Disable the request page".

- [ ] **Step 4: Run to verify pass**

Run: `npx jest test/requestPage test/api` then `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/requestPage src/api/app.ts src/api/openapi.ts src/server.ts test/requestPage test/api
git commit -m "feat(request-page): owner routes to mint, rotate and disable the share token"
```

---

### Task 3: Public route `GET /public/request-page/:token`

**Files:**
- Create: `src/requestPage/publicRequestPageRoutes.ts`
- Modify: `src/api/app.ts`, `src/server.ts`, `src/api/openapi.ts`
- Test: `test/requestPage/publicRequestPageRoutes.test.ts`

**Interfaces:**
- Consumes: `REQUEST_PAGE_TOKEN_PATTERN` (Task 2); `UserRepository.findByRequestPageToken` (Task 1); `LocalStreamManager.status(userId).local.{state, playlistId}`; `PlaylistRepository.findById`, `listTracks` (with `durationSeconds`); `InteractionRuleRepository.listEnabledByUser`.
- Produces: `createPublicRequestPageRouter(deps: PublicRequestPageDeps): Router`; response type `PublicRequestPage = { live: false } | { live: true; playlistName: string; tracks: { id: string; name: string; durationSeconds: number | null }[]; request: { keyword: string; minAmount: number } | null }`; exported constant `LIBRARY_TRACK_REQUEST = 'libraryTrackRequest'` is defined in Task 5's `donationActions.ts` — here use the string literal `'libraryTrackRequest'` and Task 5 replaces it with the constant.

- [ ] **Step 1: Failing tests** — `test/requestPage/publicRequestPageRoutes.test.ts`:

```ts
import express from 'express';
import request from 'supertest';
import { createPublicRequestPageRouter } from '../../src/requestPage/publicRequestPageRoutes';
import { errorHandler } from '../../src/api/errorHandler';

const TOKEN = '0123456789abcdef0123456789abcdef';

function buildApp(opts: { state?: string; rules?: any[]; userFound?: boolean } = {}) {
  const deps = {
    users: { findByRequestPageToken: jest.fn(async (t: string) => (opts.userFound !== false && t === TOKEN ? { id: 'u1' } : null)) },
    streams: { status: jest.fn(() => ({ local: { state: opts.state ?? 'streaming', playlistId: 'p1' }, destinations: [] })) },
    playlists: {
      findById: jest.fn(async () => ({ id: 'p1', userId: 'u1', name: 'Evening set' })),
      listTracks: jest.fn(async () => [
        { id: '11111111-1111-1111-1111-111111111111', name: 'First', audioPath: '/secret/a.mp3', coverPath: '/secret/a.png', overlayOverride: null, durationSeconds: 180 },
        { id: '22222222-2222-2222-2222-222222222222', name: 'Second', audioPath: '/secret/b.mp3', coverPath: null, overlayOverride: null, durationSeconds: null },
      ]),
    },
    rules: { listEnabledByUser: jest.fn(async () => opts.rules ?? []) },
  };
  const app = express();
  app.use('/public/request-page', createPublicRequestPageRouter(deps as any));
  app.use(errorHandler);
  return { app, deps };
}

describe('GET /public/request-page/:token', () => {
  it('404s a malformed token without touching the database', async () => {
    const { app, deps } = buildApp();
    const res = await request(app).get('/public/request-page/not-a-token');
    expect(res.status).toBe(404);
    expect(deps.users.findByRequestPageToken).not.toHaveBeenCalled();
  });

  it('404s an unknown token with the same body as a malformed one', async () => {
    const { app } = buildApp({ userFound: false });
    const unknown = await request(app).get(`/public/request-page/${TOKEN}`);
    const malformed = await request(app).get('/public/request-page/zz');
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(malformed.body);
  });

  it.each(['idle', 'starting', 'error'])('reports not live for state %s', async (state) => {
    const { app, deps } = buildApp({ state });
    const res = await request(app).get(`/public/request-page/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ live: false });
    expect(deps.playlists.listTracks).not.toHaveBeenCalled();
  });

  it.each(['streaming', 'paused', 'reconnecting'])('reports live for state %s with only public fields', async (state) => {
    const { app } = buildApp({ state });
    const res = await request(app).get(`/public/request-page/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      live: true,
      playlistName: 'Evening set',
      tracks: [
        { id: '11111111-1111-1111-1111-111111111111', name: 'First', durationSeconds: 180 },
        { id: '22222222-2222-2222-2222-222222222222', name: 'Second', durationSeconds: null },
      ],
      request: null,
    });
    expect(JSON.stringify(res.body)).not.toContain('/secret/');
  });

  it('advertises the cheapest enabled libraryTrackRequest rule and ignores other types', async () => {
    const { app } = buildApp({ rules: [
      { actionType: 'songRequest', commandKeyword: 'song', minAmount: 10 },
      { actionType: 'libraryTrackRequest', commandKeyword: 'pick', minAmount: 100 },
      { actionType: 'libraryTrackRequest', commandKeyword: 'cheap', minAmount: 50 },
    ] });
    const res = await request(app).get(`/public/request-page/${TOKEN}`);
    expect(res.body.request).toEqual({ keyword: 'cheap', minAmount: 50 });
  });

  it('sets no-store and no-referrer on every response, including 404', async () => {
    const { app } = buildApp();
    for (const path of [`/public/request-page/${TOKEN}`, '/public/request-page/bad']) {
      const res = await request(app).get(path);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    }
  });
});
```

Also add `expect(res.body.paths).toHaveProperty(['/public/request-page/{token}']);` to `test/api/openapi.test.ts`.

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/requestPage/publicRequestPageRoutes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/requestPage/publicRequestPageRoutes.ts`:

```ts
import { Router } from 'express';
import { wrapAsync } from '../api/errorHandler';
import { ApiError } from '../errors';
import { UserRepository } from '../auth/userRepository';
import { PlaylistRepository } from '../playlists/playlistRepository';
import { InteractionRuleRepository } from '../donations/interactionRuleRepository';
import { LocalStreamManager } from '../stream/localStreamManager';
import { REQUEST_PAGE_TOKEN_PATTERN } from './requestPageRoutes';

export interface PublicRequestPageDeps {
  users: Pick<UserRepository, 'findByRequestPageToken'>;
  streams: Pick<LocalStreamManager, 'status'>;
  playlists: Pick<PlaylistRepository, 'findById' | 'listTracks'>;
  rules: Pick<InteractionRuleRepository, 'listEnabledByUser'>;
}

export type PublicRequestPage =
  | { live: false }
  | {
      live: true;
      playlistName: string;
      tracks: { id: string; name: string; durationSeconds: number | null }[];
      request: { keyword: string; minAmount: number } | null;
    };

const LIVE_STATES = new Set(['streaming', 'paused', 'reconnecting']);

/**
 * The ONE unauthenticated read in the app besides auth itself. The token is the access control:
 * it resolves to exactly one user, and the playlist is read from THAT user's own in-memory stream
 * entry — nothing in the request names a playlist, track or user id, so there is nothing to swap.
 * Only names/ids/durations leave this route; never paths, covers, emails or queue state.
 */
export function createPublicRequestPageRouter(deps: PublicRequestPageDeps): Router {
  const router = Router();

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  router.get('/:token', wrapAsync(async (req, res) => {
    const { token } = req.params;
    // Reject by shape before any DB call; same 404 as an unknown token so the two are indistinguishable.
    if (!REQUEST_PAGE_TOKEN_PATTERN.test(token)) throw new ApiError(404, 'request page not found');
    const user = await deps.users.findByRequestPageToken(token);
    if (!user) throw new ApiError(404, 'request page not found');

    const { local } = deps.streams.status(user.id);
    if (!LIVE_STATES.has(local.state) || !local.playlistId) {
      const body: PublicRequestPage = { live: false };
      res.status(200).json(body);
      return;
    }

    const [playlist, tracks, rules] = await Promise.all([
      deps.playlists.findById(local.playlistId),
      deps.playlists.listTracks(local.playlistId),
      deps.rules.listEnabledByUser(user.id),
    ]);
    const cheapest = rules
      .filter((r) => r.actionType === 'libraryTrackRequest')
      .sort((a, b) => a.minAmount - b.minAmount)[0];

    const body: PublicRequestPage = {
      live: true,
      playlistName: playlist?.name ?? '',
      tracks: tracks.map((t) => ({ id: t.id, name: t.name, durationSeconds: t.durationSeconds })),
      request: cheapest ? { keyword: cheapest.commandKeyword, minAmount: cheapest.minAmount } : null,
    };
    res.status(200).json(body);
  }));

  return router;
}
```

Wire: `src/api/app.ts` — `app.use('/public/request-page', createPublicRequestPageRouter({ users: deps.userRepository, streams: deps.localStreamManager, playlists: deps.playlistRepository, rules: deps.interactionRuleRepository }));`. `src/api/openapi.ts` — add `'/public/request-page/{token}'` (get, summary: "PUBLIC, unauthenticated: the live playlist behind a share token, for donors to pick an exact track. 404 for an unknown or malformed token; {live:false} when the owner isn't streaming").

- [ ] **Step 4: Run to verify pass**

Run: `npx jest test/requestPage test/api` then `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/requestPage src/api/app.ts src/api/openapi.ts test/requestPage test/api
git commit -m "feat(request-page): public token-gated live playlist endpoint"
```

---

### Task 4: `executeLibraryTrackRequest`

**Files:**
- Create: `src/donations/libraryTrackRequestAction.ts`
- Test: `test/donations/libraryTrackRequestAction.test.ts`

**Interfaces:**
- Consumes: `StreamInserter` from `songRequestAction.ts` (`enqueueTrack(userId, track)`, Phase B); `TrackRepository.findById`.
- Produces: `extractTrackId(query: string): string | null`; `executeLibraryTrackRequest(deps: LibraryTrackRequestDeps, query: string): Promise<LibraryTrackRequestResult>`; `LibraryTrackRequestResult = { ok: true } | { ok: false; reason: 'trackIdMissing' | 'trackNotFound' | 'noActiveStream'; message: string }`.

**Known pre-existing gap this task inherits (not introduced here, and not fixed by A11's "`error` is
not live" rule above — that rule only governs the public page's display, not `enqueueTrack` itself):**
`LocalStreamManager.require()` currently accepts a retained `error`-state entry, so `enqueueTrack()`
does NOT throw for a session that ended in `error` — it silently queues into a controller that will
never play anything, and `executeLibraryTrackRequest` reports `{ ok: true }` for a track nobody will
ever hear. The old `insertEphemeralTrack` had the exact same gap, so this is not new — but this task
adds a second call site (`libraryTrackRequestAction.ts`, alongside Phase B's `songRequestAction.ts`)
that inherits it. Decide explicitly when implementing this task whether `require()` should reject an
`error`-state session (matching the A11 "not live" intent) or whether this stays deliberately
deferred — don't let it pass unnoticed just because the public page's own `live` flag already says
`false` for `error`.

- [ ] **Step 1: Failing tests**

```ts
import { executeLibraryTrackRequest, extractTrackId } from '../../src/donations/libraryTrackRequestAction';

const ID = '3f2b9c1e-8d4a-4e2b-9a7c-1b2c3d4e5f60';

function buildDeps(row: any = { id: ID, userId: 'target', name: 'Believer', audioPath: '/u/a.mp3', coverPath: null, overlayOverride: null }) {
  return {
    trackRepository: { findById: jest.fn(async (id: string) => (row && id === row.id ? row : null)) },
    streamInserter: { enqueueTrack: jest.fn() },
    targetUserId: 'target',
  };
}

describe('extractTrackId', () => {
  it.each([
    [`Believer ${ID}`, ID],
    [`Believer${ID}`, ID],
    [`Believer ${ID} thanks!!`, ID],
    [`${ID.toUpperCase()}`, ID],
    [`00000000-0000-0000-0000-000000000000 in name ${ID}`, ID],
  ])('%s -> last uuid', (query, expected) => {
    expect(extractTrackId(query)).toBe(expected);
  });

  it('returns null when there is no uuid', () => {
    expect(extractTrackId('Believer imagine dragons')).toBeNull();
  });
});

describe('executeLibraryTrackRequest', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => errorSpy.mockRestore());

  it('queues the owned library track next, as a real (non-ephemeral) track', async () => {
    const deps = buildDeps();
    const result = await executeLibraryTrackRequest(deps, `Believer ${ID}`);
    expect(result).toEqual({ ok: true });
    expect(deps.streamInserter.enqueueTrack).toHaveBeenCalledWith('target', {
      name: 'Believer', audioPath: '/u/a.mp3', coverPath: null, overlayOverride: null,
    });
    const track = deps.streamInserter.enqueueTrack.mock.calls[0][1];
    expect(track.ephemeral).toBeUndefined();
    expect(track._onFinished).toBeUndefined();
  });

  it('trackIdMissing when no uuid is present, without a DB call', async () => {
    const deps = buildDeps();
    const result = await executeLibraryTrackRequest(deps, 'Believer');
    expect(result).toMatchObject({ ok: false, reason: 'trackIdMissing' });
    expect(deps.trackRepository.findById).not.toHaveBeenCalled();
  });

  it('trackNotFound for an unknown id', async () => {
    const deps = buildDeps(null);
    expect(await executeLibraryTrackRequest(deps, ID)).toMatchObject({ ok: false, reason: 'trackNotFound' });
  });

  it("trackNotFound (same reason) for another user's track", async () => {
    const deps = buildDeps({ id: ID, userId: 'someone-else', name: 'x', audioPath: '/x', coverPath: null, overlayOverride: null });
    expect(await executeLibraryTrackRequest(deps, ID)).toMatchObject({ ok: false, reason: 'trackNotFound' });
    expect(deps.streamInserter.enqueueTrack).not.toHaveBeenCalled();
  });

  it('noActiveStream when the inserter throws', async () => {
    const deps = buildDeps();
    deps.streamInserter.enqueueTrack.mockImplementation(() => { throw new Error('local stream is not active'); });
    expect(await executeLibraryTrackRequest(deps, ID)).toMatchObject({ ok: false, reason: 'noActiveStream', message: 'local stream is not active' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/donations/libraryTrackRequestAction.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/donations/libraryTrackRequestAction.ts`:

```ts
import { Track } from '../playlist/types';
import { TrackRepository, TrackOverlayOverride } from '../tracks/trackRepository';
import { StreamInserter } from './songRequestAction';

export interface LibraryTrackRequestDeps {
  trackRepository: Pick<TrackRepository, 'findById'>;
  streamInserter: StreamInserter;
  targetUserId: string;
}

export type LibraryTrackRequestResult =
  | { ok: true }
  | { ok: false; reason: 'trackIdMissing' | 'trackNotFound' | 'noActiveStream'; message: string };

const UUID_GLOBAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// The LAST uuid-shaped substring — identical to "the last 36 characters" for a command pasted
// verbatim, but also robust to text a donor adds after it and to a uuid-looking name prefix
// (the real id is always last). The name prefix itself is ignored; it's for humans.
export function extractTrackId(query: string): string | null {
  const matches = query.match(UUID_GLOBAL);
  return matches ? matches[matches.length - 1].toLowerCase() : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Exact-track donation request: no external fetch, no temp file. Ordering against free-text
// requests is NOT this function's job — server.ts runs it through the one shared
// DonationRequestQueue (spec A5). Only ownership is checked, not membership in the live playlist —
// the playlist may change between copying a command and donating (spec A4). Every failure is
// logged and returned; a real donation ignores the result (no feedback channel by design), the
// rule "Test" button reports it.
export async function executeLibraryTrackRequest(deps: LibraryTrackRequestDeps, query: string): Promise<LibraryTrackRequestResult> {
  const id = extractTrackId(query);
  if (!id) {
    console.error(`library track request failed: no track id in query "${query}"`);
    return { ok: false, reason: 'trackIdMissing', message: 'no track id found in the command' };
  }

  const row = await deps.trackRepository.findById(id);
  if (!row || row.userId !== deps.targetUserId) {
    console.error(`library track request failed: track ${id} not found for the donation target`);
    return { ok: false, reason: 'trackNotFound', message: `track ${id} not found` };
  }

  const track: Track = {
    name: row.name,
    audioPath: row.audioPath,
    coverPath: row.coverPath,
    overlayOverride: row.overlayOverride as TrackOverlayOverride | null,
  };

  try {
    deps.streamInserter.enqueueTrack(deps.targetUserId, track);
  } catch (err) {
    console.error('library track request failed: no active local stream to insert into', err);
    return { ok: false, reason: 'noActiveStream', message: errorMessage(err) };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest test/donations/libraryTrackRequestAction.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/donations/libraryTrackRequestAction.ts test/donations/libraryTrackRequestAction.test.ts
git commit -m "feat(donations): resolve an exact library-track donation command by its trailing uuid"
```

---

### Task 4b: `DonationRequestQueue` — one arrival-ordered queue for every donation action

**Files:**
- Create: `src/donations/donationRequestQueue.ts` (by `git mv src/donations/songRequestQueue.ts src/donations/donationRequestQueue.ts`, then edit)
- Test: `test/donations/donationRequestQueue.test.ts` (by `git mv test/donations/songRequestQueue.test.ts test/donations/donationRequestQueue.test.ts`, then edit)
- Modify: `src/server.ts` (only the import/constructor, so the build stays green; full rewiring is Task 5)

**Interfaces:**
- Produces: `class DonationRequestQueue { constructor(options?: { taskTimeoutMs?: number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout }); enqueue<R>(task: () => Promise<R>): Promise<R> }`; `DONATION_TASK_TIMEOUT_MS = 90_000`.

- [ ] **Step 1: Rewrite the tests for the task-based API** — replace the moved file's contents:

```ts
import { DonationRequestQueue } from '../../src/donations/donationRequestQueue';

const later = <T>(ms: number, value: T, log?: string[], tag?: string) =>
  new Promise<T>((resolve) => setTimeout(() => { log?.push(tag!); resolve(value); }, ms));

describe('DonationRequestQueue', () => {
  it('processes tasks strictly in enqueue order, even when a later one would resolve faster', async () => {
    const order: string[] = [];
    const queue = new DonationRequestQueue();
    const p1 = queue.enqueue(() => later(50, 'slow free-text', order, 'first'));
    const p2 = queue.enqueue(() => later(0, 'instant exact-track', order, 'second'));
    expect(await Promise.all([p1, p2])).toEqual(['slow free-text', 'instant exact-track']);
    expect(order).toEqual(['first', 'second']);
  });

  it('does not START the next task until the previous one has settled', async () => {
    const queue = new DonationRequestQueue();
    let resolveFirst!: (v: string) => void;
    const second = jest.fn(() => Promise.resolve('b'));
    queue.enqueue(() => new Promise<string>((r) => { resolveFirst = r; }));
    queue.enqueue(second);
    await Promise.resolve(); await Promise.resolve();
    expect(second).not.toHaveBeenCalled();
    resolveFirst('a');
    await new Promise((r) => setImmediate(r));
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('a rejecting task never stalls the ones behind it', async () => {
    const queue = new DonationRequestQueue();
    const failing = queue.enqueue(() => Promise.reject(new Error('boom')));
    const next = queue.enqueue(() => Promise.resolve('ok'));
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });

  it('head-of-line timeout: a hung task stops blocking the queue after taskTimeoutMs (knock-on of one shared queue)', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const queue = new DonationRequestQueue({ taskTimeoutMs: 1000 });
      const hung = queue.enqueue(() => new Promise<string>(() => {}));
      const behind = jest.fn(() => Promise.resolve('ran'));
      const p = queue.enqueue(behind);
      await Promise.resolve();
      expect(behind).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1000);
      await expect(p).resolves.toBe('ran');
      expect(warn).toHaveBeenCalled();
      void hung; // never settles; the caller's own promise stays pending, which is fine
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  it('a task that resolves AFTER its timeout still resolves its own promise (inserting late, out of order) and disturbs nothing queued after it', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const queue = new DonationRequestQueue({ taskTimeoutMs: 1000 });
      const inserted: string[] = [];
      let finishSlow!: () => void;
      const slow = queue.enqueue(() => new Promise<string>((r) => { finishSlow = () => { inserted.push('slow'); r('slow done'); }; }));
      const second = queue.enqueue(async () => { inserted.push('second'); return 'second done'; });
      const third = queue.enqueue(async () => { inserted.push('third'); return 'third done'; });
      await Promise.resolve();
      jest.advanceTimersByTime(1000); // slow times out -> queue moves on
      await expect(second).resolves.toBe('second done');
      await expect(third).resolves.toBe('third done');
      finishSlow(); // completes late
      await expect(slow).resolves.toBe('slow done');
      expect(inserted).toEqual(['second', 'third', 'slow']); // documented: that one request lands out of order
      jest.advanceTimersByTime(5000);
      expect(warn).toHaveBeenCalledTimes(1); // only the one real timeout was logged
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  it('a task that throws SYNCHRONOUSLY rejects its own promise, releases the queue at once, and leaves no stray timeout log', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const queue = new DonationRequestQueue({ taskTimeoutMs: 1000 });
      const bad = queue.enqueue(() => { throw new Error('sync'); });
      const next = queue.enqueue(() => Promise.resolve('ok'));
      await expect(bad).rejects.toThrow('sync');
      await expect(next).resolves.toBe('ok');
      jest.advanceTimersByTime(5000);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/donations/donationRequestQueue.test.ts`
Expected: FAIL — `DonationRequestQueue` is not exported.

- [ ] **Step 3: Implement** — replace `src/donations/donationRequestQueue.ts`'s contents:

```ts
export const DONATION_TASK_TIMEOUT_MS = 90_000;

// ONE queue for every donation-triggered action (free-text song requests AND exact library-track
// requests): "whoever donated first plays first". A task is not even started until every task
// enqueued ahead of it has settled, so a donation's place in the play queue is fixed by when the
// webhook (or the rule Test button) dispatched it — never by which task happened to finish first.
// An exact-track task is two indexed queries and resolves almost at once when its turn comes; a
// free-text task waits on the external media-search download. Deliberately fully sequential.
//
// Head-of-line timeout: HttpMediaSearchClient sets no timeout of its own, so a stuck download is
// bounded only by Node fetch's default (~300s), and would hold up every later donation of BOTH
// types for that long. After taskTimeoutMs the queue moves on. The timed-out task is not
// cancelled: if it completes later it still inserts — one request out of order (logged), instead
// of every later donation delayed by minutes. 90s is well above a normal download, and above the
// point at which the media-search service normally answers with its own 504; retune it if that
// service's own timeout changes.
//
// The caller's OWN promise is never affected by this timeout: it settles when its task does. So
// the rule "Test" button's HTTP request simply waits for its own task — up to fetch's ~300s in the
// worst case — and then reports the real outcome. Accepted as-is: it's a manual, one-person
// diagnostic tool, and a real result beats a synthetic "timed out".
export class DonationRequestQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly taskTimeoutMs: number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  constructor(options: { taskTimeoutMs?: number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout } = {}) {
    this.taskTimeoutMs = options.taskTimeoutMs ?? DONATION_TASK_TIMEOUT_MS;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  // The timeout is armed when the task STARTS (inside the tail callback), not at enqueue time, so
  // time spent waiting behind other donations never counts against a task's own budget.
  enqueue<R>(task: () => Promise<R>): Promise<R> {
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const result = this.tail.then(() => {
      const timer = this.setTimer(() => {
        console.error(`donation task still running after ${this.taskTimeoutMs}ms; releasing the queue so later donations aren't blocked (this one may now land out of order)`);
        release();
      }, this.taskTimeoutMs);
      let run: Promise<R>;
      try {
        run = task();
      } catch (err) {
        // A synchronous throw: clear the timer too, or it would log a bogus "still running" later.
        this.clearTimer(timer);
        release();
        throw err;
      }
      run.then(() => undefined, () => undefined).finally(() => { this.clearTimer(timer); release(); });
      return run;
    });
    result.catch(() => release()); // defensive; release() is idempotent
    this.tail = released;
    return result;
  }
}
```

(The tests pin this: a task behind a hung one starts exactly `taskTimeoutMs` after the hung one STARTED.)

In `src/server.ts`, replace the `SongRequestQueue` import and construction for now with:

```ts
  const donationQueue = new DonationRequestQueue();
  const songRequestQueue = { enqueue: (query: string) => donationQueue.enqueue(() => executeSongRequest(
    { mediaSearchClient, streamInserter: localStreamManager, tempDir: donationTempDir, targetUserId: config.donationTargetUserId },
    query,
  )) };
```

(a temporary shim so this task's commit builds; Task 5 replaces it with the handlers object).

- [ ] **Step 4: Run to verify pass**

Run: `npx jest test/donations` then `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/donations/donationRequestQueue.ts test/donations/donationRequestQueue.test.ts src/server.ts
git commit -m "refactor(donations): generalize SongRequestQueue into one task-ordered DonationRequestQueue with a head-of-line timeout"
```

---

### Task 5: Action types, keyword uniqueness, dispatch by type

**Files:**
- Create: `src/donations/donationActions.ts`
- Modify: `src/donations/interactionRuleRoutes.ts`, `src/donations/donatelloWebhookRoutes.ts`, `src/api/app.ts`, `src/server.ts`, `src/api/openapi.ts`, `src/requestPage/publicRequestPageRoutes.ts` (use the constant)
- Test: `test/donations/interactionRuleRoutes.test.ts`, `test/donations/donatelloWebhookRoutes.test.ts`, `test/api/openapi.test.ts` (and any other `createApp` caller)

**Interfaces:**
- Consumes: `executeLibraryTrackRequest` (Task 4), `SongRequestResult`, `DonationRequestQueue.enqueue` (Task 4b).
- Produces: `ACTION_TYPES = ['songRequest', 'libraryTrackRequest'] as const`; `type ActionType`; `LIBRARY_TRACK_REQUEST: ActionType`; `type DonationActionResult = SongRequestResult | LibraryTrackRequestResult`; `type DonationActionHandlers = Record<ActionType, (query: string) => Promise<DonationActionResult>>`; `isActionType(value: string): value is ActionType`. `InteractionRuleTestDeps` becomes `{ converter; actions: DonationActionHandlers }`; `DonatelloWebhookDeps.executeSongRequest` is replaced by `actions: DonationActionHandlers`.

- [ ] **Step 1: Failing tests**

In `test/donations/interactionRuleRoutes.test.ts`: change `buildTestDeps` to

```ts
function buildTestDeps(overrides: Partial<{ converter: any; actions: any }> = {}) {
  return {
    converter: { toUah: (amount: number) => amount },
    actions: {
      songRequest: jest.fn().mockResolvedValue({ ok: true }),
      libraryTrackRequest: jest.fn().mockResolvedValue({ ok: true }),
    },
    ...overrides,
  };
}
```

and replace every `testDeps.executeSongRequest` assertion with `testDeps.actions.songRequest`. Add:

```ts
  describe('libraryTrackRequest and keyword uniqueness', () => {
    it('accepts the new action type', async () => {
      const repo = buildFakeRepository();
      const res = await request(buildApp(repo)).post('/interaction-rules')
        .send({ actionType: 'libraryTrackRequest', enabled: true, minAmount: 50, commandKeyword: 'track' });
      expect(res.status).toBe(201);
    });

    it('409s a keyword already used by another of the caller\'s rules, case-insensitively', async () => {
      const repo = buildFakeRepository([{ id: 'r1', userId: 'user-1', actionType: 'songRequest', enabled: true, minAmount: 50, commandKeyword: 'song' }]);
      const res = await request(buildApp(repo)).post('/interaction-rules')
        .send({ actionType: 'libraryTrackRequest', enabled: true, minAmount: 50, commandKeyword: 'SONG' });
      expect(res.status).toBe(409);
    });

    it('a keyword used only by ANOTHER user is fine', async () => {
      const repo = buildFakeRepository([{ id: 'r1', userId: 'user-2', actionType: 'songRequest', enabled: true, minAmount: 50, commandKeyword: 'song' }]);
      const res = await request(buildApp(repo)).post('/interaction-rules').send(validBody);
      expect(res.status).toBe(201);
    });

    it('PUT may keep its own keyword but not take a sibling\'s', async () => {
      const repo = buildFakeRepository([
        { id: 'r1', userId: 'user-1', actionType: 'songRequest', enabled: true, minAmount: 50, commandKeyword: 'song' },
        { id: 'r2', userId: 'user-1', actionType: 'libraryTrackRequest', enabled: true, minAmount: 50, commandKeyword: 'track' },
      ]);
      const app = buildApp(repo);
      expect((await request(app).put('/interaction-rules/r1').send({ enabled: false, minAmount: 60, commandKeyword: 'song' })).status).toBe(200);
      expect((await request(app).put('/interaction-rules/r1').send({ enabled: false, minAmount: 60, commandKeyword: 'track' })).status).toBe(409);
    });

    it('the test route dispatches by the rule\'s own actionType', async () => {
      const repo = buildFakeRepository([{ id: 'r2', userId: 'user-1', actionType: 'libraryTrackRequest', enabled: true, minAmount: 50, commandKeyword: 'track' }]);
      const testDeps = buildTestDeps();
      testDeps.actions.libraryTrackRequest.mockResolvedValue({ ok: false, reason: 'trackNotFound', message: 'x' });
      const res = await request(buildApp(repo, 'user-1', testDeps)).post('/interaction-rules/r2/test')
        .send({ message: '!track:Believer 3f2b9c1e-8d4a-4e2b-9a7c-1b2c3d4e5f60' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ matched: true, query: 'Believer 3f2b9c1e-8d4a-4e2b-9a7c-1b2c3d4e5f60', result: { ok: false, reason: 'trackNotFound', message: 'x' } });
      expect(testDeps.actions.songRequest).not.toHaveBeenCalled();
    });
  });
```

In `test/donations/donatelloWebhookRoutes.test.ts`: replace `executeSongRequest: jest.fn()` in each `buildApp(...)` with `actions: { songRequest: jest.fn(), libraryTrackRequest: jest.fn() }` and the dispatch assertion with `actions.songRequest`. Add:

```ts
  it('dispatches each matched rule to the handler for its own actionType', async () => {
    const listEnabledByUser = jest.fn().mockResolvedValue([
      { id: 'r1', userId: 'u1', actionType: 'libraryTrackRequest', enabled: true, minAmount: 100, commandKeyword: 'track', createdAt: new Date(), updatedAt: new Date() },
    ]);
    const actions = { songRequest: jest.fn(), libraryTrackRequest: jest.fn().mockResolvedValue({ ok: true }) };
    const app = buildApp({ callbackKey: 'secret', ruleRepository: { listEnabledByUser }, actions, converter: { toUah: (a: number) => a }, targetUserId: 'u1' });
    await request(app).post('/webhooks/donatello').set('X-Key', 'secret').send({ ...validBody, message: 'hi !track:Believer 3f2b9c1e-8d4a-4e2b-9a7c-1b2c3d4e5f60' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(actions.libraryTrackRequest).toHaveBeenCalledWith('Believer 3f2b9c1e-8d4a-4e2b-9a7c-1b2c3d4e5f60');
    expect(actions.songRequest).not.toHaveBeenCalled();
  });

  it('skips (logs) a stored rule with an unknown actionType instead of throwing', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const listEnabledByUser = jest.fn().mockResolvedValue([
      { id: 'r1', userId: 'u1', actionType: 'bogus', enabled: true, minAmount: 1, commandKeyword: 'song', createdAt: new Date(), updatedAt: new Date() },
    ]);
    const actions = { songRequest: jest.fn(), libraryTrackRequest: jest.fn() };
    const app = buildApp({ callbackKey: 'secret', ruleRepository: { listEnabledByUser }, actions, converter: { toUah: (a: number) => a }, targetUserId: 'u1' });
    const res = await request(app).post('/webhooks/donatello').set('X-Key', 'secret').send(validBody);
    await new Promise((resolve) => setImmediate(resolve));
    expect(res.status).toBe(200);
    expect(actions.songRequest).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/donations`
Expected: FAIL — type errors on `actions`, 400 for the new action type, no 409.

- [ ] **Step 3: Implement**

`src/donations/donationActions.ts`:

```ts
import { SongRequestResult } from './songRequestAction';
import { LibraryTrackRequestResult } from './libraryTrackRequestAction';

// Every interaction-rule action type the app can execute. A real string column in the DB
// (InteractionRule.actionType), validated against this list on write.
export const ACTION_TYPES = ['songRequest', 'libraryTrackRequest'] as const;
export type ActionType = typeof ACTION_TYPES[number];
export const LIBRARY_TRACK_REQUEST: ActionType = 'libraryTrackRequest';

export function isActionType(value: string): value is ActionType {
  return (ACTION_TYPES as readonly string[]).includes(value);
}

export type DonationActionResult = SongRequestResult | LibraryTrackRequestResult;

// ONE object, built once in server.ts and shared by the real webhook and the rule "Test" button,
// so a test exercises exactly the handler a real donation would.
export type DonationActionHandlers = Record<ActionType, (query: string) => Promise<DonationActionResult>>;
```

`src/donations/interactionRuleRoutes.ts`:
- `InteractionRuleTestDeps` → `{ converter: CurrencyConverter; actions: DonationActionHandlers }`.
- Delete `KNOWN_ACTION_TYPES`; in `validateRuleBody` use `if (typeof actionType !== 'string' || !isActionType(actionType)) throw new ApiError(400, \`body.actionType must be one of: ${ACTION_TYPES.join(', ')}\`);`.
- Router takes `ruleRepository: Pick<InteractionRuleRepository, 'listByUser' | 'findById' | 'create' | 'update' | 'delete'>` (it already calls these). Add helper inside `createInteractionRuleRouter`:

```ts
  // Two rules sharing a keyword would BOTH fire on one donation (matchRules returns every match)
  // — e.g. a copied library command also sent to the media-search service as garbage free text.
  // Enforced here rather than as a DB constraint so pre-existing duplicates keep working.
  const assertKeywordFree = async (ownerId: string, keyword: string, exceptRuleId?: string) => {
    const rules = await ruleRepository.listByUser(ownerId);
    if (rules.some((r) => r.id !== exceptRuleId && r.commandKeyword.toLowerCase() === keyword)) {
      throw new ApiError(409, `another rule already uses the command keyword "!${keyword}"`);
    }
  };
```

Call `await assertKeywordFree(userId(req), input.commandKeyword);` in POST after validation, and `await assertKeywordFree(userId(req), input.commandKeyword, existing.id);` in PUT after validation.
- In the test route replace `testDeps.executeSongRequest(match.query)` with:

```ts
    const actionType = match.rule.actionType;
    if (!isActionType(actionType)) throw new ApiError(409, `rule has an unsupported action type: ${actionType}`);
    const result = await testDeps.actions[actionType](match.query);
```

`src/donations/donatelloWebhookRoutes.ts`: replace `executeSongRequest` in `DonatelloWebhookDeps` with `actions: DonationActionHandlers;`, and the dispatch loop (and its now-obsolete "becomes a real dispatch" comment) with:

```ts
    const matches = matchRules(event, rules, deps.converter);
    for (const match of matches) {
      const actionType = match.rule.actionType;
      if (!isActionType(actionType)) {
        console.error(`donation matched rule ${match.rule.id} with unknown actionType "${actionType}", skipping`);
        continue;
      }
      deps.actions[actionType](match.query).catch((err) => {
        console.error('donation-triggered action failed', err);
      });
    }
```

`src/api/app.ts`: pass `{ converter: deps.donatelloWebhookDeps.converter, actions: deps.donatelloWebhookDeps.actions }` to `createInteractionRuleRouter`.

`src/server.ts`: import `executeLibraryTrackRequest` and `DonationActionHandlers`; replace Task 4b's temporary `songRequestQueue` shim with:

```ts
  // ONE arrival-ordered queue for every donation action, shared by the real webhook and the rule
  // "Test" button: whoever donated first plays first, across BOTH action types (user decision —
  // see the design spec, edge case A5). An exact-track request waits behind an earlier free-text
  // request that is still downloading.
  const donationQueue = new DonationRequestQueue();
  const donationActions: DonationActionHandlers = {
    songRequest: (query) => donationQueue.enqueue(() => executeSongRequest(
      { mediaSearchClient, streamInserter: localStreamManager, tempDir: donationTempDir, targetUserId: config.donationTargetUserId },
      query,
    )),
    libraryTrackRequest: (query) => donationQueue.enqueue(() => executeLibraryTrackRequest(
      { trackRepository, streamInserter: localStreamManager, targetUserId: config.donationTargetUserId },
      query,
    )),
  };
```

(The closures reference `localStreamManager`, which is constructed later in the function — safe because they only run at request time, exactly as the old `songRequestQueue` closure already did.) In `donatelloWebhookDeps` replace `executeSongRequest: …` with `actions: donationActions`.

Add to `test/donations/donatelloWebhookRoutes.test.ts` the end-to-end ordering case through a real `DonationRequestQueue` (the shape `server.ts` builds):

```ts
  it('one shared queue: an earlier slow free-text donation plays before a later instant exact-track one', async () => {
    const queue = new DonationRequestQueue();
    const inserted: string[] = [];
    const actions = {
      songRequest: (q: string) => queue.enqueue(() => new Promise((r) => setTimeout(() => { inserted.push(`song:${q}`); r({ ok: true }); }, 30))),
      libraryTrackRequest: (q: string) => queue.enqueue(async () => { inserted.push(`lib:${q}`); return { ok: true }; }),
    } as any;
    const listEnabledByUser = jest.fn().mockResolvedValue([
      { id: 'r1', userId: 'u1', actionType: 'songRequest', enabled: true, minAmount: 1, commandKeyword: 'song', createdAt: new Date(), updatedAt: new Date() },
      { id: 'r2', userId: 'u1', actionType: 'libraryTrackRequest', enabled: true, minAmount: 1, commandKeyword: 'track', createdAt: new Date(), updatedAt: new Date() },
    ]);
    const app = buildApp({ callbackKey: 'secret', ruleRepository: { listEnabledByUser }, actions, converter: { toUah: (a: number) => a }, targetUserId: 'u1' });
    await request(app).post('/webhooks/donatello').set('X-Key', 'secret').send({ ...validBody, message: '!song:Believer' });
    await request(app).post('/webhooks/donatello').set('X-Key', 'secret').send({ ...validBody, message: '!track:X 3f2b9c1e-8d4a-4e2b-9a7c-1b2c3d4e5f60' });
    await new Promise((r) => setTimeout(r, 100));
    expect(inserted).toEqual(['song:Believer', 'lib:X 3f2b9c1e-8d4a-4e2b-9a7c-1b2c3d4e5f60']);
  });
```

(import `DonationRequestQueue` from `../../src/donations/donationRequestQueue`).

`src/requestPage/publicRequestPageRoutes.ts`: replace the literal `'libraryTrackRequest'` with `LIBRARY_TRACK_REQUEST`.

`src/api/openapi.ts`: update the `/interaction-rules` POST summary/enum to list both action types and mention the 409 on a duplicate keyword; update `/interaction-rules/{id}/test` summary "dispatches the rule's own action".

Update `test/api/openapi.test.ts` (and any other `createApp` caller found with Grep) to pass `actions` instead of `executeSongRequest` in `donatelloWebhookDeps`.

- [ ] **Step 4: Run to verify pass**

Run: `npm test` then `npm run build`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/donations src/api src/server.ts src/requestPage test
git commit -m "feat(donations): libraryTrackRequest action type, per-user unique keywords, dispatch by type"
```

---

### Task 6: Frontend API layer

**Files:**
- Create: `frontend/src/api/requestPage.ts`
- Modify: `frontend/src/api/interactionRules.ts`
- Test: `frontend/src/api/requestPage.test.ts`

**Interfaces:**
- Produces: `requestPageApi.get(): Promise<{ token: string | null }>`, `.rotate(): Promise<{ token: string }>`, `.disable(): Promise<{ token: null }>`; `fetchPublicRequestPage(token: string): Promise<PublicRequestPageResult>` where `PublicRequestPageResult = { kind: 'notFound' } | { kind: 'offline' } | { kind: 'live'; playlistName: string; tracks: PublicTrack[]; request: { keyword: string; minAmount: number } | null }`; `buildRequestCommand(keyword: string, trackName: string, trackId: string): string`; `requestPageUrl(token: string): string`. In `interactionRules.ts`: `ActionType = 'songRequest' | 'libraryTrackRequest'`, `DonationActionResult` (replaces `SongRequestResult`, reasons `'mediaSearchFailed' | 'writeFailed' | 'noActiveStream' | 'trackIdMissing' | 'trackNotFound'`).

- [ ] **Step 1: Failing tests** — `frontend/src/api/requestPage.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRequestCommand, fetchPublicRequestPage } from './requestPage';

const ID = '3f2b9c1e-8d4a-4e2b-9a7c-1b2c3d4e5f60';

describe('buildRequestCommand', () => {
  it('keyword, 20-char prefix, space, full uuid', () => {
    expect(buildRequestCommand('track', 'Imagine Dragons - Believer (Live)', ID))
      .toBe(`!track:Imagine Dragons - Bel ${ID}`);
  });
  it('collapses whitespace and newlines and trims', () => {
    expect(buildRequestCommand('t', '  Two\n\nlines\t here ', ID)).toBe(`!t:Two lines here ${ID}`);
  });
  it('truncates by code point, never splitting an emoji', () => {
    const name = '🎵'.repeat(25);
    const command = buildRequestCommand('t', name, ID);
    expect(command).toBe(`!t:${'🎵'.repeat(20)} ${ID}`);
    expect(command).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
  it('keeps short names whole', () => {
    expect(buildRequestCommand('t', 'Short', ID)).toBe(`!t:Short ${ID}`);
  });
});

describe('fetchPublicRequestPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps 404 to notFound and sends no credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 404, ok: false, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchPublicRequestPage('abc')).toEqual({ kind: 'notFound' });
    expect(fetchMock.mock.calls[0][1]?.credentials ?? 'omit').toBe('omit');
  });
  it('maps {live:false} to offline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ live: false }) }));
    expect(await fetchPublicRequestPage('abc')).toEqual({ kind: 'offline' });
  });
  it('maps a live body', async () => {
    const body = { live: true, playlistName: 'P', tracks: [{ id: ID, name: 'x', durationSeconds: 1 }], request: null };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => body }));
    expect(await fetchPublicRequestPage('abc')).toEqual({ kind: 'live', playlistName: 'P', tracks: body.tracks, request: null });
  });
  it('throws on other failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 500, ok: false, json: async () => ({}) }));
    await expect(fetchPublicRequestPage('abc')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/api/requestPage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `frontend/src/api/requestPage.ts`:

```ts
import { api, API_BASE_URL } from './client';

export interface PublicTrack { id: string; name: string; durationSeconds: number | null }

export type PublicRequestPageResult =
  | { kind: 'notFound' }
  | { kind: 'offline' }
  | { kind: 'live'; playlistName: string; tracks: PublicTrack[]; request: { keyword: string; minAmount: number } | null };

const PREFIX_CODE_POINTS = 20;

// "!<keyword>:<prefix> <uuid>". The prefix is for humans reading the donation feed; the backend
// matches on the trailing uuid only (the last uuid-shaped substring). Code points, not UTF-16
// units, so an emoji is never cut into a lone surrogate.
export function buildRequestCommand(keyword: string, trackName: string, trackId: string): string {
  const oneLine = trackName.replace(/\s+/g, ' ').trim();
  const prefix = Array.from(oneLine).slice(0, PREFIX_CODE_POINTS).join('').trim();
  return `!${keyword}:${prefix} ${trackId}`;
}

export function requestPageUrl(token: string): string {
  return `${window.location.origin}/r/${token}`;
}

// Plain fetch, NOT the shared `api` client: a donor is anonymous, so no credentials are sent.
export async function fetchPublicRequestPage(token: string): Promise<PublicRequestPageResult> {
  const res = await fetch(`${API_BASE_URL}/public/request-page/${encodeURIComponent(token)}`, { credentials: 'omit' });
  if (res.status === 404) return { kind: 'notFound' };
  if (!res.ok) throw new Error(`request page failed with status ${res.status}`);
  const body = await res.json();
  if (!body.live) return { kind: 'offline' };
  return { kind: 'live', playlistName: body.playlistName, tracks: body.tracks, request: body.request };
}

export const requestPageApi = {
  get: () => api.get<{ token: string | null }>('/request-page'),
  rotate: () => api.post<{ token: string }>('/request-page/token', {}),
  disable: () => api.delete<{ token: null }>('/request-page/token'),
};
```

Note: `api.delete` sends a `Content-Type: application/json` header but no body. That is fine only because `DELETE /request-page/token` deliberately has no `requireJsonRequest` guard (Task 2): Express's `req.is()` returns null for a bodiless request whatever the header says, so the guard would 400 every real browser call.

`frontend/src/api/interactionRules.ts`: `export type ActionType = 'songRequest' | 'libraryTrackRequest';`; rename `SongRequestResult` to `DonationActionResult` with reasons `'mediaSearchFailed' | 'writeFailed' | 'noActiveStream' | 'trackIdMissing' | 'trackNotFound'`; update `TestInteractionRuleResult` to use it.

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/api && npx tsc --noEmit -p .`
Expected: PASS (fix any `SongRequestResult` import in `Donations.tsx` by renaming).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api
git commit -m "feat(frontend): request-page API client and donation command builder"
```

---

### Task 7: Public `RequestPage` at `/r/:token`

**Files:**
- Create: `frontend/src/pages/RequestPage.tsx`
- Modify: `frontend/src/App.tsx`, `frontend/src/i18n/locales/{en,ru,uk}.json`
- Test: `frontend/src/pages/RequestPage.test.tsx`

**Interfaces:**
- Consumes: `fetchPublicRequestPage`, `buildRequestCommand` (Task 6).

- [ ] **Step 1: Add i18n keys** (en shown; ru/uk translate the same keys) under a new top-level `"requestPage"` object:

```json
  "requestPage": {
    "title": "Request a track",
    "loading": "Loading…",
    "notFound": "This link isn't valid.",
    "offline": "The stream isn't live right now.",
    "requestsDisabled": "Track requests aren't enabled right now.",
    "howTo": "Copy a command and paste it into your donation message (minimum {{amount}} UAH).",
    "copy": "Copy",
    "copied": "Copied",
    "copyManually": "Copy this command:",
    "refresh": "Refresh",
    "error": "Couldn't load the page."
  }
```

- [ ] **Step 2: Failing tests** — `frontend/src/pages/RequestPage.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import RequestPage from './RequestPage';
import { fetchPublicRequestPage } from '../api/requestPage';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../api/requestPage', async (orig) => ({ ...(await orig<typeof import('../api/requestPage')>()), fetchPublicRequestPage: vi.fn() }));

const ID = '3f2b9c1e-8d4a-4e2b-9a7c-1b2c3d4e5f60';
const render = () => renderWithProviders(<Routes><Route path="/r/:token" element={<RequestPage />} /></Routes>, { route: '/r/tok' });

describe('RequestPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loading', () => {
    vi.mocked(fetchPublicRequestPage).mockReturnValue(new Promise(() => {}));
    render();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('not found', async () => {
    vi.mocked(fetchPublicRequestPage).mockResolvedValue({ kind: 'notFound' });
    render();
    expect(await screen.findByText("This link isn't valid.")).toBeInTheDocument();
  });

  it('offline', async () => {
    vi.mocked(fetchPublicRequestPage).mockResolvedValue({ kind: 'offline' });
    render();
    expect(await screen.findByText("The stream isn't live right now.")).toBeInTheDocument();
  });

  it('live without a rule: tracks, no copy buttons', async () => {
    vi.mocked(fetchPublicRequestPage).mockResolvedValue({ kind: 'live', playlistName: 'Set', tracks: [{ id: ID, name: 'Believer', durationSeconds: 200 }], request: null });
    render();
    expect(await screen.findByText('Believer')).toBeInTheDocument();
    expect(screen.getByText("Track requests aren't enabled right now.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
  });

  it('live with a rule: copy writes the command to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    vi.mocked(fetchPublicRequestPage).mockResolvedValue({ kind: 'live', playlistName: 'Set', tracks: [{ id: ID, name: 'Believer', durationSeconds: 200 }], request: { keyword: 'track', minAmount: 50 } });
    render();
    await userEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(`!track:Believer ${ID}`);
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('falls back to a selectable field when the clipboard rejects', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    vi.mocked(fetchPublicRequestPage).mockResolvedValue({ kind: 'live', playlistName: 'Set', tracks: [{ id: ID, name: 'Believer', durationSeconds: 200 }], request: { keyword: 'track', minAmount: 50 } });
    render();
    await userEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(await screen.findByDisplayValue(`!track:Believer ${ID}`)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd frontend && npx vitest run src/pages/RequestPage.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement** — `frontend/src/pages/RequestPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { buildRequestCommand, fetchPublicRequestPage, PublicTrack } from '../api/requestPage';
import { formatSeconds } from './requestPageFormat';

// PUBLIC page (no auth, no AppShell): a donor opens it from the streamer's shared link. Loaded
// once — no polling/SSE by design; a manual Refresh only.
export default function RequestPage() {
  const { t } = useTranslation();
  const { token = '' } = useParams();
  // Load-time only (spec): no refetch on window focus/reconnect, only the manual Refresh button.
  const query = useQuery({
    queryKey: ['public-request-page', token],
    queryFn: () => fetchPublicRequestPage(token),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  useEffect(() => {
    // Never leak the token through Referer (spec A16).
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
    document.title = t('requestPage.title');
    return () => { meta.remove(); };
  }, [t]);

  return (
    <main className="mx-auto max-w-2xl space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('requestPage.title')}</h1>
        <button onClick={() => query.refetch()} className="text-sm underline">{t('requestPage.refresh')}</button>
      </div>
      {query.isLoading && <p>{t('requestPage.loading')}</p>}
      {query.isError && <p className="text-red-600">{t('requestPage.error')}</p>}
      {query.data?.kind === 'notFound' && <p>{t('requestPage.notFound')}</p>}
      {query.data?.kind === 'offline' && <p>{t('requestPage.offline')}</p>}
      {query.data?.kind === 'live' && (
        <>
          <h2 className="text-lg">{query.data.playlistName}</h2>
          {query.data.request
            ? <p className="text-sm text-gray-600">{t('requestPage.howTo', { amount: query.data.request.minAmount })}</p>
            : <p className="text-sm text-gray-600">{t('requestPage.requestsDisabled')}</p>}
          <ul className="divide-y rounded-lg border">
            {query.data.tracks.map((track) => (
              <TrackRow key={track.id} track={track} keyword={query.data.kind === 'live' ? query.data.request?.keyword ?? null : null} />
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

function TrackRow({ track, keyword }: { track: PublicTrack; keyword: string | null }) {
  const { t } = useTranslation();
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const command = keyword ? buildRequestCommand(keyword, track.name, track.id) : null;

  const copy = async () => {
    if (!command) return;
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(command);
      setState('copied');
    } catch {
      setState('manual'); // non-secure context or permission denied (spec A13)
    }
  };

  return (
    <li className="p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate">{track.name}</div>
          {track.durationSeconds !== null && <div className="text-xs text-gray-500">{formatSeconds(track.durationSeconds)}</div>}
        </div>
        {command && (
          <button onClick={copy} className="shrink-0 rounded bg-black px-3 py-1 text-sm text-white">
            {state === 'copied' ? t('requestPage.copied') : t('requestPage.copy')}
          </button>
        )}
      </div>
      {state === 'manual' && command && (
        <label className="mt-2 block text-xs text-gray-500">
          {t('requestPage.copyManually')}
          <input readOnly value={command} onFocus={(e) => e.currentTarget.select()} autoFocus className="mt-1 w-full rounded border p-2 font-mono text-sm" />
        </label>
      )}
    </li>
  );
}
```

Create `frontend/src/pages/requestPageFormat.ts`:

```ts
export function formatSeconds(total: number): string {
  const s = Math.max(0, Math.round(total));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
```

`frontend/src/App.tsx`: import `RequestPage` and add `<Route path="/r/:token" element={<RequestPage />} />` next to `/login` — **outside** `<Route element={<ProtectedRoute />}>`.

- [ ] **Step 5: Run to verify pass**

Run: `cd frontend && npx vitest run && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/RequestPage.tsx frontend/src/pages/requestPageFormat.ts frontend/src/pages/RequestPage.test.tsx frontend/src/App.tsx frontend/src/i18n/locales
git commit -m "feat(frontend): public track request page at /r/:token"
```

---

### Task 8: Donations page — share-link card, real action-type select, test panel

**Files:**
- Modify: `frontend/src/pages/Donations.tsx`, `frontend/src/i18n/locales/{en,ru,uk}.json`
- Test: `frontend/src/pages/Donations.test.tsx`

**Interfaces:**
- Consumes: `requestPageApi`, `requestPageUrl` (Task 6); `ActionType`, `DonationActionResult` (Task 6).

- [ ] **Step 1: i18n keys** under `donations` (en; translate for ru/uk):

```json
    "actionLibraryTrackRequest": "Exact track from my playlist",
    "sharePage": {
      "title": "Request page",
      "description": "Share this link so donors can copy an exact track command.",
      "none": "No link yet.",
      "create": "Create link",
      "copy": "Copy link",
      "copied": "Link copied",
      "rotate": "Regenerate",
      "rotateConfirmTitle": "Regenerate the link?",
      "rotateConfirmDescription": "The old link stops working immediately. Commands donors already copied keep working.",
      "disable": "Disable",
      "noRuleHint": "No enabled \"Exact track\" rule — the page will list tracks but offer no command."
    },
    "test.pasteCommandHint": "paste a command copied from your request page"
```

(nest `pasteCommandHint` inside the existing `donations.test` object.)

- [ ] **Step 2: Failing tests** — add to `Donations.test.tsx` (at the top: `import { requestPageApi, requestPageUrl } from '../api/requestPage';` and `vi.mock('../api/requestPage');`; in `beforeEach` default `vi.mocked(requestPageApi.get).mockResolvedValue({ token: null })`):

```tsx
  it('shows the share link and creates one', async () => {
    vi.mocked(interactionRulesApi.list).mockResolvedValue([]);
    vi.mocked(requestPageApi.get).mockResolvedValueOnce({ token: null }).mockResolvedValueOnce({ token: 'f'.repeat(32) });
    vi.mocked(requestPageApi.rotate).mockResolvedValue({ token: 'f'.repeat(32) });
    vi.mocked(requestPageUrl).mockImplementation((t: string) => `https://app.example/r/${t}`);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Create link' }));
    expect(requestPageApi.rotate).toHaveBeenCalled();
    expect(await screen.findByText(`https://app.example/r/${'f'.repeat(32)}`)).toBeInTheDocument();
  });

  it('warns when no enabled libraryTrackRequest rule exists', async () => {
    vi.mocked(interactionRulesApi.list).mockResolvedValue([RULE]);
    vi.mocked(requestPageApi.get).mockResolvedValue({ token: 'f'.repeat(32) });
    renderPage();
    expect(await screen.findByText(/No enabled "Exact track" rule/)).toBeInTheDocument();
  });

  it('creates a libraryTrackRequest rule, swapping the untouched default keyword', async () => {
    vi.mocked(interactionRulesApi.list).mockResolvedValue([]);
    vi.mocked(interactionRulesApi.create).mockResolvedValue({ ...RULE, actionType: 'libraryTrackRequest', commandKeyword: 'track' });
    renderPage();
    await userEvent.click(await screen.findByText('+ Add rule'));
    await userEvent.selectOptions(screen.getByRole('combobox'), 'libraryTrackRequest');
    const amount = screen.getByRole('spinbutton');
    await userEvent.clear(amount);
    await userEvent.type(amount, '50');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(interactionRulesApi.create).toHaveBeenCalledWith({ actionType: 'libraryTrackRequest', enabled: true, minAmount: 50, commandKeyword: 'track' }));
  });
```

- [ ] **Step 3: Run to verify failure**

Run: `cd frontend && npx vitest run src/pages/Donations.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Implement in `Donations.tsx`**

- `ACTION_TYPE_LABELS` gains `libraryTrackRequest: 'donations.actionLibraryTrackRequest'`.
- `RuleFormState` gains `actionType: ActionType`; `EMPTY_FORM = { actionType: 'songRequest', minAmount: '', commandKeyword: 'song', enabled: true }`; `RuleForm` takes `isEdit: boolean`. Replace the disabled `<select>` with:

```tsx
        <select
          value={form.actionType}
          disabled={isEdit}
          onChange={(e) => {
            const actionType = e.target.value as ActionType;
            const defaults: Record<ActionType, string> = { songRequest: 'song', libraryTrackRequest: 'track' };
            const untouched = form.commandKeyword === defaults[form.actionType];
            setForm({ ...form, actionType, commandKeyword: untouched ? defaults[actionType] : form.commandKeyword });
          }}
          className="mt-1 w-full rounded border p-2"
        >
          <option value="songRequest">{t('donations.actionSongRequest')}</option>
          <option value="libraryTrackRequest">{t('donations.actionLibraryTrackRequest')}</option>
        </select>
```

  and submit `actionType: form.actionType`. Pass `isEdit={drawerState.mode === 'edit'}` and include `actionType: drawerState.rule.actionType` in the edit `initial`.
- `RuleTestPanel`'s initial message: `rule.actionType === 'libraryTrackRequest' ? \`!${rule.commandKeyword}:\${t('donations.test.pasteCommandHint')}\` : …existing…`. Its error toast already prints `data.result.message`, which covers the new reasons.
- New `SharePageCard({ rules })` component rendered between the subtitle and the rules list:

```tsx
function SharePageCard({ rules }: { rules: InteractionRule[] }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [confirmRotate, setConfirmRotate] = useState(false);
  const linkQuery = useQuery({ queryKey: ['request-page'], queryFn: requestPageApi.get });
  const onDone = () => queryClient.invalidateQueries({ queryKey: ['request-page'] });
  const rotate = useMutation({ mutationFn: requestPageApi.rotate, onSuccess: () => { setConfirmRotate(false); onDone(); } });
  const disable = useMutation({ mutationFn: requestPageApi.disable, onSuccess: onDone });
  const token = linkQuery.data?.token ?? null;
  const hasEnabledRule = rules.some((r) => r.actionType === 'libraryTrackRequest' && r.enabled);

  return (
    <section className="space-y-2 rounded-lg border p-3">
      <h2 className="font-medium">{t('donations.sharePage.title')}</h2>
      <p className="text-sm text-gray-500">{t('donations.sharePage.description')}</p>
      {token ? (
        <div className="flex flex-wrap items-center gap-2">
          <code className="break-all rounded bg-gray-50 px-2 py-1 text-sm">{requestPageUrl(token)}</code>
          <button className="text-sm underline" onClick={() => navigator.clipboard?.writeText(requestPageUrl(token)).then(() => toast.success(t('donations.sharePage.copied')))}>{t('donations.sharePage.copy')}</button>
          <button className="text-sm underline" onClick={() => setConfirmRotate(true)}>{t('donations.sharePage.rotate')}</button>
          <button className="text-sm text-red-600" onClick={() => disable.mutate()}>{t('donations.sharePage.disable')}</button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500">{t('donations.sharePage.none')}</span>
          <button className="rounded bg-black px-3 py-1 text-sm text-white" onClick={() => rotate.mutate()}>{t('donations.sharePage.create')}</button>
        </div>
      )}
      {!hasEnabledRule && <p className="text-xs text-amber-700">{t('donations.sharePage.noRuleHint')}</p>}
      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        title={t('donations.sharePage.rotateConfirmTitle')}
        description={t('donations.sharePage.rotateConfirmDescription')}
        confirmLabel={t('donations.sharePage.rotate')}
        isPending={rotate.isPending}
        onConfirm={() => rotate.mutate()}
      />
    </section>
  );
}
```

  Render it as `<SharePageCard rules={rulesQuery.data ?? []} />`.

- [ ] **Step 5: Run to verify pass**

Run: `cd frontend && npx vitest run && npx tsc --noEmit -p . && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Donations.tsx frontend/src/pages/Donations.test.tsx frontend/src/i18n/locales
git commit -m "feat(frontend): request-page share link and exact-track rule type on the Donations page"
```

---

### Task 9: Docs and real end-to-end check

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: CLAUDE.md** — add a new subsection right after "Donation-triggered song requests":

```markdown
**Exact library-track requests + the public request page.** A second action type,
`libraryTrackRequest`, lets a donor request an EXACT track. The streamer shares
`/r/<requestPageToken>` (a public frontend page, outside the authenticated shell), which reads
`GET /public/request-page/:token` — the ONE unauthenticated read besides `/auth/*` — listing the
tracks of the owner's currently-live playlist (`streaming`/`paused`/`reconnecting`; anything else
is `{live:false}`), read fresh from the DB at page load (no live updates). Each track copies
`!<keyword>:<first 20 code points of its name> <track uuid>`. `executeLibraryTrackRequest`
(`src/donations/libraryTrackRequestAction.ts`) takes the LAST uuid in the matched query, checks the
track belongs to `DONATION_TARGET_USER_ID` (ownership only, not membership in the live playlist),
and calls `LocalStreamManager.enqueueTrack` — no media-search fetch, no temp file — through the
SAME `DonationRequestQueue` as free-text requests, so the two types play strictly in donation
order (an exact-track request waits behind an earlier free-text one that is still downloading).
The token is `User.requestPageToken` — 128-bit hex, unique, minted/rotated/disabled
only via `POST`/`DELETE /request-page/token` (owner, `requireAuth`), and never the `userId`. The
public route 404s a malformed token by shape before any DB call, answers the same 404 for an
unknown one, sets `no-store` + `no-referrer`, and exposes only names/ids/durations. Rule keywords
are unique per user (409), since two rules sharing one would both fire. The webhook and the rule
"Test" button dispatch through one shared `DonationActionHandlers` object built in `server.ts`
(`src/donations/donationActions.ts`).
```

  Rewrite the existing "**Donation ordering is by arrival, not by download speed (`songRequestQueue.ts`).**" paragraph for `DonationRequestQueue` (`donationRequestQueue.ts`): one task-generic queue for BOTH action types, `enqueue(() => …)`, still fully sequential, one instance in `server.ts` shared by the webhook and the Test button, plus the 90 s head-of-line timeout (a hung media-search download releases the queue after 90 s; that one task may then land out of order, logged), and the residual race: two webhooks arriving within one `listEnabledByUser` round trip are ordered by when that read resolves. Update the Layout tree's `songRequestQueue.ts` entry accordingly.

  Also: add the three new routes to "HTTP API"; add `src/requestPage/` and the new donation files to the Layout tree; add `requestPageToken` to the `prisma/` line; update `InteractionRule` "`actionType` today always `'songRequest'`" → "`'songRequest'` or `'libraryTrackRequest'`".

- [ ] **Step 2: Commit docs**

```bash
git add CLAUDE.md
git commit -m "docs: document exact library-track requests and the public request page"
```

- [ ] **Step 3: Real end-to-end (record results in the final report)**

On the stand (192.168.14.26; re-apply and verify the port-8088 mapping after the redeploy, per memory): deploy, `npx prisma migrate deploy` against the stand DB (via the app container's normal startup, if that's how migrations are applied there — check `docker-compose.yml`/Dockerfile first). Then:
1. Create a `libraryTrackRequest` rule (keyword `track`) as the `DONATION_TARGET_USER_ID` account; create the request link; start a stream.
2. Open `/r/<token>` in a private window: the live playlist lists; Copy produces the command.
3. Paste it into the rule's Test panel → toast success; `nextTrack` in `/local-stream/status` is that track; it plays after the current one.
4. If Donatello is available: send a real donation with the copied command (plus a greeting before it and "thanks" after it) → queued. Note the maximum message length Donatello accepted (spec A15).
5. Regenerate the link → the old URL shows "not valid"; stop the stream → the page shows "not live". Then click **Disable** on the Donations page in a real browser: it must succeed (200, and the card switches to "Create link"), and the last link must now show "not valid". Nothing else exercises the bodiless browser DELETE.
6. Ordering (user decision): fire a `songRequest` Test and, a second later, a `libraryTrackRequest` Test; confirm via `/local-stream/status`'s `nextTrack` and by listening that the free-text track (the one that had to download) plays first, then the exact track.
