export function buildRtmpPusherArgs(params: {
  videoFifoPath: string;
  audioFifoPath: string;
  fps: number;
  rtmpUrl: string;
  streamKey: string;
}): string[] {
  return [
    // Kept as a defensive belt, though with raw elementary-stream inputs there is no longer a
    // container-level continuity counter for a segment switch to desynchronize in the first
    // place — see the Stage 2 design doc for why that's true now and wasn't before.
    '-err_detect', 'ignore_err',
    '-re',
    // Raw H.264 Annex-B has no in-band timing, so -r tells ffmpeg's demuxer what rate to
    // synthesize PTS at (must match the fps every producer segment encodes at).
    '-f', 'h264', '-r', String(params.fps), '-i', params.videoFifoPath,
    '-f', 'aac', '-i', params.audioFifoPath,
    '-c', 'copy',
    '-f', 'flv',
    `${params.rtmpUrl}/${params.streamKey}`,
  ];
}
