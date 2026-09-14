import { api, API_BASE_URL } from './client';

// Mirrors src/stream/localStreamManager.ts — kept in sync by hand, the way every other
// backend/frontend type pair in this project is. 'starting' exists only on this status payload: it
// means a start is in flight, so the UI never shows "idle" mid-start.
export type LocalSessionState = 'idle' | 'starting' | 'streaming' | 'paused' | 'error' | 'reconnecting';

export type ForwardDesiredState = 'on' | 'off';
// 'pending' = the user wants this destination but nothing is publishing locally yet, so NOTHING has
// happened on the platform's side. 'connecting' = the relay is running but the destination has not
// confirmed it; for YouTube that legitimately takes 10-40s and the UI must say so rather than look
// stuck, or people double-toggle and burn API quota.
export type ForwardActualState = 'off' | 'pending' | 'preparing' | 'connecting' | 'live' | 'stopping' | 'error';
export type ForwardErrorReason = 'auth' | 'provider' | 'relay' | 'source';

export interface ForwardProviderStatus {
  type: string;
  phase: string;
  // The channel's stable /live link — it survives every toggle, unlike a per-broadcast watch URL.
  watchUrl: string | null;
}

export interface ForwardError {
  reason: ForwardErrorReason;
  message: string;
}

export interface DestinationForwardStatus {
  destinationId: string;
  name: string;
  desired: ForwardDesiredState;
  state: ForwardActualState;
  provider?: ForwardProviderStatus;
  error?: ForwardError;
}

export interface LocalStreamState {
  state: LocalSessionState;
  currentTrack: string | null;
  nextTrack: string | null;
  // True while the encoder is publishing, INCLUDING while paused — pausing swaps the audio to
  // silence and never interrupts the local publish, so the preview stays watchable.
  previewReady: boolean;
  playlistId: string | null;
  templateId: string | null;
  startedAt: string | null;
}

// One local stream plus 0..N independently toggleable destinations. An empty `destinations` array
// is a normal running state, not an error — the stream runs and previews with nothing forwarded.
export interface LocalStreamStatus {
  local: LocalStreamState;
  destinations: DestinationForwardStatus[];
}

export interface StartLocalStreamOptions {
  playlistId: string;
  templateId?: string;
  // Destinations to switch on as soon as the stream is publishing. Optional and possibly empty.
  destinationIds?: string[];
  // Broadcast metadata for destinations that create a live broadcast (YouTube). Ignored by custom
  // RTMP destinations.
  title?: string;
  description?: string;
  privacyStatus?: 'public' | 'unlisted' | 'private';
  latencyPreference?: 'normal' | 'low' | 'ultraLow';
}

export const localStreamApi = {
  status: () => api.get<LocalStreamStatus>('/local-stream/status'),
  start: (opts: StartLocalStreamOptions) => api.post<LocalStreamStatus>('/local-stream/start', opts),
  stop: () => api.post<LocalStreamStatus>('/local-stream/stop'),
  pause: () => api.post<LocalStreamStatus>('/local-stream/pause'),
  resume: () => api.post<LocalStreamStatus>('/local-stream/resume'),
  next: () => api.post<LocalStreamStatus>('/local-stream/next'),
  previous: () => api.post<LocalStreamStatus>('/local-stream/previous'),
  play: (name: string) => api.post<LocalStreamStatus>('/local-stream/play', { name }),
  // The checkbox. Idempotent, and valid even with nothing running — the forward then waits at
  // 'pending' for the next start.
  setDestination: (destinationId: string, desired: ForwardDesiredState) =>
    api.put<LocalStreamStatus>(`/local-stream/destinations/${destinationId}`, { desired }),
  eventsUrl: () => `${API_BASE_URL}/local-stream/events`,
  // Absolute, because hls.js loads it itself rather than going through the `api` wrapper. The
  // backend resolves which stream this is from the session cookie — there is no id in this URL by
  // design.
  previewUrl: () => `${API_BASE_URL}/local-stream/preview/index.m3u8`,
};
