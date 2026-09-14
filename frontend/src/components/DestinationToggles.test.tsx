import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DestinationToggles } from './DestinationToggles';
import { renderWithProviders } from '../test/renderWithProviders';

const DESTINATIONS = [
  { id: 'd1', name: 'My channel', rtmpUrl: null, provider: 'youtube' },
  { id: 'd2', name: 'Twitch', rtmpUrl: 'rtmp://live.twitch.tv/app', provider: 'custom' },
];

describe('DestinationToggles', () => {
  it('renders one card per destination, off by default', () => {
    renderWithProviders(<DestinationToggles destinations={DESTINATIONS} forwards={[]} onToggle={vi.fn()} />);
    expect(screen.getByLabelText('My channel')).not.toBeChecked();
    expect(screen.getByLabelText('Twitch')).not.toBeChecked();
    expect(screen.getAllByText('not forwarded')).toHaveLength(2);
  });

  it('reflects a forward\'s desired and actual state', () => {
    renderWithProviders(
      <DestinationToggles
        destinations={DESTINATIONS}
        forwards={[{ destinationId: 'd1', name: 'My channel', desired: 'on', state: 'connecting' }]}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('My channel')).toBeChecked();
    expect(screen.getByText('connecting…')).toBeInTheDocument();
    // Honest about how long a platform takes, so nobody double-toggles and burns API quota.
    expect(screen.getByText('Going live on a platform takes 10-40 seconds. Toggling again will not make it faster.')).toBeInTheDocument();
  });

  // Toggling on before anything is running is legal and has no platform-side effect at all — the UI
  // has to say that rather than look like it failed.
  it('explains a pending forward', () => {
    renderWithProviders(
      <DestinationToggles
        destinations={DESTINATIONS}
        forwards={[{ destinationId: 'd2', name: 'Twitch', desired: 'on', state: 'pending' }]}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText('will start with the stream')).toBeInTheDocument();
  });

  it('shows the provider phase, the watch link and an error', () => {
    renderWithProviders(
      <DestinationToggles
        destinations={DESTINATIONS}
        forwards={[{
          destinationId: 'd1', name: 'My channel', desired: 'on', state: 'error',
          provider: { type: 'youtube', phase: 'error', watchUrl: 'https://www.youtube.com/channel/UC1/live' },
          error: { reason: 'auth', message: 'invalid_grant' },
        }]}
        onToggle={vi.fn()}
      />,
    );
    // The BADGE renders forwardState.error's own locale value ("error"), not a decorated string.
    // "🔴 Error" IS a real string elsewhere (streamPhase.error, used for a DIFFERENT phase label),
    // but this fixture's provider.phase is 'error' and DestinationToggles renders the badge from
    // forwardState[state], not from streamPhase — getByText('error') is what this component
    // actually produces for this fixture, and (per testing-library's getNodeText, which reads only
    // direct text children) is unambiguous here even though "🔴 Error" also contains the substring.
    expect(screen.getByText('error')).toBeInTheDocument();
    expect(screen.getByText('invalid_grant')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open watch page' })).toHaveAttribute('href', 'https://www.youtube.com/channel/UC1/live');
  });

  it('calls onToggle with the opposite intent', async () => {
    const onToggle = vi.fn();
    renderWithProviders(
      <DestinationToggles
        destinations={DESTINATIONS}
        forwards={[{ destinationId: 'd1', name: 'My channel', desired: 'on', state: 'live' }]}
        onToggle={onToggle}
      />,
    );
    await userEvent.click(screen.getByLabelText('My channel'));
    expect(onToggle).toHaveBeenCalledWith('d1', 'off');
    await userEvent.click(screen.getByLabelText('Twitch'));
    expect(onToggle).toHaveBeenCalledWith('d2', 'on');
  });

  it('renders an empty state when the user owns no destinations', () => {
    renderWithProviders(<DestinationToggles destinations={[]} forwards={[]} onToggle={vi.fn()} />);
    expect(screen.getByText('No destinations yet.')).toBeInTheDocument();
  });

  // The spec requires the YouTube consequences of repeated toggling to be visible in the UI copy,
  // not buried in a design doc.
  it('warns that each YouTube toggle starts a brand-new broadcast', () => {
    renderWithProviders(
      <DestinationToggles
        destinations={DESTINATIONS}
        forwards={[
          { destinationId: 'd1', name: 'My channel', desired: 'on', state: 'live' },
          { destinationId: 'd2', name: 'Twitch', desired: 'on', state: 'live' },
        ]}
        onToggle={vi.fn()}
      />,
    );
    // Once — for the YouTube destination only; a custom RTMP destination has no broadcast concept.
    expect(screen.getAllByText(/brand-new broadcast/)).toHaveLength(1);
  });
});
