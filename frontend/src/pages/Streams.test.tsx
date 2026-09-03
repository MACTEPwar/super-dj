import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Streams from './Streams';
import { streamSessionsApi } from '../api/streamSessions';
import { playlistsApi } from '../api/playlists';
import { destinationsApi } from '../api/destinations';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../api/streamSessions');
vi.mock('../api/playlists');
vi.mock('../api/destinations');

describe('Streams', () => {
  it('lists sessions with a badge per destination showing its state', async () => {
    vi.mocked(streamSessionsApi.list).mockResolvedValue([
      {
        id: 's1', playlistId: 'p1',
        destinations: [
          { destinationId: 'd1', status: { state: 'streaming', currentTrack: 'a', nextTrack: null } },
          { destinationId: 'd2', status: { state: 'idle', currentTrack: null, nextTrack: null } },
        ],
      },
    ]);
    vi.mocked(playlistsApi.list).mockResolvedValue([{ id: 'p1', name: 'Friday Mix' }]);
    vi.mocked(destinationsApi.list).mockResolvedValue([
      { id: 'd1', name: 'My YouTube', rtmpUrl: null, provider: 'youtube' },
      { id: 'd2', name: 'My Twitch', rtmpUrl: 'rtmp://x', provider: 'custom' },
    ]);
    renderWithProviders(<Streams />);

    expect(await screen.findByText('Friday Mix')).toBeInTheDocument();
    expect(screen.getByText('My YouTube: streaming')).toBeInTheDocument();
    expect(screen.getByText('My Twitch: idle')).toBeInTheDocument();
    expect(screen.getByText('Friday Mix').closest('a')).toHaveAttribute('href', '/streams/s1');
  });

  it('opens the Start Stream drawer', async () => {
    vi.mocked(streamSessionsApi.list).mockResolvedValue([]);
    vi.mocked(playlistsApi.list).mockResolvedValue([]);
    vi.mocked(destinationsApi.list).mockResolvedValue([]);
    renderWithProviders(<Streams />);
    await screen.findByText('No stream sessions yet.');

    await userEvent.click(screen.getByText('+ Start Stream'));

    expect(screen.getByRole('heading', { name: 'Start Stream' })).toBeInTheDocument();
  });

  it('stops and removes a session', async () => {
    vi.mocked(streamSessionsApi.list)
      .mockResolvedValueOnce([{ id: 's1', playlistId: 'p1', destinations: [] }])
      .mockResolvedValueOnce([]);
    vi.mocked(streamSessionsApi.remove).mockResolvedValue({});
    vi.mocked(playlistsApi.list).mockResolvedValue([{ id: 'p1', name: 'Friday Mix' }]);
    vi.mocked(destinationsApi.list).mockResolvedValue([]);
    renderWithProviders(<Streams />);
    await screen.findByText('Friday Mix');

    await userEvent.click(screen.getByText('Stop & remove'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop & remove' }));

    expect(streamSessionsApi.remove).toHaveBeenCalledWith('s1');
    await waitFor(() => expect(screen.getByText('No stream sessions yet.')).toBeInTheDocument());
  });
});
