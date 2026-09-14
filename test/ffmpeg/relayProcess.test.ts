import { RelayProcess } from '../../src/ffmpeg/relayProcess';
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

function buildRelay(spawner: Spawner) {
  return new RelayProcess({
    spawner,
    inputUrl: 'rtmp://mediamtx:1935/live/token?user=sub&pass=s',
    outputUrl: 'rtmp://dest.example/app/key',
  });
}

describe('RelayProcess', () => {
  it('spawns ffmpeg with the relay args and returns the child', () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const returned = buildRelay(spawner).start(() => {});
    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-c', 'copy', '-f', 'flv', 'rtmp://dest.example/app/key']));
    expect(returned).toBe(child);
  });

  it('invokes onExit when the relay dies unexpectedly', () => {
    const child = fakeChild();
    const onExit = jest.fn();
    buildRelay(jest.fn().mockReturnValue(child) as Spawner).start(onExit);
    child.emitExit(1);
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('kills the child on stop', () => {
    const child = fakeChild();
    const relay = buildRelay(jest.fn().mockReturnValue(child) as Spawner);
    relay.start(() => {});
    relay.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  // The same guard PersistentEncoder needs, for the same reason: a deliberate kill must not be
  // mistaken for a dropped destination and trigger a respawn (or, worse, finalize a broadcast the
  // caller is in the middle of toggling off).
  it('does not invoke onExit for the exit that follows a deliberate stop', () => {
    const child = fakeChild();
    const onExit = jest.fn();
    const relay = buildRelay(jest.fn().mockReturnValue(child) as Spawner);
    relay.start(onExit);
    relay.stop();
    child.emitExit(null);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('reports unexpected exits again after a stop/start cycle', () => {
    const child = fakeChild();
    const onExit = jest.fn();
    const relay = buildRelay(jest.fn().mockReturnValue(child) as Spawner);
    relay.start(() => {});
    relay.stop();
    relay.start(onExit);
    child.emitExit(1);
    expect(onExit).toHaveBeenCalledWith(1);
  });
});
