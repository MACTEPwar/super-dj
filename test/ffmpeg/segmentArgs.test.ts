import { buildCanvasFrameArgs, TimerOverlay } from '../../src/ffmpeg/segmentArgs';

const timer: TimerOverlay = { x: 10, y: 660, fontSize: 20, color: '#ffffff', text: '0:05 / 1:05',
  style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } };

describe('buildCanvasFrameArgs', () => {
  const base = {
    overlayPngPath: '/tmp/super-dj-overlay-dest-1.png',
    fontFile: '/fonts/DejaVuSans-Bold.ttf',
    width: 1280,
    height: 720,
  };

  // No background compositing here any more — CanvasFeeder used to flatten the overlay PNG onto
  // a background image itself and emit an opaque yuv420p frame, which meant animated gif overlay
  // elements (composited natively by ffmpeg, on top of this whole canvas — see
  // persistentEncoderArgs.ts) could only ever sit UNDER the entire canvas, hiding any title/
  // playlist text that was supposed to render on top of them. This now emits yuva420p (real
  // per-pixel transparency, preserved from the Satori/resvg-rendered overlay PNG) so
  // PersistentEncoder's own filter graph can composite the background/gifs BELOW this canvas and
  // still have title/playlist/cover show through correctly on top of them — see
  // buildPersistentEncoderArgs's own background+gif+canvas layering for the other half of this.
  it('builds a single-frame raw-video render of just the overlay PNG, with real alpha and no timer by default', () => {
    const args = buildCanvasFrameArgs(base);

    expect(args).toEqual([
      '-y',
      '-i', '/tmp/super-dj-overlay-dest-1.png',
      '-filter_complex', '[0:v]scale=1280:720,format=yuva420p[outv]',
      '-map', '[outv]',
      '-frames:v', '1',
      '-f', 'rawvideo',
      '-pix_fmt', 'yuva420p',
      '-',
    ]);
  });

  it('layers a drawtext for the timer on top of the overlay when given one, as a plain (already-formatted) string', () => {
    const args = buildCanvasFrameArgs({ ...base, timer });

    const filterComplex = args[args.indexOf('-filter_complex') + 1];
    expect(filterComplex).toBe(
      "[0:v]scale=1280:720,format=yuva420p[base];"
      + "[base]drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='0\\:05 / 1\\:05':x=10:y=660:fontsize=20:fontcolor=#ffffff[outv]",
    );
    // No pts-expression escaping — there's no continuous per-track encode process for a live
    // %{pts\:hms\:OFFSET} expression to run against any more (see CanvasFeeder/StreamController).
    expect(filterComplex).not.toContain('%{pts');
  });

  it('always overwrites the previous frame at this path without prompting (a real ffmpeg gotcha found via live testing)', () => {
    const args = buildCanvasFrameArgs(base);

    expect(args[0]).toBe('-y');
  });

  it('drawtext includes fontfile resolved from the timer style, not the hardcoded default', () => {
    const args = buildCanvasFrameArgs({
      overlayPngPath: 'overlay.png', fontFile: '/unused-legacy-param.ttf',
      width: 1280, height: 720,
      timer: { x: 10, y: 10, fontSize: 20, color: '#ffffff', text: '1:23 / 4:56',
        style: { fontFamily: 'Liberation Sans', bold: true, italic: false } },
    });
    const filterArg = args[args.indexOf('-filter_complex') + 1];
    expect(filterArg).toContain('fontfile=/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf');
  });

  it('drawtext includes borderw/bordercolor when the timer style has a stroke', () => {
    const args = buildCanvasFrameArgs({
      overlayPngPath: 'overlay.png', fontFile: '/unused-legacy-param.ttf',
      width: 1280, height: 720,
      timer: { x: 10, y: 10, fontSize: 20, color: '#ffffff', text: 'x',
        style: { fontFamily: 'DejaVu Sans', bold: false, italic: false, stroke: { color: '#000000', width: 2 } } },
    });
    const filterArg = args[args.indexOf('-filter_complex') + 1];
    expect(filterArg).toContain('borderw=2');
    expect(filterArg).toContain('bordercolor=#000000');
  });

  it('drawtext includes shadowx/shadowy/shadowcolor when the timer style has a shadow (blur is ignored, drawtext has no equivalent)', () => {
    const args = buildCanvasFrameArgs({
      overlayPngPath: 'overlay.png', fontFile: '/unused-legacy-param.ttf',
      width: 1280, height: 720,
      timer: { x: 10, y: 10, fontSize: 20, color: '#ffffff', text: 'x',
        style: { fontFamily: 'DejaVu Sans', bold: false, italic: false, shadow: { color: '#333333', blur: 10, offsetX: 3, offsetY: 4 } } },
    });
    const filterArg = args[args.indexOf('-filter_complex') + 1];
    expect(filterArg).toContain('shadowx=3');
    expect(filterArg).toContain('shadowy=4');
    expect(filterArg).toContain('shadowcolor=#333333');
  });
});
