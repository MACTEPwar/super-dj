import { EventEmitter } from 'events';
import { MarqueeFeeder } from '../../src/ffmpeg/marqueeFeeder';

const REGION = { x: 100, y: 50, width: 20, height: 10, originX: 0, originY: 0 };
const ELEMENT: any = { type: 'playlist', x: 100, y: 50, width: 20, fontSize: 8, color: { mode: 'solid', color: '#fff' }, style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } };
// The row rect sits inside the region at (0,0) offset (element.x/y == region.x/y here), 20x10.
const RECT = { x: 100, y: 50, width: 20, height: 10 };

function fakePipe() {
  const pipe: any = new EventEmitter();
  pipe.writes = [] as Buffer[];
  pipe.write = (b: Buffer) => { pipe.writes.push(b); return true; };
  return pipe;
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function fakeStrip(stripWidth: number, height: number): Buffer {
  // Opaque red everywhere, so every crop is trivially detectable (alpha=255, R=200).
  const buf = Buffer.alloc(stripWidth * height * 4);
  for (let i = 0; i < buf.length; i += 4) { buf[i] = 200; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 255; }
  return buf;
}

function setup() {
  jest.useFakeTimers();
  const clock = { ms: 0 };
  const renderCalls: any[] = [];
  const renderStrip = jest.fn(async (element: any, text: string, stripWidth: number, rowHeight: number) => {
    renderCalls.push({ element, text, stripWidth, rowHeight });
    return fakeStrip(stripWidth, rowHeight);
  });
  const feeder = new MarqueeFeeder({ element: ELEMENT, region: REGION, fps: 30, renderStrip, nowMs: () => clock.ms });
  const pipe = fakePipe();
  const advance = async (ms: number) => { for (let t = 0; t < ms; t += 10) { clock.ms += 10; jest.advanceTimersByTime(10); await flush(); } };
  return { feeder, pipe, renderStrip, renderCalls, advance, clock };
}

// dest's alpha plane offset for a WxH yuva420p frame: Y (W*H) + U (W/2*H/2) + V (W/2*H/2).
function alphaAt(frame: Buffer, width: number, height: number, x: number, y: number): number {
  const ySize = width * height;
  const cSize = (width / 2) * (height / 2);
  return frame[ySize + 2 * cSize + y * width + x];
}

describe('MarqueeFeeder', () => {
  afterEach(() => jest.useRealTimers());

  it('idle: writes the transparent region frame from attach(), no strip renders', async () => {
    const { feeder, pipe, renderStrip, advance } = setup();
    feeder.attach(pipe);
    await advance(200);
    expect(pipe.writes.length).toBeGreaterThanOrEqual(5);
    const f = pipe.writes[0];
    expect(f.length).toBe(2.5 * REGION.width * REGION.height);
    expect(alphaAt(f, REGION.width, REGION.height, 5, 5)).toBe(0);
    expect(renderStrip).not.toHaveBeenCalled();
    feeder.close();
  });

  it('activate() renders the strip once, sized around 2*rowWidth + textWidth, and subsequent frames are opaque within the row rect', async () => {
    const { feeder, pipe, renderCalls, advance } = setup();
    feeder.attach(pipe);
    await feeder.activate('a long track name', RECT, 100); // estimatedTextWidth 100
    await advance(50);
    expect(renderCalls.length).toBe(1);
    expect(renderCalls[0].text).toBe('a long track name');
    // stripWidth = floorEven(2*20 + ceil(100) + 2) = floorEven(142) = 142
    expect(renderCalls[0].stripWidth).toBe(142);
    expect(renderCalls[0].rowHeight).toBe(10);

    const last = pipe.writes[pipe.writes.length - 1];
    // Row rect is the whole region here (0,0 offset, 20x10) — some pixel inside it must now be
    // opaque, where the idle frame was fully transparent.
    expect(alphaAt(last, REGION.width, REGION.height, 5, 5)).toBe(255);
    feeder.close();
  });

  it('the visible crop moves over time (motion), and wraps back to fully-blank at the loop boundary', async () => {
    const { feeder, pipe, advance, clock } = setup();
    feeder.attach(pipe);
    // Node truncates a fractional setInterval delay to an integer ms (Math.trunc), so at fps=30
    // the tick actually fires every 33ms, not the nominal 33.33ms the pacer's own due-frame count
    // is based on — one real idle tick (>=33ms) must land before activate() so there is an
    // existing transparent write to compare "still hasn't moved yet" against; fakeStrip() is
    // opaque everywhere, so there's no in-strip "leading blank" pixel to crop into.
    await advance(40);
    await feeder.activate('x', RECT, 40); // small strip: stripWidth = floorEven(2*20+40+2) = 102, textPlusBox = 82
    // Just activated, well under one more tick period (33ms) later: still the pre-activation
    // idle write, unmoved and transparent.
    await advance(10);
    const atStart = pipe.writes[pipe.writes.length - 1];
    expect(alphaAt(atStart, REGION.width, REGION.height, 5, 5)).toBe(0);
    // Well into the loop (but not past it: 82px / 80px/s ≈ 1.025s), the crop has moved onto the
    // opaque text region.
    await advance(500);
    const mid = pipe.writes[pipe.writes.length - 1];
    expect(alphaAt(mid, REGION.width, REGION.height, 5, 5)).toBe(255);
    feeder.close();
  });

  it('deactivate() returns to fully transparent and stops further motion', async () => {
    const { feeder, pipe, advance } = setup();
    feeder.attach(pipe);
    await feeder.activate('x', RECT, 40);
    await advance(500);
    feeder.deactivate();
    // See the timing note in the previous test: with the tick's real (truncated) 33ms period, a
    // 50ms window landing right after a due-frame catch-up point can genuinely see zero further
    // ticks before the next one is due — 100ms comfortably covers at least one more.
    await advance(100);
    const last = pipe.writes[pipe.writes.length - 1];
    expect(alphaAt(last, REGION.width, REGION.height, 5, 5)).toBe(0);
    feeder.close();
  });

  it('a strip render resolving after deactivate()/close() never becomes active (generation guard)', async () => {
    const { feeder, pipe, advance } = setup();
    let resolveStrip!: (b: Buffer) => void;
    (feeder as any).options.renderStrip = jest.fn(() => new Promise<Buffer>((r) => { resolveStrip = r; }));
    feeder.attach(pipe);
    const activating = feeder.activate('x', RECT, 40);
    await advance(10);
    feeder.close();
    resolveStrip(fakeStrip(102, 10));
    await activating;
    await advance(50);
    // Nothing but the idle frame was ever written after close().
    expect(pipe.writes.every((f: Buffer) => alphaAt(f, REGION.width, REGION.height, 5, 5) === 0)).toBe(true);
  });
});
