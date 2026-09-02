import { api } from './client';

export interface AuthUser {
  id: string;
  email: string;
}

export const authApi = {
  register: (email: string, password: string) => api.post<AuthUser>('/auth/register', { email, password }),
  login: (email: string, password: string) => api.post<AuthUser>('/auth/login', { email, password }),
  logout: () => api.post<Record<string, never>>('/auth/logout'),
  me: () => api.get<AuthUser>('/auth/me'),
};
