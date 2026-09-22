import { PlaylistQueue } from '../playlist/queue';
import { Track } from '../playlist/types';
import { CanvasFeeder } from '../ffmpeg/canvasFeeder';
import { AudioRelay } from '../ffmpeg/audioRelay';
import { PersistentEncoder } from '../ffmpeg/persistentEncoder';
import { PulseVisualizer } from '../ffmpeg/pulseVisualizer';
import { NowPlayingOverlay } from '../ffmpeg/segmentArgs';
import { formatDuration } from '../ffmpeg/overlayText';
import { ApiError } from '../errors';
import { SessionState, StreamStatus } from './types';
import { ReconnectPolicy, ReconnectDecision, SHORT_LIVED_UPTIME_MS } from './reconnectPolicy';

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
  createPulseVisualizer?: () => PulseVisualizer;
  buildOverlay: (track: Track, baseAnchorIndex?: number) => Promise<NowPlayingOverlay>;
  // Absent means "never retry" — an unexpected exit goes straight to 'error', matching this
  // controller's pre-reconnect behavior. Injected (rather than hardcoded here) so the caller
  // (LocalStreamManager — the only constructor of a StreamController now) can fold in
  // provider-specific knowledge (e.g. a YouTube destination's lifecycle being in a terminal phase,
  // or having seen an auth-class failure) without StreamController itself having to know anything
  // YouTube-specific — see reconnectPolicy.ts.
  reconnectPolicy?: ReconnectPolicy;
  onError?: (exitCode: number | null) => void;
  onStatusChanged?: () => void;
}

export class StreamController {
  private state: SessionState = 'idle';
  private canvasFeeder: CanvasFeeder | null = null;
  private audioRelay: AudioRelay | null = null;
  private pulseVisualizer: PulseVisualizer | null = null;
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
  // What's actually audible right now — set on every feedCurrentTrack() call. Normally identical
  // to queue.current(), but the two deliberately diverge for the whole span a donation track is
  // interrupting: queue.current() stays pointed at the real playlist's resume point (untouched —
  // see PlaylistQueue.shiftDonation), while this reflects the donation track that's actually
  // playing. status()/pause()/resume()/reconnect all read THIS, never queue.current(), for
  // exactly that reason — using queue.current() during a donation interruption would pause/
  // reconnect/report the wrong track.
  private nowPlayingTrack: Track | null = null;
  // Non-null for the entire span from "a donation track first interrupted something" through
  // "the last queued donation track finished and the interrupted track resumed" — set once per
  // episode (NOT overwritten by later donation arrivals queueing behind the first one), cleared
  // the instant the original track is handed back to feedCurrentTrack(). next()/previous() reject
  // outright while this is set (a donation track can never be skipped), and the close handler
  // consults it instead of always calling advanceToNextTrack().
  private interruptedForDonation: { track: Track; elapsedSeconds: number } | null = null;
  // Distinguishes "this track ended naturally" (advance to the next one) from "this track was
  // superseded/torn down by next/previous/pause/stop/start" (do nothing) — same role
  // segmentGeneration always had, renamed because there's no more per-segment process for
  // "segment" to describe. Also doubles as the reconnect mechanism's staleness guard: a scheduled
  // respawn captures this value at schedule time and bails if it no longer matches when its timer
  // fires (the same pattern feedCurrentTrack already uses for a stale overlay probe).
  private sessionGeneration = 0;

  // When the currently-running encoder (if any) was spawned — used to compute how long it lived
  // once it exits unexpectedly (see reconnectPolicy.ts's SHORT_LIVED_UPTIME_MS: exit codes carry
  // no useful signal, ffmpeg exits 1 for almost everything, so uptime is the recoverability
  // signal instead).
  private encoderStartedAt: number | null = null;
  private pendingReconnect: { timer: NodeJS.Timeout; scheduledGeneration: number } | null = null;
  private reconnectAttempt = 0;
  private reconnectFirstFailureAt: number | null = null;
  private consecutiveShortLivedFailures = 0;

  constructor(private readonly deps: StreamControllerDeps) {}

  async start(): Promise<void> {
    if (this.state === 'streaming' || this.state === 'paused') {
      throw new ApiError(409, 'stream is already active');
    }
    if (this.deps.library.list().length === 0) throw new ApiError(409, 'library is empty');

    this.sessionGeneration += 1;
    this.teardown();
    this.resetReconnectBookkeeping();

    this.spawnPipeline();
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
    // nowPlayingTrack, not queue.current(): if a donation track was interrupting when pause() was
    // called, queue.current() still points at the ORIGINAL interrupted track, not the donation
    // track that was actually paused — resuming from queue.current() would silently abandon the
    // donation track mid-playback and jump back to the wrong one.
    const track = this.nowPlayingTrack ?? this.deps.queue.current();
    if (track) {
      await this.feedCurrentTrack(track, this.pausedElapsedSeconds);
    }
    this.deps.onStatusChanged?.();
  }

  async next(): Promise<void> {
    if (this.state === 'idle' || this.state === 'error') throw new ApiError(409, 'stream is not active');
    if (this.interruptedForDonation !== null) throw new ApiError(409, 'cannot skip a donation-requested track');
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
    if (this.interruptedForDonation !== null) throw new ApiError(409, 'cannot skip a donation-requested track');
    const track = this.deps.queue.previous();
    this.pausedElapsedSeconds = 0;
    if (track && this.state === 'streaming') {
      await this.feedCurrentTrack(track);
    }
    this.deps.onStatusChanged?.();
  }

  private async feedCurrentTrack(track: Track, startOffsetSeconds = 0): Promise<void> {
    const generation = ++this.sessionGeneration;
    const overlay = await this.deps.buildOverlay(track, this.deps.queue.positionInBase());
    // The generation may have advanced, or the session may have left 'streaming', while we were
    // awaiting the overlay — a stale overlay must never be fed.
    if (generation !== this.sessionGeneration) return;
    if (this.state !== 'streaming') return;

    this.nowPlayingTrack = track;
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
      // Self-disarming: track objects can be re-fed (e.g. previous() pops an ephemeral track back
      // out of PlaylistQueue's history and plays it again) — clearing the hook before invoking it
      // guarantees it can never fire a second time for the same track, even across a later re-feed
      // whose own close event would otherwise find it still armed.
      const onFinished = track._onFinished;
      track._onFinished = undefined;
      try {
        onFinished?.();
      } catch (err) {
        console.error('a track\'s _onFinished hook threw', err);
      }
      this.advanceAfterTrackFinished();
    });
  }

  // What runs a track's natural end into next — split from advanceToNextTrack() because a
  // donation episode in progress must never fall through to the ordinary playlist advance: while
  // interruptedForDonation is set, this track's natural end means either "play the next queued
  // donation track" or, once that queue is empty, "hand the original interrupted track back to
  // feedCurrentTrack() at the position it was cut off at" — never queue.next().
  private advanceAfterTrackFinished(): void {
    if (this.interruptedForDonation !== null) {
      if (this.deps.queue.hasDonationPending()) {
        this.playNextDonationTrack();
      } else {
        const { track, elapsedSeconds } = this.interruptedForDonation;
        this.interruptedForDonation = null;
        this.pausedElapsedSeconds = 0;
        this.deps.onStatusChanged?.();
        this.feedCurrentTrack(track, elapsedSeconds).catch((err) => {
          console.error('failed to resume the track a donation request interrupted', err);
        });
      }
      return;
    }
    this.advanceToNextTrack();
  }

  // Begins (or continues) a donation-interrupt episode: pulls the next queued donation track and
  // feeds it immediately. Called both for the very first donation track (from
  // interruptCurrentTrackForDonation) and for every subsequent one once its predecessor finishes
  // (from advanceAfterTrackFinished) — same call, same generation-bump-based supersession safety
  // feedCurrentTrack already provides for next()/previous()/etc.
  private playNextDonationTrack(): void {
    const track = this.deps.queue.shiftDonation();
    this.pausedElapsedSeconds = 0;
    if (!track) return; // Only reachable if called when hasDonationPending() was already false.
    this.feedCurrentTrack(track).catch((err) => {
      console.error('failed to play the next donation-requested track', err);
    });
  }

  // Captures what's playing right now (track + elapsed position) as the thing to resume once the
  // whole donation queue drains, then immediately switches to the first donation track. Only ever
  // called once per episode — see insertEphemeralTrack's interruptedForDonation === null guard.
  private interruptCurrentTrackForDonation(): void {
    const track = this.nowPlayingTrack ?? this.deps.queue.current();
    if (!track) return;
    const elapsedSeconds = this.state === 'paused' ? this.pausedElapsedSeconds : this.elapsedTrackSeconds();
    this.interruptedForDonation = { track, elapsedSeconds };
    this.stopTimerTicker();
    this.state = 'streaming'; // Waking a paused stream is deliberate — a donation should be heard right away, not wait for a manual resume.
    this.playNextDonationTrack();
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
    this.clearPendingReconnect();
    this.stopTimerTicker();
    this.audioRelay?.close();
    this.canvasFeeder?.close();
    this.pulseVisualizer?.close();
    this.encoder?.stop();
    this.audioRelay = null;
    this.canvasFeeder = null;
    this.pulseVisualizer = null;
    this.encoder = null;
    this.encoderStartedAt = null;
    this.trackStartedAt = null;
    this.trackStartOffsetSeconds = 0;
    this.pausedElapsedSeconds = 0;
    this.currentOverlay = null;
    this.nowPlayingTrack = null;
    this.interruptedForDonation = null;
  }

  // Creates the persistent encoder and wires CanvasFeeder/AudioRelay/PulseVisualizer to its
  // pipes exactly as start() always has — shared with the reconnect respawn path (performReconnect)
  // so an in-place respawn goes through the identical wiring sequence a fresh start() does,
  // rather than a second hand-rolled copy of it.
  private spawnPipeline(): void {
    this.encoderStartedAt = Date.now();
    this.encoder = this.deps.createPersistentEncoder();
    const child = this.encoder.start((exitCode) => this.handleUnexpectedExit(exitCode));
    this.canvasFeeder = this.deps.createCanvasFeeder();
    // The second pipe is only written to when buildStreamScene() (streamScene.ts) configured this
    // feeder with an above layer (a template whose baked elements straddle its first animated
    // gif) — passing it unconditionally keeps the wiring identical for every session, exactly
    // like pulsePipe.
    this.canvasFeeder.attach(child.videoPipe, child.aboveCanvasPipe);
    this.audioRelay = this.deps.createAudioRelay();
    this.audioRelay.attach(child.audioPipe);
    if (this.deps.createPulseVisualizer) {
      this.pulseVisualizer = this.deps.createPulseVisualizer();
      this.pulseVisualizer.attach(child.pulsePipe);
      this.audioRelay.attachTap(this.pulseVisualizer.audioSink);
    }
  }

  private resetReconnectBookkeeping(): void {
    this.reconnectAttempt = 0;
    this.reconnectFirstFailureAt = null;
    this.consecutiveShortLivedFailures = 0;
  }

  private clearPendingReconnect(): void {
    if (this.pendingReconnect) {
      clearTimeout(this.pendingReconnect.timer);
      this.pendingReconnect = null;
    }
  }

  // The encoder's exit callback — invoked for ANY unexpected exit (a real dropped RTMP
  // connection, ffmpeg crashing, etc; never for a deliberate stop(), which sets stopRequested on
  // the encoder first so this callback is skipped entirely, see PersistentEncoder.stop()).
  //
  // Tears down every collaborator IMMEDIATELY, regardless of what happens next — this is the fix
  // for the real resource-leak bug: previously this callback only set state='error' and left
  // CanvasFeeder's heartbeat, AudioRelay's decode process and PulseVisualizer's render tick loop
  // all running indefinitely against a dead pipe until a human called start()/stop().
  private handleUnexpectedExit(exitCode: number | null): void {
    const uptimeMs = this.encoderStartedAt !== null ? Date.now() - this.encoderStartedAt : 0;
    // Must be captured BEFORE teardown() resets trackStartedAt/trackStartOffsetSeconds/
    // nowPlayingTrack/interruptedForDonation — this is the position a successful reconnect needs
    // to resume from. nowPlayingTrack, not queue.current(): if a donation track was interrupting
    // when the encoder died, queue.current() still points at the track it interrupted, not the
    // donation track that was actually playing.
    const capturedElapsedSeconds = this.elapsedTrackSeconds();
    const capturedTrack = this.nowPlayingTrack ?? this.deps.queue.current();
    const wasInterruptedForDonation = this.interruptedForDonation;
    const generationAtExit = this.sessionGeneration;

    this.teardown();
    // Restored right away, not just at reconnect time — a donation track was still
    // non-skippable a moment before the crash, and stays non-skippable for the whole
    // 'reconnecting' window too; next()/previous() must keep rejecting throughout, not just
    // start rejecting again once performReconnect() eventually runs.
    this.interruptedForDonation = wasInterruptedForDonation;

    const decision: ReconnectDecision = (this.deps.reconnectPolicy && capturedTrack)
      ? this.evaluateReconnect(uptimeMs)
      : { retry: false };

    if (decision.retry && capturedTrack) {
      const track = capturedTrack;
      this.state = 'reconnecting';
      this.deps.onStatusChanged?.();
      const timer = setTimeout(() => {
        this.pendingReconnect = null;
        // The session moved on (a manual stop()/start() bumps sessionGeneration) while this
        // attempt was waiting — same stale-async-result guard feedCurrentTrack already uses.
        if (this.sessionGeneration !== generationAtExit) return;
        this.performReconnect(track, capturedElapsedSeconds).catch((err) => {
          console.error('failed to respawn the encoder after a reconnect attempt', err);
        });
      }, decision.delayMs);
      this.pendingReconnect = { timer, scheduledGeneration: generationAtExit };
      return;
    }

    this.state = 'error';
    this.deps.onError?.(exitCode);
    this.deps.onStatusChanged?.();
  }

  private evaluateReconnect(uptimeMs: number): ReconnectDecision {
    if (uptimeMs < SHORT_LIVED_UPTIME_MS) {
      this.consecutiveShortLivedFailures += 1;
    } else {
      this.consecutiveShortLivedFailures = 0;
    }
    if (this.reconnectFirstFailureAt === null) this.reconnectFirstFailureAt = Date.now();
    this.reconnectAttempt += 1;
    const totalElapsedMs = Date.now() - this.reconnectFirstFailureAt;

    return this.deps.reconnectPolicy!.decide({
      attempt: this.reconnectAttempt,
      uptimeMs,
      totalElapsedMs,
      consecutiveShortLivedFailures: this.consecutiveShortLivedFailures,
    });
  }

  // Respawns the encoder pipeline in place (same session — no re-read of the DB, no fresh
  // provider.prepareSession(), no new YouTube broadcast) and resumes playback at the position it
  // was at when the encoder died — reusing feedCurrentTrack's existing -ss-based seek path, the
  // same mechanism next()/resume() already use, rather than inventing a new one.
  private async performReconnect(capturedTrack: Track, capturedElapsedSeconds: number): Promise<void> {
    this.spawnPipeline();
    this.state = 'streaming';
    this.deps.onStatusChanged?.();

    // A donation interruption survives the crash (handleUnexpectedExit restores
    // interruptedForDonation right after teardown(), and next()/previous() reject outright while
    // it's set — so unlike the plain-playlist case below, the queue genuinely cannot have moved
    // on): resume exactly the captured donation track at exactly its captured offset.
    if (this.interruptedForDonation !== null) {
      await this.feedCurrentTrack(capturedTrack, capturedElapsedSeconds);
      this.resetReconnectBookkeeping();
      return;
    }

    const current = this.deps.queue.current();
    if (!current) return;
    // next()/previous() are allowed while 'reconnecting' (they just mutate the queue without
    // feeding, since nothing is streaming yet) — if that happened while this attempt was
    // pending, the queue has moved on to a DIFFERENT track than the one that was playing when
    // the encoder died, so the captured offset no longer applies; start the new current track
    // from 0 instead of seeking into it at a stale position.
    const offsetSeconds = current === capturedTrack ? capturedElapsedSeconds : 0;
    await this.feedCurrentTrack(current, offsetSeconds);

    // A full recovery — reset the reconnect budget so a LATER, unrelated disconnect gets its own
    // fresh attempt/time budget instead of inheriting this incident's counters.
    this.resetReconnectBookkeeping();
  }

  playByName(name: string): void {
    const track = this.deps.library.findByName(name);
    if (!track) throw new ApiError(404, `track not found: ${name}`);
    this.deps.queue.insertNext(track);
    this.deps.onStatusChanged?.();
  }

  // Like playByName, but the caller already has a Track object in hand (an ephemeral, DB-less
  // track built by the donation song-request flow) instead of a name to look up in the library —
  // and, unlike playByName, it interrupts whatever is playing right now rather than waiting for it
  // to end. Only the FIRST donation track of an episode triggers the interrupt: while
  // interruptedForDonation is already set, later arrivals just extend the donation FIFO and will
  // play in their turn once the one ahead of them finishes (see advanceAfterTrackFinished).
  insertEphemeralTrack(track: Track): void {
    this.deps.queue.enqueueDonation(track);
    if ((this.state === 'streaming' || this.state === 'paused') && this.interruptedForDonation === null) {
      this.interruptCurrentTrackForDonation();
    }
    this.deps.onStatusChanged?.();
  }

  status(): StreamStatus {
    return {
      state: this.state,
      // nowPlayingTrack, not queue.current(): during a donation interruption they deliberately
      // differ, and it's what's actually audible that a status consumer needs to see.
      currentTrack: this.nowPlayingTrack?.name ?? null,
      nextTrack: this.deps.queue.peekNext()?.name ?? null,
    };
  }
}
