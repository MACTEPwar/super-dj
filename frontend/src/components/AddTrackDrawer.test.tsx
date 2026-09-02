import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddTrackDrawer } from './AddTrackDrawer';
import { tracksApi } from '../api/tracks';
import { ApiError } from '../api/client';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../api/tracks');

// jsdom doesn't sync a file input's `.value` when files are assigned via userEvent.upload,
// so its `required` constraint validation always reports valueMissing and a real submit-button
// click never fires the form's submit event — a jsdom-only gap (this works fine in real
// browsers). Submit via fireEvent.submit(form) to bypass that, same as the app's own
// mutationFn-level "choose an audio file first" check would if a file were truly missing.
function submitForm() {
  fireEvent.submit(screen.getByText('Upload').closest('form')!);
}

describe('AddTrackDrawer', () => {
  const onOpenChange = vi.fn();
  const onUploaded = vi.fn();

  beforeEach(() => vi.clearAllMocks());

  it('uploads the chosen audio file and closes the drawer on success', async () => {
    vi.mocked(tracksApi.upload).mockResolvedValue({ id: 't1', name: 'song', durationSeconds: 5, hasCover: false });
    renderWithProviders(<AddTrackDrawer open onOpenChange={onOpenChange} onUploaded={onUploaded} />);

    const file = new File(['fake-mp3-bytes'], 'song.mp3', { type: 'audio/mpeg' });
    const audioInput = screen.getByLabelText('Audio file') as HTMLInputElement;
    await userEvent.upload(audioInput, file);
    submitForm();

    await waitFor(() => expect(tracksApi.upload).toHaveBeenCalledWith(file, null, undefined));
    await waitFor(() => expect(onUploaded).toHaveBeenCalled());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('shows the backend\'s error message when the upload fails', async () => {
    vi.mocked(tracksApi.upload).mockRejectedValue(new ApiError(400, 'unsupported audio format'));
    renderWithProviders(<AddTrackDrawer open onOpenChange={onOpenChange} onUploaded={onUploaded} />);

    const file = new File(['data'], 'song.mp3', { type: 'audio/mpeg' });
    await userEvent.upload(screen.getByLabelText('Audio file'), file);
    submitForm();

    expect(await screen.findByText('unsupported audio format')).toBeInTheDocument();
  });
});
