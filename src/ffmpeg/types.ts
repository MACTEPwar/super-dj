export interface ChildProcessLike {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): void;
  once(event: 'exit' | 'close' | 'error', listener: (...args: unknown[]) => void): void;
}

export type Spawner = (command: string, args: string[]) => ChildProcessLike;

// The persistent encoder is the one thing in this pipeline that needs more than a single stdout
// pipe: Node feeds it raw video and raw PCM audio continuously for the life of the session via
// two extra anonymous pipe file descriptors (fd 3 and 4) — no named FIFOs, no filesystem entity
// with the multi-writer-over-time semantics that broke the two-FIFO design (see the Stage 2
// design doc's "Why the two-FIFO design was abandoned").
export interface ChildProcessWithPipes extends ChildProcessLike {
  readonly videoPipe: NodeJS.WritableStream;
  readonly audioPipe: NodeJS.WritableStream;
}

export type PipeSpawner = (command: string, args: string[]) => ChildProcessWithPipes;

export interface VideoParams {
  width: number;
  height: number;
  fps: number;
}
