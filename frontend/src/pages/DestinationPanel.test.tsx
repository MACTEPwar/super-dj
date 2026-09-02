import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import DestinationPanel from './DestinationPanel';
import { useStreamStatus } from '../hooks/useStreamStatus';
import { playlistsApi } from '../api/playlists';
import { streamApi } from '../api/stream';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../hooks/useStreamStatus');
vi.mock('../api/playlists');
vi.mock('../api/stream');

function renderPanel() {
  return renderWithProviders(
    <Routes><Route path="/destinations/:id" element={<DestinationPanel />} /></Routes>,
    { route: '/destinations/d1' },
  );
}

describe('DestinationPanel', () => {
  it('shows a playlist picker and a disabled Start button until one is selected', async () => {
    vi.mocked(useStreamStatus).mockReturnValue({ data: { state: 'idle', currentTrack: null, nextTrack: null } } as any);
    vi.mocked(playlistsApi.list).mockResolvedValue([{ id: 'p1', name: 'Mix' }]);
    renderPanel();

    expect(await screen.findByText('Mix')).toBeInTheDocument();
    expect(screen.getByText('Start stream')).toBeDisabled();
  });

  it('starts a stream with the selected playlist', async () => {
    vi.mocked(useStreamStatus).mockReturnValue({ data: { state: 'idle', currentTrack: null, nextTrack: null } } as any);
    vi.mocked(playlistsApi.list).mockResolvedValue([{ id: 'p1', name: 'Mix' }]);
    vi.mocked(streamApi.start).mockResolvedValue({ state: 'streaming', currentTrack: 'a', nextTrack: 'b' });
    renderPanel();
    await screen.findByText('Mix');

    await userEvent.selectOptions(screen.getByRole('combobox'), 'p1');
    await userEvent.click(screen.getByText('Start stream'));

    await waitFor(() => expect(streamApi.start).toHaveBeenCalledWith('d1', { playlistId: 'p1' }));
  });

  it('shows playback controls and current/next track when streaming', () => {
    vi.mocked(useStreamStatus).mockReturnValue({ data: { state: 'streaming', currentTrack: 'Track A', nextTrack: 'Track B' } } as any);
    vi.mocked(playlistsApi.list).mockResolvedValue([]);
    renderPanel();

    expect(screen.getByText('Now playing: Track A')).toBeInTheDocument();
    expect(screen.getByText('Next: Track B')).toBeInTheDocument();
    expect(screen.getByText('⏸ Pause')).toBeInTheDocument();
  });

  it('shows Resume instead of Pause when paused, and calls resume() on click', async () => {
    vi.mocked(useStreamStatus).mockReturnValue({ data: { state: 'paused', currentTrack: 'Track A', nextTrack: 'Track B' } } as any);
    vi.mocked(playlistsApi.list).mockResolvedValue([]);
    vi.mocked(streamApi.resume).mockResolvedValue({ state: 'streaming', currentTrack: 'Track A', nextTrack: 'Track B' });
    renderPanel();

    await userEvent.click(screen.getByText('▶ Resume'));

    expect(streamApi.resume).toHaveBeenCalledWith('d1');
  });

  it('shows the YouTube broadcast-status bar with a watch link once the provider phase is live', () => {
    vi.mocked(useStreamStatus).mockReturnValue({
      data: { state: 'streaming', currentTrack: 'a', nextTrack: 'b', provider: { type: 'youtube', phase: 'live', watchUrl: 'https://youtube.com/watch?v=x' } },
    } as any);
    vi.mocked(playlistsApi.list).mockResolvedValue([]);
    renderPanel();

    expect(screen.getByText('🔴 Live')).toBeInTheDocument();
    expect(screen.getByText('Watch on YouTube')).toHaveAttribute('href', 'https://youtube.com/watch?v=x');
  });

  it('omits the broadcast-status bar for a custom (non-OAuth) destination', () => {
    vi.mocked(useStreamStatus).mockReturnValue({ data: { state: 'streaming', currentTrack: 'a', nextTrack: 'b' } } as any);
    vi.mocked(playlistsApi.list).mockResolvedValue([]);
    renderPanel();

    expect(screen.queryByText('Watch on YouTube')).not.toBeInTheDocument();
  });
});
