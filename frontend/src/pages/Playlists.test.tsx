import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Playlists from './Playlists';
import { playlistsApi } from '../api/playlists';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../api/playlists');

describe('Playlists', () => {
  it('lists the user\'s playlists, each linking to its editor', async () => {
    vi.mocked(playlistsApi.list).mockResolvedValue([{ id: 'p1', name: 'Mix' }]);
    renderWithProviders(<Playlists />);
    expect(await screen.findByText('Mix')).toBeInTheDocument();
    expect(screen.getByText('Mix').closest('a')).toHaveAttribute('href', '/playlists/p1');
  });

  it('opens the Create Playlist drawer', async () => {
    vi.mocked(playlistsApi.list).mockResolvedValue([]);
    renderWithProviders(<Playlists />);
    await screen.findByText('No playlists yet.');

    await userEvent.click(screen.getByText('+ Create Playlist'));

    expect(screen.getByRole('heading', { name: 'Create Playlist' })).toBeInTheDocument();
  });

  it('creates a playlist via the drawer and refetches the list', async () => {
    vi.mocked(playlistsApi.list).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'p1', name: 'New Mix' }]);
    vi.mocked(playlistsApi.create).mockResolvedValue({ id: 'p1', name: 'New Mix' });
    renderWithProviders(<Playlists />);
    await screen.findByText('No playlists yet.');

    await userEvent.click(screen.getByText('+ Create Playlist'));
    await userEvent.type(screen.getByPlaceholderText('Playlist name'), 'New Mix');
    await userEvent.click(screen.getByText('Create'));

    expect(playlistsApi.create).toHaveBeenCalledWith('New Mix');
    await waitFor(() => expect(screen.getByText('New Mix')).toBeInTheDocument());
  });

  it('deletes a playlist and refetches the list', async () => {
    vi.mocked(playlistsApi.list).mockResolvedValueOnce([{ id: 'p1', name: 'Mix' }]).mockResolvedValueOnce([]);
    vi.mocked(playlistsApi.remove).mockResolvedValue({});
    renderWithProviders(<Playlists />);
    await screen.findByText('Mix');

    await userEvent.click(screen.getByText('Delete'));

    expect(playlistsApi.remove).toHaveBeenCalledWith('p1');
    await waitFor(() => expect(screen.getByText('No playlists yet.')).toBeInTheDocument());
  });
});
