import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Track } from '../playlist/types';
import { MediaSearchClient } from './mediaSearchClient';

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

// Fetches the requested track, inserts it as a one-off next track, and wires up its own
// deletion. Every failure path (media search failure, no active stream to insert into) is
// swallowed and logged — a donation song request has no user-facing feedback in MVP by design.
export async function executeSongRequest(deps: SongRequestDeps, query: string): Promise<void> {
  let audioBuffer: Buffer;
  try {
    audioBuffer = await deps.mediaSearchClient.fetchAudio(query);
  } catch (err) {
    console.error(`song request failed: could not fetch audio for query "${query}"`, err);
    return;
  }

  await fs.mkdir(deps.tempDir, { recursive: true });
  const filePath = path.join(deps.tempDir, `${randomUUID()}.mp3`);
  await fs.writeFile(filePath, audioBuffer);

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
    await fs.unlink(filePath).catch(() => {});
  }
}
