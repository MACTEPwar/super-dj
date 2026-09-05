# Neon Pulse Equalizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the MVP `showfreqs` bar-spectrum equalizer element with the approved "neon
pulse" style — an angular, glowing line, flat baseline between beats, per-frequency-band onset-
triggered spikes — with configurable colors/glow and a live animated editor preview.

**Architecture:** A new Node-side pipeline (`PulseVisualizer`) taps the same PCM bytes `AudioRelay`
already pipes to the encoder, runs a small hand-rolled FFT per band, drives per-band onset
envelopes, draws the result as an SVG (layered translucent strokes + gradient), rasterizes it via
`@resvg/resvg-js` (off the main thread, in a dedicated piscina pool), and feeds the raw RGBA
frames into a new `pipe:5` on `PersistentEncoder`, composited on top of the canvas exactly where
the old `showfreqs` branch used to sit. The frontend gets a matching configurable style (colors/
glow) and a client-side canvas port of the same drawing recipe for a genuinely animated (if not
literally audio-driven) live preview.

**Tech Stack:** TypeScript/Node, `@resvg/resvg-js` (already a dependency), `piscina` (already a
dependency), a small hand-rolled radix-2 FFT (no new dependency), React/Vite frontend.

**Spec:** `docs/superpowers/specs/2026-09-04-neon-pulse-equalizer-design.md` — read this first;
it contains the full reasoning and two real-binary spikes (resvg's `loadSystemFonts` cost, and
resvg's premultiplied-alpha output) whose *findings* are baked into the code below as settled
decisions, not open questions.

## Global Constraints

- Every ffmpeg-touching class takes an injected `Spawner`/`ChildProcessLike`/`PipeSpawner` fake in
  tests — never spawn real ffmpeg in a unit test (see CLAUDE.md's testing strategy).
- `EqualizerElement`'s position/size stay integer-constrained (`Number.isInteger`) — `pipe:5`'s
  `-s WxH` needs whole pixels, same reason the old `showfreqs` branch needed it.
- resvg calls for this element MUST pass `{ font: { loadSystemFonts: false } }` — omitting it
  reintroduces the ~130ms-per-call regression the design spec's spike found and fixed.
- `PulseVisualizer` MUST unpremultiply resvg's raw pixel buffer before writing it to `pipe:5` —
  the design spec's alpha spike verified resvg's output is premultiplied and ffmpeg's `rgba`
  rawvideo pix_fmt expects straight alpha.
- Follow the existing fake-child/fake-repository testing pattern; don't introduce a new mocking
  style (per CLAUDE.md).

---

### Task 1: `EqualizerElement` schema — colors/glow instead of a solid color

**Files:**
- Modify: `src/templates/templateTypes.ts`
- Test: `test/templates/templateTypes.test.ts`

**Interfaces:**
- Produces: `EqualizerElement { type: 'equalizer'; x: number; y: number; width: number; height:
  number; colors: string[]; glowLayers: number; glowRadius: number; coreWidth: number }`,
  `DEFAULT_EQUALIZER_STYLE` (exported const), `isValidTemplateElement` (existing export, extended).

- [ ] **Step 1: Write the failing tests**

Replace the entire `describe('isValidTemplateElement — equalizer', ...)` block (currently lines
256-325 of `test/templates/templateTypes.test.ts`) with:

```typescript
describe('isValidTemplateElement — equalizer', () => {
  const validEqualizer = {
    type: 'equalizer', x: 10, y: 10, width: 400, height: 150,
    colors: ['#3b6fff', '#ff2f6e', '#3bdcff'],
    glowLayers: 9, glowRadius: 42, coreWidth: 1,
  };

  it('accepts a valid equalizer element', () => {
    expect(isValidTemplateElement(validEqualizer)).toBe(true);
  });

  it('rejects an equalizer with fewer than 2 color stops', () => {
    expect(isValidTemplateElement({ ...validEqualizer, colors: ['#3b6fff'] })).toBe(false);
  });

  it('rejects an equalizer with more than 6 color stops', () => {
    expect(isValidTemplateElement({ ...validEqualizer, colors: new Array(7).fill('#3b6fff') })).toBe(false);
  });

  it('rejects an equalizer with a non-hex color stop', () => {
    expect(isValidTemplateElement({ ...validEqualizer, colors: ['#3b6fff', 'not-a-color'] })).toBe(false);
  });

  // Unlike the MVP's ffmpeg-facing `color` (which needed STRICT_HEX_COLOR_PATTERN because
  // ffmpeg's av_parse_color can't do CSS shorthand), these colors reach resvg's SVG gradient
  // stops — a real CSS-color-parsing renderer, same as title/playlist's ColorValue — so 3/4-digit
  // shorthand is fine here.
  it('accepts a shorthand 3-digit hex color stop', () => {
    expect(isValidTemplateElement({ ...validEqualizer, colors: ['#f00', '#00f'] })).toBe(true);
  });

  it('rejects glowLayers below 3', () => {
    expect(isValidTemplateElement({ ...validEqualizer, glowLayers: 2 })).toBe(false);
  });

  it('rejects glowLayers above 9', () => {
    expect(isValidTemplateElement({ ...validEqualizer, glowLayers: 10 })).toBe(false);
  });

  it('rejects a non-integer glowLayers', () => {
    expect(isValidTemplateElement({ ...validEqualizer, glowLayers: 5.5 })).toBe(false);
  });

  it('rejects glowRadius outside 10-70', () => {
    expect(isValidTemplateElement({ ...validEqualizer, glowRadius: 9 })).toBe(false);
    expect(isValidTemplateElement({ ...validEqualizer, glowRadius: 71 })).toBe(false);
  });

  it('rejects coreWidth outside 1-6', () => {
    expect(isValidTemplateElement({ ...validEqualizer, coreWidth: 0.5 })).toBe(false);
    expect(isValidTemplateElement({ ...validEqualizer, coreWidth: 7 })).toBe(false);
  });

  it('rejects an equalizer with an out-of-canvas position', () => {
    expect(isValidTemplateElement({ ...validEqualizer, x: -1 })).toBe(false);
  });

  it('rejects an equalizer missing width/height', () => {
    const { width, height, ...rest } = validEqualizer;
    expect(isValidTemplateElement(rest)).toBe(false);
  });

  // pipe:5's `-s <width>x<height>` (like the old showfreqs `s=` option before it) requires
  // integer dimensions — see persistentEncoderArgs.ts.
  it('rejects an equalizer with a non-integer width', () => {
    expect(isValidTemplateElement({ ...validEqualizer, width: 400.5 })).toBe(false);
  });

  it('rejects an equalizer with a non-integer height', () => {
    expect(isValidTemplateElement({ ...validEqualizer, height: 150.5 })).toBe(false);
  });

  it('rejects an equalizer with a non-integer x', () => {
    expect(isValidTemplateElement({ ...validEqualizer, x: 10.5 })).toBe(false);
  });

  it('rejects an equalizer with a non-integer y', () => {
    expect(isValidTemplateElement({ ...validEqualizer, y: 10.5 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/templates/templateTypes.test.ts -t "isValidTemplateElement — equalizer"`
Expected: FAIL — `validEqualizer` still has no `color` field the old code required, and the new
`colors`/`glowLayers`/`glowRadius`/`coreWidth` checks don't exist yet.

- [ ] **Step 3: Implement the schema and validation change**

In `src/templates/templateTypes.ts`, replace the `EqualizerElement` interface (currently lines
67-74):

```typescript
export interface EqualizerElement {
  type: 'equalizer';
  x: number;
  y: number;
  width: number;
  height: number;
  colors: string[]; // gradient stops across the line's width, left to right, 2-6 stops
  glowLayers: number; // 3-9
  glowRadius: number; // 10-70, px — outer glow layer's half-width
  coreWidth: number; // 1-6, px — the bright core stroke
}

// The approved "neon pulse" look from this feature's design — used by the frontend's
// create-element factory and as the reference values in tests. Not consumed by backend
// validation itself (a saved element must always specify every field).
export const DEFAULT_EQUALIZER_STYLE = {
  colors: ['#3b6fff', '#b23bff', '#ff2f6e', '#b23bff', '#3bdcff'],
  glowLayers: 9,
  glowRadius: 42,
  coreWidth: 1,
} as const;
```

Add new bounds constants near `MAX_FONT_SIZE` (after line 96):

```typescript
const MIN_GLOW_LAYERS = 3;
const MAX_GLOW_LAYERS = 9;
const MIN_GLOW_RADIUS = 10;
const MAX_GLOW_RADIUS = 70;
const MIN_CORE_WIDTH = 1;
const MAX_CORE_WIDTH = 6;
const MIN_EQUALIZER_COLOR_STOPS = 2;
const MAX_EQUALIZER_COLOR_STOPS = 6;
```

Add a new validator near `isValidColorValue` (after its closing brace, currently line 150):

```typescript
// Equalizer colors reach resvg's SVG gradient stops (a real CSS-color-parsing renderer), not an
// ffmpeg filter option directly — so the loose isValidColor (CSS-valid 3/4/6/8-digit hex) is the
// right check here, same reasoning as title/playlist's ColorValue, unlike the old MVP's
// STRICT_HEX_COLOR_PATTERN-gated `color` field this replaces.
function isValidEqualizerColors(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length >= MIN_EQUALIZER_COLOR_STOPS && value.length <= MAX_EQUALIZER_COLOR_STOPS
    && value.every((c) => isValidColor(c));
}
```

Replace the `if (el.type === 'equalizer')` branch inside `isValidTemplateElement` (currently
lines 197-207):

```typescript
  if (el.type === 'equalizer') {
    // Position/size stay integer-constrained: PulseVisualizer's raw video pipe declares
    // `-s <width>x<height>` to ffmpeg, which (like the old showfreqs `s=` option before it)
    // requires whole pixels — see persistentEncoderArgs.ts.
    return Number.isInteger(el.x) && Number.isInteger(el.y)
      && isValidSize(el.width, CANVAS_WIDTH) && Number.isInteger(el.width)
      && isValidSize(el.height, CANVAS_HEIGHT) && Number.isInteger(el.height)
      && isValidEqualizerColors(el.colors)
      && isFiniteNumber(el.glowLayers) && Number.isInteger(el.glowLayers)
      && el.glowLayers >= MIN_GLOW_LAYERS && el.glowLayers <= MAX_GLOW_LAYERS
      && isFiniteNumber(el.glowRadius) && el.glowRadius >= MIN_GLOW_RADIUS && el.glowRadius <= MAX_GLOW_RADIUS
      && isFiniteNumber(el.coreWidth) && el.coreWidth >= MIN_CORE_WIDTH && el.coreWidth <= MAX_CORE_WIDTH;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest test/templates/templateTypes.test.ts`
Expected: PASS — including every other `describe` block in the file (this change must not affect
cover/title/playlist/timer/text/image validation).

- [ ] **Step 5: Commit**

```bash
git add src/templates/templateTypes.ts test/templates/templateTypes.test.ts
git commit -m "feat: replace equalizer's solid color with configurable neon-pulse style fields

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Hand-rolled FFT

**Files:**
- Create: `src/audio/fft.ts`
- Test: `test/audio/fft.test.ts`

**Interfaces:**
- Produces: `fft(real: Float64Array, imag: Float64Array): void` — in-place radix-2 Cooley-Tukey,
  throws for a non-power-of-two length.

- [ ] **Step 1: Write the failing test**

```typescript
import { fft } from '../../src/audio/fft';

describe('fft', () => {
  it('throws for a non-power-of-two length', () => {
    expect(() => fft(new Float64Array(10), new Float64Array(10))).toThrow('power of two');
  });

  it('places all energy in bin 0 for a constant (DC) signal', () => {
    const n = 64;
    const real = new Float64Array(n).fill(1);
    const imag = new Float64Array(n);
    fft(real, imag);
    const magnitude = (i: number) => Math.hypot(real[i], imag[i]);
    expect(magnitude(0)).toBeCloseTo(n, 5);
    for (let i = 1; i < n; i++) expect(magnitude(i)).toBeCloseTo(0, 5);
  });

  it('finds the peak bin of a pure sine wave at the expected frequency', () => {
    const n = 256;
    const cyclesPerWindow = 10; // bin 10 should dominate
    const real = new Float64Array(n);
    const imag = new Float64Array(n);
    for (let i = 0; i < n; i++) real[i] = Math.sin((2 * Math.PI * cyclesPerWindow * i) / n);
    fft(real, imag);

    let peakBin = 0;
    let peakMag = -Infinity;
    for (let i = 1; i < n / 2; i++) {
      const mag = Math.hypot(real[i], imag[i]);
      if (mag > peakMag) { peakMag = mag; peakBin = i; }
    }
    expect(peakBin).toBe(cyclesPerWindow);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest test/audio/fft.test.ts`
Expected: FAIL with "Cannot find module '../../src/audio/fft'"

- [ ] **Step 3: Implement the FFT**

```typescript
// In-place radix-2 Cooley-Tukey FFT. `real`/`imag` length must be a power of two — the only
// caller (pcmSpectrum.ts) always uses a fixed 2048-sample window, chosen to be a power of two for
// exactly this reason. Hand-rolled rather than a dependency (e.g. fft.js) — this is the one
// well-known, easily-tested algorithm this project needs, and a typed in-repo implementation
// avoids taking on an untyped npm package for it.
export function fft(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  if (n !== imag.length) throw new Error('fft: real and imag must be the same length');
  if (n === 0 || (n & (n - 1)) !== 0) throw new Error('fft: length must be a power of two');

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = real[i]; real[i] = real[j]; real[j] = tr;
      const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angleStep = (-2 * Math.PI) / len;
    for (let start = 0; start < n; start += len) {
      for (let k = 0; k < half; k++) {
        const angle = angleStep * k;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        const evenIndex = start + k;
        const oddIndex = start + k + half;
        const tr = real[oddIndex] * wr - imag[oddIndex] * wi;
        const ti = real[oddIndex] * wi + imag[oddIndex] * wr;
        real[oddIndex] = real[evenIndex] - tr;
        imag[oddIndex] = imag[evenIndex] - ti;
        real[evenIndex] += tr;
        imag[evenIndex] += ti;
      }
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest test/audio/fft.test.ts`
Expected: PASS (all 3 cases)

- [ ] **Step 5: Commit**

```bash
git add src/audio/fft.ts test/audio/fft.test.ts
git commit -m "feat: add a hand-rolled radix-2 FFT for the pulse equalizer

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: PCM → per-band magnitude spectrum

**Files:**
- Create: `src/audio/pcmSpectrum.ts`
- Test: `test/audio/pcmSpectrum.test.ts`

**Interfaces:**
- Consumes: `fft(real, imag)` from Task 2.
- Produces: `magnitudesFromPcm(pcm: Int16Array, bands: number): number[]`.

- [ ] **Step 1: Write the failing test**

```typescript
import { magnitudesFromPcm } from '../../src/audio/pcmSpectrum';

function sineWavePcm(freqHz: number, sampleRate: number, samples: number): Int16Array {
  const pcm = new Int16Array(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * 20000);
    pcm[i * 2] = v;
    pcm[i * 2 + 1] = v;
  }
  return pcm;
}

describe('magnitudesFromPcm', () => {
  it('returns one magnitude per requested band', () => {
    const pcm = sineWavePcm(440, 44100, 2048);
    expect(magnitudesFromPcm(pcm, 56)).toHaveLength(56);
  });

  it('places most energy in a low band for a low-frequency tone', () => {
    const pcm = sineWavePcm(110, 44100, 2048); // low bass note
    const bands = magnitudesFromPcm(pcm, 56);
    const peakBand = bands.indexOf(Math.max(...bands));
    expect(peakBand).toBeLessThan(15);
  });

  it('places most energy in a high band for a high-frequency tone', () => {
    const pcm = sineWavePcm(9000, 44100, 2048); // near the top of a typical mix
    const bands = magnitudesFromPcm(pcm, 56);
    const peakBand = bands.indexOf(Math.max(...bands));
    expect(peakBand).toBeGreaterThan(40);
  });

  it('returns near-zero magnitudes for silence', () => {
    const pcm = new Int16Array(2048 * 2);
    const bands = magnitudesFromPcm(pcm, 56);
    expect(bands.every((v) => v < 0.001)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest test/audio/pcmSpectrum.test.ts`
Expected: FAIL with "Cannot find module '../../src/audio/pcmSpectrum'"

- [ ] **Step 3: Implement it**

```typescript
import { fft } from './fft';

const WINDOW_SIZE = 2048; // power of two; ~46ms at 44.1kHz

// Maps a windowed FFT's magnitude spectrum down to a fixed number of log-spaced bands —
// bass-heavy on the left, treble on the right, matching the approved prototype's layout.
// `pcm` must contain interleaved 16-bit signed stereo samples (the same s16le/44100/stereo shape
// AudioRelay always writes — see persistentEncoderArgs.ts's pipe:4 declaration).
export function magnitudesFromPcm(pcm: Int16Array, bands: number): number[] {
  const samples = Math.min(WINDOW_SIZE, Math.floor(pcm.length / 2));
  const real = new Float64Array(WINDOW_SIZE);
  const imag = new Float64Array(WINDOW_SIZE);
  for (let i = 0; i < samples; i++) {
    const left = pcm[i * 2] ?? 0;
    const right = pcm[i * 2 + 1] ?? 0;
    const mono = (left + right) / 2 / 32768;
    // Hann window: without it, the FFT's implicit assumption that this window repeats forever
    // creates spurious energy smeared across every bin ("spectral leakage"), which would make
    // even a pure tone look like it touches most bands.
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (samples - 1 || 1));
    real[i] = mono * hann;
  }

  fft(real, imag);

  const usableBins = WINDOW_SIZE / 2;
  const magnitudes = new Array<number>(usableBins);
  for (let i = 0; i < usableBins; i++) magnitudes[i] = Math.hypot(real[i], imag[i]);

  // Log-spaced band edges: bin 1 (not 0, which is DC) up to the last usable bin, `bands + 1`
  // edges log-spaced between them so low bands cover a handful of FFT bins each and high bands
  // cover many, matching how the ear (and the approved prototype's bass-heavy-left layout)
  // actually perceives frequency.
  const result = new Array<number>(bands).fill(0);
  const logMin = Math.log(1);
  const logMax = Math.log(usableBins - 1);
  for (let b = 0; b < bands; b++) {
    const lo = Math.round(Math.exp(logMin + ((logMax - logMin) * b) / bands));
    const hi = Math.max(lo + 1, Math.round(Math.exp(logMin + ((logMax - logMin) * (b + 1)) / bands)));
    let sum = 0;
    let count = 0;
    for (let i = lo; i < hi && i < magnitudes.length; i++) { sum += magnitudes[i]; count++; }
    result[b] = count > 0 ? sum / count : 0;
  }
  return result;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest test/audio/pcmSpectrum.test.ts`
Expected: PASS. If the low/high band-index thresholds (15 / 40) don't hold on the first run,
narrow or widen them to match the actual peak band this log-mapping produces — the point of the
test is "low tone lands left, high tone lands right", not the exact index.

- [ ] **Step 5: Commit**

```bash
git add src/audio/pcmSpectrum.ts test/audio/pcmSpectrum.test.ts
git commit -m "feat: map PCM audio to log-spaced per-band magnitudes for the pulse equalizer

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Per-band onset/pulse engine

**Files:**
- Create: `src/audio/pulseEngine.ts`
- Test: `test/audio/pulseEngine.test.ts`

**Interfaces:**
- Produces: `class PulseEngine { constructor(options: { bandCount: number; floorDecayPerSecond?:
  number; triggerRatio?: number }); update(magnitudes: number[], dtSeconds: number, nowSeconds:
  number): number[]; }` — returns one visual value per band, clamped to roughly [-1.3, 1.5].

- [ ] **Step 1: Write the failing test**

```typescript
import { PulseEngine } from '../../src/audio/pulseEngine';

describe('PulseEngine', () => {
  it('stays flat (all zero) when fed silence', () => {
    const engine = new PulseEngine({ bandCount: 8 });
    const values = engine.update(new Array(8).fill(0), 0.03, 0);
    expect(values.every((v) => v === 0)).toBe(true);
  });

  it('triggers a pulse on a band whose magnitude suddenly jumps well above its recent floor', () => {
    const engine = new PulseEngine({ bandCount: 8 });
    engine.update(new Array(8).fill(0.01), 0.03, 0); // establish a low floor
    const spiked = new Array(8).fill(0.01);
    spiked[3] = 1.0; // way above floor * triggerRatio
    const values = engine.update(spiked, 0.03, 0.03);
    expect(values[3]).not.toBe(0);
  });

  it('does not keep retriggering while the same band stays loud (the floor tracks it)', () => {
    const engine = new PulseEngine({ bandCount: 8 });
    const loud = new Array(8).fill(0.01);
    loud[3] = 1.0;
    engine.update(loud, 0.03, 0);
    // Half a second later at the same sustained level, the floor has caught up to 1.0 and this
    // magnitude no longer exceeds floor * triggerRatio, so the original pulse has had time to
    // decay back toward the flat baseline with nothing re-triggering it.
    const values = engine.update(loud, 0.5, 0.5);
    expect(Math.abs(values[3])).toBeLessThan(0.05);
  });

  it('an untouched band stays at exactly zero while a distant band spikes', () => {
    const engine = new PulseEngine({ bandCount: 56 });
    const spiked = new Array(56).fill(0);
    spiked[5] = 1.0;
    const values = engine.update(spiked, 0.03, 0);
    expect(values[50]).toBe(0);
  });

  it('a triggered pulse eventually decays back to (near) zero', () => {
    const engine = new PulseEngine({ bandCount: 8 });
    const spiked = new Array(8).fill(0);
    spiked[0] = 1.0;
    engine.update(spiked, 0.03, 0);
    const later = engine.update(new Array(8).fill(0), 0.03, 5);
    expect(Math.abs(later[0])).toBeLessThan(0.01);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest test/audio/pulseEngine.test.ts`
Expected: FAIL with "Cannot find module '../../src/audio/pulseEngine'"

- [ ] **Step 3: Implement it**

```typescript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest test/audio/pulseEngine.test.ts`
Expected: PASS (all 5 cases)

- [ ] **Step 5: Commit**

```bash
git add src/audio/pulseEngine.ts test/audio/pulseEngine.test.ts
git commit -m "feat: add per-band onset-triggered pulse envelope engine

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Pulse SVG builder

**Files:**
- Create: `src/render/pulseSvg.ts`
- Test: `test/render/pulseSvg.test.ts`

**Interfaces:**
- Produces: `interface PulsePoint { x: number; y: number }`, `interface PulseStyle { width:
  number; height: number; colors: string[]; glowLayers: number; glowRadius: number; coreWidth:
  number }`, `buildPulseSvg(points: PulsePoint[], style: PulseStyle): string`.

- [ ] **Step 1: Write the failing test**

```typescript
import { buildPulseSvg } from '../../src/render/pulseSvg';

describe('buildPulseSvg', () => {
  const points = [{ x: 0, y: 75 }, { x: 200, y: 20 }, { x: 400, y: 75 }];
  const style = { width: 400, height: 150, colors: ['#3b6fff', '#ff2f6e', '#3bdcff'], glowLayers: 3, glowRadius: 40, coreWidth: 2 };

  it('includes one gradient stop per configured color, in order', () => {
    const svg = buildPulseSvg(points, style);
    expect(svg).toContain('stop-color="#3b6fff"');
    expect(svg).toContain('stop-color="#ff2f6e"');
    expect(svg).toContain('stop-color="#3bdcff"');
    expect((svg.match(/<stop /g) || []).length).toBe(3);
  });

  it('draws one glow-layer <path> per glowLayers, plus one bright core path', () => {
    const svg = buildPulseSvg(points, style);
    expect((svg.match(/<path /g) || []).length).toBe(style.glowLayers + 1);
  });

  it('the outermost glow layer stroke-width is derived from glowRadius', () => {
    const svg = buildPulseSvg(points, style);
    expect(svg).toContain('stroke-width="40.40"');
  });

  it('the core path uses coreWidth and a solid bright color, not the gradient', () => {
    const svg = buildPulseSvg(points, style);
    expect(svg).toContain('stroke="#fbf3ff" stroke-width="2"');
  });

  it('traces a straight-segment polyline through every point (angular, not smoothed)', () => {
    const svg = buildPulseSvg(points, style);
    expect(svg).toContain('M 0.00 75.00 L 200.00 20.00 L 400.00 75.00');
  });

  it('sets the declared svg size from style.width/height', () => {
    const svg = buildPulseSvg(points, style);
    expect(svg).toContain('width="400" height="150" viewBox="0 0 400 150"');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest test/render/pulseSvg.test.ts`
Expected: FAIL with "Cannot find module '../../src/render/pulseSvg'"

- [ ] **Step 3: Implement it**

```typescript
export interface PulsePoint { x: number; y: number; }

export interface PulseStyle {
  width: number;
  height: number;
  colors: string[];
  glowLayers: number;
  glowRadius: number;
  coreWidth: number;
}

function pathD(points: PulsePoint[]): string {
  return 'M ' + points.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' L ');
}

// Low exponent keeps the mid layers relatively wide, so the glow itself rounds off the
// polyline's angular joints instead of tracing them sharply — validated in the browser prototype
// during this feature's design.
function widthsFor(glowRadius: number, glowLayers: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < glowLayers; i++) {
    const f = i / (glowLayers - 1);
    out.push(glowRadius * Math.pow(1 - f, 1.5) + 0.4);
  }
  return out;
}

// Renders the approved "neon pulse" look: several layered, increasingly-narrow, increasingly-
// opaque translucent strokes (the glow) plus one bright thin core stroke, all following the same
// angular (straight-segment) path. See PulseVisualizer for how `points` gets computed from real
// audio, and pulseRenderWorker.ts for how this string gets rasterized.
export function buildPulseSvg(points: PulsePoint[], style: PulseStyle): string {
  const { width, height, colors, glowLayers, glowRadius, coreWidth } = style;
  const d = pathD(points);
  const widths = widthsFor(glowRadius, glowLayers);
  const stops = colors
    .map((color, i) => `<stop offset="${(i / (colors.length - 1)).toFixed(3)}" stop-color="${color}"/>`)
    .join('');
  const layers = widths
    .map((w, i) => {
      const t = i / (widths.length - 1);
      const alpha = Math.min(1, 0.05 + 0.45 * Math.pow(t, 2.2));
      return `<path d="${d}" fill="none" stroke="url(#g)" stroke-width="${w.toFixed(2)}" stroke-opacity="${alpha.toFixed(3)}" stroke-linejoin="round" stroke-linecap="round"/>`;
    })
    .join('');
  const core = `<path d="${d}" fill="none" stroke="#fbf3ff" stroke-width="${coreWidth}" stroke-linejoin="round" stroke-linecap="round"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">${stops}</linearGradient></defs>${layers}${core}</svg>`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest test/render/pulseSvg.test.ts`
Expected: PASS (all 6 cases)

- [ ] **Step 5: Commit**

```bash
git add src/render/pulseSvg.ts test/render/pulseSvg.test.ts
git commit -m "feat: add the neon-pulse SVG builder (layered glow strokes + gradient)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Unpremultiply helper

**Files:**
- Create: `src/render/unpremultiply.ts`
- Test: `test/render/unpremultiply.test.ts`

**Interfaces:**
- Produces: `unpremultiplyRgbaInPlace(pixels: Buffer): void`.

- [ ] **Step 1: Write the failing test**

```typescript
import { unpremultiplyRgbaInPlace } from '../../src/render/unpremultiply';

describe('unpremultiplyRgbaInPlace', () => {
  it('scales up a premultiplied color channel by 255/alpha', () => {
    // Verified against a real resvg + ffmpeg round-trip during design (see the design spec's
    // alpha spike): a 50%-alpha red renders as premultiplied (128, 0, 0, 128), and must become
    // (255, 0, 0, 128) for ffmpeg's straight-alpha rgba pix_fmt to composite it correctly.
    const pixels = Buffer.from([128, 0, 0, 128]);
    unpremultiplyRgbaInPlace(pixels);
    expect([...pixels]).toEqual([255, 0, 0, 128]);
  });

  it('leaves a fully opaque pixel unchanged', () => {
    const pixels = Buffer.from([10, 20, 30, 255]);
    unpremultiplyRgbaInPlace(pixels);
    expect([...pixels]).toEqual([10, 20, 30, 255]);
  });

  it('leaves a fully transparent pixel unchanged (nothing to recover)', () => {
    const pixels = Buffer.from([0, 0, 0, 0]);
    unpremultiplyRgbaInPlace(pixels);
    expect([...pixels]).toEqual([0, 0, 0, 0]);
  });

  it('processes every pixel in a multi-pixel buffer', () => {
    const pixels = Buffer.from([128, 0, 0, 128, 0, 64, 0, 128]);
    unpremultiplyRgbaInPlace(pixels);
    expect([...pixels]).toEqual([255, 0, 0, 128, 0, 128, 0, 128]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest test/render/unpremultiply.test.ts`
Expected: FAIL with "Cannot find module '../../src/render/unpremultiply'"

- [ ] **Step 3: Implement it**

```typescript
// resvg's raw pixel buffer is premultiplied alpha (color channels already multiplied by
// alpha/255) — verified against real resvg + ffmpeg binaries during this feature's design (see
// the design spec's alpha spike). ffmpeg's rawvideo `rgba` pix_fmt expects STRAIGHT alpha;
// feeding it premultiplied bytes directly applies alpha a second time during compositing,
// visibly darkening every translucent glow layer. This reverses that, in place.
export function unpremultiplyRgbaInPlace(pixels: Buffer): void {
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3];
    if (a === 0 || a === 255) continue; // 0: nothing to recover; 255: a/255 == 1, already correct
    pixels[i] = Math.min(255, Math.round((pixels[i] * 255) / a));
    pixels[i + 1] = Math.min(255, Math.round((pixels[i + 1] * 255) / a));
    pixels[i + 2] = Math.min(255, Math.round((pixels[i + 2] * 255) / a));
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest test/render/unpremultiply.test.ts`
Expected: PASS (all 4 cases)

- [ ] **Step 5: Commit**

```bash
git add src/render/unpremultiply.ts test/render/unpremultiply.test.ts
git commit -m "feat: add the resvg-output unpremultiply step for straight-alpha ffmpeg input

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Pulse render worker + pool

**Files:**
- Create: `src/render/pulseRenderWorker.ts`
- Create: `src/render/pulseRenderWorkerPool.ts`
- Test: `test/render/pulseRenderWorker.test.ts`

**Interfaces:**
- Consumes: `buildPulseSvg` from Task 5 (test only).
- Produces: `pulseRenderWorker.ts` default export `renderPulseFrame(task: { svg: string }): {
  pixels: Uint8Array; width: number; height: number }` (synchronous, for direct in-process
  testing); `pulseRenderWorkerPool.ts` exports `async renderPulseFrame(svg: string): Promise<{
  pixels: Buffer; width: number; height: number }>` (the piscina-backed version other code
  actually calls — same name, different module, matching this project's existing
  `renderWorker.ts` (sync default export) / `renderWorkerPool.ts` (async named export) split).

- [ ] **Step 1: Write the failing test**

```typescript
import renderPulseFrame from '../../src/render/pulseRenderWorker';
import { buildPulseSvg } from '../../src/render/pulseSvg';

describe('renderPulseFrame (real resvg, no piscina)', () => {
  const svg = buildPulseSvg(
    [{ x: 0, y: 75 }, { x: 200, y: 20 }, { x: 400, y: 75 }],
    { width: 400, height: 150, colors: ['#3b6fff', '#b23bff', '#ff2f6e', '#b23bff', '#3bdcff'], glowLayers: 9, glowRadius: 42, coreWidth: 1 },
  );

  it('rasterizes to the expected pixel dimensions with a real RGBA alpha channel', () => {
    const result = renderPulseFrame({ svg });
    expect(result.width).toBe(400);
    expect(result.height).toBe(150);
    expect(result.pixels.length).toBe(400 * 150 * 4);
  });

  // Regression guard for the design spec's real spike: Resvg's constructor scans every system
  // font by default (~130ms measured on the spec-writing machine), even for an SVG with zero
  // <text>. Without `font: { loadSystemFonts: false }` in the implementation, this fails on any
  // machine with a non-trivial font catalog — exactly how the original 141ms/frame regression
  // was found in the first place.
  it('renders well within a single 30fps frame budget (regression guard for loadSystemFonts)', () => {
    renderPulseFrame({ svg }); // warm up
    const start = process.hrtime.bigint();
    renderPulseFrame({ svg });
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    expect(ms).toBeLessThan(20);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest test/render/pulseRenderWorker.test.ts`
Expected: FAIL with "Cannot find module '../../src/render/pulseRenderWorker'"

- [ ] **Step 3: Implement `pulseRenderWorker.ts`**

```typescript
import { Resvg } from '@resvg/resvg-js';

export interface PulseRenderTask {
  svg: string;
}

export interface PulseRenderResult {
  pixels: Uint8Array;
  width: number;
  height: number;
}

// Piscina's worker entry point for pulse-frame rasterization — see pulseRenderWorkerPool.ts for
// the pool this feeds into, and the design spec's spike for why `loadSystemFonts: false` matters:
// without it, every call pays a ~130ms system-font-scan cost regardless of the SVG's actual
// content (verified against the real resvg binary; this element's SVG has no <text> at all, so
// there is nothing lost by skipping that scan).
export default function renderPulseFrame(task: PulseRenderTask): PulseRenderResult {
  const pixmap = new Resvg(task.svg, { font: { loadSystemFonts: false } }).render();
  return { pixels: pixmap.pixels, width: pixmap.width, height: pixmap.height };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest test/render/pulseRenderWorker.test.ts`
Expected: PASS (both cases)

- [ ] **Step 5: Implement `pulseRenderWorkerPool.ts`** (no dedicated unit test — mirrors
`renderWorkerPool.ts`, which is likewise exercised only through the callers that mock its module
boundary, per this project's existing pattern for piscina pool wrappers)

```typescript
import Piscina from 'piscina';
import * as path from 'path';
import * as os from 'os';
import { PulseRenderTask } from './pulseRenderWorker';

const RENDER_TIMEOUT_MS = 200; // generous vs. the ~5ms measured cost — see the design spec's spike

let pool: Piscina | null = null;

function getPool(): Piscina {
  if (!pool) {
    pool = new Piscina({
      filename: path.join(__dirname, 'pulseRenderWorker.js'),
      maxThreads: Math.max(1, Math.min(4, os.cpus().length)),
      idleTimeout: 60000,
    });
  }
  return pool;
}

// Raw RGBA pixels, not a PNG — PulseVisualizer writes these straight to a raw-video ffmpeg pipe,
// so there's no reason to pay for PNG encode/decode on every frame the way the Satori/resvg
// preview path does (that one has to cross an HTTP response boundary; this one doesn't).
export async function renderPulseFrame(svg: string): Promise<{ pixels: Buffer; width: number; height: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  const task: PulseRenderTask = { svg };
  try {
    const result = await getPool().run(task, { signal: controller.signal });
    return {
      pixels: Buffer.from(result.pixels.buffer, result.pixels.byteOffset, result.pixels.byteLength),
      width: result.width,
      height: result.height,
    };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add src/render/pulseRenderWorker.ts src/render/pulseRenderWorkerPool.ts test/render/pulseRenderWorker.test.ts
git commit -m "feat: add the pulse-frame resvg render worker and its piscina pool

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: `PulseVisualizer`

**Files:**
- Create: `src/ffmpeg/pulseVisualizer.ts`
- Test: `test/ffmpeg/pulseVisualizer.test.ts`

**Interfaces:**
- Consumes: `magnitudesFromPcm` (Task 3), `PulseEngine` (Task 4), `buildPulseSvg`/`PulsePoint`
  (Task 5), `unpremultiplyRgbaInPlace` (Task 6), `renderPulseFrame` from
  `pulseRenderWorkerPool.ts` (Task 7, as the default `renderFrame`).
- Produces: `class PulseVisualizer { constructor(options: PulseVisualizerOptions);
  get audioSink(): NodeJS.WritableStream; attach(pulsePipe: NodeJS.WritableStream): void;
  close(): void }`, consumed by `StreamController` (Task 11).

- [ ] **Step 1: Write the failing tests**

```typescript
import { PassThrough, Writable } from 'stream';
import { PulseVisualizer, PulseVisualizerOptions } from '../../src/ffmpeg/pulseVisualizer';

function buildVisualizer(overrides: Partial<PulseVisualizerOptions> = {}) {
  const renderFrame = jest.fn().mockResolvedValue({ pixels: Buffer.from([1, 2, 3, 4]), width: 4, height: 1 });
  const visualizer = new PulseVisualizer({
    width: 400, height: 150, fps: 30,
    colors: ['#3b6fff', '#ff2f6e'], glowLayers: 5, glowRadius: 20, coreWidth: 2,
    renderFrame,
    now: () => Date.now() / 1000,
    ...overrides,
  });
  return { visualizer, renderFrame };
}

describe('PulseVisualizer', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('attach() starts ticking at the configured fps and renders an SVG each tick', async () => {
    const { visualizer, renderFrame } = buildVisualizer({ fps: 10 });
    const pipe = new PassThrough();
    visualizer.attach(pipe);

    jest.advanceTimersByTime(100);
    await Promise.resolve(); await Promise.resolve();

    expect(renderFrame).toHaveBeenCalledTimes(1);
    expect(renderFrame.mock.calls[0][0]).toContain('<svg');
  });

  it('writes the rendered (and unpremultiplied) pixel buffer to the attached pipe', async () => {
    const { visualizer } = buildVisualizer({
      fps: 10,
      renderFrame: jest.fn().mockResolvedValue({ pixels: Buffer.from([128, 0, 0, 128]), width: 1, height: 1 }),
    });
    const chunks: Buffer[] = [];
    const pipe = new Writable({ write: (chunk, _e, cb) => { chunks.push(chunk); cb(); } });
    visualizer.attach(pipe);

    jest.advanceTimersByTime(100);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(chunks).toHaveLength(1);
    // (128,0,0,128) premultiplied -> (255,0,0,128) once unpremultiplied — see unpremultiply.test.ts.
    expect([...chunks[0]]).toEqual([255, 0, 0, 128]);
  });

  it('resends the last frame instead of overlapping a second render when one is still pending', async () => {
    let resolveRender!: (v: { pixels: Buffer; width: number; height: number }) => void;
    const renderFrame = jest.fn().mockReturnValue(new Promise((resolve) => { resolveRender = resolve; }));
    const { visualizer } = buildVisualizer({ fps: 10, renderFrame });
    const chunks: Buffer[] = [];
    const pipe = new Writable({ write: (chunk, _e, cb) => { chunks.push(chunk); cb(); } });
    visualizer.attach(pipe);

    jest.advanceTimersByTime(100); // first tick starts a render that never resolves yet
    await Promise.resolve();
    expect(renderFrame).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(100); // second tick — must not start a second overlapping render
    await Promise.resolve();
    expect(renderFrame).toHaveBeenCalledTimes(1);

    resolveRender({ pixels: Buffer.from([10, 20, 30, 255]), width: 1, height: 1 });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('close() stops ticking — no further renders after close', async () => {
    const { visualizer, renderFrame } = buildVisualizer({ fps: 10 });
    visualizer.attach(new PassThrough());
    jest.advanceTimersByTime(100);
    await Promise.resolve();
    visualizer.close();
    renderFrame.mockClear();

    jest.advanceTimersByTime(500);
    await Promise.resolve();

    expect(renderFrame).not.toHaveBeenCalled();
  });

  it('exposes audioSink as a writable stream that accepts PCM bytes without throwing', () => {
    const { visualizer } = buildVisualizer();
    const sink = visualizer.audioSink;
    expect(() => sink.write(Buffer.alloc(2048 * 2 * 2))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/ffmpeg/pulseVisualizer.test.ts`
Expected: FAIL with "Cannot find module '../../src/ffmpeg/pulseVisualizer'"

- [ ] **Step 3: Implement it**

```typescript
import { Writable } from 'stream';
import { magnitudesFromPcm } from '../audio/pcmSpectrum';
import { PulseEngine } from '../audio/pulseEngine';
import { buildPulseSvg, PulsePoint } from '../render/pulseSvg';
import { unpremultiplyRgbaInPlace } from '../render/unpremultiply';
import { renderPulseFrame as renderPulseFrameViaPool } from '../render/pulseRenderWorkerPool';

export interface PulseVisualizerOptions {
  width: number;
  height: number;
  fps: number;
  colors: string[];
  glowLayers: number;
  glowRadius: number;
  coreWidth: number;
  bandCount?: number;
  renderFrame?: (svg: string) => Promise<{ pixels: Buffer; width: number; height: number }>;
  now?: () => number; // seconds, injectable for tests
}

const DEFAULT_BAND_COUNT = 56;
const PCM_WINDOW_SAMPLES = 2048; // matches pcmSpectrum.ts's WINDOW_SIZE
const PCM_WINDOW_BYTES = PCM_WINDOW_SAMPLES * 2 /* channels */ * 2 /* bytes/sample */;

// Owns the equalizer's video leg — the same conceptual role CanvasFeeder has for the canvas and
// AudioRelay has for decoded track audio — but it doesn't decode or own anything. It taps the PCM
// bytes AudioRelay is already piping into the shared audio pipe (via `audioSink`, wired in
// StreamController.start() alongside AudioRelay.attachTap()) — a second listener on the same
// data, not a second reader of the pipe itself.
export class PulseVisualizer {
  private readonly bandCount: number;
  private readonly engine: PulseEngine;
  private readonly renderFrame: (svg: string) => Promise<{ pixels: Buffer; width: number; height: number }>;
  private readonly now: () => number;
  private pulsePipe: NodeJS.WritableStream | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private pcmWindow = new Int16Array(PCM_WINDOW_SAMPLES * 2);
  private rendering = false;
  private cachedFrame: Buffer | null = null;
  private lastTickSeconds: number;
  private readonly sink: Writable;

  constructor(private readonly options: PulseVisualizerOptions) {
    this.bandCount = options.bandCount ?? DEFAULT_BAND_COUNT;
    this.engine = new PulseEngine({ bandCount: this.bandCount });
    this.renderFrame = options.renderFrame ?? renderPulseFrameViaPool;
    this.now = options.now ?? (() => Date.now() / 1000);
    this.lastTickSeconds = this.now();

    // Keeps only the most recent PCM_WINDOW_SAMPLES worth of interleaved stereo samples — audio
    // arrives continuously and much faster than this element needs to redraw, so this is a ring
    // buffer of "whatever's most recent", not an attempt to consume every byte.
    let carry = Buffer.alloc(0);
    this.sink = new Writable({
      write: (chunk: Buffer, _enc, callback) => {
        carry = Buffer.concat([carry, chunk]);
        if (carry.length > PCM_WINDOW_BYTES) carry = carry.subarray(carry.length - PCM_WINDOW_BYTES);
        if (carry.length === PCM_WINDOW_BYTES) {
          this.pcmWindow = new Int16Array(carry.buffer, carry.byteOffset, PCM_WINDOW_SAMPLES * 2);
        }
        callback();
      },
    });
  }

  /** The Writable AudioRelay's `attachTap()` pipes decoded PCM into — see StreamController wiring. */
  get audioSink(): NodeJS.WritableStream {
    return this.sink;
  }

  /** Called once, right after the persistent encoder starts — see StreamController.start(). */
  attach(pulsePipe: NodeJS.WritableStream): void {
    this.pulsePipe = pulsePipe;
    this.startTicking();
  }

  close(): void {
    this.stopTicking();
    this.pulsePipe = null;
  }

  private startTicking(): void {
    this.stopTicking();
    const intervalMs = 1000 / this.options.fps;
    this.tickTimer = setInterval(() => this.tick(), intervalMs);
    this.tickTimer.unref();
  }

  private stopTicking(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private tick(): void {
    // A render is already in flight — resend the last completed frame instead of overlapping a
    // second one, the same backpressure discipline CanvasFeeder's heartbeat uses.
    if (this.rendering) {
      this.writeCachedFrame();
      return;
    }
    const nowSeconds = this.now();
    const dtSeconds = nowSeconds - this.lastTickSeconds;
    this.lastTickSeconds = nowSeconds;

    const magnitudes = magnitudesFromPcm(this.pcmWindow, this.bandCount);
    const values = this.engine.update(magnitudes, dtSeconds, nowSeconds);
    const points: PulsePoint[] = values.map((v, i) => ({
      x: (i / (this.bandCount - 1)) * this.options.width,
      y: this.options.height / 2 - v * this.options.height * 0.4,
    }));
    const svg = buildPulseSvg(points, {
      width: this.options.width,
      height: this.options.height,
      colors: this.options.colors,
      glowLayers: this.options.glowLayers,
      glowRadius: this.options.glowRadius,
      coreWidth: this.options.coreWidth,
    });

    this.rendering = true;
    this.renderFrame(svg)
      .then(({ pixels }) => {
        unpremultiplyRgbaInPlace(pixels);
        this.cachedFrame = pixels;
        this.writeCachedFrame();
      })
      .catch((err) => {
        console.error('pulse frame render failed, resending the last good frame', err);
      })
      .finally(() => {
        this.rendering = false;
      });
  }

  private writeCachedFrame(): void {
    if (!this.cachedFrame || !this.pulsePipe) return;
    if ((this.pulsePipe as unknown as { writableNeedDrain?: boolean }).writableNeedDrain) return;
    this.pulsePipe.write(this.cachedFrame);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest test/ffmpeg/pulseVisualizer.test.ts`
Expected: PASS (all 5 cases)

- [ ] **Step 5: Commit**

```bash
git add src/ffmpeg/pulseVisualizer.ts test/ffmpeg/pulseVisualizer.test.ts
git commit -m "feat: add PulseVisualizer, the equalizer's video leg

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: `AudioRelay.attachTap()`

**Files:**
- Modify: `src/ffmpeg/audioRelay.ts`
- Test: `test/ffmpeg/audioRelay.test.ts`

**Interfaces:**
- Produces: `AudioRelay.attachTap(tap: NodeJS.WritableStream): void` (new method).
- Consumed by: `StreamController` (Task 11), fed `PulseVisualizer.audioSink` from Task 8.

- [ ] **Step 1: Write the failing tests**

Append to `test/ffmpeg/audioRelay.test.ts` (inside the existing `describe('AudioRelay', ...)` block):

```typescript
  it('attachTap mirrors the same decoded PCM bytes to a second destination', () => {
    const child = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValue(child);
    const relay = new AudioRelay({ spawner });
    relay.attach(new PassThrough());
    const tapChunks: Buffer[] = [];
    const tap = new Writable({ write(chunk, _enc, cb) { tapChunks.push(chunk); cb(); } });
    relay.attachTap(tap);

    relay.switchTrack('/music/a.mp3');
    child.stdout.write('pcm-bytes');
    child.stdout.end();

    expect(Buffer.concat(tapChunks).toString()).toBe('pcm-bytes');
  });

  it('unpipes the tap (as well as the audio pipe) before spawning the next track', () => {
    const child1 = fakeChild();
    const child2 = fakeChild();
    const spawner: Spawner = jest.fn().mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    const relay = new AudioRelay({ spawner });
    relay.attach(new PassThrough());
    const tapChunks: Buffer[] = [];
    const tap = new Writable({ write(chunk, _enc, cb) { tapChunks.push(chunk); cb(); } });
    relay.attachTap(tap);

    relay.switchTrack('/music/a.mp3');
    relay.switchTrack('/music/b.mp3');
    child1.stdout.write('stale');
    child2.stdout.write('fresh');
    child2.stdout.end();

    expect(Buffer.concat(tapChunks).toString()).toBe('fresh');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/ffmpeg/audioRelay.test.ts`
Expected: FAIL with "relay.attachTap is not a function"

- [ ] **Step 3: Implement it**

In `src/ffmpeg/audioRelay.ts`, add a `tap` field and `attachTap` method, and wire it into
`stopCurrent`/`spawnNext`:

```typescript
export class AudioRelay {
  private activeProcess: ChildProcessLike | null = null;
  private audioPipe: NodeJS.WritableStream | null = null;
  private tap: NodeJS.WritableStream | null = null;

  constructor(private readonly options: AudioRelayOptions) {}

  attach(audioPipe: NodeJS.WritableStream): void {
    this.audioPipe = audioPipe;
  }

  /** Optional second destination for the exact same decoded PCM bytes — see PulseVisualizer's
   * audioSink. Purely additive: never changes what reaches `audioPipe`. */
  attachTap(tap: NodeJS.WritableStream): void {
    this.tap = tap;
  }

  // ... switchTrack/switchToSilence unchanged ...

  stopCurrent(): void {
    if (this.activeProcess) {
      if (this.activeProcess.stdout && this.audioPipe) {
        this.activeProcess.stdout.unpipe(this.audioPipe);
      }
      if (this.activeProcess.stdout && this.tap) {
        this.activeProcess.stdout.unpipe(this.tap);
      }
      this.activeProcess.kill('SIGTERM');
      this.activeProcess = null;
    }
  }

  close(): void {
    this.stopCurrent();
  }

  private spawnNext(args: string[]): ChildProcessLike {
    this.stopCurrent();
    const child = this.options.spawner('ffmpeg', args);
    if (child.stdout && this.audioPipe) {
      child.stdout.pipe(this.audioPipe, { end: false });
    }
    if (child.stdout && this.tap) {
      child.stdout.pipe(this.tap, { end: false });
    }
    this.activeProcess = child;
    return child;
  }
}
```

Add `Writable` to the test file's existing `import { PassThrough, Writable } from 'stream';` line
if not already present (it already is, per the existing tests in that file).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest test/ffmpeg/audioRelay.test.ts`
Expected: PASS (all cases, including the two new ones)

- [ ] **Step 5: Commit**

```bash
git add src/ffmpeg/audioRelay.ts test/ffmpeg/audioRelay.test.ts
git commit -m "feat: let AudioRelay mirror decoded PCM to an optional tap

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: `pipe:5` — the pulse pipe on `ChildProcessWithPipes`

**Files:**
- Modify: `src/ffmpeg/types.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Produces: `ChildProcessWithPipes.pulsePipe: NodeJS.WritableStream` (new field), consumed by
  `StreamController` (Task 11) and declared as `pipe:5` in `buildPersistentEncoderArgs` (Task 12).

No dedicated unit test for `createPipeSpawner` exists today (it wraps a real `child_process.spawn`
with real OS pipes — there is nothing to unit-test without spawning a real process, which this
project's own testing strategy deliberately avoids). This task is exercised for real by Task 13's
manual verification step instead.

- [ ] **Step 1: Update the type**

In `src/ffmpeg/types.ts`, extend `ChildProcessWithPipes`:

```typescript
export interface ChildProcessWithPipes extends ChildProcessLike {
  readonly videoPipe: NodeJS.WritableStream;
  readonly audioPipe: NodeJS.WritableStream;
  // Fed only when the resolved template has an 'equalizer' element — see PulseVisualizer and
  // buildPersistentEncoderArgs's pipe:5 input. Always present on the type/child (the stdio slot
  // always exists once spawned — see createPipeSpawner), simply never written to when there's no
  // equalizer element for a given session.
  readonly pulsePipe: NodeJS.WritableStream;
}
```

- [ ] **Step 2: Update `createPipeSpawner`**

In `src/server.ts`, replace `createPipeSpawner` (currently lines 48-71):

```typescript
export function createPipeSpawner(): PipeSpawner {
  return (command: string, args: string[]): ChildProcessWithPipes => {
    // fd0 (stdin) unused, fd1 (stdout) unused. fd2 (stderr) drained the same way createSpawner()
    // does. fd3/fd4/fd5 are the video/audio/pulse pipes ffmpeg's own args reference as
    // pipe:3/pipe:4/pipe:5.
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
    child.on('error', (err) => {
      console.error('persistent encoder process failed to spawn', err);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    const videoPipe = child.stdio[3] as unknown as NodeJS.WritableStream;
    const audioPipe = child.stdio[4] as unknown as NodeJS.WritableStream;
    const pulsePipe = child.stdio[5] as unknown as NodeJS.WritableStream;
    videoPipe.on('error', (err) => { console.error('video pipe write error', err); });
    audioPipe.on('error', (err) => { console.error('audio pipe write error', err); });
    pulsePipe.on('error', (err) => { console.error('pulse pipe write error', err); });
    return Object.assign(child as unknown as ChildProcessLike, { videoPipe, audioPipe, pulsePipe }) as ChildProcessWithPipes;
  };
}
```

- [ ] **Step 3: Run the full test suite to confirm nothing else broke**

Run: `npx jest`
Expected: PASS — `test/stream/streamController.test.ts`'s fixture (`encoderChild = { videoPipe:
{}, audioPipe: {} }`) doesn't include `pulsePipe`, which is fine as long as nothing accesses it
outside the `createPulseVisualizer`-present branch Task 11 adds (that branch has no test coverage
yet at this point in the plan, since Task 11 hasn't landed — this step is just confirming the
type/server.ts change itself doesn't break anything that exists today).

- [ ] **Step 4: Commit**

```bash
git add src/ffmpeg/types.ts src/server.ts
git commit -m "feat: add pipe:5 (pulsePipe) alongside the existing video/audio pipes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11: Wire `PulseVisualizer` into `StreamController`/`StreamManager`

**Files:**
- Modify: `src/stream/streamController.ts`
- Modify: `src/stream/streamManager.ts`
- Test: `test/stream/streamController.test.ts`
- Test: `test/stream/streamManager.test.ts`

**Interfaces:**
- Consumes: `PulseVisualizer` (Task 8), `AudioRelay.attachTap` (Task 9),
  `ChildProcessWithPipes.pulsePipe` (Task 10).
- Produces: `StreamControllerDeps.createPulseVisualizer?: () => PulseVisualizer` (new optional
  field).

- [ ] **Step 1: Write the failing `StreamController` tests**

Add to `test/stream/streamController.test.ts`. First, extend `buildDeps()`'s `encoderChild` fixture
to include `pulsePipe`, and add a helper for a fake `PulseVisualizer`:

```typescript
  const encoderChild = { videoPipe: {}, audioPipe: {}, pulsePipe: {} };
```

(This one-line fixture change is safe — every existing test in this file only asserts against
`videoPipe`/`audioPipe`, so adding a third key doesn't affect them.)

Then add new tests (in the `describe('StreamController', ...)` block):

```typescript
  it('start() does nothing pulse-related when the deps have no createPulseVisualizer (no equalizer element)', async () => {
    const { deps } = buildDeps();
    const controller = new StreamController(deps);
    await expect(controller.start()).resolves.toBeUndefined();
    // No assertion beyond "doesn't throw" — deps.createPulseVisualizer is simply absent, matching
    // every other test in this file.
  });

  it('start() creates and attaches a PulseVisualizer, and taps its audioSink into the audio relay, when createPulseVisualizer is provided', async () => {
    const { deps, encoderChild, audioRelay } = buildDeps();
    const pulseVisualizer = { attach: jest.fn(), audioSink: {}, close: jest.fn() };
    deps.createPulseVisualizer = jest.fn().mockReturnValue(pulseVisualizer);
    const controller = new StreamController(deps);

    await controller.start();

    expect(pulseVisualizer.attach).toHaveBeenCalledWith(encoderChild.pulsePipe);
    expect(audioRelay.attachTap).toHaveBeenCalledWith(pulseVisualizer.audioSink);
  });

  it('stop() closes the PulseVisualizer when one was created', async () => {
    const { deps } = buildDeps();
    const pulseVisualizer = { attach: jest.fn(), audioSink: {}, close: jest.fn() };
    deps.createPulseVisualizer = jest.fn().mockReturnValue(pulseVisualizer);
    const controller = new StreamController(deps);
    await controller.start();

    controller.stop();

    expect(pulseVisualizer.close).toHaveBeenCalled();
  });
```

Also add `attachTap: jest.fn()` to `buildDeps()`'s `audioRelay` fixture object (alongside its
existing `attach: jest.fn()`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/stream/streamController.test.ts`
Expected: FAIL — `deps.createPulseVisualizer` isn't read anywhere yet, so `pulseVisualizer.attach`
is never called, and `audioRelay.attachTap` is never called.

- [ ] **Step 3: Implement the wiring**

In `src/stream/streamController.ts`, add the import and deps field:

```typescript
import { PulseVisualizer } from '../ffmpeg/pulseVisualizer';

export interface StreamControllerDeps {
  library: LibraryLike;
  queue: PlaylistQueue;
  createCanvasFeeder: () => CanvasFeeder;
  createAudioRelay: () => AudioRelay;
  createPersistentEncoder: () => PersistentEncoder;
  createPulseVisualizer?: () => PulseVisualizer;
  buildOverlay: (track: Track) => Promise<NowPlayingOverlay>;
  onError?: () => void;
  onStatusChanged?: () => void;
}
```

Add a private field:

```typescript
  private pulseVisualizer: PulseVisualizer | null = null;
```

In `start()`, right after the existing `audioRelay.attach(child.audioPipe);` line:

```typescript
    this.audioRelay = this.deps.createAudioRelay();
    this.audioRelay.attach(child.audioPipe);
    if (this.deps.createPulseVisualizer) {
      this.pulseVisualizer = this.deps.createPulseVisualizer();
      this.pulseVisualizer.attach(child.pulsePipe);
      this.audioRelay.attachTap(this.pulseVisualizer.audioSink);
    }
```

In `teardown()` (currently lines 202-214), add the close/null-out alongside the existing ones:

```typescript
  private teardown(): void {
    this.stopTimerTicker();
    this.audioRelay?.close();
    this.canvasFeeder?.close();
    this.pulseVisualizer?.close();
    this.encoder?.stop();
    this.audioRelay = null;
    this.canvasFeeder = null;
    this.pulseVisualizer = null;
    this.encoder = null;
    this.trackStartedAt = null;
    this.trackStartOffsetSeconds = 0;
    this.pausedElapsedSeconds = 0;
    this.currentOverlay = null;
  }
```

- [ ] **Step 4: Run the `StreamController` tests to verify they pass**

Run: `npx jest test/stream/streamController.test.ts`
Expected: PASS (every test in the file, including the 3 new ones)

- [ ] **Step 5: Write the failing `StreamManager` test**

Read `test/stream/streamManager.test.ts`'s existing equalizer-related test(s) first (search for
`equalizerElement`/`'equalizer'`) to match its exact fixture-building convention, then add a test
asserting: when a template has an `equalizer` element, the `StreamController` constructor call
captured by the test's `StreamController` mock receives a `createPulseVisualizer` deps field that,
when invoked, builds a `PulseVisualizer` with `width`/`height` matching the element's (rounded)
size and `colors`/`glowLayers`/`glowRadius`/`coreWidth` matching the element's own fields — and
that `createPersistentEncoder`'s `equalizer` param no longer includes a `color` field. Follow the
same mocking pattern the file already uses for asserting `gifOverlays`/the existing equalizer
`x`/`y`/`width`/`height` rounding (do not re-derive this from scratch — read the existing
`describe`/`it` blocks covering `equalizerElement` in that file and mirror their structure and
mock setup exactly).

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx jest test/stream/streamManager.test.ts`
Expected: FAIL — `createPulseVisualizer` isn't produced yet, and the existing equalizer fixture in
that test file will fail to compile/pass once `EqualizerElement` no longer has `color` (Task 1),
until this task updates the fixture too.

- [ ] **Step 7: Implement the wiring in `streamManager.ts`**

Add the import:

```typescript
import { PulseVisualizer } from '../ffmpeg/pulseVisualizer';
```

Replace the `equalizer` field inside `createPersistentEncoder`'s options object (currently lines
324-330):

```typescript
          equalizer: equalizerElement
            ? {
                x: Math.round(equalizerElement.x), y: Math.round(equalizerElement.y),
                width: Math.round(equalizerElement.width), height: Math.round(equalizerElement.height),
              }
            : undefined,
```

Add a new `createPulseVisualizer` field to the same `StreamController` construction object
(alongside `createPersistentEncoder`):

```typescript
        createPulseVisualizer: equalizerElement
          ? () => new PulseVisualizer({
              width: Math.round(equalizerElement.width),
              height: Math.round(equalizerElement.height),
              fps: VIDEO_FPS,
              colors: equalizerElement.colors,
              glowLayers: equalizerElement.glowLayers,
              glowRadius: equalizerElement.glowRadius,
              coreWidth: equalizerElement.coreWidth,
            })
          : undefined,
```

- [ ] **Step 8: Run the full backend test suite**

Run: `npx jest`
Expected: PASS — every test file in `test/`, including `test/ffmpeg/persistentEncoder.test.ts`
(its fixture never referenced `color` on `equalizer`, so Task 1's schema change doesn't touch it)
and `test/ffmpeg/persistentEncoderArgs.test.ts` (still using the OLD `showfreqs`-based
`EqualizerConfig` shape at this point in the plan — Task 12, next, is what updates it; if this run
is done strictly in task order, expect `persistentEncoderArgs.test.ts` to still be passing here
because `EqualizerConfig`'s `color` field hasn't been touched yet — only `EqualizerElement`
(templateTypes.ts) has changed so far, and `streamManager.ts`'s object literal above already
stopped passing `color` through, which is what Task 12 needs to be consistent with).

- [ ] **Step 9: Commit**

```bash
git add src/stream/streamController.ts src/stream/streamManager.ts test/stream/streamController.test.ts test/stream/streamManager.test.ts
git commit -m "feat: wire PulseVisualizer into StreamController/StreamManager

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 12: `persistentEncoderArgs.ts` — pipe:5 instead of `showfreqs`

**Files:**
- Modify: `src/ffmpeg/persistentEncoderArgs.ts`
- Test: `test/ffmpeg/persistentEncoderArgs.test.ts`

**Interfaces:**
- Produces: `EqualizerConfig { x: number; y: number; width: number; height: number }` (color/glow
  fields removed — they never reached ffmpeg; `PulseVisualizer` consumes them directly, per
  Task 8/11).

- [ ] **Step 1: Write the failing tests**

In `test/ffmpeg/persistentEncoderArgs.test.ts`, replace the `it('adds a filter_complex with
asplit/showfreqs/overlay and maps [vout]/[a_out] when equalizer is present', ...)` test with:

```typescript
  it('adds a straight-alpha rawvideo pipe:5 input and overlays it on top of the canvas when an equalizer element is present', () => {
    const args = buildPersistentEncoderArgs({
      ...base,
      equalizer: { x: 40, y: 500, width: 400, height: 150 },
    });

    // PulseVisualizer (Node) renders and unpremultiplies this frame itself — there is no more
    // ffmpeg-native showfreqs/asplit branch; ffmpeg's only job for this element is to composite
    // an already-rendered straight-alpha RGBA frame, same as any other overlay.
    expect(args).toEqual(expect.arrayContaining([
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '400x150', '-r', '30', '-i', 'pipe:5',
    ]));
    const filterArg = args[args.indexOf('-filter_complex') + 1];
    expect(filterArg).toContain('[3:v]format=yuva420p[pulse]');
    expect(filterArg).toContain('[vcanvas_top][pulse]overlay=40:500[vout]');
    expect(args).toEqual(expect.arrayContaining(['-map', '[vout]', '-map', '1:a']));
    // No more audio split for visualization — ffmpeg never touches the audio for this element any
    // more (PulseVisualizer taps AudioRelay's PCM directly in Node instead).
    expect(filterArg).not.toContain('asplit');
    expect(args).not.toEqual(expect.arrayContaining(['-map', '[a_out]']));
  });
```

Replace the `it('composites the canvas on top of the background and every gif overlay, and the
equalizer on top of that', ...)` test with:

```typescript
  it('places the pulse input after every gif input, so adding an equalizer never renumbers the gif inputs', () => {
    const args = buildPersistentEncoderArgs({
      ...base,
      equalizer: { x: 40, y: 500, width: 400, height: 150 },
      gifOverlays: [{ x: 900, y: 40, width: 150, height: 150, filePath: '/cover.gif', frameCount: 10 }],
    });

    const filterArg = args[args.indexOf('-filter_complex') + 1];
    // gif input is still index 3 (unchanged from the no-equalizer gif test above) — the pulse
    // input is appended after it, at index 4, not inserted before it.
    expect(filterArg).toContain('[3:v]loop=loop=-1:size=10,fps=30,scale=150:150[gif0]');
    expect(filterArg).toContain('[vbg][gif0]overlay=900:40[vgif0]');
    expect(filterArg).toContain('[vgif0][vcanvas]overlay=0:0[vcanvas_top]');
    expect(filterArg).toContain('[4:v]format=yuva420p[pulse]');
    expect(filterArg).toContain('[vcanvas_top][pulse]overlay=40:500[vout]');
    expect(args).toEqual(expect.arrayContaining(['-i', '/cover.gif', '-i', 'pipe:5']));
  });
```

Leave every other test in the file (the main snapshot, the `-re` position test, the canvas-fps-
upsample test, both gif tests, and both "byte-for-byte identical when omitted vs. explicitly
undefined" tests) untouched — none of them exercise `equalizer.color`, so none of them need to
change.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/ffmpeg/persistentEncoderArgs.test.ts`
Expected: FAIL on the two replaced tests (the old `showfreqs`/`asplit` filter graph is still being
generated); every other test in the file still passes.

- [ ] **Step 3: Implement it**

In `src/ffmpeg/persistentEncoderArgs.ts`, replace the `EqualizerConfig` interface (currently
lines 1-7):

```typescript
export interface EqualizerConfig {
  x: number;
  y: number;
  width: number;
  height: number;
}
```

Replace the whole body of `buildPersistentEncoderArgs` from the `const inputs = [` line through
the function's final `return` (currently lines 39-152... the exact end depends on file state after
Task 1-11's other edits, but the block to replace is everything from `const inputs = [` to the
closing `];` of the returned array):

```typescript
  const { width, height, fps, heartbeatFps, rtmpUrl, streamKey, backgroundPath, equalizer, gifOverlays = [] } = params;
  const pulseInputIndex = 3 + gifOverlays.length;
  const inputs = [
    '-f', 'rawvideo', '-pix_fmt', 'yuva420p', '-s', `${width}x${height}`, '-r', String(heartbeatFps), '-i', 'pipe:3',
    '-re', '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:4',
    '-loop', '1', '-r', String(fps), '-i', backgroundPath,
    ...gifOverlays.flatMap((g) => ['-i', g.filePath]),
    // Present only when the template has an equalizer element — this is PulseVisualizer's own
    // continuously-fed pipe (raw RGBA straight-alpha, unpremultiplied in Node — see
    // PulseVisualizer/unpremultiply.ts and the design spec's alpha spike), not an ffmpeg-native
    // filter like the earlier showfreqs MVP. Placed last, after every gif input, so adding it
    // never renumbers the gif input indices above.
    ...(equalizer ? ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${equalizer.width}x${equalizer.height}`, '-r', String(fps), '-i', 'pipe:5'] : []),
  ];

  const filterLines: string[] = [
    `[2:v]scale=${width}:${height}[vbg]`,
    `[0:v]fps=${fps},format=yuva420p[vcanvas]`,
  ];
  let videoPad = 'vbg';

  gifOverlays.forEach((gif, i) => {
    const inputIndex = 3 + i;
    const gifPad = `gif${i}`;
    const nextPad = `vgif${i}`;
    filterLines.push(
      `[${inputIndex}:v]loop=loop=-1:size=${gif.frameCount},fps=${fps},scale=${gif.width}:${gif.height}[${gifPad}]`,
    );
    filterLines.push(`[${videoPad}][${gifPad}]overlay=${gif.x}:${gif.y}[${nextPad}]`);
    videoPad = nextPad;
  });

  filterLines.push(`[${videoPad}][vcanvas]overlay=0:0[vcanvas_top]`);
  videoPad = 'vcanvas_top';

  if (equalizer) {
    // format=yuva420p is the actual straight-alpha compositing conversion — the input is declared
    // 'rgba' (straight alpha, thanks to PulseVisualizer's unpremultiply step), and this is the
    // same conversion stage every other alpha-carrying branch in this graph already goes through
    // (compare [0:v]'s own format=yuva420p above).
    filterLines.push(`[${pulseInputIndex}:v]format=yuva420p[pulse]`);
    filterLines.push(`[${videoPad}][pulse]overlay=${equalizer.x}:${equalizer.y}[vout]`);
    videoPad = 'vout';
  }

  const mapping = ['-filter_complex', filterLines.join(';'), '-map', `[${videoPad}]`, '-map', '1:a'];

  return [
    ...inputs,
    ...mapping,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', String(fps), '-g', String(fps * 2),
    '-c:a', 'aac', '-b:a', '192k',
    '-f', 'flv', `${rtmpUrl}/${streamKey}`,
  ];
```

(Keep the function's existing doc comments on the `params` object and the `-re`/`yuva420p`
reasoning above `inputs` — those still apply unchanged; only the body from `const inputs = [`
onward is replaced.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest test/ffmpeg/persistentEncoderArgs.test.ts`
Expected: PASS — all 9 tests in the file (7 unchanged + 2 replaced).

- [ ] **Step 5: Run the full backend test suite**

Run: `npx jest`
Expected: PASS, no regressions anywhere else.

- [ ] **Step 6: Commit**

```bash
git add src/ffmpeg/persistentEncoderArgs.ts test/ffmpeg/persistentEncoderArgs.test.ts
git commit -m "feat: replace the showfreqs equalizer filter graph with a pipe:5 overlay

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 13: Real-ffmpeg round-trip verification (manual, not a unit test)

**Files:** none changed — this task exercises Tasks 1-12's combined output against a real local
`ffmpeg`, per this project's own "verify against real binaries" lesson (unit tests mock every
ffmpeg-touching boundary, so a filter-graph typo or an input-ordering mistake would otherwise only
surface live, on a real stream).

- [ ] **Step 1: Generate the real args and a real pulse frame**

Create a throwaway script at the repo root (do not commit it — same pattern as this feature's
design-phase spikes):

```javascript
// scratch-pulse-verify.js
const { buildPersistentEncoderArgs } = require('./dist/ffmpeg/persistentEncoderArgs');
const { buildPulseSvg } = require('./dist/render/pulseSvg');
const { Resvg } = require('@resvg/resvg-js');
const { unpremultiplyRgbaInPlace } = require('./dist/render/unpremultiply');
const fs = require('fs');

const eqWidth = 400, eqHeight = 150;
const points = [];
for (let i = 0; i < 56; i++) {
  const x = (i / 55) * eqWidth;
  const y = eqHeight / 2 - (i === 20 ? 40 : i === 21 ? -15 : 0);
  points.push({ x, y });
}
const svg = buildPulseSvg(points, {
  width: eqWidth, height: eqHeight,
  colors: ['#3b6fff', '#b23bff', '#ff2f6e', '#b23bff', '#3bdcff'],
  glowLayers: 9, glowRadius: 42, coreWidth: 1,
});
const pixmap = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
const pixels = Buffer.from(pixmap.pixels.buffer, pixmap.pixels.byteOffset, pixmap.pixels.byteLength);
unpremultiplyRgbaInPlace(pixels);
fs.writeFileSync('scratch-pulse-frame.rgba', pixels);

const args = buildPersistentEncoderArgs({
  width: 1280, height: 720, fps: 30, heartbeatFps: 5,
  rtmpUrl: 'rtmp://localhost/live', streamKey: 'test',
  backgroundPath: 'assets/background.png',
  equalizer: { x: 40, y: 500, width: eqWidth, height: eqHeight },
});
console.log(JSON.stringify(args, null, 2));
```

Run: `npm run build && node scratch-pulse-verify.js > scratch-pulse-args.json`
Expected: prints the full args array with no thrown errors; `scratch-pulse-frame.rgba` is written
(`400 * 150 * 4` = 240000 bytes — verify with `(Get-Item scratch-pulse-frame.rgba).Length` in
PowerShell).

- [ ] **Step 2: Run the real args against real ffmpeg (swap `pipe:3`/`pipe:4`/`pipe:5` for files, since this is a one-shot manual check, not the real pipe-based process)**

Take the JSON array from Step 1, replace `pipe:3` with a raw canvas frame file, `pipe:4` with a
short silent/real PCM file, and `pipe:5` with `scratch-pulse-frame.rgba` (loop each with `-stream_loop -1` or feed a single frame with `-frames:v 1` per input as appropriate for a quick smoke check — the goal is confirming ffmpeg accepts the filter graph and produces output, not a full session), then run it directly:

```powershell
ffmpeg <substituted args> -t 1 -y scratch-pulse-output.mp4
```

Expected: exits 0, `scratch-pulse-output.mp4` exists and is playable — confirms the filter graph
string (input indices, `format=yuva420p`, `overlay=x:y`, `-map`) is syntactically and semantically
valid against a real ffmpeg binary, not just shaped correctly per the unit tests.

- [ ] **Step 3: Visually confirm the equalizer element's color/glow (not just "no error")**

Open `scratch-pulse-output.mp4` (or extract a frame with `ffmpeg -i scratch-pulse-output.mp4
-frames:v 1 scratch-pulse-check.png`) and confirm: the neon line appears at the configured
position (40, 500), is not tinted/darkened (the premultiplied-alpha bug from the design spec's
spike would show up here as a visibly muddy/dark color instead of the crisp gradient), and the
background/canvas beneath it are unaffected.

- [ ] **Step 4: Clean up every throwaway file from this task**

```powershell
Remove-Item -Force scratch-pulse-verify.js, scratch-pulse-args.json, scratch-pulse-frame.rgba, scratch-pulse-output.mp4, scratch-pulse-check.png -ErrorAction SilentlyContinue
git status --short
```

Expected: clean working tree (no `scratch-*` files left tracked or untracked).

- [ ] **Step 5: No commit for this task** (nothing but scratch files was created, and they're all
deleted in Step 4) — if Step 3 reveals a real bug, fix it as a new commit against the specific
task above it belongs to (e.g. a filter-graph ordering mistake goes back into Task 12's commit
message as a follow-up fix, not silently folded in), then re-run this task's verification from
Step 1.

---

### Task 14: Frontend — mirror the schema, add style controls

**Files:**
- Modify: `frontend/src/api/templates.ts`
- Modify: `frontend/src/pages/TemplateEditor.tsx`

**Interfaces:**
- Produces: `TemplateElement`'s `equalizer` variant in `frontend/src/api/templates.ts`, mirroring
  Task 1's backend shape exactly.

- [ ] **Step 1: Update the mirrored type**

In `frontend/src/api/templates.ts`, replace the `equalizer` union member (currently line 29):

```typescript
  | { type: 'equalizer'; x: number; y: number; width: number; height: number; colors: string[]; glowLayers: number; glowRadius: number; coreWidth: number };
```

Remove the now-stale comment above it (currently lines 27-28, "// solid hex only — ffmpeg's
showfreqs...") since the constraint it describes no longer applies — replace with:

```typescript
  // Mirrors src/templates/templateTypes.ts's EqualizerElement — colors[] feeds resvg's SVG
  // gradient (a real CSS-color renderer), not an ffmpeg filter directly, so ordinary CSS hex
  // (including 3/4-digit shorthand) is fine here, unlike 'timer' above.
```

- [ ] **Step 2: Update the create-element default factory**

In `frontend/src/pages/TemplateEditor.tsx`, replace the `case 'equalizer':` branch (currently
lines 92-93):

```typescript
    case 'equalizer':
      return {
        type: 'equalizer', x: 100, y: 500, width: 400, height: 150,
        colors: ['#3b6fff', '#b23bff', '#ff2f6e', '#b23bff', '#3bdcff'],
        glowLayers: 9, glowRadius: 42, coreWidth: 1,
      };
```

(These are the same `DEFAULT_EQUALIZER_STYLE` values from Task 1's backend constant — kept as a
literal here rather than importing it, matching this file's existing "mirrored by hand, no shared
package" convention documented at the top of the file.)

- [ ] **Step 3: Replace the single `ColorField` inspector control with the new style controls**

In `frontend/src/pages/TemplateEditor.tsx`, replace the block that currently renders:

```typescript
              {(selected.type === 'timer' || selected.type === 'equalizer') && (
                <ColorField label={t('templateEditor.fieldColor')} value={selected.color} onChange={(v) => updateElement(selectedIndex!, { color: v })} onFocus={beginHistoryGesture} onBlur={commitHistoryGesture} />
              )}
```

with:

```typescript
              {selected.type === 'timer' && (
                <ColorField label={t('templateEditor.fieldColor')} value={selected.color} onChange={(v) => updateElement(selectedIndex!, { color: v })} onFocus={beginHistoryGesture} onBlur={commitHistoryGesture} />
              )}
              {selected.type === 'equalizer' && (
                <>
                  <div className="text-xs text-gray-600">{t('templateEditor.fieldEqualizerColors')}</div>
                  {selected.colors.map((color, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <ColorField
                        label={`#${i + 1}`}
                        value={color}
                        onChange={(v) => {
                          const colors = [...selected.colors];
                          colors[i] = v;
                          updateElement(selectedIndex!, { colors });
                        }}
                        onFocus={beginHistoryGesture}
                        onBlur={commitHistoryGesture}
                      />
                      {selected.colors.length > 2 && (
                        <button
                          onClick={() => {
                            commitHistoryNow();
                            updateElement(selectedIndex!, { colors: selected.colors.filter((_, j) => j !== i) });
                          }}
                          className="text-xs text-red-600"
                        >
                          {t('templateEditor.removeElement')}
                        </button>
                      )}
                    </div>
                  ))}
                  {selected.colors.length < 6 && (
                    <button
                      onClick={() => {
                        commitHistoryNow();
                        updateElement(selectedIndex!, { colors: [...selected.colors, '#ffffff'] });
                      }}
                      className="text-xs text-blue-600"
                    >
                      + {t('templateEditor.fieldEqualizerColors')}
                    </button>
                  )}
                  <NumberField label={t('templateEditor.fieldGlowLayers')} value={selected.glowLayers} min={3} max={9} onChange={(v) => updateElement(selectedIndex!, { glowLayers: v })} onFocus={beginHistoryGesture} onBlur={commitHistoryGesture} />
                  <NumberField label={t('templateEditor.fieldGlowRadius')} value={selected.glowRadius} min={10} max={70} onChange={(v) => updateElement(selectedIndex!, { glowRadius: v })} onFocus={beginHistoryGesture} onBlur={commitHistoryGesture} />
                  <NumberField label={t('templateEditor.fieldCoreWidth')} value={selected.coreWidth} min={1} max={6} onChange={(v) => updateElement(selectedIndex!, { coreWidth: Math.round(v) })} onFocus={beginHistoryGesture} onBlur={commitHistoryGesture} />
                </>
              )}
```

- [ ] **Step 4: Add the new i18n keys**

Read `frontend/src/i18n/en.json` (and `ru.json`/`uk.json`) to find where `templateEditor.fieldColor`
is defined, and add `fieldEqualizerColors`/`fieldGlowLayers`/`fieldGlowRadius`/`fieldCoreWidth`
next to it in all three locale files (e.g. English: "Equalizer colors" / "Glow layers" / "Glow
radius" / "Core width" — translate the other two locales consistently with this file's existing
phrasing style for nearby keys).

- [ ] **Step 5: Manually verify in the dev server**

Run: `cd frontend && npm run dev`, open `/templates/:id` for a template with an equalizer element
(or add one), select it, and confirm: the color-stop list renders with add/remove controls, the
three number fields render and update the element, and no console errors appear. This step has no
automated test — `TemplateEditor.tsx` has no existing test suite to extend (per this project's
documented "no e2e/Playwright coverage" follow-up), consistent with how the MVP's own equalizer
UI changes were verified.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/templates.ts frontend/src/pages/TemplateEditor.tsx frontend/src/i18n/en.json frontend/src/i18n/ru.json frontend/src/i18n/uk.json
git commit -m "feat: add color/glow controls for the equalizer element in the template editor

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 15: Frontend — animated live preview for the equalizer element

**Files:**
- Create: `frontend/src/components/PulseEqualizerPreview.tsx`
- Modify: `frontend/src/pages/TemplateEditor.tsx`

**Interfaces:**
- Produces: `<PulseEqualizerPreview colors={string[]} glowLayers={number} glowRadius={number}
  coreWidth={number} boxWidth={number} boxHeight={number} />` — a self-contained animated canvas,
  driven by a synthetic sample-energy simulator (no real audio in the editor).

- [ ] **Step 1: Implement the component**

```typescript
import { useEffect, useRef } from 'react';

interface PulseEqualizerPreviewProps {
  colors: string[];
  glowLayers: number;
  glowRadius: number;
  coreWidth: number;
  boxWidth: number;
  boxHeight: number;
}

const BAND_COUNT = 56;

interface Pulse {
  band: number;
  amplitude: number;
  spread: number;
  attack: number;
  decay: number;
  startedAt: number;
}

function widthsFor(glowRadius: number, glowLayers: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < glowLayers; i++) {
    const f = i / (glowLayers - 1 || 1);
    out.push(glowRadius * Math.pow(1 - f, 1.5) + 0.4);
  }
  return out;
}

function tracePath(ctx: CanvasRenderingContext2D, points: { x: number; y: number }[]): void {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
}

// A client-side port of the exact same drawing recipe PulseVisualizer uses server-side (layered
// glow strokes over an angular polyline, plus a gradient) — see the design spec's "Editor: live
// preview" section for why this can't be the real audio-driven render (there's no audio playing
// in the editor) but the STYLE (colors/glow/thickness) is still true WYSIWYG, since it's driven
// by the same props the saved element carries.
export function PulseEqualizerPreview({ colors, glowLayers, glowRadius, coreWidth, boxWidth, boxHeight }: PulseEqualizerPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = boxWidth;
    canvas.height = boxHeight;

    let pulses: Pulse[] = [];
    let beatTimer = 0;
    let lastT = 0;
    let raf = 0;
    let running = true;

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    function spawnBeat(band: number, t: number) {
      const sign = Math.random() < 0.5 ? 1 : -1;
      pulses.push({ band, amplitude: sign, spread: 1.3, attack: 0.03, decay: 0.09, startedAt: t });
      pulses.push({ band: band + (Math.random() - 0.5) * 1.3, amplitude: -sign * 0.4, spread: 1.17, attack: 0.02, decay: 0.1, startedAt: t + 0.1 });
    }

    function draw(t: number) {
      const dt = lastT ? t - lastT : 0;
      lastT = t;

      beatTimer -= dt;
      if (beatTimer <= 0) {
        beatTimer = 0.35 + Math.random() * 0.3;
        spawnBeat(Math.floor(Math.random() * BAND_COUNT), t);
      }
      pulses = pulses.filter((p) => t - p.startedAt < p.attack + p.decay * 6);

      const values = new Array(BAND_COUNT).fill(0);
      for (const p of pulses) {
        const dtp = t - p.startedAt;
        if (dtp < 0) continue;
        const env = dtp < p.attack ? dtp / p.attack : Math.exp(-(dtp - p.attack) / p.decay);
        if (env < 0.002) continue;
        for (let b = 0; b < BAND_COUNT; b++) {
          const d = b - p.band;
          values[b] += p.amplitude * env * Math.exp(-(d * d) / (2 * p.spread * p.spread));
        }
      }

      ctx.clearRect(0, 0, boxWidth, boxHeight);
      const grad = ctx.createLinearGradient(0, 0, boxWidth, 0);
      colors.forEach((c, i) => grad.addColorStop(i / (colors.length - 1 || 1), c));

      const points = values.map((v, i) => ({
        x: (i / (BAND_COUNT - 1)) * boxWidth,
        y: boxHeight / 2 - Math.max(-1.3, Math.min(1.5, v)) * boxHeight * 0.4,
      }));

      const widths = widthsFor(glowRadius, glowLayers);
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
      ctx.lineWidth = coreWidth;
      ctx.stroke();

      if (running && !reduceMotion) raf = requestAnimationFrame(draw);
    }

    raf = requestAnimationFrame(draw);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, [colors, glowLayers, glowRadius, coreWidth, boxWidth, boxHeight]);

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />;
}
```

- [ ] **Step 2: Wire it into the editor's element box**

In `frontend/src/pages/TemplateEditor.tsx`, replace the existing equalizer placeholder block
(currently lines 542-556 — the translucent color-fill `div` and the `equalizerPlaceholder` label
span):

```typescript
              {el.type === 'equalizer' && (
                <PulseEqualizerPreview
                  colors={el.colors}
                  glowLayers={el.glowLayers}
                  glowRadius={el.glowRadius}
                  coreWidth={el.coreWidth}
                  boxWidth={el.width}
                  boxHeight={el.height}
                />
              )}
```

Add the import near the top of the file:

```typescript
import { PulseEqualizerPreview } from '../components/PulseEqualizerPreview';
```

Remove the now-unused `templateEditor.equalizerPlaceholder` i18n key from `en.json`/`ru.json`/
`uk.json` if it isn't referenced anywhere else in the codebase (check with a project-wide search
for `equalizerPlaceholder` first).

- [ ] **Step 3: Manually verify in the dev server**

Run: `cd frontend && npm run dev`, open a template with an equalizer element, and confirm: the
element's box now shows a live animated glowing line (not a static placeholder), it updates
immediately when a color/glow slider changes, and resizing the element's box (drag the resize
handle) doesn't distort or crash the canvas.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/PulseEqualizerPreview.tsx frontend/src/pages/TemplateEditor.tsx frontend/src/i18n/en.json frontend/src/i18n/ru.json frontend/src/i18n/uk.json
git commit -m "feat: add an animated client-side preview for the equalizer element

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 16: Full backend verification + deploy to the demo stand

**Files:** none changed — final gate before calling this feature done.

- [ ] **Step 1: Run the full backend and frontend test suites**

Run: `npm test` (backend) and `cd frontend && npm test` (frontend)
Expected: PASS, zero failures, zero skipped tests introduced by this feature.

- [ ] **Step 2: Build both**

Run: `npm run build` (backend) and `cd frontend && npm run build`
Expected: both complete with no TypeScript errors.

- [ ] **Step 3: Deploy to the remote demo host and re-verify the deployed code**

Follow this project's established deploy workflow (per prior sessions' memory): `git archive -o
file.tar HEAD` → `scp` the tar → extract on `192.168.14.26` → verify line counts match local →
`cp -a` into `/home/user/repos/super-dj/` → reapply the local-only `docker-compose.yml` port fix
(`sed -i 's/"3000:3000"/"8088:3000"/'`) → `docker compose up -d --build super-dj` → confirm the
container reaches `healthy` → `grep` the deployed `dist/` files to confirm this feature's code is
actually in the built image (e.g. `grep -c 'pulseRenderWorker' dist/ffmpeg/persistentEncoderArgs.js`
should be 0 — that file doesn't reference it by name — instead grep for a distinctive string like
`'-i', 'pipe:5'` in `dist/ffmpeg/persistentEncoderArgs.js`).

- [ ] **Step 4: Ask the user to configure an equalizer element on a real template and start a real stream**

This is the step this project's own CLAUDE.md and prior sessions consistently flag as
irreplaceable: real-ffmpeg unit-level checks (Task 13) and a real deploy (Step 3) still don't
confirm the visual actually looks right end-to-end on a real YouTube/RTMP destination with real
music playing. Report to the user that the deploy is live and ask them to restart their stream
session (redeploying kills the running `PersistentEncoder`, same as every previous deploy this
project has done) and confirm the equalizer reacts to the actual track and looks like the approved
"Неоновый пульс" prototype.

No commit for this task (verification only).
