import { formatDuration, buildPlaylistWindowLines, buildInsertedTrackWindowLines } from '../../src/ffmpeg/overlayText';
import { Track } from '../../src/playlist/types';

const track = (name: string): Track => ({ name, audioPath: `/music/${name}.mp3`, coverPath: null });

describe('formatDuration', () => {
  it('formats sub-hour durations as M:SS', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(5)).toBe('0:05');
  });

  it('formats hour-plus durations as H:MM:SS', () => {
    expect(formatDuration(3725)).toBe('1:02:05');
  });

  it('clamps negative input to zero', () => {
    expect(formatDuration(-10)).toBe('0:00');
  });

  // Colons stay UNescaped here: segmentArgs.ts's overlayFilterComplex() is the single layer
  // that escapes them for ffmpeg drawtext. Escaping in both places produced '1\\:05', which
  // real ffmpeg rejects, dropping every frame of a timer-bearing stream.
  it('leaves colons unescaped — filter-string escaping happens at the filter boundary only', () => {
    expect(formatDuration(65)).not.toContain('\\');
  });
});

describe('buildPlaylistWindowLines', () => {
  const tracks = [track('a'), track('b'), track('c'), track('d'), track('e')];

  it('marks the current track and windows around it', () => {
    const lines = buildPlaylistWindowLines(tracks, 2, 1, 1);
    expect(lines).toEqual(['  b', '▶ c', '  d']);
  });

  it('clamps the window at the start and end of the list', () => {
    expect(buildPlaylistWindowLines(tracks, 0, 2, 1)).toEqual(['▶ a', '  b']);
    expect(buildPlaylistWindowLines(tracks, 4, 1, 2)).toEqual(['  d', '▶ e']);
  });

  it('returns an empty array for an empty playlist', () => {
    expect(buildPlaylistWindowLines([], -1, 2, 7)).toEqual([]);
  });
});

describe('buildInsertedTrackWindowLines', () => {
  const tracks = [track('a'), track('b'), track('c'), track('d'), track('e')];

  it('marks the donation track and windows before/after the base anchor', () => {
    const lines = buildInsertedTrackWindowLines(tracks, 2, '🎁 Заказ: Blur - Song 2', 1, 1);
    expect(lines).toEqual(['  c', '▶ 🎁 Заказ: Blur - Song 2', '  d']);
  });

  it('clamps the window at the start and end of the base playlist', () => {
    expect(buildInsertedTrackWindowLines(tracks, 0, '🎁 donation', 2, 1)).toEqual(['  a', '▶ 🎁 donation', '  b']);
    expect(buildInsertedTrackWindowLines(tracks, 4, '🎁 donation', 1, 2)).toEqual(['  e', '▶ 🎁 donation']);
  });

  it('falls back to just the donation track when the base anchor is unknown', () => {
    expect(buildInsertedTrackWindowLines(tracks, -1, '🎁 donation', 2, 7)).toEqual(['▶ 🎁 donation']);
  });

  it('falls back to just the donation track for an empty base playlist', () => {
    expect(buildInsertedTrackWindowLines([], 0, '🎁 donation', 2, 7)).toEqual(['▶ 🎁 donation']);
  });
});
