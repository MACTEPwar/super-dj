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
