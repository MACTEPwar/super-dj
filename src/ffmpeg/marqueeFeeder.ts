import { RawFramePacer } from './rawFramePacer';
import { transparentYuva420p, rgbaToYuva420p, blitYuva420p } from '../render/yuva420p';
import { PlaylistWindowRegion } from '../render/playlistWindowGeometry';
import { PlaylistElement } from '../templates/templateTypes';
import { renderMarqueeStripFrame } from '../render/playlistWindowRenderPool';

// The spike's own value (real local ffmpeg, visually confirmed smooth and readable) — see the
// design spec. Not user-configurable in this iteration.
export const MARQUEE_SPEED_PX_PER_SEC = 80;

const floorEven = (n: number) => Math.floor(n / 2) * 2;

export interface MarqueeRowRect { x: number; y: number; width: number; height: number }

export interface MarqueeFeederOptions {
  element: PlaylistElement;
  region: PlaylistWindowRegion;
  fps: number;
  renderStrip?: (element: PlaylistElement, text: string, stripWidth: number, rowHeight: number, paddingLeft: number) => Promise<Buffer>;
  nowMs?: () => number;
}

interface ActiveMarquee {
  stripRgba: Buffer;
  stripWidth: number;
  rect: MarqueeRowRect; // already floored to even
  activatedAtMs: number;
}

function extractRgbaSlice(strip: Buffer, stripWidth: number, height: number, offsetX: number, width: number): Buffer {
  const out = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const srcStart = (row * stripWidth + offsetX) * 4;
    strip.copy(out, row * width * 4, srcStart, srcStart + width * 4);
  }
  return out;
}

/**
 * The pipe:8 frame player for the current track's marquee. Unlike PlaylistWindowFeeder, there is
 * no per-frame Satori/resvg render: activate() renders the row's FULL text once into a wide,
 * padded strip (see src/render/sceneRenderer.ts's renderMarqueeStripPixels), and every tick after
 * that just crops a moving window out of that strip and composites it into a region-sized
 * transparent yuva420p frame — plain byte copies. See the design spec's "Chosen approach:
 * pre-rendered text strip + per-frame crop" for why.
 */
export class MarqueeFeeder {
  private readonly pacer: RawFramePacer;
  private readonly nowMs: () => number;
  private readonly idleFrame: Buffer;
  private generation = 0;
  private closed = false;
  private tickTimer: NodeJS.Timeout | null = null;
  private active: ActiveMarquee | null = null;

  constructor(private readonly options: MarqueeFeederOptions) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.pacer = new RawFramePacer({ fps: options.fps, now: () => this.nowMs() / 1000 });
    this.idleFrame = transparentYuva420p(options.region.width, options.region.height);
    this.pacer.setFrame(this.idleFrame);
  }

  attach(pipe: NodeJS.WritableStream): void {
    this.pacer.attach(pipe);
    this.tickTimer = setInterval(() => this.tick(), 1000 / this.options.fps);
    this.tickTimer.unref();
    this.pacer.writeDueFrames();
  }

  // text: the row's NAME ONLY — the caller (StreamController) strips the "▶ " marker before
  // calling this, and bakes the marker itself as the static row override, so the marker is
  // never covered by the scrolling name (see streamScene.ts's resolveMarqueeRow). estimatedTextWidth:
  // the caller's own measureTextWidth() result for `text` — sizes the strip generously; doesn't
  // need to be pixel-exact (see renderMarqueeStripPixels's doc comment).
  async activate(text: string, rect: MarqueeRowRect, estimatedTextWidth: number): Promise<void> {
    const generation = ++this.generation;
    const evenRect: MarqueeRowRect = {
      x: floorEven(rect.x), y: floorEven(rect.y),
      width: floorEven(rect.width), height: floorEven(rect.height),
    };
    // A full row-width of blank BEFORE the text, so the crop window sliding across the strip
    // shows a full blank row before the text is first revealed (and, symmetrically, a full
    // blank row after it — the strip's own width already reserves that trailing space). Without
    // this the text starts at the strip's own edge and the loop pops the name in and out at full
    // width instead of gliding through a blank gap on both sides.
    const paddingLeft = evenRect.width;
    const stripWidth = floorEven(2 * evenRect.width + Math.ceil(estimatedTextWidth) + 2);
    const renderStrip = this.options.renderStrip
      ?? ((el, t, w, h, p) => renderMarqueeStripFrame({ element: el, text: t, stripWidth: w, rowHeight: h, paddingLeft: p }));
    const stripRgba = await renderStrip(this.options.element, text, stripWidth, evenRect.height, paddingLeft);
    if (this.closed || generation !== this.generation) return;
    this.active = { stripRgba, stripWidth, rect: evenRect, activatedAtMs: this.nowMs() };
  }

  deactivate(): void {
    this.generation += 1;
    this.active = null;
    this.pacer.setFrame(this.idleFrame);
  }

  close(): void {
    this.deactivate();
    this.closed = true;
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    this.pacer.detach();
  }

  private tick(): void {
    try {
      if (this.active) this.pacer.setFrame(this.composeFrame(this.active));
      this.pacer.writeDueFrames();
    } catch (err) {
      // A bare setInterval callback: an uncaught throw would kill every tenant's stream.
      console.error('marquee tick failed', err);
    }
  }

  private composeFrame(active: ActiveMarquee): Buffer {
    const { rect, stripRgba, stripWidth, activatedAtMs } = active;
    const textPlusBox = stripWidth - rect.width;
    const elapsedSec = Math.max(0, (this.nowMs() - activatedAtMs) / 1000);
    const cropX = Math.floor((elapsedSec * MARQUEE_SPEED_PX_PER_SEC) % textPlusBox);
    const slice = extractRgbaSlice(stripRgba, stripWidth, rect.height, cropX, rect.width);
    const sliceYuva = rgbaToYuva420p(slice, rect.width, rect.height);
    const frame = Buffer.from(this.idleFrame);
    blitYuva420p(
      frame, this.options.region.width, this.options.region.height,
      sliceYuva, rect.width, rect.height,
      rect.x - this.options.region.x, rect.y - this.options.region.y,
    );
    return frame;
  }
}
