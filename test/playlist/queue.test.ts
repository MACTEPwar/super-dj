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

  describe('windowSnapshot', () => {
    const names = (rows: { text: string }[]) => rows.map((r) => r.text);
    const base = () => new PlaylistQueue(['a', 'b', 'c', 'd', 'e'].map(track));

    it('shows base context around a base current track', () => {
      const q = base();
      q.next(); q.next(); // c
      expect(names(q.windowSnapshot(2, 7))).toEqual(['  a', '  b', '▶ c', '  d', '  e']);
      expect(q.windowSnapshot(2, 7).map((r) => r.key)).toEqual(['b:0', 'b:1', 'b:2', 'b:3', 'b:4']);
    });

    it('lists queued inserted tracks right after the current one (C1)', () => {
      const q = base();
      q.insertNext(track('z'));
      expect(names(q.windowSnapshot(2, 7))).toEqual(['▶ a', '  z', '  b', '  c', '  d', '  e']);
      expect(q.windowSnapshot(2, 7)[1].key).toBe('i:0');
    });

    it('caps the after-section, inserted rows first', () => {
      const q = base();
      q.insertNext(track('y'));
      q.insertNext(track('z'));
      expect(names(q.windowSnapshot(0, 3))).toEqual(['▶ a', '  y', '  z', '  b']);
    });

    it('an inserted current track keeps its key and anchors before-context on positionInBase', () => {
      const q = base();
      q.next(); // b
      q.insertNext(track('z'));
      q.next(); // z
      const rows = q.windowSnapshot(2, 7);
      expect(names(rows)).toEqual(['  a', '  b', '▶ z', '  c', '  d', '  e']);
      expect(rows[2]).toEqual({ key: 'i:0', text: '▶ z', isCurrent: true });
    });

    it('two inserts of the same Track object are two distinct rows (B9)', () => {
      const q = base();
      const z = track('z');
      q.insertNext(z);
      q.insertNext(z);
      const keys = q.windowSnapshot(0, 7).map((r) => r.key);
      expect(keys.slice(1, 3)).toEqual(['i:0', 'i:1']);
    });

    it('previous() restores the key the track had', () => {
      const q = base();
      q.insertNext(track('z'));
      q.next(); // z (i:0)
      q.next(); // b
      q.previous(); // back to z
      expect(q.windowSnapshot(0, 0)).toEqual([{ key: 'i:0', text: '▶ z', isCurrent: true }]);
    });

    it('empty playlist -> no rows', () => {
      expect(new PlaylistQueue([]).windowSnapshot(2, 7)).toEqual([]);
    });
  });
});
