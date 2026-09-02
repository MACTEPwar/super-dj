import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreatePlaylistDrawer } from './CreatePlaylistDrawer';
import { playlistsApi } from '../api/playlists';
import { ApiError } from '../api/client';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../api/playlists');

describe('CreatePlaylistDrawer', () => {
  const onOpenChange = vi.fn();
  const onCreated = vi.fn();

  beforeEach(() => vi.clearAllMocks());

  it('creates a playlist and closes the drawer on success', async () => {
    vi.mocked(playlistsApi.create).mockResolvedValue({ id: 'p1', name: 'New Mix' });
    renderWithProviders(<CreatePlaylistDrawer open onOpenChange={onOpenChange} onCreated={onCreated} />);

    await userEvent.type(screen.getByPlaceholderText('Playlist name'), 'New Mix');
    await userEvent.click(screen.getByText('Create'));

    await waitFor(() => expect(playlistsApi.create).toHaveBeenCalledWith('New Mix'));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('shows the backend\'s error message when creation fails', async () => {
    vi.mocked(playlistsApi.create).mockRejectedValue(new ApiError(409, 'a playlist with that name already exists'));
    renderWithProviders(<CreatePlaylistDrawer open onOpenChange={onOpenChange} onCreated={onCreated} />);

    await userEvent.type(screen.getByPlaceholderText('Playlist name'), 'New Mix');
    await userEvent.click(screen.getByText('Create'));

    expect(await screen.findByText('a playlist with that name already exists')).toBeInTheDocument();
  });
});
