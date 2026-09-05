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
