import { execFile } from 'child_process';
import { promisify } from 'util';

const defaultExecFile = promisify(execFile);

export type ExecFileAsync = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export async function getAudioDurationSeconds(
  audioPath: string,
  execFileFn: ExecFileAsync = defaultExecFile,
): Promise<number> {
  const { stdout } = await execFileFn('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    audioPath,
  ]);
  return parseFloat(stdout.toString().trim());
}
