import { buildCanvasFrameArgs, TimerOverlay } from '../../src/ffmpeg/segmentArgs';

const timer: TimerOverlay = { x: 10, y: 660, fontSize: 20, color: '#ffffff', text: '0:05 / 1:05' };

describe('buildCanvasFrameArgs', () => {
  const base = {
    backgroundPath: '/assets/background.png',
    overlayPngPath: '/tmp/super-dj-overlay-dest-1.png',
    fontFile: '/fonts/DejaVuSans-Bold.ttf',
    width: 1280,
    height: 720,
  };

  it('builds a single-frame raw-video render compositing the background and overlay PNG, with no timer by default', () => {
    const args = buildCanvasFrameArgs(base);

    expect(args).toEqual([
      '-y',
      '-i', '/assets/background.png',
      '-i', '/tmp/super-dj-overlay-dest-1.png',
      '-filter_complex', '[0:v]scale=1280:720[bg];[1:v]scale=1280:720[ov];[bg][ov]overlay=0:0[outv]',
      '-map', '[outv]',
      '-frames:v', '1',
      '-f', 'rawvideo',
      '-pix_fmt', 'yuv420p',
      '-',
    ]);
  });

  it('layers a drawtext for the timer on top of the overlay when given one, as a plain (already-formatted) string', () => {
    const args = buildCanvasFrameArgs({ ...base, timer });

    const filterComplex = args[args.indexOf('-filter_complex') + 1];
    expect(filterComplex).toBe(
      "[0:v]scale=1280:720[bg];[1:v]scale=1280:720[ov];[bg][ov]overlay=0:0[base];"
      + "[base]drawtext=fontfile=/fonts/DejaVuSans-Bold.ttf:text='0:05 / 1:05':x=10:y=660:fontsize=20:fontcolor=#ffffff[outv]",
    );
    // No pts-expression escaping — there's no continuous per-track encode process for a live
    // %{pts\:hms\:OFFSET} expression to run against any more (see CanvasFeeder/StreamController).
    expect(filterComplex).not.toContain('%{pts');
  });

  it('always overwrites the previous frame at this path without prompting (a real ffmpeg gotcha found via live testing)', () => {
    const args = buildCanvasFrameArgs(base);

    expect(args[0]).toBe('-y');
  });
});
