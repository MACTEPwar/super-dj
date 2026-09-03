import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import Templates from './Templates';
import { templatesApi } from '../api/templates';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../api/templates');

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/templates" element={<Templates />} />
      <Route path="/templates/:id" element={<div>editor for the created/selected template</div>} />
    </Routes>,
    { route: '/templates' },
  );
}

describe('Templates', () => {
  it('lists the user\'s templates', async () => {
    vi.mocked(templatesApi.list).mockResolvedValue([{ id: 't1', name: 'My Theme' }]);
    renderPage();
    expect(await screen.findByText('My Theme')).toBeInTheDocument();
  });

  it('creates a new template and navigates straight into its editor', async () => {
    vi.mocked(templatesApi.list).mockResolvedValue([]);
    vi.mocked(templatesApi.create).mockResolvedValue({ id: 't1', name: 'Untitled template', elements: [], createdAt: '', updatedAt: '' });
    renderPage();
    await screen.findByText('No templates yet.');

    await userEvent.click(screen.getByText('+ New Template'));

    expect(templatesApi.create).toHaveBeenCalledWith('Untitled template');
    expect(await screen.findByText('editor for the created/selected template')).toBeInTheDocument();
  });

  it('deletes a template after confirming', async () => {
    vi.mocked(templatesApi.list)
      .mockResolvedValueOnce([{ id: 't1', name: 'My Theme' }])
      .mockResolvedValueOnce([]);
    vi.mocked(templatesApi.remove).mockResolvedValue({});
    renderPage();
    await screen.findByText('My Theme');

    await userEvent.click(screen.getByText('Delete'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(templatesApi.remove).toHaveBeenCalledWith('t1');
    await waitFor(() => expect(screen.getByText('No templates yet.')).toBeInTheDocument());
  });
});
