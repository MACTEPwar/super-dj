import { api, API_BASE_URL, ApiError } from './client';

// Mirrors src/templates/templateTypes.ts on the backend — kept in sync by hand.
// ColorValue represents both solid colors and gradients.
export type ColorValue =
  | { mode: 'solid'; color: string }
  | { mode: 'gradient'; stops: [string, string] | [string, string, string]; angleDeg: number };

export interface TextStyle {
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  stroke?: { color: string; width: number };
  shadow?: { color: string; blur: number; offsetX: number; offsetY: number };
  // Single-line truncation — makes sense for title/text, not playlist (multi-line wrapping is
  // intentional); the editor only exposes the checkbox for title/text (see TemplateEditor.tsx).
  overflow?: 'ellipsis';
}

export type TemplateElement =
  | { type: 'cover'; x: number; y: number; width: number; height: number }
  | { type: 'title'; x: number; y: number; width: number; fontSize: number; color: ColorValue; style: TextStyle }
  | { type: 'playlist'; x: number; y: number; width: number; fontSize: number; color: ColorValue; style: TextStyle }
  | { type: 'timer'; x: number; y: number; fontSize: number; color: string; style: TextStyle }
  | { type: 'text'; x: number; y: number; width: number; fontSize: number; text: string; color: ColorValue; style: TextStyle }
  | { type: 'image'; x: number; y: number; width: number; height: number; assetId: string }
  // Mirrors src/templates/templateTypes.ts's EqualizerElement — colors[] feeds resvg's SVG
  // gradient (a real CSS-color renderer), not an ffmpeg filter directly, so ordinary CSS hex
  // (including 3/4-digit shorthand) is fine here, unlike 'timer' above.
  | { type: 'equalizer'; x: number; y: number; width: number; height: number; colors: string[]; glowLayers: number; glowRadius: number; coreWidth: number };

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

export async function uploadTemplateImage(templateId: string, file: File): Promise<{ assetId: string }> {
  const form = new FormData();
  form.append('image', file);
  return api.postForm<{ assetId: string }>(`/templates/${templateId}/images`, form);
}

export function templateImageUrl(templateId: string, assetId: string): string {
  return `${API_BASE_URL}/templates/${templateId}/images/${assetId}`;
}

export async function getFontFamilies(): Promise<string[]> {
  const response = await api.get<{ families: string[] }>('/templates/fonts');
  return response.families;
}
