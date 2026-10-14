/**
 * The shape of `bin/`, asserted rather than left as an intention.
 *
 * The CLI was one 3364-line file. Almost every task had to open it, so two
 * tasks running in parallel edited the same file and merged by hand — which is
 * a place a change gets lost without anything going red. It is now one file per
 * command, and the property that makes that worth having is not "there are more
 * files" but:
 *
 * - **changing one command touches one file**, which stops being true the
 *   moment one command imports another;
 * - **nothing imports the entry point**, so `main` stays a leaf and no command
 *   can reach the dispatcher it is dispatched from;
 * - **no file is orphaned**, because a half-finished move leaves a file that
 *   still compiles, still passes `tsc`, and is dead.
 *
 * None of those three is visible to the test suite any other way: a dead file
 * or a sideways import changes no output at all. So they are checked here, on
 * the import graph, with controls that the checker can see an import in the
 * first place.
 *
 * A fourth property joined them, and it is the same shape — a fact about which
 * file says a thing, invisible in every output: **the flag list `--as` parses a
 * command line with is the command's own list**, not a copy of it kept in step
 * by hand. That copy existed, and the two halves happened to agree.
 *
 * `bin/shared.ts` gets a check of its own. It holds `ENGINE_ROOT`, which is
 * `resolve(import.meta.dir, "..")` — an expression whose answer depends on
 * which directory the file is in. Moving it one level down into
 * `bin/commands/` would silently point the engine root at `bin/`, and every
 * D-021 check that reads it would go on passing while looking at the wrong
 * tree.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { AS_COMMANDS } from "../../bin/as.ts";
import {
  SOUL_APPLY_BOOLEANS,
  SOUL_CHECK_BOOLEANS,
  SOUL_REVOKE_BOOLEANS,
  SOUL_VERIFY_BOOLEANS,
} from "../../bin/commands/soul.ts";
import { TURN_BOOLEANS } from "../../bin/commands/turn.ts";
import { WORN_BOOLEANS } from "../../bin/commands/worn.ts";
import { arrayLiteralArguments, importsOf, reachable, sourceFiles } from "../support/ast.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin");
const ENTRY = join(BIN, "mind.ts");
const COMMANDS = join(BIN, "commands");

/** Every file of the CLI, as repository-relative paths. */
async function binFiles(): Promise<string[]> {
  return (await sourceFiles(BIN)).map((path) => relative(ROOT, path)).sort();
}

/** What one file under `bin/` imports, resolved to absolute paths. */
async function importsFrom(path: string): Promise<string[]> {
  const source = await readFile(path, "utf8");
  return importsOf(path, source).map((specifier) => resolve(dirname(path), specifier));
}

describe("the CLI is one file per command, and the graph says so", () => {
  test("there is more than one file, and `commands/` is where the commands are", async () => {
    const files = await binFiles();
    // Guards every assertion below: all of them are vacuously true over a
    // single file, which is exactly what `bin/` used to be.
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain(join("bin", "mind.ts"));
    expect(files.filter((path) => path.startsWith(join("bin", "commands"))).length).toBeGreaterThan(5);
  });

  test("no file under bin/ is orphaned — all of them are reachable from the entry point", async () => {
    const closure = await reachable([ENTRY]);
    const orphans = (await sourceFiles(BIN)).filter((path) => !closure.has(path)).map((p) => relative(ROOT, p));

    expect(orphans).toEqual([]);

    // Control: the closure really is being walked, rather than being the entry
    // point on its own.
    expect([...closure].filter((path) => path.startsWith(BIN)).length).toBeGreaterThan(5);
    // And it leaves `bin/` for `src/`, which is what makes the walk transitive.
    expect([...closure].some((path) => path.startsWith(join(ROOT, "src")))).toBe(true);
  }, 30_000);

  test("one command never imports another, so changing one touches one file", async () => {
    const sideways: string[] = [];
    for (const path of await sourceFiles(COMMANDS)) {
      for (const target of await importsFrom(path)) {
        if (target.startsWith(COMMANDS)) {
          sideways.push(`${relative(ROOT, path)} → ${relative(ROOT, target)}`);
        }
      }
    }

    expect(sideways).toEqual([]);

    // Control: these files do import things — an empty list above would
    // otherwise be as true of a directory of empty files.
    const everything = (
      await Promise.all((await sourceFiles(COMMANDS)).map((path) => importsFrom(path)))
    ).flat();
    expect(everything.length).toBeGreaterThan(10);
  }, 30_000);

  test("nothing imports the entry point, so `main` stays a leaf", async () => {
    const back: string[] = [];
    for (const path of await sourceFiles(BIN)) {
      if (path === ENTRY) continue;
      for (const target of await importsFrom(path)) {
        if (target === ENTRY) back.push(relative(ROOT, path));
      }
    }
    expect(back).toEqual([]);

    // Control: the entry point imports the commands, so the edges this test
    // looks for do exist in the other direction.
    expect((await importsFrom(ENTRY)).filter((path) => path.startsWith(COMMANDS)).length).toBeGreaterThan(5);
  }, 30_000);

  test("the checker sees an import, and is not fooled by the word in prose", () => {
    const seen = (source: string) => importsOf("synthetic.ts", source);

    expect(seen(`import { a } from "./sibling.ts";`)).toEqual(["./sibling.ts"]);
    expect(seen(`import type { A } from "./sibling.ts";`)).toEqual(["./sibling.ts"]);
    expect(seen(`export { a } from "./sibling.ts";`)).toEqual(["./sibling.ts"]);
    expect(seen(`await import("./sibling.ts");`)).toEqual(["./sibling.ts"]);

    expect(seen(`// import { a } from "./sibling.ts";`)).toEqual([]);
    expect(seen(`const note = 'import { a } from "./sibling.ts"';`)).toEqual([]);
    expect(seen(`import { a } from "node:path";`)).toEqual([]);
  });
});

describe("`--as` parses a command line with that command's own flag list", () => {
  /**
   * The five, paired with the constant each one must *be*.
   *
   * `--as` has to read the command's arguments to notice `--as` and `--subject`
   * contradicting each other, and it reads them with `parseArgs`, which needs to
   * know which flags take no value. That list used to be written twice — once in
   * the command, once in `bin/as.ts` — and matched by hand across two files. The
   * failure the second copy invites is quiet: if `bin/as.ts` did not know
   * `--private` is a boolean, `mind --as ./soul turn --private --prompt hi`
   * would read `--private` as taking the value `--prompt`, and `--as` would
   * refuse or expand a command line the command itself parses fine.
   */
  const PAIRS: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["soul check", SOUL_CHECK_BOOLEANS],
    ["soul apply", SOUL_APPLY_BOOLEANS],
    ["soul verify", SOUL_VERIFY_BOOLEANS],
    ["soul revoke", SOUL_REVOKE_BOOLEANS],
    ["turn", TURN_BOOLEANS],
    ["worn", WORN_BOOLEANS],
  ];

  test("every command `--as` expands for uses the very array its command parses with", () => {
    // `toBe`, not `toEqual`: identity is the property. A list retyped in
    // `bin/as.ts` would be equal today and is exactly what went stale before.
    for (const [key, booleans] of PAIRS) {
      const spec = AS_COMMANDS.get(key);
      expect(spec, `--as claims to expand ${key}`).toBeDefined();
      expect(spec!.booleans, `${key}: same array, not an equal one`).toBe(booleans);
    }

    // And no sixth entry: a command added to the map with a hand-written list
    // would otherwise be unchecked, because the loop above only reads five keys.
    expect([...AS_COMMANDS.keys()].sort()).toEqual(PAIRS.map(([key]) => key).sort());
  });

  test("the control: `toBe` is identity, so a copy of the same words fails it", () => {
    // Without this, the test above would read the same if `toBe` compared
    // contents — which is what it would then be unable to catch.
    const copy: readonly string[] = [...TURN_BOOLEANS];
    expect(copy.join(",")).toBe(TURN_BOOLEANS.join(","));
    expect(copy).not.toBe(TURN_BOOLEANS);
  });

  test("no file whose flag list has a second reader writes that list inline", async () => {
    // The other half. Identity above pins `bin/as.ts` to the constant; this pins
    // the command to it, because `parseArgs(argv, ["json", "private"])` inside
    // `cmdTurn` would go on working while `TURN_BOOLEANS` — and therefore `--as`
    // — drifted. Three files, named rather than globbed: everywhere else an
    // inline list has one reader and is right where it is.
    const owners = [join(COMMANDS, "soul.ts"), join(COMMANDS, "turn.ts"), join(COMMANDS, "worn.ts")];
    const inline: string[] = [];
    for (const path of owners) {
      const source = await readFile(path, "utf8");
      for (const hit of arrayLiteralArguments(path, source, "parseArgs")) {
        inline.push(`${relative(ROOT, path)}:${hit}`);
      }
    }
    expect(inline).toEqual([]);

    // Control: the checker sees such a call, and is not tripped by a named list
    // or by the same words in prose.
    expect(arrayLiteralArguments("x.ts", `parseArgs(argv, ["json"]);`, "parseArgs")).toEqual([
      `1: parseArgs([…])`,
    ]);
    expect(arrayLiteralArguments("x.ts", `parseArgs(argv, TURN_BOOLEANS);`, "parseArgs")).toEqual([]);
    expect(arrayLiteralArguments("x.ts", `parseArgs(argv);`, "parseArgs")).toEqual([]);
    expect(
      arrayLiteralArguments("x.ts", `// parseArgs(argv, ["json"])\nexport const x = 1;`, "parseArgs"),
    ).toEqual([]);
  });
});

describe("ENGINE_ROOT is where it has to be to be right", () => {
  test("it is declared once, in bin/shared.ts, one level below the repository root", async () => {
    const declaring: string[] = [];
    for (const path of await sourceFiles(BIN)) {
      const source = await readFile(path, "utf8");
      if (/^(?:export )?const ENGINE_ROOT\b/m.test(source)) declaring.push(relative(ROOT, path));
    }

    expect(declaring).toEqual([join("bin", "shared.ts")]);

    // The expression is `resolve(import.meta.dir, "..")`, so the answer is a
    // fact about which directory the file sits in. Asserted as the arithmetic
    // rather than as the text: a file moved into `bin/commands/` would still
    // hold the same line and would resolve to `bin/`.
    const shared = join(BIN, "shared.ts");
    expect(resolve(dirname(shared), "..")).toBe(ROOT);
    expect(await readFile(shared, "utf8")).toContain(`resolve(import.meta.dir, "..")`);
  }, 30_000);
});
