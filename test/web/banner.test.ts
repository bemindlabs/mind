/** D-162 — the link `mind web` prints: the key only at a terminal. */

import { describe, expect, test } from "bun:test";
import { bareLink, linkLines, maskKey } from "../../src/web/banner.ts";

const KEY = "0123456789abcdef".repeat(4);
const URL_WITH_KEY = `https://box.tail1.ts.net:30701/#t=${KEY}`;

/** Every run of 8 characters of the key, so a test can say "none of it", not just "not all of it". */
function pieces(key: string): string[] {
  return Array.from({ length: key.length - 7 }, (_, i) => key.slice(i, i + 8));
}

describe("the printed link (D-162)", () => {
  test("at a terminal: the whole link, as before", () => {
    expect(linkLines(URL_WITH_KEY, { terminal: true })).toEqual({ link: URL_WITH_KEY });
    expect(linkLines(URL_WITH_KEY, { terminal: true, keyFile: "/k/web.key" })).toEqual({ link: URL_WITH_KEY });
  });

  test("off a terminal with a key file: the address and the file's path, no key material at all", () => {
    const shown = linkLines(URL_WITH_KEY, { terminal: false, keyFile: "/home/o/.secrets/web.key" });
    expect(shown.link).toBe("https://box.tail1.ts.net:30701/");
    expect(shown.note).toContain("/home/o/.secrets/web.key");
    const all = `${shown.link}\n${shown.note}`;
    for (const piece of pieces(KEY)) expect(all).not.toContain(piece);
    expect(all).not.toContain(KEY.slice(0, 4) + "…");
  });

  test("off a terminal without a key file: the key masked to its first and last four", () => {
    const shown = linkLines(URL_WITH_KEY, { terminal: false });
    expect(shown.link).toBe("https://box.tail1.ts.net:30701/#t=0123…cdef");
    expect(shown.note).toContain("--key-file");
    const all = `${shown.link}\n${shown.note}`;
    for (const piece of pieces(KEY)) expect(all).not.toContain(piece);
  });

  test("a link with no key is left alone; the mask never shows more than eight characters", () => {
    expect(linkLines("http://127.0.0.1:1/", { terminal: false })).toEqual({ link: "http://127.0.0.1:1/" });
    expect(bareLink("http://127.0.0.1:1/")).toBe("http://127.0.0.1:1/");
    expect(bareLink(URL_WITH_KEY)).toBe("https://box.tail1.ts.net:30701/");
    expect(maskKey(KEY)).toBe("0123…cdef");
    expect(maskKey("abcdefgh")).toBe("…");
  });
});
