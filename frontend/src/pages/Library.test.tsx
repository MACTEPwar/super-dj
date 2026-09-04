import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import Library from './Library';
import { tracksApi, updateTrackOverlayOverride } from '../api/tracks';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../api/tracks');
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

describe('Library', () => {
  it('lists the user\'s tracks, showing duration and a cover thumbnail when present', async () => {
    vi.mocked(tracksApi.list).mockResolvedValue([
      { id: 't1', name: 'Track A', durationSeconds: 125, hasCover: true, overlayOverride: null },
      { id: 't2', name: 'Track B', durationSeconds: null, hasCover: false, overlayOverride: null },
    ]);
    vi.mocked(tracksApi.coverUrl).mockReturnValue('http://api/tracks/t1/cover');
    renderWithProviders(<Library />);

    expect(await screen.findByText('Track A')).toBeInTheDocument();
    expect(screen.getByText('125s')).toBeInTheDocument();
    expect(screen.getByText('Track B')).toBeInTheDocument();
    expect(screen.getByText('duration unknown')).toBeInTheDocument();
    expect(screen.getByAltText('')).toHaveAttribute('src', 'http://api/tracks/t1/cover');
  });

  it('opens the Add Track drawer', async () => {
    vi.mocked(tracksApi.list).mockResolvedValue([]);
    renderWithProviders(<Library />);
    await screen.findByText('No tracks yet.');

    await userEvent.click(screen.getByText('+ Add Track'));

    expect(screen.getByRole('heading', { name: 'Add Track' })).toBeInTheDocument();
  });

  it('deletes a track and refetches the list', async () => {
    vi.mocked(tracksApi.list)
      .mockResolvedValueOnce([{ id: 't1', name: 'Track A', durationSeconds: 10, hasCover: false, overlayOverride: null }])
      .mockResolvedValueOnce([]);
    vi.mocked(tracksApi.remove).mockResolvedValue({});
    renderWithProviders(<Library />);
    await screen.findByText('Track A');

    await userEvent.click(screen.getByText('Delete'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(tracksApi.remove).toHaveBeenCalledWith('t1');
    await waitFor(() => expect(screen.getByText('No tracks yet.')).toBeInTheDocument());
  });

  it('sets a solid color override and saves it with the right shape', async () => {
    vi.mocked(tracksApi.list).mockResolvedValue([
      { id: 't1', name: 'Track A', durationSeconds: 10, hasCover: false, overlayOverride: null },
    ]);
    vi.mocked(updateTrackOverlayOverride).mockResolvedValue(undefined);
    renderWithProviders(<Library />);
    await screen.findByText('Track A');

    await userEvent.click(screen.getByText('Overlay'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByLabelText('Override text color for this track'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(updateTrackOverlayOverride).toHaveBeenCalledWith('t1', { color: { mode: 'solid', color: '#ffffff' } }),
    );
  });

  it('clears an existing override by sending null when both toggles are turned off', async () => {
    vi.mocked(tracksApi.list).mockResolvedValue([
      {
        id: 't1',
        name: 'Track A',
        durationSeconds: 10,
        hasCover: false,
        overlayOverride: { color: { mode: 'solid', color: '#112233' } },
      },
    ]);
    vi.mocked(updateTrackOverlayOverride).mockResolvedValue(undefined);
    renderWithProviders(<Library />);
    await screen.findByText('Track A');

    await userEvent.click(screen.getByText('Overlay'));
    const dialog = await screen.findByRole('dialog');
    // The color toggle starts checked since the track already has a color override.
    await userEvent.click(within(dialog).getByLabelText('Override text color for this track'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateTrackOverlayOverride).toHaveBeenCalledWith('t1', null));
  });

  it('shows a toast error when saving the overlay override fails', async () => {
    vi.mocked(tracksApi.list).mockResolvedValue([
      { id: 't1', name: 'Track A', durationSeconds: 10, hasCover: false, overlayOverride: null },
    ]);
    vi.mocked(updateTrackOverlayOverride).mockRejectedValue(new Error('network down'));
    renderWithProviders(<Library />);
    await screen.findByText('Track A');

    await userEvent.click(screen.getByText('Overlay'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByLabelText('Override text color for this track'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to save overlay override'));
  });
});
