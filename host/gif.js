// Minimal GIF89a encoder.
//
// Frames arrive already quantized to a shared palette by the extension, which
// keeps the data crossing native messaging to one byte per pixel instead of
// four. All that is left here is LZW compression and the container.

class BitWriter {
  constructor() {
    this.bytes = [];
    this.current = 0;
    this.bitCount = 0;
  }

  write(code, length) {
    this.current |= code << this.bitCount;
    this.bitCount += length;
    while (this.bitCount >= 8) {
      this.bytes.push(this.current & 0xff);
      this.current >>= 8;
      this.bitCount -= 8;
    }
  }

  flush() {
    if (this.bitCount > 0) {
      this.bytes.push(this.current & 0xff);
      this.current = 0;
      this.bitCount = 0;
    }
    return this.bytes;
  }
}

/**
 * LZW as GIF uses it: variable width codes starting one bit above the colour
 * depth, a clear code and an end code above the palette, and a reset whenever
 * the dictionary fills.
 */
function lzwCompress(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let dict = new Map();

  const writer = new BitWriter();
  writer.write(clearCode, codeSize);

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const next = indices[i];
    const key = prefix * 4096 + next;
    const found = dict.get(key);

    if (found !== undefined) {
      prefix = found;
      continue;
    }

    writer.write(prefix, codeSize);
    dict.set(key, nextCode++);

    if (nextCode > (1 << codeSize)) {
      if (codeSize < 12) {
        codeSize++;
      } else {
        writer.write(clearCode, codeSize);
        dict = new Map();
        codeSize = minCodeSize + 1;
        nextCode = endCode + 1;
      }
    }
    prefix = next;
  }

  writer.write(prefix, codeSize);
  writer.write(endCode, codeSize);
  return writer.flush();
}

/** GIF image data is carried in sub-blocks of at most 255 bytes. */
function subBlocks(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

function colorDepth(paletteSize) {
  let bits = 1;
  while (1 << bits < paletteSize) bits++;
  return Math.max(2, Math.min(8, bits));
}

/**
 * @param {{width:number,height:number,palette:number[],frames:{indices:Uint8Array|number[],delayMs:number}[],loop?:boolean}} spec
 * @returns {Buffer}
 */
export function encodeGif({ width, height, palette, frames, loop = true }) {
  if (!frames.length) throw new Error('a gif needs at least one frame');
  if (!palette.length) throw new Error('a gif needs a palette');

  const depth = colorDepth(palette.length / 3);
  const tableSize = 1 << depth;
  const out = [];

  const push = (...bytes) => out.push(...bytes);
  const pushShort = (value) => out.push(value & 0xff, (value >> 8) & 0xff);

  // Header and logical screen descriptor.
  push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
  pushShort(width);
  pushShort(height);
  push(0x80 | (depth - 1), 0, 0);

  // Global colour table, padded to the next power of two.
  for (let i = 0; i < tableSize; i++) {
    push(palette[i * 3] ?? 0, palette[i * 3 + 1] ?? 0, palette[i * 3 + 2] ?? 0);
  }

  if (loop) {
    // Netscape application extension, the only way to say "repeat forever".
    push(0x21, 0xff, 0x0b);
    push(...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)));
    push(0x03, 0x01, 0x00, 0x00, 0x00);
  }

  for (const frame of frames) {
    // Delay is in hundredths of a second, and a value under 2 is clamped by
    // most viewers, so keep at least 2.
    const delay = Math.max(2, Math.round((frame.delayMs || 100) / 10));
    push(0x21, 0xf9, 0x04, 0x04);
    pushShort(delay);
    push(0x00, 0x00);

    push(0x2c);
    pushShort(0);
    pushShort(0);
    pushShort(width);
    pushShort(height);
    push(0x00);

    const minCodeSize = depth;
    push(minCodeSize);
    push(...subBlocks(lzwCompress(frame.indices, minCodeSize)));
  }

  push(0x3b);
  return Buffer.from(out);
}
