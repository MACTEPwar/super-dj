import { PassThrough, Writable } from 'stream';
import { SegmentFeeder } from '../../src/ffmpeg/segmentFeeder';
import { Spawner, ChildProcessLike } from '../../src/ffmpeg/types';
import { Track } from '../../src/playlist/types';

function fakeChild(): ChildProcessLike & { stdout: PassThrough } {
  const stdout = new PassThrough();
  return { pid: 123, stdout, stderr: null, kill: jest.fn(), once: jest.fn() };
}

const track: Track = { name: 'a', audioPath: '/music/a.mp3', coverPath: null };
const overlay = { title: 'a', playlistLines: ['▶ a'], durationSeconds: 10 };

function buildFeeder(overrides: Partial<{ spawner: Spawner; createWriteStream: () => NodeJS.WritableStream }> = {}) {
  return new SegmentFeeder({
    spawner: overrides.spawner ?? (jest.fn().mockReturnValue(fakeChild()) as Spawner),
    fifoPath: '/tmp/fifo',
    defaultCoverPath: '/assets/default.png',
    backgroundPath: '/assets/background.png',
    fontFile: '/fonts/DejaVuSans-Bold.ttf',
    width: 1280,
    height: 720,
    fps: 30,
    createWriteStream: overrides.createWriteStream ?? (() => new PassThrough()),
  });
}

describe('SegmentFeeder', () => {
  it('spawns ffmpeg with track args and pipes stdout into the fifo stream', () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const chunks: Buffer[] = [];
    const writeStream = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
    const feeder = buildFeeder({ spawner, createWriteStream: () => writeStream });

    feeder.feedTrack(track, overlay);
    child.stdout.write('segment-bytes');
    child.stdout.end();

    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-i', '/music/a.mp3']));
    expect(Buffer.concat(chunks).toString()).toBe('segment-bytes');
  });

  it('feedTrack falls back to the default cover when the track has none', () => {
    const spawner: Spawner = jest.fn().mockReturnValue(fakeChild());
    const feeder = buildFeeder({ spawner });

    feeder.feedTrack(track, overlay);

    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-i', '/assets/default.png']));
  });

  it('feedTrack passes the start offset through for a resumed track', () => {
    const spawner: Spawner = jest.fn().mockReturnValue(fakeChild());
    const feeder = buildFeeder({ spawner });

    feeder.feedTrack(track, overlay, 42);

    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-ss', '42']));
  });

  it('feedPause spawns the background+silence args', () => {
    const spawner: Spawner = jest.fn().mockReturnValue(fakeChild());
    const feeder = buildFeeder({ spawner });

    feeder.feedPause();

    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-i', '/assets/background.png', '-f', 'lavfi']));
  });

  it('stopCurrent kills the active process', () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const feeder = buildFeeder({ spawner });

    feeder.feedTrack(track, overlay);
    feeder.stopCurrent();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('close() ends the fifo write stream', () => {
    const writeStream = new PassThrough();
    const endSpy = jest.spyOn(writeStream, 'end');
    const feeder = buildFeeder({ createWriteStream: () => writeStream });

    feeder.close();

    expect(endSpy).toHaveBeenCalled();
  });

  it('does not crash the process when the fifo write stream errors (e.g. EPIPE after the pusher dies)', () => {
    // A Node EventEmitter with no 'error' listener throws synchronously on emit('error', ...)
    // — this is exactly how an unhandled EPIPE on the fifo write stream used to crash the
    // entire server (every other user's active stream included), not just this one.
    const writeStream = new PassThrough();
    buildFeeder({ createWriteStream: () => writeStream });

    expect(() => writeStream.emit('error', new Error('EPIPE: broken pipe, write'))).not.toThrow();
  });
});
