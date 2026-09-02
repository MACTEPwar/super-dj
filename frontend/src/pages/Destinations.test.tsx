import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Destinations from './Destinations';
import { destinationsApi } from '../api/destinations';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../api/destinations');

describe('Destinations', () => {
  it('lists the user\'s destinations with their provider', async () => {
    vi.mocked(destinationsApi.list).mockResolvedValue([{ id: 'd1', name: 'My Channel', rtmpUrl: null, provider: 'youtube' }]);
    renderWithProviders(<Destinations />);
    expect(await screen.findByText(/My Channel/)).toBeInTheDocument();
    expect(screen.getByText('(youtube)')).toBeInTheDocument();
  });

  it('deletes a destination and refetches the list', async () => {
    vi.mocked(destinationsApi.list)
      .mockResolvedValueOnce([{ id: 'd1', name: 'My Channel', rtmpUrl: null, provider: 'youtube' }])
      .mockResolvedValueOnce([]);
    vi.mocked(destinationsApi.remove).mockResolvedValue({});
    renderWithProviders(<Destinations />);
    await screen.findByText(/My Channel/);

    await userEvent.click(screen.getByText('Delete'));

    expect(destinationsApi.remove).toHaveBeenCalledWith('d1');
    await waitFor(() => expect(screen.getByText('No destinations yet.')).toBeInTheDocument());
  });

  it('opens the Add Destination modal', async () => {
    vi.mocked(destinationsApi.list).mockResolvedValue([]);
    renderWithProviders(<Destinations />);
    await screen.findByText('No destinations yet.');

    await userEvent.click(screen.getByText('+ Add Destination'));

    expect(screen.getByText('Add Destination')).toBeInTheDocument();
  });
});
