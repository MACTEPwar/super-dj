import { Router } from 'express';
import { StreamPresetRecord, StreamPresetRepository, StreamPresetInput } from './streamPresetRepository';
import { PlaylistRepository } from '../playlists/playlistRepository';
import { TemplateRepository } from '../templates/templateRepository';
import { DestinationRepository } from '../destinations/destinationRepository';
import { ApiError } from '../errors';
import { wrapAsync } from '../api/errorHandler';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { AuthService } from '../auth/authService';

const PRIVACY_STATUSES = ['public', 'unlisted', 'private'];
const LATENCY_PREFERENCES = ['normal', 'low', 'ultraLow'];

function toPublicPreset(preset: StreamPresetRecord) {
  return {
    id: preset.id,
    name: preset.name,
    playlistId: preset.playlistId,
    templateId: preset.templateId,
    destinationIds: preset.destinationIds,
    title: preset.title,
    description: preset.description,
    privacyStatus: preset.privacyStatus,
    latencyPreference: preset.latencyPreference,
    createdAt: preset.createdAt,
  };
}

/**
 * CRUD for saved presets. Routes + repository with no manager in between, matching how every other
 * plain resource in this app is built (playlists, destinations, templates) — a preset triggers no
 * side effects at all, so there is nothing for a manager to orchestrate.
 */
export function createStreamPresetRouter(
  authService: AuthService,
  streamPresetRepository: Pick<StreamPresetRepository, 'create' | 'update' | 'findById' | 'listByUser' | 'deleteById'>,
  playlistRepository: Pick<PlaylistRepository, 'findById'>,
  templateRepository: Pick<TemplateRepository, 'findById'>,
  destinationRepository: Pick<DestinationRepository, 'findById'>,
): Router {
  const router = Router();
  const auth = requireAuth(authService);
  const userId = (req: AuthenticatedRequest) => req.user!.id;

  // Every referenced id must belong to the caller. Ids arriving in a request BODY that point at the
  // caller's own resources are validated here and answered 404/403 exactly like a path id would be
  // — a preset is a private object of the caller's, so there is no membership-leak concern of the
  // kind PUT /playlists/{id}/tracks has to 400 for.
  async function validate(body: unknown, callerId: string): Promise<StreamPresetInput> {
    const { name, playlistId, templateId, destinationIds, title, description, privacyStatus, latencyPreference } =
      (body ?? {}) as Record<string, unknown>;

    if (typeof name !== 'string' || name.trim().length === 0) throw new ApiError(400, 'body.name is required');
    if (typeof playlistId !== 'string' || playlistId.length === 0) throw new ApiError(400, 'body.playlistId is required');
    if (templateId !== undefined && templateId !== null && (typeof templateId !== 'string' || templateId.length === 0)) {
      throw new ApiError(400, 'body.templateId must be a non-empty string');
    }
    let ids: string[] = [];
    if (destinationIds !== undefined) {
      if (!Array.isArray(destinationIds) || destinationIds.some((id) => typeof id !== 'string' || id.length === 0)) {
        throw new ApiError(400, 'body.destinationIds must be an array of non-empty strings');
      }
      ids = destinationIds as string[];
      if (new Set(ids).size !== ids.length) throw new ApiError(400, 'body.destinationIds must not contain duplicates');
    }
    if (title !== undefined && title !== null && typeof title !== 'string') throw new ApiError(400, 'body.title must be a string');
    if (description !== undefined && description !== null && typeof description !== 'string') throw new ApiError(400, 'body.description must be a string');
    if (privacyStatus !== undefined && privacyStatus !== null && !PRIVACY_STATUSES.includes(privacyStatus as string)) {
      throw new ApiError(400, "body.privacyStatus must be 'public', 'unlisted', or 'private'");
    }
    if (latencyPreference !== undefined && latencyPreference !== null && !LATENCY_PREFERENCES.includes(latencyPreference as string)) {
      throw new ApiError(400, "body.latencyPreference must be 'normal', 'low', or 'ultraLow'");
    }

    const playlist = await playlistRepository.findById(playlistId);
    if (!playlist) throw new ApiError(404, 'playlist not found');
    if (playlist.userId !== callerId) throw new ApiError(403, 'not your playlist');

    if (typeof templateId === 'string') {
      const template = await templateRepository.findById(templateId);
      if (!template) throw new ApiError(404, 'template not found');
      if (template.userId !== callerId) throw new ApiError(403, 'not your template');
    }

    for (const destinationId of ids) {
      const destination = await destinationRepository.findById(destinationId);
      if (!destination) throw new ApiError(404, `destination not found: ${destinationId}`);
      if (destination.userId !== callerId) throw new ApiError(403, `not your destination: ${destinationId}`);
    }

    return {
      name: name.trim(),
      playlistId,
      templateId: typeof templateId === 'string' ? templateId : null,
      // Zero destinations is a valid preset: a local stream forwarded nowhere is a normal,
      // fully-supported way to run. The old StreamSession required a non-empty list because it only
      // existed to fan out to destinations.
      destinationIds: ids,
      title: typeof title === 'string' ? title : null,
      description: typeof description === 'string' ? description : null,
      privacyStatus: typeof privacyStatus === 'string' ? privacyStatus : null,
      latencyPreference: typeof latencyPreference === 'string' ? latencyPreference : null,
    };
  }

  async function requireOwned(id: string, callerId: string): Promise<StreamPresetRecord> {
    const preset = await streamPresetRepository.findById(id);
    if (!preset) throw new ApiError(404, 'stream preset not found');
    if (preset.userId !== callerId) throw new ApiError(403, 'not your stream preset');
    return preset;
  }

  router.post('/', auth, wrapAsync(async (req, res) => {
    const id = userId(req as AuthenticatedRequest);
    const input = await validate(req.body, id);
    res.status(200).json(toPublicPreset(await streamPresetRepository.create({ ...input, userId: id })));
  }));

  router.get('/', auth, wrapAsync(async (req, res) => {
    const presets = await streamPresetRepository.listByUser(userId(req as AuthenticatedRequest));
    res.status(200).json(presets.map(toPublicPreset));
  }));

  router.get('/:id', auth, wrapAsync(async (req, res) => {
    res.status(200).json(toPublicPreset(await requireOwned(req.params.id, userId(req as AuthenticatedRequest))));
  }));

  router.put('/:id', auth, wrapAsync(async (req, res) => {
    const id = userId(req as AuthenticatedRequest);
    const preset = await requireOwned(req.params.id, id);
    const input = await validate(req.body, id);
    res.status(200).json(toPublicPreset(await streamPresetRepository.update(preset.id, input)));
  }));

  router.delete('/:id', auth, wrapAsync(async (req, res) => {
    const preset = await requireOwned(req.params.id, userId(req as AuthenticatedRequest));
    await streamPresetRepository.deleteById(preset.id);
    res.status(200).json({});
  }));

  return router;
}
