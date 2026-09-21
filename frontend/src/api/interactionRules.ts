import { api } from './client';

// "songRequest" is the only action type today — kept as a real string union (not inlined as a
// boolean) so the frontend is ready for a second action type without a type-shape change.
export type ActionType = 'songRequest';

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

export const interactionRulesApi = {
  list: () => api.get<InteractionRule[]>('/interaction-rules'),
  create: (input: InteractionRuleInput) => api.post<InteractionRule>('/interaction-rules', input),
  update: (id: string, input: Partial<InteractionRuleInput>) => api.put<InteractionRule>(`/interaction-rules/${id}`, input),
  remove: (id: string) => api.delete<Record<string, never>>(`/interaction-rules/${id}`),
};
