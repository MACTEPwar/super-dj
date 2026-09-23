import { planWindowTransition, settledRows, animatedRowsAt, INSERT_ANIMATION_MS, InsertTransition } from '../../src/ffmpeg/playlistWindowTransition';
import { WindowRow } from '../../src/playlist/window';

const row = (key: string, isCurrent = false): WindowRow => ({ key, text: `  ${key}`, isCurrent });
const FROM = [row('b:0'), row('b:1', true), row('b:2'), row('b:3')];
const TO = [row('b:0'), row('b:1', true), row('i:0'), row('b:2')];

describe('planWindowTransition', () => {
  it('none for identical rows', () => {
    expect(planWindowTransition(FROM, FROM.map((r) => ({ ...r })))).toEqual({ kind: 'none' });
  });
  it('snap from empty', () => {
    expect(planWindowTransition([], FROM).kind).toBe('snap');
  });
  it('insert after the current row, bottom row falling off', () => {
    const t = planWindowTransition(FROM, TO);
    expect(t.kind).toBe('insert');
    if (t.kind === 'insert') expect([...t.insertedKeys]).toEqual(['i:0']);
  });
  it('two inserts at once are one insert transition', () => {
    const to = [row('b:0'), row('b:1', true), row('i:0'), row('i:1'), row('b:2'), row('b:3')];
    const t = planWindowTransition(FROM, to);
    expect(t.kind === 'insert' && t.insertedKeys.size).toBe(2);
  });
  it('snap when the current row changes (a track advance, C5)', () => {
    expect(planWindowTransition(FROM, [row('b:1'), row('b:2', true), row('b:3')]).kind).toBe('snap');
  });
  it('snap when a shared row changed text', () => {
    expect(planWindowTransition(FROM, FROM.map((r) => (r.key === 'b:2' ? { ...r, text: 'renamed' } : r))).kind).toBe('snap');
  });
  it('snap when a row vanished from the middle', () => {
    expect(planWindowTransition(FROM, [row('b:0'), row('b:1', true), row('b:3')]).kind).toBe('snap');
  });
});

describe('animated rows', () => {
  const t = planWindowTransition(FROM, TO) as InsertTransition;
  const byKey = (rows: { key: string }[], key: string) => rows.find((r) => r.key === key) as any;

  it('settled rows carry NO animation props (so the Satori node is byte-identical to the baked one)', () => {
    expect(settledRows(TO)).toEqual(TO.map((r) => ({ key: r.key, text: r.text })));
    for (const r of settledRows(TO)) expect(Object.keys(r).sort()).toEqual(['key', 'text']);
  });

  it('t=0: the new row has zero height and is invisible; the pushed-out row is fully visible below', () => {
    const rows = animatedRowsAt(t, 0);
    expect(rows.map((r) => r.key)).toEqual(['b:0', 'b:1', 'i:0', 'b:2', 'b:3']);
    expect(byKey(rows, 'i:0')).toMatchObject({ maxHeightFactor: 0, opacity: 0, offsetX: 36 });
    expect(byKey(rows, 'b:3')).toMatchObject({ opacity: 1 });
    expect(Object.keys(byKey(rows, 'b:2'))).toEqual(['key', 'text']); // kept rows untouched
  });

  it('by 480ms the gap is fully open and the pushed-out row gone; the content only starts after 320ms', () => {
    expect(byKey(animatedRowsAt(t, 250), 'i:0').opacity).toBe(0);
    const rows = animatedRowsAt(t, 480);
    expect(byKey(rows, 'i:0').maxHeightFactor).toBeCloseTo(1.5);
    expect(byKey(rows, 'b:3').opacity).toBe(0);
  });

  it('at the end it is exactly settledRows(to)', () => {
    expect(animatedRowsAt(t, INSERT_ANIMATION_MS)).toEqual(settledRows(TO));
    expect(animatedRowsAt(t, 5000)).toEqual(settledRows(TO));
  });

  it('gap growth is monotonic and never overshoots', () => {
    let last = -1;
    for (let ms = 0; ms <= INSERT_ANIMATION_MS; ms += 20) {
      const f = byKey(animatedRowsAt(t, ms), 'i:0')?.maxHeightFactor ?? 1.5;
      expect(f).toBeGreaterThanOrEqual(last);
      expect(f).toBeLessThanOrEqual(1.5);
      last = f;
    }
  });
});
