import { StreamController } from '../../src/stream/streamController';
import { ApiError } from '../../src/errors';
import { Track } from '../../src/playlist/types';

const track = (name: string): Track => ({ name, audioPath: `/music/${name}.mp3`, coverPath: null });
const overlayFor = (t: Track) => ({ title: t.name, playlistLines: [`▶ ${t.name}`], durationSeconds: 100 });

function buildDeps() {
  const tracks = [track('a'), track('b')];
  const library = {
    list: jest.fn().mockReturnValue(tracks),
    findByName: jest.fn((name: string) => tracks.find((t) => t.name === name)),
  };
  const queue = {
    current: jest.fn().mockReturnValue(tracks[0]),
    next: jest.fn().mockReturnValue(tracks[1]),
    previous: jest.fn().mockReturnValue(tracks[0]),
    insertNext: jest.fn(),
    peekNext: jest.fn().mockReturnValue(tracks[1]),
  };
  const feeder = { feedTrack: jest.fn(), feedPause: jest.fn(), stopCurrent: jest.fn() };
  const pusher = { start: jest.fn(), stop: jest.fn() };
  const deps: any = {
    library, queue, fifoPath: '/tmp/fifo',
    createFifo: jest.fn(), removeFifo: jest.fn(),
    createSegmentFeeder: jest.fn().mockReturnValue(feeder),
    createRtmpPusher: jest.fn().mockReturnValue(pusher),
    buildOverlay: jest.fn(overlayFor),
  };
  return { deps, library, queue, feeder, pusher };
}

describe('StreamController', () => {
  it('start() creates the fifo, starts the pusher and feeds the current track with no offset', () => {
    const { deps, feeder, pusher } = buildDeps();
    const controller = new StreamController(deps);

    controller.start();

    expect(deps.createFifo).toHaveBeenCalledWith('/tmp/fifo');
    expect(pusher.start).toHaveBeenCalled();
    expect(feeder.feedTrack).toHaveBeenCalledWith(
      { name: 'a', audioPath: '/music/a.mp3', coverPath: null },
      overlayFor(track('a')),
    );
    expect(controller.status().state).toBe('streaming');
  });

  it('start() throws 409 when already streaming', () => {
    const { deps } = buildDeps();
    const controller = new StreamController(deps);
    controller.start();
    expect(() => controller.start()).toThrow(ApiError);
  });

  it('start() throws 409 when the library is empty', () => {
    const { deps } = buildDeps();
    deps.library.list.mockReturnValue([]);
    const controller = new StreamController(deps);
    expect(() => controller.start()).toThrow('library is empty');
  });

  it('pause() then resume() seeks feedTrack to the elapsed position', () => {
    const { deps, feeder } = buildDeps();
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000);
    const controller = new StreamController(deps);
    controller.start();

    nowSpy.mockReturnValue(1_000 + 12_345);
    controller.pause();
    expect(feeder.feedPause).toHaveBeenCalled();
    expect(controller.status().state).toBe('paused');

    nowSpy.mockReturnValue(1_000 + 20_000);
    controller.resume();

    expect(feeder.feedTrack).toHaveBeenLastCalledWith(
      { name: 'a', audioPath: '/music/a.mp3', coverPath: null },
      overlayFor(track('a')),
      12.345,
    );
    expect(controller.status().state).toBe('streaming');

    nowSpy.mockRestore();
  });

  it('next() advances the queue, resets elapsed time and feeds the new track while streaming', () => {
    const { deps, queue, feeder } = buildDeps();
    const controller = new StreamController(deps);
    controller.start();

    controller.next();

    expect(queue.next).toHaveBeenCalled();
    expect(feeder.feedTrack).toHaveBeenLastCalledWith(
      { name: 'b', audioPath: '/music/b.mp3', coverPath: null },
      overlayFor(track('b')),
    );
  });

  it('next() throws 409 when idle', () => {
    const { deps } = buildDeps();
    const controller = new StreamController(deps);
    expect(() => controller.next()).toThrow(ApiError);
  });

  it('playByName() inserts into the queue without switching immediately', () => {
    const { deps, queue, feeder } = buildDeps();
    const controller = new StreamController(deps);
    controller.start();
    feeder.feedTrack.mockClear();

    controller.playByName('b');

    expect(queue.insertNext).toHaveBeenCalledWith({ name: 'b', audioPath: '/music/b.mp3', coverPath: null });
    expect(feeder.feedTrack).not.toHaveBeenCalled();
  });

  it('playByName() throws 404 for an unknown track', () => {
    const { deps } = buildDeps();
    const controller = new StreamController(deps);
    expect(() => controller.playByName('missing')).toThrow(ApiError);
  });

  it('stop() tears down the feeder, pusher and fifo', () => {
    const { deps, feeder, pusher } = buildDeps();
    const controller = new StreamController(deps);
    controller.start();

    controller.stop();

    expect(feeder.stopCurrent).toHaveBeenCalled();
    expect(pusher.stop).toHaveBeenCalled();
    expect(deps.removeFifo).toHaveBeenCalledWith('/tmp/fifo');
    expect(controller.status().state).toBe('idle');
  });
});
