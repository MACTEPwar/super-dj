export interface ChildProcessLike {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): void;
  once(event: 'exit' | 'error', listener: (...args: unknown[]) => void): void;
}

export type Spawner = (command: string, args: string[]) => ChildProcessLike;

export interface VideoParams {
  width: number;
  height: number;
  fps: number;
}
