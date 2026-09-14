import { StreamDestination } from '@prisma/client';
import { RelayProcess } from '../ffmpeg/relayProcess';
import { BroadcastMeta, PreparedSession, StreamDestinationProvider } from '../destinations/streamDestinationProvider';
import { ReconnectDecision, ReconnectPolicy, SHORT_LIVED_UPTIME_MS } from './reconnectPolicy';

export type ForwardDesiredState = 'on' | 'off';
// 'pending'    — the user wants this destination, but nothing is publishing locally yet. ZERO
//                external side effects: no prepareSession(), no YouTube broadcast, nothing.
// 'preparing'  — prepareSession() is in flight (where YouTube auth errors surface).
// 'connecting' — a relay is running but the destination has not confirmed it yet.
// 'live'       — the destination confirmed it (YouTube phase 'live'; for a lifecycle-less custom
//                RTMP destination, a relay that survived SHORT_LIVED_UPTIME_MS).
// 'stopping'   — finalize() is in flight; without this state a re-toggle-on mid-finalize would
//                race a second broadcast against the first.
// 'error'      — gave up, with a reason. Cleared by EITHER of two things: the user toggling it off
//                and on again (setDesired()), or the local session it was reading from disappearing
//                entirely (pass()'s branch 1, which resets givenUp so a brand-new local session
//                doesn't inherit a stale failure) — not just the toggle alone.
export type ForwardActualState = 'off' | 'pending' | 'preparing' | 'connecting' | 'live' | 'stopping' | 'error';
// 'source' is declared for completeness (the spec names it, and the UI type needs to be able to
// represent it) but is currently UNREACHABLE by construction: a source outage is handled as a
// HOLD (pass()'s branch 4), never an error — finalizing a broadcast every time the local encoder
// hiccups would defeat the entire point of the hold rule. Nothing in this task sets this reason;
// don't add a code path that does without first re-deciding that hold rule.
export type ForwardErrorReason = 'auth' | 'provider' | 'relay' | 'source';

export interface ForwardProviderStatus {
  type: string;
  phase: string;
  watchUrl: string | null;
}

export interface ForwardError {
  reason: ForwardErrorReason;
  message: string;
}

export interface DestinationForwardStatus {
  destinationId: string;
  name: string;
  desired: ForwardDesiredState;
  state: ForwardActualState;
  // Present only while a provider lifecycle exists (i.e. YouTube). A custom RTMP destination has
  // no broadcast concept at all.
  provider?: ForwardProviderStatus;
  error?: ForwardError;
}

export interface DestinationForwardDeps {
  destination: StreamDestination;
  provider: StreamDestinationProvider;
  // The CURRENT local session's MediaMTX read URL, or null when this account has no live session
  // to read from (never started, stopped, or reconnect gave up). Deliberately NON-null while the
  // local stream is merely 'reconnecting' — see the hold rule in pass().
  sourceUrl: () => string | null;
  // True only while the encoder is actually publishing into MediaMTX ('streaming' or 'paused').
  isSourcePublishing: () => boolean;
  createRelay: (params: { inputUrl: string; outputUrl: string }) => RelayProcess;
  reconnectPolicy: ReconnectPolicy;
  onStatusChanged: () => void;
  // Injected so tests can drive time and timers without jest fake timers leaking across the
  // reconcile loop's awaits.
  now?: () => number;
  setTimer?: (fn: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

const defaultSetTimer = (fn: () => void, delayMs: number): NodeJS.Timeout => {
  const timer = setTimeout(fn, delayMs);
  // Never let a pending respawn or promotion timer hold the process open on shutdown — the same
  // discipline CanvasFeeder's heartbeat and LocalStreamManager's expiry timer already follow.
  timer.unref();
  return timer;
};

/**
 * One destination's forward for one user: policy and lifecycle only.
 *
 * Deliberately has ZERO knowledge of child processes beyond the injected `createRelay` factory —
 * the bytes are RelayProcess's problem. Every edge case the spec enumerates (double-toggle,
 * toggle-during-prepare, toggle-during-finalize, toggle-before-start, source loss, relay crash) is
 * the same root cause: an async transition in flight when intent changes. So there is exactly one
 * `reconcile()` loop, re-entered on every relevant event, instead of N special-cased handlers.
 *
 * Hard invariant this class exists to protect: a forward NEVER touches the local encode or any
 * sibling forward, no matter how it fails.
 */
export class DestinationForward {
  private desired: ForwardDesiredState = 'off';
  private actual: ForwardActualState = 'off';
  // The broadcast metadata for the NEXT (or current) prepareSession() call — set explicitly by
  // whoever calls setDesired('on', meta), and remembered across a respawn/toggle-off-then-on so a
  // caller that omits it (an internal reconcile, a restart) keeps using whatever was last chosen
  // rather than silently reverting to the bare fallback below.
  private meta: BroadcastMeta | null = null;
  private session: PreparedSession | null = null;
  private relay: RelayProcess | null = null;
  private relayStartedAt: number | null = null;
  private error: ForwardError | null = null;
  // Sticky "stop trying": set when prepareSession() failed, when the relay's reconnect budget ran
  // out, or when the provider's own lifecycle reached a terminal phase. Only setDesired() and a
  // vanished local session clear it, so a failed forward never silently re-arms itself on an
  // unrelated reconcile() (of which there is one per local status change).
  private givenUp = false;
  private busy = false;
  private running: Promise<void> | null = null;
  private pendingPass = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private promotionTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private firstFailureAt: number | null = null;
  private consecutiveShortLivedFailures = 0;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, delayMs: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;

  constructor(private readonly deps: DestinationForwardDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? defaultSetTimer;
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  get destinationId(): string {
    return this.deps.destination.id;
  }

  /**
   * Re-applies a freshly-read `StreamDestination` row. Called by `LocalStreamManager` on EVERY
   * `getOrCreateForward()` lookup — including for an already-existing forward — never only at
   * construction. This forward object can outlive many `prepareSession()` calls (a respawn, a
   * toggle-off-then-on, a 'pending' forward that finally starts), and `YoutubeProvider
   * .prepareSession()` persists the reusable `youtubeLiveStreamId` to the DATABASE, not back onto
   * whatever row object the caller happened to pass in. Without this method, this forward's own
   * `this.deps.destination` would keep the stale (pre-persist) copy forever, so the NEXT
   * `prepareSession()` on the SAME forward would never see the id it just wrote — defeating the
   * entire liveStream-reuse feature and, since `finalize()` no longer deletes the liveStream,
   * leaking a new one on every call.
   */
  setDestination(destination: StreamDestination): void {
    this.deps.destination = destination;
  }

  /**
   * Set directly and idempotently by the checkbox. Never blocks on the reconcile it triggers.
   * `meta` is the broadcast metadata (title/description/privacy/latency) to use the next time this
   * forward calls prepareSession() — provided by the caller at the moment of toggling ON, so a
   * YouTube destination's title/privacy/latency are chosen right when it actually goes live, not
   * once for a whole session. Omitted on an ordinary toggle-off, and optional on toggle-on too (a
   * respawn or an internal reconcile need not resupply it): when omitted, whatever this forward
   * last had — or the bare `{title: destination.name}` fallback if it never had any — is used.
   */
  setDesired(desired: ForwardDesiredState, meta?: BroadcastMeta): void {
    if (meta) this.meta = meta;
    if (this.desired === desired) return;
    this.desired = desired;
    this.error = null;
    this.givenUp = false;
    this.resetRetryBudget();
    this.deps.onStatusChanged();
    void this.reconcile();
  }

  /** Turn off, tear down and wait for the provider-side finalize to complete. */
  async shutdown(): Promise<void> {
    this.setDesired('off');
    await this.reconcile();
  }

  /**
   * True when this forward wants nothing, holds nothing, AND has finished settling — safe for the
   * manager to drop. `actual === 'off'` is load-bearing, not redundant with the session/relay
   * checks: `finalizeSession()` nulls `this.session` (and `stopRelay()` nulls `this.relay`)
   * BEFORE the finalize `await` resolves, while `this.actual` stays `'stopping'` throughout. A
   * check that only looked at session/relay would call a forward "inactive" while its finalize is
   * still in flight — pruning it out from under itself, so a re-toggle-on arriving during that
   * window builds a BRAND NEW forward via `getOrCreateForward` instead of reaching the surviving
   * object's `stopping` branch, racing a second `prepareSession()` against the first's still-
   * running `finalize()`. That is exactly the hazard the spec names ("without this state, a
   * re-toggle-on mid-finalize races a second broadcast against the first") — this method is the
   * one place that hazard can be silently reopened by a plausible-looking simplification.
   */
  isInactive(): boolean {
    return this.desired === 'off' && this.actual === 'off' && this.session === null && this.relay === null;
  }

  status(): DestinationForwardStatus {
    const status: DestinationForwardStatus = {
      destinationId: this.deps.destination.id,
      name: this.deps.destination.name,
      desired: this.desired,
      state: this.actual,
    };
    const lifecycle = this.session?.lifecycle;
    if (lifecycle) {
      status.provider = {
        type: this.deps.destination.provider,
        phase: lifecycle.phase(),
        watchUrl: lifecycle.watchUrl(),
      };
    }
    if (this.error) status.error = this.error;
    return status;
  }

  /**
   * Drive this forward toward its desired state. Safe to call from anywhere at any time: a call
   * that arrives while a pass is in flight just asks the running loop to go round again, and
   * returns that loop's promise so a caller (shutdown()) can await the whole settle.
   */
  reconcile(): Promise<void> {
    if (this.busy) {
      this.pendingPass = true;
      // `running` is only momentarily null here — for the synchronous stretch between `busy = true`
      // and the assignment below — and a caller in that window still gets its work done via
      // pendingPass; it just cannot await it. The only awaiting caller is shutdown(), which always
      // arrives after the loop has suspended.
      return this.running ?? Promise.resolve();
    }
    this.busy = true;
    this.running = this.run();
    return this.running;
  }

  private async run(): Promise<void> {
    try {
      do {
        this.pendingPass = false;
        await this.pass();
      } while (this.pendingPass);
    } catch (err) {
      // pass() guards every external call itself; anything reaching here is a programming error,
      // and it must never become an unhandled rejection that takes the whole process down — and
      // with it every other tenant's stream.
      console.error(`[stream] destination ${this.destinationId}: reconcile pass failed`, err);
    } finally {
      this.busy = false;
      this.running = null;
    }
  }

  // Ask for another pass. Inside a running loop this just makes it go round again; from a callback
  // (relay exit, provider phase change, retry timer) it starts one.
  private again(): void {
    this.pendingPass = true;
    if (!this.busy) void this.reconcile();
  }

  private async pass(): Promise<void> {
    const sourceUrl = this.deps.sourceUrl();

    // 1. The user doesn't want this destination, or the local session it would read from is gone
    //    for good (never started, stopped, or reconnect gave up). Either way: no relay, no
    //    broadcast, and a clean slate for the next session.
    if (this.desired === 'off' || sourceUrl === null) {
      this.clearRetryTimer();
      this.clearPromotionTimer();
      this.stopRelay();
      if (this.session) {
        this.setState('stopping');
        await this.finalizeSession();
        this.again();
        return;
      }
      this.givenUp = false;
      this.setError(null);
      this.resetRetryBudget();
      // 'pending', not 'off', when the user still wants it: the UI shows "will start with the
      // stream" and the next start() reconciles it into life with no extra orchestration.
      this.setState(this.desired === 'off' ? 'off' : 'pending');
      return;
    }

    // 2. This forward has given up (the provider rejected it, the provider ended the broadcast, or
    //    the relay's reconnect budget ran out). Sticky: never silently re-arm on an unrelated
    //    reconcile. Only a toggle, or the local session ending, clears it.
    if (this.givenUp) {
      this.clearRetryTimer();
      this.clearPromotionTimer();
      this.stopRelay();
      if (this.session) {
        this.setState('stopping');
        await this.finalizeSession();
        this.again();
        return;
      }
      this.setState('error');
      return;
    }

    // 3. The provider already ended this broadcast on its own (YouTube's health-check timeout, or
    //    an auth-class failure short-circuiting it), checked BEFORE the hold/relay branches below —
    //    not only from branch 7 (running). A terminal phase can arrive while a relay respawn is
    //    merely SCHEDULED (branch 6 returns early via `if (this.retryTimer) return;` without ever
    //    reaching the old single call site in branch 7's `syncProviderPhase()`), and without this
    //    check here, the pending timer fires later and pushes into a broadcast the provider has
    //    already completed or errored — the exact standing CLAUDE.md follow-up this whole task
    //    exists to close, reopened by a timing gap rather than a missing check.
    if (this.checkTerminalProviderPhase()) return;

    // 4. HOLD. The encoder is not publishing right now (the local stream is starting, or
    //    reconnecting after a crash). MediaMTX drops every reader within ~1s of the publisher
    //    disconnecting, so this forward's relay is already dead or about to be — but the broadcast
    //    must NOT be finalized and this forward's own reconnect budget must NOT be spent on a
    //    problem that isn't its. The manager re-runs reconcile() when the local stream comes back.
    if (!this.deps.isSourcePublishing()) {
      this.clearRetryTimer();
      this.clearPromotionTimer();
      this.stopRelay();
      this.setState(this.session ? 'connecting' : 'pending');
      return;
    }

    // 5. Nothing prepared yet — ask the provider for this session's ingest target (and, for
    //    YouTube, create and bind the ephemeral broadcast). The FIRST external side effect this
    //    forward ever has.
    if (!this.session) {
      this.setState('preparing');
      let session: PreparedSession;
      try {
        session = await this.deps.provider.prepareSession(
          this.deps.destination,
          this.meta ?? { title: this.deps.destination.name },
        );
      } catch (err) {
        this.giveUp(this.deps.provider.isAuthError?.(err) ? 'auth' : 'provider', err);
        return;
      }
      // HARD INVARIANT (spec, "preparing"): register what prepareSession() returned BEFORE any
      // re-check of desired state. A `desired -> off` that arrived while this call was in flight
      // must find a lifecycle to finalize — dropping it here orphans a live YouTube broadcast with
      // nothing left that could ever end it. Branch 1 on the next pass does the finalizing.
      this.session = session;
      session.lifecycle?.onPhaseChange?.(() => this.onProviderPhaseChanged(session));
      this.again();
      return;
    }

    // 6. Prepared and publishing, but no relay running. A scheduled respawn owns the next attempt
    //    when one is pending — starting a second relay here would double-push to the destination.
    if (!this.relay) {
      if (this.retryTimer) return;
      this.startRelay(sourceUrl);
      this.setState('connecting');
      // onPushStarted fires on RELAY spawn, not encoder spawn: the encoder no longer touches any
      // real destination, so this is the only moment that means "bytes are on their way here".
      // It is idempotent in every provider (YoutubeProvider guards with its own pushStarted flag),
      // so a respawn does not restart the health-check poll.
      this.session.lifecycle?.onPushStarted();
      // A lifecycle-less destination (custom RTMP) has nothing to poll, so "the relay survived
      // SHORT_LIVED_UPTIME_MS" is the only "it connected" signal there is — the same heuristic the
      // encoder's reconnect policy uses to tell a startup failure from a later transport break.
      if (!this.session.lifecycle) this.schedulePromotion();
      return;
    }

    // 7. Running. Keep the reported state in step with the provider's own phase.
    this.syncProviderPhase();
  }

  // Returns true if a terminal phase was found and handled (giveUp() already called) — the caller
  // must return immediately rather than fall through to whatever branch it was about to try.
  private checkTerminalProviderPhase(): boolean {
    const lifecycle = this.session?.lifecycle;
    if (!lifecycle) return false;
    const phase = lifecycle.phase();
    if (phase !== 'error' && phase !== 'complete') return false;
    this.giveUp(
      lifecycle.isAuthError?.() ? 'auth' : 'provider',
      new Error(`the destination ended this broadcast (phase: ${phase})`),
    );
    return true;
  }

  private syncProviderPhase(): void {
    // The terminal case is handled earlier in pass() (branch 3, checkTerminalProviderPhase()) —
    // this call is defense in depth for the one phase transition that can arrive while THIS branch
    // is what's running (a relay already up), not a second copy of the same check.
    if (this.checkTerminalProviderPhase()) return;
    const lifecycle = this.session?.lifecycle;
    if (!lifecycle) return;
    const phase = lifecycle.phase();
    if (phase === 'live' && this.actual !== 'live') {
      this.resetRetryBudget();
      this.setState('live');
    }
  }

  private onProviderPhaseChanged(session: PreparedSession): void {
    // A stale callback from a PREVIOUS toggle cycle's lifecycle must never move this forward's
    // state — the same stale-async-result hazard the old, now-deleted per-destination stream
    // manager's own phase-change hook had.
    if (this.session !== session) return;
    this.deps.onStatusChanged();
    this.again();
  }

  private startRelay(inputUrl: string): void {
    const session = this.session!;
    // The same `${rtmpUrl}/${streamKey}` join buildPersistentEncoderArgs uses for its own output
    // URL: providers return the two halves separately and every consumer concatenates them the
    // same way.
    const outputUrl = `${session.rtmpUrl}/${session.streamKey}`;
    this.relay = this.deps.createRelay({ inputUrl, outputUrl });
    this.relayStartedAt = this.now();
    this.relay.start((code) => this.handleRelayExit(code));
  }

  private stopRelay(): void {
    this.relay?.stop();
    this.relay = null;
    this.relayStartedAt = null;
  }

  private handleRelayExit(exitCode: number | null): void {
    const uptimeMs = this.relayStartedAt !== null ? this.now() - this.relayStartedAt : 0;
    this.relay = null;
    this.relayStartedAt = null;
    this.clearPromotionTimer();

    // Not this destination's fault: the publisher went away (encoder crash, user stop, local
    // reconnect) and MediaMTX drops every reader within ~1s of that. Hold — the next pass parks
    // this forward without finalizing and without spending a retry.
    if (this.desired === 'off' || !this.deps.isSourcePublishing()) {
      this.again();
      return;
    }

    const decision = this.evaluateRetry(uptimeMs);
    if (decision.retry) {
      this.setState('connecting');
      this.retryTimer = this.setTimer(() => {
        this.retryTimer = null;
        this.again();
      }, decision.delayMs);
      return;
    }
    this.giveUp('relay', new Error(`the relay to this destination exited (code=${exitCode ?? 'null'}) and could not be re-established`));
  }

  private evaluateRetry(uptimeMs: number): ReconnectDecision {
    if (uptimeMs < SHORT_LIVED_UPTIME_MS) {
      this.consecutiveShortLivedFailures += 1;
    } else {
      this.consecutiveShortLivedFailures = 0;
    }
    if (this.firstFailureAt === null) this.firstFailureAt = this.now();
    this.attempt += 1;
    return this.deps.reconnectPolicy.decide({
      attempt: this.attempt,
      uptimeMs,
      totalElapsedMs: this.now() - this.firstFailureAt,
      consecutiveShortLivedFailures: this.consecutiveShortLivedFailures,
    });
  }

  private resetRetryBudget(): void {
    this.attempt = 0;
    this.firstFailureAt = null;
    this.consecutiveShortLivedFailures = 0;
  }

  private schedulePromotion(): void {
    this.clearPromotionTimer();
    this.promotionTimer = this.setTimer(() => {
      this.promotionTimer = null;
      if (this.relay && this.actual === 'connecting') {
        this.resetRetryBudget();
        this.setState('live');
      }
    }, SHORT_LIVED_UPTIME_MS);
  }

  private giveUp(reason: ForwardErrorReason, err: unknown): void {
    console.error(`[stream] destination ${this.destinationId}: forward gave up (${reason})`, err);
    this.setError({ reason, message: err instanceof Error ? err.message : String(err) });
    this.givenUp = true;
    this.again();
  }

  private async finalizeSession(): Promise<void> {
    const session = this.session;
    // Null it out BEFORE awaiting so nothing can double-finalize the same lifecycle.
    this.session = null;
    if (!session?.lifecycle) return;
    try {
      await session.lifecycle.finalize();
    } catch (err) {
      console.error(`[stream] destination ${this.destinationId}: failed to finalize the destination lifecycle`, err);
    }
  }

  private setState(state: ForwardActualState): void {
    if (this.actual === state) return;
    this.actual = state;
    this.deps.onStatusChanged();
  }

  private setError(error: ForwardError | null): void {
    if (this.error === null && error === null) return;
    this.error = error;
    this.deps.onStatusChanged();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      this.clearTimer(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private clearPromotionTimer(): void {
    if (this.promotionTimer) {
      this.clearTimer(this.promotionTimer);
      this.promotionTimer = null;
    }
  }
}
