import { Writable } from 'stream';
import { magnitudesFromPcm } from '../audio/pcmSpectrum';
import { PulseEngine } from '../audio/pulseEngine';
import { buildPulseSvg, PulsePoint } from '../render/pulseSvg';
import { unpremultiplyRgbaInPlace } from '../render/unpremultiply';
import { renderPulseFrame as renderPulseFrameViaPool } from '../render/pulseRenderWorkerPool';

export interface PulseVisualizerOptions {
  width: number;
  height: number;
  fps: number;
  colors: string[];
  glowLayers: number;
  glowRadius: number;
  coreWidth: number;
  bandCount?: number;
  renderFrame?: (svg: string) => Promise<{ pixels: Buffer; width: number; height: number }>;
  now?: () => number; // seconds, injectable for tests
}

const DEFAULT_BAND_COUNT = 56;
const PCM_WINDOW_SAMPLES = 2048; // matches pcmSpectrum.ts's WINDOW_SIZE
const PCM_WINDOW_BYTES = PCM_WINDOW_SAMPLES * 2 /* channels */ * 2; /* bytes/sample */

// Owns the equalizer's video leg — the same conceptual role CanvasFeeder has for the canvas and
// AudioRelay has for decoded track audio — but it doesn't decode or own anything. It taps the PCM
// bytes AudioRelay is already piping into the shared audio pipe (via `audioSink`, wired in
// StreamController.start() alongside AudioRelay.attachTap()) — a second listener on the same
// data, not a second reader of the pipe itself.
export class PulseVisualizer {
  private readonly bandCount: number;
  private readonly engine: PulseEngine;
  private readonly renderFrame: (svg: string) => Promise<{ pixels: Buffer; width: number; height: number }>;
  private readonly now: () => number;
  private pulsePipe: NodeJS.WritableStream | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private pcmWindow = new Int16Array(PCM_WINDOW_SAMPLES * 2);
  private rendering = false;
  private cachedFrame: Buffer | null = null;
  private lastTickSeconds: number;
  private readonly sink: Writable;

  constructor(private readonly options: PulseVisualizerOptions) {
    this.bandCount = options.bandCount ?? DEFAULT_BAND_COUNT;
    this.engine = new PulseEngine({ bandCount: this.bandCount });
    this.renderFrame = options.renderFrame ?? renderPulseFrameViaPool;
    this.now = options.now ?? (() => Date.now() / 1000);
    this.lastTickSeconds = this.now();

    // Keeps only the most recent PCM_WINDOW_SAMPLES worth of interleaved stereo samples — audio
    // arrives continuously and much faster than this element needs to redraw, so this is a ring
    // buffer of "whatever's most recent", not an attempt to consume every byte.
    let carry = Buffer.alloc(0);
    this.sink = new Writable({
      write: (chunk: Buffer, _enc, callback) => {
        try {
          carry = Buffer.concat([carry, chunk]);
          if (carry.length > PCM_WINDOW_BYTES) {
            // Trimmed to a 4-byte (stereo s16le frame) boundary — reads off the OS pipe arrive in
            // arbitrary byte counts, not necessarily frame-aligned, so this keeps channel phase
            // consistent rather than drifting by 1-3 bytes on an unlucky chunk size.
            const overflow = carry.length - PCM_WINDOW_BYTES;
            carry = carry.subarray(overflow - (overflow % 4));
          }
          if (carry.length >= PCM_WINDOW_BYTES) {
            // Copied into an owned, zero-offset buffer rather than aliasing carry's own memory:
            // carry.byteOffset (after subarray()) isn't guaranteed even, and Int16Array's
            // constructor throws a RangeError on an odd byteOffset — reproduced crashing the
            // whole process via exactly this path (an uncaught exception in a stream's `_write`
            // has no listener to catch it, unlike a normal thrown/rejected error elsewhere).
            const window = Buffer.allocUnsafe(PCM_WINDOW_BYTES);
            carry.copy(window, 0, carry.length - PCM_WINDOW_BYTES);
            this.pcmWindow = new Int16Array(window.buffer, window.byteOffset, PCM_WINDOW_SAMPLES * 2);
          }
        } catch (err) {
          console.error('pulse audio tap failed to process a PCM chunk, spectrum stays stale', err);
        }
        callback();
      },
    });
    this.sink.on('error', (err) => {
      console.error('pulse audio tap stream errored, spectrum stays stale', err);
    });
  }

  /** The Writable AudioRelay's `attachTap()` pipes decoded PCM into — see StreamController wiring. */
  get audioSink(): NodeJS.WritableStream {
    return this.sink;
  }

  /** Called once, right after the persistent encoder starts — see StreamController.start(). */
  attach(pulsePipe: NodeJS.WritableStream): void {
    this.pulsePipe = pulsePipe;
    this.startTicking();
  }

  close(): void {
    this.stopTicking();
    this.pulsePipe = null;
  }

  private startTicking(): void {
    this.stopTicking();
    const intervalMs = 1000 / this.options.fps;
    this.tickTimer = setInterval(() => this.tick(), intervalMs);
    this.tickTimer.unref();
  }

  private stopTicking(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private tick(): void {
    try {
      this.tickUnsafe();
    } catch (err) {
      // A bare setInterval callback: an uncaught synchronous throw here has nothing to catch it
      // and kills the whole process — every tenant's active stream, not just this one. Defense in
      // depth on top of normalizeEqualizerElement (templateTypes.ts), which is the actual fix for
      // the one concrete way this used to throw (a legacy template element with no colors[]).
      console.error('pulse visualizer tick failed, resending the last good frame', err);
    }
  }

  private tickUnsafe(): void {
    // A render is already in flight — resend the last completed frame instead of overlapping a
    // second one, the same backpressure discipline CanvasFeeder's heartbeat uses.
    if (this.rendering) {
      this.writeCachedFrame();
      return;
    }
    const nowSeconds = this.now();
    const dtSeconds = nowSeconds - this.lastTickSeconds;
    this.lastTickSeconds = nowSeconds;

    const magnitudes = magnitudesFromPcm(this.pcmWindow, this.bandCount);
    const values = this.engine.update(magnitudes, dtSeconds, nowSeconds);
    const points: PulsePoint[] = values.map((v, i) => ({
      x: (i / (this.bandCount - 1)) * this.options.width,
      y: this.options.height / 2 - v * this.options.height * 0.4,
    }));
    const svg = buildPulseSvg(points, {
      width: this.options.width,
      height: this.options.height,
      colors: this.options.colors,
      glowLayers: this.options.glowLayers,
      glowRadius: this.options.glowRadius,
      coreWidth: this.options.coreWidth,
    });

    this.rendering = true;
    this.renderFrame(svg)
      .then(({ pixels }) => {
        unpremultiplyRgbaInPlace(pixels);
        this.cachedFrame = pixels;
        this.writeCachedFrame();
      })
      .catch((err) => {
        console.error('pulse frame render failed, resending the last good frame', err);
      })
      .finally(() => {
        this.rendering = false;
      });
  }

  private writeCachedFrame(): void {
    if (!this.cachedFrame || !this.pulsePipe) return;
    if ((this.pulsePipe as unknown as { writableNeedDrain?: boolean }).writableNeedDrain) return;
    this.pulsePipe.write(this.cachedFrame);
  }
}
