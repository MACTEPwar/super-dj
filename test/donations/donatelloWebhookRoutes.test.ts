import express from 'express';
import request from 'supertest';
import { createDonatelloWebhookRouter } from '../../src/donations/donatelloWebhookRoutes';
import { errorHandler } from '../../src/api/errorHandler';
import { DonationRequestQueue } from '../../src/donations/donationRequestQueue';

const validBody = {
  clientName: 'Андрій',
  message: '!song:Believer',
  amount: '500',
  currency: 'UAH',
  actualAmount: '500',
  actualCurrency: 'UAH',
  isSubscription: false,
  createdAt: '1789935697',
};

function buildApp(deps: Parameters<typeof createDonatelloWebhookRouter>[0]) {
  const app = express();
  app.use(express.json());
  app.use('/webhooks/donatello', createDonatelloWebhookRouter(deps));
  app.use(errorHandler);
  return app;
}

describe('POST /webhooks/donatello', () => {
  it('returns 401 when X-Key is missing', async () => {
    const app = buildApp({ callbackKey: 'secret', ruleRepository: { listEnabledByUser: jest.fn() }, actions: { songRequest: jest.fn(), libraryTrackRequest: jest.fn() }, converter: { toUah: () => 0 }, targetUserId: 'u1' });
    const res = await request(app).post('/webhooks/donatello').send(validBody);
    expect(res.status).toBe(401);
  });

  it('returns 401 when X-Key is wrong', async () => {
    const app = buildApp({ callbackKey: 'secret', ruleRepository: { listEnabledByUser: jest.fn() }, actions: { songRequest: jest.fn(), libraryTrackRequest: jest.fn() }, converter: { toUah: () => 0 }, targetUserId: 'u1' });
    const res = await request(app).post('/webhooks/donatello').set('X-Key', 'wrong').send(validBody);
    expect(res.status).toBe(401);
  });

  it('returns 200 and dispatches the matched action on a valid, authenticated request', async () => {
    const listEnabledByUser = jest.fn().mockResolvedValue([
      { id: 'r1', userId: 'u1', actionType: 'songRequest', enabled: true, minAmount: 400, commandKeyword: 'song', createdAt: new Date(), updatedAt: new Date() },
    ]);
    const actions = { songRequest: jest.fn().mockResolvedValue(undefined), libraryTrackRequest: jest.fn() };
    const app = buildApp({
      callbackKey: 'secret',
      ruleRepository: { listEnabledByUser },
      actions,
      converter: { toUah: (amount: number) => amount },
      targetUserId: 'u1',
    });

    const res = await request(app).post('/webhooks/donatello').set('X-Key', 'secret').send(validBody);

    expect(res.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve)); // let the fire-and-forget dispatch run
    expect(actions.songRequest).toHaveBeenCalledWith('Believer');
  });

  it('returns 200 even when nothing matched, so Donatello never retries on our own decisions', async () => {
    const app = buildApp({
      callbackKey: 'secret',
      ruleRepository: { listEnabledByUser: jest.fn().mockResolvedValue([]) },
      actions: { songRequest: jest.fn(), libraryTrackRequest: jest.fn() },
      converter: { toUah: (amount: number) => amount },
      targetUserId: 'u1',
    });
    const res = await request(app).post('/webhooks/donatello').set('X-Key', 'secret').send(validBody);
    expect(res.status).toBe(200);
  });

  it('returns 400 on a malformed body', async () => {
    const app = buildApp({ callbackKey: 'secret', ruleRepository: { listEnabledByUser: jest.fn() }, actions: { songRequest: jest.fn(), libraryTrackRequest: jest.fn() }, converter: { toUah: () => 0 }, targetUserId: 'u1' });
    const res = await request(app).post('/webhooks/donatello').set('X-Key', 'secret').send({ notEvenClose: true });
    expect(res.status).toBe(400);
  });

  it('dispatches each matched rule to the handler for its own actionType', async () => {
    const listEnabledByUser = jest.fn().mockResolvedValue([
      { id: 'r1', userId: 'u1', actionType: 'libraryTrackRequest', enabled: true, minAmount: 100, commandKeyword: 'track', createdAt: new Date(), updatedAt: new Date() },
    ]);
    const actions = { songRequest: jest.fn(), libraryTrackRequest: jest.fn().mockResolvedValue({ ok: true }) };
    const app = buildApp({ callbackKey: 'secret', ruleRepository: { listEnabledByUser }, actions, converter: { toUah: (a: number) => a }, targetUserId: 'u1' });
    await request(app).post('/webhooks/donatello').set('X-Key', 'secret').send({ ...validBody, message: 'hi !track:Believer 3f2b9c1e-8d4a-4e2b-9a7c-1b2c3d4e5f60' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(actions.libraryTrackRequest).toHaveBeenCalledWith('Believer 3f2b9c1e-8d4a-4e2b-9a7c-1b2c3d4e5f60');
    expect(actions.songRequest).not.toHaveBeenCalled();
  });

  it('skips (logs) a stored rule with an unknown actionType instead of throwing', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const listEnabledByUser = jest.fn().mockResolvedValue([
      { id: 'r1', userId: 'u1', actionType: 'bogus', enabled: true, minAmount: 1, commandKeyword: 'song', createdAt: new Date(), updatedAt: new Date() },
    ]);
    const actions = { songRequest: jest.fn(), libraryTrackRequest: jest.fn() };
    const app = buildApp({ callbackKey: 'secret', ruleRepository: { listEnabledByUser }, actions, converter: { toUah: (a: number) => a }, targetUserId: 'u1' });
    const res = await request(app).post('/webhooks/donatello').set('X-Key', 'secret').send(validBody);
    await new Promise((resolve) => setImmediate(resolve));
    expect(res.status).toBe(200);
    expect(actions.songRequest).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('one shared queue: an earlier slow free-text donation plays before a later instant exact-track one', async () => {
    const queue = new DonationRequestQueue();
    const inserted: string[] = [];
    const actions = {
      songRequest: (q: string) => queue.enqueue(() => new Promise((r) => setTimeout(() => { inserted.push(`song:${q}`); r({ ok: true }); }, 30))),
      libraryTrackRequest: (q: string) => queue.enqueue(async () => { inserted.push(`lib:${q}`); return { ok: true }; }),
    } as any;
    const listEnabledByUser = jest.fn().mockResolvedValue([
      { id: 'r1', userId: 'u1', actionType: 'songRequest', enabled: true, minAmount: 1, commandKeyword: 'song', createdAt: new Date(), updatedAt: new Date() },
      { id: 'r2', userId: 'u1', actionType: 'libraryTrackRequest', enabled: true, minAmount: 1, commandKeyword: 'track', createdAt: new Date(), updatedAt: new Date() },
    ]);
    const app = buildApp({ callbackKey: 'secret', ruleRepository: { listEnabledByUser }, actions, converter: { toUah: (a: number) => a }, targetUserId: 'u1' });
    await request(app).post('/webhooks/donatello').set('X-Key', 'secret').send({ ...validBody, message: '!song:Believer' });
    await request(app).post('/webhooks/donatello').set('X-Key', 'secret').send({ ...validBody, message: '!track:X 3f2b9c1e-8d4a-4e2b-9a7c-1b2c3d4e5f60' });
    await new Promise((r) => setTimeout(r, 100));
    expect(inserted).toEqual(['song:Believer', 'lib:X 3f2b9c1e-8d4a-4e2b-9a7c-1b2c3d4e5f60']);
  });
});
