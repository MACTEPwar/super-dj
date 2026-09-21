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
}
