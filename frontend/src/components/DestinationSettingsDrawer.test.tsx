import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DestinationSettingsDrawer } from './DestinationSettingsDrawer';
import { renderWithProviders } from '../test/renderWithProviders';

const DESTINATIONS = [
  { id: 'd1', name: 'My channel', rtmpUrl: null, provider: 'youtube' },
  { id: 'd2', name: 'Second channel', rtmpUrl: null, provider: 'youtube' },
];

describe('DestinationSettingsDrawer', () => {
  it('is not rendered when closed', () => {
    renderWithProviders(
      <DestinationSettingsDrawer open={false} onOpenChange={vi.fn()} destinations={DESTINATIONS} onConfirm={vi.fn()} />,
    );
    expect(screen.queryByText('My channel')).not.toBeInTheDocument();
  });

  it('renders one section per destination, each with its own title field', async () => {
    renderWithProviders(
      <DestinationSettingsDrawer open destinations={DESTINATIONS} onOpenChange={vi.fn()} onConfirm={vi.fn()} />,
    );
    expect(screen.getByText('My channel')).toBeInTheDocument();
    expect(screen.getByText('Second channel')).toBeInTheDocument();
    expect(screen.getAllByPlaceholderText('Title (optional — defaults to this destination\'s name)')).toHaveLength(2);
  });

  it('confirms with each destination\'s own draft, defaults included', async () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <DestinationSettingsDrawer open destinations={[DESTINATIONS[0]]} onOpenChange={vi.fn()} onConfirm={onConfirm} />,
    );
    await userEvent.type(screen.getByPlaceholderText('Title (optional — defaults to this destination\'s name)'), 'Friday night set');
    await userEvent.selectOptions(screen.getByLabelText('Privacy'), 'public');
    await userEvent.selectOptions(screen.getByLabelText('Stream latency'), 'low');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledWith({
      d1: { title: 'Friday night set', description: undefined, privacyStatus: 'public', latencyPreference: 'low' },
    });
  });

  it('keeps each destination\'s draft independent of the others', async () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <DestinationSettingsDrawer open destinations={DESTINATIONS} onOpenChange={vi.fn()} onConfirm={onConfirm} />,
    );
    const titleInputs = screen.getAllByPlaceholderText('Title (optional — defaults to this destination\'s name)');
    await userEvent.type(titleInputs[0], 'First title');
    await userEvent.type(titleInputs[1], 'Second title');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledWith({
      d1: { title: 'First title', description: undefined, privacyStatus: 'private', latencyPreference: 'normal' },
      d2: { title: 'Second title', description: undefined, privacyStatus: 'private', latencyPreference: 'normal' },
    });
  });

  it('resets its drafts to blank every time it opens for a fresh set of destinations', async () => {
    const { rerender } = renderWithProviders(
      <DestinationSettingsDrawer open destinations={[DESTINATIONS[0]]} onOpenChange={vi.fn()} onConfirm={vi.fn()} />,
    );
    await userEvent.type(screen.getByPlaceholderText('Title (optional — defaults to this destination\'s name)'), 'Stale title');
    rerender(<DestinationSettingsDrawer open={false} destinations={[DESTINATIONS[0]]} onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    rerender(<DestinationSettingsDrawer open destinations={[DESTINATIONS[0]]} onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByPlaceholderText('Title (optional — defaults to this destination\'s name)')).toHaveValue('');
  });

  it('calls onOpenChange(false) when dismissed via the close button', async () => {
    const onOpenChange = vi.fn();
    renderWithProviders(
      <DestinationSettingsDrawer open destinations={[DESTINATIONS[0]]} onOpenChange={onOpenChange} onConfirm={vi.fn()} />,
    );
    await userEvent.click(screen.getByLabelText('Close'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
