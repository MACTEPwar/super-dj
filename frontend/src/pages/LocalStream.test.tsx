import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LocalStream from './LocalStream';
import { useLocalStreamStatus } from '../hooks/useLocalStreamStatus';
import { localStreamApi } from '../api/localStream';
import { playlistsApi } from '../api/playlists';
import { templatesApi } from '../api/templates';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../hooks/useLocalStreamStatus');
vi.mock('../api/localStream');
vi.mock('../api/playlists');
vi.mock('../api/templates');
vi.mock('../components/HlsPlayer', () => ({
  HlsPlayer: ({ src }: { src: string }) => <div data-testid="hls-player">{src}</div>,
}));

const IDLE = {
  state: 'idle', currentTrack: null, nextTrack: null,
  previewReady: false, playlistId: null, templateId: null, startedAt: null,
} as const;

const LIVE = {
  state: 'streaming', currentTrack: 'Track A', nextTrack: 'Track B',
  previewReady: true, playlistId: 'p1', templateId: null, startedAt: '2026-09-14T10:00:00.000Z',
} as const;

function mockStatus(data: unknown) {
  vi.mocked(useLocalStreamStatus).mockReturnValue({ data } as never);
}

describe('LocalStream page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(playlistsApi.list).mockResolvedValue([{ id: 'p1', name: 'Friday Mix' }]);
    vi.mocked(templatesApi.list).mockResolvedValue([{ id: 'tpl-1', name: 'Neon' }] as never);
    vi.mocked(localStreamApi.previewUrl).mockReturnValue('http://api/local-stream/preview/index.m3u8');
  });

  it('shows the start form and no player when nothing is running', async () => {
    mockStatus(IDLE);
    renderWithProviders(<LocalStream />);
    expect(await screen.findByLabelText('Playlist')).toBeInTheDocument();
    expect(screen.queryByTestId('hls-player')).not.toBeInTheDocument();
  });

  it('starts a stream with the chosen playlist and template', async () => {
    mockStatus(IDLE);
    vi.mocked(localStreamApi.start).mockResolvedValue(LIVE as never);
    renderWithProviders(<LocalStream />);
    // The <select> itself renders immediately (findByLabelText would resolve before the
    // playlists query settles); wait for an actual option's text, matching the same pattern
    // StartStreamDrawer.test.tsx uses for this same race.
    await screen.findByText('Friday Mix');
    await userEvent.selectOptions(screen.getByLabelText('Playlist'), 'p1');
    await userEvent.selectOptions(screen.getByLabelText('Overlay template'), 'tpl-1');
    await userEvent.click(screen.getByRole('button', { name: 'Start local stream' }));
    await waitFor(() => expect(localStreamApi.start).toHaveBeenCalledWith({ playlistId: 'p1', templateId: 'tpl-1' }));
  });

  it('sends no templateId when none is chosen', async () => {
    mockStatus(IDLE);
    vi.mocked(localStreamApi.start).mockResolvedValue(LIVE as never);
    renderWithProviders(<LocalStream />);
    await screen.findByText('Friday Mix');
    await userEvent.selectOptions(screen.getByLabelText('Playlist'), 'p1');
    await userEvent.click(screen.getByRole('button', { name: 'Start local stream' }));
    await waitFor(() => expect(localStreamApi.start).toHaveBeenCalledWith({ playlistId: 'p1', templateId: undefined }));
  });

  it('renders the player and the transport controls once the preview is ready', async () => {
    mockStatus(LIVE);
    renderWithProviders(<LocalStream />);
    expect(await screen.findByTestId('hls-player')).toHaveTextContent('http://api/local-stream/preview/index.m3u8');
    expect(screen.getByText('Now playing: Track A · Next: Track B')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '⏹ Stop' })).toBeInTheDocument();
  });

  it('shows a placeholder instead of the player while the stream is starting but not yet publishing', async () => {
    mockStatus({ ...LIVE, previewReady: false });
    renderWithProviders(<LocalStream />);
    expect(await screen.findByText('Preview is starting…')).toBeInTheDocument();
    expect(screen.queryByTestId('hls-player')).not.toBeInTheDocument();
  });

  it.each([
    ['⏮ Previous', 'previous'], ['⏸ Pause', 'pause'], ['⏭ Next', 'next'], ['⏹ Stop', 'stop'],
  ] as const)('sends %s to the backend', async (label, method) => {
    mockStatus(LIVE);
    vi.mocked(localStreamApi[method]).mockResolvedValue(LIVE as never);
    renderWithProviders(<LocalStream />);
    await userEvent.click(await screen.findByRole('button', { name: label }));
    await waitFor(() => expect(localStreamApi[method]).toHaveBeenCalled());
  });

  it('offers Resume instead of Pause while paused', async () => {
    mockStatus({ ...LIVE, state: 'paused' });
    vi.mocked(localStreamApi.resume).mockResolvedValue(LIVE as never);
    renderWithProviders(<LocalStream />);
    await userEvent.click(await screen.findByRole('button', { name: '▶ Resume' }));
    await waitFor(() => expect(localStreamApi.resume).toHaveBeenCalled());
  });

  // Zero destinations is a fully valid running state in this model, not a degenerate one — the UI
  // has to say so out loud or it reads as "something is missing".
  it('states plainly that nothing is being forwarded anywhere', async () => {
    mockStatus(LIVE);
    renderWithProviders(<LocalStream />);
    expect(await screen.findByText('This stream is local only — nothing is being sent to any platform.')).toBeInTheDocument();
  });
});
