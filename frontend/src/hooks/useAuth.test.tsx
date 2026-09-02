import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './useAuth';
import { authApi } from '../api/auth';
import { ApiError } from '../api/client';

vi.mock('../api/auth');

function TestConsumer() {
  const { user, isLoading, login, logout } = useAuth();
  if (isLoading) return <div>loading</div>;
  return (
    <div>
      <div>{user ? `signed in as ${user.email}` : 'signed out'}</div>
      <button onClick={() => login('a@example.com', 'pw')}>login</button>
      <button onClick={() => logout()}>logout</button>
    </div>
  );
}

function renderWithProviders() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider><TestConsumer /></AuthProvider>
    </QueryClientProvider>,
  );
}

describe('useAuth', () => {
  beforeEach(() => vi.resetAllMocks());

  it('treats a 401 from /auth/me as signed-out, not an error', async () => {
    vi.mocked(authApi.me).mockRejectedValue(new ApiError(401, 'unauthorized'));
    renderWithProviders();
    await waitFor(() => expect(screen.getByText('signed out')).toBeInTheDocument());
  });

  it('login() updates the current user without a page reload', async () => {
    vi.mocked(authApi.me).mockRejectedValue(new ApiError(401, 'unauthorized'));
    vi.mocked(authApi.login).mockResolvedValue({ id: 'u1', email: 'a@example.com' });
    renderWithProviders();
    await waitFor(() => expect(screen.getByText('signed out')).toBeInTheDocument());

    await userEvent.click(screen.getByText('login'));

    await waitFor(() => expect(screen.getByText('signed in as a@example.com')).toBeInTheDocument());
  });

  it('logout() clears the current user', async () => {
    vi.mocked(authApi.me).mockResolvedValue({ id: 'u1', email: 'a@example.com' });
    vi.mocked(authApi.logout).mockResolvedValue({});
    renderWithProviders();
    await waitFor(() => expect(screen.getByText('signed in as a@example.com')).toBeInTheDocument());

    await userEvent.click(screen.getByText('logout'));

    await waitFor(() => expect(screen.getByText('signed out')).toBeInTheDocument());
  });
});
