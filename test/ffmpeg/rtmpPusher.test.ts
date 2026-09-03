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

  it('does not invoke onExit for the exit that follows an intentional stop', () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const pusher = new RtmpPusher(spawner, { fifoPath: '/tmp/fifo', rtmpUrl: 'rtmp://x', streamKey: 'k' });
    const onExit = jest.fn();

    pusher.start(onExit);
    pusher.stop();
    child.emitExit(null);

    expect(onExit).not.toHaveBeenCalled();
  });

  it('reports unexpected exits again after a stop/start cycle', () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const pusher = new RtmpPusher(spawner, { fifoPath: '/tmp/fifo', rtmpUrl: 'rtmp://x', streamKey: 'k' });
    const onExit = jest.fn();

    pusher.start(() => {});
    pusher.stop();
    pusher.start(onExit);
    child.emitExit(1);

    expect(onExit).toHaveBeenCalledWith(1);
  });
});
