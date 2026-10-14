/**
 * EXEC-02 part one, and what `docs/fence.md` says it covers.
 *
 * `prctl(PR_SET_DUMPABLE, 0)` is the flag of one process. `mind turn` and `mind web` set it for themselves. A
 * long-lived command that starts `mind turn` (`mind chat serve`, `mind triggers tick`) is the *grandparent* of the
 * cloud vendor CLI that turn starts, and its own environment is still readable by that CLI's read tool: the
 * 2026-10-13 verifier started a dumpable parent holding a marker in its environment, ran `mind turn --backend
 * claude` under it, and a stand-in claude read the marker from `/proc/<grandparent>/environ` while
 * `/proc/<mind turn pid>/environ` gave EACCES.
 *
 * The docs said those commands were covered. These tests keep the sentence and the code from drifting apart again:
 * the set of commands that make themselves not dumpable is read from the source, and the page has to name the
 * rest as not covered.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");

/** The sources under `dir` (relative to the repository root) that match a pattern. */
async function sourcesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: join(ROOT, dir) })) found.push(join(dir, path));
  return found.sort();
}

/** The files that call `engineNotDumpable(` (an import is not a call). */
async function callersOfEngineNotDumpable(): Promise<string[]> {
  const callers: string[] = [];
  for (const rel of [...(await sourcesUnder("bin")), ...(await sourcesUnder("src"))]) {
    if (rel === join("src", "exec", "fence.ts")) continue; // where it is defined
    const source = await readFile(join(ROOT, rel), "utf8");
    if (/\bengineNotDumpable\(/.test(source)) callers.push(rel);
  }
  return callers;
}

/** The section of `docs/fence.md` about the engine's own flag, split at the sentence that says what is not covered. */
async function dumpableSection(): Promise<{ covered: string; notCovered: string }> {
  const page = await readFile(join(ROOT, "docs", "fence.md"), "utf8");
  const start = page.indexOf("### The engine itself is not dumpable");
  expect(start, "docs/fence.md lost its section on the engine's own flag").toBeGreaterThanOrEqual(0);
  const rest = page.slice(start + 1);
  const end = rest.search(/\n#{1,3} /);
  const section = end < 0 ? rest : rest.slice(0, end);
  const marker = section.indexOf("**Not covered");
  expect(marker, "the section no longer says what is not covered").toBeGreaterThan(0);
  return { covered: section.slice(0, marker), notCovered: section.slice(marker) };
}

describe("which commands make themselves not dumpable", () => {
  test("only `mind turn` and `mind web` call it, besides the fence's supervisor and helper", async () => {
    // Adding a caller (say, in bin/mind.ts before dispatch) is the stronger fix for chat serve and triggers tick.
    // When this list changes, change the section of docs/fence.md that names what is covered.
    expect(await callersOfEngineNotDumpable()).toEqual([join("bin", "commands", "turn.ts"), join("bin", "commands", "web.ts")]);
  });

  test("`mind chat serve` and `mind triggers tick` start `mind turn` and hold the environment themselves", async () => {
    for (const name of ["chat.ts", "triggers.ts"]) {
      const source = await readFile(join(ROOT, "bin", "commands", name), "utf8");
      expect(source, `${name} starts the turn as a child process`).toMatch(/engineCommand\(\)\.argv, "turn"/);
      expect(source, `${name} hands the turn this process's environment`).toMatch(/\.\.\.process\.env/);
      expect(source, `${name} does not close its own environment`).not.toMatch(/NotDumpable|PR_SET_DUMPABLE/);
    }
  });
});

describe("docs/fence.md: what the flag covers", () => {
  test("the commands that call it are the ones listed as covered", async () => {
    const { covered } = await dumpableSection();
    expect(covered).toContain("`mind turn`");
    expect(covered).toContain("`mind web`");
    expect(covered).toContain("supervisor");
  });

  test("a long-lived parent of a turn is named as not covered, and is not named as covered", async () => {
    const { covered, notCovered } = await dumpableSection();
    for (const command of ["mind chat serve", "mind triggers tick"]) {
      expect(covered, `${command} is not covered: it is the grandparent of the vendor CLI`).not.toContain(command);
      expect(notCovered, `${command} has to be named as readable`).toContain(command);
    }
    expect(covered).not.toMatch(/so they are covered/);
  });

  test("the commands that start a vendor CLI themselves stay listed as not covered", async () => {
    const { notCovered } = await dumpableSection();
    for (const command of ["mind memory ask", "mind persona", "mind soul"]) expect(notCovered).toContain(command);
  });

  test("it says what the cloud-path consequence is, in words an owner can act on", async () => {
    const { notCovered } = await dumpableSection();
    expect(notCovered).toMatch(/read tool/);
    expect(notCovered).toMatch(/environment/);
  });
});
