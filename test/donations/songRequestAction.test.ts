import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { executeSongRequest, SongRequestDeps } from '../../src/donations/songRequestAction';
import { MediaSearchError } from '../../src/media/mediaSearchClient';

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
    const streamInserter = { enqueueTrack: jest.fn() };
    const deps: SongRequestDeps = { mediaSearchClient, streamInserter, tempDir, targetUserId: 'user-123' };

    await expect(executeSongRequest(deps, 'Blur - Song 2')).resolves.toEqual({ ok: true });

    expect(mediaSearchClient.fetchAudio).toHaveBeenCalledWith('Blur - Song 2');
    expect(streamInserter.enqueueTrack).toHaveBeenCalledTimes(1);
    const [userId, track] = streamInserter.enqueueTrack.mock.calls[0];
    expect(userId).toBe('user-123');
    expect(track.name).toBe('🎁 Заказ: Blur - Song 2');
    expect(track.coverPath).toBeNull();
    expect(await fs.readFile(track.audioPath)).toEqual(audioBytes);
    expect(typeof track._onFinished).toBe('function');
    const inserted = streamInserter.enqueueTrack.mock.calls[0][1];
    expect(inserted.ephemeral).toBe(true);
    expect(typeof inserted._onFinished).toBe('function');
  });

  it('deletes the temp file when _onFinished is called', async () => {
    const mediaSearchClient = { fetchAudio: jest.fn().mockResolvedValue(Buffer.from([1, 2, 3])) };
    const streamInserter = { enqueueTrack: jest.fn() };
    const deps: SongRequestDeps = { mediaSearchClient, streamInserter, tempDir, targetUserId: 'user-123' };

    await executeSongRequest(deps, 'some query');

    const track = streamInserter.enqueueTrack.mock.calls[0][1];
    await expect(fs.access(track.audioPath)).resolves.toBeUndefined();
    track._onFinished();
    await new Promise((resolve) => setImmediate(resolve)); // let the fire-and-forget unlink run
    await expect(fs.access(track.audioPath)).rejects.toThrow();
  });

  it('logs and does nothing when the media search fails', async () => {
    const mediaSearchClient = { fetchAudio: jest.fn().mockRejectedValue(new MediaSearchError('not found')) };
    const streamInserter = { enqueueTrack: jest.fn() };
    const deps: SongRequestDeps = { mediaSearchClient, streamInserter, tempDir, targetUserId: 'user-123' };
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(executeSongRequest(deps, 'nonexistent track')).resolves.toEqual({
      ok: false, reason: 'mediaSearchFailed', message: 'not found',
    });
    expect(streamInserter.enqueueTrack).not.toHaveBeenCalled();
    const filesLeft = await fs.readdir(tempDir);
    expect(filesLeft).toEqual([]);
  });

  it('logs and does nothing when writing the temp file fails', async () => {
    const mediaSearchClient = { fetchAudio: jest.fn().mockResolvedValue(Buffer.from([1, 2, 3])) };
    const streamInserter = { enqueueTrack: jest.fn() };
    const deps: SongRequestDeps = { mediaSearchClient, streamInserter, tempDir, targetUserId: 'user-123' };
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const writeFileSpy = jest.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));

    await expect(executeSongRequest(deps, 'some query')).resolves.toEqual({
      ok: false, reason: 'writeFailed', message: 'ENOSPC: no space left on device',
    });

    expect(streamInserter.enqueueTrack).not.toHaveBeenCalled();
    const filesLeft = await fs.readdir(tempDir);
    expect(filesLeft).toEqual([]);
    writeFileSpy.mockRestore();
  });

  it('deletes the temp file if inserting into the stream throws (no active session)', async () => {
    const mediaSearchClient = { fetchAudio: jest.fn().mockResolvedValue(Buffer.from([1, 2, 3])) };
    const streamInserter = { enqueueTrack: jest.fn().mockImplementation(() => { throw new Error('local stream is not active'); }) };
    const deps: SongRequestDeps = { mediaSearchClient, streamInserter, tempDir, targetUserId: 'user-123' };
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(executeSongRequest(deps, 'some query')).resolves.toEqual({
      ok: false, reason: 'noActiveStream', message: 'local stream is not active',
    });

    const filesLeft = await fs.readdir(tempDir);
    expect(filesLeft).toEqual([]);
  });
});
