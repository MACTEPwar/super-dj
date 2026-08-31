import { Spawner, ChildProcessLike } from './types';
import { buildRtmpPusherArgs } from './rtmpPusherArgs';

export interface RtmpPusherParams {
  fifoPath: string;
  rtmpUrl: string;
  streamKey: string;
}

export class RtmpPusher {
  private process: ChildProcessLike | null = null;

  constructor(private readonly spawner: Spawner, private readonly params: RtmpPusherParams) {}

  start(onExit: (code: number | null) => void): void {
    const args = buildRtmpPusherArgs(this.params);
    const child = this.spawner('ffmpeg', args);
    child.once('exit', (code) => onExit(code as number | null));
    this.process = child;
  }

  stop(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }
}
