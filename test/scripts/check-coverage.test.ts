/**
 * The gate that watches every source file, watched.
 *
 * `scripts/check-coverage.ts` decides whether the test suite really runs the
 * code it loads, and until now it was the one file in this repository that
 * nothing checked — and could not be checked, because every line of it was
 * top-level: importing it from a test meant starting `bun test` from inside
 * `bun test`. The measuring now sits behind `import.meta.main` and the judging is
 * pure, so the three questions below can be asked of invented lcov rather than
 * of this machine.
 *
 * The one that matters most is the **malformed report**. A gate whose parser
 * quietly returns nothing must fail, not pass: bun could change its reporter,
 * the lcov could be truncated by a full disk, and an empty parse read as "no
 * file is below the floor" would print `all 60 source file(s) … 85%` over a suite
 * that measured nothing. That is the exact shape of failure this repository keeps
 * finding, and it is asserted here as its own test.
 *
 * The second is the **exemption list**. Eight files are excused from needing a
 * test on the words *"Checked, not assumed: every line of this file is
 * `export *`"* — checked once, by a person, in 2026. Now every run reads them.
 *
 * The third arrived with `bin/`. Thirteen files there run only in a process the
 * tests spawned, where bun measures nothing, so they are held at a recorded
 * size instead of a percentage. That list has the failure mode every second
 * list has: it describes a tree it does not live in, and it drifts. So the
 * numbers in it are checked against the files on **every `bun test` run**,
 * rather than only when somebody runs the gate — a ratchet nobody turns is a
 * number that was true once.
 *
 * The fourth arrived with `scripts/`, and brought two things worth naming.
 *
 * **`judge` used to be `main`.** 115 lines turning verdicts into an exit code,
 * reachable only by running the gate — so the largest untested thing in this
 * repository was inside the file whose job is to find untested things. It is
 * pure now, and what is tested below is not only each branch but their
 * **order**: absence before the floor, the `scripts/` registry before the size
 * ratchet. Reordering any pair changes which failure a person is shown first,
 * and two of the orderings are load-bearing rather than cosmetic.
 *
 * **`measure` takes the command it runs.** It is the one function here that
 * starts `bun test`, and it has no default, so the tests below hand it `bash`
 * and a `printf`. That is deliberate to the point of being the design: a
 * default would be a default nobody passes over, and the first test to call it
 * would have forked the suite inside itself.
 */

import { describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Readings } from "../../scripts/check-coverage.ts";
import {
  EXEMPT,
  FLOOR,
  PROOFS,
  PROVED_OTHERWISE,
  SPAWN_ONLY,
  allFiles,
  codeLines,
  heldSummary,
  judge,
  measure,
  parseLcov,
  percent,
  ranges,
  readFiles,
  scriptsSummary,
  scriptsVerdict,
  sha256,
  sizeVerdict,
  sourceFiles,
  verdict,
} from "../../scripts/check-coverage.ts";
import { nonReExports, unguardedTopLevel } from "../support/ast.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "scripts", "check-coverage.ts");

/** One lcov record, written out the way bun's reporter writes them. */
function record(path: string, lines: ReadonlyArray<readonly [number, number]>): string {
  const found = lines.length;
  const hit = lines.filter(([, hits]) => hits > 0).length;
  return [
    `SF:${path}`,
    ...lines.map(([at, hits]) => `DA:${at},${hits}`),
    `LF:${found}`,
    `LH:${hit}`,
    "end_of_record",
  ].join("\n");
}

/** `n` executable lines of which `hit` ran, as one record. */
function coverage(path: string, found: number, hit: number): string {
  const lines: Array<readonly [number, number]> = [];
  for (let at = 1; at <= found; at++) lines.push([at, at <= hit ? 1 : 0]);
  return record(path, lines);
}

describe("reading an lcov report", () => {
  test("SF, DA, LF and LH, per file, and the missed lines in order", () => {
    const lcov = [
      record("src/a.ts", [[1, 3], [2, 0], [3, 1], [4, 0]]),
      record("src/b.ts", [[10, 1]]),
      "",
    ].join("\n");

    const measured = parseLcov(lcov);
    expect([...measured.keys()]).toEqual(["src/a.ts", "src/b.ts"]);
    expect(measured.get("src/a.ts")).toEqual({ found: 4, hit: 2, missed: [2, 4] });
    expect(measured.get("src/b.ts")).toEqual({ found: 1, hit: 1, missed: [] });
  });

  test("a record with no `end_of_record` is not reported as a measured file", () => {
    // Truncation is the ordinary way a report goes wrong, and half a record is
    // not a measurement. The file then reads as absent, which fails loudly.
    const truncated = `SF:src/a.ts\nDA:1,1\nLF:1\nLH:1\n`;
    expect(parseLcov(truncated).size).toBe(0);
  });

  test("state does not leak from one record into the next", () => {
    // `missed` is accumulated in a variable that `SF:` resets. If it did not,
    // the second file would inherit the first one's uncovered lines and a clean
    // file would be reported as dirty.
    const lcov = [record("src/a.ts", [[1, 0], [2, 0]]), record("src/b.ts", [[1, 1]]), ""].join("\n");
    expect(parseLcov(lcov).get("src/b.ts")).toEqual({ found: 1, hit: 1, missed: [] });
  });
});

describe("a report this cannot parse fails the gate", () => {
  const gated = ["src/a.ts", "src/b.ts"];

  test("an unparseable report makes every file unseen, not every file fine", () => {
    // The whole reason the gate asks about absence before percentages. Each of
    // these is a plausible thing to find in `lcov.info`: the JSON reporter's
    // output, an empty file from a disk that filled, and a crash message.
    for (const junk of ['{"total":{"lines":{"pct":94.2}}}', "", "error: out of memory"]) {
      const { unseen, below } = verdict(gated, parseLcov(junk), FLOOR);
      expect(unseen, JSON.stringify(junk)).toEqual(gated);
      // And `below` is empty — which is only safe because the caller reports
      // `unseen` first. Asserted so that reordering the two would fail here.
      expect(below).toEqual([]);
    }
  });

  test("absence shuts out the floor even when the rest of the report is fine", () => {
    const measured = parseLcov(coverage("src/a.ts", 100, 10));
    const { unseen, below } = verdict(gated, measured, FLOOR);
    expect(unseen).toEqual(["src/b.ts"]);
    expect(below).toEqual([]);
  });
});

describe("the floor, at its edges", () => {
  const gated = ["src/a.ts"];
  const decide = (found: number, hit: number) =>
    verdict(gated, parseLcov(coverage("src/a.ts", found, hit)), FLOOR).below.map((b) => b.path);

  test("exactly on the floor passes, one line under it does not", () => {
    expect(decide(100, 85)).toEqual([]);
    expect(decide(100, 84)).toEqual(["src/a.ts"]);
  });

  test("a file whose exact share is the floor is not decided by rounding", () => {
    // 17/20 is 85% exactly, and 84.999…% under any float that rounds badly. The
    // comparison is `hit * 100 < FLOOR * found`, which has no float in it.
    expect(decide(20, 17)).toEqual([]);
    expect(decide(20, 16)).toEqual(["src/a.ts"]);
    expect(decide(3, 3)).toEqual([]);
  });

  test("a file with no executable lines passes rather than failing as 0%", () => {
    // `LF:0` is a file of types and re-exports. Calling that 0% would fail a
    // file for having nothing to run.
    const empty = parseLcov(record("src/a.ts", []));
    expect(empty.get("src/a.ts")).toEqual({ found: 0, hit: 0, missed: [] });
    expect(verdict(gated, empty, FLOOR).below).toEqual([]);
    expect(percent({ found: 0, hit: 0, missed: [] })).toBe("  n/a");
  });

  test("the floor is the one passed in, not one baked into the comparison", () => {
    // So that `--report`'s advice — re-measure, then move the number — is true.
    const measured = parseLcov(coverage("src/a.ts", 100, 90));
    expect(verdict(gated, measured, 85).below).toEqual([]);
    expect(verdict(gated, measured, 95).below.map((b) => b.path)).toEqual(["src/a.ts"]);
  });
});

describe("what the failure message says", () => {
  test("a percentage is printed from lcov's own integers", () => {
    expect(percent({ found: 100, hit: 70, missed: [] })).toBe("70.00");
    expect(percent({ found: 3, hit: 2, missed: [] })).toBe("66.67");
  });

  test("runs of never-run lines collapse, and a single line stays single", () => {
    expect(ranges([3, 4, 5, 9])).toBe("3-5, 9");
    expect(ranges([1])).toBe("1");
    expect(ranges([])).toBe("");
    expect(ranges([2, 4, 6])).toBe("2, 4, 6");
    // The tail the message exists for: one range, not forty numbers.
    expect(ranges([10, 11, 12, 13, 20, 21])).toBe("10-13, 20-21");
  });

  test("the missed lines a failing file reports are the ones lcov marked zero", () => {
    const measured = parseLcov(record("src/a.ts", [[1, 1], [2, 0], [3, 0], [7, 0]]));
    const [failed] = verdict(["src/a.ts"], measured, FLOOR).below;
    expect(failed?.path).toBe("src/a.ts");
    expect(ranges(failed!.cov.missed)).toBe("2-3, 7");
  });
});

describe("the exemption list is still true", () => {
  test("every exempt file exists, and every line of it is a re-export", async () => {
    // The stated reason, checked rather than inherited. A barrel that grows a
    // function is a file with no test and an exemption that reads as a decision.
    expect(EXEMPT.size).toBeGreaterThan(5);
    for (const [rel, reason] of EXEMPT) {
      const source = await readFile(join(ROOT, rel), "utf8");
      expect(nonReExports(rel, source), `${rel} — exempt as "${reason}"`).toEqual([]);
    }
  });

  test("every exempt path is one the gate would otherwise have scanned", async () => {
    // A key spelled differently from what `sourceFiles` produces exempts
    // nothing. That direction fails loudly today — the file goes red — but it
    // fails in the gate's own output rather than here, and it fails for a
    // reason that reads like a missing test.
    const scanned = new Set(
      (await sourceFiles(join(ROOT, "src"))).map((path) => path.slice(ROOT.length + 1)),
    );
    for (const rel of EXEMPT.keys()) expect(scanned.has(rel), rel).toBe(true);
  }, 30_000);

  test("the control: the re-export check fires on a barrel with code in it", () => {
    expect(nonReExports("x.ts", `export * from "./a.ts";\nexport {};`)).toEqual([]);
    expect(nonReExports("x.ts", `export type { A } from "./a.ts";`)).toEqual([]);
    expect(nonReExports("x.ts", `export * from "./a.ts";\nexport const x = 1;`)).toEqual([
      "2: VariableStatement",
    ]);
    expect(nonReExports("x.ts", `export function f() {}`)).toEqual(["1: FunctionDeclaration"]);
    expect(nonReExports("x.ts", `console.log("hi");`)).toEqual(["1: ExpressionStatement"]);
    // A local re-export is not a re-export: `export { x }` with no `from` means
    // `x` is declared in this file, so there is something here to test.
    expect(nonReExports("x.ts", `const x = 1;\nexport { x };`)).toEqual([
      "1: VariableStatement",
      "2: ExportDeclaration",
    ]);
  });
});

describe("counting the lines bun cannot measure", () => {
  test("blank lines and comments are not code; a trailing comment does not erase a line", () => {
    const source = [
      `// a line comment`,
      ``,
      `/**`,
      ` * a doc comment`,
      ` */`,
      `export const x = 1; // still a line of code`,
      `   `,
      `/* one-line block */`,
      `const y = 2;`,
    ].join("\n");
    expect(codeLines(source)).toBe(2);
  });

  test("an empty file is zero, and a file of nothing but comments is zero", () => {
    expect(codeLines("")).toBe(0);
    expect(codeLines("\n\n   \n")).toBe(0);
    expect(codeLines("/**\n * all of it\n */\n")).toBe(0);
  });

  test("a block comment that never closes takes the rest of the file with it", () => {
    // Which is also what the compiler does with it, so the count agrees with
    // the only reading of that file there is.
    expect(codeLines(`const a = 1;\n/* opened\nconst b = 2;\nconst c = 3;`)).toBe(1);
  });

  test("the documented blind spot: a `//` line inside a template literal", () => {
    // Asserted so that it is a known cost rather than a surprise. It makes one
    // number in SPAWN_ONLY lower than a reader would guess; it does not make a
    // change invisible, because the count still moves when the file does.
    const template = "export const u = `\n// looks like a comment\nreal line\n`;\n";
    expect(codeLines(template)).toBe(3);
    expect(codeLines(template.replace("// looks like a comment", "x"))).toBe(4);
  });
});

describe("the held-at-size verdict", () => {
  const held = (lines: number) => ({ lines, why: "spawned" });

  test("a file exactly its recorded size is not a failure of either kind", () => {
    const { grown, shrunk, missing } = sizeVerdict(
      new Map([["bin/a.ts", 10]]),
      new Map([["bin/a.ts", held(10)]]),
    );
    expect([grown, shrunk, missing]).toEqual([[], [], []]);
  });

  test("growing fails — the part nobody can measure got bigger", () => {
    const { grown, shrunk } = sizeVerdict(
      new Map([["bin/a.ts", 11]]),
      new Map([["bin/a.ts", held(10)]]),
    );
    expect(grown).toEqual([{ path: "bin/a.ts", was: 10, now: 11 }]);
    expect(shrunk).toEqual([]);
  });

  test("shrinking fails too, which is the half a ratchet usually forgets", () => {
    // A number left above the file is room the next change grows into for
    // free. Both directions have to cost a line, or the list drifts silently —
    // and a second list that drifts is this repository's most-repeated bug.
    const { grown, shrunk } = sizeVerdict(
      new Map([["bin/a.ts", 9]]),
      new Map([["bin/a.ts", held(10)]]),
    );
    expect(shrunk).toEqual([{ path: "bin/a.ts", was: 10, now: 9 }]);
    expect(grown).toEqual([]);
  });

  test("a recorded path that is not on disk is its own failure, not a pass", () => {
    // The shape a typo takes. `missing` rather than silence, because a line in
    // the list that matches nothing still reads like a decision someone made.
    const { missing, grown, shrunk } = sizeVerdict(
      new Map([["bin/a.ts", 10]]),
      new Map([["bin/a.ts", held(10)], ["bin/gone.ts", held(4)]]),
    );
    expect(missing).toEqual(["bin/gone.ts"]);
    expect([grown, shrunk]).toEqual([[], []]);
  });

  test("a measured file the list says nothing about is not this function's business", () => {
    // It is the floor's: anything under bin/ that is not listed is gated, so
    // silence here is the handover, not a hole.
    const { grown, shrunk, missing } = sizeVerdict(
      new Map([["bin/a.ts", 10], ["bin/unlisted.ts", 99]]),
      new Map([["bin/a.ts", held(10)]]),
    );
    expect([grown, shrunk, missing]).toEqual([[], [], []]);
  });

  test("every drift is reported, not the first one", () => {
    const { grown, shrunk } = sizeVerdict(
      new Map([["bin/a.ts", 11], ["bin/b.ts", 2], ["bin/c.ts", 30]]),
      new Map([["bin/a.ts", held(10)], ["bin/b.ts", held(5)], ["bin/c.ts", held(20)]]),
    );
    expect(grown.map((d) => d.path)).toEqual(["bin/a.ts", "bin/c.ts"]);
    expect(shrunk.map((d) => d.path)).toEqual(["bin/b.ts"]);
  });
});

describe("what the gate says about the half it cannot measure", () => {
  const sizes = new Map([["bin/a.ts", 10], ["bin/b.ts", 32], ["src/x.ts", 5]]);
  const recorded = new Map([
    ["bin/a.ts", { lines: 10, why: "spawned" }],
    ["bin/b.ts", { lines: 32, why: "spawned" }],
  ]);

  test("it counts the files and their lines, and both come from the tree", () => {
    const said = heldSummary(sizes, recorded);
    expect(said).toContain("2 file(s)");
    expect(said).toContain("42 code line(s)");
    // `src/x.ts` is measured and not held, so it is not in the total.
    expect(said).not.toContain("47");
  });

  test("it says what the number does not prove, in the same breath as the number", () => {
    // The limitation is the point. A count of lines printed beside a coverage
    // percentage reads as a coverage claim unless it says it is not one, and
    // someone reading a green run is exactly who needs to be told.
    const said = heldSummary(sizes, recorded);
    expect(said).toContain("not that it is tested");
    expect(said).toContain("bun measures nothing");
  });

  test("a held file that is not on disk is left out of the count rather than counted as zero", () => {
    expect(heldSummary(sizes, new Map([...recorded, ["bin/gone.ts", { lines: 7, why: "x" }]]))).toBe(
      heldSummary(sizes, recorded),
    );
  });
});

describe("the recorded sizes are still the sizes of the files", () => {
  test("every held file exists, and measures exactly what is written down", async () => {
    // The ratchet, turned by `bun test` rather than only by the gate. Running
    // the gate spawns a whole suite; this reads thirteen files, so the number
    // in the list cannot be true-when-written and wrong ever after. The gate
    // checks the same numbers itself — and, because it runs the suite first,
    // this is what fails when they drift. That one is the backstop for the day
    // this test is deleted, and it is the half that prints what to do next.
    expect(SPAWN_ONLY.size).toBeGreaterThan(5);
    for (const [rel, held] of SPAWN_ONLY) {
      const source = await readFile(join(ROOT, rel), "utf8");
      expect(codeLines(source), `${rel} — held at ${held.lines}, "${held.why}"`).toBe(held.lines);
    }
  });

  test("every held path is one the gate would otherwise have gated, and has a reason", async () => {
    const scanned = new Set(
      (await sourceFiles(join(ROOT, "bin"))).map((path) => relative(ROOT, path)),
    );
    for (const [rel, held] of SPAWN_ONLY) {
      expect(scanned.has(rel), rel).toBe(true);
      expect(held.why.length, rel).toBeGreaterThan(10);
    }
  }, 30_000);

  test("bin/ still has files on the floor, so the floor over it is not vacuous", async () => {
    // If every file under bin/ were held at a size, the 85% floor would apply
    // to nothing there and this whole arrangement would be a list of numbers.
    // The default is the floor, and these three are what that default looks
    // like. `bin/dial.ts` joined them in E5 on purpose: reading, deciding and
    // writing the autonomy dial can all be called from a test with a temporary
    // directory, so it is held to the floor and the report-writing that cannot
    // be lives in `bin/commands/autonomy.ts`, which is spawn-only and says so.
    const onFloor = (await sourceFiles(join(ROOT, "bin")))
      .map((path) => relative(ROOT, path))
      .filter((rel) => !SPAWN_ONLY.has(rel))
      .sort();
    expect(onFloor).toEqual([
      join("bin", "as.ts"),
      join("bin", "dial.ts"),
      join("bin", "shared.ts"),
      join("bin", "triage.ts"),
    ]);
  }, 30_000);

  test("no file is on both lists, and nothing outside bin/ is held", () => {
    // EXEMPT excuses a file from having a test; SPAWN_ONLY holds it at a size.
    // A file on both would be excused twice and watched once.
    for (const rel of SPAWN_ONLY.keys()) {
      expect(EXEMPT.has(rel), rel).toBe(false);
      // And the list is about bin/ only: `src/` has no spawn-only half, and a
      // src file hidden here would leave the floor quietly.
      expect(rel.startsWith("bin/"), rel).toBe(true);
    }
  });
});

describe("the gate can be imported at all", () => {
  test("nothing in the script runs until it is run as a program", async () => {
    // This test file imported it, and the suite is still going, which is the
    // strongest form of this assertion — the previous shape would have spawned a
    // nested `bun test` before the first `expect` below.
    const source = await readFile(SCRIPT, "utf8");
    expect(unguardedTopLevel(SCRIPT, source)).toEqual([]);
    expect(source).toContain("if (import.meta.main)");
  });

  test("the control: the three ways the guard could come undone, on the real file", async () => {
    // Over the real source's *text*, mutated in memory and never executed. The
    // ordinary way to prove a gate bites is to break the thing and watch it go
    // red — and here that means `bun test` spawning `bun test` from inside
    // itself, recursively, which is the fault this guard removes. So the
    // mutations are applied to a string.
    const source = await readFile(SCRIPT, "utf8");
    const GUARD = "if (import.meta.main) process.exit(await main(Bun.argv));";
    expect(source).toContain(GUARD);

    const shapes: ReadonlyArray<readonly [string, string]> = [
      ["a top-level await put back", `const lcov = await measure();\n${GUARD}`],
      ["the guard dropped", "process.exit(await main(Bun.argv));"],
      ["the guard replaced by something that is true on import", `if (Bun.argv.length > 1) ${GUARD.slice("if (import.meta.main) ".length)}`],
    ];

    for (const [what, replacement] of shapes) {
      const mutated = source.replace(GUARD, replacement);
      expect(mutated, what).not.toBe(source);
      expect(unguardedTopLevel(SCRIPT, mutated), what).not.toEqual([]);
    }
  });

  test("the control: it sees both shapes the old file had", () => {
    expect(unguardedTopLevel("x.ts", `const dir = await mkdtemp(tmp);`)).toEqual([
      "1: top-level await",
    ]);
    expect(unguardedTopLevel("x.ts", `process.exit(1);`)).toEqual(["1: ExpressionStatement"]);
    expect(unguardedTopLevel("x.ts", `if (x) process.exit(1);`)).toEqual(["1: IfStatement"]);

    // And not on what a module is allowed to do on import: compute a path,
    // declare things, and guard its own entry point.
    expect(unguardedTopLevel("x.ts", `const ROOT = resolve(import.meta.dir, "..");`)).toEqual([]);
    expect(unguardedTopLevel("x.ts", `export async function main() { await go(); }`)).toEqual([]);
    expect(unguardedTopLevel("x.ts", `if (import.meta.main) process.exit(await main());`)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scripts/ — the folder whose files judge everything else
// ---------------------------------------------------------------------------

/** The `scripts/` tree as the registry describes it, for the synthetic readings. */
const REGISTERED = [...PROVED_OTHERWISE.keys(), "scripts/check-coverage.ts"];
/** Digests that agree with PROOFS, so a test has to *opt in* to staleness. */
const AGREEING = new Map([...PROOFS].map(([path, proof]) => [path, proof.sha256]));
/** Sizes that agree with SPAWN_ONLY, for the same reason. */
const RECORDED_SIZES = new Map([...SPAWN_ONLY].map(([path, held]) => [path, held.lines]));

describe("the scripts/ verdict", () => {
  const proved = new Map([["scripts/a.sh", { question: "q", by: "t", why: "w" }]]);
  const proofs = new Map([
    ["scripts/a.sh", { sha256: "abc", provedOn: "2026-01-01", by: "cmd", result: "ok" }],
  ]);
  const digests = new Map([["scripts/a.sh", "abc"]]);

  test("a listed file whose digest agrees is not a failure of any kind", () => {
    const { unasked, stray, stale } = scriptsVerdict(["scripts/a.sh"], digests, proved, proofs);
    expect([unasked, stray, stale]).toEqual([[], [], []]);
  });

  test("a .ts file nobody lists is not this function's business — the floor has it", () => {
    // The handover, asserted so that adding it here later would be a visible
    // decision rather than a silent second gate on the same file.
    const { unasked } = scriptsVerdict(["scripts/a.sh", "scripts/new.ts"], digests, proved, proofs);
    expect(unasked).toEqual([]);
  });

  test("a file bun cannot measure and nobody lists fails for arriving at all", () => {
    // The hole gate4 closes. A second shell script under scripts/ was invisible
    // to every gate in this repository: no coverage, no size, no question.
    const { unasked } = scriptsVerdict(["scripts/a.sh", "scripts/new.sh"], digests, proved, proofs);
    expect(unasked).toEqual(["scripts/new.sh"]);
  });

  test("every unasked file is reported, not the first one", () => {
    const { unasked } = scriptsVerdict(
      ["scripts/one.py", "scripts/a.sh", "scripts/two.rb"],
      digests,
      proved,
      proofs,
    );
    expect(unasked).toEqual(["scripts/one.py", "scripts/two.rb"]);
  });

  test("a question about a file that is gone is its own failure", () => {
    const { stray } = scriptsVerdict([], new Map(), proved, new Map());
    expect(stray).toEqual(["scripts/a.sh"]);
  });

  test("a proof of a file that is gone is the same failure, and is not double-counted", () => {
    // Both maps name `scripts/a.sh`; the file is gone once, so it is reported
    // once. A list that says the same thing twice teaches people to skim it.
    const { stray, stale } = scriptsVerdict([], new Map(), proved, proofs);
    expect(stray).toEqual(["scripts/a.sh"]);
    // And no staleness for a file that is not there: absence is the answer.
    expect(stale).toEqual([]);
  });

  test("bytes that moved after the proof are reported with both digests", () => {
    const { stale } = scriptsVerdict(["scripts/a.sh"], new Map([["scripts/a.sh", "def"]]), proved, proofs);
    expect(stale).toEqual([{ path: "scripts/a.sh", was: "abc", now: "def" }]);
  });

  test("a proved file whose digest was never read is stale rather than fine", () => {
    // `undefined !== "abc"` is the safe direction, and it is asserted so that
    // a later `?? proof.sha256` cannot turn a missing reading into agreement.
    const { stale } = scriptsVerdict(["scripts/a.sh"], new Map(), proved, proofs);
    expect(stale).toEqual([{ path: "scripts/a.sh", was: "abc", now: "<not read>" }]);
  });
});

describe("what the gate says about scripts/ on every run", () => {
  const code = new Map([["scripts/a.sh", 20], ["scripts/b.ts", 30]]);
  const proved = new Map([["scripts/a.sh", { question: "is it still x?", by: "test/x.test.ts", why: "w" }]]);
  const proofs = new Map([
    ["scripts/a.sh", { sha256: "abc", provedOn: "2026-01-01", by: "npm run x", result: "12/12" }],
  ]);

  test("every file lands in exactly one named group, and the groups add up", () => {
    const said = scriptsSummary(["scripts/a.sh", "scripts/b.ts"], code, proved, proofs);
    expect(said).toContain("2 file(s), 50 code line(s)");
    expect(said).toContain(`1 on the ${FLOOR}% line floor`);
    expect(said).toContain("scripts/b.ts");
    expect(said).toContain("1 proved otherwise");
    expect(said).toContain("is it still x?");
    expect(said).toContain("asked by test/x.test.ts");
  });

  test("the proof is quoted with its date and what it printed, so it can be re-run", () => {
    const said = scriptsSummary(["scripts/a.sh"], code, proved, proofs);
    expect(said).toContain("2026-01-01");
    expect(said).toContain("npm run x");
    expect(said).toContain("12/12");
  });

  test("it says what a proof record does not prove, in the same breath as the record", () => {
    // The condition this whole mechanism was accepted under. A hash printed
    // beside a coverage percentage reads as a coverage claim unless it says it
    // is not one — and the person reading a *green* run is exactly who needs
    // telling, which is why this string is not in a comment.
    const said = scriptsSummary(["scripts/a.sh"], code, proved, proofs);
    expect(said).toContain("have not moved since that date");
    expect(said).toContain("does not");
    expect(said).toContain("passes today");
    expect(said).toContain("a change in src/");
  });

  test("a file nothing asks about is named in the summary, not only in the failure", () => {
    const said = scriptsSummary(["scripts/a.sh", "scripts/new.sh"], code, proved, proofs);
    expect(said).toContain("1 asked nothing at all: scripts/new.sh");
  });

  test("an empty floor group says so rather than printing a bare count", () => {
    expect(scriptsSummary(["scripts/a.sh"], code, proved, proofs)).toContain("is: none");
  });
});

describe("the gate's decision, every branch and the order of them", () => {
  /** Readings that pass, so every test below changes exactly one thing. */
  const readings = (over: Partial<Readings> = {}): Readings => ({
    lcov: [
      coverage("src/a.ts", 10, 10),
      coverage("scripts/check-coverage.ts", 10, 10),
      "",
    ].join("\n"),
    src: ["src/a.ts"],
    bin: [],
    scripts: REGISTERED,
    code: RECORDED_SIZES,
    lines: new Map(),
    digests: AGREEING,
    argv: [],
    ...over,
  });

  test("a green run is 0, and says what it checked in all three halves", () => {
    const { code, out, err } = judge(readings());
    expect({ code, err }).toEqual({ code: 0, err: [] });
    expect(out.join("\n")).toContain("are loaded by a test");
    expect(out.join("\n")).toContain(`${PROVED_OTHERWISE.size} file(s) under scripts/`);
  });

  test("a green run still prints both summaries, before any verdict", () => {
    // The one outcome refused is silence about the halves a percentage does
    // not cover. Asserted on the green path, because that is the path where
    // nobody is reading carefully.
    const { out } = judge(readings());
    expect(out[0]).toContain("run only in a spawned process");
    expect(out[1]).toContain("the tools that prove the rest of this repository");
  });

  test("no lcov at all is 1, and is not confused with nothing being covered", () => {
    const { code, err } = judge(readings({ lcov: undefined }));
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("nothing was measured");
  });

  test("--report is 0 and gates nothing, even over readings that would fail", () => {
    const { code, out } = judge(
      readings({ argv: ["--report"], scripts: [...REGISTERED, "scripts/orphan.sh"] }),
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("line coverage per file");
    expect(out.join("\n")).toContain("scripts/orphan.sh");
  });

  test("--report names every gated file, including the ones with no reading", () => {
    const { out } = judge(readings({ lcov: "", argv: ["--report"] }));
    expect(out.join("\n")).toContain("absent  src/a.ts");
  });

  test("a file no test loads is 1, and is reported with its size", () => {
    const { code, err } = judge(
      readings({ lcov: coverage("scripts/check-coverage.ts", 10, 10), lines: new Map([["src/a.ts", 42]]) }),
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("no test ever loads");
    expect(err.join("\n")).toContain("src/a.ts  (42 lines)");
  });

  test("a file under the floor is 1, and is told which lines never ran", () => {
    const { code, err } = judge(
      readings({
        lcov: [record("src/a.ts", [[1, 1], [2, 0], [3, 0]]), coverage("scripts/check-coverage.ts", 10, 10), ""].join("\n"),
      }),
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toContain(`below the ${FLOOR}% line floor`);
    expect(err.join("\n")).toContain("never run: 2-3");
  });

  test("a scripts/ file nothing asks about is 1, and says what to write down", () => {
    const { code, err } = judge(readings({ scripts: [...REGISTERED, "scripts/new.sh"] }));
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("nothing asks anything about");
    expect(err.join("\n")).toContain("scripts/new.sh");
    expect(err.join("\n")).toContain("PROVED_OTHERWISE");
  });

  test("a question about a file that is gone is 1", () => {
    const { code, err } = judge(readings({ scripts: ["scripts/check-coverage.ts"] }));
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("written down but not on disk");
  });

  test("a proved file whose bytes moved is 1, and both digests are printed", () => {
    const path = [...PROOFS.keys()][0]!;
    const { code, err } = judge(readings({ digests: new Map([...AGREEING, [path, "0".repeat(64)]]) }));
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("changed after the run that proved them");
    expect(err.join("\n")).toContain(PROOFS.get(path)!.sha256);
    expect(err.join("\n")).toContain("0".repeat(64));
    // And it says the limit at the point of failure, not only in the summary.
    expect(err.join("\n")).toContain("re-running");
  });

  test("a held file that is not on disk is 1", () => {
    // A path missing from the readings is how `sizeVerdict` hears "not there".
    const gone = [...SPAWN_ONLY.keys()][0]!;
    const short = new Map([...RECORDED_SIZES].filter(([path]) => path !== gone));
    const { code, err } = judge(readings({ code: short }));
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("held at a size are not on disk");
    expect(err.join("\n")).toContain(gone);
  });

  test("a held file that changed size is 1, in whichever direction", () => {
    const path = [...SPAWN_ONLY.keys()][0]!;

    for (const drift of [+1, -1]) {
      const { code, err } = judge(
        readings({ code: new Map([...RECORDED_SIZES, [path, SPAWN_ONLY.get(path)!.lines + drift]]) }),
      );
      expect(code).toBe(1);
      expect(err.join("\n")).toContain(drift > 0 ? "grew " : "shrank ");
    }
  });

  test("absence is reported before the floor, and shuts it out", () => {
    // The ordering `verdict` is built around: a file no test loads has no
    // percentage, so reporting the floor first would mean reporting a number
    // that does not exist. Both faults are present here; only one is shown.
    const { err } = judge(
      readings({ lcov: [record("scripts/check-coverage.ts", [[1, 0], [2, 0]]), ""].join("\n") }),
    );
    expect(err.join("\n")).toContain("no test ever loads");
    expect(err.join("\n")).not.toContain("line floor");
  });

  test("a hole in the gate is reported before a number that drifted", () => {
    // Both faults, one run. The unwatched file wins: a size that moved is a
    // fact to write down, while a file nothing asks about is the gate itself
    // having a gap, and the gap is what the next person needs to see.
    const path = [...SPAWN_ONLY.keys()][0]!;
    const { err } = judge(
      readings({
        scripts: [...REGISTERED, "scripts/new.sh"],
        code: new Map([...RECORDED_SIZES, [path, SPAWN_ONLY.get(path)!.lines + 1]]),
      }),
    );
    expect(err.join("\n")).toContain("nothing asks anything about");
    expect(err.join("\n")).not.toContain("changed size without");
  });
});

describe("measuring — the one function here that starts another process", () => {
  test("a command that fails is not a measurement, and the tail is kept", async () => {
    const result = await measure(() => ["bash", "-c", "echo boom >&2; exit 3"]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.why).toContain("fix the tests first");
    expect(result.ok === false && result.why).toContain("boom");
  });

  test("a command that passes and writes nothing is not a measurement either", async () => {
    // The shape that would otherwise be the worst outcome in the file: an
    // empty parse reads as "no file is below the floor", and the gate prints
    // a green line over a suite it never measured.
    const result = await measure(() => ["bash", "-c", "exit 0"]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.why).toContain("no lcov.info");
  });

  test("a command that writes a report hands the report back", async () => {
    const result = await measure((dir) => [
      "bash",
      "-c",
      `printf 'SF:src/a.ts\\nDA:1,1\\nLF:1\\nLH:1\\nend_of_record\\n' > "${dir}/lcov.info"`,
    ]);
    expect(result.ok).toBe(true);
    expect(result.ok === true && parseLcov(result.lcov).get("src/a.ts")).toEqual({
      found: 1,
      hit: 1,
      missed: [],
    });
  });

  test("the report directory is outside the repository, and is gone either way", async () => {
    // `coverage/` is not in .gitignore, and a gate that dirties the working
    // tree every time it runs teaches people to ignore `git status`.
    const seen: string[] = [];
    for (const script of ["exit 0", "exit 1"]) {
      await measure((dir) => {
        seen.push(dir);
        return ["bash", "-c", script];
      });
    }
    expect(seen).toHaveLength(2);
    for (const dir of seen) {
      expect(dir.startsWith(ROOT), dir).toBe(false);
      expect(await stat(dir).then(() => true, () => false), `${dir} survived`).toBe(false);
    }
  });

  test("the real command is not reachable from here, which is the guard", async () => {
    // There is no default and no export of it: the only name for `bun test
    // --coverage` is inside `main`. Stated as an assertion over the text so
    // that adding a default later fails here rather than forking the suite.
    const source = await readFile(SCRIPT, "utf8");
    expect(source).toContain("const SUITE = (coverageDir: string)");
    expect(source).not.toContain("export const SUITE");
    expect(source).toMatch(/command: \(coverageDir: string\) => readonly string\[\],/);
  });
});

describe("reading the tree", () => {
  test("allFiles sees what sourceFiles cannot, which is the point of having both", async () => {
    const every = (await allFiles(join(ROOT, "scripts"))).map((path) => relative(ROOT, path)).sort();
    const typescript = (await sourceFiles(join(ROOT, "scripts"))).map((path) => relative(ROOT, path));

    expect(every).toContain("scripts/demo-bare-container.sh");
    expect(typescript).not.toContain("scripts/demo-bare-container.sh");
    expect(every.length).toBeGreaterThan(typescript.length);
  }, 30_000);

  test("readFiles gives the three numbers, and hashes only what PROOFS names", async () => {
    const proved = [...PROOFS.keys()][0]!;
    const { code, lines, digests } = await readFiles([proved, "scripts/check-coverage.ts"]);

    expect(code.get(proved)).toBeGreaterThan(0);
    expect(lines.get(proved)).toBeGreaterThan(code.get(proved)!);
    expect(digests.get(proved)).toBe(PROOFS.get(proved)!.sha256);
    // Hashing src/ would cost little and mean nothing, so it is not done.
    expect(digests.has("scripts/check-coverage.ts")).toBe(PROOFS.has("scripts/check-coverage.ts"));
  });

  test("sha256 is sha256, against a value that does not come from this file", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("the scripts/ registry is still true of the folder", () => {
  test("every file under scripts/ is asked exactly one question, by name", async () => {
    // G4-1, checked against the tree rather than against the list. A file
    // arriving here with no question is red — on this assertion if it is not
    // TypeScript, and on the 85% floor if it is.
    const files = (await allFiles(join(ROOT, "scripts"))).map((path) => relative(ROOT, path));
    expect(files.length).toBeGreaterThan(0);

    const { unasked, stray, stale } = scriptsVerdict(
      files,
      (await readFiles(files)).digests,
      PROVED_OTHERWISE,
      PROOFS,
    );
    expect(unasked, "a file under scripts/ that nothing asks anything about").toEqual([]);
    expect(stray, "a question or a proof about a file that is not there").toEqual([]);
    expect(stale, "a file edited after the run that proved it").toEqual([]);
  });

  test("scripts/ still has a file on the floor, so the floor over it is not vacuous", async () => {
    // If every file here were proved otherwise, the 85% floor would apply to
    // nothing in this folder and the registry would be a list of excuses.
    const onFloor = (await allFiles(join(ROOT, "scripts")))
      .map((path) => relative(ROOT, path))
      .filter((rel) => rel.endsWith(".ts") && !PROVED_OTHERWISE.has(rel));
    expect(onFloor).toEqual(["scripts/check-coverage.ts"]);
  });

  test("every question names a test that exists and runs on every bun test", async () => {
    // A question is only asked if something asks it. A `by` pointing at a file
    // that is gone is the same fault as a `why` that is no longer true.
    expect(PROVED_OTHERWISE.size).toBeGreaterThan(0);
    for (const [rel, asked] of PROVED_OTHERWISE) {
      expect(rel.startsWith("scripts/"), rel).toBe(true);
      expect(asked.question.length, rel).toBeGreaterThan(20);
      expect(asked.why.length, rel).toBeGreaterThan(40);
      expect(asked.by, rel).toMatch(/^test\/.*\.test\.ts$/);
      expect(await Bun.file(join(ROOT, asked.by)).exists(), asked.by).toBe(true);
    }
  });

  test("no file is on two lists, and no list reaches outside the folder it is for", () => {
    for (const rel of PROVED_OTHERWISE.keys()) {
      expect(EXEMPT.has(rel), rel).toBe(false);
      expect(SPAWN_ONLY.has(rel), rel).toBe(false);
    }
    for (const rel of SPAWN_ONLY.keys()) expect(PROVED_OTHERWISE.has(rel), rel).toBe(false);
  });

  test("every proof is about a file that has a question, and says how it was run", () => {
    // A proof of a file nobody asks about is a record with no reader. The
    // record has to carry enough to be re-run by hand, or it is a date.
    expect(PROOFS.size).toBeGreaterThan(0);
    for (const [rel, proof] of PROOFS) {
      expect(PROVED_OTHERWISE.has(rel), rel).toBe(true);
      expect(proof.sha256, rel).toMatch(/^[0-9a-f]{64}$/);
      expect(proof.provedOn, rel).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(proof.by.length, rel).toBeGreaterThan(10);
      expect(proof.result.length, rel).toBeGreaterThan(5);
    }
  });

  test("the sp1 survey is gone, and nothing still claims to watch it", () => {
    // It was the lowest-coverage file in scripts/ and the widest surface this
    // repository had on I-3 and I-6 — the only code in it that read the
    // owner's real transcripts. Its note stayed; see test/notes/.
    for (const rel of [...PROVED_OTHERWISE.keys(), ...PROOFS.keys()]) {
      expect(rel).not.toContain("sp1");
    }
  });
});
