export interface PulseEngineOptions {
  bandCount: number;
  // Gain: how much a band's current loudness translates into visual height. 0.5-3.0; at the
  // default (1.5) a band's steady content sits at 1/REFERENCE_HEADROOM of full height and a hit
  // at REFERENCE_HEADROOM times its average reaches the top, so lower values keep the line low
  // and higher ones saturate sooner ("hotter"). See EqualizerElement in templateTypes.ts.
  sensitivity?: number;
  // 0 = snappy (near-instant attack/release), 1 = smooth/slow-following. See attackSeconds/
  // releaseSeconds below for the concrete time constants this maps onto.
  smoothing?: number;
  // 0 = pure continuous spectrum, no accent; 1 = strong extra kick on real onsets.
  beatBoost?: number;
  // 0 = off, byte-identical to an engine without it; 1 = a strong whole-line "breathe" on every
  // detected broadband beat, layered on top of the per-band picture; up to
  // MAX_GLOBAL_PULSE_STRENGTH. On the engine's OWN scale, not the template's 0-20 `globalPulse`
  // field — templateTypes.ts's globalPulseStrength() is the one place the two are related (10
  // template steps per 1.0 here), and StreamManager applies it before constructing PulseVisualizer.
  globalPulse?: number;
  // How fast each band's "floor" (recent-loudness baseline) decays back down between hits — lower
  // is slower. Tuned so a sustained loud note doesn't retrigger every tick, but a real transient
  // (a new kick, a snare) still clears the floor and triggers again shortly after.
  floorDecayPerSecond?: number;
  triggerRatio?: number; // magnitude must exceed floor * this ratio to count as an onset
}

export const DEFAULT_SENSITIVITY = 1.5;
export const DEFAULT_SMOOTHING = 0.4;
export const DEFAULT_BEAT_BOOST = 0.5;
const DEFAULT_FLOOR_DECAY_PER_SECOND = 2.2;
const DEFAULT_TRIGGER_RATIO = 1.6;

// The ceiling the returned values are clamped to. layoutPulsePoints (src/render/pulseSvg.ts)
// maps a value v to a height of v / MAX_VALUE of the usable amplitude above the baseline, so the
// continuous level's own full height (1.0) sits 20% below the top of that amplitude and this
// leaves the beat accent exactly that 20% to poke above it — the accent is visible as an
// overshoot past where the level alone can reach, without the line ever leaving the box. (The
// old random-sign pulse engine clamped to [-1.3, 1.5] — an up-and-down spike aesthetic that let
// the line leave the box in both directions; nothing here goes below the baseline any more, so
// the lower bound is simply zero.)
export const MAX_VALUE = 1.25;

// Per-band normalization. Real per-band magnitudes span ~100x between bass and treble (measured
// on a real track: bass bands peak around 10, treble bands around 0.1) and vary just as much
// between tracks, so a fixed scale would leave most of the line dead or pinned. Each band is
// therefore drawn relative to (mostly — see SPECTRAL_SHAPE_SHARE) its own slow-moving AVERAGE
// magnitude (`reference`), with REFERENCE_HEADROOM of room above it: steady content in the
// loudest band — on any master — sits at 1/REFERENCE_HEADROOM of full height, and only a genuine
// transient (a kick at ~3x its band's average) reaches the top. Normalizing against the band's recent PEAK instead
// (the onset floor's idea, just slower) was tried first and measured against a real track: it is
// an AGC, and an AGC pins steady content near full height by definition — every band averaged
// 0.75 with dips right AFTER each kick (the hit raises the peak, so everything that follows reads
// lower), the opposite of a line that rises on the beat.
const REFERENCE_HEADROOM = 2.5;
// The average rises faster than it falls: a jump in loudness (a chorus, a new track) is absorbed
// within a couple of seconds so the bars don't stay pinned at the top, while a drop (a breakdown)
// is allowed to read as one for a while before the bars recover.
const REFERENCE_RISE_SECONDS = 1.0;
const REFERENCE_FALL_SECONDS = 3.0;
// Full per-band normalization erases the spectrum's shape entirely — on a steady intro every
// band sat at exactly the same height, a flat table, which is not what a spectrum analyzer looks
// like. So each band's reference is blended with the loudest band's, in log terms, and this is
// the share of the real spectral tilt that survives: 0 would equalize every band to the same
// height, 1 would draw raw absolute levels (and leave the treble half of the line dead, ~100x
// quieter than the bass). At 0.1 a band 10x quieter than the loudest draws at ~80% of its
// height and one 100x quieter at ~63% — bass-heavy left, still clearly alive on the right
// (0.15 was tried against the real track and, stacked with the noise gate, left the top bands
// barely moving).
const SPECTRAL_SHAPE_SHARE = 0.1;
// A band that holds nothing but quantization noise relative to the rest of the track (an
// 8 kHz-lowpassed mp3's top bands) must not be normalized up into a dancing bar: its reference is
// held at least this fraction (-50 dB) of the loudest band's — real, active treble averages
// around -40 dB relative to the bass on a real track and must stay clear of the gate, while
// quantization noise measures -60 dB and below — and never below the absolute
// floor — which is what keeps silence (all-zero PCM, or ±1 LSB dither measuring ~0.001) at
// exactly-flat instead of dividing by zero or amplifying the dither into a wiggle. The floor is
// still ~8x below what a -60 dBFS tone measures (0.43), so nothing audible is ever held down by
// it; the worst case measured against the real FFT path is an artificial pure 1-LSB tone, which
// at 112 bands and maximum sensitivity reads a few percent of full height.
const NOISE_GATE_RATIO = 0.003;
const MIN_REFERENCE = 0.05;

// `smoothing` maps linearly onto these attack/release time constants (seconds to cover ~63% of
// the distance to the target). Attack stays fast across the whole range so a hit always reads as
// a hit — even the slowest attack (80ms) still lands within 2-3 frames at 30fps; the release is
// what "smoothing" is mostly felt as, from a 30ms drop (falls ~67% per frame — the old flat-
// between-beats snappiness) to a 500ms fall (the classic analyzer "peak fall" look).
const ATTACK_SECONDS_SNAPPY = 0.005;
const ATTACK_SECONDS_SMOOTH = 0.08;
const RELEASE_SECONDS_SNAPPY = 0.03;
const RELEASE_SECONDS_SMOOTH = 0.5;

// The beat accent: an always-positive envelope added on top of the band's continuous level when
// its magnitude spikes well above its own recent floor (an onset). A sharp attack then an
// exponential decay — the same silhouette the old pulse engine's spikes had, minus the random
// sign and the trailing opposite-direction notch, which were part of the "random spikes" look
// being replaced. Its height scales with the band's own normalized loudness, so an onset in a
// near-silent band gets no accent (it was never "fully independent of current loudness" that
// made the old design look disconnected from the music).
const BOOST_AMPLITUDE = 0.6;
const BOOST_ATTACK_SECONDS = 0.03;
const BOOST_DECAY_SECONDS = 0.1;
// The part of an accent's height the onset's own strength earns (see onsetStrength) — the rest
// is unconditional so that a just-cleared onset still visibly punches.
const BOOST_STRENGTH_SHARE = 0.4;

// Spatial spread: a band's reaction (level and accent alike) tapers into its neighbours instead
// of stopping dead at its own boundary — on a 56-point polyline a single-band spike is a one-
// point needle, and with the lowest ~17 bands each being a single FFT bin that fluctuates on its
// own, a real kick read as a cluster of independent needles rather than one bump. The kernel is
// a Gaussian in band units, sized as a share of the band axis so the taper covers about the same
// VISUAL width at any bandCount (at 56 bands sigma = 1.4: neighbours at 77% / 36% / 10% / 2%),
// with a floor so the spread doesn't vanish at 8-16 bands. See spreadAcrossBands for why it's a
// peak-preserving max, not a normalized blur. This replaced the accent's own narrower
// neighbour-bleed (45% into the two adjacent bands): one mechanism on the final value, applied
// once, rather than the accent spreading twice.
const SPREAD_SIGMA_SHARE = 0.025;
const SPREAD_SIGMA_MIN_BANDS = 0.75;
// Beyond this many sigmas the weight is under 2% and not worth the multiply.
const SPREAD_RADIUS_SIGMAS = 2.8;

// Global beat pulse (strength = `globalPulse`): one shared broadband onset detector — spectral
// flux, the weighted sum of every band's positive jump in normalized level, weighted toward the
// kick range — drives ONE envelope applied to every band at once, as a multiplicative "breathe"
// of the whole line. Multiplicative rather than additive on purpose: a genuinely silent band
// stays on the baseline and the spectral shape underneath survives the hit, it just scales — an
// additive lift would hoist the dead parts of the line off the baseline on every beat.
const GLOBAL_PULSE_GAIN = 0.6; // at strength 1 the line scales x1.6 at the envelope's peak
// The strength knob's ceiling: the template field's 20 on this scale (see templateTypes.ts's
// globalPulseStrength). It was 1 while the layer was an internal A/B candidate; the field's
// upper half has to keep getting stronger rather than silently saturating at 10, so the clamp
// moved up with it. At 2 the line scales x2.2 at the envelope's peak — with MAX_VALUE clamping
// the loud bands, that reads as the whole line jumping to the top on every beat, which is what
// "maximum" should feel like.
export const MAX_GLOBAL_PULSE_STRENGTH = 2;
const GLOBAL_PULSE_ATTACK_SECONDS = 0.03;
const GLOBAL_PULSE_DECAY_SECONDS = 0.15;
// Band-axis weighting of the flux. pcmSpectrum.ts spaces bands logarithmically from FFT bin 1 to
// bin 1023 at 44.1kHz/2048, so a band at fraction p of the axis sits near 21.5 * 1023^p Hz:
// the kick range (~40-200 Hz) is p = 0.09-0.32. Full weight up to the end of that range, then a
// ramp down to a smaller constant share so a snare or a broadband transient still counts.
const GLOBAL_FLUX_FULL_WEIGHT_UNTIL = 0.35;
const GLOBAL_FLUX_RAMP_UNTIL = 0.6;
const GLOBAL_FLUX_HIGH_WEIGHT = 0.25;
// Adaptive threshold: a hit must clear a multiple of the flux's own recent average, a multiple of
// its fast-decaying recent peak (so one beat doesn't fire twice while it's still rising), an
// absolute floor (so a near-silent passage doesn't fire on nothing), and a refractory gap.
const GLOBAL_FLUX_MEAN_SECONDS = 1.5;
const GLOBAL_FLUX_MEAN_RATIO = 2.0;
const GLOBAL_FLUX_FLOOR_DECAY_PER_SECOND = 3.0;
const GLOBAL_FLUX_FLOOR_RATIO = 1.5;
const GLOBAL_FLUX_MIN = 0.06;
const GLOBAL_REFRACTORY_SECONDS = 0.12;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Spreads every band's value into its neighbours with a Gaussian taper, keeping each band's OWN
 * value intact: out[i] = max over j of in[j] * exp(-(i-j)^2 / 2 sigma^2). A max, not a normalized
 * convolution, because a blur would cut the triggering band's peak to a fraction of itself — the
 * intent is "centre at 100%, tapering down toward the sides" — and a max also leaves a flat
 * spectrum exactly flat and never lowers any band, so it can't wash detail out.
 */
export function spreadAcrossBands(values: readonly number[]): number[] {
  const n = values.length;
  const sigma = Math.max(SPREAD_SIGMA_MIN_BANDS, n * SPREAD_SIGMA_SHARE);
  const radius = Math.min(n - 1, Math.ceil(sigma * SPREAD_RADIUS_SIGMAS));
  const weights = new Array<number>(radius + 1);
  for (let d = 0; d <= radius; d++) weights[d] = Math.exp(-(d * d) / (2 * sigma * sigma));
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let best = values[i];
    for (let d = 1; d <= radius; d++) {
      if (i - d >= 0) best = Math.max(best, values[i - d] * weights[d]);
      if (i + d < n) best = Math.max(best, values[i + d] * weights[d]);
    }
    out[i] = best;
  }
  return out;
}

// See GLOBAL_FLUX_* above. Normalized to sum to 1 so the flux itself lives in [0, 1].
function globalFluxWeights(bandCount: number): number[] {
  const raw = new Array<number>(bandCount);
  for (let band = 0; band < bandCount; band++) {
    const p = bandCount > 1 ? band / (bandCount - 1) : 0;
    if (p <= GLOBAL_FLUX_FULL_WEIGHT_UNTIL) raw[band] = 1;
    else if (p >= GLOBAL_FLUX_RAMP_UNTIL) raw[band] = GLOBAL_FLUX_HIGH_WEIGHT;
    else raw[band] = lerp(1, GLOBAL_FLUX_HIGH_WEIGHT, (p - GLOBAL_FLUX_FULL_WEIGHT_UNTIL) / (GLOBAL_FLUX_RAMP_UNTIL - GLOBAL_FLUX_FULL_WEIGHT_UNTIL));
  }
  const total = raw.reduce((sum, w) => sum + w, 0);
  return raw.map((w) => w / total);
}

/**
 * How far past its own trigger threshold an onset landed, normalized to [0, 1): 0 = it only just
 * cleared the threshold (a glancing hit), approaching 1 = it came out of a band that was at (or
 * near) zero, the hardest onset there is. Deliberately scale-free — a quiet band and a loud one
 * are directly comparable, and no per-track tuning is involved.
 */
function onsetStrength(magnitude: number, threshold: number): number {
  if (threshold <= 0) return 1;
  return 1 - threshold / magnitude;
}

// Turns a stream of per-band FFT magnitudes into a continuous spectrum-analyzer line with a beat
// accent: every band's height follows how loud that band currently is (fast attack, slower
// release), and a real onset — a band spiking well above its own recent floor — adds a short,
// decaying, always-positive boost on top of that same band's level. This replaced an onset-only
// design whose line stayed flat between beats and spawned randomly-signed spikes independent of
// a band's actual loudness, which read on stream as jittering rather than tracking the music.
// Everything is a pure function of the audio: no Math.random() anywhere in this class.
export class PulseEngine {
  // Fast-decaying per-band peak tracker: the onset detector's baseline.
  private readonly floor: number[];
  // Slow-moving per-band average magnitude: the level's normalization reference.
  private readonly reference: number[];
  // The smoothed, normalized continuous level — what the line draws between onsets.
  private readonly level: number[];
  private readonly boostAmplitude: number[];
  private readonly boostAge: number[];
  private readonly gain: number;
  private readonly attackSeconds: number;
  private readonly releaseSeconds: number;
  private readonly beatBoost: number;
  private readonly floorDecayPerSecond: number;
  private readonly triggerRatio: number;
  // The global beat pulse's state — see GLOBAL_PULSE_* above. Untouched when globalPulse is 0.
  private readonly globalPulse: number;
  private readonly fluxWeights: number[];
  private readonly previousTarget: number[];
  private fluxMean = 0;
  private fluxFloor = 0;
  private globalAge = Infinity;
  private sinceGlobalHit = Infinity;

  constructor(private readonly options: PulseEngineOptions) {
    const n = options.bandCount;
    this.floor = new Array(n).fill(0);
    this.reference = new Array(n).fill(0);
    this.level = new Array(n).fill(0);
    this.boostAmplitude = new Array(n).fill(0);
    this.boostAge = new Array(n).fill(Infinity);
    // The knob's default is unity gain — the REFERENCE_HEADROOM geometry above is tuned for it.
    this.gain = (options.sensitivity ?? DEFAULT_SENSITIVITY) / DEFAULT_SENSITIVITY;
    const smoothing = clamp(options.smoothing ?? DEFAULT_SMOOTHING, 0, 1);
    this.attackSeconds = lerp(ATTACK_SECONDS_SNAPPY, ATTACK_SECONDS_SMOOTH, smoothing);
    this.releaseSeconds = lerp(RELEASE_SECONDS_SNAPPY, RELEASE_SECONDS_SMOOTH, smoothing);
    this.beatBoost = clamp(options.beatBoost ?? DEFAULT_BEAT_BOOST, 0, 1);
    this.floorDecayPerSecond = options.floorDecayPerSecond ?? DEFAULT_FLOOR_DECAY_PER_SECOND;
    this.triggerRatio = options.triggerRatio ?? DEFAULT_TRIGGER_RATIO;
    this.globalPulse = clamp(options.globalPulse ?? 0, 0, MAX_GLOBAL_PULSE_STRENGTH);
    this.fluxWeights = globalFluxWeights(n);
    this.previousTarget = new Array(n).fill(0);
  }

  /**
   * Advances the engine by `dtSeconds` given the latest per-band magnitudes, and returns the
   * current visual value for every band, in [0, MAX_VALUE].
   */
  update(magnitudes: number[], dtSeconds: number): number[] {
    // The caller's clock is Date.now()-based, not monotonic: a negative or absurd dt (a clock
    // step, a stalled event loop) must not turn the smoothing factors below into growth.
    const dt = Number.isFinite(dtSeconds) ? clamp(dtSeconds, 0, 1) : 0;
    const n = this.options.bandCount;

    // One pass of magnitude bookkeeping feeds everything below: the onset decision (against the
    // fast peak floor), the normalization reference (the slow average) and the continuous level
    // all come from the same numbers.
    const onsets = new Array<number>(n).fill(0); // 0 = no onset this tick, else its strength
    const floorDecay = Math.exp(-this.floorDecayPerSecond * dt);
    const referenceRise = 1 - Math.exp(-dt / REFERENCE_RISE_SECONDS);
    const referenceFall = 1 - Math.exp(-dt / REFERENCE_FALL_SECONDS);
    let loudestReference = 0;
    for (let band = 0; band < n; band++) {
      const magnitude = Math.max(0, magnitudes[band] ?? 0);
      const threshold = this.floor[band] * this.triggerRatio;
      if (magnitude > threshold) {
        onsets[band] = onsetStrength(magnitude, threshold);
        this.floor[band] = magnitude;
      } else {
        this.floor[band] = Math.max(magnitude, this.floor[band] * floorDecay);
      }
      const reference = this.reference[band];
      this.reference[band] = reference + (magnitude - reference) * (magnitude > reference ? referenceRise : referenceFall);
      loudestReference = Math.max(loudestReference, this.reference[band]);
    }
    const gate = Math.max(MIN_REFERENCE, loudestReference * NOISE_GATE_RATIO);
    const loudest = Math.max(gate, loudestReference);

    const attack = 1 - Math.exp(-dt / this.attackSeconds);
    const release = 1 - Math.exp(-dt / this.releaseSeconds);
    const raw = new Array<number>(n);
    let flux = 0;
    for (let band = 0; band < n; band++) {
      const magnitude = Math.max(0, magnitudes[band] ?? 0);
      const own = Math.max(gate, this.reference[band]);
      const reference = Math.pow(own, 1 - SPECTRAL_SHAPE_SHARE) * Math.pow(loudest, SPECTRAL_SHAPE_SHARE);
      const target = Math.min(1, (magnitude / (REFERENCE_HEADROOM * reference)) * this.gain);
      const current = this.level[band];
      this.level[band] = current + (target - current) * (target > current ? attack : release);
      flux += this.fluxWeights[band] * Math.max(0, target - this.previousTarget[band]);
      this.previousTarget[band] = target;

      if (onsets[band] > 0 && this.beatBoost > 0) {
        this.trigger(band, this.beatBoost * BOOST_AMPLITUDE * target
          * (1 - BOOST_STRENGTH_SHARE + BOOST_STRENGTH_SHARE * onsets[band]));
      }
    }

    for (let band = 0; band < n; band++) {
      this.boostAge[band] += dt;
      raw[band] = this.level[band] + this.boostAmplitude[band] * this.boostEnvelope(band);
    }
    const spread = spreadAcrossBands(raw);

    // The global layer is a pure no-op at strength 0 — same code path, same numbers — so a
    // template with globalPulse 0 draws exactly what one that predates the field did.
    const scale = this.globalPulse > 0 ? 1 + GLOBAL_PULSE_GAIN * this.globalPulse * this.updateGlobalPulse(flux, dt) : 1;
    const values = new Array<number>(n);
    for (let band = 0; band < n; band++) values[band] = clamp(spread[band] * scale, 0, MAX_VALUE);
    return values;
  }

  // Advances the shared onset detector by one tick and returns the shared envelope, in [0, 1].
  private updateGlobalPulse(flux: number, dt: number): number {
    this.globalAge += dt;
    this.sinceGlobalHit += dt;
    const floorBefore = this.fluxFloor;
    this.fluxFloor = Math.max(flux, this.fluxFloor * Math.exp(-GLOBAL_FLUX_FLOOR_DECAY_PER_SECOND * dt));
    const meanBefore = this.fluxMean;
    this.fluxMean += (flux - this.fluxMean) * (1 - Math.exp(-dt / GLOBAL_FLUX_MEAN_SECONDS));
    const hit = flux > GLOBAL_FLUX_MIN
      && flux > meanBefore * GLOBAL_FLUX_MEAN_RATIO
      && flux > floorBefore * GLOBAL_FLUX_FLOOR_RATIO
      && this.sinceGlobalHit >= GLOBAL_REFRACTORY_SECONDS;
    if (hit) {
      this.globalAge = 0;
      this.sinceGlobalHit = 0;
    }
    const age = this.globalAge;
    if (age < GLOBAL_PULSE_ATTACK_SECONDS) return age / GLOBAL_PULSE_ATTACK_SECONDS;
    return Math.exp(-(age - GLOBAL_PULSE_ATTACK_SECONDS) / GLOBAL_PULSE_DECAY_SECONDS);
  }

  // Restarts a band's accent only if the new one would be taller than what's still showing — a
  // second onset landing inside a bigger accent's tail must not cut it short.
  private trigger(band: number, amplitude: number): void {
    if (amplitude <= this.boostAmplitude[band] * this.boostEnvelope(band)) return;
    this.boostAmplitude[band] = amplitude;
    this.boostAge[band] = 0;
  }

  private boostEnvelope(band: number): number {
    const age = this.boostAge[band];
    if (age < BOOST_ATTACK_SECONDS) return age / BOOST_ATTACK_SECONDS;
    return Math.exp(-(age - BOOST_ATTACK_SECONDS) / BOOST_DECAY_SECONDS);
  }
}
