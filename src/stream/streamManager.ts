import { posix as path } from 'path';
import { EventEmitter } from 'events';
import { PlaylistQueue } from '../playlist/queue';
import { Track } from '../playlist/types';
import { StreamController } from './streamController';
import { DestinationStreamStatus, StreamStatus } from './types';
import { SegmentFeeder } from '../ffmpeg/segmentFeeder';
import { RtmpPusher } from '../ffmpeg/rtmpPusher';
import { NowPlayingOverlay } from '../ffmpeg/segmentArgs';
import { createFifo, removeFifo } from '../ffmpeg/fifo';
import { getAudioDurationSeconds } from '../ffmpeg/duration';
import { buildPlaylistWindowLines } from '../ffmpeg/overlayText';
import { Spawner } from '../ffmpeg/types';
import { ApiError } from '../errors';
import { PlaylistRepository } from '../playlists/playlistRepository';
import { DestinationRepository } from '../destinations/destinationRepository';
import { TrackRepository } from '../tracks/trackRepository';
import { BroadcastMeta, DestinationLifecycle, StreamDestinationProvider } from '../destinations/streamDestinationProvider';

// Also declared (as '1280x720'/'30fps'-shaped strings) in src/destinations/youtubeApiClient.ts's
// createStream — keep both in sync if this ever changes.
const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 720;
const VIDEO_FPS = 30;
const PLAYLIST_WINDOW_BEFORE = 2;
const PLAYLIST_WINDOW_AFTER = 7;

export interface StreamManagerDeps {
  spawner: Spawner;
  fifoDir: string;
  defaultCoverPath: string;
  backgroundImagePath: string;
  fontFile: string;
  playlistRepository: Pick<PlaylistRepository, 'listTracks' | 'findById'>;
  destinationRepository: Pick<DestinationRepository, 'findById'>;
  trackRepository: Pick<TrackRepository, 'listByUser'>;
  providers: Record<string, StreamDestinationProvider>;
  // Optional seam for tests: SegmentFeeder opens a real fs write stream onto the
  // FIFO by default. Left undefined in production so SegmentFeeder's own default
  // (fs.createWriteStream) applies unchanged.
  createWriteStream?: (path: string) => NodeJS.WritableStream;
}

export class StreamManager extends EventEmitter {
  private readonly controllers = new Map<string, StreamController>();
  private readonly lifecycles = new Map<string, { providerType: string; lifecycle: DestinationLifecycle }>();
  private readonly starting = new Set<string>();

  constructor(private readonly deps: StreamManagerDeps) {
    super();
  }

  get(destinationId: string): StreamController | undefined {
    return this.controllers.get(destinationId);
  }

  async start(destinationId: string, playlistId: string, meta?: Partial<BroadcastMeta>): Promise<void> {
    // Synchronous, id-keyed re-entrancy guard: two overlapping start() calls for the same
    // destination must not both pass the (also synchronous) "already active" check below
    // before either has registered a controller — that race would leak the loser's
    // StreamController (orphaned ffmpeg pusher) and DestinationLifecycle (e.g. a live YouTube
    // broadcast with no finalize ever called). Reject the second call before ANY async work.
    if (this.starting.has(destinationId)) {
      throw new ApiError(409, 'a stream is already starting for this destination');
    }
    // A controller left behind in 'error' state (unexpected pusher exit) must not
    // block a restart — only a live streaming/paused session is "already active".
    const existing = this.controllers.get(destinationId);
    if (existing) {
      const state = existing.status().state;
      if (state === 'streaming' || state === 'paused') {
        throw new ApiError(409, 'a stream is already active for this destination');
      }
      this.controllers.delete(destinationId);
      // A stale entry here means an earlier session's lifecycle (e.g. a YouTube broadcast/
      // stream) was never finalized — the pusher died before StreamManager got a chance to,
      // or the destination is being restarted before that session's own cleanup ran. Finalize
      // it now so restarting a destination never silently orphans a YouTube broadcast.
      const staleEntry = this.lifecycles.get(destinationId);
      this.lifecycles.delete(destinationId);
      if (staleEntry) {
        staleEntry.lifecycle.finalize().catch((err) => {
          console.error('failed to finalize a stale destination lifecycle before restart', err);
        });
      }
    }

    this.starting.add(destinationId);
    try {
      const destination = await this.deps.destinationRepository.findById(destinationId);
      if (!destination) throw new ApiError(404, 'destination not found');

      // The playlist must belong to the same user who owns the destination, otherwise
      // any user owning a destination could stream another user's private playlist.
      const playlist = await this.deps.playlistRepository.findById(playlistId);
      if (!playlist) throw new ApiError(404, 'playlist not found');
      if (playlist.userId !== destination.userId) throw new ApiError(403, 'not your playlist');

      const tracks: Track[] = await this.deps.playlistRepository.listTracks(playlistId);
      if (tracks.length === 0) throw new ApiError(409, 'playlist is empty');

      const allUserTracksRaw = await this.deps.trackRepository.listByUser(destination.userId);
      const allUserTracks: Track[] = allUserTracksRaw.map((t) => ({ name: t.name, audioPath: t.audioPath, coverPath: t.coverPath }));

      const provider = this.deps.providers[destination.provider];
      if (!provider) throw new ApiError(400, `unsupported destination provider: ${destination.provider}`);
      const resolvedMeta: BroadcastMeta = {
        title: meta?.title ?? playlist.name,
        description: meta?.description,
        privacyStatus: meta?.privacyStatus,
      };
      const session = await provider.prepareSession(destination, resolvedMeta);

      const queue = new PlaylistQueue(tracks);
      const fifoPath = path.join(this.deps.fifoDir, `super-dj-stream-${destinationId}.fifo`);

      const buildOverlay = async (track: Track): Promise<NowPlayingOverlay> => {
        const currentIndex = tracks.findIndex((t) => t.name === track.name);
        return {
          title: track.name,
          playlistLines: buildPlaylistWindowLines(tracks, currentIndex, PLAYLIST_WINDOW_BEFORE, PLAYLIST_WINDOW_AFTER),
          durationSeconds: await getAudioDurationSeconds(track.audioPath),
        };
      };

      const controller = new StreamController({
        library: {
          list: () => tracks,
          findByName: (name: string) => allUserTracks.find((t) => t.name === name),
        },
        queue,
        fifoPath,
        createFifo,
        removeFifo,
        buildOverlay,
        createSegmentFeeder: () => new SegmentFeeder({
          spawner: this.deps.spawner,
          fifoPath,
          defaultCoverPath: this.deps.defaultCoverPath,
          backgroundPath: this.deps.backgroundImagePath,
          fontFile: this.deps.fontFile,
          width: VIDEO_WIDTH,
          height: VIDEO_HEIGHT,
          fps: VIDEO_FPS,
          createWriteStream: this.deps.createWriteStream,
        }),
        createRtmpPusher: () => new RtmpPusher(this.deps.spawner, { fifoPath, rtmpUrl: session.rtmpUrl, streamKey: session.streamKey }),
        onError: () => {
          const entry = this.lifecycles.get(destinationId);
          this.lifecycles.delete(destinationId);
          entry?.lifecycle.finalize().catch((err) => {
            console.error('failed to finalize destination lifecycle after an unexpected pusher exit', err);
          });
        },
        onStatusChanged: () => {
          this.emit('statusChanged', destinationId);
        },
      });

      this.controllers.set(destinationId, controller);
      try {
        await controller.start();
      } catch (err) {
        this.controllers.delete(destinationId);
        if (session.lifecycle) {
          await session.lifecycle.finalize().catch((finalizeErr) => {
            console.error('failed to finalize destination lifecycle after a failed start()', finalizeErr);
          });
        }
        throw err;
      }

      if (session.lifecycle) {
        this.lifecycles.set(destinationId, { providerType: destination.provider, lifecycle: session.lifecycle });
        session.lifecycle.onPhaseChange?.(() => { this.emit('statusChanged', destinationId); });
        session.lifecycle.onPushStarted();
      }
    } finally {
      this.starting.delete(destinationId);
    }
  }

  async stop(destinationId: string): Promise<void> {
    this.requireController(destinationId).stop();
    this.controllers.delete(destinationId);
    const entry = this.lifecycles.get(destinationId);
    this.lifecycles.delete(destinationId);
    if (entry) {
      await entry.lifecycle.finalize().catch((err) => {
        console.error('failed to finalize destination lifecycle on stop', err);
      });
    }
  }

  pause(destinationId: string): void {
    this.requireController(destinationId).pause();
  }

  async resume(destinationId: string): Promise<void> {
    return this.requireController(destinationId).resume();
  }

  async next(destinationId: string): Promise<void> {
    return this.requireController(destinationId).next();
  }

  async previous(destinationId: string): Promise<void> {
    return this.requireController(destinationId).previous();
  }

  playByName(destinationId: string, name: string): void {
    this.requireController(destinationId).playByName(name);
  }

  status(destinationId: string): DestinationStreamStatus {
    const controller = this.controllers.get(destinationId);
    const base: StreamStatus = controller ? controller.status() : { state: 'idle', currentTrack: null, nextTrack: null };
    const entry = this.lifecycles.get(destinationId);
    if (!entry) return base;
    return {
      ...base,
      provider: { type: entry.providerType, phase: entry.lifecycle.phase(), watchUrl: entry.lifecycle.watchUrl() },
    };
  }

  private requireController(destinationId: string): StreamController {
    const controller = this.controllers.get(destinationId);
    if (!controller) throw new ApiError(409, 'stream is not active');
    return controller;
  }
}
