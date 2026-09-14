// 'reconnecting' — a persistent encoder exited unexpectedly and a respawn attempt is scheduled
// (or in flight) against the SAME already-prepared session (same RTMP target, same YouTube
// broadcast/liveStream if any); distinct from 'error', which still means "dead, needs a human to
// call /stream/start again". See StreamController's reconnect mechanism and reconnectPolicy.ts's
// retry-or-give-up policy.
export type SessionState = 'idle' | 'streaming' | 'paused' | 'error' | 'reconnecting';

export interface StreamStatus {
  state: SessionState;
  currentTrack: string | null;
  nextTrack: string | null;
}
