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

  constructor(private readonly deps: StreamControllerDeps) {}

  start(): void {
    if (this.state !== 'idle') throw new ApiError(409, 'stream is already active');
    if (this.deps.library.list().length === 0) throw new ApiError(409, 'library is empty');

    this.deps.createFifo(this.deps.fifoPath);
    this.pusher = this.deps.createRtmpPusher();
    this.pusher.start(() => { this.state = 'error'; });
    this.feeder = this.deps.createSegmentFeeder();
    this.pausedElapsedSeconds = 0;

    const track = this.deps.queue.current();
    if (track) {
      this.feeder.feedTrack(track, this.deps.buildOverlay(track));
      this.trackStartedAt = Date.now();
    }
    this.state = 'streaming';
  }

  stop(): void {
    if (this.state === 'idle') throw new ApiError(409, 'stream is not active');
    this.feeder?.stopCurrent();
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
    this.feeder!.feedPause();
    this.state = 'paused';
  }

  resume(): void {
    if (this.state !== 'paused') throw new ApiError(409, 'stream is not paused');
    const track = this.deps.queue.current();
    if (track) {
      this.feeder!.feedTrack(track, this.deps.buildOverlay(track), this.pausedElapsedSeconds);
      this.trackStartedAt = Date.now();
    }
    this.state = 'streaming';
  }

  next(): void {
    if (this.state === 'idle' || this.state === 'error') throw new ApiError(409, 'stream is not active');
    const track = this.deps.queue.next();
    if (!track) throw new ApiError(409, 'no tracks in queue');
    this.pausedElapsedSeconds = 0;
    if (this.state === 'streaming') {
      this.feeder!.feedTrack(track, this.deps.buildOverlay(track));
      this.trackStartedAt = Date.now();
    }
  }

  previous(): void {
    if (this.state === 'idle' || this.state === 'error') throw new ApiError(409, 'stream is not active');
    const track = this.deps.queue.previous();
    this.pausedElapsedSeconds = 0;
    if (track && this.state === 'streaming') {
      this.feeder!.feedTrack(track, this.deps.buildOverlay(track));
      this.trackStartedAt = Date.now();
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
