import { createFifo, removeFifo } from '../../src/ffmpeg/fifo';

describe('fifo helpers', () => {
  it('createFifo shells out to mkfifo with the given path', () => {
    const execFileFn = jest.fn();
    createFifo('/tmp/x.fifo', execFileFn as any);
    expect(execFileFn).toHaveBeenCalledWith('mkfifo', ['/tmp/x.fifo']);
  });

  it('removeFifo unlinks the file', () => {
    const unlinkFn = jest.fn();
    removeFifo('/tmp/x.fifo', unlinkFn as any);
    expect(unlinkFn).toHaveBeenCalledWith('/tmp/x.fifo');
  });

  it('removeFifo swallows ENOENT', () => {
    const err = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const unlinkFn = jest.fn(() => { throw err; });
    expect(() => removeFifo('/tmp/x.fifo', unlinkFn as any)).not.toThrow();
  });

  it('removeFifo rethrows other errors', () => {
    const err = Object.assign(new Error('boom'), { code: 'EACCES' });
    const unlinkFn = jest.fn(() => { throw err; });
    expect(() => removeFifo('/tmp/x.fifo', unlinkFn as any)).toThrow('boom');
  });
});
