# Add-track-via-media-service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a streamer add a library track by typing a text query instead of uploading a file —
the backend fetches audio from their own external media-search microservice, holds it as a
temporary preview the streamer can listen to in-browser, and only persists it as a real track once
confirmed. Available from the Library page (creates a library track) and from a playlist's editor
page (creates the track and stages it into that playlist in one step).

**Architecture:** A new `TrackPreviewRegistry` (in-memory `previewId → {userId, tempFilePath,
createdAt}`, same shape as `MediaMtxAuthRegistry`) plus a `TrackPreviewService` that orchestrates
search → temp file → registry entry, and registry entry → permanent track via the EXISTING
`TrackUploadService.upload()` (unchanged — it only needs an `{originalname, path, size}`-shaped
object, which a preview's temp file satisfies once wrapped). Four new routes under `/tracks`. A
second `startTempFileCleanupSweep` instance (already generic, already used for donation temp files)
reaps abandoned previews after 1 hour. `HttpMediaSearchClient` moves out of `src/donations/` into a
neutral `src/media/` module first, since both features now depend on it.

**Tech Stack:** Same as the rest of the backend (Express, Prisma, Jest, supertest) and frontend
(React, Vite, React Query, Vitest, Testing Library) — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-22-track-library-via-media-service-design.md`

## Global Constraints

- `TrackUploadService.upload()` is NOT modified — every new backend piece adapts to its existing
  `{originalname, path, size}` input shape, never the other way around.
- The preview registry is in-memory only, per-process, exactly like `MediaMtxAuthRegistry` — no new
  Prisma model, no database table for previews.
- Preview temp files live in their own directory, `path.join(os.tmpdir(), 'super-dj-track-previews')`
  — never mixed with the donation feature's `super-dj-donation-songs` temp dir, and never with
  `UPLOADS_DIR` (the permanent library).
- Preview sweep: 1 hour max age (`60 * 60 * 1000`), 10-minute interval — same interval as the
  existing donation sweep, shorter max age (an abandoned preview is a forgotten draft, not a track
  a stream might still play).
- Every new route requires authentication (`requireAuth`) and enforces per-user ownership on the
  preview registry the same way every other resource route in this app does: 404 if the previewId
  isn't registered (or its file has been swept), 403 if it belongs to another user.
- Follow the existing fake-collaborator testing style throughout (`Pick<...>` structural deps, fake
  repositories/clients, `supertest` against a router built from fakes) — no new mocking style.
- Every route this plan adds gets an `openapi.ts` entry, matching this repo's established
  convention (see `CLAUDE.md`'s "every route documented" pattern).

---

### Task 1: Move `mediaSearchClient.ts` to a shared location

**Files:**
- Create: `src/media/mediaSearchClient.ts`
- Delete: `src/donations/mediaSearchClient.ts`
- Create: `test/media/mediaSearchClient.test.ts`
- Delete: `test/donations/mediaSearchClient.test.ts`
- Modify: `src/donations/songRequestAction.ts` (import path only)
- Modify: `src/server.ts` (import path only)

**Interfaces:**
- Produces: `MediaSearchClient`, `MediaSearchError`, `HttpMediaSearchClient` — identical exports,
  identical behavior, new import path `../media/mediaSearchClient` (from `src/donations/`) or
  `./media/mediaSearchClient` (from `src/server.ts`).

This is a pure file move — no behavior change. Do it as its own task so every later task that
imports the client already has the final import path.

- [ ] **Step 1: Create the new file with the exact current content**

```typescript
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

Save it as `src/media/mediaSearchClient.ts`.

- [ ] **Step 2: Move the test file, updating only its import path**

Create `test/media/mediaSearchClient.test.ts` with this exact content:

```typescript
import { HttpMediaSearchClient, MediaSearchError } from '../../src/media/mediaSearchClient';

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

Delete `test/donations/mediaSearchClient.test.ts` and `src/donations/mediaSearchClient.ts`.

- [ ] **Step 3: Run both moved-file locations to confirm nothing references the old path**

Run: `npx jest test/media/mediaSearchClient.test.ts`
Expected: PASS, 3 tests.

Then search the repo for any remaining reference to the old path:

Run: `grep -rn "donations/mediaSearchClient" src test`
Expected: no output.

- [ ] **Step 4: Fix the two import sites**

In `src/donations/songRequestAction.ts`, change:
```typescript
import { MediaSearchClient } from './mediaSearchClient';
```
to:
```typescript
import { MediaSearchClient } from '../media/mediaSearchClient';
```

In `src/server.ts`, change:
```typescript
import { HttpMediaSearchClient } from './donations/mediaSearchClient';
```
to:
```typescript
import { HttpMediaSearchClient } from './media/mediaSearchClient';
```

- [ ] **Step 5: Full backend build + test run**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

Run: `npx jest`
Expected: all suites pass (same count as before this task, minus the one file that moved).

- [ ] **Step 6: Commit**

```bash
git add src/media/mediaSearchClient.ts test/media/mediaSearchClient.test.ts src/donations/songRequestAction.ts src/server.ts
git rm src/donations/mediaSearchClient.ts test/donations/mediaSearchClient.test.ts
git commit -m "refactor(media): move mediaSearchClient out of donations into a shared module"
```

---

### Task 2: `TrackPreviewRegistry`

**Files:**
- Create: `src/tracks/trackPreviewRegistry.ts`
- Test: `test/tracks/trackPreviewRegistry.test.ts`

**Interfaces:**
- Produces: `TrackPreviewEntry { userId: string; query: string; tempFilePath: string; createdAt: number }`,
  `TrackPreviewRegistry` with `register(previewId: string, entry: TrackPreviewEntry): void`,
  `get(previewId: string): TrackPreviewEntry | undefined`, `delete(previewId: string): void`.
- Consumes: nothing — pure in-memory data structure, no dependencies.

**Why `query` is stored here:** the eventual confirmed track needs a sensible default name if the
streamer clears the name field. `TrackUploadService.upload()`'s own fallback (basename of
`originalname`) is meaningless for a preview-sourced track — `originalname` there is a synthetic
`${previewId}.mp3`, not anything derived from what was actually searched for (see Task 3's
`confirm()`). Storing the original query text right here, at registration time, is the only place
that value naturally exists.

- [ ] **Step 1: Write the failing test**

```typescript
import { TrackPreviewRegistry } from '../../src/tracks/trackPreviewRegistry';

describe('TrackPreviewRegistry', () => {
  it('returns undefined for an id that was never registered', () => {
    const registry = new TrackPreviewRegistry();
    expect(registry.get('missing')).toBeUndefined();
  });

  it('returns exactly what was registered under an id', () => {
    const registry = new TrackPreviewRegistry();
    registry.register('p1', { userId: 'user-1', query: 'Blur - Song 2', tempFilePath: '/tmp/p1.mp3', createdAt: 1000 });
    expect(registry.get('p1')).toEqual({ userId: 'user-1', query: 'Blur - Song 2', tempFilePath: '/tmp/p1.mp3', createdAt: 1000 });
  });

  it('delete removes the entry', () => {
    const registry = new TrackPreviewRegistry();
    registry.register('p1', { userId: 'user-1', query: 'x', tempFilePath: '/tmp/p1.mp3', createdAt: 1000 });
    registry.delete('p1');
    expect(registry.get('p1')).toBeUndefined();
  });

  it('delete on a missing id is a harmless no-op', () => {
    const registry = new TrackPreviewRegistry();
    expect(() => registry.delete('missing')).not.toThrow();
  });

  it('keeps entries for different ids independent', () => {
    const registry = new TrackPreviewRegistry();
    registry.register('p1', { userId: 'user-1', query: 'x', tempFilePath: '/tmp/p1.mp3', createdAt: 1000 });
    registry.register('p2', { userId: 'user-2', query: 'y', tempFilePath: '/tmp/p2.mp3', createdAt: 2000 });
    expect(registry.get('p1')?.userId).toBe('user-1');
    expect(registry.get('p2')?.userId).toBe('user-2');
  });
});
```

Save as `test/tracks/trackPreviewRegistry.test.ts`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest test/tracks/trackPreviewRegistry.test.ts`
Expected: FAIL — `Cannot find module '../../src/tracks/trackPreviewRegistry'`.

- [ ] **Step 3: Implement**

```typescript
// In-memory previewId -> pending-preview mapping, same discipline as MediaMtxAuthRegistry
// (src/stream/mediaMtxAuth.ts): nothing persisted to the database, register/get/delete only.
// An unconfirmed preview is a forgotten draft, not state worth surviving a process restart.
export interface TrackPreviewEntry {
  userId: string;
  // The original search text — TrackPreviewService.confirm() defaults the track's name to this
  // when the streamer clears the name field, since the temp file's own "originalname" is a
  // synthetic ${previewId}.mp3, not anything meaningful to fall back to.
  query: string;
  tempFilePath: string;
  createdAt: number;
}

export class TrackPreviewRegistry {
  private readonly previews = new Map<string, TrackPreviewEntry>();

  register(previewId: string, entry: TrackPreviewEntry): void {
    this.previews.set(previewId, entry);
  }

  get(previewId: string): TrackPreviewEntry | undefined {
    return this.previews.get(previewId);
  }

  delete(previewId: string): void {
    this.previews.delete(previewId);
  }
}
```

Save as `src/tracks/trackPreviewRegistry.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest test/tracks/trackPreviewRegistry.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tracks/trackPreviewRegistry.ts test/tracks/trackPreviewRegistry.test.ts
git commit -m "feat(tracks): add TrackPreviewRegistry for in-flight track-search previews"
```

---

### Task 3: `TrackPreviewService`

**Files:**
- Create: `src/tracks/trackPreviewService.ts`
- Test: `test/tracks/trackPreviewService.test.ts`

**Interfaces:**
- Consumes: `MediaSearchClient` (Task 1, `../media/mediaSearchClient`), `TrackPreviewRegistry`
  (Task 2), `Pick<TrackUploadService, 'upload'>` (`./trackUploadService`, unmodified), `ApiError`
  (`../errors`).
- Produces: `TrackPreviewService` with:
  - `search(userId: string, query: string): Promise<{ previewId: string }>`
  - `getPreviewPath(userId: string, previewId: string): Promise<string>`
  - `confirm(userId: string, previewId: string, name: string | undefined, coverFile: UploadedFile | undefined): Promise<TrackSummary>`
  - `discard(userId: string, previewId: string): Promise<void>`

`TrackSummary`/`UploadedFile` are `trackUploadService.ts`'s own exported types — import them
rather than redeclaring.

- [ ] **Step 1: Write the failing tests**

```typescript
import * as fsPromises from 'fs/promises';
import { TrackPreviewService } from '../../src/tracks/trackPreviewService';
import { TrackPreviewRegistry } from '../../src/tracks/trackPreviewRegistry';
import { MediaSearchError } from '../../src/media/mediaSearchClient';
import { ApiError } from '../../src/errors';

jest.mock('fs/promises', () => {
  const actual = jest.requireActual('fs/promises');
  return { ...actual, mkdir: jest.fn(actual.mkdir), writeFile: jest.fn(actual.writeFile), access: jest.fn(actual.access), unlink: jest.fn(actual.unlink) };
});

function buildDeps() {
  const mediaSearchClient = { fetchAudio: jest.fn() };
  const registry = new TrackPreviewRegistry();
  const trackUploadService = { upload: jest.fn() };
  const generateId = jest.fn().mockReturnValue('preview-1');
  return { mediaSearchClient, registry, trackUploadService, generateId };
}

describe('TrackPreviewService', () => {
  const previewTempDir = '/tmp/super-dj-track-previews-test';

  beforeEach(() => jest.clearAllMocks());

  describe('search', () => {
    it('fetches audio, writes it to the temp dir, and registers it under a fresh id', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      (fsPromises.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fsPromises.writeFile as jest.Mock).mockResolvedValue(undefined);
      mediaSearchClient.fetchAudio.mockResolvedValue(Buffer.from([1, 2, 3]));
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      const result = await service.search('user-1', 'Blur - Song 2');

      expect(result).toEqual({ previewId: 'preview-1' });
      expect(mediaSearchClient.fetchAudio).toHaveBeenCalledWith('Blur - Song 2');
      expect(fsPromises.writeFile).toHaveBeenCalledWith(`${previewTempDir}/preview-1.mp3`, Buffer.from([1, 2, 3]));
      const entry = registry.get('preview-1');
      expect(entry?.userId).toBe('user-1');
      expect(entry?.query).toBe('Blur - Song 2');
      expect(entry?.tempFilePath).toBe(`${previewTempDir}/preview-1.mp3`);
    });

    it('lets a MediaSearchError propagate as-is (the route layer maps it to an HTTP status)', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      mediaSearchClient.fetchAudio.mockRejectedValue(new MediaSearchError('media search service returned 502: not found'));
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      await expect(service.search('user-1', 'nonexistent')).rejects.toThrow(MediaSearchError);
    });
  });

  describe('getPreviewPath', () => {
    it('returns the temp path for an owned, still-existing preview', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      registry.register('preview-1', { userId: 'user-1', query: 'My Song', tempFilePath: '/tmp/x/preview-1.mp3', createdAt: Date.now() });
      (fsPromises.access as jest.Mock).mockResolvedValue(undefined);
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      await expect(service.getPreviewPath('user-1', 'preview-1')).resolves.toBe('/tmp/x/preview-1.mp3');
    });

    it('throws 404 for an id that was never registered', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      await expect(service.getPreviewPath('user-1', 'missing')).rejects.toMatchObject({ status: 404 });
    });

    it('throws 403 for a preview owned by someone else', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      registry.register('preview-1', { userId: 'someone-else', query: 'x', tempFilePath: '/tmp/x/preview-1.mp3', createdAt: Date.now() });
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      await expect(service.getPreviewPath('user-1', 'preview-1')).rejects.toMatchObject({ status: 403 });
    });

    it('throws 404 and clears the stale entry when the temp file was already swept', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      registry.register('preview-1', { userId: 'user-1', query: 'My Song', tempFilePath: '/tmp/x/preview-1.mp3', createdAt: Date.now() });
      (fsPromises.access as jest.Mock).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      await expect(service.getPreviewPath('user-1', 'preview-1')).rejects.toMatchObject({ status: 404 });
      expect(registry.get('preview-1')).toBeUndefined();
    });
  });

  describe('confirm', () => {
    it('wraps the temp file as an UploadedFile and delegates to trackUploadService.upload, then clears the registry entry', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      registry.register('preview-1', { userId: 'user-1', query: 'My Song', tempFilePath: '/tmp/x/preview-1.mp3', createdAt: Date.now() });
      (fsPromises.access as jest.Mock).mockResolvedValue(undefined);
      const statSpy = jest.spyOn(fsPromises, 'stat').mockResolvedValue({ size: 4242 } as never);
      trackUploadService.upload.mockResolvedValue({ id: 't1', name: 'My Song', durationSeconds: 10, hasCover: false });
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      const result = await service.confirm('user-1', 'preview-1', 'My Song', undefined);

      expect(trackUploadService.upload).toHaveBeenCalledWith(
        'user-1', 'My Song',
        { originalname: 'preview-1.mp3', path: '/tmp/x/preview-1.mp3', size: 4242 },
        undefined,
      );
      expect(result).toEqual({ id: 't1', name: 'My Song', durationSeconds: 10, hasCover: false });
      expect(registry.get('preview-1')).toBeUndefined();
      statSpy.mockRestore();
    });

    it('passes the cover file through untouched when one is given', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      registry.register('preview-1', { userId: 'user-1', query: 'My Song', tempFilePath: '/tmp/x/preview-1.mp3', createdAt: Date.now() });
      (fsPromises.access as jest.Mock).mockResolvedValue(undefined);
      const statSpy = jest.spyOn(fsPromises, 'stat').mockResolvedValue({ size: 10 } as never);
      trackUploadService.upload.mockResolvedValue({ id: 't1', name: 'x', durationSeconds: 1, hasCover: true });
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });
      const cover = { originalname: 'cover.png', path: '/tmp/cover', size: 100 };

      await service.confirm('user-1', 'preview-1', 'a chosen name', cover);

      expect(trackUploadService.upload).toHaveBeenCalledWith('user-1', 'a chosen name', expect.anything(), cover);
      statSpy.mockRestore();
    });

    // Regression test for the real bug this exact case produced during design review: the temp
    // file's own "originalname" is a synthetic `${previewId}.mp3`, never anything derived from
    // what was actually searched for — falling through to TrackUploadService.upload()'s OWN
    // filename-based default would have named the track after a random UUID instead of the song
    // the streamer actually searched for and listened to.
    it('defaults the name to the original search query when name is omitted (not to the synthetic temp filename)', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      registry.register('preview-1', { userId: 'user-1', query: 'Blur - Song 2', tempFilePath: '/tmp/x/preview-1.mp3', createdAt: Date.now() });
      (fsPromises.access as jest.Mock).mockResolvedValue(undefined);
      const statSpy = jest.spyOn(fsPromises, 'stat').mockResolvedValue({ size: 10 } as never);
      trackUploadService.upload.mockResolvedValue({ id: 't1', name: 'Blur - Song 2', durationSeconds: 1, hasCover: false });
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      await service.confirm('user-1', 'preview-1', undefined, undefined);

      expect(trackUploadService.upload).toHaveBeenCalledWith('user-1', 'Blur - Song 2', expect.anything(), undefined);
      statSpy.mockRestore();
    });

    it('also defaults the name when an empty string is given (a streamer who clears the field, not just omits it)', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      registry.register('preview-1', { userId: 'user-1', query: 'Blur - Song 2', tempFilePath: '/tmp/x/preview-1.mp3', createdAt: Date.now() });
      (fsPromises.access as jest.Mock).mockResolvedValue(undefined);
      const statSpy = jest.spyOn(fsPromises, 'stat').mockResolvedValue({ size: 10 } as never);
      trackUploadService.upload.mockResolvedValue({ id: 't1', name: 'Blur - Song 2', durationSeconds: 1, hasCover: false });
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      await service.confirm('user-1', 'preview-1', '', undefined);

      expect(trackUploadService.upload).toHaveBeenCalledWith('user-1', 'Blur - Song 2', expect.anything(), undefined);
      statSpy.mockRestore();
    });

    it('404s for a preview owned by someone else, without calling upload', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      registry.register('preview-1', { userId: 'someone-else', query: 'x', tempFilePath: '/tmp/x/preview-1.mp3', createdAt: Date.now() });
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      await expect(service.confirm('user-1', 'preview-1', undefined, undefined)).rejects.toMatchObject({ status: 403 });
      expect(trackUploadService.upload).not.toHaveBeenCalled();
    });
  });

  describe('discard', () => {
    it('removes the registry entry and unlinks the temp file', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      registry.register('preview-1', { userId: 'user-1', query: 'My Song', tempFilePath: '/tmp/x/preview-1.mp3', createdAt: Date.now() });
      (fsPromises.unlink as jest.Mock).mockResolvedValue(undefined);
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      await service.discard('user-1', 'preview-1');

      expect(registry.get('preview-1')).toBeUndefined();
      expect(fsPromises.unlink).toHaveBeenCalledWith('/tmp/x/preview-1.mp3');
    });

    it('swallows ENOENT if the file was already gone', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      registry.register('preview-1', { userId: 'user-1', query: 'My Song', tempFilePath: '/tmp/x/preview-1.mp3', createdAt: Date.now() });
      (fsPromises.unlink as jest.Mock).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      await expect(service.discard('user-1', 'preview-1')).resolves.toBeUndefined();
    });

    it('404s for a missing preview', async () => {
      const { mediaSearchClient, registry, trackUploadService, generateId } = buildDeps();
      const service = new TrackPreviewService({ mediaSearchClient, registry, trackUploadService, previewTempDir, generateId });

      await expect(service.discard('user-1', 'missing')).rejects.toMatchObject({ status: 404 });
    });
  });
});
```

Save as `test/tracks/trackPreviewService.test.ts`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest test/tracks/trackPreviewService.test.ts`
Expected: FAIL — `Cannot find module '../../src/tracks/trackPreviewService'`.

- [ ] **Step 3: Implement**

```typescript
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { MediaSearchClient } from '../media/mediaSearchClient';
import { TrackPreviewRegistry } from './trackPreviewRegistry';
import { TrackUploadService, UploadedFile, TrackSummary } from './trackUploadService';
import { ApiError } from '../errors';

export interface TrackPreviewServiceDeps {
  mediaSearchClient: MediaSearchClient;
  registry: Pick<TrackPreviewRegistry, 'register' | 'get' | 'delete'>;
  trackUploadService: Pick<TrackUploadService, 'upload'>;
  previewTempDir: string;
  generateId?: () => string;
}

// Orchestrates the preview-before-save flow: search() fetches and holds a temp file the streamer
// can listen to; confirm() hands that SAME file to TrackUploadService.upload() unchanged (no
// second fetch — deterministic, and doesn't spend the external service's quota twice for one
// track); discard()/the age-based sweep (see tempFileCleanup.ts, started a second time for
// previewTempDir in server.ts) are the two ways an unconfirmed preview's temp file ever goes away.
export class TrackPreviewService {
  private readonly generateId: () => string;

  constructor(private readonly deps: TrackPreviewServiceDeps) {
    this.generateId = deps.generateId ?? randomUUID;
  }

  async search(userId: string, query: string): Promise<{ previewId: string }> {
    const audioBuffer = await this.deps.mediaSearchClient.fetchAudio(query);
    const previewId = this.generateId();
    const tempFilePath = path.join(this.deps.previewTempDir, `${previewId}.mp3`);

    await fs.mkdir(this.deps.previewTempDir, { recursive: true });
    await fs.writeFile(tempFilePath, audioBuffer);

    this.deps.registry.register(previewId, { userId, query, tempFilePath, createdAt: Date.now() });
    return { previewId };
  }

  async getPreviewPath(userId: string, previewId: string): Promise<string> {
    const entry = this.deps.registry.get(previewId);
    if (!entry) throw new ApiError(404, 'preview not found or expired');
    if (entry.userId !== userId) throw new ApiError(403, 'not your preview');

    try {
      await fs.access(entry.tempFilePath);
    } catch {
      // The sweep already reaped this file — drop the now-dangling registry entry too, so a
      // second request for the same id fails fast with 404 instead of re-discovering the same
      // ENOENT on every subsequent attempt.
      this.deps.registry.delete(previewId);
      throw new ApiError(404, 'preview not found or expired');
    }
    return entry.tempFilePath;
  }

  async confirm(
    userId: string,
    previewId: string,
    name: string | undefined,
    coverFile: UploadedFile | undefined,
  ): Promise<TrackSummary> {
    const tempFilePath = await this.getPreviewPath(userId, previewId);
    // getPreviewPath just ownership-checked and confirmed this entry exists — safe to read again
    // directly for its query, without repeating those checks.
    const entry = this.deps.registry.get(previewId)!;
    const stat = await fs.stat(tempFilePath);
    const audioFile: UploadedFile = { originalname: `${previewId}.mp3`, path: tempFilePath, size: stat.size };
    // Never pass an empty/undefined name through to TrackUploadService.upload() — its OWN
    // filename-based fallback would name the track after `audioFile.originalname` above, which is
    // a synthetic ${previewId}.mp3, not anything derived from what the streamer actually searched
    // for and listened to. Defaulting here, to the original query, is what makes an emptied name
    // field produce a sensible track name instead of a random UUID.
    const trackName = name && name.trim().length > 0 ? name : entry.query;

    const summary = await this.deps.trackUploadService.upload(userId, trackName, audioFile, coverFile);
    this.deps.registry.delete(previewId);
    return summary;
  }

  async discard(userId: string, previewId: string): Promise<void> {
    const entry = this.deps.registry.get(previewId);
    if (!entry) throw new ApiError(404, 'preview not found or expired');
    if (entry.userId !== userId) throw new ApiError(403, 'not your preview');

    this.deps.registry.delete(previewId);
    await fs.unlink(entry.tempFilePath).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`failed to delete discarded preview temp file ${entry.tempFilePath}`, err);
      }
    });
  }
}
```

Save as `src/tracks/trackPreviewService.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest test/tracks/trackPreviewService.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Full backend build + test run**

Run: `npx tsc -p tsconfig.json --noEmit && npx jest`
Expected: no type errors, all suites pass.

- [ ] **Step 6: Commit**

```bash
git add src/tracks/trackPreviewService.ts test/tracks/trackPreviewService.test.ts
git commit -m "feat(tracks): add TrackPreviewService orchestrating search-preview-confirm"
```

---

### Task 4: New routes on `trackRoutes.ts`

**Files:**
- Modify: `src/tracks/trackRoutes.ts`
- Modify: `test/tracks/trackRoutes.test.ts`

**Interfaces:**
- Consumes: `TrackPreviewService` (Task 3) — `createTrackRouter`'s signature gains a 4th
  parameter, `trackPreviewService: TrackPreviewService`.
- Produces: `POST /tracks/search-preview`, `GET /tracks/preview/:previewId`,
  `POST /tracks/from-preview/:previewId`, `DELETE /tracks/preview/:previewId`, all mounted under
  the existing `/tracks` router.

**IMPORTANT — route ordering:** Express matches routes in declaration order. `GET /tracks/preview/
:previewId` and `POST /tracks/from-preview/:previewId` use different path prefixes than the
existing `GET /tracks/:id/cover` and `PATCH /tracks/:id`, so there is no overlap to worry about —
but add the new routes as a clearly separated block so this stays true if either path shape ever
changes.

- [ ] **Step 1: Write the failing tests**

Add this import to the top of `test/tracks/trackRoutes.test.ts`, alongside its existing imports:

```typescript
import { MediaSearchError } from '../../src/media/mediaSearchClient';
```

Then add this block, adjusting `buildApp` first:

```typescript
function buildApp(overrides: { getCurrentUser?: any; uploadService?: any; trackRepository?: any; trackPreviewService?: any } = {}) {
  const authService: any = {
    getCurrentUser: overrides.getCurrentUser ?? jest.fn().mockResolvedValue({ id: 'user-1', email: 'a@example.com' }),
  };
  const uploadService: any = overrides.uploadService ?? { upload: jest.fn() };
  const trackRepository: any = overrides.trackRepository ?? { listByUser: jest.fn(), findById: jest.fn(), deleteById: jest.fn() };
  const trackPreviewService: any = overrides.trackPreviewService ?? { search: jest.fn(), getPreviewPath: jest.fn(), confirm: jest.fn(), discard: jest.fn() };
  const app = express();
  app.use(express.json());
  app.use('/tracks', createTrackRouter(authService, uploadService, trackRepository, trackPreviewService));
  app.use(errorHandler);
  return { app, uploadService, trackRepository, trackPreviewService };
}
```

(This changes the existing `buildApp` helper's signature — every existing call site that only
passes `{ getCurrentUser, uploadService, trackRepository }` keeps working unchanged, since
`trackPreviewService` falls back to a default fake.)

Then add:

```typescript
describe('POST /tracks/search-preview', () => {
  it('400s when query is missing or not a string', async () => {
    const { app, trackPreviewService } = buildApp();
    const res = await request(app).post('/tracks/search-preview').send({});
    expect(res.status).toBe(400);
    expect(trackPreviewService.search).not.toHaveBeenCalled();
  });

  it('400s when query is an empty string', async () => {
    const { app, trackPreviewService } = buildApp();
    const res = await request(app).post('/tracks/search-preview').send({ query: '   ' });
    expect(res.status).toBe(400);
    expect(trackPreviewService.search).not.toHaveBeenCalled();
  });

  it('200s with the previewId on success', async () => {
    const trackPreviewService: any = { search: jest.fn().mockResolvedValue({ previewId: 'p1' }) };
    const { app } = buildApp({ trackPreviewService });
    const res = await request(app).post('/tracks/search-preview').send({ query: 'Blur - Song 2' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ previewId: 'p1' });
    expect(trackPreviewService.search).toHaveBeenCalledWith('user-1', 'Blur - Song 2');
  });

  it('maps a MediaSearchError from the service to 502 with its message', async () => {
    const trackPreviewService: any = { search: jest.fn().mockRejectedValue(new MediaSearchError('media search service returned 502: not found')) };
    const { app } = buildApp({ trackPreviewService });
    const res = await request(app).post('/tracks/search-preview').send({ query: 'nonexistent' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('media search service returned 502: not found');
  });
});

describe('GET /tracks/preview/:previewId', () => {
  it('streams the preview file for its owner', async () => {
    const trackPreviewService: any = { getPreviewPath: jest.fn().mockResolvedValue(__filename) };
    const { app } = buildApp({ trackPreviewService });
    const res = await request(app).get('/tracks/preview/p1');
    expect(res.status).toBe(200);
    expect(trackPreviewService.getPreviewPath).toHaveBeenCalledWith('user-1', 'p1');
  });

  it('404s when the service throws 404', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/tracks/preview/missing');
    expect(res.status).toBe(404);
  });
});

describe('POST /tracks/from-preview/:previewId', () => {
  it('confirms the preview and returns the resulting track summary', async () => {
    const trackPreviewService: any = { confirm: jest.fn().mockResolvedValue({ id: 't1', name: 'My Song', durationSeconds: 10, hasCover: false }) };
    const { app } = buildApp({ trackPreviewService });
    const res = await request(app).post('/tracks/from-preview/p1').field('name', 'My Song');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 't1', name: 'My Song', durationSeconds: 10, hasCover: false });
    expect(trackPreviewService.confirm).toHaveBeenCalledWith('user-1', 'p1', 'My Song', undefined);
  });

  it('passes an attached cover file through', async () => {
    const trackPreviewService: any = { confirm: jest.fn().mockResolvedValue({ id: 't1', name: 'x', durationSeconds: 1, hasCover: true }) };
    const { app } = buildApp({ trackPreviewService });
    await request(app).post('/tracks/from-preview/p1').attach('cover', Buffer.from('fake-png'), 'cover.png');
    expect(trackPreviewService.confirm).toHaveBeenCalledWith('user-1', 'p1', undefined, expect.objectContaining({ originalname: 'cover.png' }));
  });

  it('rejects an unsupported cover format', async () => {
    const { app, trackPreviewService } = buildApp();
    const res = await request(app).post('/tracks/from-preview/p1').attach('cover', Buffer.from('data'), 'cover.gif');
    expect(res.status).toBe(400);
    expect(trackPreviewService.confirm).not.toHaveBeenCalled();
  });

  it('404s when the service throws 404', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/tracks/from-preview/missing');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /tracks/preview/:previewId', () => {
  it('discards an owned preview', async () => {
    const trackPreviewService: any = { discard: jest.fn().mockResolvedValue(undefined) };
    const { app } = buildApp({ trackPreviewService });
    const res = await request(app).delete('/tracks/preview/p1');
    expect(res.status).toBe(200);
    expect(trackPreviewService.discard).toHaveBeenCalledWith('user-1', 'p1');
  });

  it('404s when the service throws 404', async () => {
    const { app } = buildApp();
    const res = await request(app).delete('/tracks/preview/missing');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest test/tracks/trackRoutes.test.ts`
Expected: FAIL — `createTrackRouter` called with 4 args where it only accepts 3 (a TS error under
`ts-jest`), or the new routes 404 if TS somehow lets it through. Either way, red.

- [ ] **Step 3: Implement**

In `src/tracks/trackRoutes.ts`, add the import and extend the function signature and body:

```typescript
import { TrackPreviewService } from './trackPreviewService';
import { MediaSearchError } from '../media/mediaSearchClient';
```

Change the function signature:

```typescript
export function createTrackRouter(
  authService: AuthService,
  uploadService: TrackUploadService,
  trackRepository: TrackRepository,
  trackPreviewService: TrackPreviewService,
): Router {
```

Add the four new route handlers — place them right after the existing `POST /` handler (before
`GET /`):

```typescript
  router.post('/search-preview', auth, wrapAsync(async (req, res) => {
    const query = req.body?.query;
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new ApiError(400, 'body.query must be a non-empty string');
    }
    const userId = (req as AuthenticatedRequest).user!.id;
    try {
      const result = await trackPreviewService.search(userId, query);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof MediaSearchError) throw new ApiError(502, err.message);
      throw err;
    }
  }));

  router.get('/preview/:previewId', auth, wrapAsync(async (req, res) => {
    const userId = (req as AuthenticatedRequest).user!.id;
    const filePath = await trackPreviewService.getPreviewPath(userId, req.params.previewId);
    res.set('Cache-Control', 'no-store');
    res.sendFile(filePath);
  }));

  router.post('/from-preview/:previewId', auth, upload.fields([{ name: 'cover', maxCount: 1 }]), wrapAsync(async (req, res) => {
    const files = req.files as { cover?: Express.Multer.File[] } | undefined;
    const coverFile = files?.cover?.[0];
    if (coverFile) {
      coverFile.originalname = fixMulterFilenameEncoding(coverFile.originalname);
      if (!COVER_EXTENSIONS.includes(path.extname(coverFile.originalname).toLowerCase())) {
        throw new ApiError(400, 'unsupported cover format');
      }
      if (coverFile.size > MAX_COVER_BYTES) throw new ApiError(400, 'cover file too large');
    }
    const name = typeof req.body?.name === 'string' && req.body.name.length > 0 ? req.body.name : undefined;
    const userId = (req as AuthenticatedRequest).user!.id;
    const summary = await trackPreviewService.confirm(userId, req.params.previewId, name, coverFile);
    res.status(200).json(summary);
  }));

  router.delete('/preview/:previewId', auth, wrapAsync(async (req, res) => {
    const userId = (req as AuthenticatedRequest).user!.id;
    await trackPreviewService.discard(userId, req.params.previewId);
    res.status(200).json({});
  }));
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest test/tracks/trackRoutes.test.ts`
Expected: PASS, all tests (existing + new).

- [ ] **Step 5: Full backend build + test run**

Run: `npx tsc -p tsconfig.json --noEmit && npx jest`
Expected: this will currently FAIL to type-check at the `app.ts`/`server.ts` call site of
`createTrackRouter`, since it's still called with 3 arguments — that's expected and fixed in
Task 5. Confirm the ONLY failure is that call site, nothing else.

- [ ] **Step 6: Commit**

```bash
git add src/tracks/trackRoutes.ts test/tracks/trackRoutes.test.ts
git commit -m "feat(tracks): add search-preview/preview/from-preview/discard routes"
```

---

### Task 5: Wire `TrackPreviewService` into `app.ts` and `server.ts`

**Files:**
- Modify: `src/api/app.ts`
- Modify: `src/server.ts`
- Modify: `test/server.test.ts` (its hand-built `AppConfig`/deps fixtures may need the same
  treatment the donation feature's env vars needed — check before assuming no change is required)

**Interfaces:**
- Consumes: `TrackPreviewService` (Task 3), `TrackPreviewRegistry` (Task 2),
  `HttpMediaSearchClient` (Task 1, already constructed in `server.ts` for the donations feature —
  **reuse that same instance**, don't construct a second one), `startTempFileCleanupSweep`
  (`./donations/tempFileCleanup` — already generic, reused as-is).
- Produces: `AppDeps.trackPreviewService: TrackPreviewService`; a second running sweep interval in
  `server.ts`'s returned `tempFileCleanupSweep`-shaped value (see Step 3 — this needs its OWN
  handle stopped on shutdown, same as the donation sweep already is).

- [ ] **Step 1: Add `trackPreviewService` to `AppDeps` and wire the route in `app.ts`**

In `src/api/app.ts`, add the import:

```typescript
import { TrackPreviewService } from '../tracks/trackPreviewService';
```

Add to the `AppDeps` interface (next to `trackUploadService`):

```typescript
  trackPreviewService: TrackPreviewService;
```

Change the mount line:

```typescript
  app.use('/tracks', createTrackRouter(deps.authService, deps.trackUploadService, deps.trackRepository, deps.trackPreviewService));
```

- [ ] **Step 2: Construct it in `server.ts`**

Add the imports:

```typescript
import { TrackPreviewRegistry } from './tracks/trackPreviewRegistry';
import { TrackPreviewService } from './tracks/trackPreviewService';
```

Right after the existing `mediaSearchClient` construction (the one built for the donations
feature), add:

```typescript
  const trackPreviewRegistry = new TrackPreviewRegistry();
  const previewTempDir = path.join(os.tmpdir(), 'super-dj-track-previews');
  const trackPreviewService = new TrackPreviewService({
    mediaSearchClient, registry: trackPreviewRegistry, trackUploadService, previewTempDir,
  });
  // Much shorter-lived than the donation sweep (12h) — an unconfirmed preview is a forgotten
  // draft the moment the streamer navigates away, not a track a stream might still be about to
  // play, so there's no reason to hold onto it for hours.
  const previewCleanupSweep = startTempFileCleanupSweep(previewTempDir, 60 * 60 * 1000, 10 * 60 * 1000);
```

Note: `trackUploadService` is already constructed earlier in this file (for the existing upload
route) — this reuses that same instance, it is not reconstructed.

Pass `trackPreviewService` into the `createApp(...)` call's object literal (alongside
`trackRepository`, `trackUploadService`):

```typescript
    trackPreviewService,
```

- [ ] **Step 3: Return the new sweep handle and stop it on shutdown**

`buildServer`'s return statement currently returns `{ app, prisma, mediaMtxAuthApp,
mediaMtxAuthPort, tempFileCleanupSweep }`. Add the new sweep:

```typescript
  return { app, prisma, mediaMtxAuthApp, mediaMtxAuthPort, tempFileCleanupSweep, previewCleanupSweep };
```

In `src/main.ts`, line 6 destructures `buildServer(config)`'s return value — add the new field:

```typescript
  const { app, prisma, mediaMtxAuthApp, mediaMtxAuthPort, tempFileCleanupSweep, previewCleanupSweep } = buildServer(config);
```

Inside the `shutdown` function (around line 24, right after `tempFileCleanupSweep.stop();` and
before the `try { await prisma.$disconnect(); }` block), add:

```typescript
    previewCleanupSweep.stop();
```

This runs on both `SIGTERM` and `SIGINT` (lines 34-35 already wire `shutdown()` to both), same as
the existing sweep.

- [ ] **Step 4: Check `test/server.test.ts` and `test/config/env.test.ts` for hand-built fixtures**

This plan does NOT add any new required environment variable (the media-search service URL is
already required for the donations feature and is reused as-is) — so `AppConfig`/`loadConfig`
fixtures should need no change. Confirm this by running the full suite in Step 5; if
`test/server.test.ts`'s `buildServer(config, fakeSpawner())` call now fails for an unrelated
reason, investigate before proceeding rather than assuming it's this task's fault.

- [ ] **Step 5: Full backend build + test run**

Run: `npx tsc -p tsconfig.json --noEmit && npx jest`
Expected: no type errors, all suites pass — including `test/tracks/trackRoutes.test.ts` from
Task 4, which could not fully verify itself until this wiring existed.

- [ ] **Step 6: Commit**

```bash
git add src/api/app.ts src/server.ts src/main.ts
git commit -m "feat(tracks): wire TrackPreviewService into the app and start its cleanup sweep"
```

---

### Task 6: `openapi.ts` entries for the four new routes

**Files:**
- Modify: `src/api/openapi.ts`

**Interfaces:** none — documentation only, matches this repo's "every route gets an openapi.ts
entry" convention (see e.g. the `/interaction-rules/{id}/test` entry added alongside that feature).

- [ ] **Step 1: Add the path entries**

Find the `'/tracks'` path block in `src/api/openapi.ts` (it ends right before the existing
`'/tracks/{id}'` block) and insert these three new path entries between them:

```typescript
    '/tracks/search-preview': {
      post: {
        summary: 'Fetch a candidate track from the streamer\'s own external media-search service into a temporary preview, without saving it to the library yet',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } } },
        },
        responses: {
          '200': { description: 'Preview created', content: { 'application/json': { schema: { type: 'object', properties: { previewId: { type: 'string' } } } } } },
          '400': { description: 'Missing/empty query' },
          '401': { description: 'Not authenticated' },
          '502': { description: 'The external media-search service failed or returned nothing usable' },
        },
      },
    },
    '/tracks/preview/{previewId}': {
      get: {
        summary: 'Stream a pending preview\'s audio (for an in-browser <audio> player) — never cached, since the same id can be discarded and reused for a different query',
        parameters: [{ name: 'previewId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'audio/mpeg' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your preview' },
          '404': { description: 'Preview not found, or its temp file has already been swept' },
        },
      },
      delete: {
        summary: 'Discard a pending preview and delete its temp file — no-op equivalent if it was about to be swept anyway',
        parameters: [{ name: 'previewId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Discarded' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your preview' },
          '404': { description: 'Preview not found, or already expired' },
        },
      },
    },
    '/tracks/from-preview/{previewId}': {
      post: {
        summary: 'Confirm a pending preview into a real, permanent library track — same pipeline POST /tracks uses, just starting from an already-fetched temp file instead of an upload',
        parameters: [{ name: 'previewId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: false,
          content: { 'multipart/form-data': { schema: { type: 'object', properties: { name: { type: 'string' }, cover: { type: 'string', format: 'binary' } } } } },
        },
        responses: {
          '200': { description: 'Track created', content: { 'application/json': { schema: { $ref: '#/components/schemas/TrackSummary' } } } },
          '400': { description: 'Unsupported or oversized cover file' },
          '401': { description: 'Not authenticated' },
          '403': { description: 'Not your preview' },
          '404': { description: 'Preview not found, or already expired' },
        },
      },
    },
```

(`TrackSummary` is the same existing schema `POST /tracks` and `GET /tracks` already reference —
confirmed present in `components.schemas`.)

- [ ] **Step 2: Verify the spec still parses and the regression test passes**

Run: `npx jest test/api/openapi.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/api/openapi.ts
git commit -m "docs(openapi): document the track-preview routes"
```

---

### Task 7: Frontend API client (`frontend/src/api/tracks.ts`)

**Files:**
- Modify: `frontend/src/api/tracks.ts`
- Modify: `frontend/src/api/tracks.test.ts`

**Interfaces:**
- Produces: `tracksApi.searchPreview(query: string): Promise<{ previewId: string }>`,
  `tracksApi.previewUrl(previewId: string): string`,
  `tracksApi.confirmPreview(previewId: string, name: string | undefined, cover: File | null): Promise<Track>`,
  `tracksApi.discardPreview(previewId: string): Promise<Record<string, never>>`.

- [ ] **Step 1: Write the failing tests**

`frontend/src/api/tracks.test.ts` does NOT mock `../api/client` — it stubs the global `fetch` and
asserts on the actual request URL/`init` (see its existing `mockFetchOnce` helper and every
existing `it(...)` block). Match that exact style — do not introduce a `vi.mock('../api/client')`
pattern this file doesn't use. Add these `describe` blocks inside the existing top-level
`describe('tracks API', ...)`:

```typescript
  describe('tracksApi.searchPreview', () => {
    it('POSTs the query to /tracks/search-preview and returns the previewId', async () => {
      mockFetchOnce({ previewId: 'p1' });
      const result = await tracksApi.searchPreview('Blur - Song 2');
      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain('/tracks/search-preview');
      expect(JSON.parse(init.body)).toEqual({ query: 'Blur - Song 2' });
      expect(result).toEqual({ previewId: 'p1' });
    });
  });

  describe('tracksApi.previewUrl', () => {
    it('builds the preview streaming URL', () => {
      expect(tracksApi.previewUrl('p1')).toContain('/tracks/preview/p1');
    });
  });

  describe('tracksApi.confirmPreview', () => {
    it('POSTs a multipart form with name and cover to /tracks/from-preview/{id}', async () => {
      mockFetchOnce({ id: 't1', name: 'x', durationSeconds: 1, hasCover: true, overlayOverride: null });
      const cover = new File(['data'], 'cover.png', { type: 'image/png' });
      await tracksApi.confirmPreview('p1', 'My Song', cover);
      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain('/tracks/from-preview/p1');
      expect(init.body).toBeInstanceOf(FormData);
      const form = init.body as FormData;
      expect(form.get('name')).toBe('My Song');
      expect(form.get('cover')).toBe(cover);
    });

    it('omits name/cover from the form when not given', async () => {
      mockFetchOnce({ id: 't1', name: 'x', durationSeconds: 1, hasCover: false, overlayOverride: null });
      await tracksApi.confirmPreview('p1', undefined, null);
      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const form = init.body as FormData;
      expect(form.has('name')).toBe(false);
      expect(form.has('cover')).toBe(false);
    });
  });

  describe('tracksApi.discardPreview', () => {
    it('DELETEs /tracks/preview/{id}', async () => {
      mockFetchOnce({});
      await tracksApi.discardPreview('p1');
      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain('/tracks/preview/p1');
      expect(init.method).toBe('DELETE');
    });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/api/tracks.test.ts`
Expected: FAIL — `tracksApi.searchPreview is not a function` (and similarly for the others).

- [ ] **Step 3: Implement**

In `frontend/src/api/tracks.ts`, add the new methods to the `tracksApi` object (keep every
existing method unchanged):

```typescript
  searchPreview: (query: string) => api.post<{ previewId: string }>('/tracks/search-preview', { query }),
  previewUrl: (previewId: string) => `${API_BASE_URL}/tracks/preview/${previewId}`,
  confirmPreview: (previewId: string, name: string | undefined, cover: File | null) => {
    const form = new FormData();
    if (name) form.append('name', name);
    if (cover) form.append('cover', cover);
    return api.postForm<Track>(`/tracks/from-preview/${previewId}`, form);
  },
  discardPreview: (previewId: string) => api.delete<Record<string, never>>(`/tracks/preview/${previewId}`),
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run src/api/tracks.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/tracks.ts frontend/src/api/tracks.test.ts
git commit -m "feat(frontend): add tracksApi methods for the search-preview flow"
```

---

### Task 8: Rewrite `AddTrackDrawer.tsx` with an upload/service tab switcher

**Files:**
- Modify: `frontend/src/components/AddTrackDrawer.tsx`
- Modify: `frontend/src/components/AddTrackDrawer.test.tsx`

**Interfaces:**
- Produces: `AddTrackDrawerProps` changes from `{ open, onOpenChange, onUploaded: () => void }` to
  `{ open, onOpenChange, onAdded: (track: Track) => void }` — **breaking rename**, fixed at both
  call sites in Tasks 9 and 10.
- Consumes: `tracksApi.searchPreview/previewUrl/confirmPreview/discardPreview` (Task 7).

This is the biggest single-file change in the plan — read the CURRENT `AddTrackDrawer.tsx` and
`AddTrackDrawer.test.tsx` in full before starting, since the existing upload-tab behavior (the
`submitForm()` jsdom workaround in the test file, the `required` file input, the exact error
message keys) must be preserved byte-for-byte inside the new "Upload" tab — only the callback name
and the addition of a second tab are new.

- [ ] **Step 1: Write the failing tests**

Replace `frontend/src/components/AddTrackDrawer.test.tsx` with this content — it keeps every
existing upload-flow test (renamed `onUploaded` → `onAdded`) and adds the new service-tab tests:

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddTrackDrawer } from './AddTrackDrawer';
import { tracksApi } from '../api/tracks';
import { ApiError } from '../api/client';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../api/tracks');

function submitUploadForm() {
  fireEvent.submit(screen.getByText('Upload').closest('form')!);
}

describe('AddTrackDrawer — upload tab', () => {
  const onOpenChange = vi.fn();
  const onAdded = vi.fn();

  beforeEach(() => vi.clearAllMocks());

  it('uploads the chosen audio file and closes the drawer on success', async () => {
    vi.mocked(tracksApi.upload).mockResolvedValue({ id: 't1', name: 'song', durationSeconds: 5, hasCover: false, overlayOverride: null });
    renderWithProviders(<AddTrackDrawer open onOpenChange={onOpenChange} onAdded={onAdded} />);

    const file = new File(['fake-mp3-bytes'], 'song.mp3', { type: 'audio/mpeg' });
    const audioInput = screen.getByLabelText('Audio file') as HTMLInputElement;
    await userEvent.upload(audioInput, file);
    submitUploadForm();

    await waitFor(() => expect(tracksApi.upload).toHaveBeenCalledWith(file, null, undefined));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith({ id: 't1', name: 'song', durationSeconds: 5, hasCover: false, overlayOverride: null }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('shows the backend\'s error message when the upload fails', async () => {
    vi.mocked(tracksApi.upload).mockRejectedValue(new ApiError(400, 'unsupported audio format'));
    renderWithProviders(<AddTrackDrawer open onOpenChange={onOpenChange} onAdded={onAdded} />);

    const file = new File(['data'], 'song.mp3', { type: 'audio/mpeg' });
    await userEvent.upload(screen.getByLabelText('Audio file'), file);
    submitUploadForm();

    expect(await screen.findByText('unsupported audio format')).toBeInTheDocument();
  });
});

describe('AddTrackDrawer — service tab', () => {
  const onOpenChange = vi.fn();
  const onAdded = vi.fn();

  beforeEach(() => vi.clearAllMocks());

  function openServiceTab() {
    renderWithProviders(<AddTrackDrawer open onOpenChange={onOpenChange} onAdded={onAdded} />);
    fireEvent.click(screen.getByText('Add via service'));
  }

  it('searches, previews, and confirms a track', async () => {
    vi.mocked(tracksApi.searchPreview).mockResolvedValue({ previewId: 'p1' });
    vi.mocked(tracksApi.previewUrl).mockReturnValue('http://api.test/tracks/preview/p1');
    vi.mocked(tracksApi.confirmPreview).mockResolvedValue({ id: 't1', name: 'Blur - Song 2', durationSeconds: 90, hasCover: false, overlayOverride: null });
    openServiceTab();

    await userEvent.type(screen.getByLabelText('Search query'), 'Blur - Song 2');
    await userEvent.click(screen.getByText('Search'));

    await waitFor(() => expect(tracksApi.searchPreview).toHaveBeenCalledWith('Blur - Song 2'));
    const audio = await screen.findByTestId('preview-audio');
    expect(audio.getAttribute('src')).toBe('http://api.test/tracks/preview/p1');

    await userEvent.click(screen.getByText('Add'));

    await waitFor(() => expect(tracksApi.confirmPreview).toHaveBeenCalledWith('p1', 'Blur - Song 2', null));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' })));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('shows a search error and lets the streamer retry', async () => {
    vi.mocked(tracksApi.searchPreview).mockRejectedValue(new ApiError(502, 'media search service returned 502: not found'));
    openServiceTab();

    await userEvent.type(screen.getByLabelText('Search query'), 'nonexistent track');
    await userEvent.click(screen.getByText('Search'));

    expect(await screen.findByText('media search service returned 502: not found')).toBeInTheDocument();
  });

  it('"try another query" discards the current preview and returns to the search form', async () => {
    vi.mocked(tracksApi.searchPreview).mockResolvedValue({ previewId: 'p1' });
    vi.mocked(tracksApi.discardPreview).mockResolvedValue({});
    openServiceTab();

    await userEvent.type(screen.getByLabelText('Search query'), 'query one');
    await userEvent.click(screen.getByText('Search'));
    await screen.findByTestId('preview-audio');

    await userEvent.click(screen.getByText('Try another query'));

    await waitFor(() => expect(tracksApi.discardPreview).toHaveBeenCalledWith('p1'));
    expect(screen.getByLabelText('Search query')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-audio')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/components/AddTrackDrawer.test.tsx`
Expected: FAIL — `onAdded` prop doesn't exist yet, "Add via service" text not found, etc.

- [ ] **Step 3: Implement**

Replace `frontend/src/components/AddTrackDrawer.tsx` in full:

```tsx
import { FormEvent, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { tracksApi, Track } from '../api/tracks';
import { ApiError } from '../api/client';
import { Drawer } from './Drawer';

interface AddTrackDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (track: Track) => void;
}

type Tab = 'upload' | 'service';

function tabButtonClass(active: boolean): string {
  return `px-3 py-2 text-sm font-medium border-b-2 ${active ? 'border-black text-black' : 'border-transparent text-gray-500'}`;
}

function UploadTab({ onOpenChange, onAdded }: { onOpenChange: (open: boolean) => void; onAdded: (track: Track) => void }) {
  const { t } = useTranslation();
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
    onSuccess: (track) => {
      onAdded(track);
      onOpenChange(false);
      setName('');
      if (audioInputRef.current) audioInputRef.current.value = '';
      if (coverInputRef.current) coverInputRef.current.value = '';
    },
    onError: (err) => setUploadError(err instanceof ApiError ? err.message : t('addTrackDrawer.failed')),
  });

  function handleUpload(e: FormEvent) {
    e.preventDefault();
    setUploadError(null);
    uploadMutation.mutate();
  }

  return (
    <form onSubmit={handleUpload} className="space-y-3">
      <div>
        <label htmlFor="track-audio-file" className="block text-sm font-medium">{t('addTrackDrawer.audioFile')}</label>
        <input id="track-audio-file" ref={audioInputRef} type="file" accept=".mp3,.wav,.flac,.m4a" required />
      </div>
      <div>
        <label htmlFor="track-cover-file" className="block text-sm font-medium">{t('addTrackDrawer.coverFile')}</label>
        <input id="track-cover-file" ref={coverInputRef} type="file" accept=".jpg,.jpeg,.png" />
      </div>
      <input className="w-full rounded border px-3 py-2" placeholder={t('addTrackDrawer.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
      {uploadError && <p className="text-sm text-red-600">{uploadError}</p>}
      <button type="submit" disabled={uploadMutation.isPending} className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50">
        {uploadMutation.isPending ? t('addTrackDrawer.uploading') : t('addTrackDrawer.upload')}
      </button>
    </form>
  );
}

function ServiceTab({ onOpenChange, onAdded }: { onOpenChange: (open: boolean) => void; onAdded: (track: Track) => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const coverInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const searchMutation = useMutation({
    mutationFn: () => tracksApi.searchPreview(query),
    onSuccess: ({ previewId: id }) => {
      setPreviewId(id);
      setName(query);
      setError(null);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : t('addTrackDrawer.searchFailed')),
  });

  const confirmMutation = useMutation({
    mutationFn: () => {
      if (!previewId) throw new Error('no preview to confirm');
      const cover = coverInputRef.current?.files?.[0] ?? null;
      return tracksApi.confirmPreview(previewId, name || undefined, cover);
    },
    onSuccess: (track) => {
      onAdded(track);
      onOpenChange(false);
      resetState();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : t('addTrackDrawer.confirmFailed')),
  });

  function resetState() {
    setQuery('');
    setPreviewId(null);
    setName('');
    setError(null);
    if (coverInputRef.current) coverInputRef.current.value = '';
  }

  function handleSearch(e: FormEvent) {
    e.preventDefault();
    setError(null);
    searchMutation.mutate();
  }

  function handleTryAnother() {
    if (previewId) tracksApi.discardPreview(previewId).catch(() => {});
    setPreviewId(null);
    setError(null);
  }

  if (previewId) {
    return (
      <div className="space-y-3">
        <audio controls data-testid="preview-audio" src={tracksApi.previewUrl(previewId)} className="w-full" />
        <input className="w-full rounded border px-3 py-2" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('addTrackDrawer.namePlaceholder')} />
        <div>
          <label htmlFor="track-service-cover" className="block text-sm font-medium">{t('addTrackDrawer.coverFile')}</label>
          <input id="track-service-cover" ref={coverInputRef} type="file" accept=".jpg,.jpeg,.png" />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2">
          <button onClick={() => confirmMutation.mutate()} disabled={confirmMutation.isPending} className="flex-1 rounded bg-black px-4 py-2 text-white disabled:opacity-50">
            {confirmMutation.isPending ? t('addTrackDrawer.adding') : t('addTrackDrawer.add')}
          </button>
          <button onClick={handleTryAnother} disabled={confirmMutation.isPending} className="flex-1 rounded border px-4 py-2 disabled:opacity-50">
            {t('addTrackDrawer.tryAnother')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSearch} className="space-y-3">
      <div>
        <label htmlFor="track-service-query" className="block text-sm font-medium">{t('addTrackDrawer.queryLabel')}</label>
        <input id="track-service-query" value={query} onChange={(e) => setQuery(e.target.value)} required className="mt-1 w-full rounded border px-3 py-2" />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={searchMutation.isPending || query.trim().length === 0} className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50">
        {searchMutation.isPending ? t('addTrackDrawer.searching') : t('addTrackDrawer.search')}
      </button>
    </form>
  );
}

export function AddTrackDrawer({ open, onOpenChange, onAdded }: AddTrackDrawerProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('upload');

  return (
    <Drawer open={open} onOpenChange={onOpenChange} title={t('addTrackDrawer.title')}>
      <div className="mb-4 flex border-b">
        <button className={tabButtonClass(tab === 'upload')} onClick={() => setTab('upload')}>{t('addTrackDrawer.tabUpload')}</button>
        <button className={tabButtonClass(tab === 'service')} onClick={() => setTab('service')}>{t('addTrackDrawer.tabService')}</button>
      </div>
      {tab === 'upload'
        ? <UploadTab onOpenChange={onOpenChange} onAdded={onAdded} />
        : <ServiceTab onOpenChange={onOpenChange} onAdded={onAdded} />}
    </Drawer>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run src/components/AddTrackDrawer.test.tsx`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/AddTrackDrawer.tsx frontend/src/components/AddTrackDrawer.test.tsx
git commit -m "feat(frontend): add a service-search tab to AddTrackDrawer, alongside upload"
```

---

### Task 9: Fix `Library.tsx` for the renamed `onAdded` prop

**Files:**
- Modify: `frontend/src/pages/Library.tsx`

**Interfaces:**
- Consumes: `AddTrackDrawer`'s new `onAdded` prop (Task 8) — behavior is unchanged, only the prop
  name and the fact that it now receives an argument (ignored here, same as before).

- [ ] **Step 1: Update the prop name**

In `frontend/src/pages/Library.tsx`, change:

```tsx
      <AddTrackDrawer
        open={isDrawerOpen}
        onOpenChange={setDrawerOpen}
        onUploaded={() => queryClient.invalidateQueries({ queryKey: ['tracks'] })}
      />
```

to:

```tsx
      <AddTrackDrawer
        open={isDrawerOpen}
        onOpenChange={setDrawerOpen}
        onAdded={() => queryClient.invalidateQueries({ queryKey: ['tracks'] })}
      />
```

- [ ] **Step 2: Confirm `Library.test.tsx` needs no change**

`frontend/src/pages/Library.test.tsx` does not reference `AddTrackDrawer`, `onUploaded`, or
`onAdded` at all (it renders the real page and exercises the track list/delete flow only) — no
edit needed here. Confirm this is still true by running it in Step 3 below rather than assuming.

- [ ] **Step 3: Run the frontend build + affected tests**

Run: `cd frontend && npx tsc -b`
Expected: no errors.

Run: `cd frontend && npx vitest run src/pages/Library.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Library.tsx
git commit -m "fix(frontend): update Library.tsx for AddTrackDrawer's renamed onAdded prop"
```

---

### Task 10: Playlist editor — add a track directly into this playlist

**Files:**
- Modify: `frontend/src/pages/PlaylistEditor.tsx`
- Modify: `frontend/src/pages/PlaylistEditor.test.tsx`

**Interfaces:**
- Consumes: `AddTrackDrawer` (Task 8) — reused wholesale (both its tabs), not reimplemented.

The playlist editor's own `addTrack(track)` (already defined in the file — see below) stages a
track into the LOCAL `orderedTracks` state; nothing is persisted to the playlist until the
existing "Save" button is pressed. This means "create a track and add it to this playlist in one
step" needs NO new backend call at all — it's exactly `onAdded={(track) => { invalidate tracks
query; addTrack(track); }}`, reusing the page's own existing local staging function.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/pages/PlaylistEditor.test.tsx` (check its existing mocking setup for
`tracksApi`/`playlistsApi` first, and match it):

```typescript
it('opens the add-track drawer, and a confirmed track is staged into the playlist without a separate save', async () => {
  vi.mocked(playlistsApi.get).mockResolvedValue({ id: 'pl1', name: 'Mix', tracks: [] });
  vi.mocked(tracksApi.list).mockResolvedValue([]);
  vi.mocked(tracksApi.searchPreview).mockResolvedValue({ previewId: 'p1' });
  vi.mocked(tracksApi.previewUrl).mockReturnValue('http://api.test/tracks/preview/p1');
  vi.mocked(tracksApi.confirmPreview).mockResolvedValue({ id: 't1', name: 'New Song', durationSeconds: 60, hasCover: false, overlayOverride: null });
  renderEditor(); // this file's own helper — Routes+Route at /playlists/:id, route: '/playlists/p1'
  await screen.findByText('Mix');

  await userEvent.click(screen.getByText('+ Add new track'));
  await userEvent.click(screen.getByText('Add via service'));
  await userEvent.type(screen.getByLabelText('Search query'), 'New Song');
  await userEvent.click(screen.getByText('Search'));
  await screen.findByTestId('preview-audio');
  await userEvent.click(screen.getByText('Add'));

  await waitFor(() => expect(screen.getByText('New Song')).toBeInTheDocument());
  // Not yet persisted — replaceTracks only fires when "Save" is clicked.
  expect(playlistsApi.replaceTracks).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/pages/PlaylistEditor.test.tsx`
Expected: FAIL — "Add new track" text not found.

- [ ] **Step 3: Implement**

In `frontend/src/pages/PlaylistEditor.tsx`:

Add the import and one new piece of state:

```tsx
import { AddTrackDrawer } from '../components/AddTrackDrawer';
```

```tsx
  const [isAddDrawerOpen, setAddDrawerOpen] = useState(false);
```

Add a button next to the existing `addTracksHeading`:

```tsx
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium">{t('playlistEditor.addTracksHeading')}</h2>
          <button onClick={() => setAddDrawerOpen(true)} className="text-sm underline">{t('playlistEditor.addNewTrack')}</button>
        </div>
        <ul className="divide-y rounded-lg border">
```

(This replaces the existing bare `<h2 className="mb-2 font-medium">...</h2>` line with a
flex-wrapped heading + button — keep everything below `<ul className="divide-y rounded-lg border">`
unchanged.)

Add the drawer itself near the end of the returned JSX, right after the closing `</div>` of the
"available tracks" section:

```tsx
      <AddTrackDrawer
        open={isAddDrawerOpen}
        onOpenChange={setAddDrawerOpen}
        onAdded={(track) => {
          queryClient.invalidateQueries({ queryKey: ['tracks'] });
          addTrack(track);
        }}
      />
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run src/pages/PlaylistEditor.test.tsx`
Expected: PASS.

- [ ] **Step 5: Full frontend build + test run**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: no type errors, all suites pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/PlaylistEditor.tsx frontend/src/pages/PlaylistEditor.test.tsx
git commit -m "feat(frontend): add a track to a playlist directly via AddTrackDrawer"
```

---

### Task 11: i18n — new keys for all three locales

**Files:**
- Modify: `frontend/src/i18n/locales/en.json`
- Modify: `frontend/src/i18n/locales/ru.json`
- Modify: `frontend/src/i18n/locales/uk.json`

**Interfaces:** none — translation strings only. Every key referenced by Tasks 8 and 10 must exist
in all three files or the app falls back to the raw key string at runtime.

- [ ] **Step 1: Add keys to `en.json`'s `addTrackDrawer` section**

Extend the existing `addTrackDrawer` block:

```json
  "addTrackDrawer": {
    "title": "Add Track",
    "tabUpload": "Upload file",
    "tabService": "Add via service",
    "audioFile": "Audio file",
    "coverFile": "Cover image (optional)",
    "namePlaceholder": "Track name (optional — defaults to file name)",
    "upload": "Upload",
    "uploading": "Uploading…",
    "failed": "Upload failed",
    "queryLabel": "Search query",
    "search": "Search",
    "searching": "Searching…",
    "searchFailed": "Search failed",
    "add": "Add",
    "adding": "Adding…",
    "confirmFailed": "Failed to add the track",
    "tryAnother": "Try another query"
  },
```

Add to `playlistEditor` (find the existing block and add one key):

```json
    "addNewTrack": "+ Add new track",
```

- [ ] **Step 2: Add the equivalent Russian keys to `ru.json`**

```json
  "addTrackDrawer": {
    "title": "Добавить трек",
    "tabUpload": "Загрузить файл",
    "tabService": "Через сервис",
    "audioFile": "Аудиофайл",
    "coverFile": "Обложка (необязательно)",
    "namePlaceholder": "Название трека (необязательно — по умолчанию из файла)",
    "upload": "Загрузить",
    "uploading": "Загрузка…",
    "failed": "Не удалось загрузить",
    "queryLabel": "Поисковый запрос",
    "search": "Найти",
    "searching": "Поиск…",
    "searchFailed": "Не удалось найти",
    "add": "Добавить",
    "adding": "Добавление…",
    "confirmFailed": "Не удалось добавить трек",
    "tryAnother": "Другой запрос"
  },
```

```json
    "addNewTrack": "+ Новый трек",
```

- [ ] **Step 3: Add the equivalent Ukrainian keys to `uk.json`**

```json
  "addTrackDrawer": {
    "title": "Додати трек",
    "tabUpload": "Завантажити файл",
    "tabService": "Через сервіс",
    "audioFile": "Аудіофайл",
    "coverFile": "Обкладинка (необов'язково)",
    "namePlaceholder": "Назва треку (необов'язково — за замовчуванням з файлу)",
    "upload": "Завантажити",
    "uploading": "Завантаження…",
    "failed": "Не вдалося завантажити",
    "queryLabel": "Пошуковий запит",
    "search": "Знайти",
    "searching": "Пошук…",
    "searchFailed": "Не вдалося знайти",
    "add": "Додати",
    "adding": "Додавання…",
    "confirmFailed": "Не вдалося додати трек",
    "tryAnother": "Інший запит"
  },
```

```json
    "addNewTrack": "+ Новий трек",
```

- [ ] **Step 4: Verify every referenced key resolves**

Run: `cd frontend && npx vitest run src/components/AddTrackDrawer.test.tsx src/pages/PlaylistEditor.test.tsx src/pages/Library.test.tsx`
Expected: PASS — Task 8/9/10's tests already asserted on the exact English strings, which is the
real proof these keys are wired correctly (a missing key would render the raw key name instead of
the text those tests look for).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/i18n/locales/en.json frontend/src/i18n/locales/ru.json frontend/src/i18n/locales/uk.json
git commit -m "i18n: add strings for the track-search-preview flow"
```

---

### Task 12: `CLAUDE.md` update

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Add a short section describing the feature**

Following this repo's established style (see the "Donation-triggered song requests" section as
the closest precedent — same shape, much smaller feature), add a new subsection under
"Architecture (as built)", after the donations section, along these lines (adapt exact file/line
references to whatever they actually ended up at after Tasks 1-10 — do not copy placeholder paths
verbatim):

```markdown
**Adding library tracks via the media-search service.** Alongside uploading a file, a track can be
added by typing a text query: `POST /tracks/search-preview` fetches audio from the same external
media-search service the donation feature uses (`src/media/mediaSearchClient.ts` — moved out of
`src/donations/` when this landed, since it's no longer donation-specific) into a temporary file,
registers it in `TrackPreviewRegistry` (in-memory, same discipline as `MediaMtxAuthRegistry` —
including the original search query text, not just the temp path: `TrackUploadService.upload()`'s
own filename-based name fallback is meaningless here, since the temp file's `originalname` is a
synthetic `${previewId}.mp3`, so `TrackPreviewService.confirm()` defaults an empty/omitted name to
the registry's stored query instead), and returns a `previewId` the frontend streams back through
`GET /tracks/preview/{previewId}` for an in-browser `<audio>` preview — nothing is saved to the
library yet. `POST /tracks/from-preview/{previewId}` hands that SAME temp file to the existing
`TrackUploadService.upload()` unchanged (no second fetch from the external service). An
unconfirmed preview is reaped by a second
`startTempFileCleanupSweep` instance (1 hour max age — much shorter than the donation feature's 12
hours, since an abandoned preview is a forgotten draft, not a track a stream might still play).
`AddTrackDrawer.tsx` gained a tab switcher (upload / search); the playlist editor page reuses the
same drawer and stages a confirmed track into the playlist's local (unsaved-until-"Save") track
list via its own existing `addTrack()` — no separate "add to playlist" API call needed.
```

- [ ] **Step 2: Add the two new required-nothing note (no new env vars)**

Since this feature reuses the existing `MEDIA_SEARCH_SERVICE_URL`, no change to the "Configuration"
section is needed — explicitly confirm this rather than skipping the check: grep for
`MEDIA_SEARCH_SERVICE_URL` in `CLAUDE.md`'s Configuration section and confirm the existing text
already covers this reuse (it does — this task adds no new env var).

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document the add-track-via-media-service feature"
```

---

## Post-plan verification

After all 12 tasks: run the full backend suite (`npx tsc -p tsconfig.json --noEmit && npx jest`)
and the full frontend suite (`cd frontend && npx tsc -b && npx vitest run`) one more time from a
clean state, then manually smoke-test on the remote stand (192.168.14.26) per this repo's
established deploy workflow: archive → scp → copy → reapply the local-only port fix → rebuild both
`super-dj` and `frontend` containers (no migration needed — no schema change in this plan) — search
for a real query, listen to the preview, confirm it, and check it shows up both in the Library page
and (via the playlist editor) in a playlist after Save.
