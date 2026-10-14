#!/usr/bin/env bun
/**
 * odd2 — the probes that cannot live inside `bun test`.
 *
 *     npm exec -- bun run notes/odd2-driver.ts
 *
 * Everything in `test/odd2/free-pass.test.ts` is a function call or one short
 * CLI run. The questions here are a different kind: *what does a guard say when
 * the thing it guards has been taken away?* Answering that means running `bun
 * test` — and a test that starts `bun test` is how this repository once got a
 * fork bomb, so G4-3 keeps those out of the suite and puts them here instead.
 *
 * ## The real tree is never touched
 *
 * Every run below happens in a `mkdtemp` copy built from `git ls-files`, with
 * `node_modules` symlinked in. The mutation is applied to the **copy**. The
 * checkout this is run from is read and never written, so a driver killed
 * half-way leaves no mutation on disk — which is a thing that has happened here
 * before, and is the reason it is written down.
 *
 * ## The driver's own controls
 *
 * A driver that hunts checks which pass without looking must not be one. So:
 *
 *  - an **unmutated** copy must run the same test green, with a test count
 *    above zero;
 *  - the **mutated** copy must turn that same file red, which is what proves
 *    the mutation reaches the assertions rather than merely breaking an import;
 *  - every run is parsed for `Ran N tests`. **N = 0 is a driver failure**, not
 *    a green run — a suite that matched no file is the free pass this whole
 *    task is about, and it is the one shape a runner reports as success.
 *
 * The driver exits 1 if any control does not behave, or if any run executed no
 * tests where tests were expected. A row whose result differs from the
 * prediction registered beside it is printed as a miss and is not a failure:
 * the predictions were written before anything was measured, and some of them
 * are wrong. `notes/odd2-free-pass-survey.md` records which.
 */

import { cp, mkdir, mkdtemp, readdir, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const BUN = process.execPath;

/** Everything that has to be cleaned up, whatever happens. */
const scratch: string[] = [];

// ---------------------------------------------------------------------------
// Running things
// ---------------------------------------------------------------------------

interface Ran {
  readonly code: number;
  readonly out: string;
  readonly ms: number;
}

async function run(argv: readonly string[], cwd: string, timeoutMs = 900_000): Promise<Ran> {
  const started = Date.now();
  const child = Bun.spawn([...argv], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const kill = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await child.exited;
    return { code: child.exitCode ?? -1, out: `${out}\n${err}`, ms: Date.now() - started };
  } finally {
    clearTimeout(kill);
  }
}

/** What a `bun test` run reported about itself. `ran` is `undefined` when it said nothing. */
interface Suite {
  readonly code: number;
  readonly pass: number;
  readonly fail: number;
  /** `undefined` when no `Ran N tests` line was printed at all. */
  readonly ran: number | undefined;
  readonly ms: number;
  /** First failing test name, when there is one — the reason, not just the colour. */
  readonly firstFailure: string | undefined;
  readonly out: string;
}

function readSuite({ code, out, ms }: Ran): Suite {
  const number = (pattern: RegExp): number => Number(pattern.exec(out)?.[1] ?? 0);
  const ranMatch = /Ran (\d+) tests?/.exec(out);
  const failure = /\(fail\)\s+(.+)/.exec(out);
  return {
    code,
    pass: number(/(\d+) pass/),
    fail: number(/(\d+) fail/),
    ran: ranMatch === null ? undefined : Number(ranMatch[1]),
    ms,
    firstFailure: failure?.[1]?.trim(),
    out,
  };
}

// ---------------------------------------------------------------------------
// The copy, and the mutations applied to it
// ---------------------------------------------------------------------------

/**
 * A copy of the tree as git knows it, with `node_modules` symlinked.
 *
 * Tracked files only: `git ls-files` leaves out `dist/`, `coverage/` and any
 * scratch a previous run left lying about, so the copy is what a fresh clone
 * would be rather than what this working directory happens to hold.
 */
async function checkout(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `mind-odd2-${label}-`));
  scratch.push(dir);

  const listed = await run(["git", "ls-files", "-z"], ROOT, 60_000);
  if (listed.code !== 0) throw new Error(`git ls-files failed: ${listed.out}`);
  const files = listed.out.split("\0").filter((path) => path !== "" && !path.startsWith("\n"));
  if (files.length < 100) throw new Error(`git ls-files reported only ${files.length} file(s)`);

  for (const rel of files) {
    const to = join(dir, rel);
    await mkdir(dirname(to), { recursive: true });
    await cp(join(ROOT, rel), to);
  }
  await symlink(join(ROOT, "node_modules"), join(dir, "node_modules"));
  return dir;
}

/** Remove every file under `dir`, keeping the directory itself. */
async function empty(dir: string): Promise<number> {
  let removed = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      removed += await empty(path);
      await rm(path, { recursive: true, force: true });
    } else {
      await unlink(path);
      removed += 1;
    }
  }
  return removed;
}

/** Replace exactly one string in one file of the copy, refusing a no-op. */
async function substitute(copy: string, rel: string, from: string, to: string): Promise<void> {
  const path = join(copy, rel);
  const text = await Bun.file(path).text();
  const parts = text.split(from);
  if (parts.length !== 2) {
    throw new Error(`${rel}: expected exactly one occurrence of ${JSON.stringify(from)}, found ${parts.length - 1}`);
  }
  await Bun.write(path, parts.join(to));
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

interface Row {
  readonly id: string;
  /** What is being asked, in one line. */
  readonly target: string;
  /** What was taken away. */
  readonly mutation: string;
  /** Tests executed, or a note where the question is not about a test run. */
  readonly ran: string;
  /** What happened. */
  readonly result: string;
  /** What was predicted before anything was run. */
  readonly predicted: string;
  readonly match: boolean;
}

const rows: Row[] = [];
const problems: string[] = [];

function record(row: Row): void {
  rows.push(row);
  const mark = row.match ? "  " : "!!";
  console.log(
    `${mark} ${row.id.padEnd(6)} ${row.ran.padEnd(12)} ${row.result.padEnd(46)} ${row.target}`,
  );
  if (!row.match) console.log(`          predicted: ${row.predicted}`);
}

/** A suite run that executed no tests is a driver failure, never a pass. */
function demandTests(id: string, suite: Suite): void {
  if (suite.ran === undefined || suite.ran === 0) {
    problems.push(`${id}: the run executed ${suite.ran ?? "no reported number of"} tests`);
  }
}

// ---------------------------------------------------------------------------
// The probes
// ---------------------------------------------------------------------------

const NO_VENDOR = "test/agent/no-vendor.test.ts";
/** The one test in that file with no minimum-count floor on what it scanned. */
const FLOORLESS = "nothing under src/agent/ can reach src/exec/, at any depth";

async function controlUnmutated(): Promise<void> {
  const copy = await checkout("control");
  const suite = readSuite(await run([BUN, "test", NO_VENDOR], copy));
  demandTests("D-C1", suite);
  const green = suite.code === 0 && suite.fail === 0;
  if (!green) problems.push(`D-C1: an unmutated copy could not run ${NO_VENDOR} green`);
  record({
    id: "D-C1",
    target: `control — an unmutated copy runs ${NO_VENDOR}`,
    mutation: "none",
    ran: `${suite.ran ?? 0} test(s)`,
    result: green ? `green in ${suite.ms}ms` : `RED (${suite.firstFailure ?? "?"})`,
    predicted: "green",
    match: green,
  });
}

async function agentEmptied(): Promise<void> {
  const copy = await checkout("agent");
  const removed = await empty(join(copy, "src", "agent"));

  // The control and the probe are the same mutation, which is what makes the
  // pair worth anything: the file has to go red, and the one test inside it
  // with no floor has to go green, on the same tree.
  const whole = readSuite(await run([BUN, "test", NO_VENDOR], copy));
  demandTests("D-C2", whole);
  const wentRed = whole.fail > 0;
  if (!wentRed) {
    problems.push(`D-C2: emptying src/agent/ did not turn ${NO_VENDOR} red — the mutation is not reaching the assertions`);
  }
  record({
    id: "D-C2",
    target: `control — the mutation reaches the assertions in ${NO_VENDOR}`,
    mutation: `src/agent/ emptied (${removed} file(s) removed in the copy)`,
    ran: `${whole.ran ?? 0} test(s)`,
    result: wentRed ? `RED — ${whole.fail} fail: ${whole.firstFailure ?? "?"}` : "green (the mutation was invisible)",
    predicted: "red",
    match: wentRed,
  });

  const one = readSuite(await run([BUN, "test", NO_VENDOR, "-t", FLOORLESS], copy));
  demandTests("D-P1", one);
  const freePass = one.code === 0 && one.fail === 0 && (one.ran ?? 0) > 0;
  record({
    id: "D-P1",
    target: `the floorless guard alone: \`-t "${FLOORLESS}"\``,
    mutation: "src/agent/ emptied",
    ran: `${one.ran ?? 0} test(s)`,
    result: freePass
      ? "GREEN over a closure of 0 files — free pass"
      : `red (${one.firstFailure ?? "?"})`,
    predicted: "green — a free pass",
    match: freePass,
  });
}

async function ledgerEmptied(): Promise<void> {
  const copy = await checkout("ledger");
  const removed = await empty(join(copy, "src", "ledger"));
  const suite = readSuite(await run([BUN, "test", "test/ledger/local-only.test.ts"], copy));

  // The interesting part is *why* it is red, not that it is. This file imports
  // `src/ledger/index.ts`, so an emptied directory takes the module down before
  // a single assertion runs — which means the free pass in its scan is real and
  // out of reach at the same time, and what puts it out of reach is an import
  // written for another purpose rather than a floor.
  const unresolved = /Could not resolve|Cannot find module|error: .*src[/\\]ledger/.test(suite.out);
  record({
    id: "D-P2",
    target: "test/ledger/local-only.test.ts — the same floorless scan, one directory over",
    mutation: `src/ledger/ emptied (${removed} file(s) removed in the copy)`,
    ran: `${suite.ran ?? 0} test(s)`,
    result: unresolved
      ? `RED at import, before any assertion ran (${suite.pass} pass / ${suite.fail} fail)`
      : `${suite.fail} fail / ${suite.pass} pass — ${suite.firstFailure ?? "?"}`,
    predicted: "red at import — the file cannot load without src/ledger/index.ts",
    match: unresolved,
  });
  if (!unresolved) console.log(`          ${suite.out.trim().split("\n").slice(-4).join(" / ")}`);
}

async function registryEmptied(
  id: string,
  label: string,
  rel: string,
  from: string,
  to: string,
  predicted: string,
): Promise<string> {
  const copy = await checkout(id.toLowerCase());
  await substitute(copy, rel, from, to);

  const types = await run([join(copy, "node_modules", ".bin", "tsc"), "--noEmit"], copy, 600_000);
  const suite = readSuite(await run([BUN, "test"], copy));
  demandTests(id, suite);

  // `tsc` is the half that changed with fix2. Both of these registries are
  // `NonEmpty` now, so `= []` does not compile — the mutation is still applied
  // and the suite still runs, because bun strips types rather than checking
  // them, and the row is worth more with both numbers in it than with one.
  const typechecks = types.code === 0;
  const result =
    `tsc ${typechecks ? "CLEAN — the type does not refuse this" : `refused (exit ${types.code})`} · ` +
    `${suite.fail} fail / ${suite.pass} pass in ${Math.round(suite.ms / 1000)}s`;
  record({
    id,
    target: `${label} — does anything, anywhere, go red?`,
    mutation: `${rel}: ${label} = []`,
    ran: `${suite.ran ?? 0} test(s)`,
    result,
    predicted,
    // Both halves now. Before fix2 the only signal was a red suite somewhere,
    // which is a loud answer nobody hears before a type error — `tsc` refusing
    // is the one that arrives first.
    match: suite.fail > 0 && !typechecks,
  });
  if (suite.fail > 0) {
    console.log(`          first failure: ${suite.firstFailure ?? "?"}`);
  }
  return copy;
}

/**
 * The question `DERIVATIONS = []` was actually asked for: does `.mind/` report
 * itself **fresh** when the engine builds nothing?
 *
 * `derivedStatus` compares two sorted lists of derivation ids by joining them, and
 * `"" === ""` — so an engine with no derivations agrees with a manifest that
 * recorded none, walks an empty artefact list, and returns `fresh`. That the
 * suite goes red elsewhere is a different fact; this is the one the row is
 * about, and it is asked end to end through the CLI a person would type.
 */
async function freshOverNothing(copy: string): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), "mind-odd2-derived-"));
  const home = await mkdtemp(join(tmpdir(), "mind-odd2-derived-home-"));
  scratch.push(parent, home);
  const cli = [BUN, "run", join(copy, "bin", "mind.ts")];

  const made = await run([...cli, "new", "probe", "--subject", "probe", "--dir", parent], home, 120_000);
  const agent = join(parent, "probe");
  const built = await run([...cli, "rebuild", agent, "--subject", "probe"], home, 120_000);
  const checked = await run([...cli, "rebuild", agent, "--subject", "probe", "--check"], home, 120_000);

  const fresh = checked.code === 0 && /fresh/.test(checked.out);
  const overZero = /\b0 artefact\(s\)/.test(checked.out);
  record({
    id: "D-P4b",
    target: "`mind rebuild --check` on an engine that derives nothing (tsc refused this tree)",
    mutation: "src/agent/derive.ts: DERIVATIONS = []",
    ran: `new ${made.code} · build ${built.code}`,
    result:
      fresh && overZero
        ? "exit 0, `fresh — 0 artefact(s) match` — unchanged, and now unreachable"
        : `exit ${checked.code} · ${checked.out.trim().split("\n")[0] ?? ""}`,
    // Still the same answer at run time, and that is the honest report: fix2
    // closed this at the compiler (`DERIVATIONS: NonEmpty<Derivation>`), not in
    // `derivedStatus`. bun strips types rather than checking them, so this row
    // reaches a state `npm run typecheck` refuses — see D-P4's `tsc` column.
    // Written down rather than quietly dropped: a guard that lives in the type
    // is a guard somebody can get past by not running the typechecker.
    predicted: "fresh over 0 artefacts — unchanged at run time, refused at compile time",
    match: fresh && overZero,
  });
}

/**
 * The headwater: what a test runner says when its filter matches no file.
 *
 * Every gate in this repository stands on `bun test` exiting non-zero when
 * something is wrong. If a filter that matches nothing exits 0, then a typo in
 * a CI line is a green build over an empty run.
 */
async function noSuchTests(): Promise<void> {
  const copy = await checkout("nofilter");
  const ran = await run([BUN, "test", "test/there-is-no-such-directory"], copy, 120_000);
  const suite = readSuite(ran);
  const refused = ran.code !== 0;
  record({
    id: "D-P5",
    target: "`bun test <a path that matches no file>` — the headwater of every gate",
    mutation: "none — the filter matches nothing",
    ran: `${suite.ran ?? 0} test(s)`,
    result: refused ? `exit ${ran.code} — refused` : `exit 0 over ${suite.ran ?? 0} tests — free pass`,
    predicted: "unknown — this is the measurement",
    match: true,
  });
}

/** Both sides of the parity harness pointed at the same empty directory. */
async function parityOverNothing(): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "mind-odd2-parity-base-"));
  const head = await mkdtemp(join(tmpdir(), "mind-odd2-parity-head-"));
  const work = await mkdtemp(join(tmpdir(), "mind-odd2-parity-work-"));
  scratch.push(base, head, work);

  const ran = await run(
    [
      BUN,
      "run",
      join(ROOT, "scripts", "cli-parity.ts"),
      "--base",
      base,
      "--head",
      head,
      "--only",
      "02-unknown",
      "--work",
      work,
    ],
    ROOT,
    300_000,
  );
  const freePass = /PARITY-OK/.test(ran.out);
  const refused = ran.code === 3 && /PARITY-UNDECIDED/.test(ran.out);
  record({
    id: "D-P6",
    target: "cli-parity with two empty directories — two engines that agree about nothing",
    mutation: "--base and --head both point at an empty directory",
    ran: "n/a",
    result: refused
      ? "exit 3 · PARITY-UNDECIDED — refused, not judged"
      : `exit ${ran.code}${freePass ? " · printed PARITY-OK — free pass" : ""}`,
    // Rewritten when fix2 closed this row. The original prediction, registered
    // before anything was measured, was `PARITY-OK — both sides fail
    // identically`, and it was right: that is what the harness printed. What
    // this row asks now is the opposite question, because the answer became a
    // thing worth guarding rather than a thing worth reporting.
    predicted: "exit 3 · PARITY-UNDECIDED (fix2) — a comparison that did not happen is not an OK",
    match: refused,
  });
  if (!refused) {
    console.log(`          it did not refuse: ${ran.out.trim().split("\n").slice(-3).join(" / ")}`);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  console.log("odd2 driver — the probes that cannot live inside `bun test`");
  console.log(`root: the checkout this was run from, read-only · bun ${Bun.version}`);
  console.log();
  console.log("   id     tests        result                                         target");

  try {
    await controlUnmutated();
    await agentEmptied();
    await ledgerEmptied();
    await noSuchTests();
    await parityOverNothing();
    await registryEmptied(
      "D-P3",
      "VENDORS",
      "src/exec/registry.ts",
      // `NonEmpty<VendorSpec>` since fix2, which is what this row now measures:
      // the mutation below is a type error, and `substitute` refusing a needle
      // that no longer matches is how the driver said so the first time.
      "export const VENDORS: NonEmpty<VendorSpec> = [CLAUDE, CODEX, GROK, GEMINI, COPILOT, KIMI];",
      "export const VENDORS: NonEmpty<VendorSpec> = [];\n" +
        "export const ODD2_PARKED_VENDORS: readonly VendorSpec[] = [CLAUDE, CODEX, GROK, GEMINI, COPILOT, KIMI];",
      "tsc refuses it (fix2: VENDORS is NonEmpty); the suite also goes red in doctor/index",
    );
    const derivationless = await registryEmptied(
      "D-P4",
      "DERIVATIONS",
      "src/agent/derive.ts",
      "export const DERIVATIONS: NonEmpty<Derivation> = [",
      "export const DERIVATIONS: NonEmpty<Derivation> = [];\n" +
        "export const ODD2_PARKED_DERIVATIONS: readonly Derivation[] = [",
      "tsc refuses it (fix2: DERIVATIONS is NonEmpty); the suite also goes red somewhere",
    );
    await freshOverNothing(derivationless);
  } finally {
    for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  }

  console.log();
  const missed = rows.filter((row) => !row.match);
  console.log(
    `${rows.length} row(s) · ${rows.length - missed.length} matched the prediction, ${missed.length} did not.`,
  );
  for (const row of missed) console.log(`  ${row.id}: predicted ${row.predicted}, got ${row.result}`);

  if (problems.length > 0) {
    console.log();
    console.log("driver failures — these say nothing about the engine, only that this tool did not work:");
    for (const problem of problems) console.log(`  ${problem}`);
    return 1;
  }

  console.log();
  console.log("the checkout was read and never written; every mutation happened in a temporary copy.");
  return 0;
}

process.exit(await main());
