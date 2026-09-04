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

  constructor(private readonly deps: TemplateImageServiceDeps) {
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
  // normalizes via path.resolve and checks real containment).
  resolvePath(userId: string, templateId: string, assetId: string): string {
    const dir = this.imagesDir(userId, templateId);
    const resolvedDir = path.resolve(dir);
    const resolvedPath = path.resolve(dir, `${assetId}.png`);
    const relative = path.relative(resolvedDir, resolvedPath);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes('/')) {
      throw new InvalidAssetIdError(assetId);
    }
    return resolvedPath;
  }
}
