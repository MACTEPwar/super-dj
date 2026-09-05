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

// Turns a stream of per-band FFT magnitudes into the approved "neon pulse" visual: a flat
// baseline that only moves when a band's magnitude genuinely spikes above its own recent
// baseline (an onset), not a smooth spectrum display. See the design spec's "why the previous
// mechanism doesn't fit this style" section.
export class PulseEngine {
  private readonly floor: number[];
  private pulses: ActivePulse[] = [];
  private readonly floorDecayPerSecond: number;
  private readonly triggerRatio: number;

  constructor(private readonly options: PulseEngineOptions) {
    this.floor = new Array(options.bandCount).fill(0);
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
      if (magnitude > this.floor[band] * this.triggerRatio) {
        this.spawnBeat(band, nowSeconds);
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
  // requirement. Sign is random per event so the line doesn't read as one repeating shape; a
  // narrow spread (1-2 neighboring bands) keeps the spike a thin angular blade rather than a
  // wide soft hump — both carried over unchanged from the approved browser prototype.
  private spawnBeat(band: number, nowSeconds: number): void {
    const sign = Math.random() < 0.5 ? 1 : -1;
    const spread = 1.3;
    this.pulses.push({ band, amplitude: sign, spread, attackSeconds: 0.03, decaySeconds: 0.09, startedAt: nowSeconds });
    this.pulses.push({
      band: band + (Math.random() - 0.5) * spread,
      amplitude: -sign * 0.4,
      spread: spread * 0.9,
      attackSeconds: 0.02,
      decaySeconds: 0.1,
      startedAt: nowSeconds + 0.1,
    });
  }
}
