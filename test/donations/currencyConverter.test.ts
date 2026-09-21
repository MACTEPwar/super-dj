import { StubCurrencyConverter } from '../../src/donations/currencyConverter';

describe('StubCurrencyConverter', () => {
  const converter = new StubCurrencyConverter();

  it('converts UAH 1:1', () => {
    expect(converter.toUah(400, 'UAH')).toBe(400);
  });

  it('converts USD using the hardcoded rate', () => {
    expect(converter.toUah(10, 'USD')).toBe(410);
  });

  it('converts EUR using the hardcoded rate', () => {
    expect(converter.toUah(10, 'EUR')).toBe(430);
  });

  it('is case-insensitive on the currency code', () => {
    expect(converter.toUah(10, 'usd')).toBe(410);
  });

  it('returns null for an unsupported currency instead of guessing', () => {
    expect(converter.toUah(10, 'GBP')).toBeNull();
  });
});
