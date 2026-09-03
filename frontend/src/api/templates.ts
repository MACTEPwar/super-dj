import { api } from './client';

export interface TemplateSummary {
  id: string;
  name: string;
}

export const templatesApi = {
  list: () => api.get<TemplateSummary[]>('/templates'),
};
