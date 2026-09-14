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

  // The checklist is ALWAYS backend-driven now — there is no separate local "what I've ticked"
  // state — so start() itself only ever takes playlistId/templateId, whether or not a destination
  // happens to already be on.
  it('starts with only the playlist and template — destinations are never named to start()', async () => {
    mockStatus(IDLE);
    vi.mocked(localStreamApi.start).mockResolvedValue(LIVE);
    renderWithProviders(<Stream />);
    await screen.findByText('Friday Mix');
    await userEvent.selectOptions(screen.getByLabelText('Playlist'), 'p1');
    await userEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    await waitFor(() => expect(localStreamApi.start).toHaveBeenCalledWith({ playlistId: 'p1', templateId: undefined }));
  });

  // A destination the backend already holds `desired:'on'` for (survived an errored session) shows
  // ticked and carries its error message straight through the checklist — no synthesis needed, the
  // forwards array IS the checklist.
  it('shows a leftover backend forward as ticked, with its error, while nothing is running', async () => {
    mockStatus(ERRORED_WITH_LEFTOVER);
    renderWithProviders(<Stream />);
    await screen.findByText('Friday Mix');
    expect(screen.getByLabelText('My channel')).toBeChecked();
    expect(screen.getByText('YouTube rejected the broadcast')).toBeInTheDocument();
  });

  // Unlike the old local-only checklist, turning a destination OFF hits the backend immediately —
  // there is no "intent" that could be lost or forgotten by the time Start is pressed, since Start
  // no longer has any destination list of its own to consult at all.
  it('turning a leftover forward off calls the backend immediately, not on start', async () => {
    mockStatus(ERRORED_WITH_LEFTOVER);
    vi.mocked(localStreamApi.setDestination).mockResolvedValue({ ...ERRORED_WITH_LEFTOVER, destinations: [] });
    renderWithProviders(<Stream />);
    await screen.findByText('Friday Mix');
    await userEvent.click(screen.getByLabelText('My channel'));
    expect(localStreamApi.setDestination).toHaveBeenCalledWith('d1', 'off', undefined);
  });

  // Ticking an OFF YouTube destination — whether idle or running — opens its own settings panel
  // (DestinationToggles' own concern, exercised in full there); confirming it is what actually
  // calls the backend, carrying that ONE destination's own title/privacy/latency.
  it('ticking a YouTube destination opens its settings panel and confirming toggles it on with that metadata', async () => {
    mockStatus(IDLE);
    vi.mocked(localStreamApi.setDestination).mockResolvedValue(IDLE);
    renderWithProviders(<Stream />);
    await screen.findByText('Friday Mix');
    await userEvent.click(screen.getByLabelText('My channel'));
    await userEvent.type(await screen.findByPlaceholderText('Title (optional — defaults to this destination\'s name)'), 'Late night');
    await userEvent.selectOptions(screen.getByLabelText('Privacy'), 'unlisted');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(localStreamApi.setDestination).toHaveBeenCalledWith('d1', 'on', {
      title: 'Late night', description: undefined, privacyStatus: 'unlisted', latencyPreference: 'normal',
    });
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
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(localStreamApi.setDestination).toHaveBeenCalledWith('d1', 'on', expect.objectContaining({
      privacyStatus: 'private',
    })));
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

  // Applying a preset ticks every one of its saved destinations on with that SAME preset's saved
  // metadata (a preset holds only one shared copy) — via the very same setDestination() call a
  // manual toggle makes, not through start().
  it('applies a preset by toggling its destinations on with the preset\'s saved metadata', async () => {
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

    await waitFor(() => expect(localStreamApi.setDestination).toHaveBeenCalledWith('d1', 'on', {
      title: 'Late night', description: undefined, privacyStatus: 'unlisted', latencyPreference: 'low',
    }));
    await waitFor(() => expect(screen.getByLabelText('Playlist')).toHaveValue('p1'));

    await userEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    await waitFor(() => expect(localStreamApi.start).toHaveBeenCalledWith({ playlistId: 'p1', templateId: 'tpl-1' }));
  });

  it('saves the currently-selected destinations as a preset, with no broadcast metadata of its own', async () => {
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
