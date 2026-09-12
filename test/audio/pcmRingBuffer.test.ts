import { PcmRingBuffer } from '../../src/audio/pcmRingBuffer';

// Byte at absolute stream position p is (p % 251) + 1 — never zero, so a zero in a read-back can
// only mean "the ring had nothing there".
function streamBytes(start: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = ((start + i) % 251) + 1;
  return out;
}

function readBack(ring: PcmRingBuffer, start: number, length: number): Buffer {
  const out = Buffer.alloc(length, 0xff);
  ring.read(start, out);
  return out;
}

describe('PcmRingBuffer', () => {
  it('reads back exactly what was written, by absolute stream position', () => {
    const ring = new PcmRingBuffer(100);
    ring.write(streamBytes(0, 30));
    ring.write(streamBytes(30, 20));
    expect(ring.writtenBytes).toBe(50);
    expect(readBack(ring, 10, 25)).toEqual(streamBytes(10, 25));
  });

  it('keeps addressing by absolute position across the wrap-around, including a read spanning the seam', () => {
    const ring = new PcmRingBuffer(100);
    for (let p = 0; p < 370; p += 37) ring.write(streamBytes(p, 37)); // 10 chunks, crosses the seam repeatedly
    expect(ring.writtenBytes).toBe(370);
    expect(ring.oldestBytes).toBe(270);
    expect(readBack(ring, 290, 30)).toEqual(streamBytes(290, 30)); // [290,320) straddles ring offsets 90..100..20
    expect(readBack(ring, 270, 100)).toEqual(streamBytes(270, 100)); // the whole ring
  });

  it('reads zeros (silence) for anything it cannot supply: before the stream start, past the head, or overwritten', () => {
    const ring = new PcmRingBuffer(100);
    ring.write(streamBytes(0, 80));
    // Before position 0 -> zeros, then real data.
    const early = readBack(ring, -10, 20);
    expect([...early.subarray(0, 10)]).toEqual(new Array(10).fill(0));
    expect(early.subarray(10)).toEqual(streamBytes(0, 10));
    // Past the head -> real data, then zeros.
    const late = readBack(ring, 70, 20);
    expect(late.subarray(0, 10)).toEqual(streamBytes(70, 10));
    expect([...late.subarray(10)]).toEqual(new Array(10).fill(0));
    // Overwritten (older than head - capacity = 50 once 150 bytes have gone by) -> zeros, then
    // real data.
    ring.write(streamBytes(80, 70));
    const stale = readBack(ring, 40, 20);
    expect([...stale.subarray(0, 10)]).toEqual(new Array(10).fill(0));
    expect(stale.subarray(10)).toEqual(streamBytes(50, 10));
    // Entirely unavailable in either direction.
    expect([...readBack(ring, 0, 30)]).toEqual(new Array(30).fill(0));
    expect([...readBack(ring, 500, 30)]).toEqual(new Array(30).fill(0));
  });

  it('a chunk bigger than the whole ring advances the position by its full length and keeps only its tail', () => {
    const ring = new PcmRingBuffer(50);
    ring.write(streamBytes(0, 130));
    expect(ring.writtenBytes).toBe(130);
    expect(ring.oldestBytes).toBe(80);
    expect(readBack(ring, 80, 50)).toEqual(streamBytes(80, 50));
    expect([...readBack(ring, 30, 50)]).toEqual(new Array(50).fill(0));
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new PcmRingBuffer(0)).toThrow(RangeError);
    expect(() => new PcmRingBuffer(1.5)).toThrow(RangeError);
  });
});
