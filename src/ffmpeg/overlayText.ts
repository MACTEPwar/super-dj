import { Track } from '../playlist/types';

export function formatDuration(totalSeconds: number): string {
  const rounded = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  const paddedSeconds = String(seconds).padStart(2, '0');

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`;
  }
  return `${minutes}:${paddedSeconds}`;
}

// formatDuration()'s output is digits and colons only (never arbitrary text), but ffmpeg's
// drawtext filter treats ':' as a parameter separator inside its own filter string — this is
// the one place that still needs escaping now that title/playlist no longer flow through
// drawtext at all (see the timer element in segmentFeeder.ts).
export function formatDurationForDrawtext(totalSeconds: number): string {
  return formatDuration(totalSeconds).replace(/:/g, '\\:');
}

export function buildPlaylistWindowLines(
  tracks: Track[],
  currentIndex: number,
  before: number,
  after: number,
): string[] {
  if (tracks.length === 0 || currentIndex < 0) return [];

  const start = Math.max(0, currentIndex - before);
  const end = Math.min(tracks.length - 1, currentIndex + after);
  const lines: string[] = [];

  for (let i = start; i <= end; i += 1) {
    lines.push(i === currentIndex ? `▶ ${tracks[i].name}` : `  ${tracks[i].name}`);
  }

  return lines;
}
