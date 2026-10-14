/**
 * A QR code for pairing a phone with `mind web` (S14.2, D-125).
 *
 * The app pairs by reading the page's link — address and key — from a code
 * on the screen, so nobody types a 64-character key on a phone. The engine
 * has no runtime dependencies, so this is the encoder: byte mode, versions
 * 1–10 (up to 271 bytes at level L, 213 at M — a link is about 110), all four
 * error-correction levels, the mask with the lowest penalty. It follows ISO/IEC
 * 18004 the way Project Nayuki's reference encoder lays it out.
 *
 * The code holds the key. Showing it is the same as showing the link.
 */

export type Ecl = "L" | "M" | "Q" | "H";

/** Format-information bits of each level (ISO/IEC 18004 table 12). */
const ECL_BITS: Readonly<Record<Ecl, number>> = { L: 1, M: 0, Q: 3, H: 2 };

/**
 * Blocks per version and level: [error-correction codewords per block,
 * blocks in group 1, data codewords each, blocks in group 2, data codewords each].
 */
type Blocks = readonly [number, number, number, number, number];
const BLOCKS: readonly (Readonly<Record<Ecl, Blocks>>)[] = [
  { L: [7, 1, 19, 0, 0], M: [10, 1, 16, 0, 0], Q: [13, 1, 13, 0, 0], H: [17, 1, 9, 0, 0] },
  { L: [10, 1, 34, 0, 0], M: [16, 1, 28, 0, 0], Q: [22, 1, 22, 0, 0], H: [28, 1, 16, 0, 0] },
  { L: [15, 1, 55, 0, 0], M: [26, 1, 44, 0, 0], Q: [18, 2, 17, 0, 0], H: [22, 2, 13, 0, 0] },
  { L: [20, 1, 80, 0, 0], M: [18, 2, 32, 0, 0], Q: [26, 2, 24, 0, 0], H: [16, 4, 9, 0, 0] },
  { L: [26, 1, 108, 0, 0], M: [24, 2, 43, 0, 0], Q: [18, 2, 15, 2, 16], H: [22, 2, 11, 2, 12] },
  { L: [18, 2, 68, 0, 0], M: [16, 4, 27, 0, 0], Q: [24, 4, 19, 0, 0], H: [28, 4, 15, 0, 0] },
  { L: [20, 2, 78, 0, 0], M: [18, 4, 31, 0, 0], Q: [18, 2, 14, 4, 15], H: [26, 4, 13, 1, 14] },
  { L: [24, 2, 97, 0, 0], M: [22, 2, 38, 2, 39], Q: [22, 4, 18, 2, 19], H: [26, 4, 14, 2, 15] },
  { L: [30, 2, 116, 0, 0], M: [22, 3, 36, 2, 37], Q: [20, 4, 16, 4, 17], H: [24, 4, 12, 4, 13] },
  { L: [18, 2, 68, 2, 69], M: [26, 4, 43, 1, 44], Q: [24, 6, 19, 2, 20], H: [28, 6, 15, 2, 16] },
];

/** Centres of the alignment patterns, per version. */
const ALIGN: readonly (readonly number[])[] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

export const QR_MAX_VERSION = BLOCKS.length;

function dataCodewords(version: number, ecl: Ecl): number {
  const [, g1, d1, g2, d2] = BLOCKS[version - 1]![ecl];
  return g1 * d1 + g2 * d2;
}

/** Multiplication in GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1. */
export function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < degree) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** The Reed–Solomon error-correction codewords for one block. */
export function rsRemainder(data: readonly number[], degree: number): number[] {
  const divisor = rsDivisor(degree);
  const result = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => { result[i]! ^= gfMultiply(coef, factor); });
  }
  return result;
}

/** 15 format bits: level and mask, BCH(15,5), then XOR 0x5412. */
export function formatBits(ecl: Ecl, mask: number): number {
  const data = (ECL_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18 version bits for versions 7 and up: BCH(18,6). */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

const bit = (value: number, i: number): boolean => ((value >>> i) & 1) !== 0;

/** The codewords, error correction included and interleaved, for `bytes` at `version`. */
function codewords(bytes: Uint8Array, version: number, ecl: Ecl): number[] {
  const capacityBits = dataCodewords(version, ecl) * 8;
  const bits: number[] = [];
  const put = (value: number, length: number): void => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacityBits - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));
  for (let pad = 0xec; data.length < capacityBits / 8; pad ^= 0xec ^ 0x11) data.push(pad);

  const [ecLength, g1, d1, g2, d2] = BLOCKS[version - 1]![ecl];
  const blocks: number[][] = [];
  let at = 0;
  for (const [count, length] of [[g1, d1], [g2, d2]] as const) {
    for (let i = 0; i < count; i++) { blocks.push(data.slice(at, at + length)); at += length; }
  }
  const out: number[] = [];
  for (let i = 0; i < Math.max(d1, d2); i++) for (const block of blocks) if (i < block.length) out.push(block[i]!);
  const ecc = blocks.map((block) => rsRemainder(block, ecLength));
  for (let i = 0; i < ecLength; i++) for (const e of ecc) out.push(e[i]!);
  return out;
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** ISO/IEC 18004 §7.8.3: lower is easier for a reader. */
export function penalty(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let y = 0; y < size; y++) lines.push([...modules[y]!]);
  for (let x = 0; x < size; x++) lines.push(modules.map((row) => row[x]!));
  const finderLike = [true, false, true, true, true, false, true];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) { run++; continue; }
      if (run >= 5) score += 3 + (run - 5);
      run = 1;
    }
    for (let i = 0; i + 7 <= size; i++) {
      if (!finderLike.every((v, k) => line[i + k] === v)) continue;
      const lightBefore = [1, 2, 3, 4].every((k) => i - k < 0 || !line[i - k]);
      const lightAfter = [0, 1, 2, 3].every((k) => i + 7 + k >= size || !line[i + 7 + k]);
      if (lightBefore || lightAfter) score += 40;
    }
  }
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = modules[y]![x];
      if (modules[y]![x + 1] === c && modules[y + 1]![x] === c && modules[y + 1]![x + 1] === c) score += 3;
    }
  }
  const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const total = size * size;
  score += Math.max(0, Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/**
 * The modules of a QR code for `text` (UTF-8), row by row, `true` = dark.
 * The smallest version that holds it at `ecl`; `null` when it is longer than
 * version 10 holds.
 */
export function encodeQr(text: string, ecl: Ecl = "M"): boolean[][] | null {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (version <= QR_MAX_VERSION && 4 + (version < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(version, ecl) * 8) version++;
  if (version > QR_MAX_VERSION) return null;

  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean): void => { modules[y]![x] = dark; fixed[y]![x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, distance !== 2 && distance !== 4);
      }
    }
  }
  const align = ALIGN[version - 1]!;
  const last = align.length - 1;
  align.forEach((ax, i) => align.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const drawFormat = (mask: number): void => {
    const bits = formatBits(ecl, mask);
    for (let i = 0; i <= 5; i++) set(8, i, bit(bits, i));
    set(8, 7, bit(bits, 6));
    set(8, 8, bit(bits, 7));
    set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(bits, i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, bit(bits, i));
      set(b, a, bit(bits, i));
    }
  }

  const words = codewords(bytes, version, ecl);
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (fixed[y]![x] || i >= words.length * 8) continue;
        modules[y]![x] = bit(words[i >>> 3]!, 7 - (i & 7));
        i++;
      }
    }
  }

  const masked = (mask: number): boolean[][] => modules.map((row, y) => row.map((dark, x) => (fixed[y]![x] ? dark : dark !== MASKS[mask]!(x, y))));
  let best = 0, bestScore = Infinity;
  for (let mask = 0; mask < MASKS.length; mask++) {
    drawFormat(mask);
    const score = penalty(masked(mask));
    if (score < bestScore) { best = mask; bestScore = score; }
  }
  drawFormat(best);
  return masked(best);
}

/**
 * The code as one SVG path over a four-module quiet zone: the page draws it
 * with `createElementNS` and `setAttribute`, since nothing on it assigns
 * `innerHTML` (the path is digits and M/h/v/z only).
 */
export function qrPath(modules: readonly (readonly boolean[])[]): { readonly size: number; readonly d: string } {
  const path: string[] = [];
  modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) path.push(`M${x + 4} ${y + 4}h1v1h-1z`); }));
  return { size: modules.length + 8, d: path.join("") };
}

/**
 * The code for a terminal: two rows per line with half blocks, black on a
 * white background set by ANSI colour, so it reads the same on a dark or a
 * light terminal.
 */
export function qrTerminal(modules: readonly (readonly boolean[])[]): string {
  const quiet = 4;
  const size = modules.length + quiet * 2;
  const dark = (x: number, y: number): boolean => modules[y - quiet]?.[x - quiet] === true;
  const lines: string[] = [];
  for (let y = 0; y < size; y += 2) {
    let line = "\x1b[30;47m";
    for (let x = 0; x < size; x++) {
      const top = dark(x, y), bottom = y + 1 < size && dark(x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join("\n");
}
