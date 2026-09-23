import { api } from './client';

// A real string union (not inlined as a boolean) so the frontend stays ready for further action
// types without a type-shape change.
export type ActionType = 'songRequest' | 'libraryTrackRequest';

export interface InteractionRule {
  id: string;
  actionType: ActionType;
  enabled: boolean;
  minAmount: number;
  commandKeyword: string;
  createdAt: string;
  updatedAt: string;
}

export interface InteractionRuleInput {
  actionType: ActionType;
  enabled: boolean;
  minAmount: number;
  commandKeyword: string;
}

export type DonationActionResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'mediaSearchFailed' | 'writeFailed' | 'noActiveStream' | 'trackIdMissing' | 'trackNotFound';
      message: string;
    };

export type TestInteractionRuleResult =
  | { matched: false }
  | { matched: true; query: string; result: DonationActionResult };

export const interactionRulesApi = {
  list: () => api.get<InteractionRule[]>('/interaction-rules'),
  create: (input: InteractionRuleInput) => api.post<InteractionRule>('/interaction-rules', input),
  update: (id: string, input: InteractionRuleInput) => api.put<InteractionRule>(`/interaction-rules/${id}`, input),
  remove: (id: string) => api.delete<Record<string, never>>(`/interaction-rules/${id}`),
  // Simulates a donation of exactly this rule's own minAmount (server-enforced, never sent as a
  // parameter here) — bypasses Donatello entirely, for testing a rule without spending real money.
  test: (id: string, message: string) => api.post<TestInteractionRuleResult>(`/interaction-rules/${id}/test`, { message }),
};
