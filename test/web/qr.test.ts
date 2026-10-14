// S14.2: the pairing code. The goldens below were decoded back to their text by an
// independent reader (OpenCV 4.13 QRCodeDetector) on 2026-09-27 before being pinned.

import { describe, expect, test } from "bun:test";
import { encodeQr, formatBits, gfMultiply, penalty, QR_MAX_VERSION, qrPath, qrTerminal, rsRemainder, versionBits, type Ecl } from "../../src/web/qr.ts";

const LINK = "https://box.tail0000.ts.net:30701/#t=" + "0123456789abcdef".repeat(4);

function fingerprint(modules: readonly (readonly boolean[])[]): string {
  const rows = modules.map((r) => r.map((b) => (b ? "1" : "0")).join("")).join("\n");
  return new Bun.CryptoHasher("sha256").update(rows).digest("hex").slice(0, 16);
}

describe("the arithmetic under it", () => {
  test("GF(256) multiplication", () => {
    expect(gfMultiply(0, 0x53)).toBe(0);
    expect(gfMultiply(1, 0x53)).toBe(0x53);
    expect(gfMultiply(2, 0x80)).toBe(0x1d); // x^8 folds back through 0x11d
    expect(gfMultiply(0x53, 0xca)).toBe(gfMultiply(0xca, 0x53));
  });

  test("Reed–Solomon: the worked 1-M example of ISO/IEC 18004 (HELLO WORLD)", () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rsRemainder(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  test("format and version bits match the standard's tables", () => {
    const table: Record<Ecl, readonly string[]> = {
      L: ["111011111000100", "111001011110011", "111110110101010", "111100010011101", "110011000101111", "110001100011000", "110110001000001", "110100101110110"],
      M: ["101010000010010", "101000100100101", "101111001111100", "101101101001011", "100010111111001", "100000011001110", "100111110010111", "100101010100000"],
      Q: ["011010101011111", "011000001101000", "011111100110001", "011101000000110", "010010010110100", "010000110000011", "010111011011010", "010101111101101"],
      H: ["001011010001001", "001001110111110", "001110011100111", "001100111010000", "000011101100010", "000001001010101", "000110100001100", "000100000111011"],
    };
    for (const ecl of ["L", "M", "Q", "H"] as const) {
      table[ecl].forEach((bits, mask) => expect(formatBits(ecl, mask).toString(2).padStart(15, "0")).toBe(bits));
    }
    expect(versionBits(7)).toBe(0x07c94);
    expect(versionBits(8)).toBe(0x085bc);
    expect(versionBits(9)).toBe(0x09a99);
    expect(versionBits(10)).toBe(0x0a4d3);
  });
});

describe("encodeQr", () => {
  test("pinned codes that a separate reader decoded back to their text", () => {
    const cases: [string, Ecl, number, string][] = [
      ["HELLO WORLD", "Q", 21, "7dde2e7cd1825ca0"],
      ["hi", "M", 21, "81240590f3a630b0"],
      [LINK, "M", 41, "7bf5701eace06b9e"],
      [LINK, "L", 37, "071d3189fac71ffa"],
      ["y".repeat(150), "Q", 57, "46b9d45b226f5c37"], // version 10: version bits and a 16-bit length
    ];
    for (const [text, ecl, size, hash] of cases) {
      const modules = encodeQr(text, ecl)!;
      expect(modules.length).toBe(size);
      expect(fingerprint(modules)).toBe(hash);
    }
  });

  test("the fixed parts are where a reader looks for them", () => {
    const m = encodeQr(LINK)!;
    const n = m.length;
    for (const [x0, y0] of [[0, 0], [n - 7, 0], [0, n - 7]] as const) {
      for (let i = 0; i < 7; i++) {
        expect(m[y0]![x0 + i]).toBe(true); // finder: dark outer ring
        expect(m[y0 + 6]![x0 + i]).toBe(true);
      }
      expect(m[y0 + 1]![x0 + 1]).toBe(false); // light ring
      expect(m[y0 + 3]![x0 + 3]).toBe(true); // dark centre
    }
    for (let i = 8; i < n - 8; i++) {
      expect(m[6]![i]).toBe(i % 2 === 0); // timing row
      expect(m[i]![6]).toBe(i % 2 === 0); // timing column
    }
    expect(m[n - 8]![8]).toBe(true); // the dark module
  });

  test("the smallest version that holds it; longer than version 10 holds is null", () => {
    expect(encodeQr("")!.length).toBe(21);
    expect(encodeQr("x".repeat(14), "M")!.length).toBe(21); // 1-M holds 14 bytes
    expect(encodeQr("x".repeat(15), "M")!.length).toBe(25);
    expect(encodeQr("x".repeat(213), "M")!.length).toBe(17 + 4 * QR_MAX_VERSION);
    expect(encodeQr("x".repeat(214), "M")).toBeNull();
    expect(encodeQr("x".repeat(120), "H")).toBeNull();
  });

  test("text is UTF-8", () => {
    expect(encodeQr("ไทย")!.length).toBe(21);
    expect(encodeQr("ก".repeat(5), "M")!.length).toBe(25); // 15 bytes, not 5
  });
});

describe("penalty", () => {
  test("a flat field costs more than a checkerboard", () => {
    const flat = Array.from({ length: 21 }, () => new Array<boolean>(21).fill(true));
    const checker = Array.from({ length: 21 }, (_, y) => Array.from({ length: 21 }, (_, x) => (x + y) % 2 === 0));
    expect(penalty(flat)).toBeGreaterThan(penalty(checker));
    expect(penalty(checker)).toBe(0);
  });

  test("a finder-like run with light on one side is charged", () => {
    const row = [false, false, false, false, true, false, true, true, true, false, true];
    const withIt = Array.from({ length: 11 }, (_, y) => (y === 0 ? row : Array.from({ length: 11 }, (_, x) => (x + y) % 2 === 0)));
    const without = withIt.map((r, y) => (y === 0 ? Array.from({ length: 11 }, (_, x) => x % 2 === 0) : r));
    expect(penalty(withIt) - penalty(without)).toBeGreaterThanOrEqual(40);
  });
});

describe("drawing it", () => {
  test("SVG path: one square per dark module, inside a four-module quiet zone, nothing but path letters", () => {
    const m = encodeQr("hi")!;
    const { size, d } = qrPath(m);
    expect(size).toBe(29);
    expect(d.match(/h1v1h-1z/g)!.length).toBe(m.flat().filter(Boolean).length);
    expect(d).toMatch(/^[Mhvz0-9 -]+$/);
    expect(d).toStartWith("M4 4h1v1h-1z"); // the top-left finder's corner, after the quiet zone
  });

  test("terminal: two rows per line, colours set and reset on every line", () => {
    const m = encodeQr("hi")!;
    const lines = qrTerminal(m).split("\n");
    expect(lines.length).toBe(Math.ceil((21 + 8) / 2));
    for (const line of lines) {
      expect(line).toStartWith("\x1b[30;47m");
      expect(line).toEndWith("\x1b[0m");
      expect([...line.replace(/\x1b\[[0-9;]*m/g, "")].length).toBe(29);
    }
    expect(lines[0]!.replace(/\x1b\[[0-9;]*m/g, "")).toBe(" ".repeat(29)); // quiet zone
    expect(lines.join("")).toContain("█");
    expect(lines.join("")).toContain("▀");
  });
});
