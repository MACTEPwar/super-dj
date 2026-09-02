import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from './ProtectedRoute';
import { useAuth } from '../hooks/useAuth';

vi.mock('../hooks/useAuth');

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<div>Login page</div>} />
        <Route element={<ProtectedRoute />}>
          <Route path="/library" element={<div>Library page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProtectedRoute', () => {
  it('redirects to /login when signed out', () => {
    vi.mocked(useAuth).mockReturnValue({ user: null, isLoading: false } as any);
    renderAt('/library');
    expect(screen.getByText('Login page')).toBeInTheDocument();
  });

  it('renders the nested route when signed in', () => {
    vi.mocked(useAuth).mockReturnValue({ user: { id: 'u1', email: 'a@example.com' }, isLoading: false } as any);
    renderAt('/library');
    expect(screen.getByText('Library page')).toBeInTheDocument();
  });

  it('shows a loading state instead of redirecting while the auth check is in flight', () => {
    vi.mocked(useAuth).mockReturnValue({ user: null, isLoading: true } as any);
    renderAt('/library');
    expect(screen.queryByText('Login page')).not.toBeInTheDocument();
    expect(screen.queryByText('Library page')).not.toBeInTheDocument();
  });
});
