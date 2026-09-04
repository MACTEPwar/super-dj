import { ExecFileAsync } from './duration';
import { execFile } from 'child_process';
import { promisify } from 'util';

const defaultExecFile = promisify(execFile);

// -count_frames forces a real decode instead of trusting container metadata — verified against a
// real ffmpeg binary: a GIF's own `nb_frames` metadata field is populated for a simple encode
// (ffmpeg's own gif muxer sets it), but that's not something every GIF producer guarantees, and a
// full decode-based count is correct regardless of how the file was authored. Cheap here because
// template image assets are small and this only runs once per stream start, not per frame.
export async function getImageFrameCount(
  imagePath: string,
  execFileFn: ExecFileAsync = defaultExecFile,
): Promise<number> {
  const { stdout } = await execFileFn('ffprobe', [
    '-v', 'error',
    '-count_frames',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames',
    '-of', 'csv=p=0',
    imagePath,
  ]);
  const frames = parseInt(stdout.toString().trim(), 10);
  return Number.isFinite(frames) && frames > 0 ? frames : 1;
}
