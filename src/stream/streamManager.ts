import { posix as path } from 'path';
import { PlaylistQueue } from '../playlist/queue';
import { Track } from '../playlist/types';
import { StreamController } from './streamController';
import { StreamStatus } from './types';
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
import { decrypt } from '../crypto/streamKeyCipher';

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
  playlistRepository: Pick<PlaylistRepository, 'listTracks'>;
  destinationRepository: Pick<DestinationRepository, 'findById'>;
  trackRepository: Pick<TrackRepository, 'listByUser'>;
  // Optional seam for tests: SegmentFeeder opens a real fs write stream onto the
  // FIFO by default. Left undefined in production so SegmentFeeder's own default
  // (fs.createWriteStream) applies unchanged.
  createWriteStream?: (path: string) => NodeJS.WritableStream;
}

export class StreamManager {
  private readonly controllers = new Map<string, StreamController>();

  constructor(private readonly deps: StreamManagerDeps, private readonly encryptionKey: string) {}

  get(destinationId: string): StreamController | undefined {
    return this.controllers.get(destinationId);
  }

  async start(destinationId: string, playlistId: string): Promise<void> {
    if (this.controllers.has(destinationId)) {
      throw new ApiError(409, 'a stream is already active for this destination');
    }

    const destination = await this.deps.destinationRepository.findById(destinationId);
    if (!destination) throw new ApiError(404, 'destination not found');

    const tracks: Track[] = await this.deps.playlistRepository.listTracks(playlistId);
    if (tracks.length === 0) throw new ApiError(409, 'playlist is empty');

    const allUserTracksRaw = await this.deps.trackRepository.listByUser(destination.userId);
    const allUserTracks: Track[] = allUserTracksRaw.map((t) => ({ name: t.name, audioPath: t.audioPath, coverPath: t.coverPath }));

    const queue = new PlaylistQueue(tracks);
    const fifoPath = path.join(this.deps.fifoDir, `super-dj-stream-${destinationId}.fifo`);
    const rtmpUrl = destination.rtmpUrl;
    const streamKey = decrypt(destination.streamKeyEncrypted, this.encryptionKey);

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
      createRtmpPusher: () => new RtmpPusher(this.deps.spawner, { fifoPath, rtmpUrl, streamKey }),
    });

    this.controllers.set(destinationId, controller);
    try {
      await controller.start();
    } catch (err) {
      this.controllers.delete(destinationId);
      throw err;
    }
  }

  async stop(destinationId: string): Promise<void> {
    this.requireController(destinationId).stop();
    this.controllers.delete(destinationId);
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

  status(destinationId: string): StreamStatus {
    const controller = this.controllers.get(destinationId);
    if (!controller) return { state: 'idle', currentTrack: null, nextTrack: null };
    return controller.status();
  }

  private requireController(destinationId: string): StreamController {
    const controller = this.controllers.get(destinationId);
    if (!controller) throw new ApiError(409, 'stream is not active');
    return controller;
  }
}
