import { posix as path } from 'path';
import { randomUUID } from 'crypto';
import * as fsPromises from 'fs/promises';
import { TrackRepository } from './trackRepository';
import { getAudioDurationSeconds } from '../ffmpeg/duration';

export interface UploadedFile {
  originalname: string;
  path: string;
  size: number;
}

export interface TrackSummary {
  id: string;
  name: string;
  durationSeconds: number | null;
  hasCover: boolean;
}

export interface TrackUploadServiceDeps {
  trackRepository: Pick<TrackRepository, 'create'>;
  uploadsDir: string;
  moveFile?: (from: string, to: string) => Promise<void>;
  probeDuration?: typeof getAudioDurationSeconds;
  generateId?: () => string;
}

export class TrackUploadService {
  private readonly moveFile: (from: string, to: string) => Promise<void>;
  private readonly probeDuration: typeof getAudioDurationSeconds;
  private readonly generateId: () => string;

  constructor(private readonly deps: TrackUploadServiceDeps) {
    this.moveFile = deps.moveFile ?? (async (from, to) => {
      await fsPromises.mkdir(path.dirname(to), { recursive: true });
      try {
        await fsPromises.rename(from, to);
      } catch (err) {
        // multer's tmp dir and UPLOADS_DIR can be on different filesystems/mounts
        // (e.g. distinct docker volumes) — rename(2) can't cross that, unlike copy+unlink.
        if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
          await fsPromises.copyFile(from, to);
          await fsPromises.unlink(from);
        } else {
          throw err;
        }
      }
    });
    this.probeDuration = deps.probeDuration ?? getAudioDurationSeconds;
    this.generateId = deps.generateId ?? randomUUID;
  }

  async upload(
    userId: string,
    name: string | undefined,
    audioFile: UploadedFile,
    coverFile: UploadedFile | undefined,
  ): Promise<TrackSummary> {
    const trackId = this.generateId();
    const trackDir = path.join(this.deps.uploadsDir, userId, trackId);

    const audioExt = path.extname(audioFile.originalname).toLowerCase();
    const audioPath = path.join(trackDir, `audio${audioExt}`);
    await this.moveFile(audioFile.path, audioPath);

    let coverPath: string | null = null;
    if (coverFile) {
      const coverExt = path.extname(coverFile.originalname).toLowerCase();
      coverPath = path.join(trackDir, `cover${coverExt}`);
      await this.moveFile(coverFile.path, coverPath);
    }

    const durationSeconds = await this.probeDuration(audioPath);
    const trackName = name ?? path.basename(audioFile.originalname, audioExt);

    const track = await this.deps.trackRepository.create({
      id: trackId, userId, name: trackName, audioPath, coverPath, durationSeconds,
    });

    return { id: track.id, name: track.name, durationSeconds: track.durationSeconds, hasCover: track.coverPath !== null };
  }
}
