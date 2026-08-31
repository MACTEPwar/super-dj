import { execFileSync } from 'child_process';
import * as fs from 'fs';

export function createFifo(path: string, execFileFn: typeof execFileSync = execFileSync): void {
  execFileFn('mkfifo', [path]);
}

export function removeFifo(path: string, unlinkFn: typeof fs.unlinkSync = fs.unlinkSync): void {
  try {
    unlinkFn(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
