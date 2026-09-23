import { SongRequestResult } from './songRequestAction';
import { LibraryTrackRequestResult } from './libraryTrackRequestAction';

// Every interaction-rule action type the app can execute. A real string column in the DB
// (InteractionRule.actionType), validated against this list on write.
export const ACTION_TYPES = ['songRequest', 'libraryTrackRequest'] as const;
export type ActionType = typeof ACTION_TYPES[number];
export const LIBRARY_TRACK_REQUEST: ActionType = 'libraryTrackRequest';

export function isActionType(value: string): value is ActionType {
  return (ACTION_TYPES as readonly string[]).includes(value);
}

export type DonationActionResult = SongRequestResult | LibraryTrackRequestResult;

// ONE object, built once in server.ts and shared by the real webhook and the rule "Test" button,
// so a test exercises exactly the handler a real donation would.
export type DonationActionHandlers = Record<ActionType, (query: string) => Promise<DonationActionResult>>;
