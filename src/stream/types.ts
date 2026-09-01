export type SessionState = 'idle' | 'streaming' | 'paused' | 'error';

export interface StreamStatus {
  state: SessionState;
  currentTrack: string | null;
  nextTrack: string | null;
}

export interface ProviderStatus {
  type: string;
  phase: string;
  watchUrl: string | null;
}

export interface DestinationStreamStatus extends StreamStatus {
  provider?: ProviderStatus;
}
