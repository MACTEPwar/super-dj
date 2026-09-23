import { TrackOverlayOverride } from '../tracks/trackRepository';

export interface Track {
  name: string;
  audioPath: string;
  coverPath: string | null;
  overlayOverride?: TrackOverlayOverride | null;
  // Set only on an ephemeral (non-library) track — invoked exactly once, right after this
  // specific track finishes playing, so a temp file fetched for a single play can delete itself.
  // A real library track never sets this.
  _onFinished?: () => void;
  // Set only on a one-off, temp-file track (a donation song request — see songRequestAction.ts),
  // always together with _onFinished. Unlike _onFinished (self-disarming: cleared once it fires,
  // so unreadable after the fact) this stays set, which is what lets PlaylistQueue keep such a
  // track out of `history`: its file is deleted the moment it finishes, so previous() must never
  // be able to reach it again.
  ephemeral?: true;
}
