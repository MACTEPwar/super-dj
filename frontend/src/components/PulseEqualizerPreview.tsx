import { useEffect, useRef } from 'react';

interface PulseEqualizerPreviewProps {
  colors: string[];
  glowLayers: number;
  glowRadius: number;
  coreWidth: number;
  sensitivity: number;
  smoothing: number;
  beatBoost: number;
  bandCount: number;
  // The saved element's own 0-20 value (NOT the engine's strength scale) — converted below with
  // the same 10-steps-per-1.0 relationship the backend's globalPulseStrength() uses.
  globalPulse: number;
  boxWidth: number;
  boxHeight: number;
}

// --- A port of src/audio/pulseEngine.ts (backend), constants and all. Kept in sync by hand, like
// every other frontend mirror of backend logic in this project. See that file for the reasoning
// behind each number; only the "why it exists at all" is repeated here.
const DEFAULT_SENSITIVITY = 1.5;
const MAX_VALUE = 1.25;
const REFERENCE_HEADROOM = 2.5;
const REFERENCE_RISE_SECONDS = 1.0;
const REFERENCE_FALL_SECONDS = 3.0;
const SPECTRAL_SHAPE_SHARE = 0.1;
const NOISE_GATE_RATIO = 0.003;
const MIN_REFERENCE = 0.05;
const ATTACK_SECONDS_SNAPPY = 0.005;
const ATTACK_SECONDS_SMOOTH = 0.08;
const RELEASE_SECONDS_SNAPPY = 0.03;
const RELEASE_SECONDS_SMOOTH = 0.5;
const FLOOR_DECAY_PER_SECOND = 2.2;
const TRIGGER_RATIO = 1.6;
const BOOST_AMPLITUDE = 0.6;
const BOOST_ATTACK_SECONDS = 0.03;
const BOOST_DECAY_SECONDS = 0.1;
const BOOST_STRENGTH_SHARE = 0.4;
const SPREAD_SIGMA_SHARE = 0.025;
const SPREAD_SIGMA_MIN_BANDS = 0.75;
const SPREAD_RADIUS_SIGMAS = 2.8;
// The global beat pulse (a shared whole-line "breathe" on every broadband beat, multiplicative
// over the per-band picture) — the backend's GLOBAL_PULSE_* / GLOBAL_FLUX_* constants, plus the
// template-field-to-engine-strength relationship from templateTypes.ts's globalPulseStrength().
const GLOBAL_PULSE_STEPS_PER_STRENGTH = 10;
const MAX_GLOBAL_PULSE_STRENGTH = 2;
const GLOBAL_PULSE_GAIN = 0.6;
const GLOBAL_PULSE_ATTACK_SECONDS = 0.03;
const GLOBAL_PULSE_DECAY_SECONDS = 0.15;
const GLOBAL_FLUX_FULL_WEIGHT_UNTIL = 0.35;
const GLOBAL_FLUX_RAMP_UNTIL = 0.6;
const GLOBAL_FLUX_HIGH_WEIGHT = 0.25;
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

// Port of the backend's globalFluxWeights: full weight over the kick range at the low end of the
// band axis, ramping down to a smaller constant share up top, normalized to sum to 1.
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

// Port of the backend's spreadAcrossBands: each band's value tapers into its neighbours with a
// Gaussian, as a peak-preserving max (never lowers a band, leaves a flat line flat).
function spreadAcrossBands(values: readonly number[]): number[] {
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

// Continuous per-band level (fast attack / slower release, normalized against the band's own
// slow-moving average) plus an always-positive, decaying beat accent on a real onset, plus the
// shared global beat pulse over the whole line — the same three mechanisms, driven by the same
// magnitude bookkeeping, as the backend engine. `globalPulseStrength` is on the engine's own
// scale (the component converts the element's 0-20 field before constructing this, the way
// StreamManager does for the real PulseVisualizer).
class PreviewPulseEngine {
  private readonly floor: number[];
  private readonly reference: number[];
  private readonly level: number[];
  private readonly boostAmplitude: number[];
  private readonly boostAge: number[];
  private readonly gain: number;
  private readonly attackSeconds: number;
  private readonly releaseSeconds: number;
  private readonly beatBoost: number;
  private readonly globalPulse: number;
  private readonly fluxWeights: number[];
  private readonly previousTarget: number[];
  private fluxMean = 0;
  private fluxFloor = 0;
  private globalAge = Infinity;
  private sinceGlobalHit = Infinity;

  constructor(private readonly bandCount: number, sensitivity: number, smoothing: number, beatBoost: number, globalPulseStrength: number) {
    this.floor = new Array(bandCount).fill(0);
    this.reference = new Array(bandCount).fill(0);
    this.level = new Array(bandCount).fill(0);
    this.boostAmplitude = new Array(bandCount).fill(0);
    this.boostAge = new Array(bandCount).fill(Infinity);
    this.gain = sensitivity / DEFAULT_SENSITIVITY;
    const s = clamp(smoothing, 0, 1);
    this.attackSeconds = lerp(ATTACK_SECONDS_SNAPPY, ATTACK_SECONDS_SMOOTH, s);
    this.releaseSeconds = lerp(RELEASE_SECONDS_SNAPPY, RELEASE_SECONDS_SMOOTH, s);
    this.beatBoost = clamp(beatBoost, 0, 1);
    this.globalPulse = clamp(globalPulseStrength, 0, MAX_GLOBAL_PULSE_STRENGTH);
    this.fluxWeights = globalFluxWeights(bandCount);
    this.previousTarget = new Array(bandCount).fill(0);
  }

  update(magnitudes: number[], dtSeconds: number): number[] {
    const dt = Number.isFinite(dtSeconds) ? clamp(dtSeconds, 0, 1) : 0;
    const n = this.bandCount;
    const onsets = new Array<number>(n).fill(0);
    const floorDecay = Math.exp(-FLOOR_DECAY_PER_SECOND * dt);
    const referenceRise = 1 - Math.exp(-dt / REFERENCE_RISE_SECONDS);
    const referenceFall = 1 - Math.exp(-dt / REFERENCE_FALL_SECONDS);
    let loudestReference = 0;
    for (let band = 0; band < n; band++) {
      const magnitude = Math.max(0, magnitudes[band] ?? 0);
      const threshold = this.floor[band] * TRIGGER_RATIO;
      if (magnitude > threshold) {
        onsets[band] = threshold <= 0 ? 1 : 1 - threshold / magnitude;
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
    const values = new Array<number>(n);
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
        this.trigger(band, this.beatBoost * BOOST_AMPLITUDE * target * (1 - BOOST_STRENGTH_SHARE + BOOST_STRENGTH_SHARE * onsets[band]));
      }
    }
    const raw = new Array<number>(n);
    for (let band = 0; band < n; band++) {
      this.boostAge[band] += dt;
      raw[band] = this.level[band] + this.boostAmplitude[band] * this.boostEnvelope(band);
    }
    const spread = spreadAcrossBands(raw);
    // A pure no-op at strength 0 — same code path, same numbers — exactly like the backend.
    const scale = this.globalPulse > 0 ? 1 + GLOBAL_PULSE_GAIN * this.globalPulse * this.updateGlobalPulse(flux, dt) : 1;
    for (let band = 0; band < n; band++) values[band] = clamp(spread[band] * scale, 0, MAX_VALUE);
    return values;
  }

  // Port of the backend's updateGlobalPulse: the shared broadband onset detector (adaptive
  // threshold over the flux's own recent mean and fast-decaying peak, an absolute floor, and a
  // refractory gap) driving one attack/decay envelope, in [0, 1].
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

// The preview's stand-in for a playing track (there is no audio in the editor — see the header
// comment on the component): a deterministic synthetic groove at 120 BPM with the spectral tilt
// real music has (bass ~50x louder than treble, so the engine's per-band normalization actually
// has something to do), a kick in the low bands every beat, a snare-ish burst in the mids on the
// off-beats, hi-hat ticks up top on the eighths, and a slowly wobbling pad underneath. Purely a
// function of time, so nothing about the preview is random.
function syntheticSpectrum(t: number, bandCount: number, out: number[]): void {
  const beat = 0.5;
  const beatPhase = (t % beat) / beat;
  const kick = Math.exp(-beatPhase * 9);
  const snare = Math.floor(t / beat) % 2 === 1 ? Math.exp(-beatPhase * 7) : 0;
  const hatPhase = (t % (beat / 2)) / (beat / 2);
  const hat = Math.exp(-hatPhase * 14);
  for (let band = 0; band < bandCount; band++) {
    const f = bandCount > 1 ? band / (bandCount - 1) : 0;
    const tilt = Math.pow(0.02, f);
    const pad = 0.4 + 0.25 * Math.sin(t * 1.3 + band * 0.9) * Math.sin(t * 0.7 - band * 0.4);
    const kickShape = Math.exp(-Math.pow((f - 0.08) / 0.12, 2));
    const snareShape = Math.exp(-Math.pow((f - 0.45) / 0.15, 2));
    const hatShape = f > 0.65 ? (f - 0.65) / 0.35 : 0;
    out[band] = tilt * (pad + 2.4 * kick * kickShape + 1.8 * snare * snareShape + 1.6 * hat * hatShape);
  }
}

function widthsFor(glowRadius: number, glowLayers: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < glowLayers; i++) {
    const f = i / (glowLayers - 1 || 1);
    out.push(glowRadius * Math.pow(1 - f, 1.5) + GLOW_LAYER_PAD);
  }
  return out;
}

// Port of the backend's pulseGeometry + strokeMarginPx (src/render/pulseSvg.ts) — see that file
// for the full reasoning. The short version: the polyline is inset from every edge by half the
// widest stroke plus EDGE_CLEARANCE_PX, so the whole glow lands inside the box with visible room
// to spare instead of being chopped flat at (or hugging) its edges; and when the configured glow
// is too wide for the box, the STROKES shrink to what the box can hold rather than being drawn at
// full width and clipped. Both the layout below and the draw loop read this one function, exactly
// as layoutPulsePoints and buildPulseSvg both do on the backend — them deriving it separately is
// what let the drawn glow outgrow the inset in the first place.
const EDGE_CLEARANCE_PX = 3;
const GLOW_LAYER_PAD = 0.4;
const MAX_MARGIN_SHARE = 4;

function pulseGeometry(boxWidth: number, boxHeight: number, glowRadius: number, coreWidth: number): { margin: number; glowRadius: number; coreWidth: number } {
  const wanted = Math.ceil(Math.max(glowRadius + GLOW_LAYER_PAD, coreWidth) / 2) + EDGE_CLEARANCE_PX;
  const maxMargin = Math.floor(Math.min(boxWidth, boxHeight) / MAX_MARGIN_SHARE);
  if (wanted <= maxMargin) return { margin: wanted, glowRadius, coreWidth };
  const margin = Math.max(0, maxMargin);
  const widest = Math.max(0, 2 * (margin - EDGE_CLEARANCE_PX));
  return { margin, glowRadius: Math.max(0, widest - GLOW_LAYER_PAD), coreWidth: Math.min(coreWidth, widest) };
}

// Port of the backend's layoutPulsePoints: the baseline sits at the vertical centre and the
// loudest value reaches exactly the top margin.
function layoutPulsePoints(values: number[], boxWidth: number, boxHeight: number, margin: number): { x: number; y: number }[] {
  const n = values.length;
  const usableWidth = boxWidth - 2 * margin;
  const baseline = boxHeight / 2;
  const amplitude = baseline - margin;
  return values.map((v, i) => ({
    x: margin + (n > 1 ? i / (n - 1) : 0.5) * usableWidth,
    y: baseline - (clamp(v, 0, MAX_VALUE) / MAX_VALUE) * amplitude,
  }));
}

function tracePath(ctx: CanvasRenderingContext2D, points: { x: number; y: number }[]): void {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
}

// A client-side port of the exact same drawing recipe PulseVisualizer uses server-side (layered
// glow strokes over an angular polyline, plus a gradient) driven by a port of the same PulseEngine
// — see the design spec's "Editor: live preview" section for why this can't be the real
// audio-driven render (there's no audio playing in the editor) but the STYLE (colors/glow/
// thickness) and the REACTIVITY (sensitivity/smoothing/beatBoost/bandCount/globalPulse) are
// still true WYSIWYG, since both are driven by the same props the saved element carries, through
// the same math. Only the music itself is synthetic.
export function PulseEqualizerPreview({ colors, glowLayers, glowRadius, coreWidth, sensitivity, smoothing, beatBoost, bandCount, globalPulse, boxWidth, boxHeight }: PulseEqualizerPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const ctx: CanvasRenderingContext2D = context;
    canvas.width = boxWidth;
    canvas.height = boxHeight;

    // Resolved once per prop change, not per frame — the box and the style are fixed for the
    // life of this effect, and the layout and the strokes must both come from the same result.
    const geometry = pulseGeometry(boxWidth, boxHeight, glowRadius, coreWidth);

    const engine = new PreviewPulseEngine(bandCount, sensitivity, smoothing, beatBoost, globalPulse / GLOBAL_PULSE_STEPS_PER_STRENGTH);
    const magnitudes = new Array<number>(bandCount).fill(0);
    let lastT = 0;
    let raf = 0;
    let running = true;

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    function draw(tMs: number) {
      const t = tMs / 1000;
      const dt = lastT ? t - lastT : 0;
      lastT = t;

      syntheticSpectrum(t, bandCount, magnitudes);
      const values = engine.update(magnitudes, dt);

      ctx.clearRect(0, 0, boxWidth, boxHeight);
      const grad = ctx.createLinearGradient(0, 0, boxWidth, 0);
      colors.forEach((c, i) => grad.addColorStop(i / (colors.length - 1 || 1), c));

      const points = layoutPulsePoints(values, boxWidth, boxHeight, geometry.margin);

      const widths = widthsFor(geometry.glowRadius, glowLayers);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.globalCompositeOperation = 'lighter';
      widths.forEach((w, i) => {
        const f = i / (widths.length - 1 || 1);
        tracePath(ctx, points);
        ctx.strokeStyle = grad;
        ctx.lineWidth = w;
        ctx.globalAlpha = Math.min(1, 0.05 + 0.45 * Math.pow(f, 2.2));
        ctx.stroke();
      });
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      tracePath(ctx, points);
      ctx.strokeStyle = '#fbf3ff';
      ctx.lineWidth = geometry.coreWidth;
      ctx.stroke();

      if (running && !reduceMotion) raf = requestAnimationFrame(draw);
    }

    raf = requestAnimationFrame(draw);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, [colors, glowLayers, glowRadius, coreWidth, sensitivity, smoothing, beatBoost, bandCount, globalPulse, boxWidth, boxHeight]);

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />;
}
