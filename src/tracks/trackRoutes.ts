import { Router } from 'express';
import multer from 'multer';
import * as os from 'os';
import { posix as path } from 'path';
import { TrackUploadService } from './trackUploadService';
import { TrackRepository } from './trackRepository';
import { ApiError } from '../errors';
import { wrapAsync } from '../api/errorHandler';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { AuthService } from '../auth/authService';

const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.flac', '.m4a'];
const COVER_EXTENSIONS = ['.jpg', '.jpeg', '.png'];
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_COVER_BYTES = 10 * 1024 * 1024;

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: MAX_AUDIO_BYTES } });

// busboy (multer's multipart parser) decodes the `filename` header value as latin1 by
// default, per the multipart spec's historical default — but browsers send raw UTF-8
// bytes there with no RFC 5987 encoding, so a non-ASCII filename comes out mojibake'd
// unless we redecode it as UTF-8 here.
function fixMulterFilenameEncoding(originalname: string): string {
  return Buffer.from(originalname, 'latin1').toString('utf8');
}

function toSummary(track: { id: string; name: string; durationSeconds: number | null; coverPath: string | null }) {
  return { id: track.id, name: track.name, durationSeconds: track.durationSeconds, hasCover: track.coverPath !== null };
}

export function createTrackRouter(
  authService: AuthService,
  uploadService: TrackUploadService,
  trackRepository: TrackRepository,
): Router {
  const router = Router();
  const auth = requireAuth(authService);

  router.post('/', auth, upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'cover', maxCount: 1 }]), wrapAsync(async (req, res) => {
    const files = req.files as { audio?: Express.Multer.File[]; cover?: Express.Multer.File[] } | undefined;
    const audioFile = files?.audio?.[0];
    if (!audioFile) throw new ApiError(400, 'audio file is required');
    audioFile.originalname = fixMulterFilenameEncoding(audioFile.originalname);
    if (!AUDIO_EXTENSIONS.includes(path.extname(audioFile.originalname).toLowerCase())) {
      throw new ApiError(400, 'unsupported audio format');
    }

    const coverFile = files?.cover?.[0];
    if (coverFile) {
      coverFile.originalname = fixMulterFilenameEncoding(coverFile.originalname);
      if (!COVER_EXTENSIONS.includes(path.extname(coverFile.originalname).toLowerCase())) {
        throw new ApiError(400, 'unsupported cover format');
      }
      if (coverFile.size > MAX_COVER_BYTES) throw new ApiError(400, 'cover file too large');
    }

    const name = typeof req.body?.name === 'string' && req.body.name.length > 0 ? req.body.name : undefined;
    const userId = (req as AuthenticatedRequest).user!.id;
    const summary = await uploadService.upload(userId, name, audioFile, coverFile);
    res.status(200).json(summary);
  }));

  router.get('/', auth, wrapAsync(async (req, res) => {
    const tracks = await trackRepository.listByUser((req as AuthenticatedRequest).user!.id);
    res.status(200).json(tracks.map(toSummary));
  }));

  router.get('/:id/cover', auth, wrapAsync(async (req, res) => {
    const track = await trackRepository.findById(req.params.id);
    if (!track) throw new ApiError(404, 'track not found');
    if (track.userId !== (req as AuthenticatedRequest).user!.id) throw new ApiError(403, 'not your track');
    if (!track.coverPath) throw new ApiError(404, 'track has no cover');
    res.sendFile(track.coverPath);
  }));

  router.delete('/:id', auth, wrapAsync(async (req, res) => {
    const track = await trackRepository.findById(req.params.id);
    if (!track) throw new ApiError(404, 'track not found');
    if (track.userId !== (req as AuthenticatedRequest).user!.id) throw new ApiError(403, 'not your track');
    await trackRepository.deleteById(track.id);
    res.status(200).json({});
  }));

  return router;
}
