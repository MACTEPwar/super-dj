import { execFileSync } from 'child_process';

export function getAudioDurationSeconds(
  audioPath: string,
  execFileFn: typeof execFileSync = execFileSync,
): number {
  const output = execFileFn('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    audioPath,
  ]);
  return parseFloat(output.toString().trim());
}
