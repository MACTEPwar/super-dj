import { api, API_BASE_URL } from './client';
import { SessionState } from './streamSessions';

// Mirrors LocalStreamStatus in src/stream/localStreamManager.ts — kept in sync by hand, the way
// every other backend/frontend type pair in this project is.
export interface LocalStreamStatus {
  state: SessionState;
  currentTrack: string | null;
  nextTrack: string | null;
  // True while the encoder is publishing, INCLUDING while paused — pausing swaps the audio to
  // silence and never interrupts the local publish, so the preview stays watchable.
  previewReady: boolean;
  playlistId: string | null;
  templateId: string | null;
  startedAt: string | null;
}

export interface StartLocalStreamOptions {
  playlistId: string;
  templateId?: string;
}

// No destination, title, privacy or latency options: a local stream is not connected to any
// platform in this phase. Toggling destinations arrives with Phase B.
export const localStreamApi = {
  status: () => api.get<LocalStreamStatus>('/local-stream/status'),
  start: (opts: StartLocalStreamOptions) => api.post<LocalStreamStatus>('/local-stream/start', opts),
  stop: () => api.post<LocalStreamStatus>('/local-stream/stop'),
  pause: () => api.post<LocalStreamStatus>('/local-stream/pause'),
  resume: () => api.post<LocalStreamStatus>('/local-stream/resume'),
  next: () => api.post<LocalStreamStatus>('/local-stream/next'),
  previous: () => api.post<LocalStreamStatus>('/local-stream/previous'),
  play: (name: string) => api.post<LocalStreamStatus>('/local-stream/play', { name }),
  eventsUrl: () => `${API_BASE_URL}/local-stream/events`,
  // Absolute, because hls.js loads it itself rather than going through the `api` wrapper. The
  // backend resolves which stream this is from the session cookie — there is no id in this URL by
  // design.
  previewUrl: () => `${API_BASE_URL}/local-stream/preview/index.m3u8`,
};
