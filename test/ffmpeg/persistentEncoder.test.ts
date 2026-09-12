import { PersistentEncoder } from '../../src/ffmpeg/persistentEncoder';
import { PipeSpawner, ChildProcessWithPipes } from '../../src/ffmpeg/types';
import { PassThrough } from 'stream';

function fakeChild(): ChildProcessWithPipes & { emitExit: (code: number | null) => void } {
  let exitListener: ((code: number | null) => void) | null = null;
  return {
    pid: 1,
    stdout: null,
    stderr: null,
    videoPipe: new PassThrough(),
    audioPipe: new PassThrough(),
    pulsePipe: new PassThrough(),
    aboveCanvasPipe: new PassThrough(),
    kill: jest.fn(),
    once: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'exit') exitListener = listener as (code: number | null) => void;
    }),
    emitExit: (code) => exitListener && exitListener(code),
  };
}

function buildEncoder(spawner: PipeSpawner) {
  return new PersistentEncoder({
    spawner, width: 1280, height: 720, fps: 30, heartbeatFps: 5,
    rtmpUrl: 'rtmp://x', streamKey: 'k', backgroundPath: '/assets/background.png',
  });
}

describe('PersistentEncoder', () => {
  it('starts ffmpeg with the persistent encoder args and returns the child (with its video/audio pipes)', () => {
    const child = fakeChild();
    const spawner: PipeSpawner = jest.fn().mockReturnValue(child);
    const encoder = buildEncoder(spawner);

    const returned = encoder.start(() => {});

    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-i', 'pipe:3', '-i', 'pipe:4']));
    expect(returned).toBe(child);
    expect(returned.videoPipe).toBeDefined();
    expect(returned.audioPipe).toBeDefined();
  });

  it('invokes onExit when the process exits unexpectedly', () => {
    const child = fakeChild();
    const spawner: PipeSpawner = jest.fn().mockReturnValue(child);
    const encoder = buildEncoder(spawner);
    const onExit = jest.fn();

    encoder.start(onExit);
    child.emitExit(1);

    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('stop kills the running process', () => {
    const child = fakeChild();
    const spawner: PipeSpawner = jest.fn().mockReturnValue(child);
    const encoder = buildEncoder(spawner);

    encoder.start(() => {});
    encoder.stop();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not invoke onExit for the exit that follows an intentional stop', () => {
    const child = fakeChild();
    const spawner: PipeSpawner = jest.fn().mockReturnValue(child);
    const encoder = buildEncoder(spawner);
    const onExit = jest.fn();

    encoder.start(onExit);
    encoder.stop();
    child.emitExit(null);

    expect(onExit).not.toHaveBeenCalled();
  });

  it('reports unexpected exits again after a stop/start cycle', () => {
    const child = fakeChild();
    const spawner: PipeSpawner = jest.fn().mockReturnValue(child);
    const encoder = buildEncoder(spawner);
    const onExit = jest.fn();

    encoder.start(() => {});
    encoder.stop();
    encoder.start(onExit);
    child.emitExit(1);

    expect(onExit).toHaveBeenCalledWith(1);
  });
});
