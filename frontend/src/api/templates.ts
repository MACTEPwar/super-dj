import { api, API_BASE_URL, ApiError } from './client';

export type TemplateElement =
  | { type: 'cover'; x: number; y: number; width: number; height: number }
  | { type: 'title'; x: number; y: number; width: number; fontSize: number; color: string }
  | { type: 'playlist'; x: number; y: number; width: number; fontSize: number; color: string }
  | { type: 'timer'; x: number; y: number; fontSize: number; color: string };

export interface TemplateSummary {
  id: string;
  name: string;
}

export interface TemplateDetail {
  id: string;
  name: string;
  elements: TemplateElement[];
  createdAt: string;
  updatedAt: string;
}

export const templatesApi = {
  list: () => api.get<TemplateSummary[]>('/templates'),
  get: (id: string) => api.get<TemplateDetail>(`/templates/${id}`),
  create: (name: string) => api.post<TemplateDetail>('/templates', { name, elements: [] }),
  update: (id: string, data: { name?: string; elements?: TemplateElement[] }) => api.put<TemplateDetail>(`/templates/${id}`, data),
  remove: (id: string) => api.delete<Record<string, never>>(`/templates/${id}`),
  // The preview endpoint returns a raw image/png body, not JSON — the shared `api` helper
  // always calls res.json(), so this bypasses it and hands back an object URL the caller must
  // revoke (URL.revokeObjectURL) once it's no longer displayed.
  previewBlobUrl: async (id: string, body: { elements?: TemplateElement[]; title?: string; playlistLines?: string[] }): Promise<string> => {
    const res = await fetch(`${API_BASE_URL}/templates/${id}/preview`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new ApiError(res.status, typeof errBody.error === 'string' ? errBody.error : `preview failed with status ${res.status}`);
    }
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  },
};
