import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddTrackDrawer } from './AddTrackDrawer';
import { tracksApi } from '../api/tracks';
import { ApiError } from '../api/client';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../api/tracks');

function submitUploadForm() {
  fireEvent.submit(screen.getByText('Upload').closest('form')!);
}

describe('AddTrackDrawer — upload tab', () => {
  const onOpenChange = vi.fn();
  const onAdded = vi.fn();

  beforeEach(() => vi.clearAllMocks());

  it('uploads the chosen audio file and closes the drawer on success', async () => {
    vi.mocked(tracksApi.upload).mockResolvedValue({ id: 't1', name: 'song', durationSeconds: 5, hasCover: false, overlayOverride: null });
    renderWithProviders(<AddTrackDrawer open onOpenChange={onOpenChange} onAdded={onAdded} />);

    const file = new File(['fake-mp3-bytes'], 'song.mp3', { type: 'audio/mpeg' });
    const audioInput = screen.getByLabelText('Audio file') as HTMLInputElement;
    await userEvent.upload(audioInput, file);
    submitUploadForm();

    await waitFor(() => expect(tracksApi.upload).toHaveBeenCalledWith(file, null, undefined));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith({ id: 't1', name: 'song', durationSeconds: 5, hasCover: false, overlayOverride: null }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('shows the backend\'s error message when the upload fails', async () => {
    vi.mocked(tracksApi.upload).mockRejectedValue(new ApiError(400, 'unsupported audio format'));
    renderWithProviders(<AddTrackDrawer open onOpenChange={onOpenChange} onAdded={onAdded} />);

    const file = new File(['data'], 'song.mp3', { type: 'audio/mpeg' });
    await userEvent.upload(screen.getByLabelText('Audio file'), file);
    submitUploadForm();

    expect(await screen.findByText('unsupported audio format')).toBeInTheDocument();
  });
});

describe('AddTrackDrawer — service tab', () => {
  const onOpenChange = vi.fn();
  const onAdded = vi.fn();

  beforeEach(() => vi.clearAllMocks());

  function openServiceTab() {
    renderWithProviders(<AddTrackDrawer open onOpenChange={onOpenChange} onAdded={onAdded} />);
    fireEvent.click(screen.getByText('Add via service'));
  }

  it('searches, previews, and confirms a track', async () => {
    vi.mocked(tracksApi.searchPreview).mockResolvedValue({ previewId: 'p1' });
    vi.mocked(tracksApi.previewUrl).mockReturnValue('http://api.test/tracks/preview/p1');
    vi.mocked(tracksApi.confirmPreview).mockResolvedValue({ id: 't1', name: 'Blur - Song 2', durationSeconds: 90, hasCover: false, overlayOverride: null });
    openServiceTab();

    await userEvent.type(screen.getByLabelText('Search query'), 'Blur - Song 2');
    await userEvent.click(screen.getByText('Search'));

    await waitFor(() => expect(tracksApi.searchPreview).toHaveBeenCalledWith('Blur - Song 2'));
    const audio = await screen.findByTestId('preview-audio');
    expect(audio.getAttribute('src')).toBe('http://api.test/tracks/preview/p1');

    await userEvent.click(screen.getByText('Add'));

    await waitFor(() => expect(tracksApi.confirmPreview).toHaveBeenCalledWith('p1', 'Blur - Song 2', null));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' })));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('shows a search error and lets the streamer retry', async () => {
    vi.mocked(tracksApi.searchPreview).mockRejectedValue(new ApiError(502, 'media search service returned 502: not found'));
    openServiceTab();

    await userEvent.type(screen.getByLabelText('Search query'), 'nonexistent track');
    await userEvent.click(screen.getByText('Search'));

    expect(await screen.findByText('media search service returned 502: not found')).toBeInTheDocument();
  });

  it('"try another query" discards the current preview and returns to the search form', async () => {
    vi.mocked(tracksApi.searchPreview).mockResolvedValue({ previewId: 'p1' });
    vi.mocked(tracksApi.discardPreview).mockResolvedValue({});
    openServiceTab();

    await userEvent.type(screen.getByLabelText('Search query'), 'query one');
    await userEvent.click(screen.getByText('Search'));
    await screen.findByTestId('preview-audio');

    await userEvent.click(screen.getByText('Try another query'));

    await waitFor(() => expect(tracksApi.discardPreview).toHaveBeenCalledWith('p1'));
    expect(screen.getByLabelText('Search query')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-audio')).not.toBeInTheDocument();
  });
});
