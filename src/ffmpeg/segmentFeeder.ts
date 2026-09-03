import * as fs from 'fs';
import { Track } from '../playlist/types';
import { Spawner, ChildProcessLike, VideoParams } from './types';
import { buildTrackSegmentArgs, buildPauseSegmentArgs, NowPlayingOverlay } from './segmentArgs';
import { BLANK_OVERLAY_PNG } from '../render/blankOverlay';

export interface SegmentFeederOptions extends VideoParams {
  spawner: Spawner;
  fifoPath: string;
  backgroundPath: string;
  // Fixed on-disk path this feeder writes the current overlay PNG to before every track
  // segment, and reuses as-is for a pause segment — see feedPause().
  overlayImagePath: string;
  createWriteStream?: (path: string) => NodeJS.WritableStream;
  writeFileSync?: (path: string, data: Buffer) => void;
}

export class SegmentFeeder {
  private readonly fifoWriteStream: NodeJS.WritableStream;
  private readonly writeFileSync: (path: string, data: Buffer) => void;
  private activeProcess: ChildProcessLike | null = null;
  private activeStdout: NodeJS.ReadableStream | null = null;
  private hasWrittenOverlay = false;

  constructor(private readonly options: SegmentFeederOptions) {
    const createWriteStream = options.createWriteStream ?? ((p: string) => fs.createWriteStream(p));
    this.fifoWriteStream = createWriteStream(options.fifoPath);
    this.writeFileSync = options.writeFileSync ?? fs.writeFileSync;
    // Writes fail with EPIPE once the FIFO's reader (the pusher ffmpeg) has died or
    // exited — e.g. an RTMP connection drop — which can race a producer segment still
    // writing to it. An 'error' event with no listener is an uncaught exception in
    // Node, which would crash the whole process (every other user's active stream
    // included, not just this one), so this must never be left unhandled even though
    // StreamController already reacts to the pusher's own exit via RtmpPusher's
    // onExit callback.
    this.fifoWriteStream.on('error', (err) => {
      console.error('fifo write stream error', err);
    });
  }

  feedTrack(track: Track, overlay: NowPlayingOverlay, startOffsetSeconds = 0, outputTsOffsetSeconds = 0): ChildProcessLike {
    this.writeFileSync(this.options.overlayImagePath, overlay.overlayPng);
    this.hasWrittenOverlay = true;
    const args = buildTrackSegmentArgs({
      audioPath: track.audioPath,
      backgroundPath: this.options.backgroundPath,
      overlayPngPath: this.options.overlayImagePath,
      width: this.options.width,
      height: this.options.height,
      fps: this.options.fps,
      startOffsetSeconds,
      outputTsOffsetSeconds,
    });
    return this.spawnAndPipe(args);
  }

  feedPause(outputTsOffsetSeconds = 0): ChildProcessLike {
    // Reuses whichever picture is already on disk — the last playing track's — so pausing
    // only ever changes the audio, never the overlay. If a track segment somehow never got
    // to write one yet (defensive: shouldn't happen, start() always feeds a track before a
    // pause is reachable), fall back to the shared blank PNG so ffmpeg's -loop 1 input never
    // points at a file that doesn't exist.
    if (!this.hasWrittenOverlay) {
      this.writeFileSync(this.options.overlayImagePath, BLANK_OVERLAY_PNG);
      this.hasWrittenOverlay = true;
    }
    const args = buildPauseSegmentArgs({
      backgroundPath: this.options.backgroundPath,
      overlayPngPath: this.options.overlayImagePath,
      width: this.options.width,
      height: this.options.height,
      fps: this.options.fps,
      outputTsOffsetSeconds,
    });
    return this.spawnAndPipe(args);
  }

  stopCurrent(): void {
    if (this.activeStdout) {
      // kill() doesn't stop the dying process's stdout from still draining into
      // fifoWriteStream — a real ffmpeg process takes a little while to actually exit
      // after SIGTERM, and by the time it does, spawnAndPipe() has typically already
      // piped the *next* segment's stdout into the same destination. With both piped at
      // once, their MPEG-TS bytes interleave unpredictably, corrupting the bitstream
      // right at the switch point: this is what shows up as video/audio glitches and a
      // slow-looking track change (the pusher/decoder has to resync afterwards).
      // Unpiping immediately closes that window regardless of how long the process
      // itself takes to die.
      this.activeStdout.unpipe(this.fifoWriteStream);
      this.activeStdout = null;
    }
    if (this.activeProcess) {
      this.activeProcess.kill('SIGTERM');
      this.activeProcess = null;
    }
  }

  /** Closes the FIFO write stream and removes the overlay file. Call once the feeder is being discarded. */
  close(): void {
    this.fifoWriteStream.end();
    try {
      fs.unlinkSync(this.options.overlayImagePath);
    } catch {
      // Never written, or already gone — either way there's nothing left to clean up.
    }
  }

  private spawnAndPipe(args: string[]): ChildProcessLike {
    this.stopCurrent();
    const child = this.options.spawner('ffmpeg', args);
    if (child.stdout) {
      child.stdout.pipe(this.fifoWriteStream, { end: false });
      this.activeStdout = child.stdout;
    }
    this.activeProcess = child;
    return child;
  }
}
