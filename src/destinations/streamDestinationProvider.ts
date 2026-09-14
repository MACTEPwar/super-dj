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
  // True once this lifecycle has seen an auth-class failure (e.g. a revoked YouTube OAuth
  // grant) from the underlying provider API — used to short-circuit a health-check poll that
  // would otherwise retry silently for the full timeout, and to veto a reconnect attempt against
  // a destination whose credentials are known to be dead (see reconnectPolicy.ts). Absent for a
  // provider with no such concept (e.g. CustomRtmpProvider, which has no lifecycle at all).
  isAuthError?(): boolean;
}

export interface PreparedSession {
  rtmpUrl: string;
  streamKey: string;
  lifecycle?: DestinationLifecycle;
}

export interface StreamDestinationProvider {
  prepareSession(destination: StreamDestination, meta: BroadcastMeta): Promise<PreparedSession>;
  // Classify a prepareSession() rejection as an auth-class failure — a revoked/expired grant that
  // retrying will never fix — rather than a transient provider error. Absent (CustomRtmpProvider
  // has no account to revoke) means "never auth-class". This lives on the provider because it is
  // the only layer that knows its own API's error shapes; DestinationForward stays free of any
  // YouTube-specific knowledge.
  isAuthError?(err: unknown): boolean;
}
