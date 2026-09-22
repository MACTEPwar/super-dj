import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import { posix as path } from 'path';
import { MediaSearchClient } from '../media/mediaSearchClient';
import { TrackPreviewRegistry } from './trackPreviewRegistry';
import { TrackUploadService, UploadedFile, TrackSummary } from './trackUploadService';
import { ApiError } from '../errors';

export interface TrackPreviewServiceDeps {
  mediaSearchClient: MediaSearchClient;
  registry: Pick<TrackPreviewRegistry, 'register' | 'get' | 'delete'>;
  trackUploadService: Pick<TrackUploadService, 'upload'>;
  previewTempDir: string;
  generateId?: () => string;
}

// Orchestrates the preview-before-save flow: search() fetches and holds a temp file the streamer
// can listen to; confirm() hands that SAME file to TrackUploadService.upload() unchanged (no
// second fetch — deterministic, and doesn't spend the external service's quota twice for one
// track); discard()/the age-based sweep (see tempFileCleanup.ts, started a second time for
// previewTempDir in server.ts) are the two ways an unconfirmed preview's temp file ever goes away.
export class TrackPreviewService {
  private readonly generateId: () => string;

  constructor(private readonly deps: TrackPreviewServiceDeps) {
    this.generateId = deps.generateId ?? randomUUID;
  }

  async search(userId: string, query: string): Promise<{ previewId: string }> {
    const audioBuffer = await this.deps.mediaSearchClient.fetchAudio(query);
    const previewId = this.generateId();
    const tempFilePath = path.join(this.deps.previewTempDir, `${previewId}.mp3`);

    await fs.mkdir(this.deps.previewTempDir, { recursive: true });
    await fs.writeFile(tempFilePath, audioBuffer);

    this.deps.registry.register(previewId, { userId, query, tempFilePath, createdAt: Date.now() });
    return { previewId };
  }

  async getPreviewPath(userId: string, previewId: string): Promise<string> {
    const entry = this.deps.registry.get(previewId);
    if (!entry) throw new ApiError(404, 'preview not found or expired');
    if (entry.userId !== userId) throw new ApiError(403, 'not your preview');

    try {
      await fs.access(entry.tempFilePath);
    } catch {
      // The sweep already reaped this file — drop the now-dangling registry entry too, so a
      // second request for the same id fails fast with 404 instead of re-discovering the same
      // ENOENT on every subsequent attempt.
      this.deps.registry.delete(previewId);
      throw new ApiError(404, 'preview not found or expired');
    }
    return entry.tempFilePath;
  }

  async confirm(
    userId: string,
    previewId: string,
    name: string | undefined,
    coverFile: UploadedFile | undefined,
  ): Promise<TrackSummary> {
    const tempFilePath = await this.getPreviewPath(userId, previewId);
    // getPreviewPath just ownership-checked and confirmed this entry exists — safe to read again
    // directly for its query, without repeating those checks.
    const entry = this.deps.registry.get(previewId)!;
    const stat = await fs.stat(tempFilePath);
    const audioFile: UploadedFile = { originalname: `${previewId}.mp3`, path: tempFilePath, size: stat.size };
    // Never pass an empty/undefined name through to TrackUploadService.upload() — its OWN
    // filename-based fallback would name the track after `audioFile.originalname` above, which is
    // a synthetic ${previewId}.mp3, not anything derived from what the streamer actually searched
    // for and listened to. Defaulting here, to the original query, is what makes an emptied name
    // field produce a sensible track name instead of a random UUID.
    const trackName = name && name.trim().length > 0 ? name : entry.query;

    const summary = await this.deps.trackUploadService.upload(userId, trackName, audioFile, coverFile);
    this.deps.registry.delete(previewId);
    return summary;
  }

  async discard(userId: string, previewId: string): Promise<void> {
    const entry = this.deps.registry.get(previewId);
    if (!entry) throw new ApiError(404, 'preview not found or expired');
    if (entry.userId !== userId) throw new ApiError(403, 'not your preview');

    this.deps.registry.delete(previewId);
    await fs.unlink(entry.tempFilePath).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`failed to delete discarded preview temp file ${entry.tempFilePath}`, err);
      }
    });
  }
}
