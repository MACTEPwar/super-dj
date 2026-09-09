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

  // The direct regression guard for "the whole visual is a pure function of the audio": two
  // engines fed byte-identical magnitudes must draw byte-identical lines. Fails immediately if
  // anything in the class reaches for Math.random() again.
  it('is deterministic: two engines fed the same magnitudes produce identical output', () => {
    const a = new PulseEngine({ bandCount: 8 });
    const b = new PulseEngine({ bandCount: 8 });
    let sawMovement = false;
    for (let tick = 0; tick < 200; tick++) {
      const magnitudes = new Array(8)
        .fill(0)
        .map((_, band) => Math.max(0, Math.sin(tick * 0.37 + band * 1.1) * Math.cos(tick * 0.11 + band)) * (1 + band / 4));
      const nowSeconds = tick * 0.03;
      const first = a.update(magnitudes, 0.03, nowSeconds);
      const second = b.update(magnitudes, 0.03, nowSeconds);
      expect(first).toEqual(second);
      if (first.some((v) => v !== 0)) sawMovement = true;
    }
    // Guards the guard: two engines that never pulsed at all would trivially "agree" on all-zero.
    expect(sawMovement).toBe(true);
  });

  it('spikes up when a band hits harder than its own previous onset, and down when it hits softer', () => {
    const engine = new PulseEngine({ bandCount: 8 });
    const onlyBand3 = (magnitude: number) => {
      const magnitudes = new Array(8).fill(0);
      magnitudes[3] = magnitude;
      return magnitudes;
    };

    // Onset 1: out of a band sitting at zero — the hardest possible onset (strength 1).
    engine.update(onlyBand3(0.1), 0.03, 0);
    // Onset 2, one second later: 0.2 only just clears floor(0.1) * triggerRatio(1.6) = 0.16, so
    // this is a much softer onset than the one before it -> the spike goes down.
    engine.update(onlyBand3(0.2), 1.0, 1.0);
    const softer = engine.update(onlyBand3(0), 0.03, 1.03); // read at the spike's attack peak
    expect(softer[3]).toBeLessThan(0);

    // Let the floor decay back down, then hit far harder than onset 2 did -> the spike goes up.
    engine.update(onlyBand3(0), 1.0, 2.03);
    engine.update(onlyBand3(0.6), 0.03, 2.06);
    const harder = engine.update(onlyBand3(0), 0.03, 2.09);
    expect(harder[3]).toBeGreaterThan(0);
  });

  it('draws the approved silhouette: a sharp spike followed by a smaller notch the other way', () => {
    const engine = new PulseEngine({ bandCount: 8 });
    const spiked = new Array(8).fill(0);
    spiked[3] = 1.0;
    engine.update(spiked, 0.03, 0);

    let highest = 0;
    let lowest = 0;
    for (let tick = 1; tick <= 60; tick++) {
      const values = engine.update(new Array(8).fill(0), 0.01, tick * 0.01);
      highest = Math.max(highest, ...values);
      lowest = Math.min(lowest, ...values);
    }
    expect(highest).toBeGreaterThan(0.5); // the spike
    expect(lowest).toBeLessThan(-0.03); // the opposite-direction notch behind it
    expect(Math.abs(lowest)).toBeLessThan(highest); // ...and it is the smaller of the two
  });
});
