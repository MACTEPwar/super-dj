import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import StreamSessionPanel from './StreamSessionPanel';
import { useStreamSessionStatus } from '../hooks/useStreamSessionStatus';
import { destinationsApi } from '../api/destinations';
import { playlistsApi } from '../api/playlists';
import { streamSessionsApi } from '../api/streamSessions';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../hooks/useStreamSessionStatus');
vi.mock('../api/destinations');
vi.mock('../api/playlists');
vi.mock('../api/streamSessions');

function renderPanel() {
  return renderWithProviders(
    <Routes><Route path="/streams/:id" element={<StreamSessionPanel />} /></Routes>,
    { route: '/streams/s1' },
  );
}

describe('StreamSessionPanel', () => {
  it('renders one status card per destination, with the playlist name as the heading', async () => {
    vi.mocked(useStreamSessionStatus).mockReturnValue({
      data: {
        id: 's1', playlistId: 'p1',
        destinations: [
          { destinationId: 'd1', status: { state: 'streaming', currentTrack: 'Track A', nextTrack: 'Track B' } },
          { destinationId: 'd2', status: { state: 'idle', currentTrack: null, nextTrack: null }, error: 'youtube api hiccup' },
        ],
      },
    } as any);
    vi.mocked(playlistsApi.list).mockResolvedValue([{ id: 'p1', name: 'Friday Mix' }]);
    vi.mocked(destinationsApi.list).mockResolvedValue([
      { id: 'd1', name: 'My YouTube', rtmpUrl: null, provider: 'youtube' },
      { id: 'd2', name: 'My Twitch (custom)', rtmpUrl: 'rtmp://x', provider: 'custom' },
    ]);
    renderPanel();

    expect(await screen.findByText('Stream: Friday Mix')).toBeInTheDocument();
    expect(screen.getByText('My YouTube')).toBeInTheDocument();
    expect(screen.getByText('My Twitch (custom)')).toBeInTheDocument();
    expect(screen.getByText('Now playing: Track A · Next: Track B')).toBeInTheDocument();
    expect(screen.getByText('youtube api hiccup')).toBeInTheDocument();
  });

  it('fans out Pause all to the session endpoint', async () => {
    vi.mocked(useStreamSessionStatus).mockReturnValue({
      data: { id: 's1', playlistId: 'p1', destinations: [{ destinationId: 'd1', status: { state: 'streaming', currentTrack: 'a', nextTrack: null } }] },
    } as any);
    vi.mocked(playlistsApi.list).mockResolvedValue([]);
    vi.mocked(destinationsApi.list).mockResolvedValue([]);
    vi.mocked(streamSessionsApi.pause).mockResolvedValue({ id: 's1', playlistId: 'p1', destinations: [] });
    renderPanel();

    await userEvent.click(screen.getByText('⏸ Pause all'));

    await waitFor(() => expect(streamSessionsApi.pause).toHaveBeenCalledWith('s1'));
  });

  it('shows the YouTube watch link for a live destination in the session', async () => {
    vi.mocked(useStreamSessionStatus).mockReturnValue({
      data: {
        id: 's1', playlistId: 'p1',
        destinations: [{ destinationId: 'd1', status: { state: 'streaming', currentTrack: 'a', nextTrack: null, provider: { type: 'youtube', phase: 'live', watchUrl: 'https://youtube.com/watch?v=x' } } }],
      },
    } as any);
    vi.mocked(playlistsApi.list).mockResolvedValue([]);
    vi.mocked(destinationsApi.list).mockResolvedValue([{ id: 'd1', name: 'My YouTube', rtmpUrl: null, provider: 'youtube' }]);
    renderPanel();

    expect(await screen.findByText('Watch on YouTube')).toHaveAttribute('href', 'https://youtube.com/watch?v=x');
  });
});
