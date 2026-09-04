import { PlaylistQueue } from '../playlist/queue';
import { Track } from '../playlist/types';
import { CanvasFeeder } from '../ffmpeg/canvasFeeder';
import { AudioRelay } from '../ffmpeg/audioRelay';
import { PersistentEncoder } from '../ffmpeg/persistentEncoder';
import { NowPlayingOverlay } from '../ffmpeg/segmentArgs';
import { formatDuration } from '../ffmpeg/overlayText';
import { ApiError } from '../errors';
import { SessionState, StreamStatus } from './types';

export interface LibraryLike {
  list(): Track[];
  findByName(name: string): Track | undefined;
}

export interface StreamControllerDeps {
  library: LibraryLike;
  queue: PlaylistQueue;
  createCanvasFeeder: () => CanvasFeeder;
  createAudioRelay: () => AudioRelay;
  createPersistentEncoder: () => PersistentEncoder;
  buildOverlay: (track: Track) => Promise<NowPlayingOverlay>;
  onError?: () => void;
  onStatusChanged?: () => void;
}

export class StreamController {
  private state: SessionState = 'idle';
  private canvasFeeder: CanvasFeeder | null = null;
  private audioRelay: AudioRelay | null = null;
  private encoder: PersistentEncoder | null = null;
  private trackStartedAt: number | null = null;
  // The elapsed-seconds baseline in effect for the CURRENT feedCurrentTrack() call — 0 for a
  // fresh track, pausedElapsedSeconds for a resume. elapsedTrackSeconds() must add this to the
  // live delta since trackStartedAt, or the ticking timer visibly resets toward 0 on every tick
  // after a resume instead of continuing from where it was paused.
  private trackStartOffsetSeconds = 0;
  private pausedElapsedSeconds = 0;
  private currentOverlay: NowPlayingOverlay | null = null;
  private timerTicker: NodeJS.Timeout | null = null;
  // Distinguishes "this track ended naturally" (advance to the next one) from "this track was
  // superseded/torn down by next/previous/pause/stop/start" (do nothing) — same role
  // segmentGeneration always had, renamed because there's no more per-segment process for
  // "segment" to describe.
  private sessionGeneration = 0;

  constructor(private readonly deps: StreamControllerDeps) {}

  async start(): Promise<void> {
    if (this.state === 'streaming' || this.state === 'paused') {
      throw new ApiError(409, 'stream is already active');
    }
    if (this.deps.library.list().length === 0) throw new ApiError(409, 'library is empty');

    this.sessionGeneration += 1;
    this.teardown();

    this.encoder = this.deps.createPersistentEncoder();
    const child = this.encoder.start(() => {
      this.state = 'error';
      this.deps.onError?.();
      this.deps.onStatusChanged?.();
    });
    this.canvasFeeder = this.deps.createCanvasFeeder();
    this.canvasFeeder.attach(child.videoPipe);
    this.audioRelay = this.deps.createAudioRelay();
    this.audioRelay.attach(child.audioPipe);
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
    this.sessionGeneration += 1;
    this.teardown();
    this.state = 'idle';
    this.deps.onStatusChanged?.();
  }

  pause(): void {
    if (this.state !== 'streaming') throw new ApiError(409, 'stream is not currently streaming');
    if (this.trackStartedAt !== null) {
      this.pausedElapsedSeconds += (Date.now() - this.trackStartedAt) / 1000;
      this.trackStartedAt = null;
    }
    this.sessionGeneration += 1;
    this.state = 'paused';
    this.stopTimerTicker();
    this.audioRelay!.switchToSilence();
    if (this.currentOverlay) {
      this.canvasFeeder!.render(this.currentOverlay, this.timerText(this.pausedElapsedSeconds)).catch((err) => {
        console.error('failed to render the frozen pause frame', err);
      });
    }
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

  private async feedCurrentTrack(track: Track, startOffsetSeconds = 0): Promise<void> {
    const generation = ++this.sessionGeneration;
    const overlay = await this.deps.buildOverlay(track);
    // The generation may have advanced, or the session may have left 'streaming', while we were
    // awaiting the overlay — a stale overlay must never be fed.
    if (generation !== this.sessionGeneration) return;
    if (this.state !== 'streaming') return;

    this.currentOverlay = overlay;
    this.trackStartedAt = Date.now();
    this.trackStartOffsetSeconds = startOffsetSeconds;
    const child = this.audioRelay!.switchTrack(track.audioPath, startOffsetSeconds);
    await this.canvasFeeder!.render(overlay, this.timerText(startOffsetSeconds));
    this.startTimerTicker();

    // 'close' — the decode-only process reaches this on its own once the track file ends, same
    // auto-advance signal the earlier per-segment pipeline's encode process used to provide.
    child.once('close', () => {
      if (generation !== this.sessionGeneration) return;
      if (this.state !== 'streaming') return;
      this.advanceToNextTrack();
    });
  }

  private startTimerTicker(): void {
    this.stopTimerTicker();
    if (!this.currentOverlay?.timer) return;
    this.timerTicker = setInterval(() => {
      if (this.state !== 'streaming' || !this.currentOverlay) return;
      this.canvasFeeder!.render(this.currentOverlay, this.timerText(this.elapsedTrackSeconds())).catch((err) => {
        console.error('failed to render the ticking timer frame', err);
      });
    }, 1000);
  }

  private stopTimerTicker(): void {
    if (this.timerTicker) {
      clearInterval(this.timerTicker);
      this.timerTicker = null;
    }
  }

  private elapsedTrackSeconds(): number {
    const liveDelta = this.trackStartedAt !== null ? (Date.now() - this.trackStartedAt) / 1000 : 0;
    return this.trackStartOffsetSeconds + liveDelta;
  }

  // Plain, unescaped text — segmentArgs.ts's overlayFilterComplex() is the single layer that
  // escapes colons for ffmpeg drawtext syntax. Escaping here too would double-escape.
  private timerText(elapsedSeconds: number): string | null {
    if (!this.currentOverlay?.timer) return null;
    return `${formatDuration(elapsedSeconds)} / ${formatDuration(this.currentOverlay.durationSeconds)}`;
  }

  private advanceToNextTrack(): void {
    const track = this.deps.queue.next();
    this.deps.onStatusChanged?.();
    this.pausedElapsedSeconds = 0;
    if (track) {
      this.feedCurrentTrack(track).catch((err) => {
        console.error('failed to auto-advance to the next track', err);
      });
    }
  }

  private teardown(): void {
    this.stopTimerTicker();
    this.audioRelay?.close();
    this.canvasFeeder?.close();
    this.encoder?.stop();
    this.audioRelay = null;
    this.canvasFeeder = null;
    this.encoder = null;
    this.trackStartedAt = null;
    this.trackStartOffsetSeconds = 0;
    this.pausedElapsedSeconds = 0;
    this.currentOverlay = null;
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
