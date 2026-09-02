import { api } from './client';

export interface Destination {
  id: string;
  name: string;
  rtmpUrl: string | null;
  provider: string;
}

export const destinationsApi = {
  list: () => api.get<Destination[]>('/destinations'),
  createManual: (name: string, rtmpUrl: string, streamKey: string) =>
    api.post<Destination>('/destinations', { name, rtmpUrl, streamKey }),
  remove: (id: string) => api.delete<Record<string, never>>(`/destinations/${id}`),
  oauthStart: (provider: string) => api.get<{ authUrl: string }>(`/destinations/${provider}/oauth/start`),
};
