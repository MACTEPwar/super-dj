import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Stream from './Stream';
import { useLocalStreamStatus } from '../hooks/useLocalStreamStatus';
import { localStreamApi, DestinationForwardStatus, LocalStreamStatus } from '../api/localStream';
import { streamPresetsApi } from '../api/streamPresets';
import { playlistsApi } from '../api/playlists';
import { templatesApi } from '../api/templates';
import { destinationsApi } from '../api/destinations';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../hooks/useLocalStreamStatus');
vi.mock('../api/localStream');
vi.mock('../api/streamPresets');
vi.mock('../api/playlists');
vi.mock('../api/templates');
vi.mock('../api/destinations');
vi.mock('../components/HlsPlayer', () => ({
  HlsPlayer: ({ src }: { src: string }) => <div data-testid="hls-player">{src}</div>,
}));

const IDLE: LocalStreamStatus = {
  local: {
    state: 'idle', currentTrack: null, nextTrack: null,
    previewReady: false, playlistId: null, templateId: null, startedAt: null,
  },
  destinations: [],
};

const LIVE: LocalStreamStatus = {
  local: {
    state: 'streaming', currentTrack: 'Track A', nextTrack: 'Track B',
    previewReady: true, playlistId: 'p1', templateId: null, startedAt: '2026-09-14T10:00:00.000Z',
  },
  destinations: [],
};

// A forward the backend still holds with nothing running: localStreamManager only drops the
// forwards map in stop(), so a session that died leaves its forwards behind, errors and all.
const LEFTOVER_ON_FORWARD: DestinationForwardStatus = {
  destinationId: 'd1',
  name: 'My channel',
  desired: 'on',
  state: 'error',
  error: { reason: 'provider', message: 'YouTube rejected the broadcast' },
};

const ERRORED_WITH_LEFTOVER: LocalStreamStatus = {
  local: { ...IDLE.local, state: 'error' },
  destinations: [LEFTOVER_ON_FORWARD],
};

function mockStatus(data: LocalStreamStatus) {
  vi.mocked(useLocalStreamStatus).mockReturnValue({ data } as never);
}

describe('Stream page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(playlistsApi.list).mockResolvedValue([{ id: 'p1', name: 'Friday Mix' }]);
    vi.mocked(templatesApi.list).mockResolvedValue([{ id: 'tpl-1', name: 'Neon' }] as never);
    vi.mocked(destinationsApi.list).mockResolvedValue([
      { id: 'd1', name: 'My channel', rtmpUrl: null, provider: 'youtube' },
    ]);
    vi.mocked(streamPresetsApi.list).mockResolvedValue([]);
    vi.mocked(localStreamApi.previewUrl).mockReturnValue('http://api/local-stream/preview/index.m3u8');
  });

  it('shows the start form and no player when nothing is running', async () => {
    mockStatus(IDLE);
    renderWithProviders(<Stream />);
    expect(await screen.findByLabelText('Playlist')).toBeInTheDocument();
    expect(screen.queryByTestId('hls-player')).not.toBeInTheDocument();
  });

  // While idle the checklist is local form state: ticking a box must not hit the network, and the
  // ticked ids ride along with the start call.
  it('starts with the destinations ticked before starting', async () => {
    mockStatus(IDLE);
    vi.mocked(localStreamApi.start).mockResolvedValue(LIVE);
    renderWithProviders(<Stream />);
    await screen.findByText('Friday Mix');
    await userEvent.selectOptions(screen.getByLabelText('Playlist'), 'p1');
    await userEvent.click(await screen.findByLabelText('My channel'));
    expect(localStreamApi.setDestination).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    await waitFor(() => expect(localStreamApi.start).toHaveBeenCalledWith(expect.objectContaining({
      playlistId: 'p1', destinationIds: ['d1'],
    })));
  });

  it('starts with no destinations at all', async () => {
    mockStatus(IDLE);
    vi.mocked(localStreamApi.start).mockResolvedValue(LIVE);
    renderWithProviders(<Stream />);
    await screen.findByText('Friday Mix');
    await userEvent.selectOptions(screen.getByLabelText('Playlist'), 'p1');
    await userEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    await waitFor(() => expect(localStreamApi.start).toHaveBeenCalledWith(expect.objectContaining({
      playlistId: 'p1', destinationIds: [],
    })));
  });

  // The forwards the backend already holds are real state, not decoration: they outlive an errored
  // session, they carry the error message, and start() only ever ADDS the ids it is passed — so a
  // leftover `desired:'on'` forward that the checklist showed as unticked would go live anyway.
  it('shows a leftover backend forward as ticked, with its error, while nothing is running', async () => {
    mockStatus(ERRORED_WITH_LEFTOVER);
    vi.mocked(localStreamApi.start).mockResolvedValue(LIVE);
    renderWithProviders(<Stream />);
    await screen.findByText('Friday Mix');
    await waitFor(() => expect(screen.getByLabelText('My channel')).toBeChecked());
    expect(screen.getByText('YouTube rejected the broadcast')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Playlist'), 'p1');
    await userEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    await waitFor(() => expect(localStreamApi.start).toHaveBeenCalledWith(expect.objectContaining({
      playlistId: 'p1', destinationIds: ['d1'],
    })));
  });

  // The other half of that invariant. Unticking stays local while idle (no round-trip for a box the
  // backend has no opinion on yet), so the backend still says `desired:'on'` — and start() would
  // never turn it off. Starting has to switch it off explicitly, or the UI lied.
  it('switches off a leftover forward the user unticked before starting', async () => {
    mockStatus(ERRORED_WITH_LEFTOVER);
    vi.mocked(localStreamApi.setDestination).mockResolvedValue(ERRORED_WITH_LEFTOVER);
    vi.mocked(localStreamApi.start).mockResolvedValue(LIVE);
    renderWithProviders(<Stream />);
    await screen.findByText('Friday Mix');
    await waitFor(() => expect(screen.getByLabelText('My channel')).toBeChecked());
    await userEvent.click(screen.getByLabelText('My channel'));
    expect(screen.getByLabelText('My channel')).not.toBeChecked();
    expect(localStreamApi.setDestination).not.toHaveBeenCalled();
    await userEvent.selectOptions(screen.getByLabelText('Playlist'), 'p1');
    await userEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    await waitFor(() => expect(localStreamApi.start).toHaveBeenCalledWith(expect.objectContaining({
      destinationIds: [],
    })));
    expect(localStreamApi.setDestination).toHaveBeenCalledWith('d1', 'off');
  });

  it('only offers the YouTube broadcast fields when a YouTube destination is ticked', async () => {
    mockStatus(IDLE);
    renderWithProviders(<Stream />);
    await screen.findByText('Friday Mix');
    expect(screen.queryByLabelText('Privacy')).not.toBeInTheDocument();
    await userEvent.click(await screen.findByLabelText('My channel'));
    expect(await screen.findByLabelText('Privacy')).toBeInTheDocument();
  });

  it('renders the transport controls and player while running', async () => {
    mockStatus(LIVE);
    renderWithProviders(<Stream />);
    expect(await screen.findByTestId('hls-player')).toHaveTextContent('http://api/local-stream/preview/index.m3u8');
    expect(screen.getByText('Now playing: Track A · Next: Track B')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '⏹ Stop' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Playlist')).not.toBeInTheDocument();
  });

  // Zero destinations is a fully valid running state — the page must say so, not look broken.
  it('says plainly that nothing is being forwarded', async () => {
    mockStatus(LIVE);
    renderWithProviders(<Stream />);
    expect(await screen.findByText(/Nothing is being forwarded/)).toBeInTheDocument();
  });

  it('toggles a destination through the API while running, without stopping the stream', async () => {
    mockStatus(LIVE);
    vi.mocked(localStreamApi.setDestination).mockResolvedValue(LIVE);
    renderWithProviders(<Stream />);
    await userEvent.click(await screen.findByLabelText('My channel'));
    await waitFor(() => expect(localStreamApi.setDestination).toHaveBeenCalledWith('d1', 'on'));
    expect(localStreamApi.stop).not.toHaveBeenCalled();
  });

  it.each([
    ['⏮ Previous', 'previous'], ['⏸ Pause', 'pause'], ['⏭ Next', 'next'], ['⏹ Stop', 'stop'],
  ] as const)('sends %s to the backend', async (label, method) => {
    mockStatus(LIVE);
    vi.mocked(localStreamApi[method]).mockResolvedValue(LIVE);
    renderWithProviders(<Stream />);
    await userEvent.click(await screen.findByRole('button', { name: label }));
    await waitFor(() => expect(localStreamApi[method]).toHaveBeenCalled());
  });

  it('offers Resume instead of Pause while paused', async () => {
    mockStatus({ ...LIVE, local: { ...LIVE.local, state: 'paused' } });
    vi.mocked(localStreamApi.resume).mockResolvedValue(LIVE);
    renderWithProviders(<Stream />);
    await userEvent.click(await screen.findByRole('button', { name: '▶ Resume' }));
    await waitFor(() => expect(localStreamApi.resume).toHaveBeenCalled());
  });

  it('shows a starting state rather than the start form while a start is in flight', async () => {
    mockStatus({ ...IDLE, local: { ...IDLE.local, state: 'starting' } });
    renderWithProviders(<Stream />);
    expect(await screen.findByText('starting')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start stream' })).not.toBeInTheDocument();
  });

  it('applies a preset into the form', async () => {
    mockStatus(IDLE);
    vi.mocked(streamPresetsApi.list).mockResolvedValue([{
      id: 'preset-1', name: 'Friday night', playlistId: 'p1', templateId: 'tpl-1',
      destinationIds: ['d1'], title: 'Late night', description: null,
      privacyStatus: 'unlisted', latencyPreference: 'low', createdAt: '2026-09-14T10:00:00.000Z',
    }]);
    vi.mocked(localStreamApi.start).mockResolvedValue(LIVE);
    renderWithProviders(<Stream />);
    // The <select> renders immediately with only its "No preset" option, so findByLabelText
    // resolves BEFORE the presets query settles — wait for the preset's own option text instead,
    // the same way every other test here waits for 'Friday Mix'.
    await screen.findByText('Friday night');
    await userEvent.selectOptions(screen.getByLabelText('Start from a preset'), 'preset-1');
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(screen.getByLabelText('My channel')).toBeChecked());
    await userEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    await waitFor(() => expect(localStreamApi.start).toHaveBeenCalledWith({
      playlistId: 'p1', templateId: 'tpl-1', destinationIds: ['d1'],
      title: 'Late night', description: undefined, privacyStatus: 'unlisted', latencyPreference: 'low',
    }));
  });

  it('saves the current form as a preset', async () => {
    mockStatus(IDLE);
    vi.mocked(streamPresetsApi.create).mockResolvedValue({
      id: 'preset-2', name: 'Saturday', playlistId: 'p1', templateId: null, destinationIds: [],
      title: null, description: null, privacyStatus: null, latencyPreference: null, createdAt: '',
    });
    renderWithProviders(<Stream />);
    await screen.findByText('Friday Mix');
    await userEvent.selectOptions(screen.getByLabelText('Playlist'), 'p1');
    await userEvent.type(screen.getByPlaceholderText('Preset name'), 'Saturday');
    await userEvent.click(screen.getByRole('button', { name: 'Save preset' }));
    await waitFor(() => expect(streamPresetsApi.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Saturday', playlistId: 'p1', destinationIds: [],
    })));
  });
});
