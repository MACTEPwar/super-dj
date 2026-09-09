interface ActivePulse {
  band: number;
  amplitude: number;
  spread: number;
  attackSeconds: number;
  decaySeconds: number;
  startedAt: number;
}

export interface PulseEngineOptions {
  bandCount: number;
  // How fast each band's "floor" (recent-loudness baseline) decays back down between hits — lower
  // is slower. Tuned so a sustained loud note doesn't retrigger every tick, but a real transient
  // (a new kick, a snare) still clears the floor and triggers again shortly after.
  floorDecayPerSecond?: number;
  triggerRatio?: number; // magnitude must exceed floor * this ratio to trigger
}

const DEFAULT_FLOOR_DECAY_PER_SECOND = 2.2;
const DEFAULT_TRIGGER_RATIO = 1.6;
// A narrow spread (1-2 neighboring bands) keeps a spike a thin angular blade rather than a wide
// soft hump — carried over unchanged from the approved browser prototype.
const PULSE_SPREAD = 1.3;
const BASE_SPIKE_AMPLITUDE = 0.8;
const STRENGTH_SPIKE_AMPLITUDE = 0.4; // the part of a spike's height the onset's own strength earns

/**
 * How far past its own trigger threshold an onset landed, normalized to [0, 1): 0 = it only just
 * cleared the threshold (a glancing hit), approaching 1 = it came out of a band that was at (or
 * near) zero, the hardest onset there is. Deliberately scale-free — a quiet band and a loud one
 * are directly comparable, and no per-track tuning is involved — which is what lets it drive the
 * pulse's shape on real, wildly varying music.
 */
function onsetStrength(magnitude: number, threshold: number): number {
  if (threshold <= 0) return 1;
  return 1 - threshold / magnitude;
}

// Turns a stream of per-band FFT magnitudes into the approved "neon pulse" visual: a flat
// baseline that only moves when a band's magnitude genuinely spikes above its own recent
// baseline (an onset), not a smooth spectrum display. See the design spec's "why the previous
// mechanism doesn't fit this style" section.
export class PulseEngine {
  private readonly floor: number[];
  // The strength (see onsetStrength) of each band's most recent onset — the moving reference every
  // new onset on that band is compared against to decide which way its spike points.
  private readonly previousOnsetStrength: number[];
  private pulses: ActivePulse[] = [];
  private readonly floorDecayPerSecond: number;
  private readonly triggerRatio: number;

  constructor(private readonly options: PulseEngineOptions) {
    this.floor = new Array(options.bandCount).fill(0);
    this.previousOnsetStrength = new Array(options.bandCount).fill(0);
    this.floorDecayPerSecond = options.floorDecayPerSecond ?? DEFAULT_FLOOR_DECAY_PER_SECOND;
    this.triggerRatio = options.triggerRatio ?? DEFAULT_TRIGGER_RATIO;
  }

  /**
   * Advances the engine by `dtSeconds` given the latest per-band magnitudes, and returns the
   * current visual value for every band. `nowSeconds` is the caller's own monotonic clock
   * (injected, not Date.now(), so this is exercised deterministically in tests).
   */
  update(magnitudes: number[], dtSeconds: number, nowSeconds: number): number[] {
    for (let band = 0; band < this.options.bandCount; band++) {
      const magnitude = magnitudes[band] ?? 0;
      const threshold = this.floor[band] * this.triggerRatio;
      if (magnitude > threshold) {
        this.spawnBeat(band, nowSeconds, onsetStrength(magnitude, threshold));
        this.floor[band] = magnitude;
      } else {
        this.floor[band] = Math.max(magnitude, this.floor[band] * Math.exp(-this.floorDecayPerSecond * dtSeconds));
      }
    }

    const values = new Array<number>(this.options.bandCount).fill(0);
    for (const pulse of this.pulses) {
      const dt = nowSeconds - pulse.startedAt;
      if (dt < 0) continue;
      const envelope = dt < pulse.attackSeconds
        ? dt / pulse.attackSeconds
        : Math.exp(-(dt - pulse.attackSeconds) / pulse.decaySeconds);
      if (envelope < 0.002) continue;
      for (let band = 0; band < this.options.bandCount; band++) {
        const distance = band - pulse.band;
        values[band] += pulse.amplitude * envelope * Math.exp(-(distance * distance) / (2 * pulse.spread * pulse.spread));
      }
    }

    this.pulses = this.pulses.filter((p) => nowSeconds - p.startedAt < p.attackSeconds + p.decaySeconds * 6);
    return values.map((v) => Math.max(-1.3, Math.min(1.5, v)));
  }

  // One "beat" = a sharp spike, then a smaller sharp notch back the other way — the up/down
  // requirement, carried over unchanged from the approved browser prototype. What is NOT carried
  // over is that prototype's coin-flip sign and jittered notch position: on a live stream that
  // read as the element moving in "random parts" rather than reacting to the music, even though
  // the trigger itself was already audio-driven. Every part of the shape is now a pure function of
  // the real per-band signal — identical audio in draws an identical line out, with no
  // Math.random() anywhere in this class:
  //
  //  - Direction: up when this onset hit *harder* than the same band's previous onset, down when
  //    it hit softer. That's musical dynamics (an accent punches up, a glancing hit flicks down),
  //    and it self-balances: each band compares against its own moving reference, so neither
  //    direction can dominate the way a fixed loudness cutoff would on a quiet or a loud track.
  //  - Height and the notch's band offset: the onset's own strength, so a harder hit draws a
  //    taller blade with its recoil pushed further off-band. The offset stays inside the same
  //    ±spread/2 range the old random jitter used.
  //
  // Note the direction deliberately is NOT the band's tick-to-tick momentum: update() raises
  // `floor[band]` to that band's own magnitude every tick (`max(magnitude, decayed)` in the else
  // branch, `= magnitude` in the trigger branch), so `floor[band] >= previous magnitude` always
  // holds, and a trigger therefore implies `magnitude > previousMagnitude * triggerRatio`. A band
  // is *always* still rising at the instant it fires (for any triggerRatio >= 1), which would make
  // a momentum-derived sign a constant, not a reaction.
  private spawnBeat(band: number, nowSeconds: number, strength: number): void {
    const harderThanLastOnset = strength >= this.previousOnsetStrength[band];
    this.previousOnsetStrength[band] = strength;
    const amplitude = (harderThanLastOnset ? 1 : -1) * (BASE_SPIKE_AMPLITUDE + STRENGTH_SPIKE_AMPLITUDE * strength);
    const spread = PULSE_SPREAD;
    this.pulses.push({ band, amplitude, spread, attackSeconds: 0.03, decaySeconds: 0.09, startedAt: nowSeconds });
    this.pulses.push({
      band: band + (strength - 0.5) * spread,
      amplitude: -amplitude * 0.4,
      spread: spread * 0.9,
      attackSeconds: 0.02,
      decaySeconds: 0.1,
      startedAt: nowSeconds + 0.1,
    });
  }
}
