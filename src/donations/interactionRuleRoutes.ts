import { Router } from 'express';
import { AuthService } from '../auth/authService';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { wrapAsync } from '../api/errorHandler';
import { ApiError } from '../errors';
import { InteractionRuleRepository } from './interactionRuleRepository';
import { matchRules } from './ruleMatcher';
import { DonationEvent } from './donationEvent';
import { CurrencyConverter } from './currencyConverter';
import { SongRequestResult } from './songRequestAction';

export interface InteractionRuleTestDeps {
  converter: CurrencyConverter;
  executeSongRequest: (query: string) => Promise<SongRequestResult>;
}

const COMMAND_KEYWORD_PATTERN = /^[a-zA-Z0-9]{1,20}$/;
// Only one action type exists today — validated explicitly (not just "any non-empty string") so
// a typo doesn't silently create a rule nothing will ever execute.
const KNOWN_ACTION_TYPES = ['songRequest'];

function requireJsonRequest(req: AuthenticatedRequest, _res: unknown, next: (err?: unknown) => void) {
  if (!req.is('application/json')) {
    next(new ApiError(400, 'Content-Type: application/json is required'));
    return;
  }
  next();
}

function validateRuleBody(body: unknown): { actionType: string; enabled: boolean; minAmount: number; commandKeyword: string } {
  const raw = (body ?? {}) as Record<string, unknown>;
  const actionType = raw.actionType;
  const enabled = raw.enabled;
  const minAmount = raw.minAmount;
  const commandKeyword = raw.commandKeyword;

  if (typeof actionType !== 'string' || !KNOWN_ACTION_TYPES.includes(actionType)) {
    throw new ApiError(400, `body.actionType must be one of: ${KNOWN_ACTION_TYPES.join(', ')}`);
  }
  if (typeof enabled !== 'boolean') {
    throw new ApiError(400, 'body.enabled must be a boolean');
  }
  if (typeof minAmount !== 'number' || !Number.isInteger(minAmount) || minAmount <= 0) {
    throw new ApiError(400, 'body.minAmount must be a positive whole number');
  }
  if (typeof commandKeyword !== 'string' || !COMMAND_KEYWORD_PATTERN.test(commandKeyword)) {
    throw new ApiError(400, 'body.commandKeyword must be 1-20 letters/digits with no spaces');
  }

  return { actionType, enabled, minAmount, commandKeyword: commandKeyword.toLowerCase() };
}

export function createInteractionRuleRouter(
  authService: AuthService,
  ruleRepository: InteractionRuleRepository,
  testDeps: InteractionRuleTestDeps,
): Router {
  const router = Router();
  const auth = requireAuth(authService);
  const userId = (req: AuthenticatedRequest) => req.user!.id;

  router.get('/', auth, wrapAsync(async (req, res) => {
    const rules = await ruleRepository.listByUser(userId(req as AuthenticatedRequest));
    res.status(200).json(rules);
  }));

  router.post('/', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const input = validateRuleBody(req.body);
    const rule = await ruleRepository.create({ ...input, userId: userId(req as AuthenticatedRequest) });
    res.status(201).json(rule);
  }));

  router.put('/:id', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const existing = await ruleRepository.findById(req.params.id);
    if (!existing || existing.userId !== userId(req as AuthenticatedRequest)) {
      throw new ApiError(404, 'interaction rule not found');
    }
    const input = validateRuleBody({ actionType: existing.actionType, ...req.body });
    const rule = await ruleRepository.update(req.params.id, input);
    res.status(200).json(rule);
  }));

  // Simulates a real Donatello donation for exactly this rule, entirely bypassing Donatello: the
  // synthetic event's actualAmount is always this rule's own minAmount (never lower, never
  // editable from the frontend), so the only thing under test is whether `message` contains a
  // command matching this rule's keyword. Runs the SAME matchRules() a real webhook call does —
  // including its `enabled` check — so "not matched" here means a real donation with this exact
  // message genuinely would not trigger either, not just that the test endpoint itself declined.
  router.post('/:id/test', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const existing = await ruleRepository.findById(req.params.id);
    if (!existing || existing.userId !== userId(req as AuthenticatedRequest)) {
      throw new ApiError(404, 'interaction rule not found');
    }
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const message = raw.message;
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new ApiError(400, 'body.message must be a non-empty string');
    }

    const syntheticEvent: DonationEvent = {
      clientName: 'Test',
      message,
      actualAmount: existing.minAmount,
      actualCurrency: 'UAH',
      isSubscription: false,
      createdAt: Date.now(),
    };
    const [match] = matchRules(syntheticEvent, [existing], testDeps.converter);
    if (!match) {
      res.status(200).json({ matched: false });
      return;
    }

    const result = await testDeps.executeSongRequest(match.query);
    res.status(200).json({ matched: true, query: match.query, result });
  }));

  router.delete('/:id', auth, wrapAsync(async (req, res) => {
    const existing = await ruleRepository.findById(req.params.id);
    if (!existing || existing.userId !== userId(req as AuthenticatedRequest)) {
      throw new ApiError(404, 'interaction rule not found');
    }
    await ruleRepository.delete(req.params.id);
    res.status(200).json({});
  }));

  return router;
}
