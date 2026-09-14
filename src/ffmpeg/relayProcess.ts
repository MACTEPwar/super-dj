import { Spawner, ChildProcessLike } from './types';
import { buildRelayProcessArgs } from './relayProcessArgs';

export interface RelayProcessParams {
  spawner: Spawner;
  inputUrl: string;
  outputUrl: string;
}

/**
 * One destination forward's ffmpeg process: MediaMTX read in, destination RTMP out, `-c copy` all
 * the way through. Structurally identical to PersistentEncoder on purpose — including the
 * `stopRequested` guard, which exists here for exactly the same reason: a deliberate kill
 * (toggling a destination off, stopping the stream) must never look like a dropped destination and
 * trigger a respawn or a broadcast finalize.
 *
 * A plain `Spawner`, not the `PipeSpawner` the encoder needs: a relay owns its own stdio end to
 * end and shares no pipe with anything, so the `unpipe()`-before-`kill()` discipline the audio leg
 * needs simply does not apply here.
 */
export class RelayProcess {
  private process: ChildProcessLike | null = null;
  private stopRequested = false;

  constructor(private readonly params: RelayProcessParams) {}

  start(onExit: (code: number | null) => void): ChildProcessLike {
    this.stopRequested = false;
    const child = this.params.spawner('ffmpeg', buildRelayProcessArgs(this.params));
    child.once('exit', (code) => {
      if (this.stopRequested) return;
      onExit(code as number | null);
    });
    this.process = child;
    return child;
  }

  stop(): void {
    this.stopRequested = true;
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }
}
