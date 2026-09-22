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
}
