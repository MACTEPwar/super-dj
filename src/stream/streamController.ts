import { Library } from '../playlist/library';
import { PlaylistQueue } from '../playlist/queue';
import { Track } from '../playlist/types';
import { SegmentFeeder } from '../ffmpeg/segmentFeeder';
import { RtmpPusher } from '../ffmpeg/rtmpPusher';
import { NowPlayingOverlay } from '../ffmpeg/segmentArgs';
import { ApiError } from '../errors';
import { SessionState, StreamStatus } from './types';

export interface StreamControllerDeps {
  library: Library;
  queue: PlaylistQueue;
  fifoPath: string;
  createFifo: (path: string) => void;
  removeFifo: (path: string) => void;
  createSegmentFeeder: () => SegmentFeeder;
  createRtmpPusher: () => RtmpPusher;
  buildOverlay: (track: Track) => NowPlayingOverlay;
}

export class StreamController {
  private state: SessionState = 'idle';
  private feeder: SegmentFeeder | null = null;
  private pusher: RtmpPusher | null = null;
  private trackStartedAt: number | null = null;
  private pausedElapsedSeconds = 0;
  private segmentGeneration = 0;

  constructor(private readonly deps: StreamControllerDeps) {}

  start(): void {
    if (this.state === 'streaming' || this.state === 'paused') {
      throw new ApiError(409, 'stream is already active');
    }
    if (this.deps.library.list().length === 0) throw new ApiError(409, 'library is empty');

    // Best-effort cleanup of anything left behind by a crashed session or an
    // unclean shutdown; removeFifo is idempotent (it swallows ENOENT), so this
    // also makes createFifo safe when a stale FIFO survived on disk.
    this.segmentGeneration += 1;
    this.feeder?.stopCurrent();
    this.feeder?.close();
    this.pusher?.stop();
    this.feeder = null;
    this.pusher = null;
    this.deps.removeFifo(this.deps.fifoPath);

    this.deps.createFifo(this.deps.fifoPath);
    this.pusher = this.deps.createRtmpPusher();
    this.pusher.start(() => { this.state = 'error'; });
    this.feeder = this.deps.createSegmentFeeder();
    this.pausedElapsedSeconds = 0;
    this.trackStartedAt = null;

    this.state = 'streaming';

    const track = this.deps.queue.current();
    if (track) {
      this.feedCurrentTrack(track);
    }
  }

  stop(): void {
    if (this.state === 'idle') throw new ApiError(409, 'stream is not active');
    this.segmentGeneration += 1;
    this.feeder?.stopCurrent();
    this.feeder?.close();
    this.pusher?.stop();
    this.deps.removeFifo(this.deps.fifoPath);
    this.feeder = null;
    this.pusher = null;
    this.trackStartedAt = null;
    this.pausedElapsedSeconds = 0;
    this.state = 'idle';
  }

  pause(): void {
    if (this.state !== 'streaming') throw new ApiError(409, 'stream is not currently streaming');
    if (this.trackStartedAt !== null) {
      this.pausedElapsedSeconds += (Date.now() - this.trackStartedAt) / 1000;
      this.trackStartedAt = null;
    }
    this.segmentGeneration += 1;
    this.state = 'paused';
    this.feeder!.feedPause();
  }

  resume(): void {
    if (this.state !== 'paused') throw new ApiError(409, 'stream is not paused');
    this.state = 'streaming';
    const track = this.deps.queue.current();
    if (track) {
      this.feedCurrentTrack(track, this.pausedElapsedSeconds);
    }
  }

  next(): void {
    if (this.state === 'idle' || this.state === 'error') throw new ApiError(409, 'stream is not active');
    const track = this.deps.queue.next();
    if (!track) throw new ApiError(409, 'no tracks in queue');
    this.pausedElapsedSeconds = 0;
    if (this.state === 'streaming') {
      this.feedCurrentTrack(track);
    }
  }

  previous(): void {
    if (this.state === 'idle' || this.state === 'error') throw new ApiError(409, 'stream is not active');
    const track = this.deps.queue.previous();
    this.pausedElapsedSeconds = 0;
    if (track && this.state === 'streaming') {
      this.feedCurrentTrack(track);
    }
  }

  /**
   * Feeds a track segment and arms an auto-advance listener on the producer
   * process. The generation counter distinguishes "this segment ended naturally"
   * (advance to the next track) from "this segment was superseded/torn down by
   * next/previous/pause/stop/start" (do nothing).
   */
  private feedCurrentTrack(track: Track, startOffsetSeconds = 0): void {
    const generation = ++this.segmentGeneration;
    const overlay = this.deps.buildOverlay(track);
    const child = startOffsetSeconds
      ? this.feeder!.feedTrack(track, overlay, startOffsetSeconds)
      : this.feeder!.feedTrack(track, overlay);
    this.trackStartedAt = Date.now();
    child?.once('exit', () => {
      if (generation !== this.segmentGeneration) return;
      if (this.state !== 'streaming') return;
      this.advanceToNextTrack();
    });
  }

  private advanceToNextTrack(): void {
    const track = this.deps.queue.next();
    this.pausedElapsedSeconds = 0;
    if (track) {
      this.feedCurrentTrack(track);
    }
  }

  playByName(name: string): void {
    const track = this.deps.library.findByName(name);
    if (!track) throw new ApiError(404, `track not found: ${name}`);
    this.deps.queue.insertNext(track);
  }

  status(): StreamStatus {
    return {
      state: this.state,
      currentTrack: this.deps.queue.current()?.name ?? null,
      nextTrack: this.deps.queue.peekNext()?.name ?? null,
    };
  }
}
