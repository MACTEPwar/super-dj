import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Track } from '../playlist/types';
import { MediaSearchClient } from '../media/mediaSearchClient';

export interface StreamInserter {
  insertEphemeralTrack(userId: string, track: Track): void;
}

export interface SongRequestDeps {
  mediaSearchClient: MediaSearchClient;
  streamInserter: StreamInserter;
  // A dedicated temp directory — NOT {UPLOADS_DIR}, which is for the permanent track library.
  tempDir: string;
  targetUserId: string;
}

// A real donation callback has no feedback channel and never inspects this — it's caught and
// logged, same as always. It exists so the interaction-rule "Test" button (which DOES have a
// caller waiting on a real HTTP response) can report which stage failed, instead of a silent
// no-op indistinguishable from success.
export type SongRequestResult =
  | { ok: true }
  | { ok: false; reason: 'mediaSearchFailed' | 'writeFailed' | 'noActiveStream'; message: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Fetches the requested track, inserts it as a one-off next track, and wires up its own
// deletion. Every failure path (media search failure, no active stream to insert into) is
// logged here regardless of caller — a real donation callback has no user-facing feedback in MVP
// by design, so it only ever consults the resolved value's `ok` flag when it bothers to at all.
export async function executeSongRequest(deps: SongRequestDeps, query: string): Promise<SongRequestResult> {
  let audioBuffer: Buffer;
  try {
    audioBuffer = await deps.mediaSearchClient.fetchAudio(query);
  } catch (err) {
    console.error(`song request failed: could not fetch audio for query "${query}"`, err);
    return { ok: false, reason: 'mediaSearchFailed', message: errorMessage(err) };
  }

  const filePath = path.join(deps.tempDir, `${randomUUID()}.mp3`);
  try {
    await fs.mkdir(deps.tempDir, { recursive: true });
    await fs.writeFile(filePath, audioBuffer);
  } catch (err) {
    console.error(`song request failed: could not write temp file ${filePath}`, err);
    await fs.unlink(filePath).catch(() => {});
    return { ok: false, reason: 'writeFailed', message: errorMessage(err) };
  }

  const track: Track = {
    name: `🎁 Заказ: ${query}`,
    audioPath: filePath,
    coverPath: null,
  };
  track._onFinished = () => {
    fs.unlink(filePath).catch((err) => {
      console.error(`failed to delete temp donation-song file ${filePath}`, err);
    });
  };

  try {
    deps.streamInserter.insertEphemeralTrack(deps.targetUserId, track);
  } catch (err) {
    console.error('song request failed: no active local stream to insert into', err);
    await fs.unlink(filePath).catch((unlinkErr) => {
      console.error(`failed to delete temp donation-song file ${filePath}`, unlinkErr);
    });
    return { ok: false, reason: 'noActiveStream', message: errorMessage(err) };
  }

  return { ok: true };
}
