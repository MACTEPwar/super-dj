export interface SessionOverlayCacheKey {
  sessionId: string;
  trackName: string;
  templateId: string | null;
}

// Avoids redundant renders when several destinations in the same StreamSession are showing the
// identical track+template at once (the common case) — but never forces sharing: a destination
// that has drifted onto a different track (StreamSessionManager's next/previous fan-out is
// best-effort per destination, not atomic — see its class doc) always renders its own, correct
// picture instead of inheriting another destination's, because the cache key includes the track.
//
// Only successful renders are cached, and concurrent callers for the same not-yet-resolved key
// share the same in-flight render rather than each starting their own. A failed render is never
// cached — a transient blip on one destination must not poison every other destination sharing
// this session for the cache's whole lifetime.
export class SessionOverlayCache {
  private entries = new Map<string, { promise: Promise<Buffer>; expiresAt: number | null }>();

  constructor(private readonly ttlMs = 30000) {}

  private key(k: SessionOverlayCacheKey): string {
    return `${k.sessionId}::${k.trackName}::${k.templateId ?? ''}`;
  }

  getOrRender(key: SessionOverlayCacheKey, render: () => Promise<Buffer>): Promise<Buffer> {
    const k = this.key(key);
    const now = Date.now();
    const existing = this.entries.get(k);
    if (existing && (existing.expiresAt === null || existing.expiresAt > now)) {
      return existing.promise;
    }

    const promise = render();
    // expiresAt: null marks "in flight" — a concurrent second caller for the same key awaits
    // this same promise instead of starting its own render. It's only stamped with a real TTL
    // once the render actually resolves.
    this.entries.set(k, { promise, expiresAt: null });
    promise.then(
      () => {
        const entry = this.entries.get(k);
        if (entry && entry.promise === promise) entry.expiresAt = now + this.ttlMs;
      },
      () => {
        const entry = this.entries.get(k);
        if (entry && entry.promise === promise) this.entries.delete(k);
      },
    );
    this.prune(now);
    return promise;
  }

  private prune(now: number): void {
    for (const [k, v] of this.entries) {
      if (v.expiresAt !== null && v.expiresAt <= now) this.entries.delete(k);
    }
  }
}
