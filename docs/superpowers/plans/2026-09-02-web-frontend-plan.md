# Web Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the super-dj web frontend (phase 5, final roadmap phase) — a React SPA covering
login/register, track/playlist management, connecting streaming destinations, and per-destination
stream control with live status — plus the small, additive backend changes it depends on (CORS +
cross-origin session cookies, a push-based live-status mechanism via SSE, and two small
data-shape fixes the existing API doesn't yet expose).

**Architecture:** `frontend/` is a new, independently-built/deployed Vite + React + TypeScript
project (own `package.json`) with a strict `api/` (typed fetch client, no React) /
`components/`+`pages/` (UI) split, so the `api/` layer ports almost unchanged to a future React
Native app. The backend gains an `EventEmitter`-based push mechanism (`StreamManager` emits
`statusChanged`; `StreamController`/`YoutubeProvider` call an injected hook at every state-
mutation point) feeding a new SSE route, replacing what would otherwise be a polling loop.

**Tech Stack:** React 18, TypeScript, Vite, React Router, Tailwind CSS, Radix UI primitives
(hand-built minimal Button/Dialog/Tabs components in the shadcn/ui style — shadcn's own CLI is
interactive and copies component source into your project rather than installing a package, so a
non-interactive plan builds the same small set of primitives directly instead of running it),
TanStack Query, `@dnd-kit/core`/`@dnd-kit/sortable` (playlist reorder), `sonner` (toasts).
Backend additions use the existing Express/Prisma stack plus the `cors` npm package.

**Spec:** [docs/superpowers/specs/2026-09-02-web-frontend-design.md](../specs/2026-09-02-web-frontend-design.md)

## Global Constraints

- The frontend deploys as its own container, separate from the backend's origin — every backend
  change in this plan (CORS, cookie attributes, SSE) exists to make that split work.
- `frontend/src/api/*` is the only place that calls `fetch` — every page/component goes through
  it, and it has zero React imports.
- Live stream status is pushed via SSE, never polled on an interval.
- `frontend/` gets its own test setup (Vitest + React Testing Library, mocked `fetch` for the
  `api/` layer) — no Playwright/e2e for this phase.
- Every backend addition follows this repo's existing conventions from `CLAUDE.md`: ffmpeg/
  external calls are injected and faked in tests (already true for `Spawner`/`YoutubeApiClient`;
  the new `EventEmitter`-based emission is tested the same structural-fake way), thin Prisma
  repositories are not unit-tested.
- No Prisma schema changes in this plan — the two backend data-shape fixes (Task 1) are
  query/response-shape changes only, no migration needed.

---

### Task 1: Backend data-shape fixes — playlist track ids, track cover serving

**Files:**
- Modify: `src/playlists/playlistRepository.ts`
- Modify: `src/tracks/trackRoutes.ts`
- Test: `test/tracks/trackRoutes.test.ts` (new cases; file already exists)

**Interfaces:**
- Produces: `PlaylistTrackView` gains `id: string`; new route `GET /tracks/:id/cover`.

Two gaps in the existing API block the frontend from doing what the approved spec says it must:
the playlist editor needs each track's own id to build `PUT /playlists/:id/tracks`'s
`trackIds: string[]` body, but `GET /playlists/:id`'s track objects don't carry one; and the
Library page needs to show a cover thumbnail, but uploaded cover files are never served over
HTTP anywhere in this codebase (`UPLOADS_DIR` is only ever read from disk by the backend itself,
for ffmpeg). Both are small, additive fixes to code this plan's frontend tasks depend on.

- [ ] **Step 1: Write the failing test for `GET /tracks/:id/cover`**

Read `test/tracks/trackRoutes.test.ts` first to match its existing fixture/style, then add:

```ts
  it('GET /tracks/:id/cover streams the cover file for an owned track', async () => {
    const coverPath = path.join(os.tmpdir(), `cover-test-${Date.now()}.png`);
    await fs.writeFile(coverPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic bytes, minimal
    const trackRepository: any = {
      findById: jest.fn().mockResolvedValue({ id: 't1', userId: 'user-1', coverPath }),
    };
    const res = await request(buildApp(trackRepository)).get('/tracks/t1/cover');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\//);
    await fs.unlink(coverPath);
  });

  it('GET /tracks/:id/cover 404s when the track has no cover', async () => {
    const trackRepository: any = {
      findById: jest.fn().mockResolvedValue({ id: 't1', userId: 'user-1', coverPath: null }),
    };
    const res = await request(buildApp(trackRepository)).get('/tracks/t1/cover');
    expect(res.status).toBe(404);
  });

  it('GET /tracks/:id/cover returns 403 for another user\'s track', async () => {
    const trackRepository: any = {
      findById: jest.fn().mockResolvedValue({ id: 't1', userId: 'someone-else', coverPath: '/x.png' }),
    };
    const res = await request(buildApp(trackRepository)).get('/tracks/t1/cover');
    expect(res.status).toBe(403);
  });
```

Add `import * as fs from 'fs/promises';`, `import * as os from 'os';`, `import { posix as path } from 'path';` at the top if not already present (check first — `path` is likely already imported).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest test/tracks/trackRoutes.test.ts`
Expected: FAIL — 404 (route doesn't exist) instead of 200/403 on the new cases.

- [ ] **Step 3: Add the route to `src/tracks/trackRoutes.ts`**

Read the current file first. Add this route inside `createTrackRouter`, after the existing
`GET /` route and before `DELETE /:id`:

```ts
  router.get('/:id/cover', auth, wrapAsync(async (req, res) => {
    const track = await trackRepository.findById(req.params.id);
    if (!track) throw new ApiError(404, 'track not found');
    if (track.userId !== (req as AuthenticatedRequest).user!.id) throw new ApiError(403, 'not your track');
    if (!track.coverPath) throw new ApiError(404, 'track has no cover');
    res.sendFile(track.coverPath);
  }));
```

`res.sendFile` requires an absolute path — `coverPath` is already absolute (built from
`uploadsDir` in `TrackUploadService`), and it sets `Content-Type` from the file extension
automatically (Express uses `mime` internally), matching the assertion above.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest test/tracks/trackRoutes.test.ts`
Expected: PASS (all cases, old and new)

- [ ] **Step 5: Add the failing test for `PlaylistTrackView.id`**

Read `test/playlists/playlistRoutes.test.ts` first (it fakes `playlistRepository`, so this is
really about the repository's return shape — the route test just needs to confirm `id` passes
through). Find the test covering `GET /playlists/:id` and extend its fixture/assertion:

```ts
  it('GET /playlists/:id includes each track\'s id', async () => {
    const playlistRepository: any = {
      findById: jest.fn().mockResolvedValue({ id: 'p1', userId: 'user-1', name: 'Mix' }),
      listTracks: jest.fn().mockResolvedValue([{ id: 't1', name: 'a', audioPath: '/a.mp3', coverPath: null }]),
    };
    const res = await request(buildApp(playlistRepository)).get('/playlists/p1');
    expect(res.status).toBe(200);
    expect(res.body.tracks[0].id).toBe('t1');
  });
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx jest test/playlists/playlistRoutes.test.ts`
Expected: PASS already, actually — the route just passes `tracks` through verbatim, so this test
only starts failing once `playlistRepository.ts`'s real `listTracks` is fixed AND this fake
fixture is the thing under test, not the real repository. Since this is a route-level test with a
faked repository, it will pass trivially regardless of the repository's real behavior. This step
exists to document the contract; the real regression protection is Step 7's repository change
plus Step 8's manual verification. Proceed to Step 7 regardless of this test's result.

- [ ] **Step 7: Fix `src/playlists/playlistRepository.ts`**

Read the current file first. Change `PlaylistTrackView` and `listTracks`:

```ts
export interface PlaylistTrackView {
  id: string;
  name: string;
  audioPath: string;
  coverPath: string | null;
}
```

```ts
  async listTracks(playlistId: string): Promise<PlaylistTrackView[]> {
    const rows = await this.prisma.playlistTrack.findMany({
      where: { playlistId },
      orderBy: { position: 'asc' },
      include: { track: true },
    });
    return rows.map((row) => ({
      id: row.track.id,
      name: row.track.name,
      audioPath: row.track.audioPath,
      coverPath: row.track.coverPath,
    }));
  }
```

- [ ] **Step 8: Verify the build compiles and existing consumers still typecheck**

`PlaylistTrackView` widens (adds a field), which is compatible with every existing consumer —
`StreamManager`'s `Track[]` mapping in `src/stream/streamManager.ts` only reads `name`/
`audioPath`/`coverPath` off these objects and never constructs a `PlaylistTrackView` literal
itself, so the extra `id` field passes through harmlessly.

Run: `npm run build`
Expected: `tsc` clean

- [ ] **Step 9: Run the full suite**

Run: `npx jest`
Expected: all suites PASS

- [ ] **Step 10: Commit**

```bash
git add src/tracks/trackRoutes.ts test/tracks/trackRoutes.test.ts src/playlists/playlistRepository.ts test/playlists/playlistRoutes.test.ts
git commit -m "feat: serve track covers, expose track id in playlist track listings

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Backend — CORS and cross-origin session cookies

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/auth/sessionCookie.ts`
- Modify: `src/api/app.ts`
- Modify: `package.json`
- Test: `test/config/env.test.ts`, `test/auth/sessionCookie.test.ts`, `test/api/openapi.test.ts`

**Interfaces:**
- Consumes: none new.
- Produces: `AppConfig` gains `frontendOrigin: string`. `app.ts` applies CORS middleware before
  every route.

The frontend runs on a different origin than the API (confirmed design decision), so the backend
needs to allow credentialed cross-origin requests from exactly that origin, and the session
cookie needs `SameSite=None` in production for the browser to send it cross-site at all (which in
turn requires `Secure`, i.e. HTTPS — already true of the existing `secure: NODE_ENV===
'production'` line, so this reuses that same signal rather than adding a new one).

- [ ] **Step 1: Add the `cors` dependency**

Add to `package.json`'s `"dependencies"`: `"cors": "^2.8.5"`. Add to `"devDependencies"`:
`"@types/cors": "^2.8.17"`.

Run: `npm install`

- [ ] **Step 2: Write the failing config test**

Add to `test/config/env.test.ts` (new `describe` block; do not touch the existing ones — read the
file first to match its exact `base` fixture pattern from the other blocks):

```ts
describe('loadConfig — frontend origin', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db', STREAM_KEY_ENCRYPTION_KEY: 'a'.repeat(64),
    GOOGLE_OAUTH_CLIENT_ID: 'x', GOOGLE_OAUTH_CLIENT_SECRET: 'y', APP_BASE_URL: 'https://app.example.com',
  } as NodeJS.ProcessEnv;

  it('applies FRONTEND_ORIGIN', () => {
    const config = loadConfig({ ...base, FRONTEND_ORIGIN: 'https://web.example.com' } as NodeJS.ProcessEnv);
    expect(config.frontendOrigin).toBe('https://web.example.com');
  });

  it('throws when FRONTEND_ORIGIN is missing', () => {
    expect(() => loadConfig(base)).toThrow('FRONTEND_ORIGIN environment variable is required');
  });
});
```

- [ ] **Step 2b: Fix every other test file's env/`AppConfig` fixtures**

Every existing `base`/literal-`AppConfig` fixture across `test/config/env.test.ts`'s other
`describe` blocks and `test/server.test.ts` needs `FRONTEND_ORIGIN: 'https://web.example.com'`
(env fixtures) or `frontendOrigin: 'https://web.example.com'` (literal `AppConfig` objects) added
— the same mechanical fix this project's `CLAUDE.md`-documented convention already calls for
every time a new required config field is added (see how `GOOGLE_OAUTH_CLIENT_ID` etc. were
threaded through in the previous phase). Grep first: `grep -rn "GOOGLE_OAUTH_CLIENT_ID\|googleOAuthClientId" test/` to find every fixture that needs the new field alongside it.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest test/config/env.test.ts`
Expected: FAIL — `frontendOrigin` doesn't exist, `FRONTEND_ORIGIN` isn't validated.

- [ ] **Step 4: Implement in `src/config/env.ts`**

Read the current file first. Add `frontendOrigin: string;` to `AppConfig`, and:

```ts
  const frontendOrigin = env.FRONTEND_ORIGIN;
  // ...alongside the other required-var checks...
  if (!frontendOrigin) {
    throw new Error('FRONTEND_ORIGIN environment variable is required');
  }
  // ...in the returned object...
    frontendOrigin,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest test/config/env.test.ts`
Expected: PASS

- [ ] **Step 6: Write the failing session-cookie test**

Read `test/auth/sessionCookie.test.ts` first. Add:

```ts
  it('sets SameSite=None in production (cross-origin frontend needs it to send the cookie)', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const cookie = buildSessionCookie('session-1', new Date(Date.now() + 1000));
      expect(cookie).toContain('SameSite=None');
      expect(cookie).toContain('Secure');
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('sets SameSite=Lax outside production (local dev, no Secure requirement)', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const cookie = buildSessionCookie('session-1', new Date(Date.now() + 1000));
      expect(cookie).toContain('SameSite=Lax');
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `npx jest test/auth/sessionCookie.test.ts`
Expected: FAIL — cookie is always `SameSite=Lax` today.

- [ ] **Step 8: Implement in `src/auth/sessionCookie.ts`**

Read the current file first. Replace the fixed `sameSite: 'lax'` in both `buildSessionCookie` and
`clearSessionCookie` with a value derived the same way `secure` already is:

```ts
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
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx jest test/auth/sessionCookie.test.ts`
Expected: PASS

- [ ] **Step 10: Write the failing CORS test**

Read `test/api/openapi.test.ts` first — its `buildApp()` helper (no arguments) constructs a full
`createApp({...})` fixture with every dependency stubbed as `{}`/`jest.fn()`. Add
`frontendOrigin: 'https://web.example.com'` to that `createApp({...})` call's object literal
(this is the same fixture Step 2b already needs fixed — do both edits to this one call together),
then add:

```ts
  it('allows credentialed cross-origin requests from the configured frontend origin', async () => {
    const app = buildApp();
    const res = await request(app).options('/auth/me').set('Origin', 'https://web.example.com').set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBe('https://web.example.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
```

- [ ] **Step 11: Run test to verify it fails**

Run: `npx jest test/api/openapi.test.ts`
Expected: FAIL — no CORS headers present yet.

- [ ] **Step 12: Implement in `src/api/app.ts`**

Read the current file first. Add the `cors` import and a new `frontendOrigin: string` field to
`AppDeps`, and apply the middleware as the very first thing in `createApp`, before
`express.json()`:

```ts
import cors from 'cors';
// ...
export interface AppDeps {
  // ...existing fields...
  frontendOrigin: string;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(cors({ origin: deps.frontendOrigin, credentials: true }));
  app.use(express.json());
  // ...rest unchanged...
```

- [ ] **Step 13: Run tests to verify they pass**

Run: `npx jest test/api/openapi.test.ts test/auth/sessionCookie.test.ts test/config/env.test.ts`
Expected: PASS

- [ ] **Step 14: Run the full suite and build**

Run: `npx jest && npm run build`
Expected: all PASS, `tsc` clean (this will surface any other fixture needing `frontendOrigin` —
fix and re-run until clean; `src/server.ts` also needs `frontendOrigin: config.frontendOrigin`
added to its `createApp({...})` call — make that fix now too, it's a one-line addition to an
existing object literal).

- [ ] **Step 15: Commit**

```bash
git add package.json package-lock.json src/config/env.ts src/auth/sessionCookie.ts src/api/app.ts src/server.ts test/config/env.test.ts test/auth/sessionCookie.test.ts test/api/openapi.test.ts test/server.test.ts
git commit -m "feat: CORS + cross-origin session cookie support for the separately-deployed frontend

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Backend — StreamManager/StreamController event emission

**Files:**
- Modify: `src/stream/streamController.ts`
- Modify: `src/stream/streamManager.ts`
- Modify: `src/destinations/streamDestinationProvider.ts`
- Modify: `src/destinations/youtubeProvider.ts`
- Test: `test/stream/streamController.test.ts`, `test/stream/streamManager.test.ts`, `test/destinations/youtubeProvider.test.ts`

**Interfaces:**
- Produces: `StreamControllerDeps` gains `onStatusChanged?: () => void`. `DestinationLifecycle`
  gains `onPhaseChange?(cb: () => void): void`. `StreamManager extends EventEmitter`, emitting
  `'statusChanged'` with `(destinationId: string)` whenever any destination's status changes.

This is the mechanism the SSE route (Task 4) subscribes to. No public method signatures change —
`StreamManager.pause()`/`resume()`/`next()`/`previous()`/`playByName()`/`stop()` all keep working
exactly as before; they just now also cause an event to fire, because the emission is wired once,
at controller-construction time in `start()`, via a hook `StreamController` already had a slot
for (the same pattern as the existing `onError` hook from the previous phase).

- [ ] **Step 1: Write the failing `StreamController` test**

Read `test/stream/streamController.test.ts` first (it has a `buildDeps()` helper — reuse it).
Add:

```ts
  it('invokes deps.onStatusChanged after start(), pause(), resume(), next(), previous(), playByName(), and stop()', async () => {
    const { deps } = buildDeps();
    const onStatusChanged = jest.fn();
    deps.onStatusChanged = onStatusChanged;
    const controller = new StreamController(deps);

    await controller.start();
    expect(onStatusChanged).toHaveBeenCalledTimes(1);

    controller.pause();
    expect(onStatusChanged).toHaveBeenCalledTimes(2);

    await controller.resume();
    expect(onStatusChanged).toHaveBeenCalledTimes(3);

    await controller.next();
    expect(onStatusChanged).toHaveBeenCalledTimes(4);

    await controller.previous();
    expect(onStatusChanged).toHaveBeenCalledTimes(5);

    controller.playByName('a');
    expect(onStatusChanged).toHaveBeenCalledTimes(6);

    controller.stop();
    expect(onStatusChanged).toHaveBeenCalledTimes(7);
  });

  it('invokes deps.onStatusChanged when a track auto-advances', async () => {
    const { deps, children } = buildDeps();
    const onStatusChanged = jest.fn();
    deps.onStatusChanged = onStatusChanged;
    const controller = new StreamController(deps);
    await controller.start();
    onStatusChanged.mockClear();

    children[0].emitExit(0);

    expect(onStatusChanged).toHaveBeenCalledTimes(1);
  });
```

(This file's `buildDeps()` returns tracks `a`/`b` per the existing fixture — `playByName('a')`
matches the existing `library.findByName` fake. The second test reuses this file's existing
`children` array + `emitExit(code)` helper — the same idiom the file's other auto-advance tests
already use, e.g. `children[0].emitExit(0)` — to simulate the producer ffmpeg process's `'exit'`
event.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/stream/streamController.test.ts`
Expected: FAIL — `onStatusChanged` never called (doesn't exist yet).

- [ ] **Step 3: Implement in `src/stream/streamController.ts`**

Read the current file first. Add `onStatusChanged?: () => void;` to `StreamControllerDeps`. Add
`this.deps.onStatusChanged?.();` as the last line of `start()`, `stop()`, `pause()`, `resume()`,
`next()`, `previous()`, and `playByName()` (after each method's existing final statement — for
`start()`/`resume()` that's after the `if (track) { await this.feedCurrentTrack(track); }` block;
for the others it's straightforward). Also add it inside `advanceToNextTrack()`, right after
`const track = this.deps.queue.next();`:

```ts
  private advanceToNextTrack(): void {
    const track = this.deps.queue.next();
    this.deps.onStatusChanged?.();
    this.pausedElapsedSeconds = 0;
    if (track) {
      this.feedCurrentTrack(track).catch((err) => {
        console.error('failed to auto-advance to the next track', err);
      });
    }
  }
```

And inside the pusher's exit callback in `start()`:

```ts
    this.pusher.start(() => {
      this.state = 'error';
      this.deps.onError?.();
      this.deps.onStatusChanged?.();
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/stream/streamController.test.ts`
Expected: PASS (all tests, old and new)

- [ ] **Step 5: Add `onPhaseChange` to `DestinationLifecycle`**

Read `src/destinations/streamDestinationProvider.ts` first. Add one line:

```ts
export interface DestinationLifecycle {
  onPushStarted(): void;
  phase(): DestinationLifecyclePhase;
  watchUrl(): string | null;
  finalize(): Promise<void>;
  onPhaseChange?(cb: () => void): void;
}
```

- [ ] **Step 6: Write the failing `YoutubeProvider` test**

Read `test/destinations/youtubeProvider.test.ts` first (reuse its `buildProvider()` helper). Add:

```ts
  it('invokes a registered onPhaseChange listener at every phase transition', async () => {
    const client = fakeClient({ getStreamStatus: jest.fn().mockResolvedValue('active') } as any);
    const { provider, runNextScheduledPoll } = buildProvider(client as any);
    const session = await provider.prepareSession(destination, meta);
    const onPhaseChange = jest.fn();
    session.lifecycle!.onPhaseChange!(onPhaseChange);

    session.lifecycle!.onPushStarted(); // creating -> waitingForYoutube
    expect(onPhaseChange).toHaveBeenCalledTimes(1);

    await runNextScheduledPoll(); // waitingForYoutube -> live
    expect(onPhaseChange).toHaveBeenCalledTimes(2);

    await session.lifecycle!.finalize(); // live -> complete
    expect(onPhaseChange).toHaveBeenCalledTimes(3);
  });
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx jest test/destinations/youtubeProvider.test.ts`
Expected: FAIL — `onPhaseChange` is `undefined` on the returned lifecycle object.

- [ ] **Step 8: Implement in `src/destinations/youtubeProvider.ts`**

Read the current file first. Inside `prepareSession`, add a `phaseChangeListener` closure
variable alongside the existing `phase`/`pushStarted`/`finalized` ones, and call it at every
point `phase` is reassigned:

```ts
    let phase: DestinationLifecyclePhase = 'creating';
    let pushStarted = false;
    let finalized = false;
    let phaseChangeListener: (() => void) | null = null;

    const lifecycle: DestinationLifecycle = {
      onPushStarted: () => {
        if (pushStarted) return;
        pushStarted = true;
        phase = 'waitingForYoutube';
        phaseChangeListener?.();
        const deadline = this.clock() + this.healthTimeoutMs;

        const poll = async (): Promise<void> => {
          if (finalized) return;
          try {
            const freshAccessToken = await this.deps.client.refreshAccessToken(refreshToken);
            const status = await this.deps.client.getStreamStatus(freshAccessToken, stream.id);
            if (finalized) return;
            if (status === 'active') {
              await this.deps.client.transition(freshAccessToken, broadcast.id, 'live');
              phase = 'live';
              phaseChangeListener?.();
              return;
            }
          } catch (err) {
            console.error('YouTube health-check poll failed', err);
          }
          if (this.clock() >= deadline) {
            await lifecycle.finalize();
            phase = 'error';
            phaseChangeListener?.();
            return;
          }
          this.scheduleNextPoll(() => poll(), this.pollIntervalMs);
        };
        this.scheduleNextPoll(() => poll(), this.pollIntervalMs);
      },

      phase: () => phase,
      watchUrl: () => `https://www.youtube.com/watch?v=${broadcast.id}`,
      onPhaseChange: (cb) => { phaseChangeListener = cb; },

      finalize: async () => {
        if (finalized) return;
        finalized = true;
        if (pushStarted) {
          try {
            const accessToken2 = await this.deps.client.refreshAccessToken(refreshToken);
            await this.deps.client.transition(accessToken2, broadcast.id, 'complete');
          } catch (err) {
            console.error('failed to transition YouTube broadcast to complete', err);
          }
        }
        try {
          const accessToken3 = await this.deps.client.refreshAccessToken(refreshToken);
          await this.deps.client.deleteStream(accessToken3, stream.id);
        } catch (err) {
          console.error('failed to delete ephemeral YouTube liveStream', err);
        }
        phase = 'complete';
        phaseChangeListener?.();
      },
    };
```

Note the timeout branch calls `lifecycle.finalize()` (which itself calls `phaseChangeListener?.()`
once, setting `phase = 'complete'`) and THEN overwrites `phase = 'error'` afterward without a
second `phaseChangeListener?.()` call right there — that's intentional and matches this file's
existing established ordering fix (finalize-before-error, documented in its own comment above
this block): the listener already fired once for this transition via `finalize()`'s own call; the
external subscriber (SSE) reads `phase()` fresh each time it's notified, so it'll correctly see
`'error'` as the current value on that one notification, it just won't get a *second* redundant
notification for the same transition. Do not add a second `phaseChangeListener?.()` call after
the `phase = 'error'` line — one notification per real transition is correct here.

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx jest test/destinations/youtubeProvider.test.ts`
Expected: PASS (all tests, old and new)

- [ ] **Step 10: Write the failing `StreamManager` test**

Read `test/stream/streamManager.test.ts` first (reuse `buildDeps()`). Add:

```ts
  it('is an EventEmitter that emits statusChanged for a custom destination on pause/stop', async () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any);
    await manager.start('dest-1', 'playlist-1');
    const listener = jest.fn();
    manager.on('statusChanged', listener);

    manager.pause('dest-1');
    expect(listener).toHaveBeenCalledWith('dest-1');

    await manager.stop('dest-1');
    expect(listener).toHaveBeenCalledWith('dest-1');
  });

  it('emits statusChanged when a YouTube destination\'s lifecycle phase changes', async () => {
    const { deps, destinationRepository, youtubeLifecycle } = buildDeps();
    destinationRepository.findById.mockResolvedValue({ id: 'dest-1', userId: 'user-1', provider: 'youtube' });
    const manager = new StreamManager(deps as any);
    const listener = jest.fn();
    manager.on('statusChanged', listener);

    await manager.start('dest-1', 'playlist-1');

    // youtubeLifecycle is the fakeLifecycle() from this file's existing YouTube-destination
    // fixture — onPhaseChange must have been registered with a callback that, when invoked,
    // emits statusChanged for this destination.
    expect(youtubeLifecycle.onPhaseChange).toHaveBeenCalled();
    const registeredCallback = youtubeLifecycle.onPhaseChange.mock.calls[0][0];
    listener.mockClear();
    registeredCallback();
    expect(listener).toHaveBeenCalledWith('dest-1');
  });
```

`fakeLifecycle()` in this test file needs an `onPhaseChange: jest.fn()` added to its default
mock shape (find the helper and add the field alongside `onPushStarted`/`phase`/`watchUrl`/
`finalize`).

- [ ] **Step 11: Run tests to verify they fail**

Run: `npx jest test/stream/streamManager.test.ts`
Expected: FAIL — `manager.on` doesn't exist / `TypeError`, or listener never called.

- [ ] **Step 12: Implement in `src/stream/streamManager.ts`**

Read the current file first. Add the import and change the class declaration:

```ts
import { EventEmitter } from 'events';
// ...
export class StreamManager extends EventEmitter {
  private readonly controllers = new Map<string, StreamController>();
  private readonly lifecycles = new Map<string, { providerType: string; lifecycle: DestinationLifecycle }>();
  private readonly starting = new Set<string>();

  constructor(private readonly deps: StreamManagerDeps) {
    super();
  }
```

Inside `start()`, add `onStatusChanged` to the `StreamController` constructor call (alongside the
existing `onError`):

```ts
        onError: () => {
          const entry = this.lifecycles.get(destinationId);
          this.lifecycles.delete(destinationId);
          entry?.lifecycle.finalize().catch((err) => {
            console.error('failed to finalize destination lifecycle after an unexpected pusher exit', err);
          });
        },
        onStatusChanged: () => {
          this.emit('statusChanged', destinationId);
        },
      });
```

And register the phase-change listener right before `onPushStarted()` is called:

```ts
      if (session.lifecycle) {
        this.lifecycles.set(destinationId, { providerType: destination.provider, lifecycle: session.lifecycle });
        session.lifecycle.onPhaseChange?.(() => { this.emit('statusChanged', destinationId); });
        session.lifecycle.onPushStarted();
      }
```

No other method in this file changes — `pause`/`resume`/`next`/`previous`/`playByName`/`stop`
all delegate to the controller, which now emits on its own via the hook wired above.

- [ ] **Step 13: Run tests to verify they pass**

Run: `npx jest test/stream/streamManager.test.ts`
Expected: PASS (all tests, old and new)

- [ ] **Step 14: Run the full suite and build**

Run: `npx jest && npm run build`
Expected: all PASS, `tsc` clean

- [ ] **Step 15: Commit**

```bash
git add src/stream/streamController.ts src/stream/streamManager.ts src/destinations/streamDestinationProvider.ts src/destinations/youtubeProvider.ts test/stream/streamController.test.ts test/stream/streamManager.test.ts test/destinations/youtubeProvider.test.ts
git commit -m "feat: StreamManager emits statusChanged on every destination state/phase change

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Backend — SSE live-status route

**Files:**
- Modify: `src/stream/streamRoutes.ts`
- Modify: `src/api/openapi.ts`
- Test: `test/stream/streamEvents.test.ts` (new)

**Interfaces:**
- Consumes: `StreamManager.on('statusChanged', ...)`/`.off(...)` (Task 3), `StreamManager.status()`
  (existing).
- Produces: `GET /destinations/:destinationId/stream/events` — `text/event-stream`.

- [ ] **Step 1: Write the failing test**

Create `test/stream/streamEvents.test.ts`:

```ts
import express from 'express';
import { AddressInfo } from 'net';
import { createStreamRouter } from '../../src/stream/streamRoutes';
import { errorHandler } from '../../src/api/errorHandler';
import { StreamManager } from '../../src/stream/streamManager';

function buildApp(streamManager: any, userId = 'user-1') {
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: userId, email: 'a@example.com' }) };
  const destinationRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'dest-1', userId: 'user-1' }) };
  const app = express();
  app.use(express.json());
  app.use('/destinations/:destinationId/stream', createStreamRouter(authService, streamManager, destinationRepository));
  app.use(errorHandler);
  return app;
}

describe('GET .../stream/events (SSE)', () => {
  it('sends the current status immediately on connect', async () => {
    const streamManager = new StreamManager({} as any);
    jest.spyOn(streamManager, 'status').mockReturnValue({ state: 'idle', currentTrack: null, nextTrack: null });
    const app = buildApp(streamManager);
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/destinations/dest-1/stream/events`, { signal: controller.signal });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const text = Buffer.from(value!).toString('utf8');
      expect(text).toBe('data: {"state":"idle","currentTrack":null,"nextTrack":null}\n\n');
    } finally {
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('sends a new frame when the manager emits statusChanged for this destination, and ignores other destinations', async () => {
    const streamManager = new StreamManager({} as any);
    const statuses = [
      { state: 'idle', currentTrack: null, nextTrack: null },
      { state: 'streaming', currentTrack: 'a', nextTrack: 'b' },
    ];
    jest.spyOn(streamManager, 'status').mockImplementation(() => statuses.shift() ?? statuses[0]);
    const app = buildApp(streamManager);
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/destinations/dest-1/stream/events`, { signal: controller.signal });
      const reader = res.body!.getReader();
      await reader.read(); // initial frame

      streamManager.emit('statusChanged', 'some-other-destination');
      streamManager.emit('statusChanged', 'dest-1');
      const { value } = await reader.read();
      const text = Buffer.from(value!).toString('utf8');
      expect(text).toBe('data: {"state":"streaming","currentTrack":"a","nextTrack":"b"}\n\n');
    } finally {
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns 403 before opening the stream for a destination owned by someone else', async () => {
    const streamManager = new StreamManager({} as any);
    const app = buildApp(streamManager, 'user-1');
    const destinationRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'dest-1', userId: 'someone-else' }) };
    const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: 'user-1', email: 'a@example.com' }) };
    const app2 = express();
    app2.use('/destinations/:destinationId/stream', createStreamRouter(authService, streamManager, destinationRepository));
    app2.use(errorHandler);
    const res = await request(app2).get('/destinations/dest-1/stream/events');
    expect(res.status).toBe(403);
  });
});
```

(The third test needs `import request from 'supertest';` added at the top — a plain
request/response check doesn't need the real-server/fetch machinery the streaming tests do, since
a 403 short-circuits before the response ever becomes an open SSE stream.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/stream/streamEvents.test.ts`
Expected: FAIL — route doesn't exist (404s).

- [ ] **Step 3: Implement the route in `src/stream/streamRoutes.ts`**

Read the current file first. Add this route inside `createStreamRouter`, after the existing
`GET /status` route:

```ts
  router.get('/events', auth, wrapAsync(async (req, res) => {
    const destinationId = req.params.destinationId;
    await requireOwnedDestination(destinationRepository, destinationId, userId(req as AuthenticatedRequest));

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (): void => {
      res.write(`data: ${JSON.stringify(streamManager.status(destinationId))}\n\n`);
    };
    send();

    const listener = (id: string): void => {
      if (id === destinationId) send();
    };
    streamManager.on('statusChanged', listener);

    // Keeps intermediary proxies/load balancers from timing out an otherwise-idle connection.
    const heartbeat = setInterval(() => { res.write(':heartbeat\n\n'); }, 20000);

    req.on('close', () => {
      streamManager.off('statusChanged', listener);
      clearInterval(heartbeat);
    });
  }));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/stream/streamEvents.test.ts`
Expected: PASS

- [ ] **Step 5: Add the path to `src/api/openapi.ts`**

Read the current file first, find the existing `/destinations/{destinationId}/stream/status`
entry and add a sibling, following its exact style:

```ts
    '/destinations/{destinationId}/stream/events': {
      get: {
        summary: 'Server-Sent Events stream of this destination\'s live status',
        parameters: [{ name: 'destinationId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'text/event-stream — each event is a StreamStatus JSON payload' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your destination' },
          '404': { description: 'Destination not found' },
        },
      },
    },
```

- [ ] **Step 6: Run the full suite and build**

Run: `npx jest && npm run build`
Expected: all PASS, `tsc` clean

- [ ] **Step 7: Commit**

```bash
git add src/stream/streamRoutes.ts src/api/openapi.ts test/stream/streamEvents.test.ts
git commit -m "feat: SSE route for live per-destination stream status

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Backend — OAuth callback auto-close, docker-compose frontend service stub

**Files:**
- Modify: `src/destinations/oauthRoutes.ts`
- Modify: `test/destinations/oauthRoutes.test.ts`
- Modify: `docker-compose.yml`

**Interfaces:**
- Produces: the OAuth callback's HTML response now also `postMessage`s the opener and closes
  itself, so the frontend's connect-flow popup (Task 14) doesn't have to rely solely on polling.

- [ ] **Step 1: Write the failing test**

Read `test/destinations/oauthRoutes.test.ts` first, find the callback-success test, and extend
its assertion:

```ts
  it('GET /destinations/:provider/oauth/callback response tells the opener it connected and closes itself', async () => {
    const deps = buildDeps();
    const res = await request(buildApp(deps)).get('/destinations/youtube/oauth/callback?code=abc&state=state-1');
    expect(res.status).toBe(200);
    expect(res.text).toContain("window.opener.postMessage('super-dj-oauth-connected', '*')");
    expect(res.text).toContain('window.close()');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/destinations/oauthRoutes.test.ts`
Expected: FAIL — current response has no `<script>`.

- [ ] **Step 3: Implement in `src/destinations/oauthRoutes.ts`**

Read the current file first. Replace the final `res.status(200).send(...)` line in the callback
handler:

```ts
    res.status(200).send(`
<html><body>
  Connected — this tab will close automatically.
  <script>
    if (window.opener) { window.opener.postMessage('super-dj-oauth-connected', '*'); }
    window.close();
  </script>
</body></html>`.trim());
```

The message is a plain string, not scoped to a specific origin (`'*'`), because the popup and the
opener are on different origins by design (frontend origin vs. backend/API origin) and the
message payload carries no sensitive data — just a fixed "connected" signal the frontend already
knows to expect.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/destinations/oauthRoutes.test.ts`
Expected: PASS

- [ ] **Step 5: Add a frontend service stub to `docker-compose.yml`**

Read the current file first. Add a new service (Task 15 fills in its final shape once the
frontend's Dockerfile exists — `VITE_API_BASE_URL` ends up as a Docker build ARG there, not a
runtime `environment:` entry, since Vite bakes it into the static build at `vite build` time; this
step just reserves a service block so Task 15 edits an existing stub instead of inventing compose
structure from scratch):

```yaml
  frontend:
    build: ./frontend
    ports:
      - "5173:80"
    depends_on:
      - super-dj
    restart: unless-stopped
```

Also add `FRONTEND_ORIGIN: ${FRONTEND_ORIGIN}` to the existing `super-dj` service's `environment`
block (Task 2 made this required; docker-compose needs to pass it through like every other env
var already listed there).

- [ ] **Step 6: Run the full suite**

Run: `npx jest`
Expected: all PASS (docker-compose.yml isn't exercised by the test suite; this step just confirms
nothing else broke)

- [ ] **Step 7: Commit**

```bash
git add src/destinations/oauthRoutes.ts test/destinations/oauthRoutes.test.ts docker-compose.yml
git commit -m "feat: OAuth callback notifies its opener and self-closes; reserve a frontend compose service

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Frontend project scaffold

**Files:**
- Create: `frontend/package.json`, `frontend/tsconfig.json`, `frontend/tsconfig.node.json`,
  `frontend/vite.config.ts`, `frontend/tailwind.config.ts`, `frontend/postcss.config.js`,
  `frontend/index.html`, `frontend/src/main.tsx`, `frontend/src/App.tsx`, `frontend/src/index.css`,
  `frontend/src/test/setup.ts`, `frontend/.gitignore`
- Test: `frontend/src/App.test.tsx`

**Interfaces:**
- Produces: a buildable, testable, empty React app — `npm run dev`, `npm run build`,
  `npm test` all work from `frontend/`. Every later frontend task adds to this, never recreates it.

This establishes the frontend's own tooling and test convention (Vitest + React Testing Library,
`jsdom` environment) — there is no precedent for frontend testing in this repo yet, so this task
is where that convention is set, matching the plan's Global Constraints.

- [ ] **Step 1: Create `frontend/package.json`**

```json
{
  "name": "super-dj-frontend",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "@dnd-kit/core": "^6.1.0",
    "@dnd-kit/sortable": "^8.0.0",
    "@dnd-kit/utilities": "^3.2.2",
    "@radix-ui/react-dialog": "^1.1.1",
    "@radix-ui/react-tabs": "^1.1.0",
    "@tanstack/react-query": "^5.51.1",
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.1.1",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.25.1",
    "sonner": "^1.5.0",
    "tailwind-merge": "^2.4.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.4.8",
    "@testing-library/react": "^16.0.0",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "autoprefixer": "^10.4.19",
    "jsdom": "^24.1.1",
    "postcss": "^8.4.40",
    "tailwindcss": "^3.4.7",
    "typescript": "^5.5.3",
    "vite": "^5.3.4",
    "vitest": "^2.0.4"
  }
}
```

- [ ] **Step 2: Create `frontend/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **Step 3: Create `frontend/tsconfig.node.json`**

```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 4: Create `frontend/vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
  },
});
```

- [ ] **Step 5: Create `frontend/tailwind.config.ts`**

```ts
import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
```

- [ ] **Step 6: Create `frontend/postcss.config.js`**

```js
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
```

- [ ] **Step 7: Create `frontend/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>super-dj</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 8: Create `frontend/src/index.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 9: Create `frontend/src/main.tsx`**

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 10: Create `frontend/src/App.tsx`** (placeholder — replaced with real routing in Task 8)

```tsx
export default function App() {
  return <div className="p-4">super-dj</div>;
}
```

- [ ] **Step 11: Create `frontend/src/test/setup.ts`**

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 12: Write the failing smoke test — `frontend/src/App.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('App', () => {
  it('renders without crashing', () => {
    render(<App />);
    expect(screen.getByText('super-dj')).toBeInTheDocument();
  });
});
```

- [ ] **Step 13: Create `frontend/.gitignore`**

```
node_modules/
dist/
.env
```

- [ ] **Step 14: Install and run**

```bash
cd frontend && npm install
```

Run: `cd frontend && npm test`
Expected: PASS (1 test)

Run: `cd frontend && npm run build`
Expected: builds cleanly to `frontend/dist/`

- [ ] **Step 15: Commit**

```bash
git add frontend/
git commit -m "feat: scaffold the frontend Vite/React/TypeScript project

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Frontend — API client layer

**Files:**
- Create: `frontend/src/api/client.ts`, `frontend/src/api/auth.ts`, `frontend/src/api/tracks.ts`,
  `frontend/src/api/playlists.ts`, `frontend/src/api/destinations.ts`, `frontend/src/api/stream.ts`
- Test: `frontend/src/api/client.test.ts`, `frontend/src/api/resources.test.ts`
- Modify: `frontend/.env.example` (new file, documents `VITE_API_BASE_URL`)

**Interfaces:**
- Produces: `ApiError`, `api.{get,post,put,delete,postForm}` (`client.ts`); `authApi`, `tracksApi`,
  `playlistsApi`, `destinationsApi`, `streamApi` (one object per resource, matching every
  backend route from Task 1-5 and the pre-existing routes exactly). Every page/hook in later
  tasks imports only from these files, never calls `fetch` directly.

This is the only place `fetch` is called (per the plan's Global Constraints) and the only place
that knows the backend's base URL — `import.meta.env.VITE_API_BASE_URL`, a Vite build-time env
var (resolved at `vite build` time, see Task 15 for how the Docker build supplies it).

- [ ] **Step 1: Write the failing `client.ts` tests**

Create `frontend/src/api/client.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './client';

describe('api client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetchOnce(status: number, body: unknown) {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
  }

  it('get() sends credentials and parses a JSON response', async () => {
    mockFetchOnce(200, { id: 'x' });
    const result = await api.get<{ id: string }>('/tracks');
    expect(result).toEqual({ id: 'x' });
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/tracks');
    expect(init.credentials).toBe('include');
  });

  it('post() sends a JSON body with the right content-type', async () => {
    mockFetchOnce(200, {});
    await api.post('/playlists', { name: 'Mix' });
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ name: 'Mix' }));
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('postForm() sends FormData without forcing a JSON content-type', async () => {
    mockFetchOnce(200, {});
    const form = new FormData();
    form.append('name', 'x');
    await api.postForm('/tracks', form);
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.body).toBe(form);
    expect(init.headers).toBeUndefined();
  });

  it('throws a typed ApiError with the backend\'s error message on a non-2xx response', async () => {
    mockFetchOnce(403, { error: 'not your playlist' });
    await expect(api.get('/playlists/p1')).rejects.toMatchObject(
      new ApiError(403, 'not your playlist'),
    );
  });

  it('falls back to a generic message if the error body has no error field', async () => {
    mockFetchOnce(500, {});
    await expect(api.get('/tracks')).rejects.toMatchObject({ status: 500 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/api/client.test.ts`
Expected: FAIL — `Cannot find module './client'`

- [ ] **Step 3: Implement `frontend/src/api/client.ts`**

```ts
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL as string;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isFormData = init.body instanceof FormData;
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: isFormData ? undefined : { 'Content-Type': 'application/json', ...init.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, typeof body.error === 'string' ? body.error : `request failed with status ${res.status}`);
  }
  return res.json();
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>(path),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'PUT', body: body !== undefined ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' }),
  postForm: <T>(path: string, formData: FormData): Promise<T> => request<T>(path, { method: 'POST', body: formData }),
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/api/client.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Implement the five resource modules**

`frontend/src/api/auth.ts`:

```ts
import { api } from './client';

export interface AuthUser {
  id: string;
  email: string;
}

export const authApi = {
  register: (email: string, password: string) => api.post<AuthUser>('/auth/register', { email, password }),
  login: (email: string, password: string) => api.post<AuthUser>('/auth/login', { email, password }),
  logout: () => api.post<Record<string, never>>('/auth/logout'),
  me: () => api.get<AuthUser>('/auth/me'),
};
```

`frontend/src/api/tracks.ts`:

```ts
import { api, API_BASE_URL } from './client';

export interface Track {
  id: string;
  name: string;
  durationSeconds: number | null;
  hasCover: boolean;
}

export const tracksApi = {
  list: () => api.get<Track[]>('/tracks'),
  upload: (audio: File, cover: File | null, name: string | undefined) => {
    const form = new FormData();
    form.append('audio', audio);
    if (cover) form.append('cover', cover);
    if (name) form.append('name', name);
    return api.postForm<Track>('/tracks', form);
  },
  remove: (id: string) => api.delete<Record<string, never>>(`/tracks/${id}`),
  coverUrl: (id: string) => `${API_BASE_URL}/tracks/${id}/cover`,
};
```

`frontend/src/api/playlists.ts`:

```ts
import { api } from './client';

export interface PlaylistSummary {
  id: string;
  name: string;
}

export interface PlaylistTrack {
  id: string;
  name: string;
  audioPath: string;
  coverPath: string | null;
}

export interface PlaylistDetail {
  id: string;
  name: string;
  tracks: PlaylistTrack[];
}

export const playlistsApi = {
  list: () => api.get<PlaylistSummary[]>('/playlists'),
  create: (name: string) => api.post<PlaylistSummary>('/playlists', { name }),
  get: (id: string) => api.get<PlaylistDetail>(`/playlists/${id}`),
  replaceTracks: (id: string, trackIds: string[]) => api.put<Record<string, never>>(`/playlists/${id}/tracks`, { trackIds }),
  remove: (id: string) => api.delete<Record<string, never>>(`/playlists/${id}`),
};
```

`frontend/src/api/destinations.ts`:

```ts
import { api } from './client';

export interface Destination {
  id: string;
  name: string;
  rtmpUrl: string | null;
  provider: string;
}

export const destinationsApi = {
  list: () => api.get<Destination[]>('/destinations'),
  createManual: (name: string, rtmpUrl: string, streamKey: string) =>
    api.post<Destination>('/destinations', { name, rtmpUrl, streamKey }),
  remove: (id: string) => api.delete<Record<string, never>>(`/destinations/${id}`),
  oauthStart: (provider: string) => api.get<{ authUrl: string }>(`/destinations/${provider}/oauth/start`),
};
```

`frontend/src/api/stream.ts`:

```ts
import { api, API_BASE_URL } from './client';

export type SessionState = 'idle' | 'streaming' | 'paused' | 'error';

export interface ProviderStatus {
  type: string;
  phase: string;
  watchUrl: string | null;
}

export interface StreamStatus {
  state: SessionState;
  currentTrack: string | null;
  nextTrack: string | null;
  provider?: ProviderStatus;
}

export interface StartStreamOptions {
  playlistId: string;
  title?: string;
  description?: string;
  privacyStatus?: 'public' | 'unlisted' | 'private';
}

export const streamApi = {
  start: (destinationId: string, opts: StartStreamOptions) =>
    api.post<StreamStatus>(`/destinations/${destinationId}/stream/start`, opts),
  stop: (destinationId: string) => api.post<StreamStatus>(`/destinations/${destinationId}/stream/stop`),
  pause: (destinationId: string) => api.post<StreamStatus>(`/destinations/${destinationId}/stream/pause`),
  resume: (destinationId: string) => api.post<StreamStatus>(`/destinations/${destinationId}/stream/resume`),
  next: (destinationId: string) => api.post<StreamStatus>(`/destinations/${destinationId}/stream/next`),
  previous: (destinationId: string) => api.post<StreamStatus>(`/destinations/${destinationId}/stream/previous`),
  playByName: (destinationId: string, name: string) => api.post<StreamStatus>(`/destinations/${destinationId}/stream/play`, { name }),
  status: (destinationId: string) => api.get<StreamStatus>(`/destinations/${destinationId}/stream/status`),
  eventsUrl: (destinationId: string) => `${API_BASE_URL}/destinations/${destinationId}/stream/events`,
};
```

- [ ] **Step 6: Write the failing resource-module tests**

Create `frontend/src/api/resources.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authApi } from './auth';
import { tracksApi } from './tracks';
import { playlistsApi } from './playlists';
import { destinationsApi } from './destinations';
import { streamApi } from './stream';

function mockFetchOnce(body: unknown) {
  (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
}

describe('resource API modules', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('authApi.login posts credentials to /auth/login', async () => {
    mockFetchOnce({ id: 'u1', email: 'a@example.com' });
    await authApi.login('a@example.com', 'pw');
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/auth/login');
    expect(JSON.parse(init.body)).toEqual({ email: 'a@example.com', password: 'pw' });
  });

  it('tracksApi.upload posts multipart form data to /tracks', async () => {
    mockFetchOnce({ id: 't1', name: 'A', durationSeconds: 10, hasCover: false });
    const audio = new File(['x'], 'a.mp3', { type: 'audio/mpeg' });
    await tracksApi.upload(audio, null, undefined);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/tracks');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('playlistsApi.replaceTracks PUTs the ordered id list', async () => {
    mockFetchOnce({});
    await playlistsApi.replaceTracks('p1', ['t2', 't1']);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/playlists/p1/tracks');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ trackIds: ['t2', 't1'] });
  });

  it('destinationsApi.oauthStart GETs the provider-scoped start URL', async () => {
    mockFetchOnce({ authUrl: 'https://accounts.google.com/...' });
    await destinationsApi.oauthStart('youtube');
    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/destinations/youtube/oauth/start');
  });

  it('streamApi.start posts playlistId + optional meta to .../stream/start', async () => {
    mockFetchOnce({ state: 'streaming', currentTrack: 'a', nextTrack: 'b' });
    await streamApi.start('d1', { playlistId: 'p1', privacyStatus: 'unlisted' });
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/destinations/d1/stream/start');
    expect(JSON.parse(init.body)).toEqual({ playlistId: 'p1', privacyStatus: 'unlisted' });
  });

  it('streamApi.eventsUrl builds the SSE endpoint URL without calling fetch', () => {
    const url = streamApi.eventsUrl('d1');
    expect(url).toContain('/destinations/d1/stream/events');
    expect(fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Run tests to verify they fail, then implementation makes them pass**

Run: `cd frontend && npx vitest run src/api/resources.test.ts`
Expected: first FAIL (modules don't exist — but Step 5 already created them above, so if you're
following this plan in order this should already PASS; if not, re-check Step 5's files exist).

Run: `cd frontend && npx vitest run`
Expected: PASS (all suites)

- [ ] **Step 8: Create `frontend/.env.example`**

```
VITE_API_BASE_URL=http://localhost:3000
```

- [ ] **Step 9: Run the full frontend suite and build**

Run: `cd frontend && npm test && npm run build`
Expected: all PASS, build succeeds

- [ ] **Step 10: Commit**

```bash
git add frontend/src/api frontend/.env.example
git commit -m "feat: typed API client layer for every backend resource

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Frontend — auth context, routing shell, Login/Register

**Files:**
- Create: `frontend/src/hooks/useAuth.tsx`, `frontend/src/components/ProtectedRoute.tsx`,
  `frontend/src/pages/Login.tsx`, `frontend/src/pages/Register.tsx`
- Modify: `frontend/src/App.tsx`
- Test: `frontend/src/hooks/useAuth.test.tsx`, `frontend/src/components/ProtectedRoute.test.tsx`,
  `frontend/src/pages/Login.test.tsx`
- Delete: `frontend/src/App.test.tsx` (Task 6's placeholder smoke test — `App` now renders real
  routing that needs a router/query-client context to test meaningfully; its replacement
  coverage is `ProtectedRoute.test.tsx` + `Login.test.tsx` below)

**Interfaces:**
- Consumes: `authApi` (Task 7).
- Produces: `AuthProvider`, `useAuth(): { user: AuthUser | null; isLoading: boolean; login; register; logout }`.
  `ProtectedRoute` (a layout route element). Every later page assumes it renders under
  `AuthProvider` + inside `ProtectedRoute`, and can call `useAuth()` to get the current user.

- [ ] **Step 1: Write the failing `useAuth` tests**

Create `frontend/src/hooks/useAuth.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './useAuth';
import { authApi } from '../api/auth';
import { ApiError } from '../api/client';

vi.mock('../api/auth');

function TestConsumer() {
  const { user, isLoading, login, logout } = useAuth();
  if (isLoading) return <div>loading</div>;
  return (
    <div>
      <div>{user ? `signed in as ${user.email}` : 'signed out'}</div>
      <button onClick={() => login('a@example.com', 'pw')}>login</button>
      <button onClick={() => logout()}>logout</button>
    </div>
  );
}

function renderWithProviders() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider><TestConsumer /></AuthProvider>
    </QueryClientProvider>,
  );
}

describe('useAuth', () => {
  beforeEach(() => vi.resetAllMocks());

  it('treats a 401 from /auth/me as signed-out, not an error', async () => {
    vi.mocked(authApi.me).mockRejectedValue(new ApiError(401, 'unauthorized'));
    renderWithProviders();
    await waitFor(() => expect(screen.getByText('signed out')).toBeInTheDocument());
  });

  it('login() updates the current user without a page reload', async () => {
    vi.mocked(authApi.me).mockRejectedValue(new ApiError(401, 'unauthorized'));
    vi.mocked(authApi.login).mockResolvedValue({ id: 'u1', email: 'a@example.com' });
    renderWithProviders();
    await waitFor(() => expect(screen.getByText('signed out')).toBeInTheDocument());

    await userEvent.click(screen.getByText('login'));

    await waitFor(() => expect(screen.getByText('signed in as a@example.com')).toBeInTheDocument());
  });

  it('logout() clears the current user', async () => {
    vi.mocked(authApi.me).mockResolvedValue({ id: 'u1', email: 'a@example.com' });
    vi.mocked(authApi.logout).mockResolvedValue({});
    renderWithProviders();
    await waitFor(() => expect(screen.getByText('signed in as a@example.com')).toBeInTheDocument());

    await userEvent.click(screen.getByText('logout'));

    await waitFor(() => expect(screen.getByText('signed out')).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/hooks/useAuth.test.tsx`
Expected: FAIL — `./useAuth` doesn't exist.

- [ ] **Step 3: Implement `frontend/src/hooks/useAuth.tsx`**

```tsx
import { createContext, ReactNode, useContext } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authApi, AuthUser } from '../api/auth';
import { ApiError } from '../api/client';

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const meQuery = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: async () => {
      try {
        return await authApi.me();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    retry: false,
  });

  const loginMutation = useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) => authApi.login(email, password),
    onSuccess: (user) => queryClient.setQueryData(['auth', 'me'], user),
  });

  const registerMutation = useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) => authApi.register(email, password),
    onSuccess: (user) => queryClient.setQueryData(['auth', 'me'], user),
  });

  const logoutMutation = useMutation({
    mutationFn: () => authApi.logout(),
    onSuccess: () => queryClient.setQueryData(['auth', 'me'], null),
  });

  const value: AuthContextValue = {
    user: meQuery.data ?? null,
    isLoading: meQuery.isLoading,
    login: async (email, password) => { await loginMutation.mutateAsync({ email, password }); },
    register: async (email, password) => { await registerMutation.mutateAsync({ email, password }); },
    logout: async () => { await logoutMutation.mutateAsync(); },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/hooks/useAuth.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the failing `ProtectedRoute` test**

Create `frontend/src/components/ProtectedRoute.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from './ProtectedRoute';
import { useAuth } from '../hooks/useAuth';

vi.mock('../hooks/useAuth');

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<div>Login page</div>} />
        <Route element={<ProtectedRoute />}>
          <Route path="/library" element={<div>Library page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProtectedRoute', () => {
  it('redirects to /login when signed out', () => {
    vi.mocked(useAuth).mockReturnValue({ user: null, isLoading: false } as any);
    renderAt('/library');
    expect(screen.getByText('Login page')).toBeInTheDocument();
  });

  it('renders the nested route when signed in', () => {
    vi.mocked(useAuth).mockReturnValue({ user: { id: 'u1', email: 'a@example.com' }, isLoading: false } as any);
    renderAt('/library');
    expect(screen.getByText('Library page')).toBeInTheDocument();
  });

  it('shows a loading state instead of redirecting while the auth check is in flight', () => {
    vi.mocked(useAuth).mockReturnValue({ user: null, isLoading: true } as any);
    renderAt('/library');
    expect(screen.queryByText('Login page')).not.toBeInTheDocument();
    expect(screen.queryByText('Library page')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/ProtectedRoute.test.tsx`
Expected: FAIL — `./ProtectedRoute` doesn't exist.

- [ ] **Step 7: Implement `frontend/src/components/ProtectedRoute.tsx`**

```tsx
import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export function ProtectedRoute() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <div className="p-4">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <Outlet />;
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/ProtectedRoute.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 9: Write the failing `Login` test**

Create `frontend/src/pages/Login.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Login from './Login';
import { useAuth } from '../hooks/useAuth';
import { ApiError } from '../api/client';

vi.mock('../hooks/useAuth');
const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigateMock,
}));

describe('Login', () => {
  it('calls login() and navigates to /library on success', async () => {
    const login = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useAuth).mockReturnValue({ login } as any);
    render(<MemoryRouter><Login /></MemoryRouter>);

    await userEvent.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await userEvent.type(screen.getByPlaceholderText('Password'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(login).toHaveBeenCalledWith('a@example.com', 'secret');
    expect(navigateMock).toHaveBeenCalledWith('/library');
  });

  it('shows the backend\'s error message on failure, without navigating', async () => {
    const login = vi.fn().mockRejectedValue(new ApiError(401, 'invalid email or password'));
    vi.mocked(useAuth).mockReturnValue({ login } as any);
    render(<MemoryRouter><Login /></MemoryRouter>);

    await userEvent.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await userEvent.type(screen.getByPlaceholderText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('invalid email or password')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/Login.test.tsx`
Expected: FAIL — `./Login` doesn't exist.

- [ ] **Step 11: Implement `frontend/src/pages/Login.tsx`**

```tsx
import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { ApiError } from '../api/client';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await login(email, password);
      navigate('/library');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 rounded-lg border p-6">
        <h1 className="text-xl font-semibold">Sign in</h1>
        <input className="w-full rounded border px-3 py-2" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className="w-full rounded border px-3 py-2" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" className="w-full rounded bg-black px-3 py-2 text-white">Sign in</button>
        <p className="text-sm text-gray-500">No account? <a className="underline" href="/register">Register</a></p>
      </form>
    </div>
  );
}
```

- [ ] **Step 12: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/pages/Login.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 13: Implement `frontend/src/pages/Register.tsx`** (same shape as `Login.tsx`, no
      dedicated test file — it's a near-identical form differing only in which `useAuth` method
      and copy it uses; `Login.test.tsx` already proves the pattern works)

```tsx
import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { ApiError } from '../api/client';

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await register(email, password);
      navigate('/library');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Registration failed');
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 rounded-lg border p-6">
        <h1 className="text-xl font-semibold">Create an account</h1>
        <input className="w-full rounded border px-3 py-2" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className="w-full rounded border px-3 py-2" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" className="w-full rounded bg-black px-3 py-2 text-white">Create account</button>
        <p className="text-sm text-gray-500">Already have an account? <a className="underline" href="/login">Sign in</a></p>
      </form>
    </div>
  );
}
```

- [ ] **Step 14: Rewrite `frontend/src/App.tsx`, delete `frontend/src/App.test.tsx`**

```tsx
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { AuthProvider } from './hooks/useAuth';
import { ProtectedRoute } from './components/ProtectedRoute';
import Login from './pages/Login';
import Register from './pages/Register';

const queryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Toaster richColors position="top-right" />
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route element={<ProtectedRoute />}>
              <Route path="/" element={<Navigate to="/library" replace />} />
              {/* Library/Playlists/Destinations routes are added in Task 9 */}
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
```

```bash
rm frontend/src/App.test.tsx
```

- [ ] **Step 15: Run the full frontend suite and build**

Run: `cd frontend && npm test`
Expected: PASS (`App.test.tsx` is gone; every other suite passes)

Run: `cd frontend && npm run build`
Expected: builds cleanly

- [ ] **Step 16: Commit**

```bash
git add frontend/src
git commit -m "feat: auth context, protected routing, login/register pages

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Frontend — app shell (sidebar) + Library page

**Files:**
- Create: `frontend/src/components/Sidebar.tsx`, `frontend/src/components/AppShell.tsx`,
  `frontend/src/pages/Library.tsx`, `frontend/src/test/renderWithProviders.tsx`
- Modify: `frontend/src/App.tsx`
- Test: `frontend/src/components/Sidebar.test.tsx`, `frontend/src/pages/Library.test.tsx`

**Interfaces:**
- Consumes: `tracksApi` (Task 7), `useAuth` (Task 8).
- Produces: `renderWithProviders(ui, opts?)` test helper — every subsequent page test in this plan
  reuses it instead of hand-wiring `QueryClientProvider`/`MemoryRouter` each time. `AppShell`
  (a layout route: sidebar + `<Outlet/>`) — every later top-level page nests under it in `App.tsx`.

The sidebar's three links (confirmed layout from design review) all get wired here, but only
`/library` has a real page behind it yet — `/playlists` and `/destinations` are added by their
own tasks (10 and 12), each just adding one `<Route>` line to `App.tsx`, not touching the sidebar.

- [ ] **Step 1: Create the shared test helper `frontend/src/test/renderWithProviders.tsx`**

```tsx
import { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

export function renderWithProviders(ui: ReactElement, { route = '/' }: { route?: string } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}
```

- [ ] **Step 2: Write the failing `Sidebar` test**

Create `frontend/src/components/Sidebar.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { useAuth } from '../hooks/useAuth';

vi.mock('../hooks/useAuth');

describe('Sidebar', () => {
  it('renders links for Library, Playlists, Destinations and the signed-in user\'s email', () => {
    vi.mocked(useAuth).mockReturnValue({ user: { id: 'u1', email: 'a@example.com' }, logout: vi.fn() } as any);
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    expect(screen.getByText('Library')).toBeInTheDocument();
    expect(screen.getByText('Playlists')).toBeInTheDocument();
    expect(screen.getByText('Destinations')).toBeInTheDocument();
    expect(screen.getByText('a@example.com')).toBeInTheDocument();
  });

  it('calls logout() when "Sign out" is clicked', async () => {
    const logout = vi.fn();
    vi.mocked(useAuth).mockReturnValue({ user: { id: 'u1', email: 'a@example.com' }, logout } as any);
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    await userEvent.click(screen.getByText('Sign out'));
    expect(logout).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Sidebar.test.tsx`
Expected: FAIL — `./Sidebar` doesn't exist.

- [ ] **Step 4: Implement `frontend/src/components/Sidebar.tsx`**

```tsx
import { NavLink } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

const links = [
  { to: '/library', label: 'Library' },
  { to: '/playlists', label: 'Playlists' },
  { to: '/destinations', label: 'Destinations' },
];

export function Sidebar() {
  const { user, logout } = useAuth();
  return (
    <aside className="flex h-screen w-56 flex-col justify-between border-r bg-gray-50 p-4">
      <div>
        <div className="mb-6 text-lg font-bold">super-dj</div>
        <nav className="space-y-1">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) => `block rounded px-3 py-2 text-sm ${isActive ? 'bg-gray-200 font-medium' : 'text-gray-700 hover:bg-gray-100'}`}
            >
              {link.label}
            </NavLink>
          ))}
        </nav>
      </div>
      <div className="space-y-2 text-sm">
        <div className="truncate text-gray-500">{user?.email}</div>
        <button onClick={() => logout()} className="text-gray-600 underline">Sign out</button>
      </div>
    </aside>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/Sidebar.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 6: Create `frontend/src/components/AppShell.tsx`** (no dedicated test — it's a
      trivial layout wrapper; its behavior is exercised end-to-end by every page test that
      renders inside it via `App.tsx`'s route tree)

```tsx
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';

export function AppShell() {
  return (
    <div className="flex">
      <Sidebar />
      <main className="flex-1 overflow-y-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
```

- [ ] **Step 7: Write the failing `Library` test**

Create `frontend/src/pages/Library.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Library from './Library';
import { tracksApi } from '../api/tracks';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../api/tracks');

describe('Library', () => {
  it('lists the user\'s tracks, showing duration and a cover thumbnail when present', async () => {
    vi.mocked(tracksApi.list).mockResolvedValue([
      { id: 't1', name: 'Track A', durationSeconds: 125, hasCover: true },
      { id: 't2', name: 'Track B', durationSeconds: null, hasCover: false },
    ]);
    vi.mocked(tracksApi.coverUrl).mockReturnValue('http://api/tracks/t1/cover');
    renderWithProviders(<Library />);

    expect(await screen.findByText('Track A')).toBeInTheDocument();
    expect(screen.getByText('125s')).toBeInTheDocument();
    expect(screen.getByText('Track B')).toBeInTheDocument();
    expect(screen.getByText('duration unknown')).toBeInTheDocument();
    expect(screen.getByAltText('')).toHaveAttribute('src', 'http://api/tracks/t1/cover');
  });

  it('deletes a track and refetches the list', async () => {
    vi.mocked(tracksApi.list)
      .mockResolvedValueOnce([{ id: 't1', name: 'Track A', durationSeconds: 10, hasCover: false }])
      .mockResolvedValueOnce([]);
    vi.mocked(tracksApi.remove).mockResolvedValue({});
    renderWithProviders(<Library />);
    await screen.findByText('Track A');

    await userEvent.click(screen.getByText('Delete'));

    expect(tracksApi.remove).toHaveBeenCalledWith('t1');
    await waitFor(() => expect(screen.getByText('No tracks yet.')).toBeInTheDocument());
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/Library.test.tsx`
Expected: FAIL — `./Library` doesn't exist.

- [ ] **Step 9: Implement `frontend/src/pages/Library.tsx`**

```tsx
import { FormEvent, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { tracksApi, Track } from '../api/tracks';
import { ApiError } from '../api/client';

export default function Library() {
  const queryClient = useQueryClient();
  const tracksQuery = useQuery({ queryKey: ['tracks'], queryFn: tracksApi.list });
  const audioInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);

  const uploadMutation = useMutation({
    mutationFn: () => {
      const audio = audioInputRef.current?.files?.[0];
      if (!audio) throw new Error('choose an audio file first');
      const cover = coverInputRef.current?.files?.[0] ?? null;
      return tracksApi.upload(audio, cover, name || undefined);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tracks'] });
      setName('');
      if (audioInputRef.current) audioInputRef.current.value = '';
      if (coverInputRef.current) coverInputRef.current.value = '';
    },
    onError: (err) => setUploadError(err instanceof ApiError ? err.message : 'Upload failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => tracksApi.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tracks'] }),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Failed to delete track'),
  });

  function handleUpload(e: FormEvent) {
    e.preventDefault();
    setUploadError(null);
    uploadMutation.mutate();
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Library</h1>

      <form onSubmit={handleUpload} className="space-y-3 rounded-lg border p-4">
        <div>
          <label className="block text-sm font-medium">Audio file</label>
          <input ref={audioInputRef} type="file" accept=".mp3,.wav,.flac,.m4a" required />
        </div>
        <div>
          <label className="block text-sm font-medium">Cover image (optional)</label>
          <input ref={coverInputRef} type="file" accept=".jpg,.jpeg,.png" />
        </div>
        <input className="w-full rounded border px-3 py-2" placeholder="Track name (optional — defaults to file name)" value={name} onChange={(e) => setName(e.target.value)} />
        {uploadError && <p className="text-sm text-red-600">{uploadError}</p>}
        <button type="submit" disabled={uploadMutation.isPending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">
          {uploadMutation.isPending ? 'Uploading…' : 'Upload'}
        </button>
      </form>

      <ul className="divide-y rounded-lg border">
        {tracksQuery.data?.map((track: Track) => (
          <li key={track.id} className="flex items-center gap-3 p-3">
            {track.hasCover ? (
              <img src={tracksApi.coverUrl(track.id)} alt="" className="h-10 w-10 rounded object-cover" />
            ) : (
              <div className="h-10 w-10 rounded bg-gray-200" />
            )}
            <div className="flex-1">
              <div className="font-medium">{track.name}</div>
              <div className="text-sm text-gray-500">
                {track.durationSeconds !== null ? `${Math.round(track.durationSeconds)}s` : 'duration unknown'}
              </div>
            </div>
            <button onClick={() => deleteMutation.mutate(track.id)} className="text-sm text-red-600">Delete</button>
          </li>
        ))}
        {tracksQuery.data?.length === 0 && <li className="p-3 text-sm text-gray-500">No tracks yet.</li>}
      </ul>
    </div>
  );
}
```

- [ ] **Step 10: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/pages/Library.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 11: Wire into `frontend/src/App.tsx`**

Read the current file first. Add the `AppShell`/`Library` imports and nest a new layout route
inside the existing `ProtectedRoute`:

```tsx
import { AppShell } from './components/AppShell';
import Library from './pages/Library';
// ...
            <Route element={<ProtectedRoute />}>
              <Route element={<AppShell />}>
                <Route path="/" element={<Navigate to="/library" replace />} />
                <Route path="/library" element={<Library />} />
                {/* /playlists and /destinations routes are added in Tasks 10 & 12 */}
              </Route>
            </Route>
```

- [ ] **Step 12: Run the full frontend suite and build**

Run: `cd frontend && npm test && npm run build`
Expected: all PASS, build succeeds

- [ ] **Step 13: Commit**

```bash
git add frontend/src
git commit -m "feat: app shell with sidebar navigation, Library page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: Frontend — Playlists list page

**Files:**
- Create: `frontend/src/pages/Playlists.tsx`
- Modify: `frontend/src/App.tsx`
- Test: `frontend/src/pages/Playlists.test.tsx`

**Interfaces:**
- Consumes: `playlistsApi` (Task 7), `renderWithProviders` (Task 9).
- Produces: `/playlists` route. Each playlist links to `/playlists/:id` (Task 11 builds that page —
  this task's `Link`s already point there, so Task 11 has a real entry point to test against).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/pages/Playlists.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Playlists from './Playlists';
import { playlistsApi } from '../api/playlists';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../api/playlists');

describe('Playlists', () => {
  it('lists the user\'s playlists, each linking to its editor', async () => {
    vi.mocked(playlistsApi.list).mockResolvedValue([{ id: 'p1', name: 'Mix' }]);
    renderWithProviders(<Playlists />);
    expect(await screen.findByText('Mix')).toBeInTheDocument();
    expect(screen.getByText('Mix').closest('a')).toHaveAttribute('href', '/playlists/p1');
  });

  it('creates a playlist and refetches the list', async () => {
    vi.mocked(playlistsApi.list).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'p1', name: 'New Mix' }]);
    vi.mocked(playlistsApi.create).mockResolvedValue({ id: 'p1', name: 'New Mix' });
    renderWithProviders(<Playlists />);
    await screen.findByText('No playlists yet.');

    await userEvent.type(screen.getByPlaceholderText('New playlist name'), 'New Mix');
    await userEvent.click(screen.getByText('Create'));

    expect(playlistsApi.create).toHaveBeenCalledWith('New Mix');
    await waitFor(() => expect(screen.getByText('New Mix')).toBeInTheDocument());
  });

  it('deletes a playlist and refetches the list', async () => {
    vi.mocked(playlistsApi.list).mockResolvedValueOnce([{ id: 'p1', name: 'Mix' }]).mockResolvedValueOnce([]);
    vi.mocked(playlistsApi.remove).mockResolvedValue({});
    renderWithProviders(<Playlists />);
    await screen.findByText('Mix');

    await userEvent.click(screen.getByText('Delete'));

    expect(playlistsApi.remove).toHaveBeenCalledWith('p1');
    await waitFor(() => expect(screen.getByText('No playlists yet.')).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/Playlists.test.tsx`
Expected: FAIL — `./Playlists` doesn't exist.

- [ ] **Step 3: Implement `frontend/src/pages/Playlists.tsx`**

```tsx
import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { playlistsApi } from '../api/playlists';
import { ApiError } from '../api/client';

export default function Playlists() {
  const queryClient = useQueryClient();
  const playlistsQuery = useQuery({ queryKey: ['playlists'], queryFn: playlistsApi.list });
  const [name, setName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: (name: string) => playlistsApi.create(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlists'] });
      setName('');
    },
    onError: (err) => setCreateError(err instanceof ApiError ? err.message : 'Failed to create playlist'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => playlistsApi.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['playlists'] }),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Failed to delete playlist'),
  });

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    if (name.trim()) createMutation.mutate(name.trim());
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Playlists</h1>

      <form onSubmit={handleCreate} className="flex gap-2">
        <input className="flex-1 rounded border px-3 py-2" placeholder="New playlist name" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="rounded bg-black px-4 py-2 text-white">Create</button>
      </form>
      {createError && <p className="text-sm text-red-600">{createError}</p>}

      <ul className="divide-y rounded-lg border">
        {playlistsQuery.data?.map((playlist) => (
          <li key={playlist.id} className="flex items-center justify-between p-3">
            <Link to={`/playlists/${playlist.id}`} className="font-medium underline">{playlist.name}</Link>
            <button onClick={() => deleteMutation.mutate(playlist.id)} className="text-sm text-red-600">Delete</button>
          </li>
        ))}
        {playlistsQuery.data?.length === 0 && <li className="p-3 text-sm text-gray-500">No playlists yet.</li>}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/pages/Playlists.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire into `frontend/src/App.tsx`**

Read the current file first. Add the import and one route line inside the existing `AppShell`
layout route:

```tsx
import Playlists from './pages/Playlists';
// ...
                <Route path="/playlists" element={<Playlists />} />
```

- [ ] **Step 6: Run the full frontend suite and build**

Run: `cd frontend && npm test && npm run build`
Expected: all PASS, build succeeds

- [ ] **Step 7: Commit**

```bash
git add frontend/src
git commit -m "feat: Playlists list page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11: Frontend — Playlist editor (drag-and-drop reorder)

**Files:**
- Create: `frontend/src/pages/PlaylistEditor.tsx`
- Modify: `frontend/src/App.tsx`
- Test: `frontend/src/pages/PlaylistEditor.test.tsx`

**Interfaces:**
- Consumes: `playlistsApi`, `tracksApi` (Task 7), `renderWithProviders` (Task 9).
- Produces: `/playlists/:id` route (the link target Task 10 already created).

Edits are staged locally (reorder, add, remove) and committed in one `PUT .../tracks` call via an
explicit "Save changes" button — not saved on every drag/click — matching a conventional playlist-
editor UX and avoiding a network round-trip per drag movement.

**Test scope note:** drag-and-drop itself (the actual pointer-drag gesture `@dnd-kit` reacts to)
is not covered by an automated test — simulating pointer-sensor drag gestures reliably in `jsdom`
is brittle and low-confidence; real projects typically cover this with e2e tooling, which this
plan's Global Constraints explicitly exclude. The tests below cover everything reachable without
simulating a drag: initial ordering render, remove, add, and that "Save changes" persists the
resulting id order — i.e. exactly the logic `handleDragEnd` would also mutate via `arrayMove`,
just triggered a different way.

- [ ] **Step 1: Add the `@dnd-kit` dependencies**

Already listed in Task 6's `package.json` (`@dnd-kit/core`, `@dnd-kit/sortable`,
`@dnd-kit/utilities`) — confirm `frontend/node_modules/@dnd-kit` exists; if Task 6 was followed
exactly, `npm install` already pulled them in. If not, run `cd frontend && npm install`.

- [ ] **Step 2: Write the failing test**

Create `frontend/src/pages/PlaylistEditor.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import PlaylistEditor from './PlaylistEditor';
import { playlistsApi } from '../api/playlists';
import { tracksApi } from '../api/tracks';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../api/playlists');
vi.mock('../api/tracks');

function renderEditor() {
  return renderWithProviders(
    <Routes><Route path="/playlists/:id" element={<PlaylistEditor />} /></Routes>,
    { route: '/playlists/p1' },
  );
}

describe('PlaylistEditor', () => {
  it('renders the playlist\'s current tracks and the tracks still available to add', async () => {
    vi.mocked(playlistsApi.get).mockResolvedValue({
      id: 'p1', name: 'Mix', tracks: [{ id: 't1', name: 'Track A', audioPath: '', coverPath: null }],
    });
    vi.mocked(tracksApi.list).mockResolvedValue([
      { id: 't1', name: 'Track A', durationSeconds: 10, hasCover: false },
      { id: 't2', name: 'Track B', durationSeconds: 20, hasCover: false },
    ]);
    renderEditor();

    expect(await screen.findByText('Mix')).toBeInTheDocument();
    expect(screen.getByText('Track A')).toBeInTheDocument();
    // Track B is NOT yet in the playlist, so it shows up under "Add tracks", not the ordered list.
    expect(screen.getByText('Track B')).toBeInTheDocument();
  });

  it('"Remove" takes a track out of the local ordering; "Save changes" persists the resulting id order', async () => {
    vi.mocked(playlistsApi.get).mockResolvedValue({
      id: 'p1', name: 'Mix',
      tracks: [
        { id: 't1', name: 'Track A', audioPath: '', coverPath: null },
        { id: 't2', name: 'Track B', audioPath: '', coverPath: null },
      ],
    });
    vi.mocked(tracksApi.list).mockResolvedValue([]);
    vi.mocked(playlistsApi.replaceTracks).mockResolvedValue({});
    renderEditor();
    await screen.findByText('Track A');

    await userEvent.click(screen.getAllByText('Remove')[0]);
    await userEvent.click(screen.getByText('Save changes'));

    await waitFor(() => expect(playlistsApi.replaceTracks).toHaveBeenCalledWith('p1', ['t2']));
  });

  it('"Add" appends an available track to the local ordering', async () => {
    vi.mocked(playlistsApi.get).mockResolvedValue({ id: 'p1', name: 'Mix', tracks: [] });
    vi.mocked(tracksApi.list).mockResolvedValue([{ id: 't1', name: 'Track A', durationSeconds: 10, hasCover: false }]);
    vi.mocked(playlistsApi.replaceTracks).mockResolvedValue({});
    renderEditor();
    await screen.findByText('Track A');

    await userEvent.click(screen.getByText('Add'));
    await userEvent.click(screen.getByText('Save changes'));

    await waitFor(() => expect(playlistsApi.replaceTracks).toHaveBeenCalledWith('p1', ['t1']));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/PlaylistEditor.test.tsx`
Expected: FAIL — `./PlaylistEditor` doesn't exist.

- [ ] **Step 4: Implement `frontend/src/pages/PlaylistEditor.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DndContext, DragEndEvent, closestCenter } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { toast } from 'sonner';
import { playlistsApi, PlaylistTrack } from '../api/playlists';
import { tracksApi } from '../api/tracks';
import { ApiError } from '../api/client';

function SortableRow({ track, onRemove }: { track: PlaylistTrack; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: track.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <li ref={setNodeRef} style={style} className="flex items-center gap-3 border-b bg-white p-3">
      <span {...attributes} {...listeners} className="cursor-grab text-gray-400">⠿</span>
      <span className="flex-1">{track.name}</span>
      <button onClick={onRemove} className="text-sm text-red-600">Remove</button>
    </li>
  );
}

export default function PlaylistEditor() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const playlistQuery = useQuery({ queryKey: ['playlists', id], queryFn: () => playlistsApi.get(id!), enabled: !!id });
  const allTracksQuery = useQuery({ queryKey: ['tracks'], queryFn: tracksApi.list });
  const [orderedTracks, setOrderedTracks] = useState<PlaylistTrack[]>([]);

  useEffect(() => {
    if (playlistQuery.data) setOrderedTracks(playlistQuery.data.tracks);
  }, [playlistQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () => playlistsApi.replaceTracks(id!, orderedTracks.map((t) => t.id)),
    onSuccess: () => {
      toast.success('Playlist saved');
      queryClient.invalidateQueries({ queryKey: ['playlists', id] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Failed to save playlist'),
  });

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setOrderedTracks((tracks) => {
      const oldIndex = tracks.findIndex((t) => t.id === active.id);
      const newIndex = tracks.findIndex((t) => t.id === over.id);
      return arrayMove(tracks, oldIndex, newIndex);
    });
  }

  function removeTrack(trackId: string) {
    setOrderedTracks((tracks) => tracks.filter((t) => t.id !== trackId));
  }

  function addTrack(track: { id: string; name: string }) {
    if (orderedTracks.some((t) => t.id === track.id)) return;
    setOrderedTracks((tracks) => [...tracks, { id: track.id, name: track.name, audioPath: '', coverPath: null }]);
  }

  const availableTracks = allTracksQuery.data?.filter((t) => !orderedTracks.some((ot) => ot.id === t.id)) ?? [];

  if (playlistQuery.isLoading) return <div>Loading…</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{playlistQuery.data?.name}</h1>
        <button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">
          {saveMutation.isPending ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={orderedTracks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          <ul className="rounded-lg border">
            {orderedTracks.map((track) => (
              <SortableRow key={track.id} track={track} onRemove={() => removeTrack(track.id)} />
            ))}
            {orderedTracks.length === 0 && <li className="p-3 text-sm text-gray-500">No tracks in this playlist yet — add some below.</li>}
          </ul>
        </SortableContext>
      </DndContext>

      <div>
        <h2 className="mb-2 font-medium">Add tracks</h2>
        <ul className="divide-y rounded-lg border">
          {availableTracks.map((track) => (
            <li key={track.id} className="flex items-center justify-between p-3">
              <span>{track.name}</span>
              <button onClick={() => addTrack(track)} className="text-sm underline">Add</button>
            </li>
          ))}
          {availableTracks.length === 0 && <li className="p-3 text-sm text-gray-500">All tracks are already in this playlist.</li>}
        </ul>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/pages/PlaylistEditor.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 6: Wire into `frontend/src/App.tsx`**

Read the current file first. Add the import and route:

```tsx
import PlaylistEditor from './pages/PlaylistEditor';
// ...
                <Route path="/playlists/:id" element={<PlaylistEditor />} />
```

- [ ] **Step 7: Run the full frontend suite and build**

Run: `cd frontend && npm test && npm run build`
Expected: all PASS, build succeeds

- [ ] **Step 8: Commit**

```bash
git add frontend/src
git commit -m "feat: playlist editor with drag-and-drop track reordering

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 12: Frontend — Destinations list page + Add Destination modal

**Files:**
- Create: `frontend/src/pages/Destinations.tsx`, `frontend/src/components/AddDestinationModal.tsx`
- Modify: `frontend/src/App.tsx`
- Test: `frontend/src/pages/Destinations.test.tsx`, `frontend/src/components/AddDestinationModal.test.tsx`

**Interfaces:**
- Consumes: `destinationsApi` (Task 7), `renderWithProviders` (Task 9).
- Produces: `/destinations` route. `AddDestinationModal` (also reusable on its own — no other
  task needs it, but it's a separate component/file per the plan's "one clear responsibility"
  file-structure rule, not folded directly into the page).

Bundled into one task because `Destinations.tsx` renders `AddDestinationModal` directly — neither
is independently meaningful without the other (confirmed design: single "+ Add Destination"
button opening a modal with YouTube/Manual tabs, over two separate buttons or a provider grid).

The YouTube tab implements the confirmed connect flow: `destinationsApi.oauthStart('youtube')`
returns `{ authUrl }`; `window.open(authUrl, ...)` opens it as a popup; the backend's callback
page (Task 5) `postMessage`s `'super-dj-oauth-connected'` to its opener and closes itself, which
this modal listens for via `window.addEventListener('message', ...)`. A `setInterval` polling
`popup.closed` is a fallback for a message the modal never received (e.g. the postMessage failed,
or the user closed the popup manually) — either signal refreshes the destinations list and closes
the modal.

- [ ] **Step 1: Add the `@radix-ui` dependencies**

Already listed in Task 6's `package.json` (`@radix-ui/react-dialog`, `@radix-ui/react-tabs`) —
confirm they're installed; if not, `cd frontend && npm install`.

- [ ] **Step 2: Write the failing `AddDestinationModal` test**

Create `frontend/src/components/AddDestinationModal.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddDestinationModal } from './AddDestinationModal';
import { destinationsApi } from '../api/destinations';
import { ApiError } from '../api/client';

vi.mock('../api/destinations');

describe('AddDestinationModal', () => {
  const onOpenChange = vi.fn();
  const onCreated = vi.fn();

  beforeEach(() => vi.clearAllMocks());

  it('submits the manual form and closes the modal on success', async () => {
    vi.mocked(destinationsApi.createManual).mockResolvedValue({ id: 'd1', name: 'My RTMP', rtmpUrl: 'rtmp://x', provider: 'custom' });
    render(<AddDestinationModal open onOpenChange={onOpenChange} onCreated={onCreated} />);

    await userEvent.click(screen.getByText('Manual'));
    await userEvent.type(screen.getByPlaceholderText('Name'), 'My RTMP');
    await userEvent.type(screen.getByPlaceholderText('RTMP URL'), 'rtmp://example.com/live');
    await userEvent.type(screen.getByPlaceholderText('Stream key'), 'key123');
    await userEvent.click(screen.getByText('Add'));

    await waitFor(() => expect(destinationsApi.createManual).toHaveBeenCalledWith('My RTMP', 'rtmp://example.com/live', 'key123'));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('shows the backend\'s error message when the manual form fails', async () => {
    vi.mocked(destinationsApi.createManual).mockRejectedValue(new ApiError(400, 'body.rtmpUrl is required'));
    render(<AddDestinationModal open onOpenChange={onOpenChange} onCreated={onCreated} />);

    await userEvent.click(screen.getByText('Manual'));
    await userEvent.type(screen.getByPlaceholderText('Name'), 'X');
    await userEvent.type(screen.getByPlaceholderText('RTMP URL'), 'x');
    await userEvent.type(screen.getByPlaceholderText('Stream key'), 'x');
    await userEvent.click(screen.getByText('Add'));

    expect(await screen.findByText('body.rtmpUrl is required')).toBeInTheDocument();
  });

  it('starts the YouTube OAuth flow by opening a popup at the returned authUrl', async () => {
    vi.mocked(destinationsApi.oauthStart).mockResolvedValue({ authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x' });
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({ closed: false } as Window);
    render(<AddDestinationModal open onOpenChange={onOpenChange} onCreated={onCreated} />);

    await userEvent.click(screen.getByText('Connect with Google'));

    await waitFor(() => expect(openSpy).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x', 'super-dj-oauth', 'width=500,height=700'));
    openSpy.mockRestore();
  });

  it('closes the modal and refreshes destinations when the callback tab posts the connected message', async () => {
    vi.mocked(destinationsApi.oauthStart).mockResolvedValue({ authUrl: 'https://accounts.google.com/x' });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as Window);
    render(<AddDestinationModal open onOpenChange={onOpenChange} onCreated={onCreated} />);
    await userEvent.click(screen.getByText('Connect with Google'));
    await screen.findByText('Waiting for Google…');

    window.dispatchEvent(new MessageEvent('message', { data: 'super-dj-oauth-connected' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/AddDestinationModal.test.tsx`
Expected: FAIL — `./AddDestinationModal` doesn't exist.

- [ ] **Step 4: Implement `frontend/src/components/AddDestinationModal.tsx`**

```tsx
import { FormEvent, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { destinationsApi } from '../api/destinations';
import { ApiError } from '../api/client';

interface AddDestinationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

export function AddDestinationModal({ open, onOpenChange, onCreated }: AddDestinationModalProps) {
  const [name, setName] = useState('');
  const [rtmpUrl, setRtmpUrl] = useState('');
  const [streamKey, setStreamKey] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);
  const [isConnectingYoutube, setConnectingYoutube] = useState(false);
  const popupRef = useRef<Window | null>(null);

  const manualMutation = useMutation({
    mutationFn: () => destinationsApi.createManual(name, rtmpUrl, streamKey),
    onSuccess: () => {
      onCreated();
      onOpenChange(false);
      setName(''); setRtmpUrl(''); setStreamKey('');
    },
    onError: (err) => setManualError(err instanceof ApiError ? err.message : 'Failed to add destination'),
  });

  function handleManualSubmit(e: FormEvent) {
    e.preventDefault();
    setManualError(null);
    manualMutation.mutate();
  }

  async function handleConnectYoutube() {
    try {
      const { authUrl } = await destinationsApi.oauthStart('youtube');
      popupRef.current = window.open(authUrl, 'super-dj-oauth', 'width=500,height=700');
      setConnectingYoutube(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to start YouTube connection');
    }
  }

  // Primary detection: the callback page (backend) posts this message and closes itself.
  // Fallback: if the popup closes without ever sending the message (blocked postMessage, manual
  // close), poll popup.closed and refresh the destinations list anyway — cheap insurance
  // against relying on a single signal.
  useEffect(() => {
    if (!isConnectingYoutube) return;

    function handleMessage(event: MessageEvent) {
      if (event.data === 'super-dj-oauth-connected') {
        setConnectingYoutube(false);
        onCreated();
        onOpenChange(false);
      }
    }
    window.addEventListener('message', handleMessage);

    const pollId = window.setInterval(() => {
      if (popupRef.current?.closed) {
        setConnectingYoutube(false);
        onCreated();
      }
    }, 500);

    return () => {
      window.removeEventListener('message', handleMessage);
      window.clearInterval(pollId);
    };
  }, [isConnectingYoutube, onCreated, onOpenChange]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-lg">
          <Dialog.Title className="mb-4 text-lg font-semibold">Add Destination</Dialog.Title>
          <Tabs.Root defaultValue="youtube">
            <Tabs.List className="mb-4 flex gap-2 border-b">
              <Tabs.Trigger value="youtube" className="px-3 py-2 text-sm data-[state=active]:border-b-2 data-[state=active]:border-black">YouTube</Tabs.Trigger>
              <Tabs.Trigger value="manual" className="px-3 py-2 text-sm data-[state=active]:border-b-2 data-[state=active]:border-black">Manual</Tabs.Trigger>
            </Tabs.List>

            <Tabs.Content value="youtube">
              <p className="mb-4 text-sm text-gray-600">Connect your YouTube channel to stream directly through it.</p>
              <button onClick={handleConnectYoutube} disabled={isConnectingYoutube} className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50">
                {isConnectingYoutube ? 'Waiting for Google…' : 'Connect with Google'}
              </button>
            </Tabs.Content>

            <Tabs.Content value="manual">
              <form onSubmit={handleManualSubmit} className="space-y-3">
                <input className="w-full rounded border px-3 py-2" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
                <input className="w-full rounded border px-3 py-2" placeholder="RTMP URL" value={rtmpUrl} onChange={(e) => setRtmpUrl(e.target.value)} required />
                <input className="w-full rounded border px-3 py-2" placeholder="Stream key" value={streamKey} onChange={(e) => setStreamKey(e.target.value)} required />
                {manualError && <p className="text-sm text-red-600">{manualError}</p>}
                <button type="submit" disabled={manualMutation.isPending} className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50">
                  {manualMutation.isPending ? 'Adding…' : 'Add'}
                </button>
              </form>
            </Tabs.Content>
          </Tabs.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/AddDestinationModal.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 6: Write the failing `Destinations` page test**

Create `frontend/src/pages/Destinations.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Destinations from './Destinations';
import { destinationsApi } from '../api/destinations';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../api/destinations');

describe('Destinations', () => {
  it('lists the user\'s destinations with their provider', async () => {
    vi.mocked(destinationsApi.list).mockResolvedValue([{ id: 'd1', name: 'My Channel', rtmpUrl: null, provider: 'youtube' }]);
    renderWithProviders(<Destinations />);
    expect(await screen.findByText(/My Channel/)).toBeInTheDocument();
    expect(screen.getByText('(youtube)')).toBeInTheDocument();
  });

  it('deletes a destination and refetches the list', async () => {
    vi.mocked(destinationsApi.list)
      .mockResolvedValueOnce([{ id: 'd1', name: 'My Channel', rtmpUrl: null, provider: 'youtube' }])
      .mockResolvedValueOnce([]);
    vi.mocked(destinationsApi.remove).mockResolvedValue({});
    renderWithProviders(<Destinations />);
    await screen.findByText(/My Channel/);

    await userEvent.click(screen.getByText('Delete'));

    expect(destinationsApi.remove).toHaveBeenCalledWith('d1');
    await waitFor(() => expect(screen.getByText('No destinations yet.')).toBeInTheDocument());
  });

  it('opens the Add Destination modal', async () => {
    vi.mocked(destinationsApi.list).mockResolvedValue([]);
    renderWithProviders(<Destinations />);
    await screen.findByText('No destinations yet.');

    await userEvent.click(screen.getByText('+ Add Destination'));

    expect(screen.getByText('Add Destination')).toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/Destinations.test.tsx`
Expected: FAIL — `./Destinations` doesn't exist.

- [ ] **Step 8: Implement `frontend/src/pages/Destinations.tsx`**

```tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { destinationsApi } from '../api/destinations';
import { ApiError } from '../api/client';
import { AddDestinationModal } from '../components/AddDestinationModal';

export default function Destinations() {
  const queryClient = useQueryClient();
  const destinationsQuery = useQuery({ queryKey: ['destinations'], queryFn: destinationsApi.list });
  const [isModalOpen, setModalOpen] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => destinationsApi.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['destinations'] }),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Failed to delete destination'),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Destinations</h1>
        <button onClick={() => setModalOpen(true)} className="rounded bg-black px-4 py-2 text-white">+ Add Destination</button>
      </div>

      <ul className="divide-y rounded-lg border">
        {destinationsQuery.data?.map((destination) => (
          <li key={destination.id} className="flex items-center justify-between p-3">
            <Link to={`/destinations/${destination.id}`} className="font-medium underline">
              {destination.name} <span className="text-xs text-gray-500">({destination.provider})</span>
            </Link>
            <button onClick={() => deleteMutation.mutate(destination.id)} className="text-sm text-red-600">Delete</button>
          </li>
        ))}
        {destinationsQuery.data?.length === 0 && <li className="p-3 text-sm text-gray-500">No destinations yet.</li>}
      </ul>

      <AddDestinationModal
        open={isModalOpen}
        onOpenChange={setModalOpen}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ['destinations'] })}
      />
    </div>
  );
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/pages/Destinations.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 10: Wire into `frontend/src/App.tsx`**

Read the current file first. Add the import and route:

```tsx
import Destinations from './pages/Destinations';
// ...
                <Route path="/destinations" element={<Destinations />} />
```

- [ ] **Step 11: Run the full frontend suite and build**

Run: `cd frontend && npm test && npm run build`
Expected: all PASS, build succeeds

- [ ] **Step 12: Commit**

```bash
git add frontend/src
git commit -m "feat: Destinations list page and Add Destination modal (YouTube OAuth + manual RTMP)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 13: Frontend — `useStreamStatus` hook (SSE-backed live status)

**Files:**
- Create: `frontend/src/hooks/useStreamStatus.ts`
- Test: `frontend/src/hooks/useStreamStatus.test.tsx`

**Interfaces:**
- Consumes: `streamApi.status`/`streamApi.eventsUrl` (Task 7).
- Produces: `useStreamStatus(destinationId: string)` — same return shape as TanStack Query's
  `useQuery` (`{ data: StreamStatus | undefined, isLoading, ... }`), so Task 14 consumes it
  exactly like any other query. Internally: one initial `GET .../stream/status` fetch (so the UI
  has something to show before the SSE connection's first frame arrives) plus a live `EventSource`
  subscription that pushes every subsequent update straight into the query cache — no polling.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/hooks/useStreamStatus.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { useStreamStatus } from './useStreamStatus';
import { streamApi } from '../api/stream';

vi.mock('../api/stream');

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;
  constructor(public url: string, public opts?: EventSourceInit) {
    FakeEventSource.instances.push(this);
  }
  close() { this.closed = true; }
  emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('useStreamStatus', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
    vi.mocked(streamApi.status).mockResolvedValue({ state: 'idle', currentTrack: null, nextTrack: null });
    vi.mocked(streamApi.eventsUrl).mockReturnValue('http://api/destinations/d1/stream/events');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('fetches the initial status and opens a credentialed SSE connection', async () => {
    const { result } = renderHook(() => useStreamStatus('d1'), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ state: 'idle', currentTrack: null, nextTrack: null }));
    expect(FakeEventSource.instances[0].url).toBe('http://api/destinations/d1/stream/events');
    expect(FakeEventSource.instances[0].opts).toEqual({ withCredentials: true });
  });

  it('updates the query result when an SSE message arrives', async () => {
    const { result } = renderHook(() => useStreamStatus('d1'), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    FakeEventSource.instances[0].emit({ state: 'streaming', currentTrack: 'a', nextTrack: 'b' });

    await waitFor(() => expect(result.current.data).toEqual({ state: 'streaming', currentTrack: 'a', nextTrack: 'b' }));
  });

  it('closes the EventSource on unmount', async () => {
    const { unmount } = renderHook(() => useStreamStatus('d1'), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    unmount();
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/hooks/useStreamStatus.test.tsx`
Expected: FAIL — `./useStreamStatus` doesn't exist.

- [ ] **Step 3: Implement `frontend/src/hooks/useStreamStatus.ts`**

```ts
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { streamApi, StreamStatus } from '../api/stream';

export function useStreamStatus(destinationId: string) {
  const queryClient = useQueryClient();
  const queryKey = ['stream-status', destinationId];

  const query = useQuery({
    queryKey,
    queryFn: () => streamApi.status(destinationId),
  });

  useEffect(() => {
    const source = new EventSource(streamApi.eventsUrl(destinationId), { withCredentials: true });
    source.onmessage = (event) => {
      const status: StreamStatus = JSON.parse(event.data);
      queryClient.setQueryData(queryKey, status);
    };
    return () => source.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryKey is a fresh array each
    // render but is derived solely from destinationId, which is already a dependency.
  }, [destinationId, queryClient]);

  return query;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/hooks/useStreamStatus.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full frontend suite and build**

Run: `cd frontend && npm test && npm run build`
Expected: all PASS, build succeeds

- [ ] **Step 6: Commit**

```bash
git add frontend/src/hooks/useStreamStatus.ts frontend/src/hooks/useStreamStatus.test.tsx
git commit -m "feat: useStreamStatus — SSE-backed live stream status hook

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 14: Frontend — Destination stream panel

**Files:**
- Create: `frontend/src/pages/DestinationPanel.tsx`
- Modify: `frontend/src/App.tsx`
- Test: `frontend/src/pages/DestinationPanel.test.tsx`

**Interfaces:**
- Consumes: `useStreamStatus` (Task 13), `streamApi`, `playlistsApi` (Task 7).
- Produces: `/destinations/:id` route (the link target Task 12's list page already points at).

This is the two-tier layout confirmed in design review: a broadcast-status bar (only rendered
when `status.provider` is present — i.e. only for OAuth-backed destinations) above a player card
whose contents switch between "pick a playlist and start" (idle) and full playback controls
(streaming/paused).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/pages/DestinationPanel.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import DestinationPanel from './DestinationPanel';
import { useStreamStatus } from '../hooks/useStreamStatus';
import { playlistsApi } from '../api/playlists';
import { streamApi } from '../api/stream';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../hooks/useStreamStatus');
vi.mock('../api/playlists');
vi.mock('../api/stream');

function renderPanel() {
  return renderWithProviders(
    <Routes><Route path="/destinations/:id" element={<DestinationPanel />} /></Routes>,
    { route: '/destinations/d1' },
  );
}

describe('DestinationPanel', () => {
  it('shows a playlist picker and a disabled Start button until one is selected', async () => {
    vi.mocked(useStreamStatus).mockReturnValue({ data: { state: 'idle', currentTrack: null, nextTrack: null } } as any);
    vi.mocked(playlistsApi.list).mockResolvedValue([{ id: 'p1', name: 'Mix' }]);
    renderPanel();

    expect(await screen.findByText('Mix')).toBeInTheDocument();
    expect(screen.getByText('Start stream')).toBeDisabled();
  });

  it('starts a stream with the selected playlist', async () => {
    vi.mocked(useStreamStatus).mockReturnValue({ data: { state: 'idle', currentTrack: null, nextTrack: null } } as any);
    vi.mocked(playlistsApi.list).mockResolvedValue([{ id: 'p1', name: 'Mix' }]);
    vi.mocked(streamApi.start).mockResolvedValue({ state: 'streaming', currentTrack: 'a', nextTrack: 'b' });
    renderPanel();
    await screen.findByText('Mix');

    await userEvent.selectOptions(screen.getByRole('combobox'), 'p1');
    await userEvent.click(screen.getByText('Start stream'));

    await waitFor(() => expect(streamApi.start).toHaveBeenCalledWith('d1', { playlistId: 'p1' }));
  });

  it('shows playback controls and current/next track when streaming', () => {
    vi.mocked(useStreamStatus).mockReturnValue({ data: { state: 'streaming', currentTrack: 'Track A', nextTrack: 'Track B' } } as any);
    vi.mocked(playlistsApi.list).mockResolvedValue([]);
    renderPanel();

    expect(screen.getByText('Now playing: Track A')).toBeInTheDocument();
    expect(screen.getByText('Next: Track B')).toBeInTheDocument();
    expect(screen.getByText('⏸ Pause')).toBeInTheDocument();
  });

  it('shows Resume instead of Pause when paused, and calls resume() on click', async () => {
    vi.mocked(useStreamStatus).mockReturnValue({ data: { state: 'paused', currentTrack: 'Track A', nextTrack: 'Track B' } } as any);
    vi.mocked(playlistsApi.list).mockResolvedValue([]);
    vi.mocked(streamApi.resume).mockResolvedValue({ state: 'streaming', currentTrack: 'Track A', nextTrack: 'Track B' });
    renderPanel();

    await userEvent.click(screen.getByText('▶ Resume'));

    expect(streamApi.resume).toHaveBeenCalledWith('d1');
  });

  it('shows the YouTube broadcast-status bar with a watch link once the provider phase is live', () => {
    vi.mocked(useStreamStatus).mockReturnValue({
      data: { state: 'streaming', currentTrack: 'a', nextTrack: 'b', provider: { type: 'youtube', phase: 'live', watchUrl: 'https://youtube.com/watch?v=x' } },
    } as any);
    vi.mocked(playlistsApi.list).mockResolvedValue([]);
    renderPanel();

    expect(screen.getByText('🔴 Live')).toBeInTheDocument();
    expect(screen.getByText('Watch on YouTube')).toHaveAttribute('href', 'https://youtube.com/watch?v=x');
  });

  it('omits the broadcast-status bar for a custom (non-OAuth) destination', () => {
    vi.mocked(useStreamStatus).mockReturnValue({ data: { state: 'streaming', currentTrack: 'a', nextTrack: 'b' } } as any);
    vi.mocked(playlistsApi.list).mockResolvedValue([]);
    renderPanel();

    expect(screen.queryByText('Watch on YouTube')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/DestinationPanel.test.tsx`
Expected: FAIL — `./DestinationPanel` doesn't exist.

- [ ] **Step 3: Implement `frontend/src/pages/DestinationPanel.tsx`**

```tsx
import { FormEvent, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useStreamStatus } from '../hooks/useStreamStatus';
import { streamApi } from '../api/stream';
import { playlistsApi } from '../api/playlists';
import { ApiError } from '../api/client';

const PHASE_LABELS: Record<string, string> = {
  creating: '🟡 Preparing broadcast…',
  waitingForYoutube: '🟡 Connecting to YouTube…',
  live: '🔴 Live',
  complete: '⚫ Ended',
  error: '🔴 Error',
};

export default function DestinationPanel() {
  const { id } = useParams<{ id: string }>();
  const destinationId = id!;
  const queryClient = useQueryClient();
  const statusQuery = useStreamStatus(destinationId);
  const playlistsQuery = useQuery({ queryKey: ['playlists'], queryFn: playlistsApi.list });
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('');
  const [playName, setPlayName] = useState('');

  function onStatusMutationSuccess(status: unknown) {
    queryClient.setQueryData(['stream-status', destinationId], status);
  }

  const startMutation = useMutation({
    mutationFn: () => streamApi.start(destinationId, { playlistId: selectedPlaylistId }),
    onSuccess: onStatusMutationSuccess,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Failed to start stream'),
  });
  const stopMutation = useMutation({
    mutationFn: () => streamApi.stop(destinationId),
    onSuccess: onStatusMutationSuccess,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Failed to stop stream'),
  });
  const pauseMutation = useMutation({
    mutationFn: () => streamApi.pause(destinationId),
    onSuccess: onStatusMutationSuccess,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Failed to pause'),
  });
  const resumeMutation = useMutation({
    mutationFn: () => streamApi.resume(destinationId),
    onSuccess: onStatusMutationSuccess,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Failed to resume'),
  });
  const nextMutation = useMutation({
    mutationFn: () => streamApi.next(destinationId),
    onSuccess: onStatusMutationSuccess,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Failed to skip to next track'),
  });
  const previousMutation = useMutation({
    mutationFn: () => streamApi.previous(destinationId),
    onSuccess: onStatusMutationSuccess,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Failed to go to previous track'),
  });
  const playMutation = useMutation({
    mutationFn: () => streamApi.playByName(destinationId, playName),
    onSuccess: (status) => { onStatusMutationSuccess(status); setPlayName(''); },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Track not found'),
  });

  function handlePlaySubmit(e: FormEvent) {
    e.preventDefault();
    if (playName.trim()) playMutation.mutate();
  }

  const status = statusQuery.data;
  const isIdle = !status || status.state === 'idle';

  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold">Stream Control</h1>

      {status?.provider && (
        <div className="rounded border bg-yellow-50 p-3 text-sm">
          {PHASE_LABELS[status.provider.phase] ?? status.provider.phase}
          {status.provider.watchUrl && (
            <a href={status.provider.watchUrl} target="_blank" rel="noreferrer" className="ml-2 underline">
              Watch on YouTube
            </a>
          )}
        </div>
      )}

      <div className="rounded-lg border p-4">
        {isIdle ? (
          <div className="space-y-3">
            <select className="w-full rounded border px-3 py-2" value={selectedPlaylistId} onChange={(e) => setSelectedPlaylistId(e.target.value)}>
              <option value="">Select a playlist…</option>
              {playlistsQuery.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button
              onClick={() => startMutation.mutate()}
              disabled={!selectedPlaylistId || startMutation.isPending}
              className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50"
            >
              {startMutation.isPending ? 'Starting…' : 'Start stream'}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-xs text-gray-500">State: {status.state}</div>
            <div className="font-medium">Now playing: {status.currentTrack ?? '—'}</div>
            <div className="text-sm text-gray-500">Next: {status.nextTrack ?? '—'}</div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => previousMutation.mutate()} className="rounded border px-3 py-2">⏮ Previous</button>
              {status.state === 'paused' ? (
                <button onClick={() => resumeMutation.mutate()} className="rounded border px-3 py-2">▶ Resume</button>
              ) : (
                <button onClick={() => pauseMutation.mutate()} className="rounded border px-3 py-2">⏸ Pause</button>
              )}
              <button onClick={() => nextMutation.mutate()} className="rounded border px-3 py-2">⏭ Next</button>
              <button onClick={() => stopMutation.mutate()} className="rounded border px-3 py-2 text-red-600">⏹ Stop</button>
            </div>
            <form onSubmit={handlePlaySubmit} className="flex gap-2 pt-2">
              <input className="flex-1 rounded border px-3 py-2 text-sm" placeholder="Play a track by name next…" value={playName} onChange={(e) => setPlayName(e.target.value)} />
              <button type="submit" className="rounded border px-3 py-2 text-sm">Queue</button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/pages/DestinationPanel.test.tsx`
Expected: PASS (6 tests)

- [ ] **Step 5: Wire into `frontend/src/App.tsx`**

Read the current file first. Add the import and route:

```tsx
import DestinationPanel from './pages/DestinationPanel';
// ...
                <Route path="/destinations/:id" element={<DestinationPanel />} />
```

- [ ] **Step 6: Run the full frontend suite and build**

Run: `cd frontend && npm test && npm run build`
Expected: all PASS, build succeeds

- [ ] **Step 7: Commit**

```bash
git add frontend/src
git commit -m "feat: destination stream control panel (broadcast status + player)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 15: Deployment — frontend Docker image, nginx, docker-compose

**Files:**
- Create: `frontend/Dockerfile`, `frontend/nginx.conf`, `frontend/.dockerignore`
- Modify: `docker-compose.yml`

**Interfaces:**
- Produces: a buildable `frontend` Docker image serving the SPA's static build via nginx, with
  client-side routing fallback (every path serves `index.html`, since React Router — not
  nginx — decides what to render for `/library`, `/playlists/:id`, etc.).

No local Docker daemon is available in this dev environment (same constraint noted in `CLAUDE.md`
for Prisma migrations) — this task's build verification happens on the remote host at
`192.168.14.26` (passwordless SSH), the same host already used for migration generation. This is
a build-and-throwaway-verify step, not a deploy: nothing produced here is left running, and the
existing `super-dj`/`postgres` containers on that host are never touched.

- [ ] **Step 1: Create `frontend/Dockerfile`**

```dockerfile
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost/ >/dev/null 2>&1 || exit 1
```

`VITE_API_BASE_URL` is a build ARG, not a runtime `ENV`/`environment:` entry — Vite resolves
`import.meta.env.VITE_API_BASE_URL` at `vite build` time and bakes the literal value into the
compiled JS bundle (this was the resolved "Vite build-time vs. runtime config" open question from
the spec). Changing the backend URL for a given deployment means rebuilding this image with a
different `--build-arg`, not restarting the container with a different env var.

- [ ] **Step 2: Create `frontend/nginx.conf`**

```nginx
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;

  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

The `try_files ... /index.html` fallback is required because this is a client-side-routed SPA —
a browser request for `/destinations/d1` (a React Router route, not a real file) must still serve
`index.html` so React Router can render it, not a raw nginx 404.

- [ ] **Step 3: Create `frontend/.dockerignore`**

```
node_modules
dist
.git
```

- [ ] **Step 4: Update `docker-compose.yml`**

Read the current file first (it has the `frontend` service stub from Task 5). Replace it:

```yaml
  frontend:
    build:
      context: ./frontend
      args:
        VITE_API_BASE_URL: ${VITE_API_BASE_URL}
    ports:
      - "5173:80"
    depends_on:
      - super-dj
    restart: unless-stopped
```

- [ ] **Step 5: Build and verify on the remote host, then clean up**

Follow the same remote-host pattern already established in `CLAUDE.md` for Prisma migrations:
passwordless SSH to `192.168.14.26`, do all work in a throwaway temp directory, and leave every
pre-existing container/image/network on that host untouched.

```bash
ssh 192.168.14.26 "mkdir -p /tmp/super-dj-frontend-build-$$"
```

Copy the `frontend/` directory to that temp path (`scp -r`/`rsync`), then:

```bash
ssh 192.168.14.26 "cd /tmp/super-dj-frontend-build-<id> && docker build --build-arg VITE_API_BASE_URL=http://localhost:3000 -t super-dj-frontend-verify:tmp ."
```

Run it briefly on an arbitrary free host port (do not reuse port 5173/3000/8088 or any port
already in use on that host — check with `ssh 192.168.14.26 "docker ps"` first) and confirm it
serves the SPA:

```bash
ssh 192.168.14.26 "docker run -d --rm --name super-dj-frontend-verify -p <free-port>:80 super-dj-frontend-verify:tmp"
ssh 192.168.14.26 "curl -sf http://localhost:<free-port>/ | grep -q '<div id=\"root\">'"
ssh 192.168.14.26 "curl -sf http://localhost:<free-port>/library | grep -q '<div id=\"root\">'"  # confirms the SPA fallback route works
```

Then tear everything down:

```bash
ssh 192.168.14.26 "docker stop super-dj-frontend-verify"
ssh 192.168.14.26 "docker rmi super-dj-frontend-verify:tmp"
ssh 192.168.14.26 "rm -rf /tmp/super-dj-frontend-build-<id>"
```

If SSH is unreachable or Docker isn't available on the host, report BLOCKED with specifics rather
than skipping verification silently — this is the only way this plan can confirm the Dockerfile
and nginx config actually work, since there's no local Docker daemon to fall back to.

- [ ] **Step 6: Run the frontend's own suite once more for good measure**

Run: `cd frontend && npm test && npm run build`
Expected: all PASS, build succeeds (this doesn't touch Docker at all — it's the same local
Vite build the Dockerfile's build stage runs, just without a container around it)

- [ ] **Step 7: Commit**

```bash
git add frontend/Dockerfile frontend/nginx.conf frontend/.dockerignore docker-compose.yml
git commit -m "feat: frontend Docker image (nginx + SPA fallback), wire into docker-compose

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 16: Documentation — CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- None — this task only updates documentation, no code changes.

- [ ] **Step 1: Update `CLAUDE.md`**

Read the current file first, then make these additions (following the file's existing terse,
factual style — no new section headers beyond what's needed, fold into existing sections where a
natural home exists):

1. **Project overview / Architecture:** add a short paragraph describing the frontend: a
   separately-deployed React + Vite SPA (`frontend/`) talking to the same API over CORS with
   credentialed cross-origin requests, live stream status delivered via SSE rather than polling
   (`StreamManager` is an `EventEmitter`; `GET /destinations/:id/stream/events`).
2. **Layout:** add a `frontend/` entry alongside the existing `src/`/`test/`/`prisma/` tree,
   pointing at `frontend/src/{api,pages,components,hooks}` with one line each, matching the
   existing tree's terseness.
3. **HTTP API:** add `GET /tracks/{id}/cover` and `GET /destinations/{destinationId}/stream/events`
   to the endpoint list.
4. **Configuration:** add `FRONTEND_ORIGIN` to the Required env vars list (backend); note
   `frontend/.env.example` documents `VITE_API_BASE_URL` (frontend build-time config, not a
   runtime env var — see Task 15's Dockerfile note if unclear).
5. **Development commands:** add the frontend's own commands (`cd frontend && npm install`,
   `npm run dev`, `npm test`, `npm run build`) alongside the existing backend ones.
6. **Known follow-ups:** add — the OAuth-connect popup's `postMessage` fallback (polling
   `popup.closed`) means a connect can take up to 500ms to be detected if the message itself is
   somehow lost; the playlist editor's drag-and-drop has no automated test coverage (documented
   test-scope decision, see Task 11); no e2e/Playwright coverage exists for any frontend flow.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document the web frontend, SSE, and CORS additions in CLAUDE.md

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** every section of the design spec maps to a task — stack/structure (Task 6),
  navigation shell (Task 9), auth screens (Task 8), Library (Task 9), Playlists + editor (Tasks
  10-11), Destinations + connect flow (Task 12), the stream panel's two-tier layout (Task 14),
  SSE live status (Tasks 3-4 backend, Task 13 frontend), cross-origin auth (Task 2), error
  handling (woven through every mutation across Tasks 9-14, via inline errors for form-adjacent
  actions and `sonner` toasts for panel actions with no adjacent form, exactly matching the
  spec's distinction), deployment (Task 15), testing conventions (Task 6 establishes them, every
  later task follows them).
- **Two backend gaps found and fixed during planning, not anticipated by the spec:** the spec
  assumed `GET /playlists/:id`'s track objects and a track-cover-serving route already existed in
  a frontend-usable shape; neither did (`PlaylistTrackView` had no `id` field, and no route ever
  served `UPLOADS_DIR` files over HTTP at all). Task 1 fixes both — without it, the playlist
  editor (Task 11) couldn't build a valid `PUT .../tracks` request, and the Library page (Task 9)
  couldn't show the cover thumbnails the spec's screen description calls for.
- **OAuth-connect-completion mechanism upgraded from the spec's "left to the plan" note:** rather
  than pure polling of `GET /destinations` (the spec's fallback-shaped suggestion), Task 5 adds a
  small `postMessage` + `window.close()` enhancement to the existing OAuth callback page (already
  built in phase 4), and Task 12's modal listens for it — with `popup.closed` polling kept as a
  fallback for the rare case the message doesn't arrive. Chosen because it's a few lines on an
  already-additive, already-owned file, and gives near-instant feedback instead of a multi-second
  polling delay.
- **Type-consistency check:** `PlaylistTrack`/`Track`/`Destination`/`StreamStatus` etc. in
  `frontend/src/api/*` (Task 7) were checked field-by-field against the actual backend response
  shapes read directly from `src/*/*.ts` (not guessed from the spec), including the Task 1 fix
  (`PlaylistTrack.id`) and the Task 3-4 additions (`ProviderStatus`/`DestinationStreamStatus`).
  `useStreamStatus`'s return shape (Task 13) matches TanStack Query's own `useQuery` result shape
  exactly, so `DestinationPanel` (Task 14) consumes it with no adapter needed.
- **Sequencing:** Tasks 1-5 (backend) are ordered so nothing later depends on something not yet
  built — Task 1's data-shape fixes have no dependencies, Task 2's CORS/cookie work is independent,
  Task 3 (event emission) must precede Task 4 (the SSE route that subscribes to those events), and
  Task 5's OAuth-callback change is independent of both. Tasks 6-14 (frontend) are ordered so each
  builds on a real, already-tested dependency from an earlier task — no task imports a module a
  later task hasn't been written yet, verified by tracing every `import` in this plan's code
  blocks back to the task that creates that file.
- **Right-sizing fix during drafting:** an earlier task breakdown had "sidebar layout" and
  "Library page" as separate tasks, and "Destinations list" and "Add Destination modal" as
  separate tasks — both pairs were merged, because in each case the first component is not
  independently testable/meaningful without the second (`AppShell`'s only real content is
  `<Outlet/>` until some page exists to render there; `Destinations.tsx` imports
  `AddDestinationModal` directly). Matches this plan's Task Right-Sizing rule: split only where a
  reviewer could meaningfully approve one half while rejecting the other.

