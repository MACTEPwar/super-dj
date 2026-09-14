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
      { id: 'd2', name: 'Twitch', rtmpUrl: 'rtmp://live.twitch.tv/app', provider: 'custom' },
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

  // The whole point of the two-step design: ticking a box is ONLY local intent. Neither the
  // toggle call nor the settings drawer fires just from checking a box.
  it('ticking a destination is purely local — no API call and no settings drawer yet', async () => {
    mockStatus(IDLE);
    renderWithProviders(<Stream />);
    await screen.findByText('Friday Mix');
    await userEvent.click(screen.getByLabelText('My channel'));
    expect(screen.getByLabelText('My channel')).toBeChecked();
    expect(localStreamApi.setDestination).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
  });

  it('starts with only the playlist and template when nothing is ticked', async () => {
    mockStatus(IDLE);
    vi.mocked(localStreamApi.start).mockResolvedValue(LIVE);
    renderWithProviders(<Stream />);
    await screen.findByText('Friday Mix');
    await userEvent.selectOptions(screen.getByLabelText('Playlist'), 'p1');
    await userEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    await waitFor(() => expect(localStreamApi.start).toHaveBeenCalledWith({ playlistId: 'p1', templateId: undefined }));
    expect(localStreamApi.setDestination).not.toHaveBeenCalled();
  });

  // Pressing Start with a locally-ticked YouTube destination opens the settings drawer FIRST —
  // that destination's own toggle-on call, carrying whatever was typed, only fires once the
  // drawer is confirmed, and start() itself only runs after that.
  it('pressing Start opens the settings drawer for a newly-ticked YouTube destination, then commits both calls', async () => {
    mockStatus(IDLE);
    vi.mocked(localStreamApi.setDestination).mockResolvedValue(IDLE);
    vi.mocked(localStreamApi.start).mockResolvedValue(LIVE);
    renderWithProviders(<Stream />);
    await screen.findByText('Friday Mix');
    await userEvent.selectOptions(screen.getByLabelText('Playlist'), 'p1');
    await userEvent.click(screen.getByLabelText('My channel'));
    await userEvent.click(screen.getByRole('button', { name: 'Start stream' }));

    await userEvent.type(await screen.findByPlaceholderText('Title (optional — defaults to this destination\'s name)'), 'Late night');
    await userEvent.selectOptions(screen.getByLabelText('Privacy'), 'unlisted');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(localStreamApi.setDestination).toHaveBeenCalledWith('d1', 'on', {
      title: 'Late night', description: undefined, privacyStatus: 'unlisted', latencyPreference: 'normal',
    }));
    await waitFor(() => expect(localStreamApi.start).toHaveBeenCalledWith({ playlistId: 'p1', templateId: undefined }));
  });

  // A custom RTMP destination has no broadcast concept, so ticking it never needs the drawer even
  // though its own toggle-on call still has to fire as part of the commit.
  it('a newly-ticked custom RTMP destination skips the drawer entirely', async () => {
    mockStatus(IDLE);
    vi.mocked(localStreamApi.setDestination).mockResolvedValue(IDLE);
    vi.mocked(localStreamApi.start).mockResolvedValue(LIVE);
    renderWithProviders(<Stream />);
    await screen.findByText('Friday Mix');
    await userEvent.selectOptions(screen.getByLabelText('Playlist'), 'p1');
    await userEvent.click(screen.getByLabelText('Twitch'));
    await userEvent.click(screen.getByRole('button', { name: 'Start stream' }));

    await waitFor(() => expect(localStreamApi.setDestination).toHaveBeenCalledWith('d2', 'on', undefined));
    await waitFor(() => expect(localStreamApi.start).toHaveBeenCalledWith({ playlistId: 'p1', templateId: undefined }));
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
  });

  // Dismissing the drawer without confirming must not toggle anything, and must not start the
  // stream either — a change of mind, not a failure.
  it('dismissing the settings drawer commits nothing', async () => {
    mockStatus(IDLE);
    renderWithProviders(<Stream />);
    await screen.findByText('Friday Mix');
    await userEvent.selectOptions(screen.getByLabelText('Playlist'), 'p1');
    await userEvent.click(screen.getByLabelText('My channel'));
    await userEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    await screen.findByPlaceholderText('Title (optional — defaults to this destination\'s name)');

    await userEvent.click(screen.getByLabelText('Close'));

    expect(localStreamApi.setDestination).not.toHaveBeenCalled();
    expect(localStreamApi.start).not.toHaveBeenCalled();
  });

  // A destination the backend already holds `desired:'on'` for (survived an errored session)
  // mirrors that as the initial local intent — shown ticked, with its error message straight
  // through the checklist, no synthesis needed.
  it('shows a leftover backend forward as ticked, with its error, while nothing is running', async () => {
    mockStatus(ERRORED_WITH_LEFTOVER);
    renderWithProviders(<Stream />);
    await screen.findByText('Friday Mix');
    expect(screen.getByLabelText('My channel')).toBeChecked();
    expect(screen.getByText('YouTube rejected the broadcast')).toBeInTheDocument();
  });

  // Unticking a leftover forward is a turn-OFF, which never needs the drawer — it commits
  // straight through as part of Start.
  it('unticking a leftover forward before starting switches it off with no drawer', async () => {
    mockStatus(ERRORED_WITH_LEFTOVER);
    vi.mocked(localStreamApi.setDestination).mockResolvedValue({ ...ERRORED_WITH_LEFTOVER, destinations: [] });
    vi.mocked(localStreamApi.start).mockResolvedValue(LIVE);
    renderWithProviders(<Stream />);
    await screen.findByText('Friday Mix');
    await userEvent.click(screen.getByLabelText('My channel'));
    expect(screen.getByLabelText('My channel')).not.toBeChecked();
    expect(localStreamApi.setDestination).not.toHaveBeenCalled();

    await userEvent.selectOptions(screen.getByLabelText('Playlist'), 'p1');
    await userEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    await waitFor(() => expect(localStreamApi.setDestination).toHaveBeenCalledWith('d1', 'off'));
    await waitFor(() => expect(localStreamApi.start).toHaveBeenCalledWith({ playlistId: 'p1', templateId: undefined }));
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

  // Mid-stream: ticking a box is still only local intent. The commit step — and the settings
  // drawer, if needed — only appears once "Apply changes" shows up and is pressed.
  it('ticking a destination while running does not call the backend until Apply changes is pressed', async () => {
    mockStatus(LIVE);
    vi.mocked(localStreamApi.setDestination).mockResolvedValue(LIVE);
    renderWithProviders(<Stream />);
    await userEvent.click(await screen.findByLabelText('My channel'));
    expect(localStreamApi.setDestination).not.toHaveBeenCalled();

    await userEvent.click(await screen.findByRole('button', { name: 'Apply changes' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(localStreamApi.setDestination).toHaveBeenCalledWith('d1', 'on', expect.objectContaining({ privacyStatus: 'private' })));
    expect(localStreamApi.stop).not.toHaveBeenCalled();
  });

  it('shows no Apply changes button while local intent matches the backend', async () => {
    mockStatus(LIVE);
    renderWithProviders(<Stream />);
    await screen.findByTestId('hls-player');
    expect(screen.queryByRole('button', { name: 'Apply changes' })).not.toBeInTheDocument();
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

  // Applying a preset never touches the network by itself — it only sets local intent (which
  // destinations, and their known shared metadata), exactly like a manual tick does. Because that
  // metadata is already known, committing it does not need the drawer at all.
  it('applies a preset as local intent, and commits it without the drawer since its metadata is already known', async () => {
    mockStatus(IDLE);
    vi.mocked(streamPresetsApi.list).mockResolvedValue([{
      id: 'preset-1', name: 'Friday night', playlistId: 'p1', templateId: 'tpl-1',
      destinationIds: ['d1'], title: 'Late night', description: null,
      privacyStatus: 'unlisted', latencyPreference: 'low', createdAt: '2026-09-14T10:00:00.000Z',
    }]);
    vi.mocked(localStreamApi.setDestination).mockResolvedValue(IDLE);
    vi.mocked(localStreamApi.start).mockResolvedValue(LIVE);
    renderWithProviders(<Stream />);
    // The <select> renders immediately with only its "No preset" option, so findByLabelText
    // resolves BEFORE the presets query settles — wait for the preset's own option text instead,
    // the same way every other test here waits for 'Friday Mix'.
    await screen.findByText('Friday night');
    await userEvent.selectOptions(screen.getByLabelText('Start from a preset'), 'preset-1');
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(localStreamApi.setDestination).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText('My channel')).toBeChecked());
    await waitFor(() => expect(screen.getByLabelText('Playlist')).toHaveValue('p1'));

    await userEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
    await waitFor(() => expect(localStreamApi.setDestination).toHaveBeenCalledWith('d1', 'on', {
      title: 'Late night', description: undefined, privacyStatus: 'unlisted', latencyPreference: 'low',
    }));
    await waitFor(() => expect(localStreamApi.start).toHaveBeenCalledWith({ playlistId: 'p1', templateId: 'tpl-1' }));
  });

  it('saves the currently-ticked destinations as a preset, with no broadcast metadata of its own', async () => {
    mockStatus(ERRORED_WITH_LEFTOVER);
    vi.mocked(streamPresetsApi.create).mockResolvedValue({
      id: 'preset-2', name: 'Saturday', playlistId: 'p1', templateId: null, destinationIds: ['d1'],
      title: null, description: null, privacyStatus: null, latencyPreference: null, createdAt: '',
    });
    renderWithProviders(<Stream />);
    await screen.findByText('Friday Mix');
    await userEvent.selectOptions(screen.getByLabelText('Playlist'), 'p1');
    await userEvent.type(screen.getByPlaceholderText('Preset name'), 'Saturday');
    await userEvent.click(screen.getByRole('button', { name: 'Save preset' }));
    await waitFor(() => expect(streamPresetsApi.create).toHaveBeenCalledWith({
      name: 'Saturday', playlistId: 'p1', templateId: null, destinationIds: ['d1'],
    }));
  });
});
