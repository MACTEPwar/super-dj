# Donation Song Request Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A donor on Donatello.to who donates above a configurable threshold with a message like
`!song:Artist - Title` gets that track fetched from the streamer's own media-search service,
inserted next in the live queue, played once, then deleted — without disturbing the regular
playlist.

**Architecture:** A webhook receives Donatello callbacks and normalizes them into a
`DonationEvent`. A rule-matching engine checks that event against a list of `InteractionRule`
rows (one row per configured trigger, full CRUD via a new UI page) and, on a match, hands off to
an action executor that fetches audio from an external HTTP service, writes it to a temp file,
and inserts it as a one-off, DB-less `Track` into the existing `PlaylistQueue` — which is
upgraded from a single override slot to a real FIFO so concurrent requests queue instead of
clobbering each other. Cleanup happens via a callback attached to the ephemeral track itself, plus
a periodic sweep as a fallback.

**Tech Stack:** Node/TypeScript, Express, Prisma/PostgreSQL, Jest (backend), React/Vite/Vitest
(frontend), react-query, react-i18next.

**Spec:** [docs/superpowers/specs/2026-09-21-donation-song-request-design.md](../specs/2026-09-21-donation-song-request-design.md)

## Global Constraints

- MVP scope only: one trigger source (Donatello.to webhook), one action type (`songRequest`).
- Currency conversion: hardcoded stub, USD and EUR → UAH only. Any other currency safely does not
  match (never mis-converted).
- Threshold amounts are whole UAH (`Int`), matching Donatello's own whole-number donation amounts.
- Webhook target user is a single fixed environment variable (`DONATION_TARGET_USER_ID`) — this is
  a known, explicitly-accepted MVP limitation, not an oversight. Do not build multi-user webhook
  routing now.
- No donation deduplication in this plan — the spec's dedup question is still open (pending a look
  at Donatello's "Вебхуки" tab) and is explicitly out of scope until resolved.
- Every mutating, authenticated HTTP route requires `Content-Type: application/json` (matches the
  whole existing API — see `requireJsonRequest` in `src/stream/localStreamRoutes.ts`). The
  Donatello webhook is the one exception (server-to-server, no browser, no cookie).
- Prisma-backed repositories are thin wrappers verified by manual smoke test with a real Postgres,
  not unit tests (existing project convention) — consumers take narrow structural (`Pick`-style)
  interfaces so they can be unit-tested with plain-object fakes instead.
- Schema changes need a migration generated via the documented remote-Postgres process (no local
  Docker daemon available) — see Task 3.

---

## Task 1: Currency converter

**Files:**
- Create: `src/donations/currencyConverter.ts`
- Test: `test/donations/currencyConverter.test.ts`

**Interfaces:**
- Produces: `CurrencyConverter` interface with `toUah(amount: number, currency: string): number | null`; `StubCurrencyConverter` class implementing it.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/donations/currencyConverter.test.ts
import { StubCurrencyConverter } from '../../src/donations/currencyConverter';

describe('StubCurrencyConverter', () => {
  const converter = new StubCurrencyConverter();

  it('converts UAH 1:1', () => {
    expect(converter.toUah(400, 'UAH')).toBe(400);
  });

  it('converts USD using the hardcoded rate', () => {
    expect(converter.toUah(10, 'USD')).toBe(410);
  });

  it('converts EUR using the hardcoded rate', () => {
    expect(converter.toUah(10, 'EUR')).toBe(430);
  });

  it('is case-insensitive on the currency code', () => {
    expect(converter.toUah(10, 'usd')).toBe(410);
  });

  it('returns null for an unsupported currency instead of guessing', () => {
    expect(converter.toUah(10, 'GBP')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/donations/currencyConverter.test.ts`
Expected: FAIL — `Cannot find module '../../src/donations/currencyConverter'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/donations/currencyConverter.ts

export interface CurrencyConverter {
  // Returns null for a currency this converter doesn't know how to convert, rather than
  // guessing — a null must always be treated as "does not match any threshold", never as 0.
  toUah(amount: number, currency: string): number | null;
}

// MVP stub: hardcoded approximate rates, USD and EUR only (per the design spec's explicit
// follow-up item — replace with a real live-rate source later; do not remove this comment when
// that happens, replace the whole class). This is deliberately NOT a no-op: a no-op would mean a
// $10 donation could never cross a "≥400 UAH" threshold, which defeats the point of converting
// at all.
const HARDCODED_RATES_TO_UAH: Record<string, number> = {
  UAH: 1,
  USD: 41,
  EUR: 43,
};

export class StubCurrencyConverter implements CurrencyConverter {
  toUah(amount: number, currency: string): number | null {
    const rate = HARDCODED_RATES_TO_UAH[currency.toUpperCase()];
    if (rate === undefined) return null;
    return amount * rate;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest test/donations/currencyConverter.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/donations/currencyConverter.ts test/donations/currencyConverter.test.ts
git commit -m "feat(donations): add hardcoded USD/EUR->UAH currency converter stub"
```

---

## Task 2: Config additions — target user and media-search service URL

**Files:**
- Modify: `src/config/env.ts`
- Modify: `docker-compose.yml`
- Modify: `test/config/env.test.ts`
- Modify: `test/server.test.ts`

**Interfaces:**
- Produces: `AppConfig.donationTargetUserId: string`, `AppConfig.mediaSearchServiceUrl: string` (both required, no default — same pattern as `donatelloCallbackKey`, already present).

- [ ] **Step 1: Write the failing tests**

Add to `test/config/env.test.ts` (new describe block at the end of the file):

```typescript
describe('loadConfig — donation song request', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    STREAM_KEY_ENCRYPTION_KEY: 'a'.repeat(64),
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    APP_BASE_URL: 'https://app.example.com',
    FRONTEND_ORIGIN: 'https://web.example.com',
    MEDIAMTX_AUTH_SECRET: 'shared',
    DONATELLO_CALLBACK_KEY: 'donatello-key',
  } as NodeJS.ProcessEnv;

  it('applies DONATION_TARGET_USER_ID and MEDIA_SEARCH_SERVICE_URL', () => {
    const config = loadConfig({
      ...base,
      DONATION_TARGET_USER_ID: 'user-123',
      MEDIA_SEARCH_SERVICE_URL: 'http://192.168.14.26:8010',
    } as NodeJS.ProcessEnv);
    expect(config.donationTargetUserId).toBe('user-123');
    expect(config.mediaSearchServiceUrl).toBe('http://192.168.14.26:8010');
  });

  it('throws when DONATION_TARGET_USER_ID is missing', () => {
    expect(() => loadConfig({ ...base, MEDIA_SEARCH_SERVICE_URL: 'http://x' } as NodeJS.ProcessEnv))
      .toThrow('DONATION_TARGET_USER_ID environment variable is required');
  });

  it('throws when MEDIA_SEARCH_SERVICE_URL is missing', () => {
    expect(() => loadConfig({ ...base, DONATION_TARGET_USER_ID: 'user-123' } as NodeJS.ProcessEnv))
      .toThrow('MEDIA_SEARCH_SERVICE_URL environment variable is required');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/config/env.test.ts`
Expected: FAIL — the new describe block's first test fails because `config.donationTargetUserId` is `undefined`, and the two throw-tests fail because `loadConfig` doesn't throw for these (unknown) variable names yet.

- [ ] **Step 3: Implement in `src/config/env.ts`**

Add to the `AppConfig` interface (after `donatelloCallbackKey: string;`):

```typescript
  // MVP stopgap: exactly one account uses this feature, so the webhook's target user is a fixed
  // id rather than a per-user token in the URL. Tracked as a known follow-up in the design spec —
  // replace with real per-user webhook routing the moment a second user exists.
  donationTargetUserId: string;
  // Base URL of the streamer's own media-search microservice (GET {url}/download/audio?query=).
  // Never hardcode this — it points at a specific internal host that will differ per deployment.
  mediaSearchServiceUrl: string;
```

Add extraction (after `const donatelloCallbackKey = env.DONATELLO_CALLBACK_KEY;`):

```typescript
  const donationTargetUserId = env.DONATION_TARGET_USER_ID;
  const mediaSearchServiceUrl = env.MEDIA_SEARCH_SERVICE_URL;
```

Add required-checks (after the `donatelloCallbackKey` throw block):

```typescript
  if (!donationTargetUserId) {
    throw new Error('DONATION_TARGET_USER_ID environment variable is required');
  }
  if (!mediaSearchServiceUrl) {
    throw new Error('MEDIA_SEARCH_SERVICE_URL environment variable is required');
  }
```

Add to the returned object (after `donatelloCallbackKey,`):

```typescript
    donationTargetUserId,
    mediaSearchServiceUrl,
```

- [ ] **Step 4: Fix `test/server.test.ts`'s hand-built `AppConfig` fixture**

Add to the `config` object literal (after `donatelloCallbackKey: 'donatello-key',`):

```typescript
  donationTargetUserId: 'user-123',
  mediaSearchServiceUrl: 'http://192.168.14.26:8010',
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest test/config/env.test.ts test/server.test.ts`
Expected: PASS

- [ ] **Step 6: Wire the env vars through `docker-compose.yml`**

Add to the `super-dj` service's `environment:` block (after `DONATELLO_CALLBACK_KEY: ${DONATELLO_CALLBACK_KEY}`):

```yaml
      DONATION_TARGET_USER_ID: ${DONATION_TARGET_USER_ID}
      MEDIA_SEARCH_SERVICE_URL: ${MEDIA_SEARCH_SERVICE_URL}
```

- [ ] **Step 7: Run the full backend test suite to catch anything else that constructs `AppConfig`**

Run: `npx jest`
Expected: PASS, all suites (fix any other hand-built `AppConfig` fixture the same way if one turns up)

- [ ] **Step 8: Commit**

```bash
git add src/config/env.ts test/config/env.test.ts test/server.test.ts docker-compose.yml
git commit -m "feat(config): add DONATION_TARGET_USER_ID and MEDIA_SEARCH_SERVICE_URL"
```

---

## Task 3: `InteractionRule` data model and repository

**Files:**
- Modify: `prisma/schema.prisma`
- Create: migration under `prisma/migrations/` (via the remote-host process, see Step 2)
- Create: `src/donations/interactionRuleRepository.ts`

**Interfaces:**
- Produces: Prisma model `InteractionRule` (fields: `id, userId, actionType, enabled, minAmount, commandKeyword, createdAt, updatedAt`); `InteractionRuleRepository` class with `listByUser`, `listEnabledByUser`, `findById`, `create`, `update`, `delete`.

- [ ] **Step 1: Add the model to `prisma/schema.prisma`**

Add `interactionRules InteractionRule[]` to the `User` model's relation list (after `streamTemplates StreamTemplate[]`):

```prisma
  streamTemplates    StreamTemplate[]
  interactionRules   InteractionRule[]
```

Add a new model at the end of the file:

```prisma
model InteractionRule {
  id             String   @id @default(uuid())
  userId         String
  user           User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  // Only "songRequest" exists today. A real string field (not a boolean) so a second action type
  // is additive to this table, not a migration that reshapes existing rows.
  actionType     String
  enabled        Boolean  @default(false)
  // Always whole UAH for MVP — see CurrencyConverter (Task 1) and the design spec.
  minAmount      Int
  // Stored bare, without the leading "!" — the rule-matching engine adds it when parsing.
  commandKeyword String   @default("song")
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@index([userId])
}
```

- [ ] **Step 2: Generate the migration via the documented remote-host process**

No local Docker daemon is available in this dev environment. Follow the process documented in
`CLAUDE.md` under "Persistence": stage `prisma/schema.prisma`, the **existing**
`prisma/migrations/` directory, and `package.json`/`package-lock.json` in a temp dir on
`192.168.14.26` (passwordless SSH); spin up a throwaway `postgres:16-alpine` container on an
isolated docker network; run `npm ci && npx prisma migrate dev --name add_interaction_rule
--skip-generate` in a throwaway `node:20-bookworm-slim` container on the same network
(`apt-get install -y openssl` first, or Prisma's engine can't detect libssl); copy the generated
`prisma/migrations/<timestamp>_add_interaction_rule/` directory back into the repo; tear down
every temporary container/network/temp file on the remote host afterward. **Never hand-write
migration SQL.**

- [ ] **Step 3: Run `npx prisma generate` locally to refresh the generated client types**

Run: `npx prisma generate`
Expected: succeeds, `@prisma/client` now exports an `InteractionRule` type.

- [ ] **Step 4: Write the repository (no unit test — matches this project's existing convention that Prisma-backed repositories are thin wrappers verified by manual smoke test, not unit tests)**

```typescript
// src/donations/interactionRuleRepository.ts
import { PrismaClient, InteractionRule } from '@prisma/client';

export interface CreateInteractionRuleInput {
  userId: string;
  actionType: string;
  enabled: boolean;
  minAmount: number;
  commandKeyword: string;
}

export interface UpdateInteractionRuleInput {
  enabled?: boolean;
  minAmount?: number;
  commandKeyword?: string;
}

export class InteractionRuleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listByUser(userId: string): Promise<InteractionRule[]> {
    return this.prisma.interactionRule.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  async listEnabledByUser(userId: string): Promise<InteractionRule[]> {
    return this.prisma.interactionRule.findMany({ where: { userId, enabled: true } });
  }

  async findById(id: string): Promise<InteractionRule | null> {
    return this.prisma.interactionRule.findUnique({ where: { id } });
  }

  async create(input: CreateInteractionRuleInput): Promise<InteractionRule> {
    return this.prisma.interactionRule.create({ data: input });
  }

  async update(id: string, input: UpdateInteractionRuleInput): Promise<InteractionRule> {
    return this.prisma.interactionRule.update({ where: { id }, data: input });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.interactionRule.delete({ where: { id } });
  }
}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors

- [ ] **Step 6: Manual smoke test against a real Postgres (matches this project's testing strategy for repositories)**

With `docker compose up` running locally: create a rule via a throwaway script or `psql`, confirm
`listByUser`/`listEnabledByUser`/`update`/`delete` behave as expected. This step has no automated
assertion — record in the PR description that it was done.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/donations/interactionRuleRepository.ts
git commit -m "feat(donations): add InteractionRule model and repository"
```

---

## Task 4: `PlaylistQueue` — single slot to ordered queue

**Files:**
- Modify: `src/playlist/queue.ts`
- Modify: `test/playlist/queue.test.ts`

**Interfaces:**
- Produces: `PlaylistQueue.insertNext(track: Track): void` now queues (FIFO) instead of overwriting. `peekNext()`/`next()`/`current()`/`previous()`/`setTracks()` signatures unchanged — every existing caller (`StreamController.playByName`) needs no changes.

- [ ] **Step 1: Write the new failing test (the existing single-insert test must keep passing unchanged — do not modify it)**

Add to `test/playlist/queue.test.ts` (after the existing `'insertNext plays once, then playback continues from base order'` test):

```typescript
  it('insertNext queues multiple tracks in order instead of overwriting the previous one', () => {
    const queue = new PlaylistQueue([track('a'), track('b'), track('c')]);
    queue.insertNext(track('donation-1'));
    queue.insertNext(track('donation-2'));
    expect(queue.peekNext()?.name).toBe('donation-1');
    expect(queue.next()?.name).toBe('donation-1');
    expect(queue.next()?.name).toBe('donation-2');
    expect(queue.next()?.name).toBe('b');
  });
```

- [ ] **Step 2: Run the tests to verify the new one fails**

Run: `npx jest test/playlist/queue.test.ts`
Expected: FAIL on the new test — the second `insertNext` overwrites the first, so the second
`queue.next()` call returns `'b'` instead of `'donation-2'`.

- [ ] **Step 3: Implement — replace the single slot with an ordered list**

In `src/playlist/queue.ts`, replace:

```typescript
  private insertedNext: Track | null = null;
```

with:

```typescript
  private insertedQueue: Track[] = [];
```

Replace the body of `peekNext()`:

```typescript
  peekNext(): Track | undefined {
    if (this.insertedQueue.length > 0) return this.insertedQueue[0];
    if (this.baseTracks.length === 0) return undefined;
    return this.baseTracks[(this.position + 1) % this.baseTracks.length];
  }
```

Replace the body of `next()`:

```typescript
  next(): Track | undefined {
    if (this.baseTracks.length === 0 && this.insertedQueue.length === 0) return undefined;
    if (this.currentTrack) this.history.push(this.currentTrack);

    if (this.insertedQueue.length > 0) {
      this.currentTrack = this.insertedQueue.shift();
      return this.currentTrack;
    }

    this.position = (this.position + 1) % this.baseTracks.length;
    this.currentTrack = this.baseTracks[this.position];
    return this.currentTrack;
  }
```

Replace the body of `insertNext()`:

```typescript
  insertNext(track: Track): void {
    this.insertedQueue.push(track);
  }
```

`current()`, `previous()`, and `setTracks()` are unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest test/playlist/queue.test.ts`
Expected: PASS (all tests, including the pre-existing single-insert one, unchanged)

- [ ] **Step 5: Run the full backend suite to confirm `playByName` and anything else touching the queue is unaffected**

Run: `npx jest`
Expected: PASS, all suites

- [ ] **Step 6: Commit**

```bash
git add src/playlist/queue.ts test/playlist/queue.test.ts
git commit -m "fix(playlist): queue insertNext requests instead of overwriting the pending one"
```

---

## Task 5: Ephemeral tracks in `StreamController` and `LocalStreamManager`

**Files:**
- Modify: `src/playlist/types.ts`
- Modify: `src/stream/streamController.ts`
- Modify: `src/stream/localStreamManager.ts`
- Modify: `test/stream/streamController.test.ts`
- Modify: `test/stream/localStreamManager.test.ts`

**Interfaces:**
- Consumes: `PlaylistQueue.insertNext` (Task 4).
- Produces: `Track._onFinished?: () => void` (optional field); `StreamController.insertEphemeralTrack(track: Track): void`; `LocalStreamManager.insertEphemeralTrack(userId: string, track: Track): void` (throws the existing `ApiError(409, 'local stream is not active')` from `require()` when there's no active session for that user).

- [ ] **Step 1: Add the `_onFinished` field to the `Track` type**

In `src/playlist/types.ts`:

```typescript
import { TrackOverlayOverride } from '../tracks/trackRepository';

export interface Track {
  name: string;
  audioPath: string;
  coverPath: string | null;
  overlayOverride?: TrackOverlayOverride | null;
  // Set only on an ephemeral (non-library) track — invoked exactly once, right after this
  // specific track finishes playing, so a temp file fetched for a single play can delete itself.
  // A real library track never sets this.
  _onFinished?: () => void;
}
```

- [ ] **Step 2: Write the failing `StreamController` tests**

`test/stream/streamController.test.ts` already has a `buildDeps()` helper returning `{ deps,
library, queue, canvasFeeder, audioRelay, encoder, encoderChild, children }`, and a `fakeChild()`
whose `emitClose(code)` fires the decode process's `'close'` event — the same mechanism the
existing auto-advance tests use (e.g. `children[0].emitClose(0)`). Add these three tests, placed
near the existing `playByName()` tests:

```typescript
  it('insertEphemeralTrack() inserts into the queue without switching immediately', async () => {
    const { deps, queue, audioRelay } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();
    audioRelay.switchTrack.mockClear();
    const ephemeralTrack: Track = { name: 'donation track', audioPath: '/tmp/donation.mp3', coverPath: null };

    controller.insertEphemeralTrack(ephemeralTrack);

    expect(queue.insertNext).toHaveBeenCalledWith(ephemeralTrack);
    expect(audioRelay.switchTrack).not.toHaveBeenCalled();
  });

  it('calls a track\'s _onFinished exactly once, right when its own decode process closes', async () => {
    const { deps, queue, children } = buildDeps();
    const onFinished = jest.fn();
    const ephemeralTrack: Track = { name: 'donation track', audioPath: '/tmp/donation.mp3', coverPath: null, _onFinished: onFinished };
    const controller = new StreamController(deps);
    await controller.start(); // feeds 'a' -> children[0]

    queue.next.mockReturnValueOnce(ephemeralTrack);
    children[0].emitClose(0); // 'a' ends -> advances onto ephemeralTrack -> children[1]
    await Promise.resolve();
    await Promise.resolve();
    expect(onFinished).not.toHaveBeenCalled(); // ephemeralTrack is now playing, not finished yet

    children[1].emitClose(0); // ephemeralTrack ends
    await Promise.resolve();
    await Promise.resolve();

    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('a regular library track (no _onFinished) closes without throwing', async () => {
    const { deps, children } = buildDeps();
    const controller = new StreamController(deps);
    await controller.start();

    expect(() => children[0].emitClose(0)).not.toThrow();
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest test/stream/streamController.test.ts`
Expected: FAIL — `insertEphemeralTrack` doesn't exist yet; `_onFinished` is never called.

- [ ] **Step 4: Implement `insertEphemeralTrack` in `StreamController`**

Add this method next to the existing `playByName` (in `src/stream/streamController.ts`):

```typescript
  // Like playByName, but the caller already has a Track object in hand (an ephemeral, DB-less
  // track built by the donation song-request flow) instead of a name to look up in the library.
  insertEphemeralTrack(track: Track): void {
    this.deps.queue.insertNext(track);
    this.deps.onStatusChanged?.();
  }
```

- [ ] **Step 5: Invoke `_onFinished` from the existing track-end handler**

In `feedCurrentTrack` (`src/stream/streamController.ts`), change:

```typescript
    child.once('close', () => {
      if (generation !== this.sessionGeneration) return;
      if (this.state !== 'streaming') return;
      this.advanceToNextTrack();
    });
```

to:

```typescript
    child.once('close', () => {
      if (generation !== this.sessionGeneration) return;
      if (this.state !== 'streaming') return;
      track._onFinished?.();
      this.advanceToNextTrack();
    });
```

- [ ] **Step 6: Run the `StreamController` tests to verify they pass**

Run: `npx jest test/stream/streamController.test.ts`
Expected: PASS

- [ ] **Step 7: Write the failing `LocalStreamManager` test**

`test/stream/localStreamManager.test.ts` drives a **real** `StreamController` through
`buildManager()`/`fakeScene()` (there is no mocked controller to assert against directly) — the
existing `playByName` coverage follows the same style. Add an explicit `import { Track } from
'../../src/playlist/types';` if the file doesn't already import it, then add these two tests near
the existing `'delegates pause/resume/next/previous/playByName to this user\'s own controller'`
test:

```typescript
  it('delegates insertEphemeralTrack to this user\'s own controller, and it plays on the next advance', async () => {
    const { manager, audioRelay } = buildManager();
    await manager.start('user-1', 'playlist-1');
    const ephemeralTrack: Track = { name: 'donation track', audioPath: '/tmp/donation.mp3', coverPath: null };

    manager.insertEphemeralTrack('user-1', ephemeralTrack);
    await manager.next('user-1');

    expect(audioRelay.switchTrack).toHaveBeenLastCalledWith('/tmp/donation.mp3', 0);
  });

  it('insertEphemeralTrack throws when no local stream is active for that user', () => {
    const { manager } = buildManager();
    const ephemeralTrack: Track = { name: 'donation track', audioPath: '/tmp/donation.mp3', coverPath: null };
    expect(() => manager.insertEphemeralTrack('user-1', ephemeralTrack)).toThrow('local stream is not active');
  });
```

- [ ] **Step 8: Run the tests to verify they fail**

Run: `npx jest test/stream/localStreamManager.test.ts`
Expected: FAIL — `insertEphemeralTrack` doesn't exist on `LocalStreamManager` yet.

- [ ] **Step 9: Implement in `LocalStreamManager`**

Add the `Track` import if not already present:

```typescript
import { Track } from '../playlist/types';
```

Add this method next to the existing `playByName` (in `src/stream/localStreamManager.ts`):

```typescript
  insertEphemeralTrack(userId: string, track: Track): void {
    this.require(userId).controller.insertEphemeralTrack(track);
  }
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npx jest test/stream/localStreamManager.test.ts`
Expected: PASS

- [ ] **Step 11: Run the full backend suite**

Run: `npx jest`
Expected: PASS, all suites

- [ ] **Step 12: Commit**

```bash
git add src/playlist/types.ts src/stream/streamController.ts src/stream/localStreamManager.ts test/stream/streamController.test.ts test/stream/localStreamManager.test.ts
git commit -m "feat(stream): support inserting and cleaning up ephemeral (DB-less) tracks"
```

---

## Task 6: Donation event normalization

**Files:**
- Create: `src/donations/donationEvent.ts`
- Test: `test/donations/donationEvent.test.ts`

**Interfaces:**
- Produces: `DonationEvent` interface (`clientName, message, actualAmount: number, actualCurrency, isSubscription, createdAt: number`); `InvalidDonationPayloadError`; `parseDonatelloPayload(body: unknown): DonationEvent`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/donations/donationEvent.test.ts
import { parseDonatelloPayload, InvalidDonationPayloadError } from '../../src/donations/donationEvent';

const validBody = {
  pubId: 'D41-123123',
  clientName: 'Андрій',
  message: 'Привіт! !song:Imagine Dragons - Believer',
  amount: '100',
  currency: 'UAH',
  actualAmount: '100',
  actualCurrency: 'UAH',
  source: 'donatello',
  goal: 'На мікрофон',
  isPaidFee: false,
  isSubscription: false,
  createdAt: '1789935697',
};

describe('parseDonatelloPayload', () => {
  it('parses a valid callback body', () => {
    const event = parseDonatelloPayload(validBody);
    expect(event).toEqual({
      clientName: 'Андрій',
      message: 'Привіт! !song:Imagine Dragons - Believer',
      actualAmount: 100,
      actualCurrency: 'UAH',
      isSubscription: false,
      createdAt: 1789935697,
    });
  });

  it('accepts actualAmount already as a number', () => {
    const event = parseDonatelloPayload({ ...validBody, actualAmount: 100 });
    expect(event.actualAmount).toBe(100);
  });

  it('rejects a non-object body', () => {
    expect(() => parseDonatelloPayload(null)).toThrow(InvalidDonationPayloadError);
    expect(() => parseDonatelloPayload('nope')).toThrow(InvalidDonationPayloadError);
  });

  it('rejects a body missing clientName', () => {
    const { clientName, ...rest } = validBody;
    expect(() => parseDonatelloPayload(rest)).toThrow('clientName must be a string');
  });

  it('rejects a body missing message', () => {
    const { message, ...rest } = validBody;
    expect(() => parseDonatelloPayload(rest)).toThrow('message must be a string');
  });

  it('rejects a non-numeric actualAmount', () => {
    expect(() => parseDonatelloPayload({ ...validBody, actualAmount: 'not-a-number' }))
      .toThrow('actualAmount is not a valid number');
  });

  it('rejects a body missing isSubscription', () => {
    const { isSubscription, ...rest } = validBody;
    expect(() => parseDonatelloPayload(rest)).toThrow('isSubscription must be a boolean');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/donations/donationEvent.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// src/donations/donationEvent.ts

// Only the fields the rule-matching engine and action executor actually need — the callback
// body carries more (pubId, goal, interactionMedia, ...) that this feature ignores by design.
export interface DonationEvent {
  clientName: string;
  message: string;
  actualAmount: number;
  actualCurrency: string;
  isSubscription: boolean;
  createdAt: number;
}

export class InvalidDonationPayloadError extends Error {}

// Donatello's "Колбеки" callback body — verified against the real dashboard's own example
// payload (amount/currency are sent as strings, not numbers). actualAmount/actualCurrency (the
// "honestly received" amount) is what the threshold check uses, not amount/currency.
export function parseDonatelloPayload(body: unknown): DonationEvent {
  if (typeof body !== 'object' || body === null) {
    throw new InvalidDonationPayloadError('request body must be a JSON object');
  }
  const raw = body as Record<string, unknown>;

  if (typeof raw.clientName !== 'string') {
    throw new InvalidDonationPayloadError('clientName must be a string');
  }
  if (typeof raw.message !== 'string') {
    throw new InvalidDonationPayloadError('message must be a string');
  }
  if (typeof raw.actualAmount !== 'string' && typeof raw.actualAmount !== 'number') {
    throw new InvalidDonationPayloadError('actualAmount must be a string or number');
  }
  if (typeof raw.actualCurrency !== 'string') {
    throw new InvalidDonationPayloadError('actualCurrency must be a string');
  }
  if (typeof raw.isSubscription !== 'boolean') {
    throw new InvalidDonationPayloadError('isSubscription must be a boolean');
  }
  if (typeof raw.createdAt !== 'string' && typeof raw.createdAt !== 'number') {
    throw new InvalidDonationPayloadError('createdAt must be a string or number');
  }

  const actualAmount = Number(raw.actualAmount);
  if (!Number.isFinite(actualAmount)) {
    throw new InvalidDonationPayloadError('actualAmount is not a valid number');
  }

  return {
    clientName: raw.clientName,
    message: raw.message,
    actualAmount,
    actualCurrency: raw.actualCurrency,
    isSubscription: raw.isSubscription,
    createdAt: Number(raw.createdAt),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest test/donations/donationEvent.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/donations/donationEvent.ts test/donations/donationEvent.test.ts
git commit -m "feat(donations): normalize Donatello callback bodies into DonationEvent"
```

---

## Task 7: Rule-matching engine

**Files:**
- Create: `src/donations/ruleMatcher.ts`
- Test: `test/donations/ruleMatcher.test.ts`

**Interfaces:**
- Consumes: `DonationEvent` (Task 6), `CurrencyConverter` (Task 1), Prisma `InteractionRule` type (Task 3).
- Produces: `parseCommand(message: string): ParsedCommand | null`; `matchRules(event, rules, converter): MatchedRule[]` where `MatchedRule = { rule: InteractionRule; query: string }`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/donations/ruleMatcher.test.ts
import { parseCommand, matchRules } from '../../src/donations/ruleMatcher';
import { DonationEvent } from '../../src/donations/donationEvent';
import { CurrencyConverter } from '../../src/donations/currencyConverter';
import { InteractionRule } from '@prisma/client';

describe('parseCommand', () => {
  it('parses a command at the start of the message', () => {
    expect(parseCommand('!song:Imagine Dragons - Believer')).toEqual({ keyword: 'song', query: 'Imagine Dragons - Believer' });
  });

  it('parses a command anywhere in the message, taking everything after the colon', () => {
    expect(parseCommand('Привіт! !song:Blur - Song 2 (Official Music Video)')).toEqual({ keyword: 'song', query: 'Blur - Song 2 (Official Music Video)' });
  });

  it('is case-insensitive on the keyword', () => {
    expect(parseCommand('!SONG:Believer')).toEqual({ keyword: 'song', query: 'Believer' });
  });

  it('returns null when there is no command', () => {
    expect(parseCommand('дякую за стрім!')).toBeNull();
  });

  it('returns null when the query part is empty', () => {
    expect(parseCommand('!song:   ')).toBeNull();
  });
});

describe('matchRules', () => {
  const baseEvent: DonationEvent = {
    clientName: 'Андрій',
    message: '!song:Believer',
    actualAmount: 500,
    actualCurrency: 'UAH',
    isSubscription: false,
    createdAt: 123,
  };

  const rule = (overrides: Partial<InteractionRule>): InteractionRule => ({
    id: 'r1', userId: 'u1', actionType: 'songRequest', enabled: true,
    minAmount: 400, commandKeyword: 'song', createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  });

  const identityConverter: CurrencyConverter = { toUah: (amount, currency) => (currency === 'UAH' ? amount : null) };

  it('matches an enabled rule whose keyword and threshold are met', () => {
    const result = matchRules(baseEvent, [rule({})], identityConverter);
    expect(result).toEqual([{ rule: rule({}), query: 'Believer' }]);
  });

  it('does not match a disabled rule', () => {
    expect(matchRules(baseEvent, [rule({ enabled: false })], identityConverter)).toEqual([]);
  });

  it('does not match when the donation is below the threshold', () => {
    expect(matchRules({ ...baseEvent, actualAmount: 100 }, [rule({})], identityConverter)).toEqual([]);
  });

  it('does not match a different keyword', () => {
    expect(matchRules(baseEvent, [rule({ commandKeyword: 'vip' })], identityConverter)).toEqual([]);
  });

  it('does not match when the message has no command at all', () => {
    expect(matchRules({ ...baseEvent, message: 'дякую!' }, [rule({})], identityConverter)).toEqual([]);
  });

  it('does not match when the currency cannot be converted', () => {
    expect(matchRules({ ...baseEvent, actualCurrency: 'GBP' }, [rule({})], identityConverter)).toEqual([]);
  });

  it('matches every enabled rule sharing the same keyword', () => {
    const result = matchRules(baseEvent, [rule({ id: 'r1' }), rule({ id: 'r2', minAmount: 1000 })], identityConverter);
    expect(result.map((m) => m.rule.id)).toEqual(['r1']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/donations/ruleMatcher.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// src/donations/ruleMatcher.ts
import { InteractionRule } from '@prisma/client';
import { DonationEvent } from './donationEvent';
import { CurrencyConverter } from './currencyConverter';

export interface ParsedCommand {
  keyword: string;
  query: string;
}

export interface MatchedRule {
  rule: InteractionRule;
  query: string;
}

// Matches "!keyword:query" anywhere in the message (not required at position 0 — a donor may
// write a greeting first, per the design spec). Everything after the colon to the end of the
// message is the query, trimmed. The 's' flag makes '.' match newlines too.
const COMMAND_PATTERN = /!([A-Za-z0-9_]+):(.+)$/s;

export function parseCommand(message: string): ParsedCommand | null {
  const match = COMMAND_PATTERN.exec(message);
  if (!match) return null;
  const query = match[2].trim();
  if (query.length === 0) return null;
  return { keyword: match[1].toLowerCase(), query };
}

export function matchRules(
  event: DonationEvent,
  rules: InteractionRule[],
  converter: CurrencyConverter,
): MatchedRule[] {
  const command = parseCommand(event.message);
  if (!command) return [];

  const amountInUah = converter.toUah(event.actualAmount, event.actualCurrency);
  if (amountInUah === null) return [];

  return rules
    .filter((rule) => rule.enabled && rule.commandKeyword.toLowerCase() === command.keyword && amountInUah >= rule.minAmount)
    .map((rule) => ({ rule, query: command.query }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest test/donations/ruleMatcher.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add src/donations/ruleMatcher.ts test/donations/ruleMatcher.test.ts
git commit -m "feat(donations): add donation command parsing and rule-matching engine"
```

---

## Task 8: Media-search HTTP client

**Files:**
- Create: `src/donations/mediaSearchClient.ts`
- Test: `test/donations/mediaSearchClient.test.ts`

**Interfaces:**
- Produces: `MediaSearchClient` interface (`fetchAudio(query: string): Promise<Buffer>`); `MediaSearchError`; `HttpMediaSearchClient` implementing it against a configurable base URL and injectable `fetch`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/donations/mediaSearchClient.test.ts
import { HttpMediaSearchClient, MediaSearchError } from '../../src/donations/mediaSearchClient';

function fakeFetch(response: Partial<Response> & { ok: boolean; status: number }): typeof fetch {
  return jest.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

describe('HttpMediaSearchClient', () => {
  it('fetches audio and returns it as a Buffer', async () => {
    const bytes = new Uint8Array([0x49, 0x44, 0x33]); // "ID3"
    const fetchImpl = fakeFetch({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer } as Response);
    const client = new HttpMediaSearchClient('http://192.168.14.26:8010', fetchImpl);

    const result = await client.fetchAudio('Blur - Song 2');

    expect(fetchImpl).toHaveBeenCalledWith('http://192.168.14.26:8010/download/audio?query=Blur%20-%20Song%202');
    expect(Buffer.compare(result, Buffer.from(bytes))).toBe(0);
  });

  it('throws MediaSearchError with the service\'s detail message on a non-2xx response', async () => {
    const fetchImpl = fakeFetch({
      ok: false, status: 502, json: async () => ({ detail: 'Ошибка подготовки файла или результат не найден' }),
    } as Response);
    const client = new HttpMediaSearchClient('http://192.168.14.26:8010', fetchImpl);

    await expect(client.fetchAudio('nonexistent track')).rejects.toThrow(MediaSearchError);
    await expect(client.fetchAudio('nonexistent track')).rejects.toThrow('Ошибка подготовки файла или результат не найден');
  });

  it('falls back to the HTTP status text when the error body is not JSON', async () => {
    const fetchImpl = fakeFetch({
      ok: false, status: 504, statusText: 'Gateway Timeout', json: async () => { throw new Error('not json'); },
    } as unknown as Response);
    const client = new HttpMediaSearchClient('http://192.168.14.26:8010', fetchImpl);

    await expect(client.fetchAudio('slow track')).rejects.toThrow('Gateway Timeout');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/donations/mediaSearchClient.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// src/donations/mediaSearchClient.ts

export interface MediaSearchClient {
  fetchAudio(query: string): Promise<Buffer>;
}

export class MediaSearchError extends Error {}

// Talks to the streamer's own media-search microservice — GET {baseUrl}/download/audio?query=.
// Verified against the real running service: 200 with content-type audio/mpeg and raw mp3 bytes
// on success; 400/502/504 with a JSON {"detail": "..."} body on failure (see the design spec).
export class HttpMediaSearchClient implements MediaSearchClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchAudio(query: string): Promise<Buffer> {
    const url = `${this.baseUrl}/download/audio?query=${encodeURIComponent(query)}`;
    const response = await this.fetchImpl(url);

    if (!response.ok) {
      let detail = response.statusText;
      try {
        const body = (await response.json()) as { detail?: string };
        if (body.detail) detail = body.detail;
      } catch {
        // Not a JSON body — keep the HTTP status text.
      }
      throw new MediaSearchError(`media search service returned ${response.status}: ${detail}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest test/donations/mediaSearchClient.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/donations/mediaSearchClient.ts test/donations/mediaSearchClient.test.ts
git commit -m "feat(donations): add HTTP client for the media-search audio endpoint"
```

---

## Task 9: Song-request action executor

**Files:**
- Create: `src/donations/songRequestAction.ts`
- Test: `test/donations/songRequestAction.test.ts`

**Interfaces:**
- Consumes: `MediaSearchClient` (Task 8), `Track` + `LocalStreamManager.insertEphemeralTrack` (Task 5).
- Produces: `executeSongRequest(deps: SongRequestDeps, query: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/donations/songRequestAction.test.ts
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { executeSongRequest, SongRequestDeps } from '../../src/donations/songRequestAction';
import { MediaSearchError } from '../../src/donations/mediaSearchClient';

describe('executeSongRequest', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'song-request-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('fetches audio, writes it to a temp file, and inserts an ephemeral track', async () => {
    const audioBytes = Buffer.from([0x49, 0x44, 0x33]);
    const mediaSearchClient = { fetchAudio: jest.fn().mockResolvedValue(audioBytes) };
    const streamInserter = { insertEphemeralTrack: jest.fn() };
    const deps: SongRequestDeps = { mediaSearchClient, streamInserter, tempDir, targetUserId: 'user-123' };

    await executeSongRequest(deps, 'Blur - Song 2');

    expect(mediaSearchClient.fetchAudio).toHaveBeenCalledWith('Blur - Song 2');
    expect(streamInserter.insertEphemeralTrack).toHaveBeenCalledTimes(1);
    const [userId, track] = streamInserter.insertEphemeralTrack.mock.calls[0];
    expect(userId).toBe('user-123');
    expect(track.name).toBe('🎁 Заказ: Blur - Song 2');
    expect(track.coverPath).toBeNull();
    expect(await fs.readFile(track.audioPath)).toEqual(audioBytes);
    expect(typeof track._onFinished).toBe('function');
  });

  it('deletes the temp file when _onFinished is called', async () => {
    const mediaSearchClient = { fetchAudio: jest.fn().mockResolvedValue(Buffer.from([1, 2, 3])) };
    const streamInserter = { insertEphemeralTrack: jest.fn() };
    const deps: SongRequestDeps = { mediaSearchClient, streamInserter, tempDir, targetUserId: 'user-123' };

    await executeSongRequest(deps, 'some query');

    const track = streamInserter.insertEphemeralTrack.mock.calls[0][1];
    await expect(fs.access(track.audioPath)).resolves.toBeUndefined();
    track._onFinished();
    await new Promise((resolve) => setImmediate(resolve)); // let the fire-and-forget unlink run
    await expect(fs.access(track.audioPath)).rejects.toThrow();
  });

  it('logs and does nothing when the media search fails', async () => {
    const mediaSearchClient = { fetchAudio: jest.fn().mockRejectedValue(new MediaSearchError('not found')) };
    const streamInserter = { insertEphemeralTrack: jest.fn() };
    const deps: SongRequestDeps = { mediaSearchClient, streamInserter, tempDir, targetUserId: 'user-123' };
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(executeSongRequest(deps, 'nonexistent track')).resolves.toBeUndefined();
    expect(streamInserter.insertEphemeralTrack).not.toHaveBeenCalled();
  });

  it('deletes the temp file if inserting into the stream throws (no active session)', async () => {
    const mediaSearchClient = { fetchAudio: jest.fn().mockResolvedValue(Buffer.from([1, 2, 3])) };
    const streamInserter = { insertEphemeralTrack: jest.fn().mockImplementation(() => { throw new Error('local stream is not active'); }) };
    const deps: SongRequestDeps = { mediaSearchClient, streamInserter, tempDir, targetUserId: 'user-123' };
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await executeSongRequest(deps, 'some query');

    const filesLeft = await fs.readdir(tempDir);
    expect(filesLeft).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/donations/songRequestAction.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// src/donations/songRequestAction.ts
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Track } from '../playlist/types';
import { MediaSearchClient } from './mediaSearchClient';

export interface StreamInserter {
  insertEphemeralTrack(userId: string, track: Track): void;
}

export interface SongRequestDeps {
  mediaSearchClient: MediaSearchClient;
  streamInserter: StreamInserter;
  // A dedicated temp directory — NOT {UPLOADS_DIR}, which is for the permanent track library.
  tempDir: string;
  targetUserId: string;
}

// Fetches the requested track, inserts it as a one-off next track, and wires up its own
// deletion. Every failure path (media search failure, no active stream to insert into) is
// swallowed and logged — a donation song request has no user-facing feedback in MVP by design.
export async function executeSongRequest(deps: SongRequestDeps, query: string): Promise<void> {
  let audioBuffer: Buffer;
  try {
    audioBuffer = await deps.mediaSearchClient.fetchAudio(query);
  } catch (err) {
    console.error(`song request failed: could not fetch audio for query "${query}"`, err);
    return;
  }

  await fs.mkdir(deps.tempDir, { recursive: true });
  const filePath = path.join(deps.tempDir, `${randomUUID()}.mp3`);
  await fs.writeFile(filePath, audioBuffer);

  const track: Track = {
    name: `🎁 Заказ: ${query}`,
    audioPath: filePath,
    coverPath: null,
  };
  track._onFinished = () => {
    fs.unlink(filePath).catch((err) => {
      console.error(`failed to delete temp donation-song file ${filePath}`, err);
    });
  };

  try {
    deps.streamInserter.insertEphemeralTrack(deps.targetUserId, track);
  } catch (err) {
    console.error('song request failed: no active local stream to insert into', err);
    await fs.unlink(filePath).catch(() => {});
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest test/donations/songRequestAction.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/donations/songRequestAction.ts test/donations/songRequestAction.test.ts
git commit -m "feat(donations): add the song-request action executor"
```

---

## Task 10: Temp file cleanup sweep

**Files:**
- Create: `src/donations/tempFileCleanup.ts`
- Test: `test/donations/tempFileCleanup.test.ts`

**Interfaces:**
- Produces: `sweepStaleFiles(dir: string, maxAgeMs: number): Promise<void>`; `startTempFileCleanupSweep(dir: string, maxAgeMs: number, intervalMs: number): { stop: () => void }`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/donations/tempFileCleanup.test.ts
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sweepStaleFiles, startTempFileCleanupSweep } from '../../src/donations/tempFileCleanup';

describe('sweepStaleFiles', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-sweep-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('deletes files older than maxAgeMs and keeps newer ones', async () => {
    const stalePath = path.join(tempDir, 'stale.mp3');
    const freshPath = path.join(tempDir, 'fresh.mp3');
    await fs.writeFile(stalePath, 'old');
    await fs.writeFile(freshPath, 'new');
    const oldTime = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
    await fs.utimes(stalePath, oldTime, oldTime);

    await sweepStaleFiles(tempDir, 30 * 60 * 1000); // 30-minute threshold

    await expect(fs.access(stalePath)).rejects.toThrow();
    await expect(fs.access(freshPath)).resolves.toBeUndefined();
  });

  it('does nothing if the directory does not exist yet', async () => {
    await expect(sweepStaleFiles(path.join(tempDir, 'does-not-exist'), 1000)).resolves.toBeUndefined();
  });
});

describe('startTempFileCleanupSweep', () => {
  it('runs the sweep on the given interval and can be stopped', () => {
    jest.useFakeTimers();
    const dir = '/tmp/whatever';
    const handle = startTempFileCleanupSweep(dir, 1000, 500);
    // Real sweepStaleFiles isn't mocked here — this just proves the interval fires and stop()
    // clears it, using a real timer count rather than asserting on filesystem side effects
    // (already covered by the sweepStaleFiles tests above).
    expect(jest.getTimerCount()).toBe(1);
    handle.stop();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/donations/tempFileCleanup.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// src/donations/tempFileCleanup.ts
import { promises as fs } from 'fs';
import * as path from 'path';

// Defense in depth for the _onFinished hook in songRequestAction.ts: catches any temp file left
// behind by a crash or an unhandled error path that skipped the direct cleanup callback.
export async function sweepStaleFiles(dir: string, maxAgeMs: number): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  const now = Date.now();
  await Promise.all(entries.map(async (name) => {
    const filePath = path.join(dir, name);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) return;
    if (now - stat.mtimeMs > maxAgeMs) {
      await fs.unlink(filePath).catch((err) => {
        console.error(`temp file cleanup sweep failed to delete ${filePath}`, err);
      });
    }
  }));
}

export function startTempFileCleanupSweep(dir: string, maxAgeMs: number, intervalMs: number): { stop: () => void } {
  const timer = setInterval(() => {
    sweepStaleFiles(dir, maxAgeMs).catch((err) => {
      console.error('temp file cleanup sweep failed', err);
    });
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest test/donations/tempFileCleanup.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/donations/tempFileCleanup.ts test/donations/tempFileCleanup.test.ts
git commit -m "feat(donations): add periodic temp-file cleanup sweep"
```

---

## Task 11: Donatello webhook route

**Files:**
- Create: `src/donations/donatelloWebhookRoutes.ts`
- Test: `test/donations/donatelloWebhookRoutes.test.ts`

**Interfaces:**
- Consumes: `parseDonatelloPayload` (Task 6), `matchRules` (Task 7), `executeSongRequest` (Task 9), `InteractionRuleRepository.listEnabledByUser` (Task 3, via a narrow `Pick`).
- Produces: `createDonatelloWebhookRouter(deps): Router`, mounted at `/webhooks/donatello`.

- [ ] **Step 1: Write the failing tests**

Read `test/stream/localStreamRoutes.test.ts` first (or any other route test file) for this
project's supertest setup style, then write:

```typescript
// test/donations/donatelloWebhookRoutes.test.ts
import express from 'express';
import request from 'supertest';
import { createDonatelloWebhookRouter } from '../../src/donations/donatelloWebhookRoutes';
import { errorHandler } from '../../src/api/errorHandler';

const validBody = {
  clientName: 'Андрій',
  message: '!song:Believer',
  amount: '500',
  currency: 'UAH',
  actualAmount: '500',
  actualCurrency: 'UAH',
  isSubscription: false,
  createdAt: '1789935697',
};

function buildApp(deps: Parameters<typeof createDonatelloWebhookRouter>[0]) {
  const app = express();
  app.use(express.json());
  app.use('/webhooks/donatello', createDonatelloWebhookRouter(deps));
  app.use(errorHandler);
  return app;
}

describe('POST /webhooks/donatello', () => {
  it('returns 401 when X-Key is missing', async () => {
    const app = buildApp({ callbackKey: 'secret', ruleRepository: { listEnabledByUser: jest.fn() }, executeSongRequest: jest.fn(), converter: { toUah: () => 0 }, targetUserId: 'u1' });
    const res = await request(app).post('/webhooks/donatello').send(validBody);
    expect(res.status).toBe(401);
  });

  it('returns 401 when X-Key is wrong', async () => {
    const app = buildApp({ callbackKey: 'secret', ruleRepository: { listEnabledByUser: jest.fn() }, executeSongRequest: jest.fn(), converter: { toUah: () => 0 }, targetUserId: 'u1' });
    const res = await request(app).post('/webhooks/donatello').set('X-Key', 'wrong').send(validBody);
    expect(res.status).toBe(401);
  });

  it('returns 200 and dispatches the matched action on a valid, authenticated request', async () => {
    const listEnabledByUser = jest.fn().mockResolvedValue([
      { id: 'r1', userId: 'u1', actionType: 'songRequest', enabled: true, minAmount: 400, commandKeyword: 'song', createdAt: new Date(), updatedAt: new Date() },
    ]);
    const executeSongRequest = jest.fn().mockResolvedValue(undefined);
    const app = buildApp({
      callbackKey: 'secret',
      ruleRepository: { listEnabledByUser },
      executeSongRequest,
      converter: { toUah: (amount: number) => amount },
      targetUserId: 'u1',
    });

    const res = await request(app).post('/webhooks/donatello').set('X-Key', 'secret').send(validBody);

    expect(res.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve)); // let the fire-and-forget dispatch run
    expect(executeSongRequest).toHaveBeenCalledWith('Believer');
  });

  it('returns 200 even when nothing matched, so Donatello never retries on our own decisions', async () => {
    const app = buildApp({
      callbackKey: 'secret',
      ruleRepository: { listEnabledByUser: jest.fn().mockResolvedValue([]) },
      executeSongRequest: jest.fn(),
      converter: { toUah: (amount: number) => amount },
      targetUserId: 'u1',
    });
    const res = await request(app).post('/webhooks/donatello').set('X-Key', 'secret').send(validBody);
    expect(res.status).toBe(200);
  });

  it('returns 400 on a malformed body', async () => {
    const app = buildApp({ callbackKey: 'secret', ruleRepository: { listEnabledByUser: jest.fn() }, executeSongRequest: jest.fn(), converter: { toUah: () => 0 }, targetUserId: 'u1' });
    const res = await request(app).post('/webhooks/donatello').set('X-Key', 'secret').send({ notEvenClose: true });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/donations/donatelloWebhookRoutes.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// src/donations/donatelloWebhookRoutes.ts
import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { parseDonatelloPayload, InvalidDonationPayloadError } from './donationEvent';
import { matchRules } from './ruleMatcher';
import { CurrencyConverter } from './currencyConverter';
import { wrapAsync } from '../api/errorHandler';
import { ApiError } from '../errors';
import { InteractionRuleRepository } from './interactionRuleRepository';

export interface DonatelloWebhookDeps {
  callbackKey: string;
  ruleRepository: Pick<InteractionRuleRepository, 'listEnabledByUser'>;
  executeSongRequest: (query: string) => Promise<void>;
  converter: CurrencyConverter;
  // MVP stopgap — see the design spec and AppConfig.donationTargetUserId.
  targetUserId: string;
}

function timingSafeKeyEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function createDonatelloWebhookRouter(deps: DonatelloWebhookDeps): Router {
  const router = Router();

  router.post('/', wrapAsync(async (req, res) => {
    const key = req.header('X-Key');
    if (!key || !timingSafeKeyEqual(key, deps.callbackKey)) {
      throw new ApiError(401, 'invalid or missing X-Key');
    }

    let event;
    try {
      event = parseDonatelloPayload(req.body);
    } catch (err) {
      if (err instanceof InvalidDonationPayloadError) throw new ApiError(400, err.message);
      throw err;
    }

    // Answer fast; a structurally valid, authenticated request is always 200 from here on — our
    // own downstream decisions (no rule matched, the action failed) must never look like a
    // delivery failure to Donatello, or it will retry forever.
    res.status(200).json({ received: true });

    const rules = await deps.ruleRepository.listEnabledByUser(deps.targetUserId);
    const matches = matchRules(event, rules, deps.converter);
    // Every matched rule's actionType is "songRequest" today (the only value validated by
    // interactionRuleRoutes.ts — see Task 12), so dispatching straight to executeSongRequest is
    // correct for MVP. match.rule.actionType exists for the day a second action type is added;
    // this loop becomes a real dispatch (switch on actionType) at that point, not before.
    for (const match of matches) {
      deps.executeSongRequest(match.query).catch((err) => {
        console.error('donation-triggered action failed', err);
      });
    }
  }));

  return router;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest test/donations/donatelloWebhookRoutes.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/donations/donatelloWebhookRoutes.ts test/donations/donatelloWebhookRoutes.test.ts
git commit -m "feat(donations): add the Donatello webhook route"
```

---

## Task 12: `InteractionRule` CRUD API route

**Files:**
- Create: `src/donations/interactionRuleRoutes.ts`
- Test: `test/donations/interactionRuleRoutes.test.ts`

**Interfaces:**
- Consumes: `InteractionRuleRepository` (Task 3), `requireAuth`/`AuthenticatedRequest` (existing `src/auth/authMiddleware.ts`).
- Produces: `createInteractionRuleRouter(authService, ruleRepository): Router`, mounted at `/interaction-rules`.

- [ ] **Step 1: Write the failing tests**

Read `test/templates/templateRoutes.test.ts` (or another authenticated CRUD route test) first to
match this project's `requireAuth`-faking setup exactly, then write equivalent tests for:
- `GET /interaction-rules` — 200, returns the authenticated user's rules only.
- `POST /interaction-rules` — 201 on valid body; 400 when `minAmount` is not a positive number;
  400 when `commandKeyword` is empty, contains whitespace, or is longer than 20 characters; 400
  when `Content-Type` isn't `application/json`.
- `PUT /interaction-rules/:id` — 200 on a valid partial update; 404 when the rule doesn't exist or
  belongs to another user.
- `DELETE /interaction-rules/:id` — 200/204 on success; 404 when the rule doesn't exist or belongs
  to another user.

(This plan intentionally does not fabricate the exact supertest boilerplate here — copy the
authenticated-route test harness from an existing file such as `templateRoutes.test.ts` verbatim,
then swap in the assertions listed above, so the fake-session/fake-cookie mechanics stay
consistent with the rest of the test suite rather than diverging.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/donations/interactionRuleRoutes.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// src/donations/interactionRuleRoutes.ts
import { Router } from 'express';
import { AuthService } from '../auth/authService';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { wrapAsync } from '../api/errorHandler';
import { ApiError } from '../errors';
import { InteractionRuleRepository } from './interactionRuleRepository';

const COMMAND_KEYWORD_PATTERN = /^[a-zA-Z0-9]{1,20}$/;
// Only one action type exists today — validated explicitly (not just "any non-empty string") so
// a typo doesn't silently create a rule nothing will ever execute.
const KNOWN_ACTION_TYPES = ['songRequest'];

function requireJsonRequest(req: AuthenticatedRequest, _res: unknown, next: (err?: unknown) => void) {
  if (!req.is('application/json')) {
    next(new ApiError(400, 'Content-Type: application/json is required'));
    return;
  }
  next();
}

function validateRuleBody(body: unknown): { actionType: string; enabled: boolean; minAmount: number; commandKeyword: string } {
  const raw = (body ?? {}) as Record<string, unknown>;
  const actionType = raw.actionType;
  const enabled = raw.enabled;
  const minAmount = raw.minAmount;
  const commandKeyword = raw.commandKeyword;

  if (typeof actionType !== 'string' || !KNOWN_ACTION_TYPES.includes(actionType)) {
    throw new ApiError(400, `body.actionType must be one of: ${KNOWN_ACTION_TYPES.join(', ')}`);
  }
  if (typeof enabled !== 'boolean') {
    throw new ApiError(400, 'body.enabled must be a boolean');
  }
  if (typeof minAmount !== 'number' || !Number.isInteger(minAmount) || minAmount <= 0) {
    throw new ApiError(400, 'body.minAmount must be a positive whole number');
  }
  if (typeof commandKeyword !== 'string' || !COMMAND_KEYWORD_PATTERN.test(commandKeyword)) {
    throw new ApiError(400, 'body.commandKeyword must be 1-20 letters/digits with no spaces');
  }

  return { actionType, enabled, minAmount, commandKeyword: commandKeyword.toLowerCase() };
}

export function createInteractionRuleRouter(authService: AuthService, ruleRepository: InteractionRuleRepository): Router {
  const router = Router();
  const auth = requireAuth(authService);
  const userId = (req: AuthenticatedRequest) => req.user!.id;

  router.get('/', auth, wrapAsync(async (req, res) => {
    const rules = await ruleRepository.listByUser(userId(req as AuthenticatedRequest));
    res.status(200).json(rules);
  }));

  router.post('/', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const input = validateRuleBody(req.body);
    const rule = await ruleRepository.create({ ...input, userId: userId(req as AuthenticatedRequest) });
    res.status(201).json(rule);
  }));

  router.put('/:id', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const existing = await ruleRepository.findById(req.params.id);
    if (!existing || existing.userId !== userId(req as AuthenticatedRequest)) {
      throw new ApiError(404, 'interaction rule not found');
    }
    const input = validateRuleBody({ actionType: existing.actionType, ...req.body });
    const rule = await ruleRepository.update(req.params.id, input);
    res.status(200).json(rule);
  }));

  router.delete('/:id', auth, wrapAsync(async (req, res) => {
    const existing = await ruleRepository.findById(req.params.id);
    if (!existing || existing.userId !== userId(req as AuthenticatedRequest)) {
      throw new ApiError(404, 'interaction rule not found');
    }
    await ruleRepository.delete(req.params.id);
    res.status(200).json({});
  }));

  return router;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest test/donations/interactionRuleRoutes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/donations/interactionRuleRoutes.ts test/donations/interactionRuleRoutes.test.ts
git commit -m "feat(donations): add InteractionRule CRUD API routes"
```

---

## Task 13: Wire everything into the composition root

**Files:**
- Modify: `src/api/app.ts`
- Modify: `src/server.ts`
- Modify: `test/server.test.ts` (if `AppDeps` gains required fields that fixture must supply)

**Interfaces:**
- Consumes: every module from Tasks 1-12.
- Produces: `POST /webhooks/donatello` and the `/interaction-rules` CRUD surface mounted on the real app; the temp-file cleanup sweep started in `buildServer`.

- [ ] **Step 1: Extend `AppDeps` and mount the routers in `src/api/app.ts`**

Add imports:

```typescript
import { InteractionRuleRepository } from '../donations/interactionRuleRepository';
import { createInteractionRuleRouter } from '../donations/interactionRuleRoutes';
import { createDonatelloWebhookRouter, DonatelloWebhookDeps } from '../donations/donatelloWebhookRoutes';
```

Add to `AppDeps` (after `streamPresetRepository: StreamPresetRepository;`):

```typescript
  interactionRuleRepository: InteractionRuleRepository;
  donatelloWebhookDeps: Omit<DonatelloWebhookDeps, 'ruleRepository'>;
```

Add to `createApp` (after the `/stream-presets` mount):

```typescript
  app.use('/interaction-rules', createInteractionRuleRouter(deps.authService, deps.interactionRuleRepository));
  app.use('/webhooks/donatello', createDonatelloWebhookRouter({ ...deps.donatelloWebhookDeps, ruleRepository: deps.interactionRuleRepository }));
```

- [ ] **Step 2: Construct the new dependencies in `src/server.ts`**

Add imports:

```typescript
import { InteractionRuleRepository } from './donations/interactionRuleRepository';
import { StubCurrencyConverter } from './donations/currencyConverter';
import { HttpMediaSearchClient } from './donations/mediaSearchClient';
import { executeSongRequest } from './donations/songRequestAction';
import { startTempFileCleanupSweep } from './donations/tempFileCleanup';
import * as os from 'os';
import * as path from 'path';
```

Add, after `const streamPresetRepository = new StreamPresetRepository(prisma);`:

```typescript
  const interactionRuleRepository = new InteractionRuleRepository(prisma);
  const donationTempDir = path.join(os.tmpdir(), 'super-dj-donation-songs');
  const mediaSearchClient = new HttpMediaSearchClient(config.mediaSearchServiceUrl);
  const currencyConverter = new StubCurrencyConverter();

  // 30-minute staleness threshold, swept every 10 minutes — a defense-in-depth fallback for the
  // direct cleanup hook in songRequestAction.ts (see that file and the design spec).
  const tempFileCleanupSweep = startTempFileCleanupSweep(donationTempDir, 30 * 60 * 1000, 10 * 60 * 1000);
```

Add to the `createApp({...})` call (after `streamPresetRepository,`):

```typescript
    interactionRuleRepository,
    donatelloWebhookDeps: {
      callbackKey: config.donatelloCallbackKey,
      converter: currencyConverter,
      targetUserId: config.donationTargetUserId,
      executeSongRequest: (query: string) => executeSongRequest(
        { mediaSearchClient, streamInserter: localStreamManager, tempDir: donationTempDir, targetUserId: config.donationTargetUserId },
        query,
      ),
    },
```

Add `tempFileCleanupSweep` to the function's return value (change the final `return` line):

```typescript
  return { app, prisma, mediaMtxAuthApp, mediaMtxAuthPort: config.mediaMtxAuthPort, tempFileCleanupSweep };
```

- [ ] **Step 2b: Stop the sweep on shutdown**

Find where `main.ts` handles `SIGTERM`/`SIGINT` (it already calls `prisma.$disconnect()` there per
CLAUDE.md's description of the shutdown path) and add a call to `tempFileCleanupSweep.stop()`
alongside it, using the value returned from `buildServer()`.

- [ ] **Step 3: Type-check**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors — this step will surface any mismatch between what `LocalStreamManager`
actually implements (`insertEphemeralTrack`, `Track` shape) and what `songRequestAction.ts`'s
`StreamInserter` interface expects; both should already match from Task 5 and Task 9, but this is
the first point they're wired together for real.

- [ ] **Step 4: Run the full backend test suite**

Run: `npx jest`
Expected: PASS, all suites

- [ ] **Step 5: Manual smoke test**

With `docker compose up` running (and `DONATION_TARGET_USER_ID`/`MEDIA_SEARCH_SERVICE_URL` set in
the environment), start a local stream, then `curl -X POST http://localhost:3000/webhooks/donatello
-H "Content-Type: application/json" -H "X-Key: <your DONATELLO_CALLBACK_KEY>" -d '{"clientName":
"test","message":"!song:Test Query","amount":"500","currency":"UAH","actualAmount":"500",
"actualCurrency":"UAH","isSubscription":false,"createdAt":"1789935697"}'` (after creating a
matching `InteractionRule` via the CRUD API) and confirm the track plays and its temp file is
deleted afterward. Record in the PR description that this was done.

- [ ] **Step 6: Commit**

```bash
git add src/api/app.ts src/server.ts
git commit -m "feat(donations): wire the donation song-request pipeline into the app"
```

---

## Task 14: Frontend API client

**Files:**
- Create: `frontend/src/api/interactionRules.ts`
- Test: `frontend/src/api/interactionRules.test.ts`

**Interfaces:**
- Produces: `InteractionRule` type, `interactionRulesApi.{list, create, update, remove}`.

- [ ] **Step 1: Write the failing test**

Read `frontend/src/api/templates.test.ts` first to match its mocking style for the shared `api`
client, then write equivalent tests asserting `interactionRulesApi.list()` calls `GET
/interaction-rules`, `.create(...)` calls `POST /interaction-rules` with the right body,
`.update(id, ...)` calls `PUT /interaction-rules/{id}`, and `.remove(id)` calls `DELETE
/interaction-rules/{id}`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/api/interactionRules.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// frontend/src/api/interactionRules.ts
import { api } from './client';

// "songRequest" is the only action type today — kept as a real string union (not inlined as a
// boolean) so the frontend is ready for a second action type without a type-shape change.
export type ActionType = 'songRequest';

export interface InteractionRule {
  id: string;
  actionType: ActionType;
  enabled: boolean;
  minAmount: number;
  commandKeyword: string;
  createdAt: string;
  updatedAt: string;
}

export interface InteractionRuleInput {
  actionType: ActionType;
  enabled: boolean;
  minAmount: number;
  commandKeyword: string;
}

export const interactionRulesApi = {
  list: () => api.get<InteractionRule[]>('/interaction-rules'),
  create: (input: InteractionRuleInput) => api.post<InteractionRule>('/interaction-rules', input),
  update: (id: string, input: Partial<InteractionRuleInput>) => api.put<InteractionRule>(`/interaction-rules/${id}`, input),
  remove: (id: string) => api.delete<Record<string, never>>(`/interaction-rules/${id}`),
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/api/interactionRules.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/interactionRules.ts frontend/src/api/interactionRules.test.ts
git commit -m "feat(frontend): add InteractionRule API client"
```

---

## Task 15: Frontend "Донаты" page, routing, and translations

**Files:**
- Create: `frontend/src/pages/Donations.tsx`
- Create: `frontend/src/pages/Donations.test.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/Sidebar.tsx`
- Modify: `frontend/src/i18n/locales/en.json`, `frontend/src/i18n/locales/ru.json`, `frontend/src/i18n/locales/uk.json`

**Interfaces:**
- Consumes: `interactionRulesApi` (Task 14), `Drawer` and `ConfirmDialog` components (existing).
- Produces: a routed page at `/donations` listed in the sidebar.

- [ ] **Step 1: Add translation keys**

Add to `frontend/src/i18n/locales/en.json` (a new top-level `"donations"` key, alongside
`"templates"`, plus one new `"sidebar.donations"` entry):

```json
  "sidebar": {
    "library": "Library",
    "playlists": "Playlists",
    "destinations": "Destinations",
    "templates": "Templates",
    "stream": "Stream",
    "donations": "Donations",
    "signOut": "Sign out"
  },
```

```json
  "donations": {
    "title": "Donations",
    "subtitle": "Rules that turn a Donatello donation into a live action.",
    "add": "+ Add rule",
    "empty": "No rules yet.",
    "loading": "Loading…",
    "triggerSummary": "Donation ≥ {{amount}} UAH + command \"!{{keyword}}\"",
    "actionSongRequest": "Song request",
    "edit": "Edit",
    "delete": "Delete",
    "deleteConfirmTitle": "Delete this rule?",
    "deleteConfirmDescription": "Donations will no longer trigger this action.",
    "deleteFailed": "Failed to delete the rule",
    "form": {
      "createTitle": "New rule",
      "editTitle": "Edit rule",
      "actionType": "Action",
      "minAmount": "Minimum donation amount (UAH)",
      "commandKeyword": "Command",
      "commandKeywordHint": "Letters and digits only, no spaces.",
      "instructionPreview": "Viewers will be able to request a song by writing this in their donation message: !{{keyword}}:Artist - Title",
      "save": "Save",
      "saving": "Saving…",
      "saveFailed": "Failed to save the rule",
      "invalidAmount": "Enter a whole number greater than 0",
      "invalidKeyword": "1-20 letters or digits, no spaces"
    }
  },
```

Add the equivalent Russian translation to `frontend/src/i18n/locales/ru.json` (same key structure,
Russian copy — e.g. `"title": "Донаты"`, `"subtitle": "Правила, которые превращают донат на
Donatello в действие на стриме."`, `"add": "+ Добавить правило"`, and so on through every key
above) and the equivalent Ukrainian translation to `frontend/src/i18n/locales/uk.json` (same key
structure, Ukrainian copy). Match the phrasing style already used in each file's `"templates"`
section.

- [ ] **Step 2: Write the failing page test**

Read `frontend/src/pages/Templates.test.tsx` first to match its react-query/mocking setup, then
write tests asserting: the page renders the rule list from `interactionRulesApi.list()`; clicking
"+ Add rule" opens the create form; submitting a valid form calls `interactionRulesApi.create()`
and closes the drawer; entering an invalid `minAmount` (e.g. `0` or `-5`) shows a validation error
and does not call the API; clicking "Delete" then confirming calls `interactionRulesApi.remove()`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/Donations.test.tsx`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 4: Write the page**

```typescript
// frontend/src/pages/Donations.tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { interactionRulesApi, InteractionRule, InteractionRuleInput } from '../api/interactionRules';
import { ApiError } from '../api/client';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Drawer } from '../components/Drawer';
import { usePageTitle } from '../hooks/usePageTitle';

const ACTION_TYPE_LABELS: Record<InteractionRule['actionType'], string> = {
  songRequest: 'donations.actionSongRequest',
};

interface RuleFormState {
  minAmount: string;
  commandKeyword: string;
  enabled: boolean;
}

const EMPTY_FORM: RuleFormState = { minAmount: '', commandKeyword: 'song', enabled: true };

function RuleForm({ initial, onSubmit, isPending, error }: {
  initial: RuleFormState;
  onSubmit: (input: InteractionRuleInput) => void;
  isPending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState(initial);
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const amount = Number(form.minAmount);
    if (!Number.isInteger(amount) || amount <= 0) {
      setValidationError(t('donations.form.invalidAmount'));
      return;
    }
    if (!/^[a-zA-Z0-9]{1,20}$/.test(form.commandKeyword)) {
      setValidationError(t('donations.form.invalidKeyword'));
      return;
    }
    setValidationError(null);
    onSubmit({ actionType: 'songRequest', enabled: form.enabled, minAmount: amount, commandKeyword: form.commandKeyword });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium">{t('donations.form.actionType')}</label>
        <select disabled className="mt-1 w-full rounded border p-2">
          <option>{t('donations.actionSongRequest')}</option>
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium">{t('donations.form.minAmount')}</label>
        <input
          type="number"
          value={form.minAmount}
          onChange={(e) => setForm({ ...form, minAmount: e.target.value })}
          className="mt-1 w-full rounded border p-2"
        />
      </div>
      <div>
        <label className="block text-sm font-medium">{t('donations.form.commandKeyword')}</label>
        <div className="mt-1 flex items-center gap-1">
          <span className="text-gray-500">!</span>
          <input
            type="text"
            value={form.commandKeyword}
            onChange={(e) => setForm({ ...form, commandKeyword: e.target.value })}
            className="w-full rounded border p-2"
          />
        </div>
        <p className="mt-1 text-xs text-gray-500">{t('donations.form.commandKeywordHint')}</p>
      </div>
      <p className="rounded bg-gray-50 p-3 text-sm text-gray-600">
        {t('donations.form.instructionPreview', { keyword: form.commandKeyword || '…' })}
      </p>
      {(validationError || error) && <p className="text-sm text-red-600">{validationError ?? error}</p>}
      <button type="submit" disabled={isPending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">
        {isPending ? t('donations.form.saving') : t('donations.form.save')}
      </button>
    </form>
  );
}

export default function Donations() {
  const { t } = useTranslation();
  usePageTitle(t('donations.title'));
  const queryClient = useQueryClient();
  const rulesQuery = useQuery({ queryKey: ['interaction-rules'], queryFn: interactionRulesApi.list });
  const [drawerState, setDrawerState] = useState<{ mode: 'create' } | { mode: 'edit'; rule: InteractionRule } | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: (input: InteractionRuleInput) => interactionRulesApi.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['interaction-rules'] });
      setDrawerState(null);
    },
    onError: (err) => setFormError(err instanceof ApiError ? err.message : t('donations.form.saveFailed')),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: InteractionRuleInput }) => interactionRulesApi.update(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['interaction-rules'] });
      setDrawerState(null);
    },
    onError: (err) => setFormError(err instanceof ApiError ? err.message : t('donations.form.saveFailed')),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => interactionRulesApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['interaction-rules'] });
      setConfirmingId(null);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('donations.deleteFailed')),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('donations.title')}</h1>
        <button onClick={() => { setFormError(null); setDrawerState({ mode: 'create' }); }} className="rounded bg-black px-4 py-2 text-white">
          {t('donations.add')}
        </button>
      </div>
      <p className="text-sm text-gray-500">{t('donations.subtitle')}</p>

      {rulesQuery.isLoading ? (
        <p className="text-sm text-gray-500">{t('donations.loading')}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {rulesQuery.data?.map((rule) => (
            <li key={rule.id} className="flex items-center justify-between p-3">
              <div>
                <div className="font-medium">{t(ACTION_TYPE_LABELS[rule.actionType])}</div>
                <div className="text-sm text-gray-500">
                  {t('donations.triggerSummary', { amount: rule.minAmount, keyword: rule.commandKeyword })}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={() => updateMutation.mutate({ id: rule.id, input: { actionType: rule.actionType, enabled: !rule.enabled, minAmount: rule.minAmount, commandKeyword: rule.commandKeyword } })}
                />
                <button onClick={() => { setFormError(null); setDrawerState({ mode: 'edit', rule }); }} className="text-sm underline">{t('donations.edit')}</button>
                <button onClick={() => setConfirmingId(rule.id)} className="text-sm text-red-600">{t('donations.delete')}</button>
              </div>
            </li>
          ))}
          {rulesQuery.data?.length === 0 && <li className="p-3 text-sm text-gray-500">{t('donations.empty')}</li>}
        </ul>
      )}

      <Drawer
        open={drawerState !== null}
        onOpenChange={(open) => !open && setDrawerState(null)}
        title={drawerState?.mode === 'edit' ? t('donations.form.editTitle') : t('donations.form.createTitle')}
      >
        {drawerState && (
          <RuleForm
            initial={drawerState.mode === 'edit'
              ? { minAmount: String(drawerState.rule.minAmount), commandKeyword: drawerState.rule.commandKeyword, enabled: drawerState.rule.enabled }
              : EMPTY_FORM}
            isPending={createMutation.isPending || updateMutation.isPending}
            error={formError}
            onSubmit={(input) => (drawerState.mode === 'edit'
              ? updateMutation.mutate({ id: drawerState.rule.id, input })
              : createMutation.mutate(input))}
          />
        )}
      </Drawer>

      <ConfirmDialog
        open={confirmingId !== null}
        onOpenChange={(open) => !open && setConfirmingId(null)}
        title={t('donations.deleteConfirmTitle')}
        description={t('donations.deleteConfirmDescription')}
        confirmLabel={t('donations.delete')}
        isPending={deleteMutation.isPending}
        onConfirm={() => confirmingId && deleteMutation.mutate(confirmingId)}
      />
    </div>
  );
}
```

- [ ] **Step 5: Register the route and sidebar link**

In `frontend/src/App.tsx`, add the import (`import Donations from './pages/Donations';`) and, after
the `/templates/:id` route, add:

```typescript
                <Route path="/donations" element={<Donations />} />
```

In `frontend/src/components/Sidebar.tsx`, add to the `links` array (after the `templates` entry):

```typescript
    { to: '/donations', label: t('sidebar.donations') },
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/pages/Donations.test.tsx`
Expected: PASS

- [ ] **Step 7: Run the full frontend test suite**

Run: `cd frontend && npx vitest run`
Expected: PASS, all suites

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/Donations.tsx frontend/src/pages/Donations.test.tsx frontend/src/App.tsx frontend/src/components/Sidebar.tsx frontend/src/i18n/locales/en.json frontend/src/i18n/locales/ru.json frontend/src/i18n/locales/uk.json
git commit -m "feat(frontend): add the Donations rules page"
```

---

## Final verification

- [ ] Run the full backend suite: `npx jest` — expect all suites green.
- [ ] Run `npx tsc -p tsconfig.json --noEmit` — expect no errors.
- [ ] Run the full frontend suite: `cd frontend && npx vitest run` — expect all suites green.
- [ ] Confirm the manual smoke tests from Task 3 (repository against real Postgres) and Task 13
  (end-to-end webhook → play → cleanup) were actually performed, not just planned.
- [ ] Re-read the design spec's "Known follow-ups" section — confirm none of them were
  accidentally "solved" in passing by this plan (they weren't meant to be; if one was, that's a
  scope creep to flag, not a bonus).
