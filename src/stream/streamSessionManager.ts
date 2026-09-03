import { StreamManager } from './streamManager';
import { StreamSessionRepository, StreamSessionRecord } from './streamSessionRepository';
import { SessionOverlayCache } from './sessionOverlayCache';
import { DestinationRepository } from '../destinations/destinationRepository';
import { PlaylistRepository } from '../playlists/playlistRepository';
import { TemplateRepository } from '../templates/templateRepository';
import { BroadcastMeta } from '../destinations/streamDestinationProvider';
import { DestinationStreamStatus } from './types';
import { ApiError } from '../errors';

export interface StreamSessionDestinationStatus {
  destinationId: string;
  status: DestinationStreamStatus;
  error?: string;
}

export interface StreamSessionStatus {
  id: string;
  playlistId: string;
  templateId: string | null;
  destinations: StreamSessionDestinationStatus[];
}

export interface StreamSessionManagerDeps {
  streamManager: Pick<StreamManager, 'start' | 'stop' | 'pause' | 'resume' | 'next' | 'previous' | 'status'>;
  streamSessionRepository: Pick<StreamSessionRepository, 'create' | 'findById' | 'listByUser' | 'deleteById'>;
  destinationRepository: Pick<DestinationRepository, 'findById'>;
  playlistRepository: Pick<PlaylistRepository, 'findById'>;
  templateRepository: Pick<TemplateRepository, 'findById'>;
}

// Thin fan-out orchestrator over the existing, already-independent per-destination
// StreamManager/StreamController pipeline — deliberately does not touch it. A
// StreamSession is just "which destinations belong together"; each destination keeps
// its own ffmpeg process, FIFO, and state machine exactly as it does for a
// single-destination stream, so one destination failing to start (e.g. a YouTube API
// hiccup) never blocks the others from going live.
export class StreamSessionManager {
  constructor(private readonly deps: StreamSessionManagerDeps) {}

  async create(
    userId: string,
    playlistId: string,
    templateId: string | undefined,
    destinationIds: string[],
    meta?: Partial<BroadcastMeta>,
  ): Promise<StreamSessionStatus> {
    if (!Array.isArray(destinationIds) || destinationIds.length === 0) {
      throw new ApiError(400, 'body.destinationIds must be a non-empty array');
    }
    const uniqueIds = [...new Set(destinationIds)];
    if (uniqueIds.length !== destinationIds.length) {
      throw new ApiError(400, 'body.destinationIds must not contain duplicates');
    }

    const playlist = await this.deps.playlistRepository.findById(playlistId);
    if (!playlist) throw new ApiError(404, 'playlist not found');
    if (playlist.userId !== userId) throw new ApiError(403, 'not your playlist');

    if (templateId !== undefined) {
      const template = await this.deps.templateRepository.findById(templateId);
      if (!template) throw new ApiError(404, 'template not found');
      if (template.userId !== userId) throw new ApiError(403, 'not your template');
    }

    for (const destinationId of uniqueIds) {
      const destination = await this.deps.destinationRepository.findById(destinationId);
      if (!destination) throw new ApiError(404, `destination not found: ${destinationId}`);
      if (destination.userId !== userId) throw new ApiError(403, `not your destination: ${destinationId}`);
    }

    const session = await this.deps.streamSessionRepository.create({
      userId,
      playlistId,
      templateId: templateId ?? null,
      destinationIds: uniqueIds,
      title: meta?.title ?? null,
      description: meta?.description ?? null,
      privacyStatus: meta?.privacyStatus ?? null,
    });

    // Shared by every destination in this session — see SessionOverlayCache's own doc for why
    // this is safe even when destinations drift onto different tracks.
    const overlayCache = new SessionOverlayCache();
    const destinations = await this.fanOut(session, (destinationId) =>
      this.deps.streamManager.start(destinationId, playlistId, meta, { templateId, overlayCache, sessionId: session.id }));
    return { id: session.id, playlistId: session.playlistId, templateId: session.templateId, destinations };
  }

  async status(userId: string, sessionId: string): Promise<StreamSessionStatus> {
    const session = await this.requireOwnedSession(sessionId, userId);
    return {
      id: session.id,
      playlistId: session.playlistId,
      templateId: session.templateId,
      destinations: session.destinationIds.map((destinationId) => ({
        destinationId,
        status: this.deps.streamManager.status(destinationId),
      })),
    };
  }

  async list(userId: string): Promise<StreamSessionStatus[]> {
    const sessions = await this.deps.streamSessionRepository.listByUser(userId);
    return sessions.map((session) => ({
      id: session.id,
      playlistId: session.playlistId,
      templateId: session.templateId,
      destinations: session.destinationIds.map((destinationId) => ({
        destinationId,
        status: this.deps.streamManager.status(destinationId),
      })),
    }));
  }

  async pause(userId: string, sessionId: string): Promise<StreamSessionStatus> {
    const session = await this.requireOwnedSession(sessionId, userId);
    const destinations = await this.fanOut(session, (destinationId) => this.deps.streamManager.pause(destinationId));
    return { id: session.id, playlistId: session.playlistId, templateId: session.templateId, destinations };
  }

  async resume(userId: string, sessionId: string): Promise<StreamSessionStatus> {
    const session = await this.requireOwnedSession(sessionId, userId);
    const destinations = await this.fanOut(session, (destinationId) => this.deps.streamManager.resume(destinationId));
    return { id: session.id, playlistId: session.playlistId, templateId: session.templateId, destinations };
  }

  async next(userId: string, sessionId: string): Promise<StreamSessionStatus> {
    const session = await this.requireOwnedSession(sessionId, userId);
    const destinations = await this.fanOut(session, (destinationId) => this.deps.streamManager.next(destinationId));
    return { id: session.id, playlistId: session.playlistId, templateId: session.templateId, destinations };
  }

  async previous(userId: string, sessionId: string): Promise<StreamSessionStatus> {
    const session = await this.requireOwnedSession(sessionId, userId);
    const destinations = await this.fanOut(session, (destinationId) => this.deps.streamManager.previous(destinationId));
    return { id: session.id, playlistId: session.playlistId, templateId: session.templateId, destinations };
  }

  async stop(userId: string, sessionId: string): Promise<StreamSessionStatus> {
    const session = await this.requireOwnedSession(sessionId, userId);
    const destinations = await this.fanOut(session, (destinationId) => this.deps.streamManager.stop(destinationId));
    return { id: session.id, playlistId: session.playlistId, templateId: session.templateId, destinations };
  }

  async deleteById(userId: string, sessionId: string): Promise<void> {
    const session = await this.requireOwnedSession(sessionId, userId);
    await Promise.all(session.destinationIds.map(async (destinationId) => {
      try {
        await this.deps.streamManager.stop(destinationId);
      } catch (err) {
        // 409 just means "wasn't active" — every other error should still surface.
        if (!(err instanceof ApiError && err.status === 409)) throw err;
      }
    }));
    await this.deps.streamSessionRepository.deleteById(session.id);
  }

  private async requireOwnedSession(sessionId: string, userId: string): Promise<StreamSessionRecord> {
    const session = await this.deps.streamSessionRepository.findById(sessionId);
    if (!session) throw new ApiError(404, 'stream session not found');
    if (session.userId !== userId) throw new ApiError(403, 'not your stream session');
    return session;
  }

  // Runs `command` against every destination in the session independently — one
  // destination throwing (e.g. "stream is not active" from a command that arrived after
  // that destination already errored out on its own) must not stop the others' commands
  // from running or from being reported. Each result always carries this destination's
  // current status; `error` is set only when its own command call failed.
  private async fanOut(
    session: StreamSessionRecord,
    command: (destinationId: string) => Promise<void> | void,
  ): Promise<StreamSessionDestinationStatus[]> {
    return Promise.all(session.destinationIds.map(async (destinationId) => {
      try {
        await command(destinationId);
        return { destinationId, status: this.deps.streamManager.status(destinationId) };
      } catch (err) {
        return {
          destinationId,
          status: this.deps.streamManager.status(destinationId),
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }));
  }
}
