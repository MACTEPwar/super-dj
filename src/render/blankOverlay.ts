import * as zlib from 'zlib';

// Hand-built via Node's own zlib rather than through Satori/resvg — this is specifically the
// fallback used when the render pipeline itself is unavailable (crashed worker pool, missing
// native binding in the image), so it must not depend on that same pipeline to exist. ffmpeg's
// own `scale` filter stretches this to the video canvas size at composite time, so there's no
// need to encode it at full resolution — a single transparent pixel is enough.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function buildTransparentPixelPng(): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0); // width
  ihdrData.writeUInt32BE(1, 4); // height
  ihdrData.writeUInt8(8, 8); // bit depth
  ihdrData.writeUInt8(6, 9); // color type: RGBA
  ihdrData.writeUInt8(0, 10); // compression method
  ihdrData.writeUInt8(0, 11); // filter method
  ihdrData.writeUInt8(0, 12); // interlace method
  const ihdr = pngChunk('IHDR', ihdrData);

  // One scanline: a filter-type byte (0 = none) followed by 4 RGBA bytes, all zero
  // (fully transparent).
  const raw = Buffer.alloc(5, 0);
  const idat = pngChunk('IDAT', zlib.deflateSync(raw));

  const iend = pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

export const BLANK_OVERLAY_PNG: Buffer = buildTransparentPixelPng();
