import express from 'express';
import request from 'supertest';
import { createInteractionRuleRouter } from '../../src/donations/interactionRuleRoutes';
import { errorHandler } from '../../src/api/errorHandler';

interface FakeRule {
  id: string;
  userId: string;
  actionType: string;
  enabled: boolean;
  minAmount: number;
  commandKeyword: string;
}

let nextId = 1;

// A small in-memory fake that behaves like InteractionRuleRepository, so GET scoping and the
// PUT/DELETE ownership checks are exercised against real filtering logic rather than just
// asserting a mock was called with the right arguments.
function buildFakeRepository(seed: FakeRule[] = []) {
  const rows = [...seed];
  return {
    rows,
    listByUser: jest.fn(async (userId: string) => rows.filter((r) => r.userId === userId)),
    findById: jest.fn(async (id: string) => rows.find((r) => r.id === id) ?? null),
    create: jest.fn(async (input: Omit<FakeRule, 'id'>) => {
      const rule: FakeRule = { id: `rule-${nextId++}`, ...input };
      rows.push(rule);
      return rule;
    }),
    update: jest.fn(async (id: string, input: Partial<FakeRule>) => {
      const rule = rows.find((r) => r.id === id)!;
      Object.assign(rule, input);
      return rule;
    }),
    delete: jest.fn(async (id: string) => {
      const idx = rows.findIndex((r) => r.id === id);
      if (idx >= 0) rows.splice(idx, 1);
    }),
  };
}

function buildApp(ruleRepository: any, userId = 'user-1') {
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: userId, email: 'a@example.com' }) };
  const app = express();
  app.use(express.json());
  app.use('/interaction-rules', createInteractionRuleRouter(authService, ruleRepository));
  app.use(errorHandler);
  return app;
}

const validBody = { actionType: 'songRequest', enabled: true, minAmount: 50, commandKeyword: 'song' };

describe('interaction rule routes', () => {
  beforeEach(() => {
    nextId = 1;
    jest.clearAllMocks();
  });

  describe('GET /interaction-rules', () => {
    it('returns 200 with only the authenticated user\'s rules', async () => {
      const ruleRepository = buildFakeRepository([
        { id: 'r1', userId: 'user-1', actionType: 'songRequest', enabled: true, minAmount: 50, commandKeyword: 'song' },
        { id: 'r2', userId: 'user-2', actionType: 'songRequest', enabled: true, minAmount: 100, commandKeyword: 'other' },
      ]);

      const res = await request(buildApp(ruleRepository, 'user-1')).get('/interaction-rules');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ id: 'r1', userId: 'user-1' });
      expect(ruleRepository.listByUser).toHaveBeenCalledWith('user-1');
    });
  });

  describe('POST /interaction-rules', () => {
    it('creates a rule for the authenticated user and returns 201', async () => {
      const ruleRepository = buildFakeRepository();

      const res = await request(buildApp(ruleRepository, 'user-1')).post('/interaction-rules').send(validBody);

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ userId: 'user-1', ...validBody });
      expect(ruleRepository.create).toHaveBeenCalledWith({ ...validBody, userId: 'user-1' });
    });

    it('lowercases the stored commandKeyword', async () => {
      const ruleRepository = buildFakeRepository();

      const res = await request(buildApp(ruleRepository, 'user-1'))
        .post('/interaction-rules')
        .send({ ...validBody, commandKeyword: 'SoNg' });

      expect(res.status).toBe(201);
      expect(res.body.commandKeyword).toBe('song');
    });

    it('400s when minAmount is not a positive number', async () => {
      const ruleRepository = buildFakeRepository();

      const res = await request(buildApp(ruleRepository)).post('/interaction-rules').send({ ...validBody, minAmount: 0 });

      expect(res.status).toBe(400);
      expect(ruleRepository.create).not.toHaveBeenCalled();
    });

    it('400s when minAmount is negative', async () => {
      const ruleRepository = buildFakeRepository();

      const res = await request(buildApp(ruleRepository)).post('/interaction-rules').send({ ...validBody, minAmount: -10 });

      expect(res.status).toBe(400);
      expect(ruleRepository.create).not.toHaveBeenCalled();
    });

    it('400s when minAmount is not an integer', async () => {
      const ruleRepository = buildFakeRepository();

      const res = await request(buildApp(ruleRepository)).post('/interaction-rules').send({ ...validBody, minAmount: 12.5 });

      expect(res.status).toBe(400);
      expect(ruleRepository.create).not.toHaveBeenCalled();
    });

    it('400s when commandKeyword is empty', async () => {
      const ruleRepository = buildFakeRepository();

      const res = await request(buildApp(ruleRepository)).post('/interaction-rules').send({ ...validBody, commandKeyword: '' });

      expect(res.status).toBe(400);
      expect(ruleRepository.create).not.toHaveBeenCalled();
    });

    it('400s when commandKeyword contains whitespace', async () => {
      const ruleRepository = buildFakeRepository();

      const res = await request(buildApp(ruleRepository)).post('/interaction-rules').send({ ...validBody, commandKeyword: 'so ng' });

      expect(res.status).toBe(400);
      expect(ruleRepository.create).not.toHaveBeenCalled();
    });

    it('400s when commandKeyword is longer than 20 characters', async () => {
      const ruleRepository = buildFakeRepository();

      const res = await request(buildApp(ruleRepository))
        .post('/interaction-rules')
        .send({ ...validBody, commandKeyword: 'a'.repeat(21) });

      expect(res.status).toBe(400);
      expect(ruleRepository.create).not.toHaveBeenCalled();
    });

    it('400s when actionType is not a known value', async () => {
      const ruleRepository = buildFakeRepository();

      const res = await request(buildApp(ruleRepository)).post('/interaction-rules').send({ ...validBody, actionType: 'somethingElse' });

      expect(res.status).toBe(400);
      expect(ruleRepository.create).not.toHaveBeenCalled();
    });

    it('400s when enabled is not a boolean', async () => {
      const ruleRepository = buildFakeRepository();

      const res = await request(buildApp(ruleRepository)).post('/interaction-rules').send({ ...validBody, enabled: 'yes' });

      expect(res.status).toBe(400);
      expect(ruleRepository.create).not.toHaveBeenCalled();
    });

    it('400s when Content-Type is not application/json, so a plain cross-site form POST cannot trigger it', async () => {
      const ruleRepository = buildFakeRepository();

      const res = await request(buildApp(ruleRepository))
        .post('/interaction-rules')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('x=1');

      expect(res.status).toBe(400);
      expect(ruleRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('PUT /interaction-rules/:id', () => {
    it('200s on a valid partial update of an owned rule', async () => {
      const ruleRepository = buildFakeRepository([
        { id: 'r1', userId: 'user-1', actionType: 'songRequest', enabled: false, minAmount: 50, commandKeyword: 'song' },
      ]);

      const res = await request(buildApp(ruleRepository, 'user-1'))
        .put('/interaction-rules/r1')
        .send({ enabled: true, minAmount: 100, commandKeyword: 'request' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: 'r1', enabled: true, minAmount: 100, commandKeyword: 'request' });
      expect(ruleRepository.update).toHaveBeenCalledWith('r1', {
        actionType: 'songRequest', enabled: true, minAmount: 100, commandKeyword: 'request',
      });
    });

    it('404s when the rule does not exist', async () => {
      const ruleRepository = buildFakeRepository();

      const res = await request(buildApp(ruleRepository, 'user-1')).put('/interaction-rules/missing').send({ enabled: true });

      expect(res.status).toBe(404);
      expect(ruleRepository.update).not.toHaveBeenCalled();
    });

    it('404s (not 403, not 500) when the rule belongs to another user', async () => {
      const ruleRepository = buildFakeRepository([
        { id: 'r1', userId: 'user-2', actionType: 'songRequest', enabled: false, minAmount: 50, commandKeyword: 'song' },
      ]);

      const res = await request(buildApp(ruleRepository, 'user-1')).put('/interaction-rules/r1').send({ enabled: true });

      expect(res.status).toBe(404);
      expect(ruleRepository.update).not.toHaveBeenCalled();
    });

    it('400s when Content-Type is not application/json', async () => {
      const ruleRepository = buildFakeRepository([
        { id: 'r1', userId: 'user-1', actionType: 'songRequest', enabled: false, minAmount: 50, commandKeyword: 'song' },
      ]);

      const res = await request(buildApp(ruleRepository, 'user-1'))
        .put('/interaction-rules/r1')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('enabled=true');

      expect(res.status).toBe(400);
      expect(ruleRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /interaction-rules/:id', () => {
    it('200s on deleting an owned rule', async () => {
      const ruleRepository = buildFakeRepository([
        { id: 'r1', userId: 'user-1', actionType: 'songRequest', enabled: false, minAmount: 50, commandKeyword: 'song' },
      ]);

      const res = await request(buildApp(ruleRepository, 'user-1')).delete('/interaction-rules/r1');

      expect(res.status).toBe(200);
      expect(ruleRepository.delete).toHaveBeenCalledWith('r1');
      expect(ruleRepository.rows).toHaveLength(0);
    });

    it('404s when the rule does not exist', async () => {
      const ruleRepository = buildFakeRepository();

      const res = await request(buildApp(ruleRepository, 'user-1')).delete('/interaction-rules/missing');

      expect(res.status).toBe(404);
      expect(ruleRepository.delete).not.toHaveBeenCalled();
    });

    it('404s (not 403, not 500) when the rule belongs to another user', async () => {
      const ruleRepository = buildFakeRepository([
        { id: 'r1', userId: 'user-2', actionType: 'songRequest', enabled: false, minAmount: 50, commandKeyword: 'song' },
      ]);

      const res = await request(buildApp(ruleRepository, 'user-1')).delete('/interaction-rules/r1');

      expect(res.status).toBe(404);
      expect(ruleRepository.delete).not.toHaveBeenCalled();
    });
  });
});
