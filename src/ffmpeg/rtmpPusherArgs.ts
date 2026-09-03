export function buildRtmpPusherArgs(params: { fifoPath: string; rtmpUrl: string; streamKey: string }): string[] {
  return [
    // Each segment is its own ffmpeg process muxing its own MPEG-TS from scratch, so its
    // per-PID continuity counter always restarts at a track/pause switch — the demuxer here
    // sees that as a "Packet corrupt" continuity-counter mismatch and drops the one packet,
    // which is normally harmless (it's -c copy passthrough, not a decode), but left
    // unacknowledged it can occasionally cascade into the ADTS bitstream filter losing sync
    // and killing the whole RTMP connection. ignore_err keeps the demuxer moving past it
    // instead of ever treating it as fatal.
    '-err_detect', 'ignore_err',
    '-re',
    '-i', params.fifoPath,
    '-c', 'copy',
    '-f', 'flv',
    `${params.rtmpUrl}/${params.streamKey}`,
  ];
}
