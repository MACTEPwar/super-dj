import { EventEmitter } from 'events';
import { PlaylistWindowFeeder, FeederCancelled } from '../../src/ffmpeg/playlistWindowFeeder';
import { planWindowTransition, InsertTransition } from '../../src/ffmpeg/playlistWindowTransition';
import { WindowRow } from '../../src/playlist/window';

const REGION = { x: 0, y: 0, width: 4, height: 2, originX: 0, originY: 0 };
const FRAME = 4 * 2 * 2.5;
const ELEMENT: any = { type: 'playlist', x: 0, y: 0, width: 4, fontSize: 22, color: { mode: 'solid', color: '#fff' }, style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } };
const row = (key: string, isCurrent = false): WindowRow => ({ key, text: key, isCurrent });
const FROM = [row('b:0', true), row('b:1'), row('b:2')];
const TO = [row('b:0', true), row('i:0'), row('b:1'), row('b:2')];
const PLAN = planWindowTransition(FROM, TO) as InsertTransition;

function fakePipe() {
  const pipe: any = new EventEmitter();
  pipe.writes = [] as Buffer[];
  pipe.write = (b: Buffer) => { pipe.writes.push(b); return true; };
  return pipe;
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function setup() {
  jest.useFakeTimers();
  const clock = { ms: 0 };
  const requests: any[] = [];
  const renderFrame = jest.fn(async (req: any) => { requests.push(req); return Buffer.alloc(FRAME, 200); });
  const feeder = new PlaylistWindowFeeder({ element: ELEMENT, region: REGION, fps: 30, renderFrame, nowMs: () => clock.ms });
  const pipe = fakePipe();
  const advance = async (ms: number) => { for (let t = 0; t < ms; t += 10) { clock.ms += 10; jest.advanceTimersByTime(10); await flush(); } };
  return { feeder, pipe, renderFrame, requests, advance };
}

describe('PlaylistWindowFeeder', () => {
  afterEach(() => jest.useRealTimers());

  it('idle: writes the transparent yuva frame from attach(), no renders (C10)', async () => {
    const { feeder, pipe, renderFrame, advance } = setup();
    feeder.attach(pipe);
    await advance(200);
    expect(pipe.writes.length).toBeGreaterThanOrEqual(5);
    const f = pipe.writes[0];
    expect(f.length).toBe(FRAME);
    expect([...f.subarray(0, 8)].every((v) => v === 16)).toBe(true);
    expect([...f.subarray(12, 20)].every((v) => v === 0)).toBe(true);
    expect(renderFrame).not.toHaveBeenCalled();
    feeder.close();
  });

  it('showRows renders settled rows (no animation props) and resolves once that frame is current', async () => {
    const { feeder, pipe, requests, advance } = setup();
    feeder.attach(pipe);
    const done = feeder.showRows(FROM);
    await advance(50);
    await done;
    expect(requests[0].rows).toEqual(FROM.map((r) => ({ key: r.key, text: r.text })));
    await advance(50);
    expect(pipe.writes[pipe.writes.length - 1][0]).toBe(200);
    feeder.close();
  });

  it('animate: ~800ms, at most one render in flight, ends on the settled TO frame', async () => {
    const { feeder, pipe, renderFrame, requests, advance } = setup();
    let inFlight = 0; let maxInFlight = 0;
    renderFrame.mockImplementation(async (req: any) => { requests.push(req); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 20)); inFlight--; return Buffer.alloc(FRAME, 200); });
    feeder.attach(pipe);
    let finished = false;
    const done = feeder.animate(PLAN).then(() => { finished = true; });
    await advance(650);
    expect(finished).toBe(false);
    await advance(350);
    await done;
    expect(maxInFlight).toBe(1);
    expect(requests.length).toBeGreaterThan(5);
    expect(requests.length).toBeLessThanOrEqual(25);
    expect(requests[requests.length - 1].rows).toEqual(TO.map((r) => ({ key: r.key, text: r.text })));
    feeder.close();
  });

  it('goIdle during animate: rejects it with FeederCancelled, transparent immediately, stale renders never written', async () => {
    const { feeder, pipe, renderFrame, advance } = setup();
    let resolveRender!: (b: Buffer<ArrayBuffer>) => void;
    renderFrame.mockImplementation(() => new Promise<Buffer<ArrayBuffer>>((r) => { resolveRender = r; }));
    feeder.attach(pipe);
    const done = feeder.animate(PLAN);
    await advance(50);
    feeder.goIdle();
    await expect(done).rejects.toBeInstanceOf(FeederCancelled);
    resolveRender(Buffer.alloc(FRAME, 200));
    await advance(100);
    expect(pipe.writes[pipe.writes.length - 1][0]).toBe(16); // still the transparent frame
    feeder.close();
  });

  it('after close(), a resolving render never writes (C8)', async () => {
    const { feeder, pipe, renderFrame, advance } = setup();
    let resolveRender!: (b: Buffer<ArrayBuffer>) => void;
    renderFrame.mockImplementation(() => new Promise<Buffer<ArrayBuffer>>((r) => { resolveRender = r; }));
    feeder.attach(pipe);
    const done = feeder.showRows(FROM).catch(() => undefined);
    await advance(20);
    feeder.close();
    const before = pipe.writes.length;
    resolveRender(Buffer.alloc(FRAME, 200));
    await advance(200);
    await done;
    expect(pipe.writes.length).toBe(before);
  });

  it('a failed intermediate frame is logged and skipped; a failed showRows rejects', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { feeder, pipe, renderFrame, advance } = setup();
    feeder.attach(pipe);
    renderFrame.mockRejectedValueOnce(new Error('boom'));
    await expect(Promise.all([feeder.showRows(FROM), advance(50)])).rejects.toThrow('boom');
    renderFrame.mockRejectedValueOnce(new Error('mid'));
    const done = feeder.animate(PLAN);
    await advance(800);
    await expect(done).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    feeder.close();
  });
});
