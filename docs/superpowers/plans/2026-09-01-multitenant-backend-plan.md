# Multi-Tenant Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn super-dj's streaming backend from a single-tenant, env-configured, disk-scanned service into a multi-tenant one: tracks and playlists live in Postgres and are uploaded/managed via API, RTMP credentials live in Postgres (encrypted) as `StreamDestination` records, and any number of destinations can stream concurrently — one `StreamController` per `destinationId`, not per user, so a single user can eventually push to several platforms at once without a later redesign.

**Architecture:** New Prisma models (`Track`, `Playlist`, `PlaylistTrack`, `StreamDestination`) plus thin repositories matching the existing `UserRepository`/`SessionRepository` pattern. A `StreamManager` replaces the single global `StreamController`: it holds `Map<destinationId, StreamController>`, and `/destinations/:destinationId/stream/start` builds a fresh `StreamController` from a snapshot of the chosen playlist's tracks and the destination's decrypted RTMP credentials. `StreamController` itself is barely touched — only its `library` dependency's type is widened from the concrete (soon-to-be-deleted) `Library` class to a small structural interface. The old single-tenant surface (`Library`, `/library/*`, the global unauthenticated `/stream/*`, `AUDIO_DIR`/`RTMP_URL`/`STREAM_KEY`/`FIFO_PATH` env vars) is deleted in one cutover task once every replacement piece exists and is tested standalone.

**Tech Stack:** Prisma (new models), `multer` (file uploads), Node's built-in `crypto` (AES-256-GCM for stream keys), Express, Jest/supertest (existing).

**Spec:** [docs/superpowers/specs/2026-09-01-multitenant-backend-design.md](../specs/2026-09-01-multitenant-backend-design.md)

## Global Constraints

- Every destination streams independently: the runtime registry is keyed by `destinationId`, never by `userId` — a user may eventually run several concurrent streams, one per destination.
- `/stream/start` always builds a **fresh** `StreamController` from a snapshot of the playlist at that moment. Editing a playlist never affects an already-running stream; changes apply only on the next `/start`.
- Ownership is checked on every action against `destinationId`/`playlistId`/`trackId`: a resource that exists but belongs to another user returns 403, not 404 (a resource that doesn't exist at all returns 404).
- `TrackRepository`/`PlaylistRepository`/`DestinationRepository` (thin Prisma wrappers) are intentionally NOT unit-tested, matching `UserRepository`/`SessionRepository` from the DB+auth phase — verified via manual smoke test instead.
- `POST .../stream/play` looks up the track by name across **all of the destination-owning user's tracks**, not just the tracks in the currently-streaming playlist (this mirrors the old single-tenant `Library.findByName` behavior, now backed by the DB).
- Stream key plaintext is never returned by any API response, ever — `GET /destinations` returns only `id`/`name`/`rtmpUrl`/`provider`.
- Tasks 1–8 are purely additive: the old `Library`/`libraryRoutes`/`streamRoutes`/env vars keep working untouched while the new pieces are built and tested standalone (their own Express app in tests, not wired into `createApp` yet). Task 9 is the one cutover that removes the old surface and rewires everything — do not attempt a partial removal in an earlier task.

---

### Task 1: Prisma schema additions, config additions, dependencies

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/config/env.ts`
- Modify: `test/config/env.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: Prisma models `Track`, `Playlist`, `PlaylistTrack`, `StreamDestination`; `AppConfig` gains `uploadsDir: string`, `streamKeyEncryptionKey: string`, `fifoDir: string`.

This task is purely additive — every existing `AppConfig` field (`rtmpUrl`, `streamKey`, `audioDir`, `fifoPath`, etc.) stays exactly as it is. Task 9 removes them once everything that depends on the new fields exists.

- [ ] **Step 1: Modify `prisma/schema.prisma`**

Add these four models, and add three relation fields to the existing `User` model:

```prisma
model User {
  id                 String              @id @default(uuid())
  email              String              @unique
  passwordHash       String
  createdAt          DateTime            @default(now())
  sessions           Session[]
  tracks             Track[]
  playlists          Playlist[]
  streamDestinations StreamDestination[]
}

model Track {
  id              String          @id @default(uuid())
  userId          String
  user            User            @relation(fields: [userId], references: [id], onDelete: Cascade)
  name            String
  audioPath       String
  coverPath       String?
  durationSeconds Float?
  createdAt       DateTime        @default(now())
  playlistTracks  PlaylistTrack[]
}

model Playlist {
  id        String          @id @default(uuid())
  userId    String
  user      User            @relation(fields: [userId], references: [id], onDelete: Cascade)
  name      String
  createdAt DateTime        @default(now())
  tracks    PlaylistTrack[]
}

model PlaylistTrack {
  id         String   @id @default(uuid())
  playlistId String
  playlist   Playlist @relation(fields: [playlistId], references: [id], onDelete: Cascade)
  trackId    String
  track      Track    @relation(fields: [trackId], references: [id], onDelete: Cascade)
  position   Int
}

model StreamDestination {
  id                 String   @id @default(uuid())
  userId             String
  user               User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  name               String
  rtmpUrl            String
  streamKeyEncrypted String
  provider           String   @default("youtube")
  createdAt          DateTime @default(now())
}
```

(`Session` model is unchanged — leave it exactly as it is.)

- [ ] **Step 2: Add `multer` to `package.json`**

Add to `"dependencies"`: `"multer": "^1.4.5-lts.1"`. Add to `"devDependencies"`: `"@types/multer": "^1.4.11"`.

- [ ] **Step 3: Install and regenerate the Prisma client**

Run: `npm install`
Run (with a placeholder `DATABASE_URL` if not already set in your shell): `npx prisma generate`

- [ ] **Step 4: Write the failing config tests**

Add to `test/config/env.test.ts` (new `describe` block; do not touch the existing ones):

```ts
describe('loadConfig — multi-tenant additions', () => {
  const base = {
    RTMP_URL: 'rtmp://example.com/live', STREAM_KEY: 'key123', DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  } as NodeJS.ProcessEnv;

  it('applies defaults for uploadsDir, streamKeyEncryptionKey requirement, and fifoDir', () => {
    const config = loadConfig({ ...base, STREAM_KEY_ENCRYPTION_KEY: 'a'.repeat(64) } as NodeJS.ProcessEnv);
    expect(config.uploadsDir).toBe('/data/uploads');
    expect(config.fifoDir).toBe('/tmp');
    expect(config.streamKeyEncryptionKey).toBe('a'.repeat(64));
  });

  it('throws when STREAM_KEY_ENCRYPTION_KEY is missing', () => {
    expect(() => loadConfig(base)).toThrow('STREAM_KEY_ENCRYPTION_KEY environment variable is required');
  });

  it('honors overridden UPLOADS_DIR and FIFO_DIR', () => {
    const config = loadConfig({
      ...base, STREAM_KEY_ENCRYPTION_KEY: 'a'.repeat(64), UPLOADS_DIR: '/srv/uploads', FIFO_DIR: '/var/run/super-dj',
    } as NodeJS.ProcessEnv);
    expect(config.uploadsDir).toBe('/srv/uploads');
    expect(config.fifoDir).toBe('/var/run/super-dj');
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx jest test/config/env.test.ts`
Expected: FAIL — `uploadsDir`/`fifoDir`/`streamKeyEncryptionKey` don't exist, `STREAM_KEY_ENCRYPTION_KEY` isn't validated

- [ ] **Step 6: Implement the `AppConfig` additions in `src/config/env.ts`**

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
  uploadsDir: string;
  streamKeyEncryptionKey: string;
  fifoDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rtmpUrl = env.RTMP_URL;
  const streamKey = env.STREAM_KEY;
  const databaseUrl = env.DATABASE_URL;
  const streamKeyEncryptionKey = env.STREAM_KEY_ENCRYPTION_KEY;

  if (!rtmpUrl) {
    throw new Error('RTMP_URL environment variable is required');
  }
  if (!streamKey) {
    throw new Error('STREAM_KEY environment variable is required');
  }
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  if (!streamKeyEncryptionKey) {
    throw new Error('STREAM_KEY_ENCRYPTION_KEY environment variable is required');
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
    uploadsDir: env.UPLOADS_DIR ?? '/data/uploads',
    streamKeyEncryptionKey,
    fifoDir: env.FIFO_DIR ?? '/tmp',
  };
}
```

Note this makes `STREAM_KEY_ENCRYPTION_KEY` newly required — every pre-existing test in this file that calls `loadConfig` must now also include it in its env fixture, or it will start failing. Update every existing test's fixture object accordingly (add `STREAM_KEY_ENCRYPTION_KEY: 'a'.repeat(64)` alongside the existing `RTMP_URL`/`STREAM_KEY`/`DATABASE_URL`).

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx jest test/config/env.test.ts`
Expected: PASS (all tests, old and new)

- [ ] **Step 8: Fix `test/server.test.ts`'s `AppConfig` fixture**

It constructs a literal `AppConfig` object — add `uploadsDir`, `streamKeyEncryptionKey`, `fifoDir` to it (any valid-looking values, e.g. `uploadsDir: '/uploads'`, `streamKeyEncryptionKey: 'a'.repeat(64)`, `fifoDir: '/tmp'`) so it keeps compiling.

- [ ] **Step 9: Run the full suite and build**

Run: `npx jest && npm run build`
Expected: all suites PASS, `tsc` clean

- [ ] **Step 10: Commit**

```bash
git add prisma/schema.prisma src/config/env.ts test/config/env.test.ts test/server.test.ts package.json package-lock.json
git commit -m "feat: add multi-tenant Prisma models and config (uploads dir, stream key encryption key, fifo dir)"
```

---

### Task 2: Stream key cipher

**Files:**
- Create: `src/crypto/streamKeyCipher.ts`
- Test: `test/crypto/streamKeyCipher.test.ts`

**Interfaces:**
- Produces: `encrypt(plaintext: string, key: string): string`, `decrypt(encrypted: string, key: string): string`

The encryption key is passed in explicitly (not read from `process.env` inside this module) so it's fully unit-testable and the composition root controls where the key comes from.

- [ ] **Step 1: Write the failing tests**

```ts
// test/crypto/streamKeyCipher.test.ts
import { encrypt, decrypt } from '../../src/crypto/streamKeyCipher';

const KEY = 'a'.repeat(64); // 32 bytes, hex-encoded

describe('streamKeyCipher', () => {
  it('encrypts and decrypts a round trip', () => {
    const ciphertext = encrypt('my-secret-stream-key', KEY);
    expect(ciphertext).not.toContain('my-secret-stream-key');
    expect(decrypt(ciphertext, KEY)).toBe('my-secret-stream-key');
  });

  it('produces different ciphertext for the same plaintext (random IV)', () => {
    const a = encrypt('same-value', KEY);
    const b = encrypt('same-value', KEY);
    expect(a).not.toBe(b);
  });

  it('fails to decrypt with the wrong key', () => {
    const ciphertext = encrypt('my-secret-stream-key', KEY);
    const wrongKey = 'b'.repeat(64);
    expect(() => decrypt(ciphertext, wrongKey)).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/crypto/streamKeyCipher.test.ts`
Expected: FAIL — `Cannot find module '../../src/crypto/streamKeyCipher'`

- [ ] **Step 3: Implement `src/crypto/streamKeyCipher.ts`**

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

export function encrypt(plaintext: string, hexKey: string): string {
  const key = Buffer.from(hexKey, 'hex');
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decrypt(encrypted: string, hexKey: string): string {
  const key = Buffer.from(hexKey, 'hex');
  const data = Buffer.from(encrypted, 'base64');
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = data.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/crypto/streamKeyCipher.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/crypto/streamKeyCipher.ts test/crypto/streamKeyCipher.test.ts
git commit -m "feat: AES-256-GCM stream key cipher"
```

---

### Task 3: Track, Playlist, and Destination repositories

**Files:**
- Create: `src/tracks/trackRepository.ts`
- Create: `src/playlists/playlistRepository.ts`
- Create: `src/destinations/destinationRepository.ts`

**Interfaces:**
- Consumes: `PrismaClient`, `Track`, `Playlist`, `StreamDestination` from `@prisma/client` (Task 1).
- Produces:
  - `class TrackRepository { constructor(prisma: PrismaClient); create(data: {id: string; userId: string; name: string; audioPath: string; coverPath: string | null; durationSeconds: number}): Promise<Track>; listByUser(userId: string): Promise<Track[]>; findById(id: string): Promise<Track | null>; deleteById(id: string): Promise<void>; }`
  - `interface PlaylistTrackView { name: string; audioPath: string; coverPath: string | null; }`, `class PlaylistRepository { constructor(prisma: PrismaClient); create(userId: string, name: string): Promise<Playlist>; listByUser(userId: string): Promise<Playlist[]>; findById(id: string): Promise<Playlist | null>; listTracks(playlistId: string): Promise<PlaylistTrackView[]>; replaceTracks(playlistId: string, trackIds: string[]): Promise<void>; deleteById(id: string): Promise<void>; }`
  - `class DestinationRepository { constructor(prisma: PrismaClient); create(data: {userId: string; name: string; rtmpUrl: string; streamKeyEncrypted: string}): Promise<StreamDestination>; listByUser(userId: string): Promise<StreamDestination[]>; findById(id: string): Promise<StreamDestination | null>; deleteById(id: string): Promise<void>; }`

No test files for this task — per the plan's Global Constraints, these thin Prisma wrappers are verified by manual smoke test, not unit tests (matching `UserRepository`/`SessionRepository`).

- [ ] **Step 1: Implement `src/tracks/trackRepository.ts`**

```ts
import { PrismaClient, Track } from '@prisma/client';

export class TrackRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(data: {
    id: string; userId: string; name: string; audioPath: string; coverPath: string | null; durationSeconds: number;
  }): Promise<Track> {
    return this.prisma.track.create({ data });
  }

  listByUser(userId: string): Promise<Track[]> {
    return this.prisma.track.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  findById(id: string): Promise<Track | null> {
    return this.prisma.track.findUnique({ where: { id } });
  }

  async deleteById(id: string): Promise<void> {
    await this.prisma.track.deleteMany({ where: { id } });
  }
}
```

- [ ] **Step 2: Implement `src/playlists/playlistRepository.ts`**

```ts
import { PrismaClient, Playlist } from '@prisma/client';

export interface PlaylistTrackView {
  name: string;
  audioPath: string;
  coverPath: string | null;
}

export class PlaylistRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(userId: string, name: string): Promise<Playlist> {
    return this.prisma.playlist.create({ data: { userId, name } });
  }

  listByUser(userId: string): Promise<Playlist[]> {
    return this.prisma.playlist.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  findById(id: string): Promise<Playlist | null> {
    return this.prisma.playlist.findUnique({ where: { id } });
  }

  async listTracks(playlistId: string): Promise<PlaylistTrackView[]> {
    const rows = await this.prisma.playlistTrack.findMany({
      where: { playlistId },
      orderBy: { position: 'asc' },
      include: { track: true },
    });
    return rows.map((row) => ({
      name: row.track.name,
      audioPath: row.track.audioPath,
      coverPath: row.track.coverPath,
    }));
  }

  async replaceTracks(playlistId: string, trackIds: string[]): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.playlistTrack.deleteMany({ where: { playlistId } }),
      this.prisma.playlistTrack.createMany({
        data: trackIds.map((trackId, index) => ({ playlistId, trackId, position: index })),
      }),
    ]);
  }

  async deleteById(id: string): Promise<void> {
    await this.prisma.playlist.deleteMany({ where: { id } });
  }
}
```

- [ ] **Step 3: Implement `src/destinations/destinationRepository.ts`**

```ts
import { PrismaClient, StreamDestination } from '@prisma/client';

export class DestinationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(data: {
    userId: string; name: string; rtmpUrl: string; streamKeyEncrypted: string;
  }): Promise<StreamDestination> {
    return this.prisma.streamDestination.create({ data });
  }

  listByUser(userId: string): Promise<StreamDestination[]> {
    return this.prisma.streamDestination.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  findById(id: string): Promise<StreamDestination | null> {
    return this.prisma.streamDestination.findUnique({ where: { id } });
  }

  async deleteById(id: string): Promise<void> {
    await this.prisma.streamDestination.deleteMany({ where: { id } });
  }
}
```

- [ ] **Step 4: Verify the build compiles**

Run: `npm run build`
Expected: `tsc` clean

- [ ] **Step 5: Commit**

```bash
git add src/tracks/trackRepository.ts src/playlists/playlistRepository.ts src/destinations/destinationRepository.ts
git commit -m "feat: Prisma-backed track, playlist, and destination repositories"
```

---

### Task 4: Track upload service and routes

**Files:**
- Create: `src/tracks/trackUploadService.ts`
- Create: `src/tracks/trackRoutes.ts`
- Test: `test/tracks/trackUploadService.test.ts`
- Test: `test/tracks/trackRoutes.test.ts`

**Interfaces:**
- Consumes: `TrackRepository` (Task 3), `getAudioDurationSeconds` (existing `src/ffmpeg/duration.ts`), `ApiError`, `wrapAsync`, `requireAuth`, `AuthenticatedRequest`, `AuthService` (all existing from the DB+auth phase).
- Produces: `interface UploadedFile { originalname: string; path: string; size: number; }`, `interface TrackSummary { id: string; name: string; durationSeconds: number | null; hasCover: boolean; }`, `class TrackUploadService { constructor(trackRepository, uploadsDir: string, probeDuration?: typeof getAudioDurationSeconds); upload(userId: string, name: string | undefined, audioFile: UploadedFile, coverFile: UploadedFile | undefined): Promise<TrackSummary>; }`, `createTrackRouter(authService, uploadService, trackRepository): Router`.

`TrackUploadService` takes a filesystem-move function and an id generator as **injectable** dependencies so it's testable without touching a real disk.

- [ ] **Step 1: Write the failing service tests**

```ts
// test/tracks/trackUploadService.test.ts
import { TrackUploadService } from '../../src/tracks/trackUploadService';

function buildDeps() {
  const trackRepository = { create: jest.fn(async (data: any) => ({ ...data, createdAt: new Date() })) };
  const moveFile = jest.fn(async (_from: string, _to: string) => {});
  const probeDuration = jest.fn(async () => 123.45);
  const generateId = jest.fn(() => 'track-1');
  return { trackRepository, moveFile, probeDuration, generateId };
}

describe('TrackUploadService', () => {
  it('moves the audio (and cover) file into the uploads dir and creates a Track row', async () => {
    const { trackRepository, moveFile, probeDuration, generateId } = buildDeps();
    const service = new TrackUploadService({
      trackRepository, uploadsDir: '/uploads', moveFile, probeDuration, generateId,
    });

    const result = await service.upload(
      'user-1',
      undefined,
      { originalname: 'My Song.mp3', path: '/tmp/upload-a', size: 1000 },
      { originalname: 'cover.png', path: '/tmp/upload-b', size: 500 },
    );

    expect(moveFile).toHaveBeenCalledWith('/tmp/upload-a', '/uploads/user-1/track-1/audio.mp3');
    expect(moveFile).toHaveBeenCalledWith('/tmp/upload-b', '/uploads/user-1/track-1/cover.png');
    expect(probeDuration).toHaveBeenCalledWith('/uploads/user-1/track-1/audio.mp3');
    expect(trackRepository.create).toHaveBeenCalledWith({
      id: 'track-1', userId: 'user-1', name: 'My Song', audioPath: '/uploads/user-1/track-1/audio.mp3',
      coverPath: '/uploads/user-1/track-1/cover.png', durationSeconds: 123.45,
    });
    expect(result).toEqual({ id: 'track-1', name: 'My Song', durationSeconds: 123.45, hasCover: true });
  });

  it('uses the provided name over the filename, and omits the cover when none is given', async () => {
    const { trackRepository, moveFile, probeDuration, generateId } = buildDeps();
    const service = new TrackUploadService({ trackRepository, uploadsDir: '/uploads', moveFile, probeDuration, generateId });

    const result = await service.upload('user-1', 'Custom Name', { originalname: 'track.wav', path: '/tmp/x', size: 1 }, undefined);

    expect(trackRepository.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Custom Name', coverPath: null }));
    expect(result.hasCover).toBe(false);
    expect(moveFile).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/tracks/trackUploadService.test.ts`
Expected: FAIL — `Cannot find module '../../src/tracks/trackUploadService'`

- [ ] **Step 3: Implement `src/tracks/trackUploadService.ts`**

```ts
import { posix as path } from 'path';
import { randomUUID } from 'crypto';
import * as fsPromises from 'fs/promises';
import { TrackRepository } from './trackRepository';
import { getAudioDurationSeconds } from '../ffmpeg/duration';

export interface UploadedFile {
  originalname: string;
  path: string;
  size: number;
}

export interface TrackSummary {
  id: string;
  name: string;
  durationSeconds: number | null;
  hasCover: boolean;
}

export interface TrackUploadServiceDeps {
  trackRepository: Pick<TrackRepository, 'create'>;
  uploadsDir: string;
  moveFile?: (from: string, to: string) => Promise<void>;
  probeDuration?: typeof getAudioDurationSeconds;
  generateId?: () => string;
}

export class TrackUploadService {
  private readonly moveFile: (from: string, to: string) => Promise<void>;
  private readonly probeDuration: typeof getAudioDurationSeconds;
  private readonly generateId: () => string;

  constructor(private readonly deps: TrackUploadServiceDeps) {
    this.moveFile = deps.moveFile ?? (async (from, to) => {
      await fsPromises.mkdir(path.dirname(to), { recursive: true });
      await fsPromises.rename(from, to);
    });
    this.probeDuration = deps.probeDuration ?? getAudioDurationSeconds;
    this.generateId = deps.generateId ?? randomUUID;
  }

  async upload(
    userId: string,
    name: string | undefined,
    audioFile: UploadedFile,
    coverFile: UploadedFile | undefined,
  ): Promise<TrackSummary> {
    const trackId = this.generateId();
    const trackDir = path.join(this.deps.uploadsDir, userId, trackId);

    const audioExt = path.extname(audioFile.originalname).toLowerCase();
    const audioPath = path.join(trackDir, `audio${audioExt}`);
    await this.moveFile(audioFile.path, audioPath);

    let coverPath: string | null = null;
    if (coverFile) {
      const coverExt = path.extname(coverFile.originalname).toLowerCase();
      coverPath = path.join(trackDir, `cover${coverExt}`);
      await this.moveFile(coverFile.path, coverPath);
    }

    const durationSeconds = await this.probeDuration(audioPath);
    const trackName = name ?? path.basename(audioFile.originalname, audioExt);

    const track = await this.deps.trackRepository.create({
      id: trackId, userId, name: trackName, audioPath, coverPath, durationSeconds,
    });

    return { id: track.id, name: track.name, durationSeconds: track.durationSeconds, hasCover: track.coverPath !== null };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/tracks/trackUploadService.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the failing route tests**

```ts
// test/tracks/trackRoutes.test.ts
import express from 'express';
import request from 'supertest';
import { createTrackRouter } from '../../src/tracks/trackRoutes';
import { errorHandler } from '../../src/api/errorHandler';

function buildApp(overrides: { getCurrentUser?: any; uploadService?: any; trackRepository?: any } = {}) {
  const authService: any = {
    getCurrentUser: overrides.getCurrentUser ?? jest.fn().mockResolvedValue({ id: 'user-1', email: 'a@example.com' }),
  };
  const uploadService: any = overrides.uploadService ?? { upload: jest.fn() };
  const trackRepository: any = overrides.trackRepository ?? { listByUser: jest.fn(), findById: jest.fn(), deleteById: jest.fn() };
  const app = express();
  app.use(express.json());
  app.use('/tracks', createTrackRouter(authService, uploadService, trackRepository));
  app.use(errorHandler);
  return { app, uploadService, trackRepository };
}

describe('track routes', () => {
  it('GET /tracks requires authentication', async () => {
    const { app } = buildApp({ getCurrentUser: jest.fn().mockResolvedValue(null) });
    const res = await request(app).get('/tracks');
    expect(res.status).toBe(401);
  });

  it('GET /tracks lists the current user\'s tracks', async () => {
    const trackRepository: any = {
      listByUser: jest.fn().mockResolvedValue([
        { id: 't1', name: 'a', durationSeconds: 10, coverPath: null },
        { id: 't2', name: 'b', durationSeconds: 20, coverPath: '/x/cover.png' },
      ]),
    };
    const { app } = buildApp({ trackRepository });
    const res = await request(app).get('/tracks');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: 't1', name: 'a', durationSeconds: 10, hasCover: false },
      { id: 't2', name: 'b', durationSeconds: 20, hasCover: true },
    ]);
    expect(trackRepository.listByUser).toHaveBeenCalledWith('user-1');
  });

  it('DELETE /tracks/:id returns 403 for a track owned by someone else', async () => {
    const trackRepository: any = { findById: jest.fn().mockResolvedValue({ id: 't1', userId: 'someone-else' }), deleteById: jest.fn() };
    const { app } = buildApp({ trackRepository });
    const res = await request(app).delete('/tracks/t1');
    expect(res.status).toBe(403);
    expect(trackRepository.deleteById).not.toHaveBeenCalled();
  });

  it('DELETE /tracks/:id returns 404 for a track that does not exist', async () => {
    const trackRepository: any = { findById: jest.fn().mockResolvedValue(null), deleteById: jest.fn() };
    const { app } = buildApp({ trackRepository });
    const res = await request(app).delete('/tracks/missing');
    expect(res.status).toBe(404);
  });

  it('DELETE /tracks/:id deletes an owned track', async () => {
    const trackRepository: any = { findById: jest.fn().mockResolvedValue({ id: 't1', userId: 'user-1' }), deleteById: jest.fn() };
    const { app } = buildApp({ trackRepository });
    const res = await request(app).delete('/tracks/t1');
    expect(res.status).toBe(200);
    expect(trackRepository.deleteById).toHaveBeenCalledWith('t1');
  });

  it('POST /tracks rejects a request with no audio file', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/tracks').field('name', 'test');
    expect(res.status).toBe(400);
  });

  it('POST /tracks accepts an audio file and calls the upload service', async () => {
    const uploadService: any = { upload: jest.fn().mockResolvedValue({ id: 't1', name: 'song', durationSeconds: 5, hasCover: false }) };
    const { app } = buildApp({ uploadService });
    const res = await request(app).post('/tracks').attach('audio', Buffer.from('fake-mp3-bytes'), 'song.mp3');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 't1', name: 'song', durationSeconds: 5, hasCover: false });
    expect(uploadService.upload).toHaveBeenCalledWith('user-1', undefined, expect.objectContaining({ originalname: 'song.mp3' }), undefined);
  });

  it('POST /tracks rejects an unsupported audio extension', async () => {
    const uploadService: any = { upload: jest.fn() };
    const { app } = buildApp({ uploadService });
    const res = await request(app).post('/tracks').attach('audio', Buffer.from('data'), 'song.exe');
    expect(res.status).toBe(400);
    expect(uploadService.upload).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx jest test/tracks/trackRoutes.test.ts`
Expected: FAIL — `Cannot find module '../../src/tracks/trackRoutes'`

- [ ] **Step 7: Implement `src/tracks/trackRoutes.ts`**

```ts
import { Router } from 'express';
import multer from 'multer';
import * as os from 'os';
import { posix as path } from 'path';
import { TrackUploadService } from './trackUploadService';
import { TrackRepository } from './trackRepository';
import { ApiError } from '../errors';
import { wrapAsync } from '../api/errorHandler';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { AuthService } from '../auth/authService';

const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.flac', '.m4a'];
const COVER_EXTENSIONS = ['.jpg', '.jpeg', '.png'];
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_COVER_BYTES = 10 * 1024 * 1024;

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: MAX_AUDIO_BYTES } });

function toSummary(track: { id: string; name: string; durationSeconds: number | null; coverPath: string | null }) {
  return { id: track.id, name: track.name, durationSeconds: track.durationSeconds, hasCover: track.coverPath !== null };
}

export function createTrackRouter(
  authService: AuthService,
  uploadService: TrackUploadService,
  trackRepository: TrackRepository,
): Router {
  const router = Router();
  const auth = requireAuth(authService);

  router.post('/', auth, upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'cover', maxCount: 1 }]), wrapAsync(async (req, res) => {
    const files = req.files as { audio?: Express.Multer.File[]; cover?: Express.Multer.File[] } | undefined;
    const audioFile = files?.audio?.[0];
    if (!audioFile) throw new ApiError(400, 'audio file is required');
    if (!AUDIO_EXTENSIONS.includes(path.extname(audioFile.originalname).toLowerCase())) {
      throw new ApiError(400, 'unsupported audio format');
    }

    const coverFile = files?.cover?.[0];
    if (coverFile) {
      if (!COVER_EXTENSIONS.includes(path.extname(coverFile.originalname).toLowerCase())) {
        throw new ApiError(400, 'unsupported cover format');
      }
      if (coverFile.size > MAX_COVER_BYTES) throw new ApiError(400, 'cover file too large');
    }

    const name = typeof req.body?.name === 'string' && req.body.name.length > 0 ? req.body.name : undefined;
    const userId = (req as AuthenticatedRequest).user!.id;
    const summary = await uploadService.upload(userId, name, audioFile, coverFile);
    res.status(200).json(summary);
  }));

  router.get('/', auth, wrapAsync(async (req, res) => {
    const tracks = await trackRepository.listByUser((req as AuthenticatedRequest).user!.id);
    res.status(200).json(tracks.map(toSummary));
  }));

  router.delete('/:id', auth, wrapAsync(async (req, res) => {
    const track = await trackRepository.findById(req.params.id);
    if (!track) throw new ApiError(404, 'track not found');
    if (track.userId !== (req as AuthenticatedRequest).user!.id) throw new ApiError(403, 'not your track');
    await trackRepository.deleteById(track.id);
    res.status(200).json({});
  }));

  return router;
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx jest test/tracks/trackRoutes.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 9: Run the full suite and build**

Run: `npx jest && npm run build`
Expected: all suites PASS, `tsc` clean

- [ ] **Step 10: Commit**

```bash
git add src/tracks/trackUploadService.ts src/tracks/trackRoutes.ts test/tracks/trackUploadService.test.ts test/tracks/trackRoutes.test.ts
git commit -m "feat: track upload service and REST routes"
```

---

### Task 5: Playlist routes

**Files:**
- Create: `src/playlists/playlistRoutes.ts`
- Test: `test/playlists/playlistRoutes.test.ts`

**Interfaces:**
- Consumes: `PlaylistRepository` (Task 3), `ApiError`, `wrapAsync`, `requireAuth`, `AuthenticatedRequest`, `AuthService`.
- Produces: `createPlaylistRouter(authService, playlistRepository): Router`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/playlists/playlistRoutes.test.ts
import express from 'express';
import request from 'supertest';
import { createPlaylistRouter } from '../../src/playlists/playlistRoutes';
import { errorHandler } from '../../src/api/errorHandler';

function buildApp(playlistRepository: any, userId = 'user-1') {
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: userId, email: 'a@example.com' }) };
  const app = express();
  app.use(express.json());
  app.use('/playlists', createPlaylistRouter(authService, playlistRepository));
  app.use(errorHandler);
  return app;
}

describe('playlist routes', () => {
  it('POST /playlists creates a playlist for the current user', async () => {
    const playlistRepository: any = { create: jest.fn().mockResolvedValue({ id: 'p1', name: 'My Mix', userId: 'user-1' }) };
    const res = await request(buildApp(playlistRepository)).post('/playlists').send({ name: 'My Mix' });
    expect(res.status).toBe(200);
    expect(playlistRepository.create).toHaveBeenCalledWith('user-1', 'My Mix');
    expect(res.body).toEqual({ id: 'p1', name: 'My Mix' });
  });

  it('POST /playlists requires a non-empty name', async () => {
    const playlistRepository: any = { create: jest.fn() };
    const res = await request(buildApp(playlistRepository)).post('/playlists').send({});
    expect(res.status).toBe(400);
    expect(playlistRepository.create).not.toHaveBeenCalled();
  });

  it('GET /playlists lists the current user\'s playlists', async () => {
    const playlistRepository: any = { listByUser: jest.fn().mockResolvedValue([{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }]) };
    const res = await request(buildApp(playlistRepository)).get('/playlists');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }]);
  });

  it('GET /playlists/:id returns the playlist with its ordered tracks', async () => {
    const playlistRepository: any = {
      findById: jest.fn().mockResolvedValue({ id: 'p1', name: 'A', userId: 'user-1' }),
      listTracks: jest.fn().mockResolvedValue([{ name: 'a', audioPath: '/x/a.mp3', coverPath: null }]),
    };
    const res = await request(buildApp(playlistRepository)).get('/playlists/p1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'p1', name: 'A', tracks: [{ name: 'a', audioPath: '/x/a.mp3', coverPath: null }] });
  });

  it('GET /playlists/:id returns 403 for someone else\'s playlist', async () => {
    const playlistRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'p1', name: 'A', userId: 'someone-else' }) };
    const res = await request(buildApp(playlistRepository)).get('/playlists/p1');
    expect(res.status).toBe(403);
  });

  it('PUT /playlists/:id/tracks replaces the ordered track list', async () => {
    const playlistRepository: any = {
      findById: jest.fn().mockResolvedValue({ id: 'p1', name: 'A', userId: 'user-1' }),
      replaceTracks: jest.fn().mockResolvedValue(undefined),
    };
    const res = await request(buildApp(playlistRepository)).put('/playlists/p1/tracks').send({ trackIds: ['t2', 't1'] });
    expect(res.status).toBe(200);
    expect(playlistRepository.replaceTracks).toHaveBeenCalledWith('p1', ['t2', 't1']);
  });

  it('PUT /playlists/:id/tracks requires trackIds to be an array', async () => {
    const playlistRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'p1', name: 'A', userId: 'user-1' }) };
    const res = await request(buildApp(playlistRepository)).put('/playlists/p1/tracks').send({ trackIds: 'not-an-array' });
    expect(res.status).toBe(400);
  });

  it('DELETE /playlists/:id deletes an owned playlist', async () => {
    const playlistRepository: any = {
      findById: jest.fn().mockResolvedValue({ id: 'p1', name: 'A', userId: 'user-1' }),
      deleteById: jest.fn().mockResolvedValue(undefined),
    };
    const res = await request(buildApp(playlistRepository)).delete('/playlists/p1');
    expect(res.status).toBe(200);
    expect(playlistRepository.deleteById).toHaveBeenCalledWith('p1');
  });

  it('DELETE /playlists/:id returns 404 for a missing playlist', async () => {
    const playlistRepository: any = { findById: jest.fn().mockResolvedValue(null) };
    const res = await request(buildApp(playlistRepository)).delete('/playlists/missing');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/playlists/playlistRoutes.test.ts`
Expected: FAIL — `Cannot find module '../../src/playlists/playlistRoutes'`

- [ ] **Step 3: Implement `src/playlists/playlistRoutes.ts`**

```ts
import { Router } from 'express';
import { PlaylistRepository } from './playlistRepository';
import { ApiError } from '../errors';
import { wrapAsync } from '../api/errorHandler';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { AuthService } from '../auth/authService';

async function requireOwnedPlaylist(playlistRepository: PlaylistRepository, id: string, userId: string) {
  const playlist = await playlistRepository.findById(id);
  if (!playlist) throw new ApiError(404, 'playlist not found');
  if (playlist.userId !== userId) throw new ApiError(403, 'not your playlist');
  return playlist;
}

export function createPlaylistRouter(authService: AuthService, playlistRepository: PlaylistRepository): Router {
  const router = Router();
  const auth = requireAuth(authService);

  router.post('/', auth, wrapAsync(async (req, res) => {
    const { name } = req.body ?? {};
    if (typeof name !== 'string' || name.length === 0) throw new ApiError(400, 'body.name is required');
    const playlist = await playlistRepository.create((req as AuthenticatedRequest).user!.id, name);
    res.status(200).json({ id: playlist.id, name: playlist.name });
  }));

  router.get('/', auth, wrapAsync(async (req, res) => {
    const playlists = await playlistRepository.listByUser((req as AuthenticatedRequest).user!.id);
    res.status(200).json(playlists.map((p) => ({ id: p.id, name: p.name })));
  }));

  router.get('/:id', auth, wrapAsync(async (req, res) => {
    const playlist = await requireOwnedPlaylist(playlistRepository, req.params.id, (req as AuthenticatedRequest).user!.id);
    const tracks = await playlistRepository.listTracks(playlist.id);
    res.status(200).json({ id: playlist.id, name: playlist.name, tracks });
  }));

  router.put('/:id/tracks', auth, wrapAsync(async (req, res) => {
    const playlist = await requireOwnedPlaylist(playlistRepository, req.params.id, (req as AuthenticatedRequest).user!.id);
    const { trackIds } = req.body ?? {};
    if (!Array.isArray(trackIds) || !trackIds.every((id) => typeof id === 'string')) {
      throw new ApiError(400, 'body.trackIds must be an array of strings');
    }
    await playlistRepository.replaceTracks(playlist.id, trackIds);
    res.status(200).json({});
  }));

  router.delete('/:id', auth, wrapAsync(async (req, res) => {
    const playlist = await requireOwnedPlaylist(playlistRepository, req.params.id, (req as AuthenticatedRequest).user!.id);
    await playlistRepository.deleteById(playlist.id);
    res.status(200).json({});
  }));

  return router;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/playlists/playlistRoutes.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Run the full suite and build**

Run: `npx jest && npm run build`
Expected: all suites PASS, `tsc` clean

- [ ] **Step 6: Commit**

```bash
git add src/playlists/playlistRoutes.ts test/playlists/playlistRoutes.test.ts
git commit -m "feat: playlist REST routes"
```

---

### Task 6: Destination routes

**Files:**
- Create: `src/destinations/destinationRoutes.ts`
- Test: `test/destinations/destinationRoutes.test.ts`

**Interfaces:**
- Consumes: `DestinationRepository` (Task 3), `encrypt` (Task 2), `ApiError`, `wrapAsync`, `requireAuth`, `AuthenticatedRequest`, `AuthService`.
- Produces: `createDestinationRouter(authService, destinationRepository, encryptionKey: string): Router`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/destinations/destinationRoutes.test.ts
import express from 'express';
import request from 'supertest';
import { createDestinationRouter } from '../../src/destinations/destinationRoutes';
import { errorHandler } from '../../src/api/errorHandler';

const KEY = 'a'.repeat(64);

function buildApp(destinationRepository: any, userId = 'user-1') {
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: userId, email: 'a@example.com' }) };
  const app = express();
  app.use(express.json());
  app.use('/destinations', createDestinationRouter(authService, destinationRepository, KEY));
  app.use(errorHandler);
  return app;
}

describe('destination routes', () => {
  it('POST /destinations creates a destination with the stream key encrypted, and never echoes it back', async () => {
    const destinationRepository: any = {
      create: jest.fn(async (data: any) => ({ id: 'd1', ...data, provider: 'youtube', createdAt: new Date() })),
    };
    const res = await request(buildApp(destinationRepository)).post('/destinations').send({
      name: 'My YouTube', rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2', streamKey: 'abcd-1234',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'd1', name: 'My YouTube', rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2', provider: 'youtube' });
    expect(res.body.streamKey).toBeUndefined();
    expect(res.body.streamKeyEncrypted).toBeUndefined();

    const createArgs = destinationRepository.create.mock.calls[0][0];
    expect(createArgs.streamKeyEncrypted).not.toBe('abcd-1234');
    expect(createArgs.userId).toBe('user-1');
  });

  it('POST /destinations requires name, rtmpUrl, and streamKey', async () => {
    const destinationRepository: any = { create: jest.fn() };
    const res = await request(buildApp(destinationRepository)).post('/destinations').send({ name: 'X' });
    expect(res.status).toBe(400);
    expect(destinationRepository.create).not.toHaveBeenCalled();
  });

  it('GET /destinations never includes the encrypted key', async () => {
    const destinationRepository: any = {
      listByUser: jest.fn().mockResolvedValue([
        { id: 'd1', name: 'X', rtmpUrl: 'rtmp://x', provider: 'youtube', streamKeyEncrypted: 'secret-blob' },
      ]),
    };
    const res = await request(buildApp(destinationRepository)).get('/destinations');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'd1', name: 'X', rtmpUrl: 'rtmp://x', provider: 'youtube' }]);
  });

  it('DELETE /destinations/:id returns 403 for someone else\'s destination', async () => {
    const destinationRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'd1', userId: 'someone-else' }), deleteById: jest.fn() };
    const res = await request(buildApp(destinationRepository)).delete('/destinations/d1');
    expect(res.status).toBe(403);
    expect(destinationRepository.deleteById).not.toHaveBeenCalled();
  });

  it('DELETE /destinations/:id deletes an owned destination', async () => {
    const destinationRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'd1', userId: 'user-1' }), deleteById: jest.fn() };
    const res = await request(buildApp(destinationRepository)).delete('/destinations/d1');
    expect(res.status).toBe(200);
    expect(destinationRepository.deleteById).toHaveBeenCalledWith('d1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/destinations/destinationRoutes.test.ts`
Expected: FAIL — `Cannot find module '../../src/destinations/destinationRoutes'`

- [ ] **Step 3: Implement `src/destinations/destinationRoutes.ts`**

```ts
import { Router } from 'express';
import { DestinationRepository } from './destinationRepository';
import { encrypt } from '../crypto/streamKeyCipher';
import { ApiError } from '../errors';
import { wrapAsync } from '../api/errorHandler';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { AuthService } from '../auth/authService';

function toPublicDestination(d: { id: string; name: string; rtmpUrl: string; provider: string }) {
  return { id: d.id, name: d.name, rtmpUrl: d.rtmpUrl, provider: d.provider };
}

export function createDestinationRouter(
  authService: AuthService,
  destinationRepository: DestinationRepository,
  encryptionKey: string,
): Router {
  const router = Router();
  const auth = requireAuth(authService);

  router.post('/', auth, wrapAsync(async (req, res) => {
    const { name, rtmpUrl, streamKey } = req.body ?? {};
    if (typeof name !== 'string' || name.length === 0) throw new ApiError(400, 'body.name is required');
    if (typeof rtmpUrl !== 'string' || rtmpUrl.length === 0) throw new ApiError(400, 'body.rtmpUrl is required');
    if (typeof streamKey !== 'string' || streamKey.length === 0) throw new ApiError(400, 'body.streamKey is required');

    const destination = await destinationRepository.create({
      userId: (req as AuthenticatedRequest).user!.id,
      name,
      rtmpUrl,
      streamKeyEncrypted: encrypt(streamKey, encryptionKey),
    });
    res.status(200).json(toPublicDestination(destination));
  }));

  router.get('/', auth, wrapAsync(async (req, res) => {
    const destinations = await destinationRepository.listByUser((req as AuthenticatedRequest).user!.id);
    res.status(200).json(destinations.map(toPublicDestination));
  }));

  router.delete('/:id', auth, wrapAsync(async (req, res) => {
    const destination = await destinationRepository.findById(req.params.id);
    if (!destination) throw new ApiError(404, 'destination not found');
    if (destination.userId !== (req as AuthenticatedRequest).user!.id) throw new ApiError(403, 'not your destination');
    await destinationRepository.deleteById(destination.id);
    res.status(200).json({});
  }));

  return router;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/destinations/destinationRoutes.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the full suite and build**

Run: `npx jest && npm run build`
Expected: all suites PASS, `tsc` clean

- [ ] **Step 6: Commit**

```bash
git add src/destinations/destinationRoutes.ts test/destinations/destinationRoutes.test.ts
git commit -m "feat: stream destination REST routes"
```

---

### Task 7: StreamManager (per-destination stream registry)

**Files:**
- Modify: `src/stream/streamController.ts` (widen the `library` dependency's type — see below)
- Create: `src/stream/streamManager.ts`
- Test: `test/stream/streamManager.test.ts`

**Interfaces:**
- Consumes: `PlaylistQueue`, `Track` (existing), `SegmentFeeder`, `RtmpPusher`, `NowPlayingOverlay`, `createFifo`/`removeFifo`, `getAudioDurationSeconds`, `buildPlaylistWindowLines`, `Spawner` (all existing), `PlaylistRepository`, `DestinationRepository`, `TrackRepository` (Task 3), `decrypt` (Task 2), `ApiError`.
- Produces: `interface StreamManagerDeps { spawner; fifoDir: string; defaultCoverPath: string; backgroundImagePath: string; fontFile: string; playlistRepository; destinationRepository; trackRepository; }`, `class StreamManager { constructor(deps: StreamManagerDeps, encryptionKey: string); get(destinationId): StreamController | undefined; start(destinationId, playlistId): Promise<void>; stop(destinationId): Promise<void>; pause(destinationId): void; resume(destinationId): Promise<void>; next(destinationId): Promise<void>; previous(destinationId): Promise<void>; playByName(destinationId, name): void; status(destinationId): StreamStatus; }`

**Step 0 — widen `StreamController`'s `library` dependency type.** Currently `src/stream/streamController.ts` imports the concrete `Library` class from `../playlist/library` and types `StreamControllerDeps.library: Library`. `Library` is being deleted in Task 9 (it was the old disk-scanning class), and `StreamManager` needs to pass in a lightweight object, not a real `Library` instance. This is a **safe, backward-compatible widening**: change the type to a small structural interface that the real `Library` class already satisfies, so nothing that currently constructs a `StreamController` with a real `Library` breaks.

```ts
// in src/stream/streamController.ts — replace the Library import and the library field's type
export interface LibraryLike {
  list(): Track[];
  findByName(name: string): Track | undefined;
}

export interface StreamControllerDeps {
  library: LibraryLike; // was: library: Library (imported from '../playlist/library')
  // ...rest unchanged
}
```

Remove the `import { Library } from '../playlist/library';` line — nothing else in this file needs it. Do not change any other logic in this file. `test/stream/streamController.test.ts` already builds its `library` fake as a plain object (`{ list: jest.fn()..., findByName: jest.fn()... }`, typed via `deps: any`), so it needs no changes.

- [ ] **Step 1: Write the failing tests**

```ts
// test/stream/streamManager.test.ts
import { StreamManager } from '../../src/stream/streamManager';
import { ApiError } from '../../src/errors';
// A fixed, valid ciphertext isn't needed for real ffmpeg here (spawner is faked) —
// decrypt() is still exercised for real, against a real encrypt() output computed below.
import { encrypt } from '../../src/crypto/streamKeyCipher';

const KEY = 'a'.repeat(64);
const encryptFixture = encrypt('real-stream-key', KEY);

function fakeChild() {
  return { pid: 1, stdout: null, stderr: null, kill: jest.fn(), once: jest.fn() };
}

function buildDeps() {
  const spawner = jest.fn().mockReturnValue(fakeChild());
  const destinationRepository = {
    findById: jest.fn().mockResolvedValue({
      id: 'dest-1', userId: 'user-1', rtmpUrl: 'rtmp://example.com/live', streamKeyEncrypted: encryptFixture, provider: 'youtube',
    }),
  };
  const playlistRepository = {
    listTracks: jest.fn().mockResolvedValue([
      { name: 'a', audioPath: '/music/a.mp3', coverPath: null },
      { name: 'b', audioPath: '/music/b.mp3', coverPath: null },
    ]),
  };
  const trackRepository = {
    listByUser: jest.fn().mockResolvedValue([
      { name: 'a', audioPath: '/music/a.mp3', coverPath: null },
      { name: 'b', audioPath: '/music/b.mp3', coverPath: null },
      { name: 'c', audioPath: '/music/c.mp3', coverPath: null },
    ]),
  };
  return {
    deps: {
      spawner, fifoDir: '/tmp', defaultCoverPath: '/assets/default.png', backgroundImagePath: '/assets/bg.png',
      fontFile: '/fonts/x.ttf', playlistRepository, destinationRepository, trackRepository,
    },
    destinationRepository, playlistRepository, trackRepository,
  };
}

describe('StreamManager', () => {
  it('start() throws 404 for an unknown destination', async () => {
    const { deps, destinationRepository } = buildDeps();
    destinationRepository.findById.mockResolvedValue(null);
    const manager = new StreamManager(deps as any, KEY);
    await expect(manager.start('dest-1', 'playlist-1')).rejects.toThrow(ApiError);
  });

  it('start() throws 409 for an empty playlist', async () => {
    const { deps, playlistRepository } = buildDeps();
    playlistRepository.listTracks.mockResolvedValue([]);
    const manager = new StreamManager(deps as any, KEY);
    await expect(manager.start('dest-1', 'playlist-1')).rejects.toThrow('playlist is empty');
  });

  it('start() creates a controller reachable via get(), and status() reflects it', async () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any, KEY);

    await manager.start('dest-1', 'playlist-1');

    expect(manager.get('dest-1')).toBeDefined();
    expect(manager.status('dest-1').state).toBe('streaming');
    expect(manager.status('dest-1').currentTrack).toBe('a');
  });

  it('start() throws 409 if a stream is already active for that destination', async () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any, KEY);
    await manager.start('dest-1', 'playlist-1');
    await expect(manager.start('dest-1', 'playlist-1')).rejects.toThrow(ApiError);
  });

  it('status() returns a synthetic idle status when no controller exists for a destination', () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any, KEY);
    expect(manager.status('never-started')).toEqual({ state: 'idle', currentTrack: null, nextTrack: null });
  });

  it('pause()/next()/etc. throw 409 when no controller exists for a destination', async () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any, KEY);
    expect(() => manager.pause('never-started')).toThrow(ApiError);
    await expect(manager.next('never-started')).rejects.toThrow(ApiError);
  });

  it('stop() tears the controller down and removes it from the registry', async () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any, KEY);
    await manager.start('dest-1', 'playlist-1');

    await manager.stop('dest-1');

    expect(manager.get('dest-1')).toBeUndefined();
    expect(manager.status('dest-1')).toEqual({ state: 'idle', currentTrack: null, nextTrack: null });
  });

  it('playByName() finds a track across ALL of the owning user\'s tracks, not just the current playlist', async () => {
    const { deps } = buildDeps();
    const manager = new StreamManager(deps as any, KEY);
    await manager.start('dest-1', 'playlist-1');

    // 'c' is in trackRepository.listByUser's fixture but NOT in playlistRepository.listTracks' fixture
    expect(() => manager.playByName('dest-1', 'c')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/stream/streamManager.test.ts`
Expected: FAIL — `Cannot find module '../../src/stream/streamManager'`

- [ ] **Step 3: Apply Step 0's `streamController.ts` edit, then implement `src/stream/streamManager.ts`**

```ts
import { posix as path } from 'path';
import { PlaylistQueue } from '../playlist/queue';
import { Track } from '../playlist/types';
import { StreamController } from './streamController';
import { StreamStatus } from './types';
import { SegmentFeeder } from '../ffmpeg/segmentFeeder';
import { RtmpPusher } from '../ffmpeg/rtmpPusher';
import { NowPlayingOverlay } from '../ffmpeg/segmentArgs';
import { createFifo, removeFifo } from '../ffmpeg/fifo';
import { getAudioDurationSeconds } from '../ffmpeg/duration';
import { buildPlaylistWindowLines } from '../ffmpeg/overlayText';
import { Spawner } from '../ffmpeg/types';
import { ApiError } from '../errors';
import { PlaylistRepository } from '../playlists/playlistRepository';
import { DestinationRepository } from '../destinations/destinationRepository';
import { TrackRepository } from '../tracks/trackRepository';
import { decrypt } from '../crypto/streamKeyCipher';

const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 720;
const VIDEO_FPS = 30;
const PLAYLIST_WINDOW_BEFORE = 2;
const PLAYLIST_WINDOW_AFTER = 7;

export interface StreamManagerDeps {
  spawner: Spawner;
  fifoDir: string;
  defaultCoverPath: string;
  backgroundImagePath: string;
  fontFile: string;
  playlistRepository: Pick<PlaylistRepository, 'listTracks'>;
  destinationRepository: Pick<DestinationRepository, 'findById'>;
  trackRepository: Pick<TrackRepository, 'listByUser'>;
}

export class StreamManager {
  private readonly controllers = new Map<string, StreamController>();

  constructor(private readonly deps: StreamManagerDeps, private readonly encryptionKey: string) {}

  get(destinationId: string): StreamController | undefined {
    return this.controllers.get(destinationId);
  }

  async start(destinationId: string, playlistId: string): Promise<void> {
    if (this.controllers.has(destinationId)) {
      throw new ApiError(409, 'a stream is already active for this destination');
    }

    const destination = await this.deps.destinationRepository.findById(destinationId);
    if (!destination) throw new ApiError(404, 'destination not found');

    const tracks: Track[] = await this.deps.playlistRepository.listTracks(playlistId);
    if (tracks.length === 0) throw new ApiError(409, 'playlist is empty');

    const allUserTracksRaw = await this.deps.trackRepository.listByUser(destination.userId);
    const allUserTracks: Track[] = allUserTracksRaw.map((t) => ({ name: t.name, audioPath: t.audioPath, coverPath: t.coverPath }));

    const queue = new PlaylistQueue(tracks);
    const fifoPath = path.join(this.deps.fifoDir, `super-dj-stream-${destinationId}.fifo`);
    const rtmpUrl = destination.rtmpUrl;
    const streamKey = decrypt(destination.streamKeyEncrypted, this.encryptionKey);

    const buildOverlay = async (track: Track): Promise<NowPlayingOverlay> => {
      const currentIndex = tracks.findIndex((t) => t.name === track.name);
      return {
        title: track.name,
        playlistLines: buildPlaylistWindowLines(tracks, currentIndex, PLAYLIST_WINDOW_BEFORE, PLAYLIST_WINDOW_AFTER),
        durationSeconds: await getAudioDurationSeconds(track.audioPath),
      };
    };

    const controller = new StreamController({
      library: {
        list: () => tracks,
        findByName: (name: string) => allUserTracks.find((t) => t.name === name),
      },
      queue,
      fifoPath,
      createFifo,
      removeFifo,
      buildOverlay,
      createSegmentFeeder: () => new SegmentFeeder({
        spawner: this.deps.spawner,
        fifoPath,
        defaultCoverPath: this.deps.defaultCoverPath,
        backgroundPath: this.deps.backgroundImagePath,
        fontFile: this.deps.fontFile,
        width: VIDEO_WIDTH,
        height: VIDEO_HEIGHT,
        fps: VIDEO_FPS,
      }),
      createRtmpPusher: () => new RtmpPusher(this.deps.spawner, { fifoPath, rtmpUrl, streamKey }),
    });

    this.controllers.set(destinationId, controller);
    try {
      await controller.start();
    } catch (err) {
      this.controllers.delete(destinationId);
      throw err;
    }
  }

  async stop(destinationId: string): Promise<void> {
    this.requireController(destinationId).stop();
    this.controllers.delete(destinationId);
  }

  pause(destinationId: string): void {
    this.requireController(destinationId).pause();
  }

  resume(destinationId: string): Promise<void> {
    return this.requireController(destinationId).resume();
  }

  next(destinationId: string): Promise<void> {
    return this.requireController(destinationId).next();
  }

  previous(destinationId: string): Promise<void> {
    return this.requireController(destinationId).previous();
  }

  playByName(destinationId: string, name: string): void {
    this.requireController(destinationId).playByName(name);
  }

  status(destinationId: string): StreamStatus {
    const controller = this.controllers.get(destinationId);
    if (!controller) return { state: 'idle', currentTrack: null, nextTrack: null };
    return controller.status();
  }

  private requireController(destinationId: string): StreamController {
    const controller = this.controllers.get(destinationId);
    if (!controller) throw new ApiError(409, 'stream is not active');
    return controller;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/stream/streamManager.test.ts test/stream/streamController.test.ts`
Expected: PASS (9 new tests; existing `streamController.test.ts` still passes unmodified)

- [ ] **Step 5: Run the full suite and build**

Run: `npx jest && npm run build`
Expected: all suites PASS, `tsc` clean

- [ ] **Step 6: Commit**

```bash
git add src/stream/streamController.ts src/stream/streamManager.ts test/stream/streamManager.test.ts
git commit -m "feat: StreamManager — per-destination stream registry"
```

---

### Task 8: Per-destination stream routes

**Files:**
- Create: `src/stream/streamRoutes.ts`
- Test: `test/stream/streamRoutes.test.ts`

**Interfaces:**
- Consumes: `StreamManager` (Task 7), `DestinationRepository` (Task 3), `ApiError`, `wrapAsync`, `requireAuth`, `AuthenticatedRequest`, `AuthService`.
- Produces: `createStreamRouter(authService, streamManager, destinationRepository): Router` — mounted with `mergeParams: true` at `/destinations/:destinationId/stream`.

This is a **new** file at `src/stream/streamRoutes.ts` — it is not the same file as the existing `src/api/streamRoutes.ts` (which controls the old single-tenant, unauthenticated `/stream/*` and is deleted in Task 9).

- [ ] **Step 1: Write the failing tests**

```ts
// test/stream/streamRoutes.test.ts
import express from 'express';
import request from 'supertest';
import { createStreamRouter } from '../../src/stream/streamRoutes';
import { errorHandler } from '../../src/api/errorHandler';
import { ApiError } from '../../src/errors';

function buildApp(streamManager: any, destinationRepository: any, userId = 'user-1') {
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: userId, email: 'a@example.com' }) };
  const app = express();
  app.use(express.json());
  app.use('/destinations/:destinationId/stream', createStreamRouter(authService, streamManager, destinationRepository));
  app.use(errorHandler);
  return app;
}

function ownedDestination(userId = 'user-1') {
  return { findById: jest.fn().mockResolvedValue({ id: 'dest-1', userId }) };
}

describe('per-destination stream routes', () => {
  it('POST .../start requires playlistId in the body', async () => {
    const streamManager: any = { start: jest.fn() };
    const res = await request(buildApp(streamManager, ownedDestination())).post('/destinations/dest-1/stream/start').send({});
    expect(res.status).toBe(400);
    expect(streamManager.start).not.toHaveBeenCalled();
  });

  it('POST .../start calls streamManager.start with the destination and playlist ids', async () => {
    const streamManager: any = { start: jest.fn().mockResolvedValue(undefined), status: jest.fn().mockReturnValue({ state: 'streaming', currentTrack: 'a', nextTrack: 'b' }) };
    const res = await request(buildApp(streamManager, ownedDestination())).post('/destinations/dest-1/stream/start').send({ playlistId: 'p1' });
    expect(res.status).toBe(200);
    expect(streamManager.start).toHaveBeenCalledWith('dest-1', 'p1');
    expect(res.body).toEqual({ state: 'streaming', currentTrack: 'a', nextTrack: 'b' });
  });

  it('returns 403 for a destination owned by someone else', async () => {
    const streamManager: any = { start: jest.fn() };
    const res = await request(buildApp(streamManager, ownedDestination('someone-else'))).post('/destinations/dest-1/stream/start').send({ playlistId: 'p1' });
    expect(res.status).toBe(403);
    expect(streamManager.start).not.toHaveBeenCalled();
  });

  it('returns 404 for a destination that does not exist', async () => {
    const streamManager: any = { start: jest.fn() };
    const destinationRepository: any = { findById: jest.fn().mockResolvedValue(null) };
    const res = await request(buildApp(streamManager, destinationRepository)).post('/destinations/dest-1/stream/start').send({ playlistId: 'p1' });
    expect(res.status).toBe(404);
  });

  it('POST .../next maps a 409 ApiError from the manager', async () => {
    const streamManager: any = { next: jest.fn().mockRejectedValue(new ApiError(409, 'stream is not active')) };
    const res = await request(buildApp(streamManager, ownedDestination())).post('/destinations/dest-1/stream/next');
    expect(res.status).toBe(409);
  });

  it('POST .../play requires name in the body', async () => {
    const streamManager: any = { playByName: jest.fn() };
    const res = await request(buildApp(streamManager, ownedDestination())).post('/destinations/dest-1/stream/play').send({});
    expect(res.status).toBe(400);
    expect(streamManager.playByName).not.toHaveBeenCalled();
  });

  it('GET .../status returns the manager\'s status for this destination', async () => {
    const streamManager: any = { status: jest.fn().mockReturnValue({ state: 'idle', currentTrack: null, nextTrack: null }) };
    const res = await request(buildApp(streamManager, ownedDestination())).get('/destinations/dest-1/stream/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: 'idle', currentTrack: null, nextTrack: null });
    expect(streamManager.status).toHaveBeenCalledWith('dest-1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/stream/streamRoutes.test.ts`
Expected: FAIL — `Cannot find module '../../src/stream/streamRoutes'`

- [ ] **Step 3: Implement `src/stream/streamRoutes.ts`**

```ts
import { Router } from 'express';
import { StreamManager } from './streamManager';
import { DestinationRepository } from '../destinations/destinationRepository';
import { ApiError } from '../errors';
import { wrapAsync } from '../api/errorHandler';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { AuthService } from '../auth/authService';

async function requireOwnedDestination(
  destinationRepository: Pick<DestinationRepository, 'findById'>,
  destinationId: string,
  userId: string,
): Promise<void> {
  const destination = await destinationRepository.findById(destinationId);
  if (!destination) throw new ApiError(404, 'destination not found');
  if (destination.userId !== userId) throw new ApiError(403, 'not your destination');
}

export function createStreamRouter(
  authService: AuthService,
  streamManager: StreamManager,
  destinationRepository: Pick<DestinationRepository, 'findById'>,
): Router {
  const router = Router({ mergeParams: true });
  const auth = requireAuth(authService);
  const userId = (req: AuthenticatedRequest) => req.user!.id;

  router.post('/start', auth, wrapAsync(async (req, res) => {
    const destinationId = req.params.destinationId;
    await requireOwnedDestination(destinationRepository, destinationId, userId(req as AuthenticatedRequest));
    const { playlistId } = req.body ?? {};
    if (typeof playlistId !== 'string' || playlistId.length === 0) throw new ApiError(400, 'body.playlistId is required');
    await streamManager.start(destinationId, playlistId);
    res.status(200).json(streamManager.status(destinationId));
  }));

  router.post('/stop', auth, wrapAsync(async (req, res) => {
    const destinationId = req.params.destinationId;
    await requireOwnedDestination(destinationRepository, destinationId, userId(req as AuthenticatedRequest));
    await streamManager.stop(destinationId);
    res.status(200).json(streamManager.status(destinationId));
  }));

  router.post('/pause', auth, wrapAsync(async (req, res) => {
    const destinationId = req.params.destinationId;
    await requireOwnedDestination(destinationRepository, destinationId, userId(req as AuthenticatedRequest));
    streamManager.pause(destinationId);
    res.status(200).json(streamManager.status(destinationId));
  }));

  router.post('/resume', auth, wrapAsync(async (req, res) => {
    const destinationId = req.params.destinationId;
    await requireOwnedDestination(destinationRepository, destinationId, userId(req as AuthenticatedRequest));
    await streamManager.resume(destinationId);
    res.status(200).json(streamManager.status(destinationId));
  }));

  router.post('/next', auth, wrapAsync(async (req, res) => {
    const destinationId = req.params.destinationId;
    await requireOwnedDestination(destinationRepository, destinationId, userId(req as AuthenticatedRequest));
    await streamManager.next(destinationId);
    res.status(200).json(streamManager.status(destinationId));
  }));

  router.post('/previous', auth, wrapAsync(async (req, res) => {
    const destinationId = req.params.destinationId;
    await requireOwnedDestination(destinationRepository, destinationId, userId(req as AuthenticatedRequest));
    await streamManager.previous(destinationId);
    res.status(200).json(streamManager.status(destinationId));
  }));

  router.post('/play', auth, wrapAsync(async (req, res) => {
    const destinationId = req.params.destinationId;
    await requireOwnedDestination(destinationRepository, destinationId, userId(req as AuthenticatedRequest));
    const { name } = req.body ?? {};
    if (typeof name !== 'string' || name.length === 0) throw new ApiError(400, 'body.name is required');
    streamManager.playByName(destinationId, name);
    res.status(200).json(streamManager.status(destinationId));
  }));

  router.get('/status', auth, wrapAsync(async (req, res) => {
    const destinationId = req.params.destinationId;
    await requireOwnedDestination(destinationRepository, destinationId, userId(req as AuthenticatedRequest));
    res.status(200).json(streamManager.status(destinationId));
  }));

  return router;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/stream/streamRoutes.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Run the full suite and build**

Run: `npx jest && npm run build`
Expected: all suites PASS, `tsc` clean

- [ ] **Step 6: Commit**

```bash
git add src/stream/streamRoutes.ts test/stream/streamRoutes.test.ts
git commit -m "feat: per-destination stream control routes"
```

---

### Task 9: Cutover — remove the old single-tenant surface, wire everything

This is the one task in this plan that removes code rather than only adding it. Every piece it depends on (Tasks 1–8) already exists and is independently tested. This task's job is composition-root surgery: delete what's obsolete, wire what's new.

**Files:**
- Delete: `src/playlist/library.ts`, `test/playlist/library.test.ts`, `src/api/streamRoutes.ts`, `test/api/streamRoutes.test.ts`, `src/api/libraryRoutes.ts`, `test/api/libraryRoutes.test.ts`
- Modify: `src/config/env.ts`, `test/config/env.test.ts` (remove `rtmpUrl`/`streamKey`/`audioDir`/`fifoPath`)
- Modify: `src/api/app.ts`
- Modify: `src/server.ts`
- Modify: `src/main.ts`
- Modify: `src/api/openapi.ts`
- Modify: `test/api/openapi.test.ts`, `test/server.test.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 1–8.
- Produces: `AppConfig` loses `rtmpUrl`/`streamKey`/`audioDir`/`fifoPath`; `AppDeps` (in `app.ts`) drops `streamController`/`library`/`queue`, gains `streamManager`, `trackRepository`, `playlistRepository`, `destinationRepository`, `authService` (already had `authService`); `buildServer(...)` return value drops `library`/`queue`/`streamController`, gains `streamManager`.

- [ ] **Step 1: Remove `rtmpUrl`/`streamKey`/`audioDir`/`fifoPath` from `AppConfig`**

In `src/config/env.ts`, remove those four fields and their validation/defaults from `AppConfig`/`loadConfig`. The resulting shape:

```ts
export interface AppConfig {
  port: number;
  defaultCoverPath: string;
  backgroundImagePath: string;
  databaseUrl: string;
  sessionTtlDays: number;
  uploadsDir: string;
  streamKeyEncryptionKey: string;
  fifoDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  const streamKeyEncryptionKey = env.STREAM_KEY_ENCRYPTION_KEY;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  if (!streamKeyEncryptionKey) {
    throw new Error('STREAM_KEY_ENCRYPTION_KEY environment variable is required');
  }

  return {
    port: env.PORT ? parseInt(env.PORT, 10) : 3000,
    defaultCoverPath: env.DEFAULT_COVER_PATH ?? path.join(process.cwd(), 'assets', 'default-cover.png'),
    backgroundImagePath: env.BACKGROUND_IMAGE_PATH ?? path.join(process.cwd(), 'assets', 'background.png'),
    databaseUrl,
    sessionTtlDays: env.SESSION_TTL_DAYS ? parseInt(env.SESSION_TTL_DAYS, 10) : 30,
    uploadsDir: env.UPLOADS_DIR ?? '/data/uploads',
    streamKeyEncryptionKey,
    fifoDir: env.FIFO_DIR ?? '/tmp',
  };
}
```

Update `test/config/env.test.ts`: remove every test/fixture reference to `RTMP_URL`/`STREAM_KEY`/`AUDIO_DIR`/`FIFO_PATH` (both the "throws when missing" tests for `RTMP_URL`/`STREAM_KEY`, and every `base`/override fixture object's use of those keys). Keep the `DATABASE_URL`/`STREAM_KEY_ENCRYPTION_KEY` required-field tests and the `uploadsDir`/`fifoDir`/`sessionTtlDays` default/override tests from Task 1.

- [ ] **Step 2: Delete the old single-tenant files**

```bash
git rm src/playlist/library.ts test/playlist/library.test.ts src/api/streamRoutes.ts test/api/streamRoutes.test.ts src/api/libraryRoutes.ts test/api/libraryRoutes.test.ts
```

- [ ] **Step 3: Rewrite `src/api/app.ts`**

```ts
import express, { Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import { AuthService } from '../auth/authService';
import { createAuthRouter } from '../auth/authRoutes';
import { TrackRepository } from '../tracks/trackRepository';
import { TrackUploadService } from '../tracks/trackUploadService';
import { createTrackRouter } from '../tracks/trackRoutes';
import { PlaylistRepository } from '../playlists/playlistRepository';
import { createPlaylistRouter } from '../playlists/playlistRoutes';
import { DestinationRepository } from '../destinations/destinationRepository';
import { createDestinationRouter } from '../destinations/destinationRoutes';
import { StreamManager } from '../stream/streamManager';
import { createStreamRouter } from '../stream/streamRoutes';
import { errorHandler } from './errorHandler';
import { openApiSpec } from './openapi';

export interface AppDeps {
  authService: AuthService;
  trackRepository: TrackRepository;
  trackUploadService: TrackUploadService;
  playlistRepository: PlaylistRepository;
  destinationRepository: DestinationRepository;
  destinationEncryptionKey: string;
  streamManager: StreamManager;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json());
  app.use('/auth', createAuthRouter(deps.authService));
  app.use('/tracks', createTrackRouter(deps.authService, deps.trackUploadService, deps.trackRepository));
  app.use('/playlists', createPlaylistRouter(deps.authService, deps.playlistRepository));
  app.use('/destinations', createDestinationRouter(deps.authService, deps.destinationRepository, deps.destinationEncryptionKey));
  app.use('/destinations/:destinationId/stream', createStreamRouter(deps.authService, deps.streamManager, deps.destinationRepository));
  app.get('/openapi.json', (_req, res) => res.json(openApiSpec));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
  app.use(errorHandler);
  return app;
}
```

- [ ] **Step 4: Rewrite `src/server.ts`**

Read the current file first for the exact `createSpawner` helper (keep it verbatim — it isn't affected by this cutover) and the `FONT_FILE` constant. Replace the `Library`/`PlaylistQueue`/`StreamController` construction with the multi-tenant wiring:

```ts
import { spawn } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { AppConfig } from './config/env';
import { UserRepository } from './auth/userRepository';
import { SessionRepository } from './auth/sessionRepository';
import { AuthService } from './auth/authService';
import { TrackRepository } from './tracks/trackRepository';
import { TrackUploadService } from './tracks/trackUploadService';
import { PlaylistRepository } from './playlists/playlistRepository';
import { DestinationRepository } from './destinations/destinationRepository';
import { StreamManager } from './stream/streamManager';
import { Spawner, ChildProcessLike } from './ffmpeg/types';
import { createApp } from './api/app';

const FONT_FILE = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

export function createSpawner(): Spawner {
  return (command: string, args: string[]): ChildProcessLike => {
    const child = spawn(command, args);
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    return child as unknown as ChildProcessLike;
  };
}

export function buildServer(config: AppConfig, spawner: Spawner = createSpawner()) {
  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });

  const userRepository = new UserRepository(prisma);
  const sessionRepository = new SessionRepository(prisma);
  const authService = new AuthService({ userRepository, sessionRepository, sessionTtlDays: config.sessionTtlDays });

  const trackRepository = new TrackRepository(prisma);
  const trackUploadService = new TrackUploadService({ trackRepository, uploadsDir: config.uploadsDir });
  const playlistRepository = new PlaylistRepository(prisma);
  const destinationRepository = new DestinationRepository(prisma);

  const streamManager = new StreamManager({
    spawner,
    fifoDir: config.fifoDir,
    defaultCoverPath: config.defaultCoverPath,
    backgroundImagePath: config.backgroundImagePath,
    fontFile: FONT_FILE,
    playlistRepository,
    destinationRepository,
    trackRepository,
  }, config.streamKeyEncryptionKey);

  const app = createApp({
    authService,
    trackRepository,
    trackUploadService,
    playlistRepository,
    destinationRepository,
    destinationEncryptionKey: config.streamKeyEncryptionKey,
    streamManager,
  });

  return { app, prisma };
}
```

- [ ] **Step 5: Rewrite `src/main.ts`**

Remove the `library.scan()`/`queue.setTracks()` boot-time calls (there is no more global library/queue). Keep the `prisma.$connect()` fail-fast and the existing SIGTERM/SIGINT shutdown handler's shape, but it no longer needs to call `streamController.stop()` (there's no single global controller anymore — an in-flight per-destination stream will simply be killed along with the process; this is an accepted simplification for this phase, matching how the FIFO/child ffmpeg processes are already not orphan-tracked across restarts).

```ts
import { loadConfig } from './config/env';
import { buildServer } from './server';

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, prisma } = buildServer(config);

  await prisma.$connect();

  const server = app.listen(config.port, () => {
    console.log(`super-dj listening on port ${config.port}`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await prisma.$disconnect();
    } catch (err) {
      console.error('error disconnecting from the database during shutdown', err);
    }
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', () => shutdown());
  process.on('SIGINT', () => shutdown());
}

main().catch((err) => {
  console.error('failed to start super-dj', err);
  process.exit(1);
});
```

- [ ] **Step 6: Rewrite `test/server.test.ts`**

The old tests exercised the global `/stream/status`/`/stream/start`. Replace with tests appropriate to the new `buildServer` shape:

```ts
import request from 'supertest';
import { buildServer } from '../src/server';
import { AppConfig } from '../src/config/env';
import { Spawner, ChildProcessLike } from '../src/ffmpeg/types';
import { PassThrough } from 'stream';

function fakeSpawner(): Spawner {
  return jest.fn().mockImplementation((): ChildProcessLike => ({
    pid: 1, stdout: new PassThrough(), stderr: null, kill: jest.fn(), once: jest.fn(),
  }));
}

const config: AppConfig = {
  port: 3000,
  defaultCoverPath: '/assets/default-cover.png',
  backgroundImagePath: '/assets/background.png',
  databaseUrl: 'postgresql://u:p@localhost:5432/db',
  sessionTtlDays: 30,
  uploadsDir: '/uploads',
  streamKeyEncryptionKey: 'a'.repeat(64),
  fifoDir: '/tmp',
};

describe('buildServer', () => {
  it('wires an app that responds to a request without touching the database (no live Postgres needed for this check)', async () => {
    const { app } = buildServer(config, fakeSpawner());
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);
  });

  it('requires authentication for the new resource routes', async () => {
    const { app } = buildServer(config, fakeSpawner());
    const res = await request(app).get('/tracks');
    expect(res.status).toBe(401);
  });
});
```

(`PrismaClient` is lazy — constructing it inside `buildServer` never actually connects until a query runs, so these two tests don't need a real Postgres.)

- [ ] **Step 7: Update `src/api/openapi.ts`**

Remove every `/stream/*` and `/library/*` path and the `Track`/`StreamStatus` schema entries that only existed for the old surface (keep `User` from the auth phase). Add paths for the new surface, following the file's existing style: `POST/GET /tracks`, `DELETE /tracks/{id}`, `POST/GET /playlists`, `GET /playlists/{id}`, `PUT /playlists/{id}/tracks`, `DELETE /playlists/{id}`, `POST/GET /destinations`, `DELETE /destinations/{id}`, and `POST /destinations/{id}/stream/{start,stop,pause,resume,next,previous,play}` + `GET /destinations/{id}/stream/status`. Read the current file first and follow its existing patterns for `requestBody`/`responses`/`components.schemas` — this step doesn't need to be exhaustive on every schema field, but every path must be present so `/docs` accurately reflects the running API.

- [ ] **Step 8: Fix `test/api/openapi.test.ts`**

It currently builds a fake `authService`/`library`/`queue`/`streamController` and calls `createApp(...)`. Update its `buildApp()` helper to match the new `AppDeps` shape (fake `authService`, `trackRepository`, `trackUploadService`, `playlistRepository`, `destinationRepository`, `destinationEncryptionKey: 'a'.repeat(64)`, `streamManager`), and update its assertion to check for a path that actually exists now, e.g. `/tracks` instead of `/stream/start`.

- [ ] **Step 9: Run the full suite and build**

Run: `npx jest && npm run build`
Expected: all suites PASS, `tsc` clean. This is the single most important checkpoint in this task — it proves the cutover didn't silently drop or break anything the other 8 tasks built.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: cut over to multi-tenant streaming, remove single-tenant Library/streamRoutes/libraryRoutes"
```

---

### Task 10: Docker / infra for uploads and the new migration

**Files:**
- Modify: `docker-compose.yml`
- Modify: `Dockerfile` (only if the `assets`/`prisma` COPY steps need adjustment — likely no change needed, verify)
- Create: `prisma/migrations/<timestamp>_multitenant/migration.sql` (and update `migration_lock.toml` if needed — it should already exist from the DB+auth phase)

**Interfaces:**
- Consumes: `prisma/schema.prisma` (Task 1), `UPLOADS_DIR`/`STREAM_KEY_ENCRYPTION_KEY`/`FIFO_DIR` config (Task 1), the removal of `RTMP_URL`/`STREAM_KEY`/`AUDIO_DIR`/`FIFO_PATH` (Task 9).

- [ ] **Step 1: Modify `docker-compose.yml`**

Read the current file first (it has the DB+auth phase's `postgres` service with a healthcheck, and the `super-dj` service's env/volumes from the streaming phase). Update the `super-dj` service's `environment` block — remove `RTMP_URL`/`STREAM_KEY`/`AUDIO_DIR`, add `UPLOADS_DIR: /data/uploads`, `STREAM_KEY_ENCRYPTION_KEY: ${STREAM_KEY_ENCRYPTION_KEY}`, `FIFO_DIR: /tmp`. Replace the old `./music:/data/audio:ro` volume with `uploads-data:/data/uploads` (read-write now, since tracks are uploaded through the app, not provided by the operator). Add `uploads-data` to the top-level `volumes:` block alongside the existing `postgres-data`.

- [ ] **Step 2: Verify the Dockerfile needs no change**

Read the current `Dockerfile`. It should already `COPY assets ./assets` and generate the Prisma client in the build stage from Task 1's/the DB+auth phase's changes — nothing in this task's code changes requires new system packages or build steps. If you find something that does need adjusting (e.g. a hardcoded reference to `AUDIO_DIR`), fix it; otherwise leave the file untouched and say so in your report.

- [ ] **Step 3: Generate the migration for the new models**

Follow the exact same procedure used for the DB+auth phase's migration (documented in that plan and in `CLAUDE.md`'s persistence section): no local Docker daemon is available, so use temporary, self-cleaning Docker resources on the remote host at `192.168.14.26` (passwordless SSH) — a throwaway Postgres container on an isolated docker network, a throwaway Node container running `npx prisma migrate dev --name multitenant --skip-generate` against it (mounting only `prisma/schema.prisma` + `package.json`/`package-lock.json`), then copy the resulting `prisma/migrations/<timestamp>_multitenant/` directory back into this repo and tear down every temporary resource. Do not touch, stop, or inspect anything already running on that host. If this is genuinely blocked, report BLOCKED with specifics rather than hand-writing migration SQL.

Verify the generated SQL creates `Track`, `Playlist`, `PlaylistTrack`, `StreamDestination` tables matching `schema.prisma`, plus the three new foreign keys on `User`, before committing.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml Dockerfile prisma/migrations
git commit -m "chore: uploads volume, updated env vars, and multi-tenant Prisma migration"
```

---

## Self-Review Notes

- **Spec coverage:** the data model, per-destination stream registry, file upload with cached duration, encrypted stream keys never echoed back, ownership checks (403 vs 404), the "playlist snapshot at start, not live" rule, and the full removal of the old single-tenant surface each map to a task above.
- **Sequencing fix during drafting:** an earlier draft tried to remove `Library`/old config fields in Task 1 alongside adding the new ones, which would have broken `server.ts`'s still-untouched old wiring immediately and left the build red for 8 tasks. Restructured so Tasks 1–8 are purely additive (old and new code coexist, each independently tested) and Task 9 is the single, deliberate cutover — matching the same pattern used for the DB+auth phase's `app.ts`/`server.ts` merge.
- **Type-compatibility fix during drafting:** `StreamController`'s `library: Library` dependency referenced the concrete class being deleted in Task 9, but `StreamManager` (Task 7) needs to pass in a lightweight adapter object, not a real `Library` instance. Resolved by widening the type to a small `LibraryLike` structural interface in Task 7 itself — a safe, backward-compatible change (the real `Library` class already satisfies it, and the existing test fake already uses a plain object) that doesn't wait for the Task 9 cutover.
- **Scope-correctness fix during drafting:** `POST .../stream/play` initially would have searched only the currently-streaming playlist for the named track, but the spec requires searching across the destination-owning user's entire track library (matching the old single-tenant `Library.findByName` behavior). `StreamManager.start()` now fetches both the playlist snapshot (for playback and the overlay window) and the full user track list (for `findByName`) as two separate, correctly-scoped sources.
- **Cross-task interface check:** `TrackRepository`/`PlaylistRepository`/`DestinationRepository` (Task 3) are consumed via `Pick<...>` structural subsets in `TrackUploadService` (Task 4) and `StreamManager` (Task 7), so tests never need a real Prisma-backed instance — verified the field/method names line up exactly at each consumption site.
