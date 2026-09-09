import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { StartStreamDrawer } from './StartStreamDrawer';
import { playlistsApi } from '../api/playlists';
import { destinationsApi } from '../api/destinations';
import { templatesApi } from '../api/templates';
import { streamSessionsApi } from '../api/streamSessions';
import { ApiError } from '../api/client';

vi.mock('../api/playlists');
vi.mock('../api/destinations');
vi.mock('../api/templates');
vi.mock('../api/streamSessions');
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
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
    vi.mocked(toast.error).mockClear();
    vi.mocked(playlistsApi.list).mockResolvedValue([{ id: 'p1', name: 'Friday Mix' }]);
    vi.mocked(destinationsApi.list).mockResolvedValue([
      { id: 'd1', name: 'My YouTube', rtmpUrl: null, provider: 'youtube' },
      { id: 'd2', name: 'My Twitch', rtmpUrl: 'rtmp://x', provider: 'custom' },
    ]);
    vi.mocked(templatesApi.list).mockResolvedValue([]);
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
      playlistId: 'p1', templateId: undefined, destinationIds: ['d2'], title: undefined, description: undefined, privacyStatus: undefined, latencyPreference: undefined,
    }));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/streams/s1'));
  });

  it('passes the selected templateId through when a template is chosen', async () => {
    vi.mocked(templatesApi.list).mockResolvedValue([{ id: 'tpl-1', name: 'My Theme' }]);
    vi.mocked(streamSessionsApi.create).mockResolvedValue({ id: 's1', playlistId: 'p1', destinations: [] });
    render();
    await screen.findByText('Friday Mix');
    await screen.findByText('My Theme');

    await userEvent.selectOptions(screen.getByLabelText('Playlist'), 'p1');
    await userEvent.selectOptions(screen.getByLabelText('Overlay template'), 'tpl-1');
    await userEvent.click(screen.getByLabelText('My Twitch (custom)'));
    await userEvent.click(screen.getByRole('button', { name: /Start stream/ }));

    await waitFor(() => expect(streamSessionsApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 'tpl-1' }),
    ));
  });

  it('shows YouTube broadcast fields (including latency) only when a YouTube destination is selected', async () => {
    render();
    await screen.findByText('Friday Mix');

    expect(screen.queryByLabelText('Privacy')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Stream latency')).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('My YouTube (youtube)'));

    expect(screen.getByLabelText('Privacy')).toBeInTheDocument();
    expect(screen.getByLabelText('Stream latency')).toBeInTheDocument();
  });

  it('defaults latency to normal and passes an explicit choice through for a YouTube destination', async () => {
    vi.mocked(streamSessionsApi.create).mockResolvedValue({ id: 's1', playlistId: 'p1', destinations: [] });
    render();
    await screen.findByText('Friday Mix');

    await userEvent.selectOptions(screen.getByLabelText('Playlist'), 'p1');
    await userEvent.click(screen.getByLabelText('My YouTube (youtube)'));
    expect((screen.getByLabelText('Stream latency') as HTMLSelectElement).value).toBe('normal');

    await userEvent.selectOptions(screen.getByLabelText('Stream latency'), 'ultraLow');
    await userEvent.click(screen.getByRole('button', { name: /Start stream/ }));

    await waitFor(() => expect(streamSessionsApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ latencyPreference: 'ultraLow' }),
    ));
  });

  it('toasts a per-destination error even though the create call itself resolves 200 (a YouTube token failure, say) instead of silently navigating away with no sign anything went wrong', async () => {
    // POST /stream-sessions always resolves — one destination's own start failure lands on that
    // destination's `error` field, not as a rejected request (see streamSessionManager.ts's
    // fan-out) — so createMutation's onSuccess, not onError, is what has to surface this.
    vi.mocked(streamSessionsApi.create).mockResolvedValue({
      id: 's1',
      playlistId: 'p1',
      destinations: [
        { destinationId: 'd1', status: { state: 'idle', currentTrack: null, nextTrack: null }, error: 'YouTube API error (refreshAccessToken): 400 invalid_grant' },
      ],
    });
    render();
    await screen.findByText('Friday Mix');

    await userEvent.selectOptions(screen.getByLabelText('Playlist'), 'p1');
    await userEvent.click(screen.getByLabelText('My YouTube (youtube)'));
    await userEvent.click(screen.getByRole('button', { name: /Start stream/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('YouTube API error (refreshAccessToken): 400 invalid_grant'),
    ));
    // Still navigates — other destinations in the same session may have started successfully.
    expect(navigateMock).toHaveBeenCalledWith('/streams/s1');
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
