// Raw PCM (s16le, 44.1kHz stereo) is the common format both a decoded track and generated
// silence are handed to the persistent encoder's audio pipe in — plain samples, no container, so
// there is nothing here that could ever develop a continuity-counter or bitstream-filter
// discontinuity at a track switch the way the old per-segment MPEG-TS encode did.
export function buildDecodeTrackArgs(params: { audioPath: string; startOffsetSeconds?: number }): string[] {
  const args: string[] = [];
  if (params.startOffsetSeconds) {
    args.push('-ss', String(params.startOffsetSeconds));
  }
  args.push('-i', params.audioPath, '-f', 's16le', '-ar', '44100', '-ac', '2', '-');
  return args;
}

export function buildSilenceArgs(): string[] {
  return ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-f', 's16le', '-ar', '44100', '-ac', '2', '-'];
}
