import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the playlist\'s current tracks and the tracks still available to add', async () => {
    vi.mocked(playlistsApi.get).mockResolvedValue({
      id: 'p1', name: 'Mix', tracks: [{ id: 't1', name: 'Track A', audioPath: '', coverPath: null }],
    });
    vi.mocked(tracksApi.list).mockResolvedValue([
      { id: 't1', name: 'Track A', durationSeconds: 10, hasCover: false, overlayOverride: null },
      { id: 't2', name: 'Track B', durationSeconds: 20, hasCover: false, overlayOverride: null },
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
    vi.mocked(tracksApi.list).mockResolvedValue([{ id: 't1', name: 'Track A', durationSeconds: 10, hasCover: false, overlayOverride: null }]);
    vi.mocked(playlistsApi.replaceTracks).mockResolvedValue({});
    renderEditor();
    await screen.findByText('Track A');

    await userEvent.click(screen.getByText('Add'));
    await userEvent.click(screen.getByText('Save changes'));

    await waitFor(() => expect(playlistsApi.replaceTracks).toHaveBeenCalledWith('p1', ['t1']));
  });

  it('opens the add-track drawer, and a confirmed track is staged into the playlist without a separate save', async () => {
    vi.mocked(playlistsApi.get).mockResolvedValue({ id: 'pl1', name: 'Mix', tracks: [] });
    vi.mocked(tracksApi.list).mockResolvedValue([]);
    vi.mocked(tracksApi.searchPreview).mockResolvedValue({ previewId: 'p1' });
    vi.mocked(tracksApi.previewUrl).mockReturnValue('http://api.test/tracks/preview/p1');
    vi.mocked(tracksApi.confirmPreview).mockResolvedValue({ id: 't1', name: 'New Song', durationSeconds: 60, hasCover: false, overlayOverride: null });
    renderEditor(); // this file's own helper — Routes+Route at /playlists/:id, route: '/playlists/p1'
    await screen.findByText('Mix');

    await userEvent.click(screen.getByText('+ Add new track'));
    await userEvent.click(screen.getByText('Add via service'));
    await userEvent.type(screen.getByLabelText('Search query'), 'New Song');
    await userEvent.click(screen.getByText('Search'));
    await screen.findByTestId('preview-audio');
    await userEvent.click(screen.getByText('Add'));

    await waitFor(() => expect(screen.getByText('New Song')).toBeInTheDocument());
    // Not yet persisted — replaceTracks only fires when "Save" is clicked.
    expect(playlistsApi.replaceTracks).not.toHaveBeenCalled();
  });
});
