/**
 * The guard of the names clean (D-182): no tracked file, in any language, spells a name this product had before it
 * was called Mind, and no file is named after one. There is no allow-list: history, fixtures and comments are held
 * to the same rule as code. The compatibility layer that once read old names is gone too, and this test says so.
 *
 * The only names are "Mind", "mind" and "mind bot". This file builds the scan patterns from short fragments, so it
 * passes its own scan.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");

/** Escape nothing: the fragments are plain letters. A separator is a space, an underscore, a dash, or none. */
const SEP = "[ _-]?";

/** The fragments of the earlier names. Never joined into a literal in this file. */
const FRAGMENTS: readonly (readonly string[])[] = [
  ["oh", "my", "agi"],
  ["om", "agi"],
  ["om", "agi"],
];

/** Every spelling the clean removes, case-insensitively, with any separator or none. */
export const OLD = new RegExp(FRAGMENTS.map((parts) => parts.join(SEP)).join("|"), "i");

/** The derived directory's earlier name: a dot, then the initial of "derived" and the last word of the names above. */
export const OLD_DIR = new RegExp(`(^|[^A-Za-z0-9])\\.${["d", "agi"].join("")}\\b`, "i");

/** One sample spelling per separator: the words joined by `sep`, in `form`. */
const sample = (parts: readonly string[], sep: string, form: (word: string) => string = (w) => w): string => parts.map(form).join(sep);

/** Lines of text that hold an old spelling, 1-based. */
export function oldLines(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  text.split("\n").forEach((line, i) => {
    if (OLD.test(line) || OLD_DIR.test(line)) out.push({ line: i + 1, text: line });
  });
  return out;
}

/** Every problem with `files` (path to text), as sentences a person can act on. Empty means clean. */
export function judge(files: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  for (const [path, text] of files) {
    if (OLD.test(path) || OLD_DIR.test(`/${path}`)) problems.push(`${path}: the file's own name spells an old name`);
    for (const hit of oldLines(text)) problems.push(`${path}:${hit.line}: an old name: ${hit.text.trim().slice(0, 100)}`);
  }
  return problems;
}

/** Every tracked text file, read from the working tree. A tracked file that is gone or is not text is not here. */
function trackedText(): Map<string, string> {
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT });
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  const out = new Map<string, string>();
  for (const path of listed.stdout.toString().split("\0").filter(Boolean)) {
    const full = join(ROOT, path);
    if (!existsSync(full)) continue;
    const bytes = readFileSync(full);
    if (bytes.includes(0)) continue;
    out.set(path, bytes.toString("utf8"));
  }
  return out;
}

describe("no tracked file spells an old name", () => {
  test("the tree is clean, with no allowed place", () => {
    const files = trackedText();
    expect(files.size).toBeGreaterThan(100);
    expect(judge(files)).toEqual([]);
  });

  test("the entry file, the package and the bin links are the new name", () => {
    expect(existsSync(join(ROOT, "bin", "mind.ts"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { name: string; bin: Record<string, string> };
    expect(manifest.name).toBe("mind");
    expect(manifest.bin).toEqual({ mind: "./bin/mind.ts" });
  });
});

describe("the compatibility layer is gone", () => {
  test("its files are not there", () => {
    for (const path of ["src/legacy-names.ts", "src/emit-names.ts", "src/legacy-roots.ts", "src/migrate", "bin/commands/migrate.ts", "test/support/compat-tags.ts"]) {
      expect(existsSync(join(ROOT, path)), path).toBe(false);
    }
  });

  test("no source file carries a compat tag, an expiry, a legacy constant or an emit switch", () => {
    const layer = /compat\(legacy\)|expires: R\+1|\bLEGACY_[A-Z_]+|\bPINNED_PRICE_TABLE_DIGEST_KIND|\bEMIT_NAMES\b|\blegacyEnvName\b/;
    const hits: string[] = [];
    for (const [path, text] of trackedText()) {
      if (!/^(src|bin|scripts|test)\//.test(path) || !/\.(ts|sh|cjs|mjs)$/.test(path)) continue;
      if (path === "test/compat/no-old-names.test.ts") continue;
      text.split("\n").forEach((line, i) => {
        if (layer.test(line)) hits.push(`${path}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });

  test("`mind migrate` is not a command", () => {
    const entry = readFileSync(join(ROOT, "bin", "mind.ts"), "utf8");
    expect(entry).not.toContain('case "migrate"');
    expect(readFileSync(join(ROOT, "bin", "usage.ts"), "utf8")).not.toContain("mind migrate");
  });
});

describe("the guard is not blind (controls)", () => {
  const files = (record: Record<string, string>): Map<string, string> => new Map(Object.entries(record));
  const WORDS = FRAGMENTS[0]!;
  const SHORT = FRAGMENTS[1]!;

  test("every spelling is seen, in any case, with a space, a dash, an underscore or none", () => {
    for (const sep of [" ", "-", "_", ""]) {
      for (const form of [(w: string) => w, (w: string) => w.toUpperCase(), (w: string) => w[0]!.toUpperCase() + w.slice(1)]) {
        expect(OLD.test(sample(WORDS, sep, form)), `${sep}|${sample(WORDS, sep, form)}`).toBe(true);
        expect(OLD.test(sample(SHORT, sep, form)), `${sep}|${sample(SHORT, sep, form)}`).toBe(true);
      }
    }
    expect(OLD.test(`${SHORT.join("")}__subject`)).toBe(true);
    expect(OLD.test(`x-${WORDS.join("")}-token`)).toBe(true);
    for (const fine of ["mind", "Mind bot", "mind-linux-x64", "omega", "agile", "ohm", "my agent"]) expect(OLD.test(fine), fine).toBe(false);
  });

  test("the derived directory's earlier name is seen as a path, and not inside another word", () => {
    expect(OLD_DIR.test(`cat ${"."}${["d", "agi"].join("")}/manifest.json`)).toBe(true);
    expect(OLD_DIR.test(`/${["d", "agi"].join("")}/`)).toBe(false);
    expect(OLD_DIR.test(".mind/manifest.json")).toBe(false);
  });

  test("a spelling is named with its file and line", () => {
    const text = `fine\nand the ${sample(SHORT, "-")} again\n`;
    expect(judge(files({ "src/a.ts": text }))).toEqual([`src/a.ts:2: an old name: and the ${sample(SHORT, "-")} again`]);
  });

  test("a file whose own name spells one is named, history or not", () => {
    expect(judge(files({ [`docs/${sample(SHORT, "-")}.md`]: "fine\n" }))).toEqual([`docs/${sample(SHORT, "-")}.md: the file's own name spells an old name`]);
    expect(judge(files({ [`notes/${sample(SHORT, "-")}.md`]: "fine\n" })).length).toBe(1);
  });

  test("history is held to the same rule: there is no allowed place", () => {
    const text = `${sample(WORDS, "")}\n`;
    for (const path of ["CHANGELOG.md", ".scrum/decisions.md", "notes/x.md", "docs/adr/0001.md", "TRADEMARKS.md", "NOTICE", "test/fixtures/x.json"]) {
      expect(judge(files({ [path]: text })).length, path).toBe(1);
    }
  });

  test("a clean tree has no problems", () => {
    expect(judge(files({ "src/a.ts": "fine\n", "README.md": "Mind\n" }))).toEqual([]);
  });
});
