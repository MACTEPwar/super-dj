# Audio-Reactive Equalizer Element (MVP) — Design

## Motivation

The user wants a Winamp-style audio-reactive visualizer as a template
element — a component that visibly reacts to the currently playing
track's actual sound, not a static picture. Explicit scope for this
round: **one visual style, solid color only, "make the design nice,"
more styles/capabilities later.**

## Why this is a different category from every other element type

Every element built so far (`cover`/`title`/`playlist`/`text`/`image`,
Part A; the deferred `timer`-adjacent Part B ideas) either bakes into the
Satori-rendered PNG once per track switch, or — at most — re-renders on a
Node-driven tick (the `timer` element's precedent). An equalizer needs to
react to the actual audio waveform in real time, which neither mechanism
can do: Satori has no concept of audio, and a Node-driven tick fast enough
to look "alive" (30+ times/second) would mean 30+ Satori/resvg renders a
second per active stream — exactly the kind of CPU cost this project
already got burned by once this session (the `-preset ultrafast` fix for
the persistent encoder falling behind real time under host contention).

**The right mechanism, found via a real spike against this project's
actual ffmpeg (not assumed from documentation):** ffmpeg ships native
audio-to-video filters (`showfreqs`, `showspectrum`, `showwaves`) that
generate a reactive video signal directly from an audio stream, with no
per-frame Node or Satori involvement at all — this becomes one more
filter inside the *existing* `PersistentEncoder` process, which is
already continuously running and already paying the audio-decode cost.
This is categorically different from both "Part A" (bakes into a
Satori PNG) and the earlier "Part B" framing (a Node-driven tick loop) —
call it its own thing: a native, continuous ffmpeg filter chain, wired in
once at `PersistentEncoder` construction time, requiring zero additional
runtime work from Node for the life of the session.

## What the spike actually verified (and what it disproved)

Run directly against this machine's real `ffmpeg` (not simulated):

- `showfreqs` (`A->V`, converts audio to a frequency-video output) exists
  and works as expected in `mode=bar`.
- A transparent background is achievable and confirmed to composite
  correctly: `format=yuva420p,colorkey=black:0.1:0.1` after the filter,
  then a normal `overlay`.
- **Disproved: `showfreqs`'s `colors` option is NOT a gradient control.**
  Its real, documented meaning is "set channels colors" — one color per
  *audio channel*, not a spectrum/height gradient. There is no native
  per-bar or across-the-spectrum gradient in this filter.
- **Disproved: there is no native gap/spacing between bars.** `bar` mode
  fills each FFT bin down to zero with no border, so adjacent bins touch —
  visually this reads as a continuous reactive spectrum silhouette (a
  "skyline" shape), not discrete separated Winamp-style columns. Verified
  on both a single test tone (mostly smooth) and a 3-tone mix (visibly
  stepped/reactive, closer to what real music would look like).

**Decisions made from this evidence, not assumption:**
- **MVP renders the continuous-spectrum look, not gapped bars.** This is
  a real, current, appealing style in its own right (comparable to the
  spectrum/waveform visuals in Spotify Canvas, Apple Music, etc.), not a
  downgrade — and it's what the filter actually, verifiably produces.
  Discrete gapped bars would need extra masking/scaling trickery with
  unverified visual quality; not worth it for a "one type, prove it
  first" MVP.
- **MVP color is solid only**, not the `ColorValue` (solid/gradient) type
  used elsewhere. A true gradient would need `showfreqs`'s bars rendered
  as a luma mask, then blended with a separately-rendered gradient layer
  underneath — a real, extra filter-graph construction with its own
  unverified risk. Deferred, matching the "one type now, extend later"
  framing from brainstorming. This mirrors the existing precedent of
  `TimerElement.color: string` (not `ColorValue`) for the same underlying
  reason: the rendering mechanism can't do gradients, so the type
  shouldn't offer to.

## Data model

```typescript
interface EqualizerElement {
  type: 'equalizer';
  x: number;
  y: number;
  width: number;
  height: number;
  color: string; // solid hex only, same HEX_COLOR_PATTERN as every other color field
}
```

Added to the `TemplateElement` union alongside the existing six types.
`isValidTemplateElement` grows one more branch, validating position/size/
color the same way `cover` and `timer` already do.

## Rendering: NOT part of `sceneRenderer.ts`'s element system

`sceneRenderer.ts`'s `elementNode()` must treat `'equalizer'` the same way
it already treats `'timer'` — return `null` (skip it entirely; it is
never part of the baked PNG). The equalizer is instead consumed by a new
code path that builds the `PersistentEncoder`'s `-filter_complex`.

### Persistent encoder wiring

Today, `buildPersistentEncoderArgs` produces a simple pipeline with no
`-filter_complex` at all — raw video in on `pipe:3`, raw audio in on
`pipe:4`, straight to the encoders. This changes **only when the
template actually has an `equalizer` element** (checked once, at
`PersistentEncoder` construction time — the same point every other
per-session-fixed parameter, like width/height/fps, is already decided):

```
# conceptual filter_complex when an equalizer element is present
[1:a]asplit=2[a_out][a_viz];
[a_viz]showfreqs=s=<eqWidth>x<eqHeight>:mode=bar:colors=<eqColor>,format=yuva420p,colorkey=black:0.1:0.1[eq];
[0:v][eq]overlay=<eqX>:<eqY>[vout]
```
`-map "[vout]" -map "[a_out]"` replace today's `-map 0:v -map 1:a` for
this case. Absent an equalizer element, the encoder's args are completely
unchanged from today — no regression risk for existing templates.
(Verified directly: ffmpeg's color parser accepts the project's existing
`#RRGGBB` hex format literally in `showfreqs`'s `colors` option — no
`#RRGGBB` → `0xRRGGBB` conversion step is needed.)

`PersistentEncoder`'s constructor options gain one new optional field:
```typescript
equalizer?: { x: number; y: number; width: number; height: number; color: string };
```
Threaded from `StreamManager`'s existing per-session template resolution
(wherever `timerElement` is already found in the chosen template's
elements today) — the same discovery pattern, just for a different
element type, decided once per stream start and fixed for the session's
lifetime (consistent with the project's existing "templateId is fixed at
`start()`, mid-stream template edits don't affect a running session"
rule).

## Z-order: always topmost, a known limitation

Because the equalizer is composited via `overlay` *after* the whole
Satori-rendered canvas is already flattened into one video frame, it is
not part of the normal element stacking order — it will always render
**above every other element** (cover, title, playlist, text, image),
regardless of where it sits in the template's element array. Acceptable
for an MVP whose whole purpose is "prove the mechanism, one style" — not
silently acceptable forever, called out explicitly here so it isn't
mistaken for a bug later.

## Editor: no live-reactive preview is possible

`POST /templates/{id}/preview` renders a static PNG through Satori/resvg
with sample data — there is no real audio stream involved, and even if
there were, this element type doesn't go through that rendering path at
all (see above). **The template editor cannot show the equalizer actually
reacting to sound.** `TemplateEditor.tsx` shows a static placeholder box
at the element's position/size (e.g. a labeled rectangle: "Equalizer —
visible during live playback"), not a rendered preview. This is a
deliberate, disclosed limitation, not an oversight — the only way to see
it working is a real live stream.

## Pause behavior

No special-casing needed: `AudioRelay.switchToSilence()` already feeds
silence into the same audio pipe on pause — `showfreqs` fed silence
naturally shows a flat/empty spectrum, which is the correct, expected
look for "nothing is playing" without any extra logic.

## Testing approach

`buildPersistentEncoderArgs`'s new conditional filter-graph branch gets
unit tests asserting the exact `-filter_complex` string for both the
with-equalizer and without-equalizer cases (string-shape tests, matching
this file's existing convention). Given this project's own repeated
lesson about ffmpeg filter strings that pass a string-shape test but fail
against the real binary (the drawtext double-colon escaping bug, found
only by real-render verification) — **the implementation plan must
include running the generated filter string through a real local ffmpeg
process** before considering the feature done, the same discipline this
spec's own spike already used.

## Out of scope (deliberately deferred)

- Gradient color (needs a luma-mask + blend filter graph, unverified).
- Discrete gapped bars (needs masking/scaling trickery, unverified visual
  quality, not necessary once "continuous spectrum" was accepted as the
  MVP look).
- Any additional visualizer style (`showspectrum`, `showwaves`,
  `avectorscope`) — explicitly named by the user as "add later."
- Any live-reactive preview in the template editor.
- Per-track override of the equalizer's color (the existing per-track
  `overlayOverride` mechanism from Part A only ever targeted
  `title`/`text` color and canvas background — extending it to the
  equalizer is a separate decision, not assumed here).
