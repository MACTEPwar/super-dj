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

  describe('donation queue', () => {
    it('is separate from insertNext\'s FIFO and does not affect next()/peekNext()', () => {
      const queue = new PlaylistQueue([track('a'), track('b')]);
      queue.enqueueDonation(track('donation-1'));
      expect(queue.peekNext()?.name).toBe('b');
      expect(queue.next()?.name).toBe('b');
    });

    it('shiftDonation drains in FIFO order and does not touch current()/history/position', () => {
      const queue = new PlaylistQueue([track('a'), track('b'), track('c')]);
      queue.enqueueDonation(track('donation-1'));
      queue.enqueueDonation(track('donation-2'));

      expect(queue.hasDonationPending()).toBe(true);
      expect(queue.shiftDonation()?.name).toBe('donation-1');
      expect(queue.current()?.name).toBe('a');
      expect(queue.positionInBase()).toBe(0);

      expect(queue.shiftDonation()?.name).toBe('donation-2');
      expect(queue.hasDonationPending()).toBe(false);
      expect(queue.shiftDonation()).toBeUndefined();
      expect(queue.current()?.name).toBe('a');
    });

    it('positionInBase tracks real advancement only, never a donation pull', () => {
      const queue = new PlaylistQueue([track('a'), track('b'), track('c')]);
      queue.next();
      expect(queue.positionInBase()).toBe(1);
      queue.enqueueDonation(track('donation-1'));
      queue.shiftDonation();
      expect(queue.positionInBase()).toBe(1);
    });
  });
});
