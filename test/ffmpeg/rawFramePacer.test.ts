import { EventEmitter } from 'events';
import { RawFramePacer, MAX_CATCH_UP_FRAMES } from '../../src/ffmpeg/rawFramePacer';

function fakePipe() {
  const pipe: any = new EventEmitter();
  pipe.writes = [] as Buffer[];
  pipe.writableNeedDrain = false;
  pipe.write = (b: Buffer) => { pipe.writes.push(b); return true; };
  return pipe;
}

describe('RawFramePacer', () => {
  it('writes nothing until a frame is set', () => {
    const clock = { s: 0 };
    const pacer = new RawFramePacer({ fps: 30, now: () => clock.s });
    const pipe = fakePipe();
    pacer.attach(pipe);
    clock.s = 1;
    pacer.writeDueFrames();
    expect(pipe.writes).toHaveLength(0);
  });

  it('writes exactly the frames due at the declared rate, capped by MAX_CATCH_UP_FRAMES', () => {
    const clock = { s: 0 };
    const pacer = new RawFramePacer({ fps: 30, now: () => clock.s });
    const pipe = fakePipe();
    pacer.attach(pipe);
    pacer.setFrame(Buffer.from([1]));
    clock.s = 0.1; // 3 frames due
    pacer.writeDueFrames();
    expect(pipe.writes).toHaveLength(3);
    clock.s = 10; // hundreds due -> capped
    pacer.writeDueFrames();
    expect(pipe.writes).toHaveLength(3 + MAX_CATCH_UP_FRAMES);
    expect(pacer.framesWritten).toBe(3 + MAX_CATCH_UP_FRAMES);
  });

  it('forgives frames while the pipe is backed up and owes one on drain', () => {
    const clock = { s: 0 };
    const pacer = new RawFramePacer({ fps: 30, now: () => clock.s });
    const pipe = fakePipe();
    pacer.attach(pipe);
    pacer.setFrame(Buffer.from([1]));
    pipe.writableNeedDrain = true;
    clock.s = 1; // 30 due, pipe blocked
    pacer.writeDueFrames();
    expect(pipe.writes).toHaveLength(0);
    pipe.writableNeedDrain = false;
    pipe.emit('drain');
    expect(pipe.writes).toHaveLength(1);
  });

  it('never writes after detach', () => {
    const clock = { s: 0 };
    const pacer = new RawFramePacer({ fps: 30, now: () => clock.s });
    const pipe = fakePipe();
    pacer.attach(pipe);
    pacer.setFrame(Buffer.from([1]));
    pacer.detach();
    clock.s = 1;
    pacer.writeDueFrames();
    pipe.emit('drain');
    expect(pipe.writes).toHaveLength(0);
  });
});
