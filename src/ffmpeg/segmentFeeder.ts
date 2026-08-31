import * as fs from 'fs';
import { Track } from '../playlist/types';
import { Spawner, ChildProcessLike, VideoParams } from './types';
import { buildTrackSegmentArgs, buildPauseSegmentArgs, NowPlayingOverlay } from './segmentArgs';

export interface SegmentFeederOptions extends VideoParams {
  spawner: Spawner;
  fifoPath: string;
  defaultCoverPath: string;
  backgroundPath: string;
  fontFile: string;
  createWriteStream?: (path: string) => NodeJS.WritableStream;
}

export class SegmentFeeder {
  private readonly fifoWriteStream: NodeJS.WritableStream;
  private activeProcess: ChildProcessLike | null = null;

  constructor(private readonly options: SegmentFeederOptions) {
    const createWriteStream = options.createWriteStream ?? ((p: string) => fs.createWriteStream(p));
    this.fifoWriteStream = createWriteStream(options.fifoPath);
  }

  feedTrack(track: Track, overlay: NowPlayingOverlay, startOffsetSeconds = 0): ChildProcessLike {
    const args = buildTrackSegmentArgs({
      audioPath: track.audioPath,
      coverPath: track.coverPath ?? this.options.defaultCoverPath,
      backgroundPath: this.options.backgroundPath,
      fontFile: this.options.fontFile,
      width: this.options.width,
      height: this.options.height,
      fps: this.options.fps,
      overlay,
      startOffsetSeconds,
    });
    return this.spawnAndPipe(args);
  }

  feedPause(): ChildProcessLike {
    const args = buildPauseSegmentArgs({
      backgroundPath: this.options.backgroundPath,
      width: this.options.width,
      height: this.options.height,
      fps: this.options.fps,
    });
    return this.spawnAndPipe(args);
  }

  stopCurrent(): void {
    if (this.activeProcess) {
      this.activeProcess.kill('SIGTERM');
      this.activeProcess = null;
    }
  }

  private spawnAndPipe(args: string[]): ChildProcessLike {
    this.stopCurrent();
    const child = this.options.spawner('ffmpeg', args);
    if (child.stdout) {
      child.stdout.pipe(this.fifoWriteStream, { end: false });
    }
    this.activeProcess = child;
    return child;
  }
}
