import { PassThrough, Writable } from 'stream';
import { AudioRelay } from '../../src/ffmpeg/audioRelay';
import { Spawner, ChildProcessLike } from '../../src/ffmpeg/types';

function fakeChild(): ChildProcessLike & { stdout: PassThrough } {
  const stdout = new PassThrough();
  return { pid: 123, stdout, stderr: null, kill: jest.fn(), once: jest.fn() };
}

describe('AudioRelay', () => {
  it('switchTrack spawns a decode-only ffmpeg and pipes its stdout into the attached audio pipe', () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const chunks: Buffer[] = [];
    const audioPipe = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
    const relay = new AudioRelay({ spawner });
    relay.attach(audioPipe);

    relay.switchTrack('/music/a.mp3');
    child.stdout.write('pcm-bytes');
    child.stdout.end();

    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-i', '/music/a.mp3']));
    expect(Buffer.concat(chunks).toString()).toBe('pcm-bytes');
  });

  it('switchTrack passes the start offset through for a resumed track', () => {
    const spawner: Spawner = jest.fn().mockReturnValue(fakeChild());
    const relay = new AudioRelay({ spawner });
    relay.attach(new PassThrough());

    relay.switchTrack('/music/a.mp3', 42);

    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-ss', '42']));
  });

  it('switchToSilence spawns anullsrc instead of decoding a file', () => {
    const spawner: Spawner = jest.fn().mockReturnValue(fakeChild());
    const relay = new AudioRelay({ spawner });
    relay.attach(new PassThrough());

    relay.switchToSilence();

    expect(spawner).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['anullsrc=r=44100:cl=stereo']));
  });

  it('kills the outgoing process and unpipes it before spawning the next one', () => {
    const chunks: Buffer[] = [];
    const audioPipe = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
    const child1 = fakeChild();
    const child2 = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    const relay = new AudioRelay({ spawner });
    relay.attach(audioPipe);

    relay.switchTrack('/music/a.mp3');
    relay.switchTrack('/music/b.mp3');

    child1.stdout.write('stale-bytes-from-the-dying-decoder');
    child2.stdout.write('fresh-track-bytes');
    child2.stdout.end();

    expect(Buffer.concat(chunks).toString()).toBe('fresh-track-bytes');
    expect(child1.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('stopCurrent kills the active process without spawning a replacement', () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const relay = new AudioRelay({ spawner });
    relay.attach(new PassThrough());

    relay.switchTrack('/music/a.mp3');
    relay.stopCurrent();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('close() stops the active process', () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const relay = new AudioRelay({ spawner });
    relay.attach(new PassThrough());

    relay.switchTrack('/music/a.mp3');
    relay.close();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('switchTrack returns the spawned child so the caller can listen for natural end-of-track', () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const relay = new AudioRelay({ spawner });
    relay.attach(new PassThrough());

    const returned = relay.switchTrack('/music/a.mp3');

    expect(returned).toBe(child);
  });
});
