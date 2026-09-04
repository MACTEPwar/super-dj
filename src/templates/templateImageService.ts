import { posix as path } from 'path';
import { randomUUID } from 'crypto';
import * as fsPromises from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface UploadedFile {
  originalname: string;
  path: string;
  size: number;
}

export interface TemplateImageServiceDeps {
  uploadsDir: string;
  moveFile?: (from: string, to: string) => Promise<void>;
  runFfmpeg?: (originalPath: string, outPngPath: string) => Promise<void>;
  generateId?: () => string;
  readdir?: (dir: string) => Promise<string[]>;
}

// Thrown by resolvePath() when the caller-supplied assetId doesn't resolve to a plain filename
// inside the intended per-user/per-template images directory (path traversal, an embedded path
// separator, etc.). Kept as a distinct type — rather than a generic Error — so callers (route
// handlers) can translate it into the appropriate HTTP response without string-matching a message.
export class InvalidAssetIdError extends Error {
  constructor(assetId: string) {
    super(`invalid template image assetId: ${assetId}`);
    this.name = 'InvalidAssetIdError';
  }
}

export class TemplateImageService {
  private readonly moveFile: (from: string, to: string) => Promise<void>;
  private readonly runFfmpeg: (originalPath: string, outPngPath: string) => Promise<void>;
  private readonly generateId: () => string;
  private readonly readdir: (dir: string) => Promise<string[]>;

  constructor(private readonly deps: TemplateImageServiceDeps) {
    this.readdir = deps.readdir ?? ((dir) => fsPromises.readdir(dir));
    this.moveFile = deps.moveFile ?? (async (from, to) => {
      await fsPromises.mkdir(path.dirname(to), { recursive: true });
      try {
        await fsPromises.rename(from, to);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
          await fsPromises.copyFile(from, to);
          await fsPromises.unlink(from);
        } else {
          throw err;
        }
      }
    });
    // -update 1 is required so ffmpeg writes a single PNG file rather than treating the output
    // path as an image-sequence pattern (which -frames:v 1 alone does not prevent). One code
    // path handles PNG/JPEG/GIF-first-frame alike this way.
    this.runFfmpeg = deps.runFfmpeg ?? (async (originalPath, outPngPath) => {
      await execFileAsync('ffmpeg', ['-y', '-i', originalPath, '-frames:v', '1', '-update', '1', outPngPath]);
    });
    this.generateId = deps.generateId ?? randomUUID;
  }

  private imagesDir(userId: string, templateId: string): string {
    return path.join(this.deps.uploadsDir, userId, 'templates', templateId, 'images');
  }

  async upload(userId: string, templateId: string, file: UploadedFile): Promise<{ assetId: string }> {
    const assetId = this.generateId();
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    const dir = this.imagesDir(userId, templateId);
    const originalPath = path.join(dir, `${assetId}.original${ext}`);
    const pngPath = path.join(dir, `${assetId}.png`);

    await this.moveFile(file.path, originalPath);
    await this.runFfmpeg(originalPath, pngPath);

    return { assetId };
  }

  // assetId is attacker-controlled (a raw route parameter, not looked up against any server-side
  // registry of ids actually issued by upload()) — resolve it against the per-user/per-template
  // images directory and verify the result is still a direct child of that directory before ever
  // returning it, rather than trusting string content (e.g. a naive `.includes('..')` check can be
  // bypassed by encoded or absolute-path variants depending on how it's applied; this instead
  // normalizes via path.resolve and checks real containment). Shared by resolvePath() and
  // resolveOriginalPath() below — an assetId unsafe for one filename in this directory is unsafe
  // for any other filename in it too.
  private assertSafeAssetId(dir: string, assetId: string): void {
    const resolvedDir = path.resolve(dir);
    const resolvedPath = path.resolve(dir, assetId);
    const relative = path.relative(resolvedDir, resolvedPath);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes('/')) {
      throw new InvalidAssetIdError(assetId);
    }
  }

  resolvePath(userId: string, templateId: string, assetId: string): string {
    const dir = this.imagesDir(userId, templateId);
    this.assertSafeAssetId(dir, assetId);
    return path.resolve(dir, `${assetId}.png`);
  }

  // upload() keeps the untouched original (whatever its extension) alongside the flattened .png
  // resolvePath() always points at — needed to probe/play a multi-frame (animated) original with
  // ffmpeg directly, since the .png has already been flattened to a single frame. The extension
  // isn't known ahead of time, so this lists the directory rather than guessing it. Returns null
  // (not a throw) for "no original found" — an asset uploaded before this method existed, or a
  // missing images directory — so a caller can fall back to treating the image as static rather
  // than failing outright.
  async resolveOriginalPath(userId: string, templateId: string, assetId: string): Promise<string | null> {
    const dir = this.imagesDir(userId, templateId);
    this.assertSafeAssetId(dir, assetId);
    const resolvedDir = path.resolve(dir);
    let entries: string[];
    try {
      entries = await this.readdir(resolvedDir);
    } catch {
      return null;
    }
    const match = entries.find((name) => name.startsWith(`${assetId}.original.`));
    return match ? path.join(resolvedDir, match) : null;
  }
}
