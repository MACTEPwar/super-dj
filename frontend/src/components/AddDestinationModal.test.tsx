import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddDestinationModal } from './AddDestinationModal';
import { destinationsApi } from '../api/destinations';
import { ApiError } from '../api/client';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../api/destinations');

describe('AddDestinationModal', () => {
  const onOpenChange = vi.fn();
  const onCreated = vi.fn();

  beforeEach(() => vi.clearAllMocks());

  it('submits the manual form and closes the modal on success', async () => {
    vi.mocked(destinationsApi.createManual).mockResolvedValue({ id: 'd1', name: 'My RTMP', rtmpUrl: 'rtmp://x', provider: 'custom' });
    renderWithProviders(<AddDestinationModal open onOpenChange={onOpenChange} onCreated={onCreated} />);

    await userEvent.click(screen.getByText('Manual'));
    await userEvent.type(screen.getByPlaceholderText('Name'), 'My RTMP');
    await userEvent.type(screen.getByPlaceholderText('RTMP URL'), 'rtmp://example.com/live');
    await userEvent.type(screen.getByPlaceholderText('Stream key'), 'key123');
    await userEvent.click(screen.getByText('Add'));

    await waitFor(() => expect(destinationsApi.createManual).toHaveBeenCalledWith('My RTMP', 'rtmp://example.com/live', 'key123'));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('shows the backend\'s error message when the manual form fails', async () => {
    vi.mocked(destinationsApi.createManual).mockRejectedValue(new ApiError(400, 'body.rtmpUrl is required'));
    renderWithProviders(<AddDestinationModal open onOpenChange={onOpenChange} onCreated={onCreated} />);

    await userEvent.click(screen.getByText('Manual'));
    await userEvent.type(screen.getByPlaceholderText('Name'), 'X');
    await userEvent.type(screen.getByPlaceholderText('RTMP URL'), 'x');
    await userEvent.type(screen.getByPlaceholderText('Stream key'), 'x');
    await userEvent.click(screen.getByText('Add'));

    expect(await screen.findByText('body.rtmpUrl is required')).toBeInTheDocument();
  });

  it('starts the YouTube OAuth flow by opening a popup at the returned authUrl', async () => {
    vi.mocked(destinationsApi.oauthStart).mockResolvedValue({ authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x' });
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({ closed: false } as Window);
    renderWithProviders(<AddDestinationModal open onOpenChange={onOpenChange} onCreated={onCreated} />);

    await userEvent.click(screen.getByText('Connect with Google'));

    await waitFor(() => expect(openSpy).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x', 'super-dj-oauth', 'width=500,height=700'));
    openSpy.mockRestore();
  });

  it('closes the modal and refreshes destinations when the callback tab posts the connected message', async () => {
    vi.mocked(destinationsApi.oauthStart).mockResolvedValue({ authUrl: 'https://accounts.google.com/x' });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as Window);
    renderWithProviders(<AddDestinationModal open onOpenChange={onOpenChange} onCreated={onCreated} />);
    await userEvent.click(screen.getByText('Connect with Google'));
    await screen.findByText('Waiting for Google…');

    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: 'super-dj-oauth-connected' }));
    });

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
