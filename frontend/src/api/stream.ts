import { api, API_BASE_URL } from './client';

export type SessionState = 'idle' | 'streaming' | 'paused' | 'error';

export interface ProviderStatus {
  type: string;
  phase: string;
  watchUrl: string | null;
}

export interface StreamStatus {
  state: SessionState;
  currentTrack: string | null;
  nextTrack: string | null;
  provider?: ProviderStatus;
}

export interface StartStreamOptions {
  playlistId: string;
  title?: string;
  description?: string;
  privacyStatus?: 'public' | 'unlisted' | 'private';
}

export const streamApi = {
  start: (destinationId: string, opts: StartStreamOptions) =>
    api.post<StreamStatus>(`/destinations/${destinationId}/stream/start`, opts),
  stop: (destinationId: string) => api.post<StreamStatus>(`/destinations/${destinationId}/stream/stop`),
  pause: (destinationId: string) => api.post<StreamStatus>(`/destinations/${destinationId}/stream/pause`),
  resume: (destinationId: string) => api.post<StreamStatus>(`/destinations/${destinationId}/stream/resume`),
  next: (destinationId: string) => api.post<StreamStatus>(`/destinations/${destinationId}/stream/next`),
  previous: (destinationId: string) => api.post<StreamStatus>(`/destinations/${destinationId}/stream/previous`),
  playByName: (destinationId: string, name: string) => api.post<StreamStatus>(`/destinations/${destinationId}/stream/play`, { name }),
  status: (destinationId: string) => api.get<StreamStatus>(`/destinations/${destinationId}/stream/status`),
  eventsUrl: (destinationId: string) => `${API_BASE_URL}/destinations/${destinationId}/stream/events`,
};
