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
//
// The playlist window's lines used to be built here too; they now come from
// PlaylistQueue.windowSnapshot() (src/playlist/queue.ts), which also lists queued tracks.
