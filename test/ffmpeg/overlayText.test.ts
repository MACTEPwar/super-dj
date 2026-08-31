import { formatDuration, escapeDrawtext, buildPlaylistWindowLines } from '../../src/ffmpeg/overlayText';
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
});

describe('escapeDrawtext', () => {
  it('escapes backslash, colon, quote and percent for ffmpeg drawtext syntax', () => {
    expect(escapeDrawtext(`a:b'c%d\\e`)).toBe(`a\\:b\\'c\\%d\\\\e`);
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
