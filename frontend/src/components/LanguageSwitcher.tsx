import { useTranslation } from 'react-i18next';
import { changeLanguage, SUPPORTED_LANGUAGES, SupportedLanguage } from '../i18n';

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  return (
    <select
      aria-label="Language"
      className="w-full rounded border px-2 py-1 text-sm"
      value={i18n.language}
      onChange={(e) => changeLanguage(e.target.value as SupportedLanguage)}
    >
      {SUPPORTED_LANGUAGES.map((lang) => (
        <option key={lang} value={lang}>{t(`language.${lang}`)}</option>
      ))}
    </select>
  );
}
