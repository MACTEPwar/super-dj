import { api, API_BASE_URL } from './client';
import type { ColorValue } from './templates';

export interface TrackOverlayOverride {
  color?: ColorValue;
  backgroundColor?: ColorValue;
}

export interface Track {
  id: string;
  name: string;
  durationSeconds: number | null;
  hasCover: boolean;
  overlayOverride: TrackOverlayOverride | null;
}

export const tracksApi = {
  list: () => api.get<Track[]>('/tracks'),
  upload: (audio: File, cover: File | null, name: string | undefined) => {
    const form = new FormData();
    form.append('audio', audio);
    if (cover) form.append('cover', cover);
    if (name) form.append('name', name);
    return api.postForm<Track>('/tracks', form);
  },
  remove: (id: string) => api.delete<Record<string, never>>(`/tracks/${id}`),
  coverUrl: (id: string) => `${API_BASE_URL}/tracks/${id}/cover`,
};

export async function updateTrackOverlayOverride(trackId: string, override: TrackOverlayOverride | null): Promise<void> {
  await api.patch<Record<string, never>>(`/tracks/${trackId}`, { overlayOverride: override });
}
