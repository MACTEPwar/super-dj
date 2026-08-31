# Autonomous YouTube Streamer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Node.js/TypeScript service that streams a local audio playlist to YouTube Live continuously via a persistent ffmpeg RTMP process, controlled by a REST API (start/stop/pause/resume/next/previous/play-by-name/rescan) without ever restarting the RTMP connection.

**Architecture:** A persistent `RtmpPusher` ffmpeg process reads a named pipe (FIFO) and copies it straight to YouTube RTMP (`-c copy`). A `SegmentFeeder` spawns short-lived ffmpeg producer processes (one per track or pause) that transcode audio+cover into MPEG-TS segments and write their bytes into the FIFO; MPEG-TS segments concatenate byte-wise, so switching what is fed does not interrupt the RTMP stream. `StreamController` is a state machine (`idle`/`streaming`/`paused`/`error`) that wires `PlaylistQueue` (queue/history/insert-next) and `Library` (directory scan) to the feeder/pusher. Express exposes this over REST with Swagger/OpenAPI docs.

**Tech Stack:** Node.js, TypeScript, Express, ffmpeg (spawned as a child process), Jest + ts-jest + supertest, swagger-ui-express, Docker.

**Spec:** [docs/superpowers/specs/2026-08-31-autonomous-youtube-streamer-design.md](../specs/2026-08-31-autonomous-youtube-streamer-design.md)

## Global Constraints

- FIFO architecture only — the concat-demuxer MVP from the original `CLAUDE.md` plan is not implemented.
- No authentication on the REST API in v1.
- State is in-memory only; no persistence, no auto-recovery after a restart.
- Exactly one stream session at a time (design must not make future multi-session support structurally impossible, but only one session is built/tested).
- `RTMP_URL` and `STREAM_KEY` are required env vars with no defaults; the service must refuse to start a stream without them.
- Library scan order is alphabetical by filename; rescanning happens only on explicit `POST /library/rescan`.
- Pause is silence + splash fed into the FIFO — never a stop/restart of the RTMP connection.
- `play-by-name` inserts the track as "next" in the queue; it does not switch immediately.
- `previous` at the start of history is idempotent (stays on the current track, no error).
- REST API must ship with Swagger/OpenAPI documentation.
- All filesystem paths inside `Library`/ffmpeg argument builders are built with POSIX semantics (`path.posix`), since the deployment target is always Linux and this keeps unit tests deterministic across dev OSes.

---

### Task 1: Project scaffolding & tooling

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `jest.config.js`
- Create: `.gitignore`
- Create: `.dockerignore`
- Test: `test/sanity.test.ts`

**Interfaces:**
- Produces: npm scripts `build` (tsc), `test` (jest), `start` (node dist/main.js); TypeScript compiles `src/**/*.ts` → `dist/`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "super-dj",
  "version": "0.1.0",
  "private": true,
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/main.js",
    "test": "jest"
  },
  "dependencies": {
    "express": "^4.19.2",
    "swagger-ui-express": "^5.0.1"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/jest": "^29.5.12",
    "@types/node": "^20.14.10",
    "@types/supertest": "^6.0.2",
    "@types/swagger-ui-express": "^4.1.6",
    "jest": "^29.7.0",
    "supertest": "^7.0.0",
    "ts-jest": "^29.1.5",
    "typescript": "^5.5.3"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "CommonJS",
    "moduleResolution": "node",
    "lib": ["ES2020"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 4: Create `jest.config.js`**

```js
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
};
```

- [ ] **Step 5: Create `.gitignore` and `.dockerignore`**

`.gitignore`:
```
node_modules/
dist/
*.log
.env
```

`.dockerignore`:
```
node_modules
dist
test
docs
.git
```

- [ ] **Step 6: Write the sanity test**

```ts
// test/sanity.test.ts
describe('sanity', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 7: Run the test suite and verify it passes**

Run: `npx jest`
Expected: 1 suite, 1 test, PASS

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json jest.config.js .gitignore .dockerignore test/sanity.test.ts
git commit -m "chore: project scaffolding (TypeScript, Jest)"
```

---

### Task 2: Config loader

**Files:**
- Create: `src/config/env.ts`
- Test: `test/config/env.test.ts`

**Interfaces:**
- Produces: `loadConfig(env?: NodeJS.ProcessEnv): AppConfig`, `interface AppConfig { port: number; rtmpUrl: string; streamKey: string; audioDir: string; defaultCoverPath: string; fifoPath: string; }`

- [ ] **Step 1: Write the failing tests**

```ts
// test/config/env.test.ts
import { loadConfig } from '../../src/config/env';

describe('loadConfig', () => {
  const base = { RTMP_URL: 'rtmp://example.com/live', STREAM_KEY: 'key123' } as NodeJS.ProcessEnv;

  it('throws when RTMP_URL is missing', () => {
    expect(() => loadConfig({ STREAM_KEY: 'key123' } as NodeJS.ProcessEnv))
      .toThrow('RTMP_URL environment variable is required');
  });

  it('throws when STREAM_KEY is missing', () => {
    expect(() => loadConfig({ RTMP_URL: 'rtmp://example.com/live' } as NodeJS.ProcessEnv))
      .toThrow('STREAM_KEY environment variable is required');
  });

  it('applies defaults for optional values', () => {
    const config = loadConfig(base);
    expect(config.port).toBe(3000);
    expect(config.audioDir).toBe('/data/audio');
    expect(config.fifoPath).toBe('/tmp/super-dj-stream.fifo');
  });

  it('honors overrides', () => {
    const config = loadConfig({ ...base, PORT: '8080', AUDIO_DIR: '/music', FIFO_PATH: '/tmp/x.fifo' } as NodeJS.ProcessEnv);
    expect(config.port).toBe(8080);
    expect(config.audioDir).toBe('/music');
    expect(config.fifoPath).toBe('/tmp/x.fifo');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/config/env.test.ts`
Expected: FAIL — `Cannot find module '../../src/config/env'`

- [ ] **Step 3: Implement `src/config/env.ts`**

```ts
import { posix as path } from 'path';

export interface AppConfig {
  port: number;
  rtmpUrl: string;
  streamKey: string;
  audioDir: string;
  defaultCoverPath: string;
  fifoPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rtmpUrl = env.RTMP_URL;
  const streamKey = env.STREAM_KEY;

  if (!rtmpUrl) {
    throw new Error('RTMP_URL environment variable is required');
  }
  if (!streamKey) {
    throw new Error('STREAM_KEY environment variable is required');
  }

  return {
    port: env.PORT ? parseInt(env.PORT, 10) : 3000,
    rtmpUrl,
    streamKey,
    audioDir: env.AUDIO_DIR ?? '/data/audio',
    defaultCoverPath: env.DEFAULT_COVER_PATH ?? path.join(process.cwd(), 'assets', 'default-cover.png'),
    fifoPath: env.FIFO_PATH ?? '/tmp/super-dj-stream.fifo',
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/config/env.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts test/config/env.test.ts
git commit -m "feat: env-based config loader"
```

---

### Task 3: Track types & Library

**Files:**
- Create: `src/playlist/types.ts`
- Create: `src/playlist/library.ts`
- Test: `test/playlist/library.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface Track { name: string; audioPath: string; coverPath: string | null; }`, `class Library { constructor(audioDir: string, defaultCoverPath: string); scan(): Promise<Track[]>; list(): Track[]; findByName(name: string): Track | undefined; }`

- [ ] **Step 1: Write the failing tests**

```ts
// test/playlist/library.test.ts
import { Library } from '../../src/playlist/library';
import * as fs from 'fs/promises';

jest.mock('fs/promises');
const mockedReaddir = fs.readdir as jest.MockedFunction<typeof fs.readdir>;

describe('Library', () => {
  beforeEach(() => {
    mockedReaddir.mockReset();
  });

  it('scans audio files sorted alphabetically with matching covers', async () => {
    mockedReaddir.mockResolvedValue(['b.mp3', 'a.mp3', 'a.png', 'readme.txt'] as any);
    const library = new Library('/music', '/assets/default.png');

    const tracks = await library.scan();

    expect(tracks.map((t) => t.name)).toEqual(['a', 'b']);
    expect(tracks[0].coverPath).toBe('/music/a.png');
    expect(tracks[1].coverPath).toBeNull();
  });

  it('findByName returns the matching track after scan', async () => {
    mockedReaddir.mockResolvedValue(['song.mp3'] as any);
    const library = new Library('/music', '/assets/default.png');
    await library.scan();

    expect(library.findByName('song')?.audioPath).toBe('/music/song.mp3');
    expect(library.findByName('missing')).toBeUndefined();
  });

  it('list returns an empty array before scan', () => {
    const library = new Library('/music', '/assets/default.png');
    expect(library.list()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/playlist/library.test.ts`
Expected: FAIL — `Cannot find module '../../src/playlist/library'`

- [ ] **Step 3: Implement `src/playlist/types.ts`**

```ts
export interface Track {
  name: string;
  audioPath: string;
  coverPath: string | null;
}
```

- [ ] **Step 4: Implement `src/playlist/library.ts`**

```ts
import * as fs from 'fs/promises';
import { posix as path } from 'path';
import { Track } from './types';

const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.flac', '.m4a'];
const COVER_EXTENSIONS = ['.jpg', '.jpeg', '.png'];

export class Library {
  private tracks: Track[] = [];

  constructor(private readonly audioDir: string, private readonly defaultCoverPath: string) {}

  async scan(): Promise<Track[]> {
    const entries = await fs.readdir(this.audioDir);

    const audioFiles = entries
      .filter((entry) => AUDIO_EXTENSIONS.includes(path.extname(entry).toLowerCase()))
      .sort((a, b) => a.localeCompare(b));

    this.tracks = audioFiles.map((file) => {
      const base = path.basename(file, path.extname(file));
      const coverFile = COVER_EXTENSIONS
        .map((ext) => base + ext)
        .find((candidate) => entries.includes(candidate));

      return {
        name: base,
        audioPath: path.join(this.audioDir, file),
        coverPath: coverFile ? path.join(this.audioDir, coverFile) : null,
      };
    });

    return this.tracks;
  }

  list(): Track[] {
    return this.tracks;
  }

  findByName(name: string): Track | undefined {
    return this.tracks.find((track) => track.name === name);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest test/playlist/library.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/playlist/types.ts src/playlist/library.ts test/playlist/library.test.ts
git commit -m "feat: library directory scanning"
```

---

### Task 4: PlaylistQueue

**Files:**
- Create: `src/playlist/queue.ts`
- Test: `test/playlist/queue.test.ts`

**Interfaces:**
- Consumes: `Track` from `src/playlist/types.ts` (Task 3).
- Produces: `class PlaylistQueue { constructor(tracks: Track[]); current(): Track | undefined; peekNext(): Track | undefined; next(): Track | undefined; previous(): Track | undefined; insertNext(track: Track): void; setTracks(tracks: Track[]): void; }`

- [ ] **Step 1: Write the failing tests**

```ts
// test/playlist/queue.test.ts
import { PlaylistQueue } from '../../src/playlist/queue';
import { Track } from '../../src/playlist/types';

const track = (name: string): Track => ({ name, audioPath: `/music/${name}.mp3`, coverPath: null });

describe('PlaylistQueue', () => {
  it('starts on the first track', () => {
    const queue = new PlaylistQueue([track('a'), track('b')]);
    expect(queue.current()?.name).toBe('a');
  });

  it('handles an empty playlist without throwing', () => {
    const queue = new PlaylistQueue([]);
    expect(queue.current()).toBeUndefined();
    expect(queue.next()).toBeUndefined();
    expect(queue.previous()).toBeUndefined();
  });

  it('advances forward and wraps around at the end', () => {
    const queue = new PlaylistQueue([track('a'), track('b')]);
    expect(queue.next()?.name).toBe('b');
    expect(queue.next()?.name).toBe('a');
  });

  it('previous() steps back through history', () => {
    const queue = new PlaylistQueue([track('a'), track('b'), track('c')]);
    queue.next();
    queue.next();
    expect(queue.current()?.name).toBe('c');
    expect(queue.previous()?.name).toBe('b');
    expect(queue.previous()?.name).toBe('a');
  });

  it('previous() at the start stays on the current track', () => {
    const queue = new PlaylistQueue([track('a'), track('b')]);
    expect(queue.previous()?.name).toBe('a');
  });

  it('insertNext plays once, then playback continues from base order', () => {
    const queue = new PlaylistQueue([track('a'), track('b'), track('c')]);
    queue.insertNext(track('z'));
    expect(queue.peekNext()?.name).toBe('z');
    expect(queue.next()?.name).toBe('z');
    expect(queue.next()?.name).toBe('b');
  });

  it('setTracks keeps the current track in sync with its new position', () => {
    const queue = new PlaylistQueue([track('a'), track('b')]);
    queue.setTracks([track('z'), track('a'), track('b')]);
    expect(queue.current()?.name).toBe('a');
    expect(queue.next()?.name).toBe('b');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/playlist/queue.test.ts`
Expected: FAIL — `Cannot find module '../../src/playlist/queue'`

- [ ] **Step 3: Implement `src/playlist/queue.ts`**

```ts
import { Track } from './types';

export class PlaylistQueue {
  private baseTracks: Track[];
  private position: number;
  private currentTrack: Track | undefined;
  private history: Track[] = [];
  private insertedNext: Track | null = null;

  constructor(tracks: Track[]) {
    this.baseTracks = tracks;
    this.position = tracks.length > 0 ? 0 : -1;
    this.currentTrack = tracks[0];
  }

  current(): Track | undefined {
    return this.currentTrack;
  }

  peekNext(): Track | undefined {
    if (this.insertedNext) return this.insertedNext;
    if (this.baseTracks.length === 0) return undefined;
    return this.baseTracks[(this.position + 1) % this.baseTracks.length];
  }

  next(): Track | undefined {
    if (this.baseTracks.length === 0 && !this.insertedNext) return undefined;
    if (this.currentTrack) this.history.push(this.currentTrack);

    if (this.insertedNext) {
      this.currentTrack = this.insertedNext;
      this.insertedNext = null;
      return this.currentTrack;
    }

    this.position = (this.position + 1) % this.baseTracks.length;
    this.currentTrack = this.baseTracks[this.position];
    return this.currentTrack;
  }

  previous(): Track | undefined {
    if (this.history.length === 0) return this.currentTrack;

    const previousTrack = this.history.pop()!;
    const foundIndex = this.baseTracks.findIndex((t) => t.name === previousTrack.name);
    if (foundIndex >= 0) this.position = foundIndex;
    this.currentTrack = previousTrack;
    return this.currentTrack;
  }

  insertNext(track: Track): void {
    this.insertedNext = track;
  }

  setTracks(tracks: Track[]): void {
    this.baseTracks = tracks;
    if (this.currentTrack) {
      const foundIndex = tracks.findIndex((t) => t.name === this.currentTrack!.name);
      this.position = foundIndex >= 0 ? foundIndex : 0;
    } else {
      this.position = tracks.length > 0 ? 0 : -1;
      this.currentTrack = tracks[0];
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/playlist/queue.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/playlist/queue.ts test/playlist/queue.test.ts
git commit -m "feat: playlist queue with next/previous/insert-next"
```

---

### Task 5: ffmpeg process types & pure argument builders

**Files:**
- Create: `src/ffmpeg/types.ts`
- Create: `src/ffmpeg/segmentArgs.ts`
- Create: `src/ffmpeg/rtmpPusherArgs.ts`
- Test: `test/ffmpeg/segmentArgs.test.ts`
- Test: `test/ffmpeg/rtmpPusherArgs.test.ts`

**Interfaces:**
- Produces: `interface ChildProcessLike { pid: number|undefined; stdout: NodeJS.ReadableStream|null; stderr: NodeJS.ReadableStream|null; kill(signal?: NodeJS.Signals): void; once(event: 'exit'|'error', listener: (...args: unknown[]) => void): void; }`, `type Spawner = (command: string, args: string[]) => ChildProcessLike`, `interface VideoParams { width: number; height: number; fps: number; }`, `buildTrackSegmentArgs(params: VideoParams & { audioPath: string; coverPath: string }): string[]`, `buildPauseSegmentArgs(params: VideoParams & { coverPath: string }): string[]`, `buildRtmpPusherArgs(params: { fifoPath: string; rtmpUrl: string; streamKey: string }): string[]`

- [ ] **Step 1: Write the failing tests**

```ts
// test/ffmpeg/segmentArgs.test.ts
import { buildTrackSegmentArgs, buildPauseSegmentArgs } from '../../src/ffmpeg/segmentArgs';

describe('buildTrackSegmentArgs', () => {
  it('builds ffmpeg args that mux the cover image with the audio file into mpegts on stdout', () => {
    const args = buildTrackSegmentArgs({
      audioPath: '/music/a.mp3',
      coverPath: '/music/a.png',
      width: 1280,
      height: 720,
      fps: 30,
    });

    expect(args).toEqual([
      '-loop', '1',
      '-i', '/music/a.png',
      '-i', '/music/a.mp3',
      '-c:v', 'libx264',
      '-tune', 'stillimage',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-vf', 'scale=1280:720',
      '-shortest',
      '-f', 'mpegts',
      'pipe:1',
    ]);
  });
});

describe('buildPauseSegmentArgs', () => {
  it('builds ffmpeg args for an unbounded silence + splash segment', () => {
    const args = buildPauseSegmentArgs({ coverPath: '/assets/default.png', width: 1280, height: 720, fps: 30 });

    expect(args).toEqual([
      '-loop', '1',
      '-i', '/assets/default.png',
      '-f', 'lavfi',
      '-i', 'anullsrc=r=44100:cl=stereo',
      '-c:v', 'libx264',
      '-tune', 'stillimage',
      '-c:a', 'aac',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-vf', 'scale=1280:720',
      '-f', 'mpegts',
      'pipe:1',
    ]);
  });
});
```

```ts
// test/ffmpeg/rtmpPusherArgs.test.ts
import { buildRtmpPusherArgs } from '../../src/ffmpeg/rtmpPusherArgs';

describe('buildRtmpPusherArgs', () => {
  it('builds ffmpeg args that copy the fifo into the rtmp url + stream key', () => {
    const args = buildRtmpPusherArgs({ fifoPath: '/tmp/x.fifo', rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2', streamKey: 'abcd-1234' });

    expect(args).toEqual(['-re', '-i', '/tmp/x.fifo', '-c', 'copy', '-f', 'flv', 'rtmp://a.rtmp.youtube.com/live2/abcd-1234']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/ffmpeg/segmentArgs.test.ts test/ffmpeg/rtmpPusherArgs.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement `src/ffmpeg/types.ts`**

```ts
export interface ChildProcessLike {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): void;
  once(event: 'exit' | 'error', listener: (...args: unknown[]) => void): void;
}

export type Spawner = (command: string, args: string[]) => ChildProcessLike;
```

- [ ] **Step 4: Implement `src/ffmpeg/segmentArgs.ts`**

```ts
export interface VideoParams {
  width: number;
  height: number;
  fps: number;
}

export function buildTrackSegmentArgs(params: VideoParams & { audioPath: string; coverPath: string }): string[] {
  return [
    '-loop', '1',
    '-i', params.coverPath,
    '-i', params.audioPath,
    '-c:v', 'libx264',
    '-tune', 'stillimage',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-pix_fmt', 'yuv420p',
    '-r', String(params.fps),
    '-vf', `scale=${params.width}:${params.height}`,
    '-shortest',
    '-f', 'mpegts',
    'pipe:1',
  ];
}

export function buildPauseSegmentArgs(params: VideoParams & { coverPath: string }): string[] {
  return [
    '-loop', '1',
    '-i', params.coverPath,
    '-f', 'lavfi',
    '-i', 'anullsrc=r=44100:cl=stereo',
    '-c:v', 'libx264',
    '-tune', 'stillimage',
    '-c:a', 'aac',
    '-pix_fmt', 'yuv420p',
    '-r', String(params.fps),
    '-vf', `scale=${params.width}:${params.height}`,
    '-f', 'mpegts',
    'pipe:1',
  ];
}
```

- [ ] **Step 5: Implement `src/ffmpeg/rtmpPusherArgs.ts`**

```ts
export function buildRtmpPusherArgs(params: { fifoPath: string; rtmpUrl: string; streamKey: string }): string[] {
  return [
    '-re',
    '-i', params.fifoPath,
    '-c', 'copy',
    '-f', 'flv',
    `${params.rtmpUrl}/${params.streamKey}`,
  ];
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest test/ffmpeg/segmentArgs.test.ts test/ffmpeg/rtmpPusherArgs.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: Commit**

```bash
git add src/ffmpeg/types.ts src/ffmpeg/segmentArgs.ts src/ffmpeg/rtmpPusherArgs.ts test/ffmpeg/segmentArgs.test.ts test/ffmpeg/rtmpPusherArgs.test.ts
git commit -m "feat: pure ffmpeg argument builders"
```

---

### Task 6: SegmentFeeder

**Files:**
- Create: `src/ffmpeg/segmentFeeder.ts`
- Test: `test/ffmpeg/segmentFeeder.test.ts`

**Interfaces:**
- Consumes: `Spawner`, `ChildProcessLike` (Task 5), `buildTrackSegmentArgs`, `buildPauseSegmentArgs`, `VideoParams` (Task 5), `Track` (Task 3).
- Produces: `interface SegmentFeederOptions extends VideoParams { spawner: Spawner; fifoPath: string; defaultCoverPath: string; createWriteStream?: (path: string) => NodeJS.WritableStream; }`, `class SegmentFeeder { constructor(options: SegmentFeederOptions); feedTrack(track: Track): ChildProcessLike; feedPause(): ChildProcessLike; stopCurrent(): void; }`

- [ ] **Step 1: Write the failing tests**

```ts
// test/ffmpeg/segmentFeeder.test.ts
import { PassThrough, Writable } from 'stream';
import { SegmentFeeder } from '../../src/ffmpeg/segmentFeeder';
import { Spawner, ChildProcessLike } from '../../src/ffmpeg/types';
import { Track } from '../../src/playlist/types';

function fakeChild(): ChildProcessLike & { stdout: PassThrough } {
  const stdout = new PassThrough();
  return { pid: 123, stdout, stderr: null, kill: jest.fn(), once: jest.fn() };
}

const track: Track = { name: 'a', audioPath: '/music/a.mp3', coverPath: null };

describe('SegmentFeeder', () => {
  it('spawns ffmpeg with track args and pipes stdout into the fifo stream', () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const chunks: Buffer[] = [];
    const writeStream = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
    });

    const feeder = new SegmentFeeder({
      spawner, fifoPath: '/tmp/fifo', defaultCoverPath: '/assets/default.png',
      width: 1280, height: 720, fps: 30,
      createWriteStream: () => writeStream,
    });

    feeder.feedTrack(track);
    child.stdout.write('segment-bytes');
    child.stdout.end();

    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-i', '/music/a.mp3']));
    expect(Buffer.concat(chunks).toString()).toBe('segment-bytes');
  });

  it('feedTrack falls back to the default cover when the track has none', () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const feeder = new SegmentFeeder({
      spawner, fifoPath: '/tmp/fifo', defaultCoverPath: '/assets/default.png',
      width: 1280, height: 720, fps: 30,
      createWriteStream: () => new PassThrough(),
    });

    feeder.feedTrack(track);

    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-i', '/assets/default.png']));
  });

  it('stopCurrent kills the active process', () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const feeder = new SegmentFeeder({
      spawner, fifoPath: '/tmp/fifo', defaultCoverPath: '/assets/default.png',
      width: 1280, height: 720, fps: 30,
      createWriteStream: () => new PassThrough(),
    });

    feeder.feedTrack(track);
    feeder.stopCurrent();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/ffmpeg/segmentFeeder.test.ts`
Expected: FAIL — `Cannot find module '../../src/ffmpeg/segmentFeeder'`

- [ ] **Step 3: Implement `src/ffmpeg/segmentFeeder.ts`**

```ts
import * as fs from 'fs';
import { Track } from '../playlist/types';
import { Spawner, ChildProcessLike } from './types';
import { buildTrackSegmentArgs, buildPauseSegmentArgs, VideoParams } from './segmentArgs';

export interface SegmentFeederOptions extends VideoParams {
  spawner: Spawner;
  fifoPath: string;
  defaultCoverPath: string;
  createWriteStream?: (path: string) => NodeJS.WritableStream;
}

export class SegmentFeeder {
  private readonly fifoWriteStream: NodeJS.WritableStream;
  private activeProcess: ChildProcessLike | null = null;

  constructor(private readonly options: SegmentFeederOptions) {
    const createWriteStream = options.createWriteStream ?? ((p: string) => fs.createWriteStream(p));
    this.fifoWriteStream = createWriteStream(options.fifoPath);
  }

  feedTrack(track: Track): ChildProcessLike {
    const args = buildTrackSegmentArgs({
      audioPath: track.audioPath,
      coverPath: track.coverPath ?? this.options.defaultCoverPath,
      width: this.options.width,
      height: this.options.height,
      fps: this.options.fps,
    });
    return this.spawnAndPipe(args);
  }

  feedPause(): ChildProcessLike {
    const args = buildPauseSegmentArgs({
      coverPath: this.options.defaultCoverPath,
      width: this.options.width,
      height: this.options.height,
      fps: this.options.fps,
    });
    return this.spawnAndPipe(args);
  }

  stopCurrent(): void {
    if (this.activeProcess) {
      this.activeProcess.kill('SIGTERM');
      this.activeProcess = null;
    }
  }

  private spawnAndPipe(args: string[]): ChildProcessLike {
    this.stopCurrent();
    const child = this.options.spawner('ffmpeg', args);
    if (child.stdout) {
      child.stdout.pipe(this.fifoWriteStream, { end: false });
    }
    this.activeProcess = child;
    return child;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/ffmpeg/segmentFeeder.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ffmpeg/segmentFeeder.ts test/ffmpeg/segmentFeeder.test.ts
git commit -m "feat: segment feeder pipes track/pause segments into the fifo"
```

---

### Task 7: RtmpPusher

**Files:**
- Create: `src/ffmpeg/rtmpPusher.ts`
- Test: `test/ffmpeg/rtmpPusher.test.ts`

**Interfaces:**
- Consumes: `Spawner`, `ChildProcessLike` (Task 5), `buildRtmpPusherArgs` (Task 5).
- Produces: `interface RtmpPusherParams { fifoPath: string; rtmpUrl: string; streamKey: string; }`, `class RtmpPusher { constructor(spawner: Spawner, params: RtmpPusherParams); start(onExit: (code: number|null) => void): void; stop(): void; }`

- [ ] **Step 1: Write the failing tests**

```ts
// test/ffmpeg/rtmpPusher.test.ts
import { RtmpPusher } from '../../src/ffmpeg/rtmpPusher';
import { Spawner, ChildProcessLike } from '../../src/ffmpeg/types';

function fakeChild(): ChildProcessLike & { emitExit: (code: number | null) => void } {
  let exitListener: ((code: number | null) => void) | null = null;
  return {
    pid: 1,
    stdout: null,
    stderr: null,
    kill: jest.fn(),
    once: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'exit') exitListener = listener as (code: number | null) => void;
    }),
    emitExit: (code) => exitListener && exitListener(code),
  };
}

describe('RtmpPusher', () => {
  it('starts ffmpeg with the rtmp pusher args', () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const pusher = new RtmpPusher(spawner, { fifoPath: '/tmp/fifo', rtmpUrl: 'rtmp://x', streamKey: 'k' });

    pusher.start(() => {});

    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-i', '/tmp/fifo', 'rtmp://x/k']));
  });

  it('invokes onExit when the process exits', () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const pusher = new RtmpPusher(spawner, { fifoPath: '/tmp/fifo', rtmpUrl: 'rtmp://x', streamKey: 'k' });
    const onExit = jest.fn();

    pusher.start(onExit);
    child.emitExit(1);

    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('stop kills the running process', () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const pusher = new RtmpPusher(spawner, { fifoPath: '/tmp/fifo', rtmpUrl: 'rtmp://x', streamKey: 'k' });

    pusher.start(() => {});
    pusher.stop();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/ffmpeg/rtmpPusher.test.ts`
Expected: FAIL — `Cannot find module '../../src/ffmpeg/rtmpPusher'`

- [ ] **Step 3: Implement `src/ffmpeg/rtmpPusher.ts`**

```ts
import { Spawner, ChildProcessLike } from './types';
import { buildRtmpPusherArgs } from './rtmpPusherArgs';

export interface RtmpPusherParams {
  fifoPath: string;
  rtmpUrl: string;
  streamKey: string;
}

export class RtmpPusher {
  private process: ChildProcessLike | null = null;

  constructor(private readonly spawner: Spawner, private readonly params: RtmpPusherParams) {}

  start(onExit: (code: number | null) => void): void {
    const args = buildRtmpPusherArgs(this.params);
    const child = this.spawner('ffmpeg', args);
    child.once('exit', (code) => onExit(code as number | null));
    this.process = child;
  }

  stop(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/ffmpeg/rtmpPusher.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ffmpeg/rtmpPusher.ts test/ffmpeg/rtmpPusher.test.ts
git commit -m "feat: persistent rtmp pusher process"
```

---

### Task 8: FIFO helpers

**Files:**
- Create: `src/ffmpeg/fifo.ts`
- Test: `test/ffmpeg/fifo.test.ts`

**Interfaces:**
- Produces: `createFifo(path: string, execFileFn?: typeof execFileSync): void`, `removeFifo(path: string, unlinkFn?: typeof fs.unlinkSync): void`

`mkfifo` is a Linux-only shell utility, matching the Docker/Linux deployment target — these tests inject fakes rather than exercising the real syscall, since the dev machine may not be Linux.

- [ ] **Step 1: Write the failing tests**

```ts
// test/ffmpeg/fifo.test.ts
import { createFifo, removeFifo } from '../../src/ffmpeg/fifo';

describe('fifo helpers', () => {
  it('createFifo shells out to mkfifo with the given path', () => {
    const execFileFn = jest.fn();
    createFifo('/tmp/x.fifo', execFileFn as any);
    expect(execFileFn).toHaveBeenCalledWith('mkfifo', ['/tmp/x.fifo']);
  });

  it('removeFifo unlinks the file', () => {
    const unlinkFn = jest.fn();
    removeFifo('/tmp/x.fifo', unlinkFn as any);
    expect(unlinkFn).toHaveBeenCalledWith('/tmp/x.fifo');
  });

  it('removeFifo swallows ENOENT', () => {
    const err = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const unlinkFn = jest.fn(() => { throw err; });
    expect(() => removeFifo('/tmp/x.fifo', unlinkFn as any)).not.toThrow();
  });

  it('removeFifo rethrows other errors', () => {
    const err = Object.assign(new Error('boom'), { code: 'EACCES' });
    const unlinkFn = jest.fn(() => { throw err; });
    expect(() => removeFifo('/tmp/x.fifo', unlinkFn as any)).toThrow('boom');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/ffmpeg/fifo.test.ts`
Expected: FAIL — `Cannot find module '../../src/ffmpeg/fifo'`

- [ ] **Step 3: Implement `src/ffmpeg/fifo.ts`**

```ts
import { execFileSync } from 'child_process';
import * as fs from 'fs';

export function createFifo(path: string, execFileFn: typeof execFileSync = execFileSync): void {
  execFileFn('mkfifo', [path]);
}

export function removeFifo(path: string, unlinkFn: typeof fs.unlinkSync = fs.unlinkSync): void {
  try {
    unlinkFn(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/ffmpeg/fifo.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ffmpeg/fifo.ts test/ffmpeg/fifo.test.ts
git commit -m "feat: fifo create/remove helpers"
```

---

### Task 9: ApiError & StreamController

**Files:**
- Create: `src/errors.ts`
- Create: `src/stream/types.ts`
- Create: `src/stream/streamController.ts`
- Test: `test/stream/streamController.test.ts`

**Interfaces:**
- Consumes: `Library`, `Track` (Task 3), `PlaylistQueue` (Task 4), `SegmentFeeder` (Task 6), `RtmpPusher` (Task 7).
- Produces: `class ApiError extends Error { constructor(status: number, message: string); status: number; }`, `type SessionState = 'idle'|'streaming'|'paused'|'error'`, `interface StreamStatus { state: SessionState; currentTrack: string|null; nextTrack: string|null; }`, `class StreamController { constructor(deps: StreamControllerDeps); start(): void; stop(): void; pause(): void; resume(): void; next(): void; previous(): void; playByName(name: string): void; status(): StreamStatus; }`

- [ ] **Step 1: Write the failing tests**

```ts
// test/stream/streamController.test.ts
import { StreamController } from '../../src/stream/streamController';
import { ApiError } from '../../src/errors';
import { Track } from '../../src/playlist/types';

const track = (name: string): Track => ({ name, audioPath: `/music/${name}.mp3`, coverPath: null });

function buildDeps() {
  const tracks = [track('a'), track('b')];
  const library = {
    list: jest.fn().mockReturnValue(tracks),
    findByName: jest.fn((name: string) => tracks.find((t) => t.name === name)),
  };
  const queue = {
    current: jest.fn().mockReturnValue(tracks[0]),
    next: jest.fn().mockReturnValue(tracks[1]),
    previous: jest.fn().mockReturnValue(tracks[0]),
    insertNext: jest.fn(),
    peekNext: jest.fn().mockReturnValue(tracks[1]),
  };
  const feeder = { feedTrack: jest.fn(), feedPause: jest.fn(), stopCurrent: jest.fn() };
  const pusher = { start: jest.fn(), stop: jest.fn() };
  const deps: any = {
    library, queue, fifoPath: '/tmp/fifo',
    createFifo: jest.fn(), removeFifo: jest.fn(),
    createSegmentFeeder: jest.fn().mockReturnValue(feeder),
    createRtmpPusher: jest.fn().mockReturnValue(pusher),
  };
  return { deps, library, queue, feeder, pusher };
}

describe('StreamController', () => {
  it('start() creates the fifo, starts the pusher and feeds the current track', () => {
    const { deps, feeder, pusher } = buildDeps();
    const controller = new StreamController(deps);

    controller.start();

    expect(deps.createFifo).toHaveBeenCalledWith('/tmp/fifo');
    expect(pusher.start).toHaveBeenCalled();
    expect(feeder.feedTrack).toHaveBeenCalledWith({ name: 'a', audioPath: '/music/a.mp3', coverPath: null });
    expect(controller.status().state).toBe('streaming');
  });

  it('start() throws 409 when already streaming', () => {
    const { deps } = buildDeps();
    const controller = new StreamController(deps);
    controller.start();
    expect(() => controller.start()).toThrow(ApiError);
  });

  it('start() throws 409 when the library is empty', () => {
    const { deps } = buildDeps();
    deps.library.list.mockReturnValue([]);
    const controller = new StreamController(deps);
    expect(() => controller.start()).toThrow('library is empty');
  });

  it('pause() feeds a pause segment; resume() feeds the current track again', () => {
    const { deps, feeder } = buildDeps();
    const controller = new StreamController(deps);
    controller.start();

    controller.pause();
    expect(feeder.feedPause).toHaveBeenCalled();
    expect(controller.status().state).toBe('paused');

    controller.resume();
    expect(controller.status().state).toBe('streaming');
  });

  it('next() advances the queue and feeds the new track while streaming', () => {
    const { deps, queue, feeder } = buildDeps();
    const controller = new StreamController(deps);
    controller.start();

    controller.next();

    expect(queue.next).toHaveBeenCalled();
    expect(feeder.feedTrack).toHaveBeenCalledWith({ name: 'b', audioPath: '/music/b.mp3', coverPath: null });
  });

  it('next() throws 409 when idle', () => {
    const { deps } = buildDeps();
    const controller = new StreamController(deps);
    expect(() => controller.next()).toThrow(ApiError);
  });

  it('playByName() inserts into the queue without switching immediately', () => {
    const { deps, queue, feeder } = buildDeps();
    const controller = new StreamController(deps);
    controller.start();
    feeder.feedTrack.mockClear();

    controller.playByName('b');

    expect(queue.insertNext).toHaveBeenCalledWith({ name: 'b', audioPath: '/music/b.mp3', coverPath: null });
    expect(feeder.feedTrack).not.toHaveBeenCalled();
  });

  it('playByName() throws 404 for an unknown track', () => {
    const { deps } = buildDeps();
    const controller = new StreamController(deps);
    expect(() => controller.playByName('missing')).toThrow(ApiError);
  });

  it('stop() tears down the feeder, pusher and fifo', () => {
    const { deps, feeder, pusher } = buildDeps();
    const controller = new StreamController(deps);
    controller.start();

    controller.stop();

    expect(feeder.stopCurrent).toHaveBeenCalled();
    expect(pusher.stop).toHaveBeenCalled();
    expect(deps.removeFifo).toHaveBeenCalledWith('/tmp/fifo');
    expect(controller.status().state).toBe('idle');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/stream/streamController.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement `src/errors.ts`**

```ts
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}
```

- [ ] **Step 4: Implement `src/stream/types.ts`**

```ts
export type SessionState = 'idle' | 'streaming' | 'paused' | 'error';

export interface StreamStatus {
  state: SessionState;
  currentTrack: string | null;
  nextTrack: string | null;
}
```

- [ ] **Step 5: Implement `src/stream/streamController.ts`**

```ts
import { Library } from '../playlist/library';
import { PlaylistQueue } from '../playlist/queue';
import { SegmentFeeder } from '../ffmpeg/segmentFeeder';
import { RtmpPusher } from '../ffmpeg/rtmpPusher';
import { ApiError } from '../errors';
import { SessionState, StreamStatus } from './types';

export interface StreamControllerDeps {
  library: Library;
  queue: PlaylistQueue;
  fifoPath: string;
  createFifo: (path: string) => void;
  removeFifo: (path: string) => void;
  createSegmentFeeder: () => SegmentFeeder;
  createRtmpPusher: () => RtmpPusher;
}

export class StreamController {
  private state: SessionState = 'idle';
  private feeder: SegmentFeeder | null = null;
  private pusher: RtmpPusher | null = null;

  constructor(private readonly deps: StreamControllerDeps) {}

  start(): void {
    if (this.state !== 'idle') throw new ApiError(409, 'stream is already active');
    if (this.deps.library.list().length === 0) throw new ApiError(409, 'library is empty');

    this.deps.createFifo(this.deps.fifoPath);
    this.pusher = this.deps.createRtmpPusher();
    this.pusher.start(() => { this.state = 'error'; });
    this.feeder = this.deps.createSegmentFeeder();
    const track = this.deps.queue.current();
    if (track) this.feeder.feedTrack(track);
    this.state = 'streaming';
  }

  stop(): void {
    if (this.state === 'idle') throw new ApiError(409, 'stream is not active');
    this.feeder?.stopCurrent();
    this.pusher?.stop();
    this.deps.removeFifo(this.deps.fifoPath);
    this.feeder = null;
    this.pusher = null;
    this.state = 'idle';
  }

  pause(): void {
    if (this.state !== 'streaming') throw new ApiError(409, 'stream is not currently streaming');
    this.feeder!.feedPause();
    this.state = 'paused';
  }

  resume(): void {
    if (this.state !== 'paused') throw new ApiError(409, 'stream is not paused');
    const track = this.deps.queue.current();
    if (track) this.feeder!.feedTrack(track);
    this.state = 'streaming';
  }

  next(): void {
    if (this.state === 'idle' || this.state === 'error') throw new ApiError(409, 'stream is not active');
    const track = this.deps.queue.next();
    if (!track) throw new ApiError(409, 'no tracks in queue');
    if (this.state === 'streaming') this.feeder!.feedTrack(track);
  }

  previous(): void {
    if (this.state === 'idle' || this.state === 'error') throw new ApiError(409, 'stream is not active');
    const track = this.deps.queue.previous();
    if (track && this.state === 'streaming') this.feeder!.feedTrack(track);
  }

  playByName(name: string): void {
    const track = this.deps.library.findByName(name);
    if (!track) throw new ApiError(404, `track not found: ${name}`);
    this.deps.queue.insertNext(track);
  }

  status(): StreamStatus {
    return {
      state: this.state,
      currentTrack: this.deps.queue.current()?.name ?? null,
      nextTrack: this.deps.queue.peekNext()?.name ?? null,
    };
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest test/stream/streamController.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 7: Commit**

```bash
git add src/errors.ts src/stream/types.ts src/stream/streamController.ts test/stream/streamController.test.ts
git commit -m "feat: stream controller state machine"
```

---

### Task 10: REST API — stream & library routes

**Files:**
- Create: `src/api/errorHandler.ts`
- Create: `src/api/streamRoutes.ts`
- Create: `src/api/libraryRoutes.ts`
- Create: `src/api/app.ts`
- Test: `test/api/streamRoutes.test.ts`
- Test: `test/api/libraryRoutes.test.ts`

**Interfaces:**
- Consumes: `StreamController` (Task 9), `ApiError` (Task 9), `Library` (Task 3), `PlaylistQueue` (Task 4).
- Produces: `wrapAsync(handler): RequestHandler`, `errorHandler(err, req, res, next): void`, `createStreamRouter(streamController: StreamController): Router`, `createLibraryRouter(library: Library, queue: PlaylistQueue): Router`, `interface AppDeps { streamController: StreamController; library: Library; queue: PlaylistQueue; }`, `createApp(deps: AppDeps): Express`

- [ ] **Step 1: Write the failing tests**

```ts
// test/api/streamRoutes.test.ts
import express from 'express';
import request from 'supertest';
import { createStreamRouter } from '../../src/api/streamRoutes';
import { errorHandler } from '../../src/api/errorHandler';
import { ApiError } from '../../src/errors';

function buildApp(controller: any) {
  const app = express();
  app.use(express.json());
  app.use('/stream', createStreamRouter(controller));
  app.use(errorHandler);
  return app;
}

describe('stream routes', () => {
  it('POST /stream/start calls controller.start and returns status', async () => {
    const controller = { start: jest.fn(), status: jest.fn().mockReturnValue({ state: 'streaming' }) };
    const res = await request(buildApp(controller)).post('/stream/start');

    expect(controller.start).toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: 'streaming' });
  });

  it('maps ApiError thrown by the controller to the right status code', async () => {
    const controller = {
      start: jest.fn(() => { throw new ApiError(409, 'already active'); }),
      status: jest.fn(),
    };
    const res = await request(buildApp(controller)).post('/stream/start');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'already active' });
  });

  it('POST /stream/play requires a name in the body', async () => {
    const controller = { playByName: jest.fn(), status: jest.fn() };
    const res = await request(buildApp(controller)).post('/stream/play').send({});

    expect(res.status).toBe(400);
    expect(controller.playByName).not.toHaveBeenCalled();
  });

  it('POST /stream/play passes the name through', async () => {
    const controller = { playByName: jest.fn(), status: jest.fn().mockReturnValue({ state: 'streaming' }) };
    const res = await request(buildApp(controller)).post('/stream/play').send({ name: 'track-a' });

    expect(controller.playByName).toHaveBeenCalledWith('track-a');
    expect(res.status).toBe(200);
  });

  it('GET /stream/status returns the controller status', async () => {
    const controller = { status: jest.fn().mockReturnValue({ state: 'idle' }) };
    const res = await request(buildApp(controller)).get('/stream/status');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: 'idle' });
  });
});
```

```ts
// test/api/libraryRoutes.test.ts
import express from 'express';
import request from 'supertest';
import { createLibraryRouter } from '../../src/api/libraryRoutes';
import { errorHandler } from '../../src/api/errorHandler';

function buildApp(library: any, queue: any) {
  const app = express();
  app.use(express.json());
  app.use('/library', createLibraryRouter(library, queue));
  app.use(errorHandler);
  return app;
}

describe('library routes', () => {
  it('GET /library returns the current track list', async () => {
    const library = { list: jest.fn().mockReturnValue([{ name: 'a' }]) };
    const res = await request(buildApp(library, { setTracks: jest.fn() })).get('/library');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ name: 'a' }]);
  });

  it('POST /library/rescan rescans and syncs the queue', async () => {
    const tracks = [{ name: 'a' }, { name: 'b' }];
    const library = { scan: jest.fn().mockResolvedValue(tracks) };
    const queue = { setTracks: jest.fn() };
    const res = await request(buildApp(library, queue)).post('/library/rescan');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(tracks);
    expect(queue.setTracks).toHaveBeenCalledWith(tracks);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/api/streamRoutes.test.ts test/api/libraryRoutes.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement `src/api/errorHandler.ts`**

```ts
import { NextFunction, Request, RequestHandler, Response } from 'express';
import { ApiError } from '../errors';

export function wrapAsync(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void> | void,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: 'internal server error' });
}
```

- [ ] **Step 4: Implement `src/api/streamRoutes.ts`**

```ts
import { Router } from 'express';
import { StreamController } from '../stream/streamController';
import { ApiError } from '../errors';
import { wrapAsync } from './errorHandler';

export function createStreamRouter(streamController: StreamController): Router {
  const router = Router();

  router.post('/start', wrapAsync(async (_req, res) => {
    streamController.start();
    res.status(200).json(streamController.status());
  }));

  router.post('/stop', wrapAsync(async (_req, res) => {
    streamController.stop();
    res.status(200).json(streamController.status());
  }));

  router.post('/pause', wrapAsync(async (_req, res) => {
    streamController.pause();
    res.status(200).json(streamController.status());
  }));

  router.post('/resume', wrapAsync(async (_req, res) => {
    streamController.resume();
    res.status(200).json(streamController.status());
  }));

  router.post('/next', wrapAsync(async (_req, res) => {
    streamController.next();
    res.status(200).json(streamController.status());
  }));

  router.post('/previous', wrapAsync(async (_req, res) => {
    streamController.previous();
    res.status(200).json(streamController.status());
  }));

  router.post('/play', wrapAsync(async (req, res) => {
    const { name } = req.body ?? {};
    if (typeof name !== 'string' || name.length === 0) {
      throw new ApiError(400, 'body.name is required');
    }
    streamController.playByName(name);
    res.status(200).json(streamController.status());
  }));

  router.get('/status', wrapAsync(async (_req, res) => {
    res.status(200).json(streamController.status());
  }));

  return router;
}
```

- [ ] **Step 5: Implement `src/api/libraryRoutes.ts`**

```ts
import { Router } from 'express';
import { Library } from '../playlist/library';
import { PlaylistQueue } from '../playlist/queue';
import { wrapAsync } from './errorHandler';

export function createLibraryRouter(library: Library, queue: PlaylistQueue): Router {
  const router = Router();

  router.get('/', wrapAsync(async (_req, res) => {
    res.status(200).json(library.list());
  }));

  router.post('/rescan', wrapAsync(async (_req, res) => {
    const tracks = await library.scan();
    queue.setTracks(tracks);
    res.status(200).json(tracks);
  }));

  return router;
}
```

- [ ] **Step 6: Implement `src/api/app.ts`**

```ts
import express, { Express } from 'express';
import { StreamController } from '../stream/streamController';
import { Library } from '../playlist/library';
import { PlaylistQueue } from '../playlist/queue';
import { createStreamRouter } from './streamRoutes';
import { createLibraryRouter } from './libraryRoutes';
import { errorHandler } from './errorHandler';

export interface AppDeps {
  streamController: StreamController;
  library: Library;
  queue: PlaylistQueue;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json());
  app.use('/stream', createStreamRouter(deps.streamController));
  app.use('/library', createLibraryRouter(deps.library, deps.queue));
  app.use(errorHandler);
  return app;
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx jest test/api/streamRoutes.test.ts test/api/libraryRoutes.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 8: Commit**

```bash
git add src/api/errorHandler.ts src/api/streamRoutes.ts src/api/libraryRoutes.ts src/api/app.ts test/api/streamRoutes.test.ts test/api/libraryRoutes.test.ts
git commit -m "feat: REST API for stream and library control"
```

---

### Task 11: OpenAPI / Swagger documentation

**Files:**
- Create: `src/api/openapi.ts`
- Modify: `src/api/app.ts`
- Test: `test/api/openapi.test.ts`

**Interfaces:**
- Consumes: `createApp` (Task 10).
- Produces: `openApiSpec` (OpenAPI 3.0 document object); `createApp` now also serves `GET /openapi.json` and Swagger UI at `/docs`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/api/openapi.test.ts
import request from 'supertest';
import { createApp } from '../../src/api/app';

function buildApp() {
  const streamController: any = { status: jest.fn().mockReturnValue({ state: 'idle' }) };
  const library: any = { list: jest.fn().mockReturnValue([]) };
  const queue: any = { setTracks: jest.fn() };
  return createApp({ streamController, library, queue });
}

describe('API docs', () => {
  it('serves the raw OpenAPI document', async () => {
    const res = await request(buildApp()).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.paths).toHaveProperty('/stream/start');
  });

  it('serves Swagger UI at /docs', async () => {
    const res = await request(buildApp()).get('/docs/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/api/openapi.test.ts`
Expected: FAIL — `/openapi.json` and `/docs/` return 404

- [ ] **Step 3: Implement `src/api/openapi.ts`**

```ts
export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Super DJ Streamer API',
    version: '1.0.0',
    description: 'Controls a continuous YouTube Live audio stream.',
  },
  paths: {
    '/stream/start': {
      post: {
        summary: 'Start the stream',
        responses: {
          '200': { description: 'Stream started', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamStatus' } } } },
          '409': { description: 'Stream already active or library empty' },
        },
      },
    },
    '/stream/stop': {
      post: {
        summary: 'Stop the stream',
        responses: {
          '200': { description: 'Stream stopped', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamStatus' } } } },
          '409': { description: 'Stream is not active' },
        },
      },
    },
    '/stream/pause': {
      post: {
        summary: 'Pause playback (silence + splash, RTMP stays connected)',
        responses: {
          '200': { description: 'Stream paused', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamStatus' } } } },
          '409': { description: 'Stream is not currently streaming' },
        },
      },
    },
    '/stream/resume': {
      post: {
        summary: 'Resume playback of the current track',
        responses: {
          '200': { description: 'Stream resumed', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamStatus' } } } },
          '409': { description: 'Stream is not paused' },
        },
      },
    },
    '/stream/next': {
      post: {
        summary: 'Skip to the next track in the queue',
        responses: {
          '200': { description: 'Advanced to next track', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamStatus' } } } },
          '409': { description: 'Stream is not active or queue is empty' },
        },
      },
    },
    '/stream/previous': {
      post: {
        summary: 'Go back to the previous track',
        responses: {
          '200': { description: 'Moved to previous track', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamStatus' } } } },
          '409': { description: 'Stream is not active' },
        },
      },
    },
    '/stream/play': {
      post: {
        summary: 'Queue a specific track by name to play next',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } },
        },
        responses: {
          '200': { description: 'Track queued', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamStatus' } } } },
          '400': { description: 'Missing or invalid name' },
          '404': { description: 'Track not found' },
        },
      },
    },
    '/stream/status': {
      get: {
        summary: 'Get current stream status',
        responses: {
          '200': { description: 'Current status', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreamStatus' } } } },
        },
      },
    },
    '/library': {
      get: {
        summary: 'List tracks currently in the library',
        responses: {
          '200': { description: 'Track list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Track' } } } } },
        },
      },
    },
    '/library/rescan': {
      post: {
        summary: 'Rescan the audio directory and update the library',
        responses: {
          '200': { description: 'Updated track list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Track' } } } } },
        },
      },
    },
  },
  components: {
    schemas: {
      Track: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          audioPath: { type: 'string' },
          coverPath: { type: 'string', nullable: true },
        },
      },
      StreamStatus: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['idle', 'streaming', 'paused', 'error'] },
          currentTrack: { type: 'string', nullable: true },
          nextTrack: { type: 'string', nullable: true },
        },
      },
    },
  },
};
```

- [ ] **Step 4: Modify `src/api/app.ts` to mount Swagger UI**

```ts
import express, { Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import { StreamController } from '../stream/streamController';
import { Library } from '../playlist/library';
import { PlaylistQueue } from '../playlist/queue';
import { createStreamRouter } from './streamRoutes';
import { createLibraryRouter } from './libraryRoutes';
import { errorHandler } from './errorHandler';
import { openApiSpec } from './openapi';

export interface AppDeps {
  streamController: StreamController;
  library: Library;
  queue: PlaylistQueue;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json());
  app.use('/stream', createStreamRouter(deps.streamController));
  app.use('/library', createLibraryRouter(deps.library, deps.queue));
  app.get('/openapi.json', (_req, res) => res.json(openApiSpec));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
  app.use(errorHandler);
  return app;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest test/api/openapi.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Run the full test suite to confirm nothing regressed**

Run: `npx jest`
Expected: all suites PASS

- [ ] **Step 7: Commit**

```bash
git add src/api/openapi.ts src/api/app.ts test/api/openapi.test.ts
git commit -m "feat: OpenAPI spec and Swagger UI for the management API"
```

---

### Task 12: Bootstrap wiring (server.ts + main.ts)

**Files:**
- Create: `src/server.ts`
- Create: `src/main.ts`
- Create: `assets/default-cover.png` (manual asset — see Step 1)
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `AppConfig` (Task 2), `Library`/`PlaylistQueue` (Tasks 3–4), `StreamController` (Task 9), `SegmentFeeder`/`RtmpPusher`/`createFifo`/`removeFifo`/`Spawner` (Tasks 5–8), `createApp` (Task 10–11).
- Produces: `buildServer(config: AppConfig, spawner?: Spawner): { app: Express; library: Library; queue: PlaylistQueue; streamController: StreamController }`

- [ ] **Step 1: Add a placeholder default cover asset**

Binary image content can't be authored as a plan step — place any square JPEG/PNG file at `assets/default-cover.png` manually before running this in Docker (a solid-color placeholder is fine for v1; nothing in the code validates its contents, ffmpeg will error clearly if the file is missing or unreadable).

- [ ] **Step 2: Write the failing tests**

```ts
// test/server.test.ts
import { PassThrough } from 'stream';
import request from 'supertest';
import { buildServer } from '../src/server';
import { AppConfig } from '../src/config/env';
import { Spawner, ChildProcessLike } from '../src/ffmpeg/types';

function fakeSpawner(): Spawner {
  return jest.fn().mockImplementation((): ChildProcessLike => ({
    pid: 1,
    stdout: new PassThrough(),
    stderr: null,
    kill: jest.fn(),
    once: jest.fn(),
  }));
}

const config: AppConfig = {
  port: 3000,
  rtmpUrl: 'rtmp://example.com/live',
  streamKey: 'key',
  audioDir: '/music',
  defaultCoverPath: '/assets/default-cover.png',
  fifoPath: '/tmp/test.fifo',
};

describe('buildServer', () => {
  it('wires an app that reports idle status before any track is loaded', async () => {
    const { app } = buildServer(config, fakeSpawner());
    const res = await request(app).get('/stream/status');

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('idle');
  });

  it('start() fails with 409 until the library has tracks', async () => {
    const { app } = buildServer(config, fakeSpawner());
    const res = await request(app).post('/stream/start');

    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest test/server.test.ts`
Expected: FAIL — `Cannot find module '../src/server'`

- [ ] **Step 4: Implement `src/server.ts`**

```ts
import { spawn } from 'child_process';
import { AppConfig } from './config/env';
import { Library } from './playlist/library';
import { PlaylistQueue } from './playlist/queue';
import { StreamController } from './stream/streamController';
import { SegmentFeeder } from './ffmpeg/segmentFeeder';
import { RtmpPusher } from './ffmpeg/rtmpPusher';
import { createFifo, removeFifo } from './ffmpeg/fifo';
import { Spawner } from './ffmpeg/types';
import { createApp } from './api/app';

const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 720;
const VIDEO_FPS = 30;

export function buildServer(config: AppConfig, spawner: Spawner = spawn as unknown as Spawner) {
  const library = new Library(config.audioDir, config.defaultCoverPath);
  const queue = new PlaylistQueue([]);

  const streamController = new StreamController({
    library,
    queue,
    fifoPath: config.fifoPath,
    createFifo,
    removeFifo,
    createSegmentFeeder: () => new SegmentFeeder({
      spawner,
      fifoPath: config.fifoPath,
      defaultCoverPath: config.defaultCoverPath,
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      fps: VIDEO_FPS,
    }),
    createRtmpPusher: () => new RtmpPusher(spawner, {
      fifoPath: config.fifoPath,
      rtmpUrl: config.rtmpUrl,
      streamKey: config.streamKey,
    }),
  });

  const app = createApp({ streamController, library, queue });

  return { app, library, queue, streamController };
}
```

- [ ] **Step 5: Implement `src/main.ts`**

```ts
import { loadConfig } from './config/env';
import { buildServer } from './server';

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, library, queue } = buildServer(config);

  await library.scan();
  queue.setTracks(library.list());

  app.listen(config.port, () => {
    console.log(`super-dj listening on port ${config.port}`);
  });
}

main().catch((err) => {
  console.error('failed to start super-dj', err);
  process.exit(1);
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest test/server.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: Build and run the full test suite**

Run: `npm run build && npx jest`
Expected: `tsc` succeeds with no errors, all test suites PASS

- [ ] **Step 8: Commit**

```bash
git add src/server.ts src/main.ts test/server.test.ts assets/default-cover.png
git commit -m "feat: bootstrap server wiring (main entrypoint)"
```

---

### Task 13: Docker packaging

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`

**Interfaces:**
- Consumes: `package.json` build/start scripts (Task 1), `dist/main.js` (Task 12).

- [ ] **Step 1: Create `Dockerfile`**

```dockerfile
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY assets ./assets
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

- [ ] **Step 2: Create `docker-compose.yml`**

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
    volumes:
      - ./music:/data/audio:ro
```

- [ ] **Step 3: Build the image to verify the Dockerfile is correct**

Run: `docker build -t super-dj .`
Expected: image builds successfully (requires Docker on the machine running this step; if unavailable locally, verify this step in CI or on the deployment host before shipping)

- [ ] **Step 4: Commit**

```bash
git add Dockerfile docker-compose.yml
git commit -m "chore: Docker packaging"
```

---

## Self-Review Notes

- **Spec coverage:** every REST endpoint, the FIFO/MPEG-TS architecture, pause-as-silence, play-by-name-inserts-next, previous-idempotent-at-start, alphabetical scan, Swagger docs, Docker/env requirements, and the test strategy from the spec each map to a task above.
- **Fixed during drafting:** `POST /library/rescan` must also update `PlaylistQueue` (via `setTracks`), not just `Library` — otherwise a rescan would never reach the queue actually being played. Task 10's `createLibraryRouter` takes `queue` for this reason, and its test asserts `queue.setTracks` is called.
- **Fixed during drafting:** the pause segment is unbounded (no `-shortest`, no fixed duration) and killed by `stopCurrent()` on resume, rather than a fixed-length segment that needed re-looping bookkeeping — simpler and matches "loop until resume."
- **Type consistency:** `Track`, `ChildProcessLike`, `Spawner`, `SessionState`, `StreamStatus`, and `ApiError` are each defined exactly once and reused by name across all later tasks.
