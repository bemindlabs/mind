/**
 * The console's design tokens are not written in this repository: `src/web/tokens/` holds the two files that
 * bemindlabs/mind-app generates from `src/design/tokens.ts` (the source of truth for every Mind UI, spec §8, S3),
 * copied byte for byte. A copy cannot be edited here and cannot fall behind unnoticed:
 *
 * - **With a mind-app checkout at hand** (`MIND_APP_DIR`, or `../mind-app` beside this repository) each file is
 *   compared byte for byte with `src/design/generated/` there.
 * - **Without one** (CI) each file is compared with the SHA-256 pinned below, and the source hash that both carry is
 *   recomputed from the committed JSON and compared with the pin.
 *
 * To take a change: run `bun run tokens` in mind-app, copy `src/design/generated/{tokens.css,tokens.json}` to
 * `src/web/tokens/`, move the pins below, and commit all of it. Never edit the files by hand.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TOKENS_CSS } from "../../src/web/tokens.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const COPIES = join(ROOT, "src", "web", "tokens");
const FILES = ["tokens.css", "tokens.json"] as const;
type File = (typeof FILES)[number];

/** SHA-256 of each generated file, and the source hash they carry, as of mind-app 1e39150 (the last change to `src/design/generated/`). */
const PINNED: Readonly<Record<File, string>> = {
  "tokens.css": "2a0b095f6176dc35f041b37ab9c4abe54d944d5b3d55558fd2b70e4e45b35415",
  "tokens.json": "1cb55bf840e84692cb19da15f73781488c5e7f1d1e19534a5bf492d0e192e8b3",
};
const PINNED_SOURCE_HASH = "239b7206192545e6a88b3f00bf586d18a830a046dafb9470d3aebfea8cf024dc";

const sha256 = (data: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");
const read = (dir: string, file: File) => new Uint8Array(readFileSync(join(dir, file)));
const loaded = (dir: string): Record<File, Uint8Array> => ({ "tokens.css": read(dir, "tokens.css"), "tokens.json": read(dir, "tokens.json") });
const drifted = (ours: Readonly<Record<File, Uint8Array>>, theirs: Readonly<Record<File, Uint8Array>>): File[] =>
  FILES.filter((file) => !Buffer.from(ours[file]).equals(Buffer.from(theirs[file])));

/** The hash mind-app puts in `tokens.json`: SHA-256 of the object without `$generated` and `sourceHash`, as `JSON.stringify` writes it. */
function sourceHashOf(json: string): string {
  const { $generated: _generated, sourceHash: _hash, ...rest } = JSON.parse(json) as Record<string, unknown>;
  return sha256(JSON.stringify(rest));
}

describe("the console's generated tokens, pinned", () => {
  test("each committed file is the pinned bytes", () => {
    for (const file of FILES) {
      const actual = sha256(read(COPIES, file));
      if (actual !== PINNED[file]) {
        throw new Error(`src/web/tokens/${file} is not the pinned file (sha256 ${actual}, expected ${PINNED[file]}). Copy it from mind-app (bun run tokens there) and move the pins.`);
      }
    }
  });

  test("the source hash is the one the JSON recomputes to, and the stylesheet carries it", () => {
    const json = readFileSync(join(COPIES, "tokens.json"), "utf8");
    expect((JSON.parse(json) as { sourceHash: string }).sourceHash).toBe(PINNED_SOURCE_HASH);
    expect(sourceHashOf(json)).toBe(PINNED_SOURCE_HASH);
    const css = readFileSync(join(COPIES, "tokens.css"), "utf8");
    expect(css).toContain(`source sha256: ${PINNED_SOURCE_HASH}`);
    expect(css).toContain("do not edit");
  });

  test("the page takes exactly the committed stylesheet, as text", () => {
    expect(TOKENS_CSS).toBe(readFileSync(join(COPIES, "tokens.css"), "utf8"));
  });

  test("against mind-app, when its checkout is at hand: byte for byte", () => {
    const dir = process.env["MIND_APP_DIR"] ?? join(ROOT, "..", "mind-app");
    const generated = join(dir, "src", "design", "generated");
    if (!existsSync(join(generated, "tokens.css"))) {
      console.warn(`tokens: no mind-app checkout at ${dir}; checked against the pinned checksums only`);
      return;
    }
    const names = drifted(loaded(COPIES), loaded(generated));
    if (names.length > 0) throw new Error(`${names.join(", ")} differ from mind-app's ${generated}: copy the files over and move the pins in this test.`);
  });

  test("the drift check itself: it names the file that differs, and none when nothing does", () => {
    const ours = loaded(COPIES);
    expect(drifted(ours, loaded(COPIES))).toEqual([]);
    const edited = new Uint8Array(ours["tokens.css"]);
    edited[edited.length - 2] = (edited[edited.length - 2] ?? 0) ^ 1;
    expect(drifted(ours, { ...ours, "tokens.css": edited })).toEqual(["tokens.css"]);
    expect(sha256(edited)).not.toBe(PINNED["tokens.css"]);
    const json = JSON.parse(readFileSync(join(COPIES, "tokens.json"), "utf8")) as { colors: { light: { background: { hsl: string } } } };
    json.colors.light.background.hsl = "0 0% 99%";
    expect(sourceHashOf(JSON.stringify(json))).not.toBe(PINNED_SOURCE_HASH);
  });
});
