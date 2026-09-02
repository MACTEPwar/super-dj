import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StartStreamDrawer } from './StartStreamDrawer';
import { playlistsApi } from '../api/playlists';
import { destinationsApi } from '../api/destinations';
import { streamSessionsApi } from '../api/streamSessions';
import { ApiError } from '../api/client';

vi.mock('../api/playlists');
vi.mock('../api/destinations');
vi.mock('../api/streamSessions');
const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigateMock,
}));

function render(open = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  const utils = rtlRender(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <StartStreamDrawer open={open} onOpenChange={onOpenChange} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, onOpenChange };
}

describe('StartStreamDrawer', () => {
  beforeEach(() => {
    navigateMock.mockClear();
    vi.mocked(playlistsApi.list).mockResolvedValue([{ id: 'p1', name: 'Friday Mix' }]);
    vi.mocked(destinationsApi.list).mockResolvedValue([
      { id: 'd1', name: 'My YouTube', rtmpUrl: null, provider: 'youtube' },
      { id: 'd2', name: 'My Twitch', rtmpUrl: 'rtmp://x', provider: 'custom' },
    ]);
  });

  it('disables Start until a playlist and at least one destination are selected', async () => {
    render();
    await screen.findByText('My YouTube', { exact: false });

    expect(screen.getByRole('button', { name: /Start stream/ })).toBeDisabled();
  });

  it('starts a session with the selected playlist and destinations, then navigates to it', async () => {
    vi.mocked(streamSessionsApi.create).mockResolvedValue({ id: 's1', playlistId: 'p1', destinations: [] });
    render();
    await screen.findByText('Friday Mix');

    await userEvent.selectOptions(screen.getByLabelText('Playlist'), 'p1');
    await userEvent.click(screen.getByLabelText('My Twitch (custom)'));
    await userEvent.click(screen.getByRole('button', { name: /Start stream/ }));

    await waitFor(() => expect(streamSessionsApi.create).toHaveBeenCalledWith({
      playlistId: 'p1', destinationIds: ['d2'], title: undefined, description: undefined, privacyStatus: undefined,
    }));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/streams/s1'));
  });

  it('shows YouTube broadcast fields only when a YouTube destination is selected', async () => {
    render();
    await screen.findByText('Friday Mix');

    expect(screen.queryByLabelText('Privacy')).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('My YouTube (youtube)'));

    expect(screen.getByLabelText('Privacy')).toBeInTheDocument();
  });

  it('shows the backend\'s error message when creation fails', async () => {
    vi.mocked(streamSessionsApi.create).mockRejectedValue(new ApiError(409, 'a destination is already streaming'));
    render();
    await screen.findByText('Friday Mix');

    await userEvent.selectOptions(screen.getByLabelText('Playlist'), 'p1');
    await userEvent.click(screen.getByLabelText('My Twitch (custom)'));
    await userEvent.click(screen.getByRole('button', { name: /Start stream/ }));

    expect(await screen.findByText('a destination is already streaming')).toBeInTheDocument();
  });
});
