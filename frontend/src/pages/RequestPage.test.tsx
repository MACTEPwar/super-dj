import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import RequestPage from './RequestPage';
import { fetchPublicRequestPage } from '../api/requestPage';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../api/requestPage', async (orig) => ({ ...(await orig<typeof import('../api/requestPage')>()), fetchPublicRequestPage: vi.fn() }));

const ID = '3f2b9c1e-8d4a-4e2b-9a7c-1b2c3d4e5f60';
const render = () => renderWithProviders(<Routes><Route path="/r/:token" element={<RequestPage />} /></Routes>, { route: '/r/tok' });

describe('RequestPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loading', () => {
    vi.mocked(fetchPublicRequestPage).mockReturnValue(new Promise(() => {}));
    render();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('not found', async () => {
    vi.mocked(fetchPublicRequestPage).mockResolvedValue({ kind: 'notFound' });
    render();
    expect(await screen.findByText("This link isn't valid.")).toBeInTheDocument();
  });

  it('offline', async () => {
    vi.mocked(fetchPublicRequestPage).mockResolvedValue({ kind: 'offline' });
    render();
    expect(await screen.findByText("The stream isn't live right now.")).toBeInTheDocument();
  });

  it('live without a rule: tracks, no copy buttons', async () => {
    vi.mocked(fetchPublicRequestPage).mockResolvedValue({ kind: 'live', playlistName: 'Set', tracks: [{ id: ID, name: 'Believer', durationSeconds: 200 }], request: null });
    render();
    expect(await screen.findByText('Believer')).toBeInTheDocument();
    expect(screen.getByText("Track requests aren't enabled right now.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
  });

  it('live with a rule: copy writes the command to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    vi.mocked(fetchPublicRequestPage).mockResolvedValue({ kind: 'live', playlistName: 'Set', tracks: [{ id: ID, name: 'Believer', durationSeconds: 200 }], request: { keyword: 'track', minAmount: 50 } });
    render();
    await userEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(`!track:Believer ${ID}`);
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('falls back to a selectable field when the clipboard rejects', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    vi.mocked(fetchPublicRequestPage).mockResolvedValue({ kind: 'live', playlistName: 'Set', tracks: [{ id: ID, name: 'Believer', durationSeconds: 200 }], request: { keyword: 'track', minAmount: 50 } });
    render();
    await userEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(await screen.findByDisplayValue(`!track:Believer ${ID}`)).toBeInTheDocument();
  });
});
