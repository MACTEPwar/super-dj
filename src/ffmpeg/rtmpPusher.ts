import { Spawner, ChildProcessLike } from './types';
import { buildRtmpPusherArgs } from './rtmpPusherArgs';

export interface RtmpPusherParams {
  fifoPath: string;
  rtmpUrl: string;
  streamKey: string;
}

export class RtmpPusher {
  private process: ChildProcessLike | null = null;
  private stopRequested = false;

  constructor(private readonly spawner: Spawner, private readonly params: RtmpPusherParams) {}

  start(onExit: (code: number | null) => void): void {
    this.stopRequested = false;
    const args = buildRtmpPusherArgs(this.params);
    const child = this.spawner('ffmpeg', args);
    child.once('exit', (code) => {
      // An exit that follows an intentional stop() is expected, not a crash.
      if (this.stopRequested) return;
      onExit(code as number | null);
    });
    this.process = child;
  }

  stop(): void {
    this.stopRequested = true;
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }
}
