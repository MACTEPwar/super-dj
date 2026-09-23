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
  // Fed only when the resolved template has an 'equalizer' element — see PulseVisualizer and
  // buildPersistentEncoderArgs's pipe:5 input. Always present on the type/child (the stdio slot
  // always exists once spawned — see createPipeSpawner), simply never written to when there's no
  // equalizer element for a given session.
  readonly pulsePipe: NodeJS.WritableStream;
  // The second canvas layer, fed only when the resolved template's baked elements straddle its
  // first animated-gif element — see CanvasPlacement in persistentEncoderArgs.ts and
  // CanvasFeeder's aboveOverlayImagePath. Same "always present on the child, only sometimes
  // written to" arrangement as pulsePipe above: createPipeSpawner opens the stdio slot
  // unconditionally, and buildPersistentEncoderArgs only declares `-i pipe:6` when it's needed.
  readonly aboveCanvasPipe: NodeJS.WritableStream;
  // The playlist window's burst layer (fd 7) — see PlaylistWindowFeeder. Same "always present,
  // sometimes written" arrangement as pulsePipe.
  readonly playlistWindowPipe: NodeJS.WritableStream;
}

export type PipeSpawner = (command: string, args: string[]) => ChildProcessWithPipes;
