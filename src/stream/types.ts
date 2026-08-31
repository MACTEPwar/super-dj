export type SessionState = 'idle' | 'streaming' | 'paused' | 'error';

export interface StreamStatus {
  state: SessionState;
  currentTrack: string | null;
  nextTrack: string | null;
}
