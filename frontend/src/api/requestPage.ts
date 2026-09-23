import { api, API_BASE_URL } from './client';

export interface PublicTrack { id: string; name: string; durationSeconds: number | null }

export type PublicRequestPageResult =
  | { kind: 'notFound' }
  | { kind: 'offline' }
  | { kind: 'live'; playlistName: string; tracks: PublicTrack[]; request: { keyword: string; minAmount: number } | null };

const PREFIX_CODE_POINTS = 20;

// "!<keyword>:<prefix> <uuid>". The prefix is for humans reading the donation feed; the backend
// matches on the trailing uuid only (the last uuid-shaped substring). Code points, not UTF-16
// units, so an emoji is never cut into a lone surrogate.
export function buildRequestCommand(keyword: string, trackName: string, trackId: string): string {
  const oneLine = trackName.replace(/\s+/g, ' ').trim();
  const prefix = Array.from(oneLine).slice(0, PREFIX_CODE_POINTS).join('').trim();
  return `!${keyword}:${prefix} ${trackId}`;
}

export function requestPageUrl(token: string): string {
  return `${window.location.origin}/r/${token}`;
}

// Plain fetch, NOT the shared `api` client: a donor is anonymous, so no credentials are sent.
export async function fetchPublicRequestPage(token: string): Promise<PublicRequestPageResult> {
  const res = await fetch(`${API_BASE_URL}/public/request-page/${encodeURIComponent(token)}`, { credentials: 'omit' });
  if (res.status === 404) return { kind: 'notFound' };
  if (!res.ok) throw new Error(`request page failed with status ${res.status}`);
  const body = await res.json();
  if (!body.live) return { kind: 'offline' };
  return { kind: 'live', playlistName: body.playlistName, tracks: body.tracks, request: body.request };
}

export const requestPageApi = {
  get: () => api.get<{ token: string | null }>('/request-page'),
  rotate: () => api.post<{ token: string }>('/request-page/token', {}),
  disable: () => api.delete<{ token: null }>('/request-page/token'),
};
