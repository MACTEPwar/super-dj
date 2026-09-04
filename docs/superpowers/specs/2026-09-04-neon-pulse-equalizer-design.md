# Neon Pulse Equalizer — Design

## Motivation

Replace the MVP `showfreqs` bar-spectrum equalizer element (see
`2026-09-04-audio-equalizer-element-design.md`) with the "neon pulse" style
arrived at after live iteration on a series of throwaway browser
prototypes: an angular, glowing line with a flat baseline between beats,
sharp up/down spikes per frequency band, driven by real audio transients.
Unlike the MVP, this round also needs configurable color/glow (user
request) and a genuinely animated editor preview (also user request) —
both explicitly out of scope for the MVP.

## Why the previous mechanism doesn't fit this style

The MVP's whole case for using `showfreqs` was "native ffmpeg filter, zero
extra Node/Satori cost per frame." That's still true, but the filter's
built-in look is fixed: continuous bar/line spectrum, one color per audio
*channel* (not a gradient across the spectrum), no glow, no "flat baseline
+ angular spike" shape. None of that is reachable by tuning `showfreqs`
parameters — confirmed by the MVP spec's own spike. The approved look was
reached by drawing it ourselves (layered translucent strokes + gradient +
a per-band pulse envelope with random up/down sign), which has no ffmpeg
equivalent — it has to be rendered as an image, per frame, and composited
as another video layer, the same way an animated GIF overlay already is.

## Spike: is drawing it ourselves fast enough?

Same discipline as the MVP spec: verify against the real binary before
committing to an architecture, not from documentation or assumption.

Benchmarked the actual candidate renderer — `@resvg/resvg-js`, already a
project dependency, already used by `sceneRenderer.ts` for every other
element — directly against the exact SVG shape the approved style needs:
9 layered strokes + linear gradient + 1 bright core stroke, a 56-point
angular polyline, 400×150 output.

- **First result: 141ms/frame** (7fps ceiling — 425% over a 30fps budget,
  for a single stream, before even considering concurrency). Hopeless.
- Root-caused, not guessed: varying layer count (9 → 1), stroke width,
  join style, and point count (56 → 28) left the time **unchanged** —
  ruling out rasterization work entirely. Isolated to `Resvg`'s
  constructor: **it scans and loads every system font on each
  instantiation by default**, even for an SVG with zero `<text>`.
  Confirmed directly: a trivial one-line SVG cost the same ~133ms with
  default options, and 0.1ms with `font.loadSystemFonts: false`.
- Fix: `new Resvg(svg, { font: { loadSystemFonts: false } })` — valid here
  because this element is pure vector paths. Re-measured the *full*
  9-layer/gradient/400×150 shape: **5.1ms/frame** (197fps ceiling, ~15% of
  a 30fps budget); 3.7ms/frame at a larger 900×300 box.
- **Conclusion: resvg is comfortably fast enough.** No new native
  dependency (`node-canvas`/`skia-canvas`) needed — the existing
  renderer, the existing dependency, just needed one constructor option
  for this call site.
- Still routed through the existing `renderWorkerPool` (piscina), for the
  same reason every other resvg call in this project already avoids the
  main thread: cheap-per-call isn't free at N concurrent streams × 30fps,
  and this keeps one stream's render from stalling another stream's
  audio/video feeding or the HTTP server.
- **Verified (real round-trip, not assumed): resvg's raw pixel buffer is
  premultiplied alpha.** Rendered a 50%-alpha red rectangle
  (`fill="#ff0000" fill-opacity="0.5"`); the raw pixel came back
  `(128, 0, 0, 128)` — half of 255, not 255, which is only possible if
  the color channels were already multiplied by alpha. Fed those bytes
  straight into a real `ffmpeg` as `-pix_fmt rgba` and composited over a
  solid blue background: the result was visibly wrong (`R≈63`, should be
  `R≈128`) — alpha applied a second time on top of the pixel data being
  premultiplied already. Un-premultiplying each pixel first
  (`R = R * 255 / A`, clamped, per channel, skip when `A == 0`) and
  re-running the same round-trip produced the correct `R≈128`. **Decision:
  `PulseVisualizer` unpremultiplies resvg's output before writing it to
  the pipe** — a cheap per-pixel pass, not a filter-graph change.

## Data model

```typescript
interface EqualizerElement {
  type: 'equalizer';
  x: number; y: number; width: number; height: number;
  colors: string[];      // gradient stops across the line's width, left to right, 2-6 stops
  glowLayers: number;    // 3-9
  glowRadius: number;    // 10-70, px — outer glow layer's half-width
  coreWidth: number;     // 1-6, px — the bright core stroke
}
```

Replaces the MVP's single `color: string`. `isValidTemplateElement`'s
`equalizer` branch grows: each `colors[]` entry validated with the
existing `STRICT_HEX_COLOR_PATTERN` (resvg needs exact hex here too, same
reasoning as the MVP's ffmpeg-facing colors), `glowLayers`/`glowRadius`/
`coreWidth` bounds-checked. Default, matching the approved look:
`colors: ['#3b6fff','#b23bff','#ff2f6e','#b23bff','#3bdcff']`,
`glowLayers: 9`, `glowRadius: 42`, `coreWidth: 1`.

**Breaking change, accepted deliberately:** an MVP-era template with a
bare `color` field stops validating. No migration path — this project has
no external users yet, and the one demo-stand template gets manually
re-saved with the new shape once this ships.

## New component: `PulseVisualizer`

Owns the equalizer's video leg — the same conceptual role `CanvasFeeder`
has for the canvas and `AudioRelay` has for decoded track audio — but it
doesn't decode or own anything. It **taps** the PCM bytes `AudioRelay` is
already piping into the shared audio pipe (a second listener on the same
data, not a second reader of the pipe itself — `PersistentEncoder` still
gets the exact same audio it always did, untouched).

### Per-frame pipeline

1. Accumulate PCM bytes into a rolling window (2048 samples @ 44.1kHz ≈
   46ms — enough frequency resolution for 56 bands, short enough to feel
   responsive).
2. Run an FFT (small pure-JS dependency, e.g. `fft.js` — no native build)
   → magnitude per bin, log-mapped down to a fixed 56 bands (bass-heavy
   left, treble right, matching the approved prototypes).
3. **Per-band onset detection** — this is what makes it "pulse" instead
   of "spectrum hill." Each band keeps a decaying floor
   (`floor[i] *= decayRate` every tick, tuned to fall slower than a beat
   but faster than a song section). When `magnitude[i] > floor[i] *
   threshold`, that's a trigger: spawn a synthetic pulse event at that
   band exactly like the approved prototype's `spawnBeat` — sharp attack,
   exponential decay, a small trailing notch in the *opposite* sign
   (random up/down, per the explicit "up and down" requirement), narrow
   spread to 1-2 neighboring bands for the angular "blade" look. Raise
   `floor[i]` to the new peak right after triggering (standard
   onset-detector practice — stops the same loud note from re-triggering
   every tick while it holds).
4. Sum all currently-active bands' envelopes into a 56-point angular
   polyline — straight segments, not smoothed, which is what reads as
   "lightning" rather than "heart monitor" once glow is layered on.
5. Build the SVG (gradient + `glowLayers` translucent strokes +
   `coreWidth` core, using the element's own `colors`/`glowLayers`/
   `glowRadius`/`coreWidth`), rasterize via the worker pool
   (`loadSystemFonts: false`), get raw RGBA pixels.
6. Write the frame into a new dedicated pipe at the encoder's target fps —
   same heartbeat discipline `CanvasFeeder` already follows: resend the
   last frame if a new one isn't ready in time, never block the pipe.

### Wiring into `PersistentEncoder`

- New pipe, `pipe:5` (video is 3, audio is 4). `ChildProcessWithPipes`
  gains a `pulsePipe` alongside `videoPipe`/`audioPipe`.
- New ffmpeg input:
  `-f rawvideo -pix_fmt rgba -s <eqWidth>x<eqHeight> -r <fps> -i pipe:5`
  — valid as straight (non-premultiplied) alpha because `PulseVisualizer`
  unpremultiplies before writing, per the verified decision above.
- Filter graph: `[vcanvas_top][pulse]overlay=<eqX>:<eqY>[vout]` replaces
  the MVP's `asplit`/`showfreqs`/`colorkey` chain entirely. Audio mapping
  goes back to the plain `-map 1:a` — no more `asplit`/`[a_out]` split,
  since ffmpeg itself no longer touches the audio for visualization.
- Present only when the resolved template actually has an `equalizer`
  element, exactly like the MVP: no equalizer element means no new pipe,
  no new input, args byte-for-byte unchanged from today.
- Z-order unchanged from the MVP: always the topmost compositing stage,
  above canvas/gifs/background. Same disclosed limitation as before, not
  revisited in this round.

### Pause behavior

Same reasoning as the MVP, unchanged: `AudioRelay.switchToSilence()`
already feeds silence into the audio pipe on pause, which naturally
decays every band's floor/envelope toward the flat baseline —
"nothing playing" falls out for free, no special-casing in
`PulseVisualizer` itself.

## Editor: live preview (new — the MVP explicitly couldn't do this)

`TemplateEditor.tsx`'s element inspector gets, for `equalizer` elements: a
color-stop editor (add/remove/reorder hex stops) and three sliders
(`glowLayers`, `glowRadius`, `coreWidth`) — same control style already
used for other elements' font/color fields.

The canvas preview itself gets a genuinely **animated** rendering for
this element type, breaking from the MVP's "static placeholder box." It
can't be the real backend pipeline (no live audio in the editor), so it's
a **client-side port of the same drawing recipe** (gradient stroke,
layered glow, angular polyline) driven by a synthetic sample-energy
simulator standing in for a playing track — the same technique validated
in the throwaway browser prototypes during this design's brainstorming.
Net effect: **color/glow/thickness are true WYSIWYG** between editor and
stream (same parameters, same drawing logic ported to TS/canvas) — only
the specific instant-by-instant pulse pattern differs, since editing
happens with no real track playing. This is a disclosed, deliberate
approximation, the same way the MVP disclosed "no preview at all."

`POST /templates/{id}/preview` (the static PNG endpoint) continues to
skip `equalizer` entirely, same as the MVP — it was never going to show
motion anyway.

## Testing approach

- `templateTypes.test.ts`: new/updated cases for the `colors[]`/
  `glowLayers`/`glowRadius`/`coreWidth` validation branch (valid,
  out-of-bounds, malformed hex, wrong array length).
- Onset detector: a pure function of a magnitude-history array → trigger
  events, unit-testable with synthetic FFT-magnitude fixtures (no real
  audio or real FFT needed to test the *decision* logic in isolation).
- SVG builder: string-shape assertions (gradient stops present, expected
  number of `<path>` layers, expected `stroke-width`s derived from
  `glowLayers`/`glowRadius`) — matching this codebase's existing
  convention for filter-string/SVG-shape tests.
- `buildPersistentEncoderArgs`: extended exactly like the MVP's own
  tests — exact-array assertions for the with/without-equalizer-element
  cases, now asserting the new pipe/input/filter shape instead of the
  old `showfreqs` one.
- **Real-binary verification, non-negotiable per this project's own
  repeated lesson:** (a) the `loadSystemFonts: false` fix — verified
  above; (b) the premultiplied-alpha unpremultiply step — verified
  above; (c) still needed before calling this done: a full round-trip
  through real `ffmpeg` with the actual generated args (the same
  "тестовый" template used for this session's prior real-ffmpeg checks).

## Out of scope (deliberately deferred)

- Any visualizer style other than this one ("neon pulse") — no style
  picker.
- Per-track override of equalizer colors (the existing `overlayOverride`
  mechanism only ever targeted title/text/background; extending it here
  is a separate decision).
- Frequency-band count (`56`) as a configurable field — fixed, not
  exposed.
- A truly audio-reactive editor preview (would need piping real audio
  into the browser during editing — a materially different feature).
- The 3D visualizer direction raised earlier in this design's
  brainstorming — explicitly backlogged, not part of this spec.
