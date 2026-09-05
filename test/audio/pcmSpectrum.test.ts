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
