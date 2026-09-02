import { PlaylistQueue } from '../playlist/queue';
import { Track } from '../playlist/types';
import { SegmentFeeder } from '../ffmpeg/segmentFeeder';
import { RtmpPusher } from '../ffmpeg/rtmpPusher';
import { NowPlayingOverlay } from '../ffmpeg/segmentArgs';
import { ApiError } from '../errors';
import { SessionState, StreamStatus } from './types';

export interface LibraryLike {
  list(): Track[];
  findByName(name: string): Track | undefined;
}

export interface StreamControllerDeps {
  library: LibraryLike;
  queue: PlaylistQueue;
  fifoPath: string;
  createFifo: (path: string) => void;
  removeFifo: (path: string) => void;
  createSegmentFeeder: () => SegmentFeeder;
  createRtmpPusher: () => RtmpPusher;
  buildOverlay: (track: Track) => Promise<NowPlayingOverlay>;
  onError?: () => void;
  onStatusChanged?: () => void;
}

export class StreamController {
  private state: SessionState = 'idle';
  private feeder: SegmentFeeder | null = null;
  private pusher: RtmpPusher | null = null;
  private trackStartedAt: number | null = null;
  private pausedElapsedSeconds = 0;
  private segmentGeneration = 0;

  constructor(private readonly deps: StreamControllerDeps) {}

  async start(): Promise<void> {
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
    this.pusher.start(() => {
      this.state = 'error';
      this.deps.onError?.();
      this.deps.onStatusChanged?.();
    });
    this.feeder = this.deps.createSegmentFeeder();
    this.pausedElapsedSeconds = 0;
    this.trackStartedAt = null;

    this.state = 'streaming';

    const track = this.deps.queue.current();
    if (track) {
      await this.feedCurrentTrack(track);
    }
    this.deps.onStatusChanged?.();
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
    this.deps.onStatusChanged?.();
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
    this.deps.onStatusChanged?.();
  }

  async resume(): Promise<void> {
    if (this.state !== 'paused') throw new ApiError(409, 'stream is not paused');
    this.state = 'streaming';
    const track = this.deps.queue.current();
    if (track) {
      await this.feedCurrentTrack(track, this.pausedElapsedSeconds);
    }
    this.deps.onStatusChanged?.();
  }

  async next(): Promise<void> {
    if (this.state === 'idle' || this.state === 'error') throw new ApiError(409, 'stream is not active');
    const track = this.deps.queue.next();
    if (!track) throw new ApiError(409, 'no tracks in queue');
    this.pausedElapsedSeconds = 0;
    if (this.state === 'streaming') {
      await this.feedCurrentTrack(track);
    }
    this.deps.onStatusChanged?.();
  }

  async previous(): Promise<void> {
    if (this.state === 'idle' || this.state === 'error') throw new ApiError(409, 'stream is not active');
    const track = this.deps.queue.previous();
    this.pausedElapsedSeconds = 0;
    if (track && this.state === 'streaming') {
      await this.feedCurrentTrack(track);
    }
    this.deps.onStatusChanged?.();
  }

  /**
   * Feeds a track segment and arms an auto-advance listener on the producer
   * process. The generation counter distinguishes "this segment ended naturally"
   * (advance to the next track) from "this segment was superseded/torn down by
   * next/previous/pause/stop/start" (do nothing).
   */
  private async feedCurrentTrack(track: Track, startOffsetSeconds = 0): Promise<void> {
    const generation = ++this.segmentGeneration;
    const overlay = await this.deps.buildOverlay(track);
    // The generation may have advanced, or the session may have left
    // 'streaming' (e.g. the pusher died, or stop()/pause() ran), while we
    // were awaiting the overlay — a stale overlay must never be fed.
    if (generation !== this.segmentGeneration) return;
    if (this.state !== 'streaming') return;
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
    this.deps.onStatusChanged?.();
    this.pausedElapsedSeconds = 0;
    if (track) {
      // Fire-and-forget: this runs from a child-process 'exit' callback, not
      // an awaited call chain. Catch so a failed duration probe surfaces as a
      // log line instead of an unhandled rejection.
      this.feedCurrentTrack(track).catch((err) => {
        console.error('failed to auto-advance to the next track', err);
      });
    }
  }

  playByName(name: string): void {
    const track = this.deps.library.findByName(name);
    if (!track) throw new ApiError(404, `track not found: ${name}`);
    this.deps.queue.insertNext(track);
    this.deps.onStatusChanged?.();
  }

  status(): StreamStatus {
    return {
      state: this.state,
      currentTrack: this.deps.queue.current()?.name ?? null,
      nextTrack: this.deps.queue.peekNext()?.name ?? null,
    };
  }
}
