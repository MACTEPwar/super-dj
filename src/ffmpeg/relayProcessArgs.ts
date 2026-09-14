export interface RelayProcessArgsParams {
  // The MediaMTX read URL for the publishing local session, credentials already in the query
  // string: LocalRelaySession.readRtmpUrl, minted in Phase A precisely for this consumer. Never
  // re-derive it — MediaMTX v1.21.0 reads RTMP credentials from query parameters, not userinfo.
  inputUrl: string;
  // The destination's own ingest URL with its stream key already appended, i.e.
  // `${preparedSession.rtmpUrl}/${preparedSession.streamKey}`.
  outputUrl: string;
}

/**
 * One destination forward's ffmpeg argv: pull the already-encoded H.264/AAC out of the local relay
 * and hand it to the destination untouched.
 *
 * The `-c copy` here is load-bearing and is the single rule this file exists to make checkable:
 * per-destination transcoding is explicitly out of scope for this design ("would reintroduce
 * per-destination encodes and destroy the entire CPU-sharing premise") — MediaMTX serves one
 * publisher to N readers, so the local encode's cost does not grow with destination count at all.
 * Never add a codec, scaler, bitrate or filter option here.
 *
 * Deliberately absent: `-reconnect`/`-reconnect_streamed`/`-reconnect_delay_max`. Those apply to
 * HTTP(S) inputs only; an RTMP input ignores them. Input-side recovery is a Node-level respawn
 * owned by DestinationForward.
 */
export function buildRelayProcessArgs(params: RelayProcessArgsParams): string[] {
  return [
    '-hide_banner',
    // `createSpawner()` (src/server.ts) spawns with the default stdio (`['pipe','pipe','pipe']`),
    // so this child never actually shares the parent process's stdin — there is no keystroke-
    // stealing hazard to guard against. `-nostdin` is still worth keeping for its actual effect:
    // without it, ffmpeg spawns a thread polling its own stdin pipe for interactive commands (q to
    // quit, etc.) that nothing here will ever send, which is pointless overhead on a process this
    // app starts and stops entirely by signal. Neither this flag nor `-hide_banner` appears in this
    // repo's other ffmpeg arg builders — this one is the first to add them, not restoring a
    // pre-existing convention.
    '-nostdin',
    '-i', params.inputUrl,
    '-c', 'copy',
    // A relay that joins a session already hours in inherits large non-zero input timestamps.
    // ffmpeg's default (`auto`) already shifts them for a muxer that cannot take negatives, but
    // saying `make_zero` outright means the output timeline starts at 0 for every ingest server,
    // not just the ones that happen to tolerate the default. Verified against real binaries in the
    // smoke-test task rather than assumed.
    '-avoid_negative_ts', 'make_zero',
    '-f', 'flv', params.outputUrl,
  ];
}
