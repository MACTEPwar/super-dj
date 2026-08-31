import { spawn } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { AppConfig } from './config/env';
import { Library } from './playlist/library';
import { PlaylistQueue } from './playlist/queue';
import { Track } from './playlist/types';
import { StreamController } from './stream/streamController';
import { SegmentFeeder } from './ffmpeg/segmentFeeder';
import { RtmpPusher } from './ffmpeg/rtmpPusher';
import { NowPlayingOverlay } from './ffmpeg/segmentArgs';
import { createFifo, removeFifo } from './ffmpeg/fifo';
import { getAudioDurationSeconds } from './ffmpeg/duration';
import { buildPlaylistWindowLines } from './ffmpeg/overlayText';
import { Spawner, ChildProcessLike } from './ffmpeg/types';
import { UserRepository } from './auth/userRepository';
import { SessionRepository } from './auth/sessionRepository';
import { AuthService } from './auth/authService';
import { createApp } from './api/app';

const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 720;
const VIDEO_FPS = 30;
const FONT_FILE = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const PLAYLIST_WINDOW_BEFORE = 2;
const PLAYLIST_WINDOW_AFTER = 7;

/**
 * Wraps child_process.spawn so every spawned ffmpeg has its stderr drained.
 * ffmpeg writes a banner plus continuous progress to stderr; if nothing reads
 * it the OS pipe buffer (~64KB) fills and ffmpeg blocks on write, stalling the
 * whole pipeline. Forwarding it to our own stderr also surfaces ffmpeg errors
 * in the container logs.
 */
export function createSpawner(): Spawner {
  return (command: string, args: string[]): ChildProcessLike => {
    const child = spawn(command, args);
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    return child as unknown as ChildProcessLike;
  };
}

export function buildServer(config: AppConfig, spawner: Spawner = createSpawner()) {
  const library = new Library(config.audioDir, config.defaultCoverPath);
  const queue = new PlaylistQueue([]);

  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  const userRepository = new UserRepository(prisma);
  const sessionRepository = new SessionRepository(prisma);
  const authService = new AuthService({ userRepository, sessionRepository, sessionTtlDays: config.sessionTtlDays });

  const buildOverlay = async (track: Track): Promise<NowPlayingOverlay> => {
    const allTracks = library.list();
    const currentIndex = allTracks.findIndex((t) => t.name === track.name);
    return {
      title: track.name,
      playlistLines: buildPlaylistWindowLines(allTracks, currentIndex, PLAYLIST_WINDOW_BEFORE, PLAYLIST_WINDOW_AFTER),
      durationSeconds: await getAudioDurationSeconds(track.audioPath),
    };
  };

  const streamController = new StreamController({
    library,
    queue,
    fifoPath: config.fifoPath,
    createFifo,
    removeFifo,
    buildOverlay,
    createSegmentFeeder: () => new SegmentFeeder({
      spawner,
      fifoPath: config.fifoPath,
      defaultCoverPath: config.defaultCoverPath,
      backgroundPath: config.backgroundImagePath,
      fontFile: FONT_FILE,
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      fps: VIDEO_FPS,
    }),
    createRtmpPusher: () => new RtmpPusher(spawner, {
      fifoPath: config.fifoPath,
      rtmpUrl: config.rtmpUrl,
      streamKey: config.streamKey,
    }),
  });

  const app = createApp({ streamController, library, queue, authService });

  return { app, library, queue, streamController, prisma };
}
