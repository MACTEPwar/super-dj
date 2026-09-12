import { describe, it, expect } from 'vitest';
import { gradientCss, normalizeColorValue, insertStopAtMidpoint } from './colorValue';

describe('gradientCss (frontend mirror)', () => {
  it('matches the backend linear spelling', () => {
    expect(gradientCss({ mode: 'gradient', gradientType: 'linear', angleDeg: 45,
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 100 }] }))
      .toBe('linear-gradient(45deg, #ff0000 0%, #0000ff 100%)');
  });

  it('matches the backend radial spelling and ignores the angle', () => {
    expect(gradientCss({ mode: 'gradient', gradientType: 'radial', angleDeg: 45,
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 100 }] }))
      .toBe('radial-gradient(#ff0000 0%, #0000ff 100%)');
  });

  it('sorts stops by offset, like the backend', () => {
    expect(gradientCss({ mode: 'gradient', gradientType: 'linear', angleDeg: 0,
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#00ff00', offset: 80 }, { color: '#0000ff', offset: 30 }] }))
      .toBe('linear-gradient(0deg, #ff0000 0%, #0000ff 30%, #00ff00 80%)');
  });
});

describe('normalizeColorValue (frontend mirror)', () => {
  it('wraps a legacy plain hex string as a solid color', () => {
    expect(normalizeColorValue('#abcdef')).toEqual({ mode: 'solid', color: '#abcdef' });
  });

  it('migrates a legacy bare-string gradient', () => {
    expect(normalizeColorValue({ mode: 'gradient', stops: ['#ff0000', '#0000ff'], angleDeg: 45 })).toEqual({
      mode: 'gradient', gradientType: 'linear', angleDeg: 45,
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 100 }],
    });
  });

  it('falls back to white for anything unrecognisable', () => {
    expect(normalizeColorValue(undefined)).toEqual({ mode: 'solid', color: '#ffffff' });
  });
});

describe('insertStopAtMidpoint', () => {
  // Adding a stop must NOT re-spread the existing stops — it inserts one new stop at the
  // midpoint of the widest gap and leaves every existing offset untouched.
  it('inserts at the midpoint of the only gap for a simple 2-stop gradient', () => {
    expect(insertStopAtMidpoint([
      { color: '#a00000', offset: 0 }, { color: '#0000a0', offset: 100 },
    ])).toEqual([
      { color: '#a00000', offset: 0 }, { color: '#0000a0', offset: 100 }, { color: '#ffffff', offset: 50 },
    ]);
  });

  it('inserts at the midpoint of the WIDEST gap, leaving other stops untouched', () => {
    expect(insertStopAtMidpoint([
      { color: '#a00000', offset: 0 }, { color: '#00a000', offset: 10 }, { color: '#0000a0', offset: 100 },
    ])).toEqual([
      { color: '#a00000', offset: 0 }, { color: '#00a000', offset: 10 }, { color: '#0000a0', offset: 100 },
      { color: '#ffffff', offset: 55 },
    ]);
  });

  it('does not move or reorder any existing stop', () => {
    const original = [
      { color: '#111111', offset: 12 }, { color: '#222222', offset: 13 }, { color: '#333333', offset: 99 },
    ];
    const result = insertStopAtMidpoint(original);
    expect(result.slice(0, 3)).toEqual(original);
  });
});
