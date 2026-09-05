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
