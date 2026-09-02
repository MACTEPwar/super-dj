import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { LanguageSwitcher } from './LanguageSwitcher';
import i18n, { LANGUAGE_STORAGE_KEY } from '../i18n';

// This test environment's global `localStorage` isn't a working Storage implementation
// (none of its methods exist — an unrelated Node/jsdom environment quirk, not something
// the app's own code controls), so stub in a real one rather than relying on it.
function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
  };
}

describe('LanguageSwitcher', () => {
  beforeEach(async () => {
    vi.stubGlobal('localStorage', fakeLocalStorage());
    await i18n.changeLanguage('en');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows all three languages, with the current one selected', () => {
    render(<I18nextProvider i18n={i18n}><LanguageSwitcher /></I18nextProvider>);
    const select = screen.getByLabelText('Language') as HTMLSelectElement;
    expect(select.value).toBe('en');
    expect(screen.getByRole('option', { name: 'English' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Русский' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Українська' })).toBeInTheDocument();
  });

  it('switches the active language and persists the choice', async () => {
    render(<I18nextProvider i18n={i18n}><LanguageSwitcher /></I18nextProvider>);

    await userEvent.selectOptions(screen.getByLabelText('Language'), 'uk');

    await waitFor(() => expect(i18n.language).toBe('uk'));
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('uk');
  });
});
