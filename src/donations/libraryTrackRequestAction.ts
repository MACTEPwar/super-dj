import { Track } from '../playlist/types';
import { TrackRepository, TrackOverlayOverride } from '../tracks/trackRepository';
import { StreamInserter } from './songRequestAction';

export interface LibraryTrackRequestDeps {
  trackRepository: Pick<TrackRepository, 'findById'>;
  streamInserter: StreamInserter;
  targetUserId: string;
}

export type LibraryTrackRequestResult =
  | { ok: true }
  | { ok: false; reason: 'trackIdMissing' | 'trackNotFound' | 'noActiveStream'; message: string };

const UUID_GLOBAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// The LAST uuid-shaped substring — identical to "the last 36 characters" for a command pasted
// verbatim, but also robust to text a donor adds after it and to a uuid-looking name prefix
// (the real id is always last). The name prefix itself is ignored; it's for humans.
export function extractTrackId(query: string): string | null {
  const matches = query.match(UUID_GLOBAL);
  return matches ? matches[matches.length - 1].toLowerCase() : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Exact-track donation request: no external fetch, no temp file. Ordering against free-text
// requests is NOT this function's job — server.ts runs it through the one shared
// DonationRequestQueue (spec A5). Only ownership is checked, not membership in the live playlist —
// the playlist may change between copying a command and donating (spec A4). Every failure is
// logged and returned; a real donation ignores the result (no feedback channel by design), the
// rule "Test" button reports it.
export async function executeLibraryTrackRequest(deps: LibraryTrackRequestDeps, query: string): Promise<LibraryTrackRequestResult> {
  const id = extractTrackId(query);
  if (!id) {
    console.error(`library track request failed: no track id in query "${query}"`);
    return { ok: false, reason: 'trackIdMissing', message: 'no track id found in the command' };
  }

  const row = await deps.trackRepository.findById(id);
  if (!row || row.userId !== deps.targetUserId) {
    console.error(`library track request failed: track ${id} not found for the donation target`);
    return { ok: false, reason: 'trackNotFound', message: `track ${id} not found` };
  }

  const track: Track = {
    name: row.name,
    audioPath: row.audioPath,
    coverPath: row.coverPath,
    overlayOverride: row.overlayOverride as TrackOverlayOverride | null,
  };

  try {
    deps.streamInserter.enqueueTrack(deps.targetUserId, track);
  } catch (err) {
    console.error('library track request failed: no active local stream to insert into', err);
    return { ok: false, reason: 'noActiveStream', message: errorMessage(err) };
  }
  return { ok: true };
}
