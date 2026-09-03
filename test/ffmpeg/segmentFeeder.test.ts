import { PassThrough, Writable } from 'stream';
import { SegmentFeeder } from '../../src/ffmpeg/segmentFeeder';
import { Spawner, ChildProcessLike } from '../../src/ffmpeg/types';
import { Track } from '../../src/playlist/types';
import { NowPlayingOverlay } from '../../src/ffmpeg/segmentArgs';
import { BLANK_OVERLAY_PNG } from '../../src/render/blankOverlay';

function fakeChild(): ChildProcessLike & { stdout: PassThrough } {
  const stdout = new PassThrough();
  return { pid: 123, stdout, stderr: null, kill: jest.fn(), once: jest.fn() };
}

const track: Track = { name: 'a', audioPath: '/music/a.mp3', coverPath: null };
const overlay: NowPlayingOverlay = { durationSeconds: 10, overlayPng: Buffer.from('fake-png-bytes'), timer: null };
const overlayWithTimer: NowPlayingOverlay = {
  durationSeconds: 65,
  overlayPng: Buffer.from('fake-png-bytes'),
  timer: { x: 10, y: 660, fontSize: 20, color: '#ffffff' },
};

function buildFeeder(overrides: Partial<{ spawner: Spawner; createWriteStream: () => NodeJS.WritableStream; writeFileSync: jest.Mock }> = {}) {
  const writeFileSync = overrides.writeFileSync ?? jest.fn();
  const feeder = new SegmentFeeder({
    spawner: overrides.spawner ?? (jest.fn().mockReturnValue(fakeChild()) as Spawner),
    fifoPath: '/tmp/fifo',
    backgroundPath: '/assets/background.png',
    overlayImagePath: '/tmp/overlay-dest-1.png',
    fontFile: '/fonts/DejaVuSans-Bold.ttf',
    width: 1280,
    height: 720,
    fps: 30,
    createWriteStream: overrides.createWriteStream ?? (() => new PassThrough()),
    writeFileSync,
  });
  return { feeder, writeFileSync };
}

function filterComplexArg(args: string[]): string {
  return args[args.indexOf('-filter_complex') + 1];
}

describe('SegmentFeeder', () => {
  it('spawns ffmpeg with track args and pipes stdout into the fifo stream', () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const chunks: Buffer[] = [];
    const writeStream = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
    const { feeder } = buildFeeder({ spawner, createWriteStream: () => writeStream });

    feeder.feedTrack(track, overlay);
    child.stdout.write('segment-bytes');
    child.stdout.end();

    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-i', '/music/a.mp3']));
    expect(Buffer.concat(chunks).toString()).toBe('segment-bytes');
  });

  it('feedTrack writes the rendered overlay PNG to the fixed overlay path before spawning ffmpeg', () => {
    const spawner: Spawner = jest.fn().mockReturnValue(fakeChild());
    const { feeder, writeFileSync } = buildFeeder({ spawner });

    feeder.feedTrack(track, overlay);

    expect(writeFileSync).toHaveBeenCalledWith('/tmp/overlay-dest-1.png', overlay.overlayPng);
    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-loop', '1', '-i', '/tmp/overlay-dest-1.png']));
  });

  it('feedTrack passes the start offset through for a resumed track', () => {
    const spawner: Spawner = jest.fn().mockReturnValue(fakeChild());
    const { feeder } = buildFeeder({ spawner });

    feeder.feedTrack(track, overlay, 42);

    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-ss', '42']));
  });

  it('feedTrack does not add a timer drawtext when the template has no timer element', () => {
    const spawner: Spawner = jest.fn().mockReturnValue(fakeChild());
    const { feeder } = buildFeeder({ spawner });

    feeder.feedTrack(track, overlay);

    const args = (spawner as jest.Mock).mock.calls[0][1] as string[];
    expect(filterComplexArg(args)).not.toContain('drawtext');
  });

  it('feedTrack builds a live, pts-driven timer expression carrying the seek offset forward, when the template has a timer', () => {
    const spawner: Spawner = jest.fn().mockReturnValue(fakeChild());
    const { feeder } = buildFeeder({ spawner });

    feeder.feedTrack(track, overlayWithTimer, 12);

    const args = (spawner as jest.Mock).mock.calls[0][1] as string[];
    const filterComplex = filterComplexArg(args);
    expect(filterComplex).toContain('drawtext=fontfile=/fonts/DejaVuSans-Bold.ttf');
    expect(filterComplex).toContain("text='%{pts\\:hms\\:12} / 1\\:05'");
    expect(filterComplex).toContain('x=10:y=660:fontsize=20:fontcolor=#ffffff');
  });

  it('feedPause reuses the overlay PNG already written by the last feedTrack, without rewriting it', () => {
    const spawner: Spawner = jest.fn().mockReturnValue(fakeChild());
    const { feeder, writeFileSync } = buildFeeder({ spawner });

    feeder.feedTrack(track, overlay);
    writeFileSync.mockClear();
    feeder.feedPause();

    expect(writeFileSync).not.toHaveBeenCalled();
    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-i', '/assets/background.png', '-loop', '1', '-i', '/tmp/overlay-dest-1.png', '-f', 'lavfi']));
  });

  it('feedPause writes the shared blank overlay when no track has ever been fed yet, instead of pointing ffmpeg at a missing file', () => {
    const spawner: Spawner = jest.fn().mockReturnValue(fakeChild());
    const { feeder, writeFileSync } = buildFeeder({ spawner });

    feeder.feedPause();

    expect(writeFileSync).toHaveBeenCalledWith('/tmp/overlay-dest-1.png', BLANK_OVERLAY_PNG);
  });

  it('feedPause freezes the timer at the given track-elapsed position instead of a live pts expression', () => {
    const spawner: Spawner = jest.fn().mockReturnValue(fakeChild());
    const { feeder } = buildFeeder({ spawner });

    feeder.feedTrack(track, overlayWithTimer);
    feeder.feedPause(0, 37);

    const args = (spawner as jest.Mock).mock.calls[1][1] as string[];
    const filterComplex = filterComplexArg(args);
    expect(filterComplex).toContain("text='0\\:37 / 1\\:05'");
    expect(filterComplex).not.toContain('%{pts');
  });

  it('stopCurrent kills the active process', () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const { feeder } = buildFeeder({ spawner });

    feeder.feedTrack(track, overlay);
    feeder.stopCurrent();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('unpipes the outgoing producer so a still-draining old segment cannot interleave with the next one', () => {
    // kill('SIGTERM') doesn't make a real ffmpeg process's stdout stop emitting data
    // immediately — there's a window before it actually exits. Without an explicit
    // unpipe, that leftover data and the next segment's data would both flow into the
    // same fifo write stream at once, interleaving two MPEG-TS streams into one
    // corrupted byte stream (the artifacts/slow-recovery a track switch used to cause).
    const chunks: Buffer[] = [];
    const writeStream = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
    const child1 = fakeChild();
    const child2 = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    const { feeder } = buildFeeder({ spawner, createWriteStream: () => writeStream });

    feeder.feedTrack(track, overlay);
    feeder.feedTrack(track, overlay);

    child1.stdout.write('stale-bytes-from-the-dying-process');
    child2.stdout.write('fresh-segment-bytes');
    child2.stdout.end();

    expect(Buffer.concat(chunks).toString()).toBe('fresh-segment-bytes');
  });

  it('close() ends the fifo write stream', () => {
    const writeStream = new PassThrough();
    const endSpy = jest.spyOn(writeStream, 'end');
    const { feeder } = buildFeeder({ createWriteStream: () => writeStream });

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
