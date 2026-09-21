import { parseDonatelloPayload, InvalidDonationPayloadError } from '../../src/donations/donationEvent';

const validBody = {
  pubId: 'D41-123123',
  clientName: 'Андрій',
  message: 'Привіт! !song:Imagine Dragons - Believer',
  amount: '100',
  currency: 'UAH',
  actualAmount: '100',
  actualCurrency: 'UAH',
  source: 'donatello',
  goal: 'На мікрофон',
  isPaidFee: false,
  isSubscription: false,
  createdAt: '1789935697',
};

describe('parseDonatelloPayload', () => {
  it('parses a valid callback body', () => {
    const event = parseDonatelloPayload(validBody);
    expect(event).toEqual({
      clientName: 'Андрій',
      message: 'Привіт! !song:Imagine Dragons - Believer',
      actualAmount: 100,
      actualCurrency: 'UAH',
      isSubscription: false,
      createdAt: 1789935697,
    });
  });

  it('accepts actualAmount already as a number', () => {
    const event = parseDonatelloPayload({ ...validBody, actualAmount: 100 });
    expect(event.actualAmount).toBe(100);
  });

  it('rejects a non-object body', () => {
    expect(() => parseDonatelloPayload(null)).toThrow(InvalidDonationPayloadError);
    expect(() => parseDonatelloPayload('nope')).toThrow(InvalidDonationPayloadError);
  });

  it('rejects a body missing clientName', () => {
    const { clientName, ...rest } = validBody;
    expect(() => parseDonatelloPayload(rest)).toThrow('clientName must be a string');
  });

  it('rejects a body missing message', () => {
    const { message, ...rest } = validBody;
    expect(() => parseDonatelloPayload(rest)).toThrow('message must be a string');
  });

  it('rejects a non-numeric actualAmount', () => {
    expect(() => parseDonatelloPayload({ ...validBody, actualAmount: 'not-a-number' }))
      .toThrow('actualAmount is not a valid number');
  });

  it('rejects a body missing isSubscription', () => {
    const { isSubscription, ...rest } = validBody;
    expect(() => parseDonatelloPayload(rest)).toThrow('isSubscription must be a boolean');
  });

  it('rejects a non-timestamp createdAt', () => {
    expect(() => parseDonatelloPayload({ ...validBody, createdAt: 'not-a-timestamp' }))
      .toThrow('createdAt is not a valid timestamp');
  });

  it('rejects an actualAmount that is neither string nor number', () => {
    expect(() => parseDonatelloPayload({ ...validBody, actualAmount: true }))
      .toThrow('actualAmount must be a string or number');
    expect(() => parseDonatelloPayload({ ...validBody, actualAmount: {} }))
      .toThrow('actualAmount must be a string or number');
  });

  it('rejects a non-string actualCurrency', () => {
    expect(() => parseDonatelloPayload({ ...validBody, actualCurrency: 123 }))
      .toThrow('actualCurrency must be a string');
  });

  it('rejects a createdAt that is neither string nor number', () => {
    expect(() => parseDonatelloPayload({ ...validBody, createdAt: true }))
      .toThrow('createdAt must be a string or number');
    expect(() => parseDonatelloPayload({ ...validBody, createdAt: {} }))
      .toThrow('createdAt must be a string or number');
  });
});
