import {
  createReconnectPolicy,
  createForwardReconnectPolicy,
  SHORT_LIVED_UPTIME_MS,
  CRASH_LOOP_THRESHOLD,
  MAX_ATTEMPTS,
  MAX_TOTAL_MS,
  FORWARD_BACKOFF_SCHEDULE_MS,
  FORWARD_BACKOFF_CAP_MS,
} from '../../src/stream/reconnectPolicy';

describe('createReconnectPolicy (the default retry-or-give-up policy)', () => {
  it('retries a single short-lived failure (attempt 1) — one blip alone is not yet a crash loop', () => {
    const policy = createReconnectPolicy();
    const decision = policy.decide({
      attempt: 1, uptimeMs: SHORT_LIVED_UPTIME_MS - 1, totalElapsedMs: 0, consecutiveShortLivedFailures: 1,
    });
    expect(decision.retry).toBe(true);
  });

  it('gives up once consecutiveShortLivedFailures reaches the crash-loop threshold, regardless of the attempt/time budget still remaining', () => {
    const policy = createReconnectPolicy();
    const decision = policy.decide({
      attempt: 2, uptimeMs: SHORT_LIVED_UPTIME_MS - 1, totalElapsedMs: 3000,
      consecutiveShortLivedFailures: CRASH_LOOP_THRESHOLD,
    });
    expect(decision).toEqual({ retry: false });
  });

  it('retries a longer-lived failure normally', () => {
    const policy = createReconnectPolicy();
    const decision = policy.decide({
      attempt: 1, uptimeMs: 20_000, totalElapsedMs: 0, consecutiveShortLivedFailures: 0,
    });
    expect(decision.retry).toBe(true);
  });

  it('gives up once the attempt count exceeds MAX_ATTEMPTS', () => {
    const policy = createReconnectPolicy();
    const decision = policy.decide({
      attempt: MAX_ATTEMPTS + 1, uptimeMs: 20_000, totalElapsedMs: 1000, consecutiveShortLivedFailures: 0,
    });
    expect(decision).toEqual({ retry: false });
  });

  it('retries at exactly MAX_ATTEMPTS (the boundary is inclusive)', () => {
    const policy = createReconnectPolicy();
    const decision = policy.decide({
      attempt: MAX_ATTEMPTS, uptimeMs: 20_000, totalElapsedMs: 1000, consecutiveShortLivedFailures: 0,
    });
    expect(decision.retry).toBe(true);
  });

  it('gives up once the total elapsed time reaches MAX_TOTAL_MS, even with attempts still available', () => {
    const policy = createReconnectPolicy();
    const decision = policy.decide({
      attempt: 2, uptimeMs: 20_000, totalElapsedMs: MAX_TOTAL_MS, consecutiveShortLivedFailures: 0,
    });
    expect(decision).toEqual({ retry: false });
  });

  it('caps the backoff delay at 30s and never returns a negative/zero delay', () => {
    const policy = createReconnectPolicy({ random: () => 1 }); // max positive jitter
    // Beyond the explicit backoff schedule's length (5 entries) but still within MAX_ATTEMPTS —
    // falls back to the flat 30s cap.
    const decision = policy.decide({
      attempt: MAX_ATTEMPTS, uptimeMs: 20_000, totalElapsedMs: 0, consecutiveShortLivedFailures: 0,
    });
    expect(decision.retry).toBe(true);
    if (decision.retry) {
      expect(decision.delayMs).toBeLessThanOrEqual(30_000 * 1.2);
      expect(decision.delayMs).toBeGreaterThan(0);
    }
  });

  it('produces an increasing backoff schedule for the first few attempts (no jitter)', () => {
    const policy = createReconnectPolicy({ random: () => 0.5 }); // random()*2-1 === 0, no jitter
    const delays = [1, 2, 3, 4, 5].map((attempt) => {
      const decision = policy.decide({ attempt, uptimeMs: 20_000, totalElapsedMs: 0, consecutiveShortLivedFailures: 0 });
      return decision.retry ? decision.delayMs : -1;
    });
    expect(delays).toEqual([2000, 5000, 10000, 20000, 30000]);
  });

  it('defers to isRetryableDestination when provided — a provider-side veto wins over an otherwise-retryable uptime/budget state', () => {
    const policy = createReconnectPolicy({ isRetryableDestination: () => false });
    const decision = policy.decide({
      attempt: 1, uptimeMs: 20_000, totalElapsedMs: 0, consecutiveShortLivedFailures: 0,
    });
    expect(decision).toEqual({ retry: false });
  });

  it('retries when isRetryableDestination is absent (e.g. a CustomRtmpProvider destination with no lifecycle at all)', () => {
    const policy = createReconnectPolicy();
    const decision = policy.decide({
      attempt: 1, uptimeMs: 20_000, totalElapsedMs: 0, consecutiveShortLivedFailures: 0,
    });
    expect(decision.retry).toBe(true);
  });
});

describe('createForwardReconnectPolicy (a destination forward\'s own, faster schedule)', () => {
  // A forward relay is one `-c copy` ffmpeg reconnecting to a container-local MediaMTX. It is
  // cheap to respawn and should be back sub-second — unlike the encoder, whose 2s-start schedule
  // is sized for rebuilding a whole render/encode pipeline.
  it('retries sub-second on the first attempt and keeps the same increasing shape', () => {
    const policy = createForwardReconnectPolicy({ random: () => 0.5 }); // random()*2-1 === 0, no jitter
    const delays = [1, 2, 3, 4, 5].map((attempt) => {
      const decision = policy.decide({ attempt, uptimeMs: 20_000, totalElapsedMs: 0, consecutiveShortLivedFailures: 0 });
      return decision.retry ? decision.delayMs : -1;
    });
    expect(delays).toEqual(FORWARD_BACKOFF_SCHEDULE_MS);
    expect(FORWARD_BACKOFF_SCHEDULE_MS[0]).toBeLessThan(1000);
  });

  it('caps at the forward cap rather than the encoder\'s 30s one', () => {
    const policy = createForwardReconnectPolicy({ random: () => 0.5 });
    const decision = policy.decide({
      attempt: FORWARD_BACKOFF_SCHEDULE_MS.length + 1, uptimeMs: 20_000, totalElapsedMs: 0, consecutiveShortLivedFailures: 0,
    });
    expect(decision).toEqual({ retry: true, delayMs: FORWARD_BACKOFF_CAP_MS });
  });

  it('keeps every generic budget the encoder policy has (crash loop, attempts, total time)', () => {
    const policy = createForwardReconnectPolicy();
    expect(policy.decide({ attempt: 2, uptimeMs: 1, totalElapsedMs: 10, consecutiveShortLivedFailures: CRASH_LOOP_THRESHOLD }))
      .toEqual({ retry: false });
    expect(policy.decide({ attempt: MAX_ATTEMPTS + 1, uptimeMs: 20_000, totalElapsedMs: 10, consecutiveShortLivedFailures: 0 }))
      .toEqual({ retry: false });
    expect(policy.decide({ attempt: 2, uptimeMs: 20_000, totalElapsedMs: MAX_TOTAL_MS, consecutiveShortLivedFailures: 0 }))
      .toEqual({ retry: false });
  });

  it('still honours a provider-side veto', () => {
    const policy = createForwardReconnectPolicy({ isRetryableDestination: () => false });
    expect(policy.decide({ attempt: 1, uptimeMs: 20_000, totalElapsedMs: 0, consecutiveShortLivedFailures: 0 }))
      .toEqual({ retry: false });
  });

  it('leaves the encoder-level schedule exactly as it was', () => {
    const policy = createReconnectPolicy({ random: () => 0.5 });
    const first = policy.decide({ attempt: 1, uptimeMs: 20_000, totalElapsedMs: 0, consecutiveShortLivedFailures: 0 });
    expect(first).toEqual({ retry: true, delayMs: 2000 });
  });
});
