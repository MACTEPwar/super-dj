// Only the fields the rule-matching engine and action executor actually need — the callback
// body carries more (pubId, goal, interactionMedia, ...) that this feature ignores by design.
export interface DonationEvent {
  clientName: string;
  message: string;
  actualAmount: number;
  actualCurrency: string;
  isSubscription: boolean;
  createdAt: number;
}

export class InvalidDonationPayloadError extends Error {}

// Donatello's "Колбеки" callback body — verified against the real dashboard's own example
// payload (amount/currency are sent as strings, not numbers). actualAmount/actualCurrency (the
// "honestly received" amount) is what the threshold check uses, not amount/currency.
export function parseDonatelloPayload(body: unknown): DonationEvent {
  if (typeof body !== 'object' || body === null) {
    throw new InvalidDonationPayloadError('request body must be a JSON object');
  }
  const raw = body as Record<string, unknown>;

  if (typeof raw.clientName !== 'string') {
    throw new InvalidDonationPayloadError('clientName must be a string');
  }
  if (typeof raw.message !== 'string') {
    throw new InvalidDonationPayloadError('message must be a string');
  }
  if (typeof raw.actualAmount !== 'string' && typeof raw.actualAmount !== 'number') {
    throw new InvalidDonationPayloadError('actualAmount must be a string or number');
  }
  if (typeof raw.actualCurrency !== 'string') {
    throw new InvalidDonationPayloadError('actualCurrency must be a string');
  }
  if (typeof raw.isSubscription !== 'boolean') {
    throw new InvalidDonationPayloadError('isSubscription must be a boolean');
  }
  if (typeof raw.createdAt !== 'string' && typeof raw.createdAt !== 'number') {
    throw new InvalidDonationPayloadError('createdAt must be a string or number');
  }

  const actualAmount = Number(raw.actualAmount);
  if (!Number.isFinite(actualAmount)) {
    throw new InvalidDonationPayloadError('actualAmount is not a valid number');
  }

  return {
    clientName: raw.clientName,
    message: raw.message,
    actualAmount,
    actualCurrency: raw.actualCurrency,
    isSubscription: raw.isSubscription,
    createdAt: Number(raw.createdAt),
  };
}
