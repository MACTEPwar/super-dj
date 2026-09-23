import { PlaylistQueue } from '../../src/playlist/queue';
import { Track } from '../../src/playlist/types';

const track = (name: string): Track => ({ name, audioPath: `/music/${name}.mp3`, coverPath: null });

describe('PlaylistQueue', () => {
  it('starts on the first track', () => {
    const queue = new PlaylistQueue([track('a'), track('b')]);
    expect(queue.current()?.name).toBe('a');
  });

  it('handles an empty playlist without throwing', () => {
    const queue = new PlaylistQueue([]);
    expect(queue.current()).toBeUndefined();
    expect(queue.next()).toBeUndefined();
    expect(queue.previous()).toBeUndefined();
  });

  it('advances forward and wraps around at the end', () => {
    const queue = new PlaylistQueue([track('a'), track('b')]);
    expect(queue.next()?.name).toBe('b');
    expect(queue.next()?.name).toBe('a');
  });

  it('previous() steps back through history', () => {
    const queue = new PlaylistQueue([track('a'), track('b'), track('c')]);
    queue.next();
    queue.next();
    expect(queue.current()?.name).toBe('c');
    expect(queue.previous()?.name).toBe('b');
    expect(queue.previous()?.name).toBe('a');
  });

  it('previous() at the start stays on the current track', () => {
    const queue = new PlaylistQueue([track('a'), track('b')]);
    expect(queue.previous()?.name).toBe('a');
  });

  it('insertNext plays once, then playback continues from base order', () => {
    const queue = new PlaylistQueue([track('a'), track('b'), track('c')]);
    queue.insertNext(track('z'));
    expect(queue.peekNext()?.name).toBe('z');
    expect(queue.next()?.name).toBe('z');
    expect(queue.next()?.name).toBe('b');
  });

  it('insertNext queues multiple tracks in order instead of overwriting the previous one', () => {
    const queue = new PlaylistQueue([track('a'), track('b'), track('c')]);
    queue.insertNext(track('donation-1'));
    queue.insertNext(track('donation-2'));
    expect(queue.peekNext()?.name).toBe('donation-1');
    expect(queue.next()?.name).toBe('donation-1');
    expect(queue.next()?.name).toBe('donation-2');
    expect(queue.next()?.name).toBe('b');
  });

  it('setTracks keeps the current track in sync with its new position', () => {
    const queue = new PlaylistQueue([track('a'), track('b')]);
    queue.setTracks([track('z'), track('a'), track('b')]);
    expect(queue.current()?.name).toBe('a');
    expect(queue.next()?.name).toBe('b');
  });

  it('positionInBase stays on the base track while an inserted track is current', () => {
    const queue = new PlaylistQueue([track('a'), track('b'), track('c')]);
    queue.next(); // b
    queue.insertNext(track('z'));
    queue.next(); // z
    expect(queue.current()?.name).toBe('z');
    expect(queue.positionInBase()).toBe(1);
  });

  describe('ephemeral tracks', () => {
    const ephemeral = (name: string): Track => ({ name, audioPath: `/tmp/${name}.mp3`, coverPath: null, ephemeral: true });

    it('an ephemeral track plays once from the inserted FIFO but never enters history', () => {
      const queue = new PlaylistQueue([track('a'), track('b'), track('c')]);
      queue.insertNext(ephemeral('donation'));
      expect(queue.next()?.name).toBe('donation');
      expect(queue.next()?.name).toBe('b');
      // history is [a] — the donation was skipped over when it stopped being current
      expect(queue.previous()?.name).toBe('a');
      expect(queue.previous()?.name).toBe('a');
    });

    it('a non-ephemeral inserted track still joins history (play-by-name semantics unchanged)', () => {
      const queue = new PlaylistQueue([track('a'), track('b')]);
      queue.insertNext(track('z'));
      queue.next(); // z
      queue.next(); // b
      expect(queue.previous()?.name).toBe('z');
    });
  });
});
