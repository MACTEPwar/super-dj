// Decides whether an unexpected PersistentEncoder exit is worth retrying (an in-place respawn
// against the SAME already-prepared session), and if so, how long to wait before the next
// attempt. StreamController owns the *mechanism* (bookkeeping, scheduling, respawning, resuming
// the track at its captured position) — this module owns the *policy*: what counts as
// retryable, and the attempt/time budget. See CLAUDE.md's "Backend streaming pipeline" section
// for why exit codes carry no useful signal here (ffmpeg exits 1 for almost everything) — the
// context below is uptime/attempt-count-based instead.

export interface ReconnectAttemptContext {
  // 1-based: the attempt about to be scheduled if this decide() call returns retry:true.
  attempt: number;
  // How long the PersistentEncoder that just exited had been running, in ms. A short-lived
  // process (see SHORT_LIVED_UPTIME_MS) means a deterministic startup failure (bad stream key,
  // malformed filter graph) — not worth retrying, since respawning would just fail the same way.
  uptimeMs: number;
  // Time since the FIRST failure of this reconnect sequence, in ms — reset once a respawned
  // encoder runs long enough to be considered recovered.
  totalElapsedMs: number;
  // Count of consecutive failures under SHORT_LIVED_UPTIME_MS, including this one. Resets to 0
  // on any failure that ran longer than that threshold.
  consecutiveShortLivedFailures: number;
}

export type ReconnectDecision = { retry: true; delayMs: number } | { retry: false };

export interface ReconnectPolicy {
  decide(ctx: ReconnectAttemptContext): ReconnectDecision;
}

// ~10s: long enough for ffmpeg to have opened the RTMP connection and started pushing, short
// enough that dying before this point means it never really got going (a startup-time failure,
// not a transport that broke after being established).
export const SHORT_LIVED_UPTIME_MS = 10_000;
// 2 consecutive short-lived failures means every respawn attempt is hitting the same
// deterministic problem — give up immediately rather than burning the rest of the attempt/time
// budget on retries that can't succeed.
export const CRASH_LOOP_THRESHOLD = 2;
// 6-8 attempts, whichever budget (this or MAX_TOTAL_MS) is exhausted first.
export const MAX_ATTEMPTS = 7;
// ~5 minutes total.
export const MAX_TOTAL_MS = 5 * 60 * 1000;
// Capped exponential backoff for the LOCAL ENCODER: 2s, 5s, 10s, 20s, 30s, then 30s forever after.
const BACKOFF_SCHEDULE_MS = [2_000, 5_000, 10_000, 20_000, 30_000];
const BACKOFF_CAP_MS = 30_000;
// A DESTINATION FORWARD's own schedule: 0.5s, 1s, 2s, 5s, 10s, then 10s forever after. A relay is
// one `-c copy` ffmpeg reconnecting to a container-local MediaMTX — cheap to respawn and worth
// retrying sub-second. The encoder's schedule above is deliberately slower because a respawn there
// rebuilds a whole render/encode pipeline.
export const FORWARD_BACKOFF_SCHEDULE_MS = [500, 1_000, 2_000, 5_000, 10_000];
export const FORWARD_BACKOFF_CAP_MS = 10_000;
// +/-20% jitter so several destinations that dropped at the same moment (e.g. a shared network
// blip) don't all hammer their ingest again in lockstep.
const JITTER_RATIO = 0.2;

function backoffDelayMs(attempt: number, random: () => number, schedule: number[], capMs: number): number {
  const base = schedule[attempt - 1] ?? capMs;
  const jitter = base * JITTER_RATIO * (random() * 2 - 1);
  return Math.max(500, Math.round(base + jitter));
}

export interface ReconnectPolicyOptions {
  // Provider-specific veto — e.g. YouTube's DestinationLifecycle being in a terminal phase
  // ('error'/'complete') or having seen an auth-class failure. Absent (CustomRtmpProvider has no
  // lifecycle/broadcast concept at all) means "no provider-side objection" — reconnect is then
  // gated purely on the generic uptime/crash-loop/budget signals below. Called fresh on every
  // decide(), since provider state can change between failures.
  isRetryableDestination?: () => boolean;
  // Override the delay schedule. Present so a destination forward can retry on its own, much
  // faster, schedule while sharing every other budget rule in this module — see
  // createForwardReconnectPolicy below. Note there is deliberately NO "is the source available"
  // veto here: a forward whose SOURCE is down must neither retry nor give up but HOLD, and a
  // retry/give-up policy has no way to express that third outcome. DestinationForward checks the
  // source itself, where the distinction can actually be made.
  backoffScheduleMs?: number[];
  backoffCapMs?: number;
  random?: () => number;
}

export function createReconnectPolicy(options: ReconnectPolicyOptions = {}): ReconnectPolicy {
  const isRetryableDestination = options.isRetryableDestination ?? (() => true);
  const random = options.random ?? Math.random;
  const schedule = options.backoffScheduleMs ?? BACKOFF_SCHEDULE_MS;
  const capMs = options.backoffCapMs ?? BACKOFF_CAP_MS;
  return {
    decide(ctx: ReconnectAttemptContext): ReconnectDecision {
      if (!isRetryableDestination()) return { retry: false };
      if (ctx.consecutiveShortLivedFailures >= CRASH_LOOP_THRESHOLD) return { retry: false };
      if (ctx.attempt > MAX_ATTEMPTS) return { retry: false };
      if (ctx.totalElapsedMs >= MAX_TOTAL_MS) return { retry: false };
      return { retry: true, delayMs: backoffDelayMs(ctx.attempt, random, schedule, capMs) };
    },
  };
}

// The same policy with a destination forward's faster schedule. Two call sites, one module — the
// spec is explicit that this is "a genuinely bigger surface", not a pure simplification, so keep
// the budget rules shared rather than forking the module.
export function createForwardReconnectPolicy(
  options: Omit<ReconnectPolicyOptions, 'backoffScheduleMs' | 'backoffCapMs'> = {},
): ReconnectPolicy {
  return createReconnectPolicy({
    ...options,
    backoffScheduleMs: FORWARD_BACKOFF_SCHEDULE_MS,
    backoffCapMs: FORWARD_BACKOFF_CAP_MS,
  });
}
