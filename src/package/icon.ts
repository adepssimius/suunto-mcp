import { deflateSync } from 'node:zlib';

/**
 * A minimal PNG encoder, used only to synthesise the 300×300 icon every guide
 * zip must contain.
 *
 * Generating it beats committing a binary: the output is deterministic (so guide
 * zips are byte-reproducible), there is no asset to lose track of, and the
 * caller can tint it per sport without an image library. Callers who want real
 * artwork pass their own bytes instead.
 *
 * Icons may be served from a public URL, so nothing here embeds any input.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Suunto requires exactly this size. */
export const ICON_SIZE = 300;

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
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Suunto's brand red, a reasonable default for a generated guide icon. */
export const DEFAULT_ICON_COLOR: Rgb = { r: 0x00, g: 0x2b, b: 0x49 };

/**
 * Encode a solid-colour truecolour PNG of `size` × `size`.
 *
 * Every scanline is prefixed with filter byte 0 (None) — for a flat colour the
 * filters buy nothing, and deflate collapses the result to a few hundred bytes
 * regardless.
 */
export function solidPng(color: Rgb = DEFAULT_ICON_COLOR, size = ICON_SIZE): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // colour type 2: truecolour RGB
  ihdr.writeUInt8(0, 10); // deflate
  ihdr.writeUInt8(0, 11); // adaptive filtering
  ihdr.writeUInt8(0, 12); // no interlace

  const stride = 1 + size * 3;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < size; x += 1) {
      const px = rowStart + 1 + x * 3;
      raw[px] = color.r;
      raw[px + 1] = color.g;
      raw[px + 2] = color.b;
    }
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** True when `buf` starts with the PNG signature. */
export function isPng(buf: Uint8Array): boolean {
  return PNG_SIGNATURE.equals(Buffer.from(buf.subarray(0, 8)));
}

/** Read `width`/`height` out of a PNG's IHDR, so we can reject wrong-sized icons. */
export function pngDimensions(buf: Uint8Array): { width: number; height: number } | undefined {
  if (!isPng(buf) || buf.length < 24) return undefined;
  const b = Buffer.from(buf);
  if (b.subarray(12, 16).toString('ascii') !== 'IHDR') return undefined;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}
