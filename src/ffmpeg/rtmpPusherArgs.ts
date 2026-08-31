export function buildRtmpPusherArgs(params: { fifoPath: string; rtmpUrl: string; streamKey: string }): string[] {
  return [
    '-re',
    '-i', params.fifoPath,
    '-c', 'copy',
    '-f', 'flv',
    `${params.rtmpUrl}/${params.streamKey}`,
  ];
}
