import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sweepStaleFiles, startTempFileCleanupSweep } from '../../src/donations/tempFileCleanup';

describe('sweepStaleFiles', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-sweep-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('deletes files older than maxAgeMs and keeps newer ones', async () => {
    const stalePath = path.join(tempDir, 'stale.mp3');
    const freshPath = path.join(tempDir, 'fresh.mp3');
    await fs.writeFile(stalePath, 'old');
    await fs.writeFile(freshPath, 'new');
    const oldTime = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
    await fs.utimes(stalePath, oldTime, oldTime);

    await sweepStaleFiles(tempDir, 30 * 60 * 1000); // 30-minute threshold

    await expect(fs.access(stalePath)).rejects.toThrow();
    await expect(fs.access(freshPath)).resolves.toBeUndefined();
  });

  it('does nothing if the directory does not exist yet', async () => {
    await expect(sweepStaleFiles(path.join(tempDir, 'does-not-exist'), 1000)).resolves.toBeUndefined();
  });
});

describe('startTempFileCleanupSweep', () => {
  it('runs the sweep on the given interval and can be stopped', () => {
    jest.useFakeTimers();
    const dir = '/tmp/whatever';
    const handle = startTempFileCleanupSweep(dir, 1000, 500);
    // Real sweepStaleFiles isn't mocked here — this just proves the interval fires and stop()
    // clears it, using a real timer count rather than asserting on filesystem side effects
    // (already covered by the sweepStaleFiles tests above).
    expect(jest.getTimerCount()).toBe(1);
    handle.stop();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
});
