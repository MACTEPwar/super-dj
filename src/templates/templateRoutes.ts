import { Router } from 'express';
import multer from 'multer';
import * as os from 'os';
import { TemplateRepository } from './templateRepository';
import { isValidTemplateElements, TemplateElement, CANVAS_WIDTH, CANVAS_HEIGHT } from './templateTypes';
import { TemplateImageService } from './templateImageService';
import { TrackRepository } from '../tracks/trackRepository';
import { renderTemplatePng } from '../render/renderOverlay';
import { ApiError } from '../errors';
import { wrapAsync } from '../api/errorHandler';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { AuthService } from '../auth/authService';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: MAX_IMAGE_BYTES } });
const ALLOWED_IMAGE_MIMETYPES = ['image/png', 'image/jpeg', 'image/gif'];

function toPublicTemplate(t: { id: string; name: string; elements: unknown; createdAt: Date; updatedAt: Date }) {
  return { id: t.id, name: t.name, elements: t.elements, createdAt: t.createdAt, updatedAt: t.updatedAt };
}

export interface TemplateRendererDeps {
  fontPath: string;
  fontFamily: string;
  defaultCoverPath: string;
}

export function createTemplateRouter(
  authService: AuthService,
  templateRepository: TemplateRepository,
  trackRepository: Pick<TrackRepository, 'findById'>,
  rendererDeps: TemplateRendererDeps,
  templateImageService: TemplateImageService,
): Router {
  const router = Router();
  const auth = requireAuth(authService);
  const userId = (req: AuthenticatedRequest) => req.user!.id;

  async function requireOwnedTemplate(id: string, ownerId: string) {
    const template = await templateRepository.findById(id);
    if (!template) throw new ApiError(404, 'template not found');
    if (template.userId !== ownerId) throw new ApiError(403, 'not your template');
    return template;
  }

  router.post('/', auth, wrapAsync(async (req, res) => {
    const { name, elements } = req.body ?? {};
    if (typeof name !== 'string' || name.length === 0) throw new ApiError(400, 'body.name is required');
    if (!isValidTemplateElements(elements)) throw new ApiError(400, 'body.elements must be an array of valid template elements');

    const template = await templateRepository.create({ userId: userId(req as AuthenticatedRequest), name, elements });
    res.status(200).json(toPublicTemplate(template));
  }));

  router.get('/', auth, wrapAsync(async (req, res) => {
    const templates = await templateRepository.listByUser(userId(req as AuthenticatedRequest));
    res.status(200).json(templates.map(toPublicTemplate));
  }));

  router.get('/:id', auth, wrapAsync(async (req, res) => {
    const template = await requireOwnedTemplate(req.params.id, userId(req as AuthenticatedRequest));
    res.status(200).json(toPublicTemplate(template));
  }));

  router.put('/:id', auth, wrapAsync(async (req, res) => {
    await requireOwnedTemplate(req.params.id, userId(req as AuthenticatedRequest));
    const { name, elements } = req.body ?? {};
    if (name !== undefined && (typeof name !== 'string' || name.length === 0)) throw new ApiError(400, 'body.name must be a non-empty string');
    if (elements !== undefined && !isValidTemplateElements(elements)) throw new ApiError(400, 'body.elements must be an array of valid template elements');
    const updated = await templateRepository.update(req.params.id, { name, elements });
    res.status(200).json(toPublicTemplate(updated));
  }));

  router.delete('/:id', auth, wrapAsync(async (req, res) => {
    const template = await requireOwnedTemplate(req.params.id, userId(req as AuthenticatedRequest));
    await templateRepository.deleteById(template.id);
    res.status(200).json({});
  }));

  // Renders the template (either the saved one, or a draft passed in the body — so the editor
  // can preview unsaved changes) against sample scene data and returns the PNG directly, so the
  // frontend can point an <img> straight at this endpoint. Unlike the live stream pipeline
  // (StreamManager.buildOverlay), a render failure here is NOT caught — it propagates as a real
  // HTTP error, because this is an interactive request from someone testing a template layout,
  // who needs to see that something broke rather than a silently blank picture.
  router.post('/:id/preview', auth, wrapAsync(async (req, res) => {
    const owner = userId(req as AuthenticatedRequest);
    const template = await requireOwnedTemplate(req.params.id, owner);
    const { elements, title, playlistLines, trackId } = req.body ?? {};

    let previewElements: TemplateElement[] = template.elements as unknown as TemplateElement[];
    if (elements !== undefined) {
      if (!isValidTemplateElements(elements)) throw new ApiError(400, 'body.elements must be an array of valid template elements');
      previewElements = elements;
    }
    if (title !== undefined && typeof title !== 'string') throw new ApiError(400, 'body.title must be a string');
    if (playlistLines !== undefined && (!Array.isArray(playlistLines) || playlistLines.some((l: unknown) => typeof l !== 'string'))) {
      throw new ApiError(400, 'body.playlistLines must be an array of strings');
    }

    let coverPath = rendererDeps.defaultCoverPath;
    if (trackId !== undefined) {
      if (typeof trackId !== 'string') throw new ApiError(400, 'body.trackId must be a string');
      const track = await trackRepository.findById(trackId);
      if (!track) throw new ApiError(404, 'track not found');
      if (track.userId !== owner) throw new ApiError(403, 'not your track');
      coverPath = track.coverPath ?? rendererDeps.defaultCoverPath;
    }

    const png = await renderTemplatePng({
      elements: previewElements,
      title: title ?? 'Sample Track',
      playlistLines: playlistLines ?? ['▶ Sample Track', '  Next Track'],
      coverPath,
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      fontPath: rendererDeps.fontPath,
      fontFamily: rendererDeps.fontFamily,
    });

    res.status(200).contentType('image/png').send(png);
  }));

  router.post('/:id/images', auth, upload.single('image'), wrapAsync(async (req, res) => {
    const owner = userId(req as AuthenticatedRequest);
    const template = await requireOwnedTemplate(req.params.id, owner);
    if (!req.file) throw new ApiError(400, 'image file is required');
    if (!ALLOWED_IMAGE_MIMETYPES.includes(req.file.mimetype)) throw new ApiError(400, 'unsupported image type');
    const result = await templateImageService.upload(owner, template.id, {
      originalname: req.file.originalname, path: req.file.path, size: req.file.size,
    });
    res.status(200).json(result);
  }));

  router.get('/:id/images/:assetId', auth, wrapAsync(async (req, res) => {
    const owner = userId(req as AuthenticatedRequest);
    const template = await requireOwnedTemplate(req.params.id, owner);
    const filePath = templateImageService.resolvePath(owner, template.id, req.params.assetId);
    res.sendFile(filePath);
  }));

  return router;
}
