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

// NOTE: ffmpeg's drawtext filter treats ':' as a parameter separator, so the timer text does
// need its colons escaped — but that escaping belongs at exactly ONE layer, the point where the
// string actually becomes ffmpeg filter syntax (overlayFilterComplex() in segmentArgs.ts). A
// second escape here produced '0\\:37', which real ffmpeg rejects outright ("No option name
// near ...", exit -22), silently killing every frame of a timer-bearing stream. Keep this
// module's output plain text.

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
