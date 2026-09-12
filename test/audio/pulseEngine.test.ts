import { MAX_GLOBAL_PULSE_STRENGTH, MAX_VALUE, PulseEngine, PulseEngineOptions, spreadAcrossBands } from '../../src/audio/pulseEngine';

const TICK = 1 / 30;

function onlyBand(bandCount: number, band: number, magnitude: number): number[] {
  const magnitudes = new Array(bandCount).fill(0);
  magnitudes[band] = magnitude;
  return magnitudes;
}

// Runs `ticks` updates of the same magnitudes and returns the last output.
function hold(engine: PulseEngine, magnitudes: number[], ticks: number): number[] {
  let values: number[] = [];
  for (let i = 0; i < ticks; i++) values = engine.update(magnitudes, TICK);
  return values;
}

// A deterministic stand-in for a real spectrum: per-band pseudo-music with wildly different
// absolute scales (bass ~10, treble ~0.1 — the real spread measured on a real track), a periodic
// "kick" in bands 0-2 and a per-band wobble. Pure arithmetic, so two engines can be fed
// byte-identical input and every run is reproducible.
function syntheticMagnitudes(tick: number, bandCount: number): number[] {
  const out = new Array<number>(bandCount);
  for (let band = 0; band < bandCount; band++) {
    const scale = 10 * Math.pow(0.92, band);
    const kick = band < 3 && tick % 15 === 0 ? 1 : 0;
    const wobble = 0.3 + 0.3 * Math.abs(Math.sin(tick * 0.21 + band * 0.7));
    out[band] = scale * (wobble + kick);
  }
  return out;
}

function build(overrides: Partial<PulseEngineOptions> = {}): PulseEngine {
  return new PulseEngine({ bandCount: 8, ...overrides });
}

describe('PulseEngine', () => {
  it('stays flat (all zero, never NaN) when fed silence', () => {
    const engine = build();
    const values = hold(engine, new Array(8).fill(0), 30);
    expect(values).toHaveLength(8);
    expect(values.every((v) => v === 0)).toBe(true);
  });

  it('returns one value per band at both ends of the supported band-count range', () => {
    for (const bandCount of [8, 112]) {
      const engine = new PulseEngine({ bandCount });
      const values = engine.update(syntheticMagnitudes(0, bandCount), TICK);
      expect(values).toHaveLength(bandCount);
      expect(values.every((v) => Number.isFinite(v))).toBe(true);
    }
  });

  // The core behavior change from the old onset-only design: a band's height follows its
  // current loudness continuously — a band held at half the loudness it was just at reads at
  // about half the height, and a band that stays loud STAYS up rather than flattening back to
  // the baseline the way the old flat-between-beats pulse envelope did.
  it('tracks a band\'s current loudness continuously and proportionally', () => {
    // Snappy smoothing so the level has fully settled on the new loudness within a few ticks —
    // measured there, before the band's own normalization reference (a slow-moving average, see
    // PulseEngine) has had time to follow it down and pull the ratio back up. That adaptation
    // is intended, not what this test is about.
    const engine = build({ beatBoost: 0, smoothing: 0 });
    const loud = hold(engine, onlyBand(8, 2, 1.0), 30)[2];
    const half = hold(engine, onlyBand(8, 2, 0.5), 6)[2];
    expect(loud).toBeGreaterThan(0.5);
    expect(half).toBeGreaterThan(0.1);
    expect(half / loud).toBeGreaterThan(0.35);
    expect(half / loud).toBeLessThan(0.65);
  });

  it('a band that stays loud stays up (no flattening back to the baseline while the audio is still there)', () => {
    const engine = build({ beatBoost: 0 });
    const afterOneSecond = hold(engine, onlyBand(8, 2, 1.0), 30)[2];
    const afterThreeSeconds = hold(engine, onlyBand(8, 2, 1.0), 60)[2];
    // Steady content settles at a fixed fraction of full height (1 / the engine's headroom), not
    // at the top — the top is reserved for transients above the band's own average — and not at
    // zero, which is what the old onset-only design decayed to.
    expect(afterOneSecond).toBeGreaterThan(0.3);
    expect(afterThreeSeconds).toBeGreaterThan(0.3);
    expect(afterThreeSeconds).toBeLessThan(0.7);
  });

  it('releases smoothly rather than dropping to zero the instant a band goes quiet', () => {
    const engine = build({ beatBoost: 0 });
    hold(engine, onlyBand(8, 2, 1.0), 30);
    const trail: number[] = [];
    for (let i = 0; i < 30; i++) trail.push(engine.update(new Array(8).fill(0), TICK)[2]);
    // Still clearly visible one frame after the audio stopped...
    expect(trail[0]).toBeGreaterThan(0.3);
    // ...falls monotonically...
    for (let i = 1; i < trail.length; i++) expect(trail[i]).toBeLessThanOrEqual(trail[i - 1]);
    // ...and is (nearly) gone within a second, so the line doesn't lag the music.
    expect(trail[29]).toBeLessThan(0.05);
  });

  it('attacks faster than it releases', () => {
    const engine = build({ beatBoost: 0 });
    hold(engine, new Array(8).fill(0), 5);
    let riseTicks = 0;
    while (engine.update(onlyBand(8, 2, 1.0), TICK)[2] < 0.9 && riseTicks < 100) riseTicks++;
    hold(engine, onlyBand(8, 2, 1.0), 30);
    let fallTicks = 0;
    while (engine.update(new Array(8).fill(0), TICK)[2] > 0.1 && fallTicks < 100) fallTicks++;
    expect(riseTicks).toBeLessThan(fallTicks);
  });

  it('a higher `smoothing` releases more slowly, and 0 is near-instant', () => {
    // How much of the settled level is still there one frame after the audio stops.
    const retained = (smoothing: number) => {
      const engine = build({ beatBoost: 0, smoothing });
      const before = hold(engine, onlyBand(8, 2, 1.0), 30)[2];
      return engine.update(new Array(8).fill(0), TICK)[2] / before;
    };
    const snappy = retained(0);
    const medium = retained(0.4);
    const smooth = retained(1);
    expect(snappy).toBeLessThan(medium);
    expect(medium).toBeLessThan(smooth);
    expect(snappy).toBeLessThan(0.4);
    expect(smooth).toBeGreaterThan(0.85);
  });

  it('a higher `sensitivity` draws the same band taller, up to the ceiling', () => {
    const at = (sensitivity: number) => {
      const engine = build({ beatBoost: 0, sensitivity });
      hold(engine, onlyBand(8, 2, 1.0), 30);
      return hold(engine, onlyBand(8, 2, 0.4), 30)[2];
    };
    expect(at(0.5)).toBeLessThan(at(1.5));
    expect(at(1.5)).toBeLessThan(at(3.0));
    expect(at(3.0)).toBeLessThanOrEqual(1);
  });

  // The old pulse mechanism drew every band against one absolute scale, which — with real
  // bass bands measuring ~100x louder than real treble bands — would leave the treble half of the
  // line dead. Each band is normalized (mostly) against its own recent average instead, so a
  // quiet-but-active band still dances — drawn a little lower than a loud one, so the spectrum
  // keeps its bass-heavy-left shape, but nowhere near 1/20th of its height.
  it('normalizes each band against its own recent average, so a 20x quieter band is still drawn at over half the height', () => {
    const engine = build({ beatBoost: 0 });
    const magnitudes = new Array(8).fill(0);
    magnitudes[0] = 10;
    magnitudes[7] = 0.5;
    const values = hold(engine, magnitudes, 30);
    expect(values[7]).toBeGreaterThan(values[0] * 0.5);
    expect(values[7]).toBeLessThan(values[0]);
  });

  // ...but not a band that is effectively empty relative to the rest of the track (an 8 kHz
  // lowpassed mp3's top bands hold nothing but quantization noise): that must not be amplified
  // up into a full-height bar, so the gate sits relative to the loudest band, not at zero.
  it('does not amplify a band that is only noise relative to the loudest band', () => {
    const engine = build({ beatBoost: 1 });
    const magnitudes = new Array(8).fill(0);
    magnitudes[0] = 10;
    magnitudes[7] = 0.001;
    const values = hold(engine, magnitudes, 30);
    expect(values[7]).toBeLessThan(0.05);
  });

  describe('beat boost', () => {
    // Runs two engines that differ only in beatBoost through byte-identical input and returns
    // both outputs per tick, so the accent can be isolated from the continuous level underneath.
    function compare(ticks: number, boosted: number, bandCount = 8) {
      const plain = new PulseEngine({ bandCount, beatBoost: 0 });
      const withBoost = new PulseEngine({ bandCount, beatBoost: boosted });
      const frames: { plain: number[]; boosted: number[] }[] = [];
      for (let tick = 0; tick < ticks; tick++) {
        const magnitudes = syntheticMagnitudes(tick, bandCount);
        frames.push({ plain: plain.update(magnitudes, TICK), boosted: withBoost.update(magnitudes, TICK) });
      }
      return frames;
    }

    it('adds extra height ON TOP of the continuous level on a real onset', () => {
      const frames = compare(90, 1);
      // The synthetic kick lands every 15 ticks in bands 0-2; on and right after those ticks the
      // boosted engine must sit above the plain one.
      let sawBoost = false;
      for (const kickTick of [15, 30, 45, 60, 75]) {
        for (const band of [0, 1, 2]) {
          const delta = frames[kickTick + 1].boosted[band] - frames[kickTick + 1].plain[band];
          if (delta > 0.05) sawBoost = true;
        }
      }
      expect(sawBoost).toBe(true);
    });

    it('is strictly additive and same-direction — never a negative or opposite-sign spike, on any tick, in any band', () => {
      for (const frame of compare(300, 1)) {
        for (let band = 0; band < 8; band++) {
          expect(frame.boosted[band]).toBeGreaterThanOrEqual(frame.plain[band] - 1e-9);
          expect(frame.boosted[band]).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('is a short accent that decays back onto the continuous level, not a lasting offset', () => {
      const frames = compare(90, 1);
      // Well between kicks (kick at 30, next at 45), the two engines agree again.
      for (let band = 0; band < 8; band++) {
        expect(Math.abs(frames[43].boosted[band] - frames[43].plain[band])).toBeLessThan(0.02);
      }
    });

    it('beatBoost = 0 is a pure continuous spectrum: identical to the level alone', () => {
      const a = new PulseEngine({ bandCount: 8, beatBoost: 0 });
      const b = new PulseEngine({ bandCount: 8, beatBoost: 0 });
      for (let tick = 0; tick < 60; tick++) {
        const magnitudes = syntheticMagnitudes(tick, 8);
        expect(a.update(magnitudes, TICK)).toEqual(b.update(magnitudes, TICK));
      }
    });

    it('does not keep re-firing while the same band merely stays loud', () => {
      const plain = build({ beatBoost: 0 });
      const boosted = build({ beatBoost: 1 });
      const loud = onlyBand(8, 3, 1.0);
      hold(plain, loud, 45);
      hold(boosted, loud, 45);
      // 1.5s into a sustained note the one-off onset accent has long decayed, and nothing has
      // re-triggered it, so the boosted engine reads exactly the continuous level.
      expect(Math.abs(boosted.update(loud, TICK)[3] - plain.update(loud, TICK)[3])).toBeLessThan(0.01);
    });

    it('scales with the band\'s own loudness — an onset in a near-silent band gets (almost) no accent', () => {
      const engine = build({ beatBoost: 1 });
      const magnitudes = new Array(8).fill(0);
      magnitudes[0] = 10;
      hold(engine, magnitudes, 30);
      magnitudes[6] = 0.001; // an "onset" out of silence, but 10,000x quieter than the loudest band
      const values = hold(engine, magnitudes, 2);
      expect(values[6]).toBeLessThan(0.05);
    });
  });

  // Spatial spread: a band's reaction tapers into its neighbours (centre 100%, falling off with
  // distance) instead of stopping dead at its own boundary — see spreadAcrossBands.
  describe('spread across bands', () => {
    it('spreadAcrossBands: a lone spike keeps its own height and tapers symmetrically into its neighbours, gone a few bands out', () => {
      const input = new Array(56).fill(0);
      input[20] = 1;
      const out = spreadAcrossBands(input);
      expect(out[20]).toBe(1);
      expect(out[19]).toBeGreaterThan(0.6);
      expect(out[19]).toBeLessThan(0.95);
      expect(out[18]).toBeLessThan(out[19]);
      expect(out[17]).toBeLessThan(out[18]);
      expect(out[17]).toBeGreaterThan(0.02);
      for (let d = 1; d <= 5; d++) expect(out[20 - d]).toBeCloseTo(out[20 + d], 12);
      expect(out[14]).toBeLessThan(0.01);
      expect(out[26]).toBeLessThan(0.01);
      expect(out[0]).toBe(0);
      expect(out[55]).toBe(0);
    });

    it('spreadAcrossBands: never lowers a band, and leaves a flat spectrum exactly flat', () => {
      const flat = new Array(56).fill(0.4);
      expect(spreadAcrossBands(flat)).toEqual(flat);
      const bumpy = Array.from({ length: 56 }, (_, i) => 0.2 + 0.5 * Math.abs(Math.sin(i * 0.9)));
      const out = spreadAcrossBands(bumpy);
      bumpy.forEach((v, i) => expect(out[i]).toBeGreaterThanOrEqual(v));
    });

    it('spreadAcrossBands: covers about the same share of the axis at any band count, and still spreads at 8 bands', () => {
      const widthAt = (n: number) => {
        const input = new Array(n).fill(0);
        input[Math.floor(n / 2)] = 1;
        return spreadAcrossBands(input).filter((v) => v > 0.1).length / n;
      };
      expect(widthAt(8)).toBeGreaterThan(1 / 8); // more than the spike alone
      expect(widthAt(56)).toBeGreaterThan(0.05);
      expect(widthAt(56)).toBeLessThan(0.15);
      expect(Math.abs(widthAt(112) - widthAt(56))).toBeLessThan(0.03);
    });

    it('a triggering band appears, attenuated, in its immediate neighbours and not in a distant band', () => {
      const engine = new PulseEngine({ bandCount: 56, beatBoost: 0 });
      const values = hold(engine, onlyBand(56, 20, 1.0), 30);
      expect(values[20]).toBeGreaterThan(0.3);
      expect(values[19]).toBeGreaterThan(values[20] * 0.5);
      expect(values[19]).toBeLessThan(values[20]);
      expect(values[21]).toBeCloseTo(values[19], 12);
      expect(values[18]).toBeLessThan(values[19]);
      expect(values[40]).toBe(0);
      expect(values[5]).toBe(0);
    });
  });

  // The global beat pulse (globalPulse — on the engine's own strength scale here; the template's
  // 0-20 field maps onto it via templateTypes.ts's globalPulseStrength): one broadband onset
  // detector driving a single shared "breathe" of the whole line, layered over the per-band picture.
  describe('global beat pulse', () => {
    // Bands 0-2 kick every 15 ticks (a 120 BPM beat at 30fps), bands 3-9 hold steady content
    // with a gentle wobble, bands 10-15 are genuinely silent.
    function beatMagnitudes(tick: number): number[] {
      const out = new Array<number>(16).fill(0);
      for (let band = 0; band < 10; band++) {
        const scale = 10 * Math.pow(0.8, band);
        const kick = band < 3 && tick % 15 === 0 ? 2 : 0;
        const wobble = 0.5 + 0.1 * Math.sin(tick * 0.3 + band);
        out[band] = scale * (wobble + kick);
      }
      return out;
    }

    function compare(ticks: number, strength: number) {
      const plain = new PulseEngine({ bandCount: 16, beatBoost: 0.5 });
      const withPulse = new PulseEngine({ bandCount: 16, beatBoost: 0.5, globalPulse: strength });
      const frames: { plain: number[]; pulsed: number[] }[] = [];
      for (let tick = 0; tick < ticks; tick++) {
        const magnitudes = beatMagnitudes(tick);
        frames.push({ plain: plain.update(magnitudes, TICK), pulsed: withPulse.update(magnitudes, TICK) });
      }
      return frames;
    }

    it('strength 0 is byte-identical to an engine without the option — the "off" comparison is a true baseline', () => {
      const without = new PulseEngine({ bandCount: 8 });
      const zero = new PulseEngine({ bandCount: 8, globalPulse: 0 });
      for (let tick = 0; tick < 300; tick++) {
        const magnitudes = syntheticMagnitudes(tick, 8);
        expect(zero.update(magnitudes, TICK)).toEqual(without.update(magnitudes, TICK));
      }
    });

    it('on a beat, lifts every active band at once — including bands the kick itself never touched — then settles back', () => {
      const frames = compare(120, 1);
      let sawWholeLineLift = false;
      for (const kickTick of [60, 75, 90, 105]) {
        const after = frames[kickTick + 1];
        if ([3, 4, 5, 6, 7, 8].every((band) => after.pulsed[band] > after.plain[band] + 0.03)) sawWholeLineLift = true;
        // Well before the next beat the shared envelope has decayed and the two agree again.
        const settled = frames[kickTick + 12];
        for (let band = 0; band < 16; band++) expect(Math.abs(settled.pulsed[band] - settled.plain[band])).toBeLessThan(0.03);
      }
      expect(sawWholeLineLift).toBe(true);
    });

    it('keeps the spectral detail underneath: bands scale together, so their ratios survive the hit', () => {
      const frames = compare(120, 1);
      const after = frames[76];
      expect(after.pulsed[4]).toBeGreaterThan(after.plain[4] + 0.03);
      for (const [a, b] of [[3, 5], [4, 6], [5, 7]]) {
        if (after.pulsed[a] >= MAX_VALUE - 1e-6 || after.pulsed[b] >= MAX_VALUE - 1e-6) continue; // clamped
        const plainRatio = after.plain[a] / after.plain[b];
        const pulsedRatio = after.pulsed[a] / after.pulsed[b];
        expect(Math.abs(pulsedRatio / plainRatio - 1)).toBeLessThan(0.05);
      }
    });

    it('a genuinely silent band stays on the baseline through a hit (nothing to breathe)', () => {
      for (const frame of compare(120, 1)) {
        expect(frame.pulsed[15]).toBeLessThan(0.005);
        expect(frame.pulsed[14]).toBeLessThan(0.005);
      }
    });

    it('does not keep firing on a sustained loud note', () => {
      const plain = new PulseEngine({ bandCount: 8, beatBoost: 0 });
      const pulsed = new PulseEngine({ bandCount: 8, beatBoost: 0, globalPulse: 1 });
      const loud = new Array(8).fill(1);
      hold(plain, loud, 30);
      hold(pulsed, loud, 30);
      for (let tick = 0; tick < 60; tick++) {
        const a = plain.update(loud, TICK);
        const b = pulsed.update(loud, TICK);
        for (let band = 0; band < 8; band++) expect(Math.abs(a[band] - b[band])).toBeLessThan(0.01);
      }
    });

    it('is strictly a lift, never a dip, and never leaves the value range', () => {
      for (const frame of compare(300, 1)) {
        for (let band = 0; band < 16; band++) {
          expect(frame.pulsed[band]).toBeGreaterThanOrEqual(frame.plain[band] - 1e-9);
          expect(frame.pulsed[band]).toBeLessThanOrEqual(MAX_VALUE);
        }
      }
    });

    // The template field runs 0-20 = strength 0-2, so the upper half of the knob has to keep
    // doing more — the clamp used to sit at 1 while this was an internal-only candidate, which
    // would have made 10 through 20 all identical.
    it('a strength above 1 lifts the line more than strength 1 does (the field\'s upper half is not a dead zone)', () => {
      const at1 = new PulseEngine({ bandCount: 16, beatBoost: 0.5, globalPulse: 1 });
      const atMax = new PulseEngine({ bandCount: 16, beatBoost: 0.5, globalPulse: MAX_GLOBAL_PULSE_STRENGTH });
      let sawStrongerLift = false;
      for (let tick = 0; tick < 120; tick++) {
        const magnitudes = beatMagnitudes(tick);
        const a = at1.update(magnitudes, TICK);
        const b = atMax.update(magnitudes, TICK);
        for (let band = 0; band < 16; band++) expect(b[band]).toBeGreaterThanOrEqual(a[band] - 1e-9);
        // Right after a beat, on a mid band that's active but not pinned at the ceiling.
        if (tick % 15 === 1 && tick > 30 && a[5] < MAX_VALUE - 1e-6 && b[5] > a[5] + 0.03) sawStrongerLift = true;
      }
      expect(sawStrongerLift).toBe(true);
    });

    it('clamps a strength above MAX_GLOBAL_PULSE_STRENGTH down to it', () => {
      const atMax = new PulseEngine({ bandCount: 8, globalPulse: MAX_GLOBAL_PULSE_STRENGTH });
      const beyond = new PulseEngine({ bandCount: 8, globalPulse: 100 });
      for (let tick = 0; tick < 120; tick++) {
        const magnitudes = syntheticMagnitudes(tick, 8);
        expect(beyond.update(magnitudes, TICK)).toEqual(atMax.update(magnitudes, TICK));
      }
    });
  });

  it('never produces a negative, NaN, or above-ceiling value for extreme inputs', () => {
    for (const sensitivity of [0.5, 3.0]) {
      for (const beatBoost of [0, 1]) {
        for (const smoothing of [0, 1]) {
          for (const globalPulse of [0, 1, MAX_GLOBAL_PULSE_STRENGTH]) {
            const engine = new PulseEngine({ bandCount: 8, sensitivity, beatBoost, smoothing, globalPulse });
            for (let tick = 0; tick < 200; tick++) {
              const magnitudes = tick % 7 === 0
                ? new Array(8).fill(0)
                : syntheticMagnitudes(tick, 8).map((m) => (tick % 11 === 0 ? m * 1e4 : m));
              const values = engine.update(magnitudes, tick % 13 === 0 ? 0 : TICK);
              for (const v of values) {
                expect(Number.isFinite(v)).toBe(true);
                expect(v).toBeGreaterThanOrEqual(0);
                expect(v).toBeLessThanOrEqual(1.25);
              }
            }
          }
        }
      }
    }
  });

  it('tolerates a zero, huge or negative dt (a stalled or non-monotonic clock) without blowing up', () => {
    const engine = build({ globalPulse: 1 });
    for (const dt of [0, 100, -1, Number.NaN]) {
      const values = engine.update(syntheticMagnitudes(3, 8), dt);
      for (const v of values) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1.25);
      }
    }
  });

  // The direct regression guard for "the whole visual is a pure function of the audio": two
  // engines fed byte-identical magnitudes must draw byte-identical lines. Fails immediately if
  // anything in the class reaches for Math.random() again.
  it('is deterministic: two engines fed the same magnitudes produce identical output', () => {
    const a = build();
    const b = build();
    let sawMovement = false;
    for (let tick = 0; tick < 200; tick++) {
      const magnitudes = syntheticMagnitudes(tick, 8);
      const first = a.update(magnitudes, TICK);
      const second = b.update(magnitudes, TICK);
      expect(first).toEqual(second);
      if (first.some((v) => v !== 0)) sawMovement = true;
    }
    // Guards the guard: two engines that never moved at all would trivially "agree" on all-zero.
    expect(sawMovement).toBe(true);
  });
});
