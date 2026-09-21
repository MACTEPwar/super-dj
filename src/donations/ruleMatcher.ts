import { InteractionRule } from '@prisma/client';
import { DonationEvent } from './donationEvent';
import { CurrencyConverter } from './currencyConverter';

export interface ParsedCommand {
  keyword: string;
  query: string;
}

export interface MatchedRule {
  rule: InteractionRule;
  query: string;
}

// Matches "!keyword:query" anywhere in the message (not required at position 0 — a donor may
// write a greeting first, per the design spec). Everything after the colon to the end of the
// message is the query, trimmed. The 's' flag makes '.' match newlines too.
const COMMAND_PATTERN = /!([A-Za-z0-9_]+):(.+)$/s;

export function parseCommand(message: string): ParsedCommand | null {
  const match = COMMAND_PATTERN.exec(message);
  if (!match) return null;
  const query = match[2].trim();
  if (query.length === 0) return null;
  return { keyword: match[1].toLowerCase(), query };
}

export function matchRules(
  event: DonationEvent,
  rules: InteractionRule[],
  converter: CurrencyConverter,
): MatchedRule[] {
  const command = parseCommand(event.message);
  if (!command) return [];

  const amountInUah = converter.toUah(event.actualAmount, event.actualCurrency);
  if (amountInUah === null) return [];

  return rules
    .filter((rule) => rule.enabled && rule.commandKeyword.toLowerCase() === command.keyword && amountInUah >= rule.minAmount)
    .map((rule) => ({ rule, query: command.query }));
}
