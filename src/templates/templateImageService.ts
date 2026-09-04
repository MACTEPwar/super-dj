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

  resolvePath(userId: string, templateId: string, assetId: string): string {
    return path.join(this.imagesDir(userId, templateId), `${assetId}.png`);
  }
}
