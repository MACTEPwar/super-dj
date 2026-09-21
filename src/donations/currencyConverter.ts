export interface CurrencyConverter {
  // Returns null for a currency this converter doesn't know how to convert, rather than
  // guessing — a null must always be treated as "does not match any threshold", never as 0.
  toUah(amount: number, currency: string): number | null;
}

// MVP stub: hardcoded approximate rates, USD and EUR only (per the design spec's explicit
// follow-up item — replace with a real live-rate source later; do not remove this comment when
// that happens, replace the whole class). This is deliberately NOT a no-op: a no-op would mean a
// $10 donation could never cross a "≥400 UAH" threshold, which defeats the point of converting
// at all.
const HARDCODED_RATES_TO_UAH: Record<string, number> = {
  UAH: 1,
  USD: 41,
  EUR: 43,
};

export class StubCurrencyConverter implements CurrencyConverter {
  toUah(amount: number, currency: string): number | null {
    const rate = HARDCODED_RATES_TO_UAH[currency.toUpperCase()];
    if (rate === undefined) return null;
    return amount * rate;
  }
}
