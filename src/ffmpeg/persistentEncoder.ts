import { PipeSpawner, ChildProcessWithPipes } from './types';
import { buildPersistentEncoderArgs, CanvasPlacement, EqualizerConfig, GifOverlayConfig, PlaylistWindowLayerConfig, MarqueeLayerConfig } from './persistentEncoderArgs';

export interface PersistentEncoderParams {
  spawner: PipeSpawner;
  width: number;
  height: number;
  fps: number;
  heartbeatFps: number;
  rtmpUrl: string;
  streamKey: string;
  backgroundPath: string;
  equalizer?: EqualizerConfig;
  gifOverlays?: GifOverlayConfig[];
  canvasPlacement?: CanvasPlacement;
  playlistWindow: PlaylistWindowLayerConfig | undefined;
  marquee: MarqueeLayerConfig | undefined;
}

// Spawned once in StreamController.start() and never restarted for the life of the session —
// this is the actual fix: there is no per-track/per-segment process for a continuity counter or
// bitstream filter to lose sync at any more. See the Stage 2 design doc.
export class PersistentEncoder {
  private process: ChildProcessWithPipes | null = null;
  private stopRequested = false;

  constructor(private readonly params: PersistentEncoderParams) {}

  start(onExit: (code: number | null) => void): ChildProcessWithPipes {
    this.stopRequested = false;
    const args = buildPersistentEncoderArgs(this.params);
    const child = this.params.spawner('ffmpeg', args);
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
