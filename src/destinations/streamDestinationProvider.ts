import { StreamDestination } from '@prisma/client';

export interface BroadcastMeta {
  title: string;
  description?: string;
  privacyStatus?: 'public' | 'unlisted' | 'private';
  // YouTube-only; ignored by CustomRtmpProvider. Defaults to 'normal' (YouTube's own default —
  // and its highest end-to-end latency, ~20-40s) when omitted.
  latencyPreference?: 'normal' | 'low' | 'ultraLow';
}

export type DestinationLifecyclePhase = 'creating' | 'waitingForYoutube' | 'live' | 'complete' | 'error';

export interface DestinationLifecycle {
  onPushStarted(): void;
  phase(): DestinationLifecyclePhase;
  watchUrl(): string | null;
  finalize(): Promise<void>;
  onPhaseChange?(cb: () => void): void;
}

export interface PreparedSession {
  rtmpUrl: string;
  streamKey: string;
  lifecycle?: DestinationLifecycle;
}

export interface StreamDestinationProvider {
  prepareSession(destination: StreamDestination, meta: BroadcastMeta): Promise<PreparedSession>;
}
