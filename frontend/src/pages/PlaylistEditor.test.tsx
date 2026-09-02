import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import PlaylistEditor from './PlaylistEditor';
import { playlistsApi } from '../api/playlists';
import { tracksApi } from '../api/tracks';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../api/playlists');
vi.mock('../api/tracks');

function renderEditor() {
  return renderWithProviders(
    <Routes><Route path="/playlists/:id" element={<PlaylistEditor />} /></Routes>,
    { route: '/playlists/p1' },
  );
}

describe('PlaylistEditor', () => {
  it('renders the playlist\'s current tracks and the tracks still available to add', async () => {
    vi.mocked(playlistsApi.get).mockResolvedValue({
      id: 'p1', name: 'Mix', tracks: [{ id: 't1', name: 'Track A', audioPath: '', coverPath: null }],
    });
    vi.mocked(tracksApi.list).mockResolvedValue([
      { id: 't1', name: 'Track A', durationSeconds: 10, hasCover: false },
      { id: 't2', name: 'Track B', durationSeconds: 20, hasCover: false },
    ]);
    renderEditor();

    expect(await screen.findByText('Mix')).toBeInTheDocument();
    expect(screen.getByText('Track A')).toBeInTheDocument();
    // Track B is NOT yet in the playlist, so it shows up under "Add tracks", not the ordered list.
    expect(screen.getByText('Track B')).toBeInTheDocument();
  });

  it('"Remove" takes a track out of the local ordering; "Save changes" persists the resulting id order', async () => {
    vi.mocked(playlistsApi.get).mockResolvedValue({
      id: 'p1', name: 'Mix',
      tracks: [
        { id: 't1', name: 'Track A', audioPath: '', coverPath: null },
        { id: 't2', name: 'Track B', audioPath: '', coverPath: null },
      ],
    });
    vi.mocked(tracksApi.list).mockResolvedValue([]);
    vi.mocked(playlistsApi.replaceTracks).mockResolvedValue({});
    renderEditor();
    await screen.findByText('Track A');

    await userEvent.click(screen.getAllByText('Remove')[0]);
    await userEvent.click(screen.getByText('Save changes'));

    await waitFor(() => expect(playlistsApi.replaceTracks).toHaveBeenCalledWith('p1', ['t2']));
  });

  it('"Add" appends an available track to the local ordering', async () => {
    vi.mocked(playlistsApi.get).mockResolvedValue({ id: 'p1', name: 'Mix', tracks: [] });
    vi.mocked(tracksApi.list).mockResolvedValue([{ id: 't1', name: 'Track A', durationSeconds: 10, hasCover: false }]);
    vi.mocked(playlistsApi.replaceTracks).mockResolvedValue({});
    renderEditor();
    await screen.findByText('Track A');

    await userEvent.click(screen.getByText('Add'));
    await userEvent.click(screen.getByText('Save changes'));

    await waitFor(() => expect(playlistsApi.replaceTracks).toHaveBeenCalledWith('p1', ['t1']));
  });
});
