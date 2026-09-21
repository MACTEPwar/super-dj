import { promises as fs } from 'fs';
import * as path from 'path';

// Defense in depth for the _onFinished hook in songRequestAction.ts: catches any temp file left
// behind by a crash or an unhandled error path that skipped the direct cleanup callback.
export async function sweepStaleFiles(dir: string, maxAgeMs: number): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  const now = Date.now();
  await Promise.all(entries.map(async (name) => {
    const filePath = path.join(dir, name);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) return;
    if (now - stat.mtimeMs > maxAgeMs) {
      await fs.unlink(filePath).catch((err) => {
        console.error(`temp file cleanup sweep failed to delete ${filePath}`, err);
      });
    }
  }));
}

export function startTempFileCleanupSweep(dir: string, maxAgeMs: number, intervalMs: number): { stop: () => void } {
  const timer = setInterval(() => {
    sweepStaleFiles(dir, maxAgeMs).catch((err) => {
      console.error('temp file cleanup sweep failed', err);
    });
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
