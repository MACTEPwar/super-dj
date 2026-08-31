// StreamManager wires the real createFifo/removeFifo and getAudioDurationSeconds
// (they aren't part of StreamManagerDeps — only the Spawner is injected there).
// Per this repo's testing strategy ("everything touching ffmpeg is injected as a
// Spawner fake — unit tests never spawn real ffmpeg"), mock these two modules so
// start() never shells out to a real `mkfifo`/`ffprobe` against the fixture's
// non-existent /music/*.mp3 paths.
jest.mock('../../src/ffmpeg/fifo', () => ({
  createFifo: jest.fn(),
  removeFifo: jest.fn(),
}));
jest.mock('../../src/ffmpeg/duration', () => ({
  getAudioDurationSeconds: jest.fn().mockResolvedValue(100),
}));

import { PassThrough } from 'stream';
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
  // SegmentFeeder opens a real fs.createWriteStream on the fifo path unless overridden;
  // fake it so start()/tests never touch the real filesystem (same rationale as the
  // fifo/duration module mocks above — no real fs/subprocess touches in a unit test).
  const createWriteStream = jest.fn().mockImplementation(() => new PassThrough());
  return {
    deps: {
      spawner, fifoDir: '/tmp', defaultCoverPath: '/assets/default.png', backgroundImagePath: '/assets/bg.png',
      fontFile: '/fonts/x.ttf', playlistRepository, destinationRepository, trackRepository, createWriteStream,
    },
    destinationRepository, playlistRepository, trackRepository, createWriteStream,
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
    const { deps, createWriteStream } = buildDeps();
    const manager = new StreamManager(deps as any, KEY);

    await manager.start('dest-1', 'playlist-1');

    expect(manager.get('dest-1')).toBeDefined();
    expect(manager.status('dest-1').state).toBe('streaming');
    expect(manager.status('dest-1').currentTrack).toBe('a');
    // Proves SegmentFeeder's real fs.createWriteStream(fifoPath) call was actually
    // routed through the injected fake, not silently falling back to touching disk.
    expect(createWriteStream).toHaveBeenCalledWith('/tmp/super-dj-stream-dest-1.fifo');
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
