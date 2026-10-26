/**
 * Deflate64 («enhanced deflate», zip method 9; PKWARE APPNOTE 4.4.5): deflate
 * (RFC 1951) with a 64 KB window, length code 285 carrying 16 extra bits from
 * a base of 3, and distance codes 30 and 31. The IRS packs its largest monthly
 * archives of Form 990 returns with it, and Node's zlib does not read it. A
 * straightforward decoder after zlib's puff.c; `size` is the uncompressed size
 * from the archive directory, so output never grows past it. The caller checks
 * the CRC of the result.
 */
const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 3];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 16];
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577, 32769, 49153];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const MAX_BITS = 15;

interface Huffman { counts: Uint16Array; symbols: Uint16Array }
function fail(): never { throw new Error('registry_invalid_response'); }
/** Canonical Huffman code from code lengths (puff.c construct); an over-subscribed code is refused. */
function huffman(lengths: ArrayLike<number>, count: number): Huffman {
  const counts = new Uint16Array(MAX_BITS + 1);
  for (let symbol = 0; symbol < count; symbol += 1) counts[lengths[symbol]] += 1;
  let left = 1;
  for (let length = 1; length <= MAX_BITS; length += 1) {
    left = left * 2 - counts[length];
    if (left < 0) fail();
  }
  const offsets = new Uint16Array(MAX_BITS + 2);
  for (let length = 1; length <= MAX_BITS; length += 1) offsets[length + 1] = offsets[length] + counts[length];
  const symbols = new Uint16Array(count);
  for (let symbol = 0; symbol < count; symbol += 1) if (lengths[symbol]) symbols[offsets[lengths[symbol]]++] = symbol;
  counts[0] = 0;
  return { counts, symbols };
}
let fixed: { lengths: Huffman; distances: Huffman } | null = null;
function fixedCodes(): { lengths: Huffman; distances: Huffman } {
  if (fixed) return fixed;
  const lengths = new Uint8Array(288);
  lengths.fill(8, 0, 144); lengths.fill(9, 144, 256); lengths.fill(7, 256, 280); lengths.fill(8, 280, 288);
  fixed = { lengths: huffman(lengths, 288), distances: huffman(new Uint8Array(32).fill(5), 32) };
  return fixed;
}

export function inflateHeEngDeflate64(input: Uint8Array, size: number): Buffer {
  const out = Buffer.alloc(size);
  let written = 0;
  let position = 0;
  let buffer = 0;
  let bitCount = 0;
  const bits = (need: number): number => {
    while (bitCount < need) {
      if (position >= input.length) fail();
      buffer |= input[position++] << bitCount;
      bitCount += 8;
    }
    const value = buffer & ((1 << need) - 1);
    buffer >>>= need; bitCount -= need;
    return value;
  };
  const decode = (code: Huffman): number => {
    let value = 0; let first = 0; let index = 0;
    for (let length = 1; length <= MAX_BITS; length += 1) {
      value |= bits(1);
      const count = code.counts[length];
      if (value - count < first) return code.symbols[index + value - first];
      index += count; first += count; first <<= 1; value <<= 1;
    }
    return fail();
  };
  let last = 0;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      // Stored block: byte-aligned length, its complement, then the bytes.
      buffer = 0; bitCount = 0;
      if (position + 4 > input.length) fail();
      const length = input[position] | (input[position + 1] << 8);
      if ((length ^ 0xffff) !== (input[position + 2] | (input[position + 3] << 8))) fail();
      position += 4;
      if (position + length > input.length || written + length > size) fail();
      out.set(input.subarray(position, position + length), written);
      position += length; written += length;
      continue;
    }
    let lengthCode: Huffman; let distanceCode: Huffman;
    if (type === 1) ({ lengths: lengthCode, distances: distanceCode } = fixedCodes());
    else if (type === 2) {
      const literals = bits(5) + 257; const distances = bits(5) + 1; const codeLengths = bits(4) + 4;
      if (literals > 286) fail();
      const order = new Uint8Array(19);
      for (let i = 0; i < codeLengths; i += 1) order[CODE_LENGTH_ORDER[i]] = bits(3);
      const lengthsCode = huffman(order, 19);
      const lengths = new Uint8Array(literals + distances);
      for (let i = 0; i < literals + distances;) {
        const symbol = decode(lengthsCode);
        if (symbol < 16) { lengths[i++] = symbol; continue; }
        let repeat: number; let value = 0;
        if (symbol === 16) { if (i === 0) fail(); value = lengths[i - 1]; repeat = 3 + bits(2); }
        else if (symbol === 17) repeat = 3 + bits(3);
        else repeat = 11 + bits(7);
        if (i + repeat > literals + distances) fail();
        lengths.fill(value, i, i + repeat); i += repeat;
      }
      if (lengths[256] === 0) fail();
      lengthCode = huffman(lengths.subarray(0, literals), literals);
      distanceCode = huffman(lengths.subarray(literals), distances);
    } else return fail();
    for (;;) {
      const symbol = decode(lengthCode);
      if (symbol < 256) {
        if (written >= size) fail();
        out[written++] = symbol;
        continue;
      }
      if (symbol === 256) break;
      const index = symbol - 257;
      if (index >= LENGTH_BASE.length) fail();
      const length = LENGTH_BASE[index] + bits(LENGTH_EXTRA[index]);
      const distanceSymbol = decode(distanceCode);
      if (distanceSymbol >= DISTANCE_BASE.length) fail();
      const distance = DISTANCE_BASE[distanceSymbol] + bits(DISTANCE_EXTRA[distanceSymbol]);
      if (distance > written || written + length > size) fail();
      // Byte by byte: a copy may overlap the bytes it is writing.
      for (let i = 0; i < length; i += 1, written += 1) out[written] = out[written - distance];
    }
  } while (!last);
  if (written !== size) fail();
  return out;
}
