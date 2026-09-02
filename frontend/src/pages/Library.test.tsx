import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Library from './Library';
import { tracksApi } from '../api/tracks';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../api/tracks');

describe('Library', () => {
  it('lists the user\'s tracks, showing duration and a cover thumbnail when present', async () => {
    vi.mocked(tracksApi.list).mockResolvedValue([
      { id: 't1', name: 'Track A', durationSeconds: 125, hasCover: true },
      { id: 't2', name: 'Track B', durationSeconds: null, hasCover: false },
    ]);
    vi.mocked(tracksApi.coverUrl).mockReturnValue('http://api/tracks/t1/cover');
    renderWithProviders(<Library />);

    expect(await screen.findByText('Track A')).toBeInTheDocument();
    expect(screen.getByText('125s')).toBeInTheDocument();
    expect(screen.getByText('Track B')).toBeInTheDocument();
    expect(screen.getByText('duration unknown')).toBeInTheDocument();
    expect(screen.getByAltText('')).toHaveAttribute('src', 'http://api/tracks/t1/cover');
  });

  it('deletes a track and refetches the list', async () => {
    vi.mocked(tracksApi.list)
      .mockResolvedValueOnce([{ id: 't1', name: 'Track A', durationSeconds: 10, hasCover: false }])
      .mockResolvedValueOnce([]);
    vi.mocked(tracksApi.remove).mockResolvedValue({});
    renderWithProviders(<Library />);
    await screen.findByText('Track A');

    await userEvent.click(screen.getByText('Delete'));

    expect(tracksApi.remove).toHaveBeenCalledWith('t1');
    await waitFor(() => expect(screen.getByText('No tracks yet.')).toBeInTheDocument());
  });
});
