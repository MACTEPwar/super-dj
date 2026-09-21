import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import Donations from './Donations';
import { interactionRulesApi } from '../api/interactionRules';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../api/interactionRules');

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/donations" element={<Donations />} />
    </Routes>,
    { route: '/donations' },
  );
}

const RULE = {
  id: 'r1',
  actionType: 'songRequest' as const,
  enabled: true,
  minAmount: 50,
  commandKeyword: 'song',
  createdAt: '',
  updatedAt: '',
};

describe('Donations', () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists the user's rules", async () => {
    vi.mocked(interactionRulesApi.list).mockResolvedValue([RULE]);
    renderPage();
    expect(await screen.findByText('Song request')).toBeInTheDocument();
    expect(screen.getByText('Donation ≥ 50 UAH + command "!song"')).toBeInTheDocument();
  });

  it('opens the create form when "+ Add rule" is clicked', async () => {
    vi.mocked(interactionRulesApi.list).mockResolvedValue([]);
    renderPage();
    await screen.findByText('No rules yet.');

    await userEvent.click(screen.getByText('+ Add rule'));

    expect(await screen.findByText('New rule')).toBeInTheDocument();
  });

  it('submits a valid form and creates the rule', async () => {
    vi.mocked(interactionRulesApi.list)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([RULE]);
    vi.mocked(interactionRulesApi.create).mockResolvedValue(RULE);
    renderPage();
    await screen.findByText('No rules yet.');

    await userEvent.click(screen.getByText('+ Add rule'));
    await screen.findByText('New rule');

    const amountInput = screen.getByRole('spinbutton');
    await userEvent.clear(amountInput);
    await userEvent.type(amountInput, '50');

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(interactionRulesApi.create).toHaveBeenCalledWith({
        actionType: 'songRequest',
        enabled: true,
        minAmount: 50,
        commandKeyword: 'song',
      }),
    );
    await waitFor(() => expect(screen.queryByText('New rule')).not.toBeInTheDocument());
  });

  it('shows a validation error and does not call the API for an invalid amount', async () => {
    vi.mocked(interactionRulesApi.list).mockResolvedValue([]);
    renderPage();
    await screen.findByText('No rules yet.');

    await userEvent.click(screen.getByText('+ Add rule'));
    await screen.findByText('New rule');

    const amountInput = screen.getByRole('spinbutton');
    await userEvent.clear(amountInput);
    await userEvent.type(amountInput, '0');

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Enter a whole number greater than 0')).toBeInTheDocument();
    expect(interactionRulesApi.create).not.toHaveBeenCalled();
  });

  it('shows the rule\'s minAmount in a disabled test-amount field that cannot be edited', async () => {
    vi.mocked(interactionRulesApi.list).mockResolvedValue([RULE]);
    renderPage();
    await screen.findByText('Song request');

    const amountInput = screen.getByRole('spinbutton') as HTMLInputElement;
    expect(amountInput.disabled).toBe(true);
    expect(amountInput.value).toBe('50');
  });

  it('pre-fills the test message with the rule\'s own command, and running the test sends the edited message', async () => {
    vi.mocked(interactionRulesApi.list).mockResolvedValue([RULE]);
    vi.mocked(interactionRulesApi.test).mockResolvedValue({ matched: true, query: 'Blur - Song 2', result: { ok: true } });
    renderPage();
    await screen.findByText('Song request');

    const messageInput = screen.getByDisplayValue('!song:Artist - Title');
    await userEvent.clear(messageInput);
    await userEvent.type(messageInput, '!song:Blur - Song 2');

    await userEvent.click(screen.getByRole('button', { name: 'Test' }));

    await waitFor(() => expect(interactionRulesApi.test).toHaveBeenCalledWith('r1', '!song:Blur - Song 2'));
  });

  it('deletes a rule after confirming', async () => {
    vi.mocked(interactionRulesApi.list)
      .mockResolvedValueOnce([RULE])
      .mockResolvedValueOnce([]);
    vi.mocked(interactionRulesApi.remove).mockResolvedValue({});
    renderPage();
    await screen.findByText('Song request');

    await userEvent.click(screen.getByText('Delete'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(interactionRulesApi.remove).toHaveBeenCalledWith('r1');
    await waitFor(() => expect(screen.getByText('No rules yet.')).toBeInTheDocument());
  });
});
