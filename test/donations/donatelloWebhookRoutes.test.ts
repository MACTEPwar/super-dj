import express from 'express';
import request from 'supertest';
import { createDonatelloWebhookRouter } from '../../src/donations/donatelloWebhookRoutes';
import { errorHandler } from '../../src/api/errorHandler';

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
    const app = buildApp({ callbackKey: 'secret', ruleRepository: { listEnabledByUser: jest.fn() }, executeSongRequest: jest.fn(), converter: { toUah: () => 0 }, targetUserId: 'u1' });
    const res = await request(app).post('/webhooks/donatello').send(validBody);
    expect(res.status).toBe(401);
  });

  it('returns 401 when X-Key is wrong', async () => {
    const app = buildApp({ callbackKey: 'secret', ruleRepository: { listEnabledByUser: jest.fn() }, executeSongRequest: jest.fn(), converter: { toUah: () => 0 }, targetUserId: 'u1' });
    const res = await request(app).post('/webhooks/donatello').set('X-Key', 'wrong').send(validBody);
    expect(res.status).toBe(401);
  });

  it('returns 200 and dispatches the matched action on a valid, authenticated request', async () => {
    const listEnabledByUser = jest.fn().mockResolvedValue([
      { id: 'r1', userId: 'u1', actionType: 'songRequest', enabled: true, minAmount: 400, commandKeyword: 'song', createdAt: new Date(), updatedAt: new Date() },
    ]);
    const executeSongRequest = jest.fn().mockResolvedValue(undefined);
    const app = buildApp({
      callbackKey: 'secret',
      ruleRepository: { listEnabledByUser },
      executeSongRequest,
      converter: { toUah: (amount: number) => amount },
      targetUserId: 'u1',
    });

    const res = await request(app).post('/webhooks/donatello').set('X-Key', 'secret').send(validBody);

    expect(res.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve)); // let the fire-and-forget dispatch run
    expect(executeSongRequest).toHaveBeenCalledWith('Believer');
  });

  it('returns 200 even when nothing matched, so Donatello never retries on our own decisions', async () => {
    const app = buildApp({
      callbackKey: 'secret',
      ruleRepository: { listEnabledByUser: jest.fn().mockResolvedValue([]) },
      executeSongRequest: jest.fn(),
      converter: { toUah: (amount: number) => amount },
      targetUserId: 'u1',
    });
    const res = await request(app).post('/webhooks/donatello').set('X-Key', 'secret').send(validBody);
    expect(res.status).toBe(200);
  });

  it('returns 400 on a malformed body', async () => {
    const app = buildApp({ callbackKey: 'secret', ruleRepository: { listEnabledByUser: jest.fn() }, executeSongRequest: jest.fn(), converter: { toUah: () => 0 }, targetUserId: 'u1' });
    const res = await request(app).post('/webhooks/donatello').set('X-Key', 'secret').send({ notEvenClose: true });
    expect(res.status).toBe(400);
  });
});
