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
