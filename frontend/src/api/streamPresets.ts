import { api } from './client';

// A saved choice, not a running thing: what to pre-populate the start form with. Mirrors
// src/stream/streamPresetRoutes.ts's toPublicPreset.
export interface StreamPreset {
  id: string;
  name: string;
  playlistId: string;
  templateId: string | null;
  destinationIds: string[];
  title: string | null;
  description: string | null;
  privacyStatus: 'public' | 'unlisted' | 'private' | null;
  latencyPreference: 'normal' | 'low' | 'ultraLow' | null;
  createdAt: string;
}

export interface StreamPresetInput {
  name: string;
  playlistId: string;
  templateId?: string | null;
  destinationIds?: string[];
  title?: string | null;
  description?: string | null;
  privacyStatus?: 'public' | 'unlisted' | 'private' | null;
  latencyPreference?: 'normal' | 'low' | 'ultraLow' | null;
}

export const streamPresetsApi = {
  list: () => api.get<StreamPreset[]>('/stream-presets'),
  create: (input: StreamPresetInput) => api.post<StreamPreset>('/stream-presets', input),
  update: (id: string, input: StreamPresetInput) => api.put<StreamPreset>(`/stream-presets/${id}`, input),
  remove: (id: string) => api.delete<Record<string, never>>(`/stream-presets/${id}`),
};
