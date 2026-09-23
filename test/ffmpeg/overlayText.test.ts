import { formatDuration } from '../../src/ffmpeg/overlayText';

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
