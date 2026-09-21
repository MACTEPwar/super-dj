import { Router } from 'express';
import { AuthService } from '../auth/authService';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { wrapAsync } from '../api/errorHandler';
import { ApiError } from '../errors';
import { InteractionRuleRepository } from './interactionRuleRepository';

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

export function createInteractionRuleRouter(authService: AuthService, ruleRepository: InteractionRuleRepository): Router {
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
