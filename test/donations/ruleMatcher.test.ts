import { parseCommand, matchRules } from '../../src/donations/ruleMatcher';
import { DonationEvent } from '../../src/donations/donationEvent';
import { CurrencyConverter } from '../../src/donations/currencyConverter';
import { InteractionRule } from '@prisma/client';

describe('parseCommand', () => {
  it('parses a command at the start of the message', () => {
    expect(parseCommand('!song:Imagine Dragons - Believer')).toEqual({ keyword: 'song', query: 'Imagine Dragons - Believer' });
  });

  it('parses a command anywhere in the message, taking everything after the colon', () => {
    expect(parseCommand('Привіт! !song:Blur - Song 2 (Official Music Video)')).toEqual({ keyword: 'song', query: 'Blur - Song 2 (Official Music Video)' });
  });

  it('is case-insensitive on the keyword', () => {
    expect(parseCommand('!SONG:Believer')).toEqual({ keyword: 'song', query: 'Believer' });
  });

  it('returns null when there is no command', () => {
    expect(parseCommand('дякую за стрім!')).toBeNull();
  });

  it('returns null when the query part is empty', () => {
    expect(parseCommand('!song:   ')).toBeNull();
  });
});

describe('matchRules', () => {
  const baseEvent: DonationEvent = {
    clientName: 'Андрій',
    message: '!song:Believer',
    actualAmount: 500,
    actualCurrency: 'UAH',
    isSubscription: false,
    createdAt: 123,
  };

  const rule = (overrides: Partial<InteractionRule>): InteractionRule => ({
    id: 'r1', userId: 'u1', actionType: 'songRequest', enabled: true,
    minAmount: 400, commandKeyword: 'song', createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  });

  const identityConverter: CurrencyConverter = { toUah: (amount, currency) => (currency === 'UAH' ? amount : null) };

  it('matches an enabled rule whose keyword and threshold are met', () => {
    const result = matchRules(baseEvent, [rule({})], identityConverter);
    expect(result).toEqual([{ rule: rule({}), query: 'Believer' }]);
  });

  it('does not match a disabled rule', () => {
    expect(matchRules(baseEvent, [rule({ enabled: false })], identityConverter)).toEqual([]);
  });

  it('does not match when the donation is below the threshold', () => {
    expect(matchRules({ ...baseEvent, actualAmount: 100 }, [rule({})], identityConverter)).toEqual([]);
  });

  it('does not match a different keyword', () => {
    expect(matchRules(baseEvent, [rule({ commandKeyword: 'vip' })], identityConverter)).toEqual([]);
  });

  it('does not match when the message has no command at all', () => {
    expect(matchRules({ ...baseEvent, message: 'дякую!' }, [rule({})], identityConverter)).toEqual([]);
  });

  it('does not match when the currency cannot be converted', () => {
    expect(matchRules({ ...baseEvent, actualCurrency: 'GBP' }, [rule({})], identityConverter)).toEqual([]);
  });

  it('matches every enabled rule sharing the same keyword', () => {
    const result = matchRules(baseEvent, [rule({ id: 'r1' }), rule({ id: 'r2', minAmount: 1000 })], identityConverter);
    expect(result.map((m) => m.rule.id)).toEqual(['r1']);
  });

  it('matches multiple rules that both genuinely qualify', () => {
    const result = matchRules(
      baseEvent,
      [rule({ id: 'r1', minAmount: 400 }), rule({ id: 'r2', minAmount: 300 })],
      identityConverter,
    );
    expect(result.map((m) => m.rule.id).sort()).toEqual(['r1', 'r2']);
  });

  it('matches regardless of case differences between the rule keyword and the message command', () => {
    const result = matchRules(baseEvent, [rule({ commandKeyword: 'SONG' })], identityConverter);
    expect(result.map((m) => m.rule.id)).toEqual(['r1']);
  });
});
