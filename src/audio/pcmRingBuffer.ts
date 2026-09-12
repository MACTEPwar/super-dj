// A fixed-capacity ring over a continuous byte stream, addressed by ABSOLUTE stream position
// (total bytes ever written), not by "how far behind the newest byte". PulseVisualizer uses one
// to hold the last several seconds of the PCM AudioRelay writes into the encoder's audio pipe,
// so a frame can be analyzed against the exact audio that will be muxed alongside it — which is
// a fixed position in that stream, not a fixed distance behind whatever arrived most recently
// (see PulseVisualizer.tickUnsafe for why that distance is anything but fixed).
export class PcmRingBuffer {
  private readonly buffer: Buffer;
  // Total bytes ever written: the absolute stream position just past the newest byte.
  private head = 0;

  constructor(readonly capacityBytes: number) {
    if (!Number.isInteger(capacityBytes) || capacityBytes <= 0) throw new RangeError('capacityBytes must be a positive integer');
    this.buffer = Buffer.alloc(capacityBytes);
  }

  /** Absolute stream position just past the newest byte (total bytes ever written). */
  get writtenBytes(): number {
    return this.head;
  }

  /** Oldest absolute position still readable — everything before it has been overwritten. */
  get oldestBytes(): number {
    return Math.max(0, this.head - this.capacityBytes);
  }

  write(chunk: Buffer): void {
    let source = chunk;
    if (source.length > this.capacityBytes) {
      // Only the tail of a chunk bigger than the whole ring can ever be read back; the rest is
      // accounted for in the position (it did go by) but never stored.
      this.head += source.length - this.capacityBytes;
      source = source.subarray(source.length - this.capacityBytes);
    }
    const at = this.head % this.capacityBytes;
    const firstPart = Math.min(source.length, this.capacityBytes - at);
    source.copy(this.buffer, at, 0, firstPart);
    if (firstPart < source.length) source.copy(this.buffer, 0, firstPart);
    this.head += source.length;
  }

  /**
   * Fills `out` with the stream bytes [start, start + out.length). Any part the ring can't
   * supply — before position 0, past the head, or already overwritten — reads as zeros (which,
   * for PCM, is silence).
   */
  read(start: number, out: Buffer): void {
    out.fill(0);
    const from = Math.max(start, this.oldestBytes);
    const to = Math.min(start + out.length, this.head);
    let position = from;
    while (position < to) {
      const at = position % this.capacityBytes;
      const length = Math.min(to - position, this.capacityBytes - at);
      this.buffer.copy(out, position - start, at, at + length);
      position += length;
    }
  }
}
