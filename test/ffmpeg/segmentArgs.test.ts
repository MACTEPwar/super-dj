import { buildTrackSegmentArgs, buildPauseSegmentArgs, TimerOverlay } from '../../src/ffmpeg/segmentArgs';

const timer: TimerOverlay = { x: 10, y: 660, fontSize: 20, color: '#ffffff', text: '%{pts\\:hms:0} / 1\\:05' };

describe('buildTrackSegmentArgs', () => {
  const base = {
    audioPath: '/music/a.mp3',
    backgroundPath: '/assets/background.png',
    overlayPngPath: '/tmp/super-dj-overlay-dest-1.png',
    fontFile: '/fonts/DejaVuSans-Bold.ttf',
    width: 1280,
    height: 720,
    fps: 30,
    durationSeconds: 65,
    videoFifoPath: '/tmp/super-dj-stream-dest-1-video.fifo',
    audioFifoPath: '/tmp/super-dj-stream-dest-1-audio.fifo',
  };

  it('builds ffmpeg args compositing the background and the overlay PNG, with no seek or timer by default', () => {
    const args = buildTrackSegmentArgs(base);

    expect(args.slice(0, 8)).toEqual([
      '-loop', '1', '-i', '/assets/background.png',
      '-loop', '1', '-i', '/tmp/super-dj-overlay-dest-1.png',
    ]);
    expect(args).toEqual(expect.arrayContaining(['-i', '/music/a.mp3']));
    expect(args).not.toEqual(expect.arrayContaining(['-ss']));
    expect(args).not.toEqual(expect.arrayContaining(['-output_ts_offset']));
    expect(args).not.toEqual(expect.arrayContaining(['-shortest']));

    const filterComplexIndex = args.indexOf('-filter_complex');
    const filterComplex = args[filterComplexIndex + 1];
    expect(filterComplex).toBe('[0:v]scale=1280:720[bg];[1:v]scale=1280:720[ov];[bg][ov]overlay=0:0[outv]');

    // Assert the two output legs exactly so a missing pin cannot slip through.
    expect(args.slice(filterComplexIndex + 2)).toEqual([
      '-map', '[outv]',
      '-c:v', 'libx264',
      '-tune', 'stillimage',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-g', '60',
      '-t', '65',
      '-f', 'h264', '/tmp/super-dj-stream-dest-1-video.fifo',
      '-map', '2:a',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '44100',
      '-ac', '2',
      '-t', '65',
      '-f', 'adts', '/tmp/super-dj-stream-dest-1-audio.fifo',
    ]);
  });

  it('adds a -ss seek before the audio input when resuming mid-track, and bounds -t by the remaining duration', () => {
    const args = buildTrackSegmentArgs({ ...base, startOffsetSeconds: 42 });
    const audioInputIndex = args.indexOf('/music/a.mp3');

    expect(args[audioInputIndex - 3]).toBe('-ss');
    expect(args[audioInputIndex - 2]).toBe('42');
    // 65s track, resuming 42s in -> 23s of video/audio left to encode in this segment.
    const tIndices = args.reduce<number[]>((acc, v, i) => (v === '-t' ? [...acc, i] : acc), []);
    expect(tIndices).toHaveLength(2);
    for (const i of tIndices) expect(args[i + 1]).toBe('23');
  });

  it('layers a drawtext for the timer on top of the overlay when the template has one', () => {
    const args = buildTrackSegmentArgs({ ...base, timer });

    const filterComplex = args[args.indexOf('-filter_complex') + 1];
    expect(filterComplex).toBe(
      "[0:v]scale=1280:720[bg];[1:v]scale=1280:720[ov];[bg][ov]overlay=0:0[base];"
      + "[base]drawtext=fontfile=/fonts/DejaVuSans-Bold.ttf:text='%{pts\\:hms:0} / 1\\:05':x=10:y=660:fontsize=20:fontcolor=#ffffff[outv]",
    );
  });
});

describe('buildPauseSegmentArgs', () => {
  const base = {
    backgroundPath: '/assets/background.png',
    overlayPngPath: '/tmp/super-dj-overlay-dest-1.png',
    fontFile: '/fonts/DejaVuSans-Bold.ttf',
    width: 1280,
    height: 720,
    fps: 30,
    videoFifoPath: '/tmp/super-dj-stream-dest-1-video.fifo',
    audioFifoPath: '/tmp/super-dj-stream-dest-1-audio.fifo',
  };

  it('builds ffmpeg args compositing the background, the reused overlay PNG, and silence, unbounded (killed externally)', () => {
    const args = buildPauseSegmentArgs(base);

    expect(args).toEqual([
      '-loop', '1', '-i', '/assets/background.png',
      '-loop', '1', '-i', '/tmp/super-dj-overlay-dest-1.png',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-filter_complex', '[0:v]scale=1280:720[bg];[1:v]scale=1280:720[ov];[bg][ov]overlay=0:0[outv]',
      '-map', '[outv]',
      '-c:v', 'libx264',
      '-tune', 'stillimage',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-g', '60',
      '-f', 'h264', '/tmp/super-dj-stream-dest-1-video.fifo',
      '-map', '2:a',
      '-c:a', 'aac',
      '-ar', '44100',
      '-ac', '2',
      '-f', 'adts', '/tmp/super-dj-stream-dest-1-audio.fifo',
    ]);
  });

  it('layers a (frozen) drawtext for the timer on top of the overlay when the template has one', () => {
    const frozenTimer: TimerOverlay = { ...timer, text: '0\\:05 / 1\\:05' };
    const args = buildPauseSegmentArgs({ ...base, timer: frozenTimer });

    const filterComplex = args[args.indexOf('-filter_complex') + 1];
    expect(filterComplex).toContain("drawtext=fontfile=/fonts/DejaVuSans-Bold.ttf:text='0\\:05 / 1\\:05'");
  });
});
