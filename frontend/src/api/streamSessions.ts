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

export interface StreamSessionDestinationStatus {
  destinationId: string;
  status: StreamStatus;
  error?: string;
}

export interface StreamSessionStatus {
  id: string;
  playlistId: string;
  destinations: StreamSessionDestinationStatus[];
}

export interface StartStreamSessionOptions {
  playlistId: string;
  destinationIds: string[];
  title?: string;
  description?: string;
  privacyStatus?: 'public' | 'unlisted' | 'private';
}

export const streamSessionsApi = {
  create: (opts: StartStreamSessionOptions) => api.post<StreamSessionStatus>('/stream-sessions', opts),
  list: () => api.get<StreamSessionStatus[]>('/stream-sessions'),
  status: (id: string) => api.get<StreamSessionStatus>(`/stream-sessions/${id}/status`),
  pause: (id: string) => api.post<StreamSessionStatus>(`/stream-sessions/${id}/pause`),
  resume: (id: string) => api.post<StreamSessionStatus>(`/stream-sessions/${id}/resume`),
  next: (id: string) => api.post<StreamSessionStatus>(`/stream-sessions/${id}/next`),
  previous: (id: string) => api.post<StreamSessionStatus>(`/stream-sessions/${id}/previous`),
  stop: (id: string) => api.post<StreamSessionStatus>(`/stream-sessions/${id}/stop`),
  remove: (id: string) => api.delete<Record<string, never>>(`/stream-sessions/${id}`),
  eventsUrl: (id: string) => `${API_BASE_URL}/stream-sessions/${id}/events`,
};
