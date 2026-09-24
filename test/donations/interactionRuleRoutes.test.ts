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

function buildTestDeps(overrides: Partial<{ converter: any; actions: any }> = {}) {
  return {
    converter: { toUah: (amount: number) => amount },
    actions: {
      songRequest: jest.fn().mockResolvedValue({ ok: true }),
      libraryTrackRequest: jest.fn().mockResolvedValue({ ok: true }),
    },
    ...overrides,
  };
}

function buildApp(ruleRepository: any, userId = 'user-1', testDeps = buildTestDeps()) {
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: userId, email: 'a@example.com' }) };
  const app = express();
  app.use(express.json());
  app.use('/interaction-rules', createInteractionRuleRouter(authService, ruleRepository, testDeps));
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

  describe('POST /interaction-rules/:id/test', () => {
    const seedRule = { id: 'r1', userId: 'user-1', actionType: 'songRequest', enabled: true, minAmount: 100, commandKeyword: 'song' };

    it('returns matched:false when the message does not contain the rule\'s command', async () => {
      const ruleRepository = buildFakeRepository([seedRule]);
      const testDeps = buildTestDeps();

      const res = await request(buildApp(ruleRepository, 'user-1', testDeps))
        .post('/interaction-rules/r1/test')
        .send({ message: 'just a greeting, no command here' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ matched: false });
      expect(testDeps.actions.songRequest).not.toHaveBeenCalled();
    });

    it('returns matched:false when the rule is disabled, mirroring real webhook behavior', async () => {
      const ruleRepository = buildFakeRepository([{ ...seedRule, enabled: false }]);
      const testDeps = buildTestDeps();

      const res = await request(buildApp(ruleRepository, 'user-1', testDeps))
        .post('/interaction-rules/r1/test')
        .send({ message: '!song:Artist - Title' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ matched: false });
      expect(testDeps.actions.songRequest).not.toHaveBeenCalled();
    });

    it('matches, calls the songRequest action with the parsed query, and returns its result', async () => {
      const ruleRepository = buildFakeRepository([seedRule]);
      const testDeps = buildTestDeps();
      testDeps.actions.songRequest.mockResolvedValue({ ok: true });

      const res = await request(buildApp(ruleRepository, 'user-1', testDeps))
        .post('/interaction-rules/r1/test')
        .send({ message: '!song:Artist - Title' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ matched: true, query: 'Artist - Title', result: { ok: true } });
      expect(testDeps.actions.songRequest).toHaveBeenCalledWith('Artist - Title');
    });

    it('surfaces a failed songRequest action result without erroring the request', async () => {
      const ruleRepository = buildFakeRepository([seedRule]);
      const testDeps = buildTestDeps();
      testDeps.actions.songRequest.mockResolvedValue({ ok: false, reason: 'noActiveStream', message: 'local stream is not active' });

      const res = await request(buildApp(ruleRepository, 'user-1', testDeps))
        .post('/interaction-rules/r1/test')
        .send({ message: '!song:Artist - Title' });

      expect(res.status).toBe(200);
      expect(res.body.result).toEqual({ ok: false, reason: 'noActiveStream', message: 'local stream is not active' });
    });

    it('404s when the rule does not exist', async () => {
      const ruleRepository = buildFakeRepository();

      const res = await request(buildApp(ruleRepository, 'user-1')).post('/interaction-rules/missing/test').send({ message: '!song:x' });

      expect(res.status).toBe(404);
    });

    it('404s (not 403, not 500) when the rule belongs to another user', async () => {
      const ruleRepository = buildFakeRepository([{ ...seedRule, userId: 'user-2' }]);

      const res = await request(buildApp(ruleRepository, 'user-1')).post('/interaction-rules/r1/test').send({ message: '!song:x' });

      expect(res.status).toBe(404);
    });

    it('400s when message is missing or not a string', async () => {
      const ruleRepository = buildFakeRepository([seedRule]);

      const res = await request(buildApp(ruleRepository, 'user-1')).post('/interaction-rules/r1/test').send({});

      expect(res.status).toBe(400);
    });

    it('400s when Content-Type is not application/json', async () => {
      const ruleRepository = buildFakeRepository([seedRule]);

      const res = await request(buildApp(ruleRepository, 'user-1'))
        .post('/interaction-rules/r1/test')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('message=x');

      expect(res.status).toBe(400);
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

  describe('libraryTrackRequest and keyword uniqueness', () => {
    it('accepts the new action type', async () => {
      const repo = buildFakeRepository();
      const res = await request(buildApp(repo)).post('/interaction-rules')
        .send({ actionType: 'libraryTrackRequest', enabled: true, minAmount: 50, commandKeyword: 'track' });
      expect(res.status).toBe(201);
    });

    it('409s a keyword already used by another of the caller\'s rules, case-insensitively', async () => {
      const repo = buildFakeRepository([{ id: 'r1', userId: 'user-1', actionType: 'songRequest', enabled: true, minAmount: 50, commandKeyword: 'song' }]);
      const res = await request(buildApp(repo)).post('/interaction-rules')
        .send({ actionType: 'libraryTrackRequest', enabled: true, minAmount: 50, commandKeyword: 'SONG' });
      expect(res.status).toBe(409);
    });

    it('a keyword used only by ANOTHER user is fine', async () => {
      const repo = buildFakeRepository([{ id: 'r1', userId: 'user-2', actionType: 'songRequest', enabled: true, minAmount: 50, commandKeyword: 'song' }]);
      const res = await request(buildApp(repo)).post('/interaction-rules').send(validBody);
      expect(res.status).toBe(201);
    });

    it('PUT may keep its own keyword but not take a sibling\'s', async () => {
      const repo = buildFakeRepository([
        { id: 'r1', userId: 'user-1', actionType: 'songRequest', enabled: true, minAmount: 50, commandKeyword: 'song' },
        { id: 'r2', userId: 'user-1', actionType: 'libraryTrackRequest', enabled: true, minAmount: 50, commandKeyword: 'track' },
      ]);
      const app = buildApp(repo);
      expect((await request(app).put('/interaction-rules/r1').send({ enabled: false, minAmount: 60, commandKeyword: 'song' })).status).toBe(200);
      expect((await request(app).put('/interaction-rules/r1').send({ enabled: false, minAmount: 60, commandKeyword: 'track' })).status).toBe(409);
    });

    it('the test route dispatches by the rule\'s own actionType', async () => {
      const repo = buildFakeRepository([{ id: 'r2', userId: 'user-1', actionType: 'libraryTrackRequest', enabled: true, minAmount: 50, commandKeyword: 'track' }]);
      const testDeps = buildTestDeps();
      testDeps.actions.libraryTrackRequest.mockResolvedValue({ ok: false, reason: 'trackNotFound', message: 'x' });
      const res = await request(buildApp(repo, 'user-1', testDeps)).post('/interaction-rules/r2/test')
        .send({ message: '!track:Believer 3f2b9c1e-8d4a-4e2b-9a7c-1b2c3d4e5f60' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ matched: true, query: 'Believer 3f2b9c1e-8d4a-4e2b-9a7c-1b2c3d4e5f60', result: { ok: false, reason: 'trackNotFound', message: 'x' } });
      expect(testDeps.actions.songRequest).not.toHaveBeenCalled();
    });
  });
});
