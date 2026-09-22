// In-memory previewId -> pending-preview mapping, same discipline as MediaMtxAuthRegistry
// (src/stream/mediaMtxAuth.ts): nothing persisted to the database, register/get/delete only.
// An unconfirmed preview is a forgotten draft, not state worth surviving a process restart.
export interface TrackPreviewEntry {
  userId: string;
  // The original search text — TrackPreviewService.confirm() defaults the track's name to this
  // when the streamer clears the name field, since the temp file's own "originalname" is a
  // synthetic ${previewId}.mp3, not anything meaningful to fall back to.
  query: string;
  tempFilePath: string;
  createdAt: number;
}

export class TrackPreviewRegistry {
  private readonly previews = new Map<string, TrackPreviewEntry>();

  register(previewId: string, entry: TrackPreviewEntry): void {
    this.previews.set(previewId, entry);
  }

  get(previewId: string): TrackPreviewEntry | undefined {
    return this.previews.get(previewId);
  }

  delete(previewId: string): void {
    this.previews.delete(previewId);
  }

  // Backstop for the common abandonment paths (switching drawer tabs, closing the drawer) that
  // never call discardPreview — without this, every abandoned preview leaves a permanent entry in
  // this process-lifetime Map. Mirrors the temp-file sweep's own age-based reap, but for the
  // in-memory registry entry rather than the file on disk.
  pruneOlderThan(maxAgeMs: number, now: number = Date.now()): void {
    for (const [previewId, entry] of this.previews) {
      if (now - entry.createdAt > maxAgeMs) {
        this.previews.delete(previewId);
      }
    }
  }
}
