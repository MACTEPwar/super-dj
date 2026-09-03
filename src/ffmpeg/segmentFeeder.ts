import * as fs from 'fs';
import { Track } from '../playlist/types';
import { Spawner, ChildProcessLike, VideoParams } from './types';
import { buildTrackSegmentArgs, buildPauseSegmentArgs, NowPlayingOverlay, TimerOverlay } from './segmentArgs';
import { formatDurationForDrawtext } from './overlayText';
import { BLANK_OVERLAY_PNG } from '../render/blankOverlay';

export interface SegmentFeederOptions extends VideoParams {
  spawner: Spawner;
  // ffmpeg opens both of these paths itself (as -f h264/-f adts output targets) — SegmentFeeder
  // no longer owns a write stream onto either of them, see the Stage 2 design doc.
  videoFifoPath: string;
  audioFifoPath: string;
  backgroundPath: string;
  // Fixed on-disk path this feeder writes the current overlay PNG to before every track
  // segment, and reuses as-is for a pause segment — see feedPause().
  overlayImagePath: string;
  // Only actually used when the template has a `timer` element — see buildTimerOverlay().
  fontFile: string;
  writeFileSync?: (path: string, data: Buffer) => void;
}

export class SegmentFeeder {
  private readonly writeFileSync: (path: string, data: Buffer) => void;
  private activeProcess: ChildProcessLike | null = null;
  private hasWrittenOverlay = false;
  // Remembered across calls so feedPause() can reuse the last track's overlay picture and timer
  // position/style without re-rendering — pausing only ever changes the audio.
  private lastOverlay: NowPlayingOverlay | null = null;

  constructor(private readonly options: SegmentFeederOptions) {
    this.writeFileSync = options.writeFileSync ?? fs.writeFileSync;
  }

  feedTrack(track: Track, overlay: NowPlayingOverlay, startOffsetSeconds = 0): ChildProcessLike {
    this.writeFileSync(this.options.overlayImagePath, overlay.overlayPng);
    this.hasWrittenOverlay = true;
    this.lastOverlay = overlay;

    const timer: TimerOverlay | null = overlay.timer && {
      ...overlay.timer,
      // Live, ticking — pts:hms's optional offset carries the seek position forward so a
      // resumed track's displayed time continues from where it was paused instead of
      // restarting at 0 (this segment's own pts always starts near 0). Both colons inside
      // %{...} need escaping, not just the first one — confirmed by actually running this
      // through ffmpeg locally (`No option name near ...` otherwise), not just by reading docs.
      text: `%{pts\\:hms\\:${startOffsetSeconds}} / ${formatDurationForDrawtext(overlay.durationSeconds)}`,
    };

    const args = buildTrackSegmentArgs({
      audioPath: track.audioPath,
      backgroundPath: this.options.backgroundPath,
      overlayPngPath: this.options.overlayImagePath,
      fontFile: this.options.fontFile,
      timer,
      width: this.options.width,
      height: this.options.height,
      fps: this.options.fps,
      startOffsetSeconds,
      durationSeconds: overlay.durationSeconds,
      videoFifoPath: this.options.videoFifoPath,
      audioFifoPath: this.options.audioFifoPath,
    });
    return this.spawnNext(args);
  }

  feedPause(trackElapsedSeconds = 0): ChildProcessLike {
    // Reuses whichever picture is already on disk — the last playing track's — so pausing
    // only ever changes the audio, never the overlay. If a track segment somehow never got
    // to write one yet (defensive: shouldn't happen — start() always feeds a track before a
    // pause is reachable), fall back to the shared blank PNG so ffmpeg's -loop 1 input never
    // points at a file that doesn't exist.
    if (!this.hasWrittenOverlay) {
      this.writeFileSync(this.options.overlayImagePath, BLANK_OVERLAY_PNG);
      this.hasWrittenOverlay = true;
      this.lastOverlay = { durationSeconds: 0, overlayPng: BLANK_OVERLAY_PNG, timer: null };
    }

    const timer: TimerOverlay | null = this.lastOverlay!.timer && {
      ...this.lastOverlay!.timer,
      // Static — frozen at the elapsed position, not a live pts expression, since a paused
      // segment's own pts keeps advancing in real time even though no track is playing.
      text: `${formatDurationForDrawtext(trackElapsedSeconds)} / ${formatDurationForDrawtext(this.lastOverlay!.durationSeconds)}`,
    };

    const args = buildPauseSegmentArgs({
      backgroundPath: this.options.backgroundPath,
      overlayPngPath: this.options.overlayImagePath,
      fontFile: this.options.fontFile,
      timer,
      width: this.options.width,
      height: this.options.height,
      fps: this.options.fps,
      videoFifoPath: this.options.videoFifoPath,
      audioFifoPath: this.options.audioFifoPath,
    });
    return this.spawnNext(args);
  }

  stopCurrent(): void {
    if (this.activeProcess) {
      this.activeProcess.kill('SIGTERM');
      this.activeProcess = null;
    }
  }

  /** Removes the overlay image file. Call once the feeder is being discarded. */
  close(): void {
    try {
      fs.unlinkSync(this.options.overlayImagePath);
    } catch {
      // Never written, or already gone — either way there's nothing left to clean up.
    }
  }

  private spawnNext(args: string[]): ChildProcessLike {
    // The outgoing process must be killed before the next one starts — a FIFO only supports
    // one writer cleanly, so two producers must never both hold the video/audio FIFOs open at
    // once. Unlike the old single-FIFO design, there's no Node-owned write stream to unpipe
    // here: ffmpeg opens both FIFO paths itself as its own output targets.
    this.stopCurrent();
    const child = this.options.spawner('ffmpeg', args);
    this.activeProcess = child;
    return child;
  }
}
