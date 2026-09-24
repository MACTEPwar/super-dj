import { PlaylistQueue } from '../playlist/queue';
import { Track } from '../playlist/types';
import { CanvasFeeder } from '../ffmpeg/canvasFeeder';
import { AudioRelay } from '../ffmpeg/audioRelay';
import { PersistentEncoder } from '../ffmpeg/persistentEncoder';
import { PulseVisualizer } from '../ffmpeg/pulseVisualizer';
import { NowPlayingOverlay } from '../ffmpeg/segmentArgs';
import { formatDuration } from '../ffmpeg/overlayText';
import { InsertTransition } from '../ffmpeg/playlistWindowTransition';
import { WindowRow, PLAYLIST_WINDOW_BEFORE, PLAYLIST_WINDOW_AFTER } from '../playlist/window';
import { ApiError } from '../errors';
import { SessionState, StreamStatus } from './types';
import { ReconnectPolicy, ReconnectDecision, SHORT_LIVED_UPTIME_MS } from './reconnectPolicy';
import { PlaylistWindowAnimator, HANDOFF_HOLD_MS } from './playlistWindowAnimator';
import { MarqueeRowRect } from '../ffmpeg/marqueeFeeder';

export interface LibraryLike {
  list(): Track[];
  findByName(name: string): Track | undefined;
}

// The structural subset of PlaylistWindowFeeder this controller drives.
export interface PlaylistWindowFeederLike {
  attach(pipe: NodeJS.WritableStream): void;
  showRows(rows: WindowRow[]): Promise<void>;
  animate(plan: InsertTransition): Promise<void>;
  goIdle(): void;
  close(): void;
}

// The structural subset of MarqueeFeeder this controller drives.
export interface MarqueeFeederLike {
  attach(pipe: NodeJS.WritableStream): void;
  activate(text: string, rect: MarqueeRowRect, estimatedTextWidth: number): Promise<void>;
  deactivate(): void;
  close(): void;
}

export interface StreamControllerDeps {
  library: LibraryLike;
  queue: PlaylistQueue;
  createCanvasFeeder: () => CanvasFeeder;
  createAudioRelay: () => AudioRelay;
  createPersistentEncoder: () => PersistentEncoder;
  // These four are all sourced directly from StreamScene (see buildStreamScene()) and are
  // deliberately `T | undefined` rather than `field?:` — a real bug (found live on the demo
  // stand, see CLAUDE.md's marquee section) was LocalStreamManager silently omitting two of
  // these `?:`-optional fields from the object literal it built, which TypeScript accepted with
  // zero errors and which stalled the persistent encoder in production. A required-but-nullable
  // key forces every future caller to make an explicit decision, catching that same omission at
  // compile time instead of relying on a regression test to keep covering every new field added
  // here later.
  createPulseVisualizer: (() => PulseVisualizer) | undefined;
  // Present only when the template has an on-canvas playlist element — see buildStreamScene().
  createPlaylistWindowFeeder: (() => PlaylistWindowFeederLike) | undefined;
  createMarqueeFeeder: (() => MarqueeFeederLike) | undefined;
  resolveMarqueeRow: ((currentRowText: string, rowIndex: number) => Promise<{ rect: MarqueeRowRect; textWidth: number } | null>) | undefined;
  buildOverlay: (track: Track, windowRows: WindowRow[], opts?: { omitLivePlaylist?: boolean; currentRowOverrideText?: string }) => Promise<NowPlayingOverlay>;
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
  // Distinguishes "this track ended naturally" (advance to the next one) from "this track was
  // superseded/torn down by next/previous/pause/stop/start" (do nothing) — same role
  // segmentGeneration always had, renamed because there's no more per-segment process for
  // "segment" to describe. Also doubles as the reconnect mechanism's staleness guard: a scheduled
  // respawn captures this value at schedule time and bails if it no longer matches when its timer
  // fires (the same pattern feedCurrentTrack already uses for a stale overlay probe).
  private sessionGeneration = 0;

  // The playlist window's pipe:7 burst layer — both null when the template has no on-canvas
  // playlist element.
  private playlistWindowFeeder: PlaylistWindowFeederLike | null = null;
  private playlistAnimator: PlaylistWindowAnimator | null = null;
  private marqueeFeeder: MarqueeFeederLike | null = null;
  private marqueeOverrideText: string | undefined = undefined;
  // The rows the canvas currently shows in the live playlist element (variant B's rows).
  private bakedRows: WindowRow[] = [];
  // The track whose overlay is actually on screen — NOT always queue.current(), which a paused
  // next()/previous() moves without feeding.
  private bakedTrack: Track | null = null;
  // Separate from sessionGeneration on purpose: pause() bumps sessionGeneration, and a burst's
  // canvas-B bake must still land while paused. Only a track change / teardown invalidates a bake.
  private overlayGeneration = 0;

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
    const track = this.deps.queue.current();
    if (track) {
      await this.feedCurrentTrack(track, this.pausedElapsedSeconds);
    }
    this.deps.onStatusChanged?.();
  }

  async next(): Promise<void> {
    if (this.state === 'idle' || this.state === 'error') throw new ApiError(409, 'stream is not active');
    const before = this.deps.queue.current();
    const track = this.deps.queue.next();
    if (!track) throw new ApiError(409, 'no tracks in queue');
    if (before && before !== track) this.releaseTrack(before);
    this.pausedElapsedSeconds = 0;
    if (this.state === 'streaming') {
      await this.feedCurrentTrack(track);
    }
    this.deps.onStatusChanged?.();
  }

  async previous(): Promise<void> {
    if (this.state === 'idle' || this.state === 'error') throw new ApiError(409, 'stream is not active');
    const before = this.deps.queue.current();
    const track = this.deps.queue.previous();
    if (before && track && before !== track) this.releaseTrack(before);
    this.pausedElapsedSeconds = 0;
    if (track && this.state === 'streaming') {
      await this.feedCurrentTrack(track);
    }
    this.deps.onStatusChanged?.();
  }

  private async feedCurrentTrack(track: Track, startOffsetSeconds = 0): Promise<void> {
    // A track change (or resume) supersedes any in-progress window burst: the layer goes
    // transparent at once and any pending canvas A/B bake from it is invalidated, so the new
    // track's full overlay (window included) is what lands — no stale moving rows on top.
    this.playlistAnimator?.abort();
    this.overlayGeneration += 1;
    const rows = this.windowRows();
    const generation = ++this.sessionGeneration;

    if (this.deps.resolveMarqueeRow) {
      const rowIndex = rows.findIndex((r) => r.isCurrent);
      const currentRow = rowIndex >= 0 ? rows[rowIndex] : undefined;
      if (currentRow) {
        const resolved = await this.deps.resolveMarqueeRow(currentRow.text, rowIndex);
        if (generation !== this.sessionGeneration) return;
        if (resolved) {
          await this.marqueeFeeder?.activate(currentRow.text, resolved.rect, resolved.textWidth);
          if (generation !== this.sessionGeneration) return;
          this.marqueeOverrideText = '▶';
        } else {
          this.marqueeFeeder?.deactivate();
          this.marqueeOverrideText = undefined;
        }
      } else {
        this.marqueeFeeder?.deactivate();
        this.marqueeOverrideText = undefined;
      }
    }

    const overlay = this.marqueeOverrideText !== undefined
      ? await this.deps.buildOverlay(track, rows, { currentRowOverrideText: this.marqueeOverrideText })
      : await this.deps.buildOverlay(track, rows);
    // The generation may have advanced, or the session may have left 'streaming', while we were
    // awaiting the overlay — a stale overlay must never be fed.
    if (generation !== this.sessionGeneration) return;
    if (this.state !== 'streaming') return;

    // Re-feeding the SAME track (resume, or previous() landing back on it) leaves
    // bakedTrack === queue.current() during the wait above, so an enqueueTrack() could have started
    // a burst meanwhile. Cancel it here, before this full render lands, so the catch-up below
    // restarts it cleanly instead of racing it (baked rows under moving pipe:7 rows).
    this.playlistAnimator?.abort();
    this.overlayGeneration += 1;
    this.currentOverlay = overlay;
    this.bakedRows = rows;
    this.bakedTrack = track;
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
      this.releaseTrack(track);
      this.advanceToNextTrack();
    });

    // An enqueueTrack() that arrived while this feed was awaiting its overlay skipped its burst
    // (bakedTrack was still the previous track then), so `rows` may predate it. Catch the window
    // up; a plain no-op ('none' plan, no bake) when nothing was queued in the meantime.
    if (this.playlistAnimator && generation === this.sessionGeneration && this.state === 'streaming') {
      this.playlistAnimator.queueChanged(this.windowRows());
    }
  }

  private windowRows(): WindowRow[] {
    return this.deps.queue.windowSnapshot(PLAYLIST_WINDOW_BEFORE, PLAYLIST_WINDOW_AFTER);
  }

  // The animator's hook back into the canvas: builds the current track's overlay from `rows`
  // (variant A omits the live playlist element), makes it currentOverlay — so the once-a-second
  // timer tick and pause()'s frozen frame re-render the RIGHT variant — and renders it. Returns
  // false when a track change (feedCurrentTrack bumps overlayGeneration) made the result stale.
  private async bakeCanvas(rows: WindowRow[], opts: { omitLivePlaylist: boolean }): Promise<boolean> {
    const generation = this.overlayGeneration;
    // The track actually on screen — NOT queue.current(), which a paused next()/previous() moves
    // without feeding (nothing changes on screen until resume).
    const track = this.bakedTrack;
    if (!track || !this.canvasFeeder) return false;
    const buildOpts = this.marqueeOverrideText !== undefined
      ? { omitLivePlaylist: opts.omitLivePlaylist, currentRowOverrideText: this.marqueeOverrideText }
      : opts;
    const overlay = await this.deps.buildOverlay(track, rows, buildOpts);
    if (generation !== this.overlayGeneration || !this.canvasFeeder) return false;
    if (this.state !== 'streaming' && this.state !== 'paused') return false;
    this.currentOverlay = overlay;
    if (!opts.omitLivePlaylist) this.bakedRows = rows;
    const elapsed = this.state === 'paused' ? this.pausedElapsedSeconds : this.elapsedTrackSeconds();
    await this.canvasFeeder.render(overlay, this.timerText(elapsed));
    return true;
  }

  // Fires a one-off track's cleanup hook once it stops being the current track — naturally (the
  // decode 'close' above) or because next()/previous() moved off it mid-play. Self-disarming:
  // track objects can be re-fed (a non-ephemeral one via previous()), so the hook is cleared
  // before it's invoked and can never fire twice. A throwing hook is logged, never propagated —
  // it must not skip auto-advance or reject a transport command.
  private releaseTrack(track: Track): void {
    const onFinished = track._onFinished;
    track._onFinished = undefined;
    try {
      onFinished?.();
    } catch (err) {
      console.error('a track\'s _onFinished hook threw', err);
    }
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
    this.playlistAnimator?.abort();
    this.playlistWindowFeeder?.close();
    this.playlistAnimator = null;
    this.playlistWindowFeeder = null;
    this.marqueeFeeder?.close();
    this.marqueeFeeder = null;
    this.marqueeOverrideText = undefined;
    this.bakedRows = [];
    this.bakedTrack = null;
    this.overlayGeneration += 1;
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
    if (this.deps.createPlaylistWindowFeeder) {
      const feeder = this.deps.createPlaylistWindowFeeder();
      feeder.attach(child.playlistWindowPipe);
      this.playlistWindowFeeder = feeder;
      this.playlistAnimator = new PlaylistWindowAnimator({
        feeder,
        bakeCanvas: (rows, opts) => this.bakeCanvas(rows, opts),
        getBakedRows: () => this.bakedRows,
        sleep: (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref(); }),
        holdMs: HANDOFF_HOLD_MS,
      });
    }
    if (this.deps.createMarqueeFeeder) {
      this.marqueeFeeder = this.deps.createMarqueeFeeder();
      this.marqueeFeeder.attach(child.marqueePipe);
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
    // Must be captured BEFORE teardown() resets trackStartedAt/trackStartOffsetSeconds — this is
    // the position a successful reconnect needs to resume from.
    const capturedElapsedSeconds = this.elapsedTrackSeconds();
    const capturedTrack = this.deps.queue.current();
    const generationAtExit = this.sessionGeneration;

    this.teardown();

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
    this.enqueueTrack(track);
  }

  // The ONE "queue this next" path: plays after the current track ends, never interrupts, joins
  // history normally unless ephemeral (see PlaylistQueue.next()). Used by playByName and by every
  // donation request (free-text via songRequestAction.ts, exact via libraryTrackRequestAction.ts,
  // Phase A).
  enqueueTrack(track: Track): void {
    this.deps.queue.insertNext(track);
    // Animate only when a picture is actually being produced, AND only while the queue's current
    // track is still the one on screen. After a paused next()/previous() the snapshot's current row
    // has moved but the screen deliberately hasn't (nothing changes until resume). Baking now
    // would show the NEXT track's title/cover under the old audio. In both skip cases the next
    // feedCurrentTrack() simply bakes the new snapshot.
    if (this.playlistAnimator && (this.state === 'streaming' || this.state === 'paused')
      && this.deps.queue.current() === this.bakedTrack) {
      this.playlistAnimator.queueChanged(this.windowRows());
    }
    this.deps.onStatusChanged?.();
  }

  status(): StreamStatus {
    // Only while a session exists: an idle or errored controller keeps its own queue
    // (LocalStreamManager retains only an errored entry — an idle one is discarded on stop()), and
    // reporting queue.current() then would claim a track is playing when none is.
    const live = this.state === 'streaming' || this.state === 'paused' || this.state === 'reconnecting';
    return {
      state: this.state,
      currentTrack: live ? this.deps.queue.current()?.name ?? null : null,
      nextTrack: this.deps.queue.peekNext()?.name ?? null,
    };
  }
}
