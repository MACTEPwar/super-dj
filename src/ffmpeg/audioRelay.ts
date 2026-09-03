import { Spawner, ChildProcessLike } from './types';
import { buildDecodeTrackArgs, buildSilenceArgs } from './audioRelayArgs';

export interface AudioRelayOptions {
  spawner: Spawner;
}

export class AudioRelay {
  private activeProcess: ChildProcessLike | null = null;
  private audioPipe: NodeJS.WritableStream | null = null;

  constructor(private readonly options: AudioRelayOptions) {}

  /** Called once, right after the persistent encoder starts — see StreamController.start(). */
  attach(audioPipe: NodeJS.WritableStream): void {
    this.audioPipe = audioPipe;
  }

  switchTrack(audioPath: string, startOffsetSeconds = 0): ChildProcessLike {
    return this.spawnNext(buildDecodeTrackArgs({ audioPath, startOffsetSeconds }));
  }

  switchToSilence(): ChildProcessLike {
    return this.spawnNext(buildSilenceArgs());
  }

  stopCurrent(): void {
    if (this.activeProcess) {
      // Same reasoning SegmentFeeder always had: kill() doesn't stop a still-alive process's
      // stdout from draining into the audio pipe immediately, so unpipe first or two decoders'
      // raw PCM could interleave into the same pipe for a moment.
      if (this.activeProcess.stdout && this.audioPipe) {
        this.activeProcess.stdout.unpipe(this.audioPipe);
      }
      this.activeProcess.kill('SIGTERM');
      this.activeProcess = null;
    }
  }

  close(): void {
    this.stopCurrent();
  }

  private spawnNext(args: string[]): ChildProcessLike {
    this.stopCurrent();
    const child = this.options.spawner('ffmpeg', args);
    if (child.stdout && this.audioPipe) {
      child.stdout.pipe(this.audioPipe, { end: false });
    }
    this.activeProcess = child;
    return child;
  }
}
