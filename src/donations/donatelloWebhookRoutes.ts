import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { parseDonatelloPayload, InvalidDonationPayloadError } from './donationEvent';
import { matchRules } from './ruleMatcher';
import { CurrencyConverter } from './currencyConverter';
import { wrapAsync } from '../api/errorHandler';
import { ApiError } from '../errors';
import { InteractionRuleRepository } from './interactionRuleRepository';
import { SongRequestResult } from './songRequestAction';

export interface DonatelloWebhookDeps {
  callbackKey: string;
  ruleRepository: Pick<InteractionRuleRepository, 'listEnabledByUser'>;
  executeSongRequest: (query: string) => Promise<SongRequestResult>;
  converter: CurrencyConverter;
  // MVP stopgap — see the design spec and AppConfig.donationTargetUserId.
  targetUserId: string;
}

function timingSafeKeyEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function createDonatelloWebhookRouter(deps: DonatelloWebhookDeps): Router {
  const router = Router();

  router.post('/', wrapAsync(async (req, res) => {
    const key = req.header('X-Key');
    if (!key || !timingSafeKeyEqual(key, deps.callbackKey)) {
      throw new ApiError(401, 'invalid or missing X-Key');
    }

    let event;
    try {
      event = parseDonatelloPayload(req.body);
    } catch (err) {
      if (err instanceof InvalidDonationPayloadError) throw new ApiError(400, err.message);
      throw err;
    }

    // Answer fast; a structurally valid, authenticated request is always 200 from here on — our
    // own downstream decisions (no rule matched, the action failed) must never look like a
    // delivery failure to Donatello, or it will retry forever.
    res.status(200).json({ received: true });

    const rules = await deps.ruleRepository.listEnabledByUser(deps.targetUserId);
    // Every matched rule's actionType is "songRequest" today (the only value validated by
    // interactionRuleRoutes.ts — see Task 12), so dispatching straight to executeSongRequest is
    // correct for MVP. match.rule.actionType exists for the day a second action type is added;
    // this loop becomes a real dispatch (switch on actionType) at that point, not before.
    const matches = matchRules(event, rules, deps.converter);
    for (const match of matches) {
      deps.executeSongRequest(match.query).catch((err) => {
        console.error('donation-triggered action failed', err);
      });
    }
  }));

  return router;
}
