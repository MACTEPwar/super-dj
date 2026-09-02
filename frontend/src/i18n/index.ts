import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import ru from './locales/ru.json';
import uk from './locales/uk.json';

export const LANGUAGE_STORAGE_KEY = 'super-dj-language';
export const SUPPORTED_LANGUAGES = ['uk', 'en', 'ru'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
const DEFAULT_LANGUAGE: SupportedLanguage = 'uk';

function isSupportedLanguage(value: string | null): value is SupportedLanguage {
  return value !== null && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

function getInitialLanguage(): SupportedLanguage {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (isSupportedLanguage(stored)) return stored;
  } catch {
    // localStorage can throw (e.g. private browsing) — fall back to the default below.
  }
  return DEFAULT_LANGUAGE;
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ru: { translation: ru },
    uk: { translation: uk },
  },
  lng: getInitialLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  interpolation: { escapeValue: false },
});

export function changeLanguage(lang: SupportedLanguage): void {
  void i18n.changeLanguage(lang);
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  } catch {
    // per-viewer convenience only — losing the preference just means it resets next visit.
  }
}

export default i18n;
