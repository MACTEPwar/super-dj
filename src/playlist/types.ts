import { TrackOverlayOverride } from '../tracks/trackRepository';

export interface Track {
  name: string;
  audioPath: string;
  coverPath: string | null;
  overlayOverride?: TrackOverlayOverride | null;
}
