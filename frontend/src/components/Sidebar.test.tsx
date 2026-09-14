import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { useAuth } from '../hooks/useAuth';

vi.mock('../hooks/useAuth');

describe('Sidebar', () => {
  it('renders links for Library, Playlists, Destinations, Stream and the signed-in user\'s email', () => {
    vi.mocked(useAuth).mockReturnValue({ user: { id: 'u1', email: 'a@example.com' }, logout: vi.fn() } as any);
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    expect(screen.getByText('Library')).toBeInTheDocument();
    expect(screen.getByText('Playlists')).toBeInTheDocument();
    expect(screen.getByText('Destinations')).toBeInTheDocument();
    expect(screen.getByText('Stream')).toBeInTheDocument();
    expect(screen.getByText('a@example.com')).toBeInTheDocument();
  });

  // The old "Streams" list and "Local stream" pages collapsed into the single /stream entry above —
  // neither label should survive anywhere in the nav.
  it('no longer offers the old Streams or Local stream entries', () => {
    vi.mocked(useAuth).mockReturnValue({ user: { id: 'u1', email: 'a@example.com' }, logout: vi.fn() } as any);
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    expect(screen.queryByText('Streams')).not.toBeInTheDocument();
    expect(screen.queryByText('Local stream')).not.toBeInTheDocument();
  });

  it('calls logout() when "Sign out" is clicked', async () => {
    const logout = vi.fn();
    vi.mocked(useAuth).mockReturnValue({ user: { id: 'u1', email: 'a@example.com' }, logout } as any);
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    await userEvent.click(screen.getByText('Sign out'));
    expect(logout).toHaveBeenCalled();
  });
});
