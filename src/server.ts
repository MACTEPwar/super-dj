import { spawn } from 'child_process';
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
import { Spawner } from './ffmpeg/types';
import { createApp } from './api/app';

const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 720;
const VIDEO_FPS = 30;
const FONT_FILE = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const PLAYLIST_WINDOW_BEFORE = 2;
const PLAYLIST_WINDOW_AFTER = 7;

export function buildServer(config: AppConfig, spawner: Spawner = spawn as unknown as Spawner) {
  const library = new Library(config.audioDir, config.defaultCoverPath);
  const queue = new PlaylistQueue([]);

  const buildOverlay = (track: Track): NowPlayingOverlay => {
    const allTracks = library.list();
    const currentIndex = allTracks.findIndex((t) => t.name === track.name);
    return {
      title: track.name,
      playlistLines: buildPlaylistWindowLines(allTracks, currentIndex, PLAYLIST_WINDOW_BEFORE, PLAYLIST_WINDOW_AFTER),
      durationSeconds: getAudioDurationSeconds(track.audioPath),
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

  const app = createApp({ streamController, library, queue });

  return { app, library, queue, streamController };
}
