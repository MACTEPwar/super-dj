// Keys are per queue ENTRY, stable across renders — what lets PlaylistWindowAnimator diff the
// baked snapshot against the new one into an insert animation.
export interface WindowRow {
  key: string;
  text: string;
  isCurrent: boolean;
}

export const PLAYLIST_WINDOW_BEFORE = 2;
export const PLAYLIST_WINDOW_AFTER = 7;
export const PLAYLIST_WINDOW_VISIBLE_ROWS = PLAYLIST_WINDOW_BEFORE + 1 + PLAYLIST_WINDOW_AFTER;

export function windowRowLines(rows: WindowRow[]): string[] {
  return rows.map((r) => r.text);
}
