import { api } from './client';

export interface PlaylistSummary {
  id: string;
  name: string;
}

export interface PlaylistTrack {
  id: string;
  name: string;
  audioPath: string;
  coverPath: string | null;
}

export interface PlaylistDetail {
  id: string;
  name: string;
  tracks: PlaylistTrack[];
}

export const playlistsApi = {
  list: () => api.get<PlaylistSummary[]>('/playlists'),
  create: (name: string) => api.post<PlaylistSummary>('/playlists', { name }),
  get: (id: string) => api.get<PlaylistDetail>(`/playlists/${id}`),
  replaceTracks: (id: string, trackIds: string[]) => api.put<Record<string, never>>(`/playlists/${id}/tracks`, { trackIds }),
  remove: (id: string) => api.delete<Record<string, never>>(`/playlists/${id}`),
};
