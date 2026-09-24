import { Router } from 'express';
import { AuthService } from '../auth/authService';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { wrapAsync } from '../api/errorHandler';
import { ApiError } from '../errors';
import { InteractionRuleRepository } from './interactionRuleRepository';
import { matchRules } from './ruleMatcher';
import { DonationEvent } from './donationEvent';
import { CurrencyConverter } from './currencyConverter';
import { ACTION_TYPES, DonationActionHandlers, isActionType } from './donationActions';

export interface InteractionRuleTestDeps {
  converter: CurrencyConverter;
  actions: DonationActionHandlers;
}

const COMMAND_KEYWORD_PATTERN = /^[a-zA-Z0-9]{1,20}$/;

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

  if (typeof actionType !== 'string' || !isActionType(actionType)) {
    throw new ApiError(400, `body.actionType must be one of: ${ACTION_TYPES.join(', ')}`);
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

  // Two rules sharing a keyword would BOTH fire on one donation (matchRules returns every match)
  // — e.g. a copied library command also sent to the media-search service as garbage free text.
  // Enforced here rather than as a DB constraint so pre-existing duplicates keep working.
  const assertKeywordFree = async (ownerId: string, keyword: string, exceptRuleId?: string) => {
    const rules = await ruleRepository.listByUser(ownerId);
    if (rules.some((r) => r.id !== exceptRuleId && r.commandKeyword.toLowerCase() === keyword)) {
      throw new ApiError(409, `another rule already uses the command keyword "!${keyword}"`);
    }
  };

  router.get('/', auth, wrapAsync(async (req, res) => {
    const rules = await ruleRepository.listByUser(userId(req as AuthenticatedRequest));
    res.status(200).json(rules);
  }));

  router.post('/', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const input = validateRuleBody(req.body);
    await assertKeywordFree(userId(req as AuthenticatedRequest), input.commandKeyword);
    const rule = await ruleRepository.create({ ...input, userId: userId(req as AuthenticatedRequest) });
    res.status(201).json(rule);
  }));

  router.put('/:id', auth, requireJsonRequest, wrapAsync(async (req, res) => {
    const existing = await ruleRepository.findById(req.params.id);
    if (!existing || existing.userId !== userId(req as AuthenticatedRequest)) {
      throw new ApiError(404, 'interaction rule not found');
    }
    const input = validateRuleBody({ actionType: existing.actionType, ...req.body });
    await assertKeywordFree(userId(req as AuthenticatedRequest), input.commandKeyword, existing.id);
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

    const actionType = match.rule.actionType;
    if (!isActionType(actionType)) throw new ApiError(409, `rule has an unsupported action type: ${actionType}`);
    const result = await testDeps.actions[actionType](match.query);
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
