import { SegmentFeeder } from '../../src/ffmpeg/segmentFeeder';
import { Spawner, ChildProcessLike } from '../../src/ffmpeg/types';
import { Track } from '../../src/playlist/types';
import { NowPlayingOverlay } from '../../src/ffmpeg/segmentArgs';
import { BLANK_OVERLAY_PNG } from '../../src/render/blankOverlay';

function fakeChild(): ChildProcessLike {
  return { pid: 123, stdout: null, stderr: null, kill: jest.fn(), once: jest.fn() };
}

const track: Track = { name: 'a', audioPath: '/music/a.mp3', coverPath: null };
const overlay: NowPlayingOverlay = { durationSeconds: 10, overlayPng: Buffer.from('fake-png-bytes'), timer: null };
const overlayWithTimer: NowPlayingOverlay = {
  durationSeconds: 65,
  overlayPng: Buffer.from('fake-png-bytes'),
  timer: { x: 10, y: 660, fontSize: 20, color: '#ffffff' },
};

function buildFeeder(overrides: Partial<{ spawner: Spawner; writeFileSync: jest.Mock }> = {}) {
  const writeFileSync = overrides.writeFileSync ?? jest.fn();
  const feeder = new SegmentFeeder({
    spawner: overrides.spawner ?? (jest.fn().mockReturnValue(fakeChild()) as Spawner),
    videoFifoPath: '/tmp/stream-dest-1-video.fifo',
    audioFifoPath: '/tmp/stream-dest-1-audio.fifo',
    backgroundPath: '/assets/background.png',
    overlayImagePath: '/tmp/overlay-dest-1.png',
    fontFile: '/fonts/DejaVuSans-Bold.ttf',
    width: 1280,
    height: 720,
    fps: 30,
    writeFileSync,
  });
  return { feeder, writeFileSync };
}

function filterComplexArg(args: string[]): string {
  return args[args.indexOf('-filter_complex') + 1];
}

describe('SegmentFeeder', () => {
  it('spawns ffmpeg with track args pointed at both raw-ES fifo paths', () => {
    const spawner: Spawner = jest.fn().mockReturnValue(fakeChild());
    const { feeder } = buildFeeder({ spawner });

    feeder.feedTrack(track, overlay);

    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-i', '/music/a.mp3']));
    const args = (spawner as jest.Mock).mock.calls[0][1] as string[];
    expect(args).toEqual(expect.arrayContaining(['-f', 'h264', '/tmp/stream-dest-1-video.fifo']));
    expect(args).toEqual(expect.arrayContaining(['-f', 'adts', '/tmp/stream-dest-1-audio.fifo']));
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

    feeder.feedTrack(track, overlay, 4);

    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-ss', '4']));
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
    feeder.feedPause(37);

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

  it('kills the outgoing process before spawning the next segment, so both never hold the fifos open for write at once', () => {
    const child1 = fakeChild();
    const child2 = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    const { feeder } = buildFeeder({ spawner });

    feeder.feedTrack(track, overlay);
    feeder.feedTrack(track, overlay);

    expect((child1.kill as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((spawner as jest.Mock).mock.invocationCallOrder[1]);
  });

  it('close() removes the overlay image file', () => {
    const { feeder } = buildFeeder();
    const unlinkSync = jest.spyOn(require('fs'), 'unlinkSync').mockImplementation(() => {});

    feeder.close();

    expect(unlinkSync).toHaveBeenCalledWith('/tmp/overlay-dest-1.png');
    unlinkSync.mockRestore();
  });
});
