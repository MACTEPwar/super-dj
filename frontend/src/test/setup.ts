import '@testing-library/jest-dom/vitest';
import i18n from '../i18n';

// The app defaults to Ukrainian, but existing tests assert on the original English
// microcopy — force English for the whole test run so those assertions stay meaningful
// without needing per-test locale setup.
await i18n.changeLanguage('en');
