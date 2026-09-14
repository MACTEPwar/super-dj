import { Writable } from 'stream';
import { magnitudesFromPcm } from '../audio/pcmSpectrum';
import { PcmRingBuffer } from '../audio/pcmRingBuffer';
import { PulseEngine } from '../audio/pulseEngine';
import { buildPulseSvg, layoutPulsePoints } from '../render/pulseSvg';
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
  // Reactivity knobs, passed straight through to PulseEngine (see its options for semantics).
  sensitivity?: number;
  smoothing?: number;
  beatBoost?: number;
  // On PulseEngine's own strength scale (0..MAX_GLOBAL_PULSE_STRENGTH, 0 = off, the default) —
  // NOT the template's 0-20 field; buildStreamScene() (streamScene.ts) converts via
  // templateTypes.ts's globalPulseStrength() before constructing this.
  globalPulse?: number;
  renderFrame?: (svg: string) => Promise<{ pixels: Buffer; width: number; height: number }>;
  now?: () => number; // seconds, injectable for tests
  // The FFT-and-band step, injectable so a test can see the exact PCM window each tick analyzes.
  analyzeSpectrum?: (pcm: Int16Array, bandCount: number) => number[];
}

const DEFAULT_BAND_COUNT = 56;
// The most frames a single tick will write to catch the frame count up after the event loop was
// stalled — ~1/3s at 30fps, longer than CanvasFeeder's 200ms heartbeat, so any stall the canvas
// heartbeat itself rides out without losing a frame is caught up fully here too. A longer stall
// cost the canvas frames as well (it has no catch-up), so replaying it all here would only push
// this pipe ahead of the canvas and pin it against backpressure — and this also bounds how much
// raw RGBA a catch-up can ever park in Node's write buffer at once (see writeDueFrames).
export const MAX_CATCH_UP_FRAMES = 10;
const PCM_WINDOW_SAMPLES = 2048; // matches pcmSpectrum.ts's WINDOW_SIZE
const PCM_FRAME_BYTES = 2 /* channels */ * 2; /* bytes/sample */
const PCM_WINDOW_BYTES = PCM_WINDOW_SAMPLES * PCM_FRAME_BYTES;
// pipe:4's declared format (s16le, 44.1kHz, stereo — see persistentEncoderArgs.ts and
// audioRelayArgs.ts): the stream's byte position IS its presentation time.
const PCM_SAMPLE_RATE = 44100;
export const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * PCM_FRAME_BYTES;
// How much audio the ring holds. It must cover how far the tap can run AHEAD of the frame being
// rendered (see loadAnalysisWindow): measured against a real encoder, 0.3-1.4s in steady state but up to
// ~5s right after start on Windows, whose kernel pipe swallowed ~900KB before backpressuring
// (Linux pipes hold 64KB, so less there). 10s leaves a wide margin at 1.76MB per active element.
export const PCM_RING_SECONDS = 10;

// Owns the equalizer's video leg — the same conceptual role CanvasFeeder has for the canvas and
// AudioRelay has for decoded track audio — but it doesn't decode or own anything. It taps the PCM
// bytes AudioRelay is already piping into the shared audio pipe (via `audioSink`, wired in
// StreamController.start() alongside AudioRelay.attachTap()) — a second listener on the same
// data, not a second reader of the pipe itself.
export class PulseVisualizer {
  private readonly bandCount: number;
  private readonly engine: PulseEngine;
  private readonly renderFrame: (svg: string) => Promise<{ pixels: Buffer; width: number; height: number }>;
  private readonly analyzeSpectrum: (pcm: Int16Array, bandCount: number) => number[];
  private readonly now: () => number;
  private pulsePipe: NodeJS.WritableStream | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private readonly pcm = new PcmRingBuffer(PCM_RING_SECONDS * PCM_BYTES_PER_SECOND);
  // One reusable analysis window; pcmWindow aliases windowBytes' memory (an Int16Array view needs
  // an even byteOffset, which a fresh zero-offset allocation guarantees — a subarray() of an
  // incoming chunk did not, and constructing the view on one crashed the process once).
  private readonly windowBytes = Buffer.alloc(PCM_WINDOW_BYTES);
  private readonly pcmWindow = new Int16Array(this.windowBytes.buffer, this.windowBytes.byteOffset, PCM_WINDOW_SAMPLES * 2);
  private rendering = false;
  private cachedFrame: Buffer | null = null;
  private lastTickSeconds: number;
  private attachedAtSeconds = 0;
  // Frames written plus frames deliberately forgiven — see writeDueFrames() for the distinction.
  private framesAccounted = 0;
  // Frames actually written to pipe:5 — i.e. the index ffmpeg will give the next one, which is
  // what fixes its place on the output timeline (see loadAnalysisWindow). Deliberately NOT
  // framesAccounted: a forgiven frame was never written, so ffmpeg never numbered it.
  private framesWritten = 0;
  private readonly onDrain = () => {
    // The pipe just came unblocked. Everything that came due while it was blocked is forgiven
    // except the one frame the blocked tick left owed — see writeDueFrames() for why.
    this.framesAccounted = Math.max(this.framesAccounted, this.framesDue() - 1);
    this.writeDueFrames();
  };
  private readonly sink: Writable;

  constructor(private readonly options: PulseVisualizerOptions) {
    this.bandCount = options.bandCount ?? DEFAULT_BAND_COUNT;
    this.engine = new PulseEngine({
      bandCount: this.bandCount,
      sensitivity: options.sensitivity,
      smoothing: options.smoothing,
      beatBoost: options.beatBoost,
      globalPulse: options.globalPulse,
    });
    this.renderFrame = options.renderFrame ?? renderPulseFrameViaPool;
    this.analyzeSpectrum = options.analyzeSpectrum ?? magnitudesFromPcm;
    this.now = options.now ?? (() => Date.now() / 1000);
    this.lastTickSeconds = this.now();

    // Every byte AudioRelay writes into the encoder's audio pipe lands in the ring too, in the
    // same order, so a ring position is a pipe:4 position. Nothing is analyzed here: the sink
    // only records, and each tick picks the window it needs (see loadAnalysisWindow). The previous sink
    // kept just the newest 46ms of whatever chunk arrived last — and chunks arrive as 64KB
    // (372ms) bursts a few times a second, so 97% of ticks re-analyzed a byte-identical window
    // and the picture stepped a few times a second on the pipe's cadence, not the music's.
    this.sink = new Writable({
      write: (chunk: Buffer, _enc, callback) => {
        try {
          this.pcm.write(chunk);
        } catch (err) {
          // An uncaught exception in a stream's `_write` has no listener to catch it and would
          // take the whole process down, unlike a normal thrown/rejected error elsewhere.
          console.error('pulse audio tap failed to record a PCM chunk, spectrum stays stale', err);
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
    this.attachedAtSeconds = this.now();
    this.framesAccounted = 0;
    this.framesWritten = 0;
    pulsePipe.on('drain', this.onDrain);
    this.startTicking();
  }

  close(): void {
    this.stopTicking();
    this.pulsePipe?.removeListener('drain', this.onDrain);
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
      this.writeDueFrames();
      return;
    }
    const nowSeconds = this.now();
    const dtSeconds = nowSeconds - this.lastTickSeconds;
    this.lastTickSeconds = nowSeconds;

    this.loadAnalysisWindow();
    const magnitudes = this.analyzeSpectrum(this.pcmWindow, this.bandCount);
    const values = this.engine.update(magnitudes, dtSeconds);
    // Inset so the whole stroke (glow included) stays inside the element's box — see
    // layoutPulsePoints for why the line no longer runs edge to edge.
    const points = layoutPulsePoints(values, {
      width: this.options.width,
      height: this.options.height,
      glowRadius: this.options.glowRadius,
      coreWidth: this.options.coreWidth,
    });
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
        this.writeDueFrames();
      })
      .catch((err) => {
        console.error('pulse frame render failed, resending the last good frame', err);
      })
      .finally(() => {
        this.rendering = false;
      });
  }

  // Fills pcmWindow with the audio a viewer will HEAR while the frame this tick renders is on
  // screen. That frame becomes pulse frame #framesWritten, and pipe:5 is declared at a fixed
  // `-r fps` with no timestamps, so ffmpeg gives it pts framesWritten/fps; pipe:4 is declared
  // s16le/44.1k/stereo with no timestamps either, so its byte offset is its pts. Both timelines
  // start at zero, and the muxer pairs them by pts — so the audio for this frame sits at a fixed
  // POSITION in the tap's byte stream, and that is where the window is read from.
  //
  // What it must not be read from is the newest audio the tap has: `-re` on pipe:4 makes ffmpeg
  // consume audio at real-time pace, so the tap — which sees bytes when AudioRelay's decoder
  // hands them to Node, long before ffmpeg reads them — runs ahead of playback by everything
  // parked in Node's write buffer, the kernel pipe, ffmpeg's read buffer and its demux/mux
  // queues. Measured against a real encoder (tap position vs. the frame index being written)
  // that lead was 0.7-0.9s at the median — picture ahead of sound, the direction viewers
  // tolerate worst — and it is not a constant to subtract: it swung between 0.3s and 5s inside
  // one session and depends on the host OS's pipe buffering. Reading at the frame's own
  // position instead measured 0-1 frame of lag on the encoder's output, on every transient.
  private loadAnalysisWindow(): void {
    // Centered on the interval frame #framesWritten is on screen for, [k, k+1)/fps.
    const centerByte = ((this.framesWritten + 0.5) / this.options.fps) * PCM_BYTES_PER_SECOND;
    // If that audio hasn't reached the tap yet (only right after start, before the decoder's
    // first output), the newest available is the closest there is.
    let end = Math.min(Math.round(centerByte + PCM_WINDOW_BYTES / 2), this.pcm.writtenBytes);
    // Snapped to a stereo-frame boundary (the stream's position 0 is one) so L/R never swap.
    end -= end % PCM_FRAME_BYTES;
    this.pcm.read(end - PCM_WINDOW_BYTES, this.windowBytes);
  }

  // How many frames pipe:5 should have received by now. The pipe is declared to ffmpeg at a fixed
  // `-r fps` with no timestamps, so ffmpeg synthesizes its timeline purely from this count — and
  // its overlay filter can't emit any output frame until this pipe has a NEWER one. That makes
  // the count, not the tick, the thing that has to track wall-clock time: every frame this class
  // fails to deliver stalls the whole stream (canvas, audio, everything) by one frame interval,
  // permanently, because nothing downstream ever catches up. Measured against a real ffmpeg
  // binary: with a late-firing 30fps timer the encoder ran at 0.7x real time on an idle CPU, and a
  // viewer sees that as the picture's only moving element — this one — periodically freezing.
  // (The +1e-6 keeps e.g. 0.1 * 10 = 0.9999... from rounding a frame that is due down to zero.)
  private framesDue(): number {
    return Math.floor((this.now() - this.attachedAtSeconds) * this.options.fps + 1e-6);
  }

  // Brings the frame count up to date. Unlike CanvasFeeder's writeCachedFrame(), which can simply
  // skip a tick under backpressure because its content is near-static and ffmpeg holding the
  // last canvas frame a little longer changes nothing, a frame this class never writes is not
  // harmless: it's a permanently missing slot in a count-derived timeline (see framesDue()).
  // Which of two things a missed write means depends on the pipe's own state:
  //
  // - Pipe free: ffmpeg is reading as fast as we write, i.e. it's waiting on US, and the whole
  //   stream stalls for every frame we're short. So a tick that fired late writes every frame it
  //   owes now — resends of the latest frame, a one-interval hold no viewer can see — bounded by
  //   MAX_CATCH_UP_FRAMES, which is also what bounds the raw RGBA parked in Node's buffer.
  //
  // - Pipe backed up: ffmpeg is NOT reading this pipe, so it's waiting on something else — the
  //   canvas, whose frames it consumes in one-heartbeat bursts (its fps= stage only releases a
  //   canvas frame's copies once the next canvas frame lands). Frames that come due meanwhile
  //   stall nothing and are forgiven, all but one, which the pipe's 'drain' event then writes so
  //   a momentary stall while ffmpeg IS waiting on us never loses a frame. Forgiving (rather
  //   than deferring and replaying as duplicates) is deliberate and verified against a real
  //   ffmpeg binary: replaying produced a 4-frame hold then a 4-frame jump on every heartbeat,
  //   whereas each forgiven frame nudges this pipe's timeline to just behind the canvas bursts,
  //   where consumption is frame-by-frame and the pipe stops backing up at all.
  private writeDueFrames(): void {
    if (!this.cachedFrame || !this.pulsePipe) return;
    const due = this.framesDue();
    if ((this.pulsePipe as unknown as { writableNeedDrain?: boolean }).writableNeedDrain) {
      this.framesAccounted = Math.max(this.framesAccounted, due - 1);
      return;
    }
    if (due - this.framesAccounted > MAX_CATCH_UP_FRAMES) this.framesAccounted = due - MAX_CATCH_UP_FRAMES;
    while (this.framesAccounted < due) {
      this.pulsePipe.write(this.cachedFrame);
      this.framesAccounted += 1;
      this.framesWritten += 1;
    }
  }
}
