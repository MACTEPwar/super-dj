import * as fs from 'fs/promises';
import * as path from 'path';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

// satori's <img> only accepts a URL it can fetch or an embedded data: URI — there's no file://
// support, so cover art (read from local disk, same as the ffmpeg pipeline does today) has to
// be inlined this way to reach the renderer.
export async function readImageAsDataUri(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? 'image/png';
  const bytes = await fs.readFile(filePath);
  return `data:${mime};base64,${bytes.toString('base64')}`;
}
