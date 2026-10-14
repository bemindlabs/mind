/**
 * odd2 — the free pass, asked of every checker in this repository at once.
 *
 * One question, put to everything that decides a pass: **if the thing it checks
 * were missing entirely, or had never existed, what would it say?** Five real
 * bugs on 2026-09-21 had that shape — `doctor` printing `ok clean · 0 file(s)`
 * from the compiled binary, where `import.meta.dir` resolves inside the
 * executable and the walk read nothing at all.
 *
 * This file is the measured half of `notes/odd2-free-pass-survey.md`. Every row
 * in that report points at a test here, at a row printed by
 * `notes/odd2-driver.ts`, or says in plain words that it was not measured.
 *
 * ## Two shapes, and the difference is deliberate
 *
 * A checker that holds gets an **ordinary assertion**. It stays on as a
 * permanent regression guard, and it goes red the day somebody removes the
 * guard clause that makes it hold.
 *
 * A proven hole got **`test.failing`**, with the assertion written the way the
 * checker *should* behave. The suite therefore stayed green while odd2 fixed
 * nothing, and each of those went red on the day somebody repaired it, which is
 * the one moment a reader needs to be told that a label can come off. The first
 * `describe` below proves `test.failing` really has that behaviour in the bun
 * this suite runs under, rather than assuming it.
 *
 * ## All of them are ordinary tests now, and four are not the tests they were
 *
 * fix1 closed H1 and H2; fix2 closed the rest. Two `test.failing`s remain and
 * they are permanent — they are the controls on the instrument, not holes.
 *
 * The part worth reading before trusting any of this: **four of the seven
 * `test.failing` assertions were wrong about what the repair should be**, and
 * the repair went where the danger was rather than where the probe pointed.
 *
 * - H3 asked for `plan.git === null` over a directory that is no repository.
 *   The dangerous case is the mirror of it — a repository *with* history and a
 *   remote that git refuses to read — and `null` is the value `--no-agent` uses.
 * - H4 asked for `stable: false`. That is the claim that a backend was asked
 *   and wavered, over one that was never asked at all: ADR 0001 §2's `silent`
 *   collapsed into `failed`.
 * - H7 asked for a non-zero exit over an empty index. The reachable way to get
 *   one is a commit that only deletes files, and blocking those teaches people
 *   `--no-verify`. The filter that was really dropping bytes was `ACMR`
 *   swallowing typechanges.
 * - H10 asked for `ok: false` when nothing is written. Writing nothing is the
 *   ordinary result of applying twice, and the only result on a machine whose
 *   one backend is ollama.
 *
 * Each of those rewrites is a moved goalpost unless somebody watched the new
 * assertion fail first. Every one of them was run red against the unrepaired
 * engine before the repair landed, and the reasoning for each rejection is
 * written beside the test rather than carried in a commit message.
 *
 * ## What these probes are not allowed to do
 *
 * No real `HOME`, no vendor CLI, no socket, no push, synthetic fixtures only.
 * Every home here is a `mkdtemp` under `$TMPDIR` and is removed afterwards; the
 * two hosts handed to `doctor` are ports nothing listens on, and the seam is
 * stubbed anyway, so neither is dialled. Nothing here fixes anything.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DERIVATIONS } from "../../src/agent/derive.ts";
import { derivedStatus } from "../../src/agent/rebuild.ts";
import {
  blockers,
  runDoctor,
  type DoctorEnv,
  type DoctorReport,
  type Finding,
} from "../../src/doctor.ts";
import {
  CERTIFICATE_SCHEMA,
  certificate,
  commitErase,
  formatCertificate,
  planErase,
  searchTree,
  verifyErase,
  type EraseEnv,
  type ErasePlan,
  type EraseResult,
  type EraseVerification,
} from "../../src/erase/index.ts";
import type { ExecBackend } from "../../src/exec/backend.ts";
import { FallbackExec } from "../../src/exec/fallback.ts";
import { isProjectScopedOnly, PHASE_A_BACKENDS, VENDORS } from "../../src/exec/registry.ts";
import { historyFacts } from "../../src/guard/history.ts";
import { hookStatus } from "../../src/guard/hooks.ts";
import { scanStaged } from "../../src/guard/scan.ts";
import { stagedDeletions, stagedFiles } from "../../src/guard/staged.ts";
import { auditClears } from "../../src/observer/audit.ts";
import { commitApply, planApply, type ApplyEnv } from "../../src/soul/apply.ts";
import { isolationHeld } from "../../src/soul/isolation.ts";
import { loadSoul } from "../../src/soul/load.ts";
import { resolveTargets } from "../../src/soul/targets.ts";
import { levelFor, verifyPasses, verifySoul, type VerifyReport } from "../../src/soul/verify.ts";
import { wearsOnly, wornReport } from "../../src/soul/worn.ts";
import { subjectId, type NonEmpty } from "../../src/types.ts";
import { judge, sizeVerdict, verdict, type Readings } from "../../scripts/check-coverage.ts";
import { BUN } from "../support/bare-path.ts";
import { git, GIT_ENV } from "../support/trap-git.ts";
import { SOUL_A, writeSoul } from "../support/synthetic-soul.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");

/** A port nothing listens on, so a probe that dialled one would hang, not lie. */
const DEAD_OLLAMA = "http://127.0.0.1:59996";
/** A second one, for the store. Both seams are stubbed; neither is reached. */
const DEAD_QDRANT = "http://127.0.0.1:59995";

const scratch: string[] = [];

afterAll(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// 0. The control this whole file rests on
// ---------------------------------------------------------------------------

/** Set inside the control's failing body, read by the test after it. */
let failingBodyRan = false;
/** The same, for an async body — set only after an `await` has resumed. */
let asyncFailingFinished = false;

describe("odd2 control — can this suite pin a hole without going red?", () => {
  test("`test.failing` exists in the bun this suite runs under", () => {
    // Asserted rather than assumed: without it, every `test.failing` below
    // would be a silently skipped test, which is the same shape odd2 hunts.
    expect(typeof (test as unknown as { failing?: unknown }).failing).toBe("function");
  });

  test.failing("a body that fails is counted as a pass by `test.failing`", () => {
    // If bun ever stops honouring this, this line starts *passing*, `test.failing`
    // reports a pass where it expected a failure, and the suite goes red — which
    // is exactly the notice a reader needs before trusting the ones below.
    failingBodyRan = true;
    expect("this assertion is meant to fail").toBe("and it does");
  });

  test("and that body really ran — `test.failing` is not a skip in disguise", () => {
    // The control the control needed. A `test.failing` that quietly skipped its
    // body would report a pass for every hole below without executing one line
    // of them, which is the free pass this whole file is about — wearing the
    // costume of the instrument that hunts it.
    expect(failingBodyRan).toBe(true);
  });

  test.failing("an async body that fails after an await is a pass too", async () => {
    // The second half of the same question, and the one that decides how the
    // probes below are written: several of them have to spawn a process before
    // they can assert anything. If an async `test.failing` body were not
    // awaited, every one of those would report a pass without its assertion
    // ever being reached.
    await Bun.sleep(50);
    asyncFailingFinished = true;
    expect("this one fails after an await").toBe("and it still has to be awaited");
  });

  test("and the async body was awaited before the next test began", () => {
    expect(asyncFailingFinished).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1. I-4 — a withdrawal certified over nothing
// ---------------------------------------------------------------------------

/** Plan, commit and verify an erase of a subject that has never existed. */
async function eraseNobody(): Promise<{
  readonly plan: ErasePlan;
  readonly result: EraseResult;
  readonly verification: EraseVerification;
}> {
  const home = await sandbox("mind-odd2-erase-");
  const env: EraseEnv = {
    home,
    env: { HOME: home, XDG_STATE_HOME: join(home, "state"), XDG_DATA_HOME: join(home, "data") },
    now: () => new Date("2026-09-22T00:00:00.000Z"),
  };
  const plan = await planErase(env, {
    subject: subjectId("never-existed"),
    // `--no-agent`, which the CLI offers by name.
    agentDir: null,
    scope: "all",
    by: "odd2 probe",
    needles: [],
    instructionFiles: [],
    soulName: null,
    personalValues: [],
  });
  const result = await commitErase(plan);
  return { plan, result, verification: await verifyErase(plan, result) };
}

/** Regular files whose bytes a verification pass actually read. */
function filesRead(verification: EraseVerification): number {
  return verification.search.scopes.reduce((total, scope) => total + scope.filesRead, 0);
}

describe("I-4 — `erase` certifies a subject that was never there", () => {
  // Closed by fix1. The four probes below were `test.failing` when this file
  // was written — each one pinned a hole with the assertion the checker *should*
  // satisfy, and each went red the day it was repaired, which is the moment
  // they were built for. They are ordinary tests now, and they stay: what pinned
  // the hole is what guards against its return.
  //
  // What the repair is **not**: a rule keyed on `filesRead === 0`. That number
  // turns all four of these green and leaves the dangerous case wide open — see
  // the last test in this block, and `test/erase/plan.test.ts` for the same
  // measurement with the other subject's bytes compared before and after.

  test("the run reads no file at all — the number the verdict must not rest on", async () => {
    // The measurement, stated on its own so that the tests below are read
    // against a number rather than against a suspicion. Nothing existed, so
    // nothing was walked: every scope came back with zero files read.
    const { plan, verification } = await eraseNobody();
    expect(plan.refusals).toEqual([]);
    expect(filesRead(verification)).toBe(0);
    expect(verification.search.deletableHits).toBe(0);
    expect(verification.remainingFiles).toBe(0);
  });

  test("a verdict is not `erased-and-verified` when nothing was read", async () => {
    // I-4 is the promise that an owner can always withdraw. `verifyErase` had
    // three arms — remaining files, failed deletions, hits — and every one of
    // them is a count that reads zero for "clean" and zero for "never looked".
    // There was no fourth arm for "could not look", so the absence of evidence
    // was returned as evidence of absence, over a subject this machine has never
    // heard of. ADR 0001 §2 is the rule that was being broken: `silent` is not
    // `failed`, and "nothing was scanned" is not "nothing is there".
    //
    // The fourth arm now exists and it is not about reading: nothing was found
    // before and nothing was removed, so there is no erasure to certify.
    const { verification } = await eraseNobody();
    expect(verification.verdict).not.toBe("erased-and-verified");
    expect(verification.verdict).toBe("nothing-found");
    expect(verification.found.total).toBe(0);
    expect(verification.removed.total).toBe(0);
  });

  test("the certificate says how much was read, not only what was found", async () => {
    // `EraseVerification` knew `filesRead` per scope and the certificate dropped
    // it: `verification.ran` is true whenever the function was *called*, and the
    // four numbers beside it were all zero on a clean run and on an empty one.
    // A reader holding that document could not tell the two apart.
    const { plan, result, verification } = await eraseNobody();
    const cert = certificate({
      plan,
      result,
      verification,
      observedAccount: "odd2",
      engine: "0.0.0",
      issuedAt: "2026-09-22T00:00:00.000Z",
    });
    expect(cert.verification.ran).toBe(true);
    expect(Object.keys(cert.verification)).toContain("filesRead");
    expect(cert.verification.filesRead).toBe(0);
    // And the document says in words what that zero can mean, rather than
    // leaving a reader to infer "it is gone" from a row of zeros.
    expect(cert.statement.join("\n")).toContain("NOTHING WAS ERASED");
  });

  test("and the same hole does not reopen under `filesRead > 0`", async () => {
    // The case a rule keyed on "nothing was read" would wave straight through,
    // and the one that actually costs somebody their data: an id mistyped by a
    // character, on a machine that holds a real subject under the correct
    // spelling. Files are read, nothing is found, nothing is removed — and the
    // verdict has to be the same `nothing-found`, not a certificate.
    const home = await sandbox("mind-odd2-erase-typo-");
    // Under the state root, so the search really reads it. Its subject id is
    // one character away from the one being erased, and it is never named in
    // any output — only counted.
    await Bun.write(
      join(home, "state", "mind", "ledger", "never-existed-2", "turns.jsonl"),
      `{"subject":"never-existed-2","prompt":"a real person's words"}\n`,
    );
    const env: EraseEnv = {
      home,
      env: { HOME: home, XDG_STATE_HOME: join(home, "state"), XDG_DATA_HOME: join(home, "data") },
      now: () => new Date("2026-09-22T00:00:00.000Z"),
    };
    const plan = await planErase(env, {
      subject: subjectId("never-existed"),
      agentDir: null,
      scope: "all",
      by: "odd2 probe",
      needles: [],
      instructionFiles: [],
      soulName: null,
      personalValues: [],
    });
    const result = await commitErase(plan);
    const verification = await verifyErase(plan, result);

    expect(filesRead(verification)).toBeGreaterThan(0);
    expect(verification.verdict).toBe("nothing-found");
  });

  // The same hole as a person meets it: one command, no repository, a subject
  // that has never existed on this machine. Run once in `beforeAll` rather than
  // inside a `test.failing`, so that the assertion which pins the hole is
  // synchronous and the *fact that the probe ran at all* is asserted separately
  // — a `test.failing` whose body throws before reaching its assertion reports
  // the same pass as one whose assertion failed, which is the shape this file
  // is about.
  beforeAll(async () => {
    const home = await sandbox("mind-odd2-erase-cli-");
    const child = Bun.spawn(
      [BUN, "run", BIN, "erase", "never-existed", "--no-agent", "--by", "odd2", "--yes", "--json"],
      {
        cwd: home,
        env: {
          HOME: home,
          PATH: process.env["PATH"] ?? "",
          XDG_STATE_HOME: join(home, "state"),
          XDG_DATA_HOME: join(home, "data"),
          CODEX_HOME: join(home, ".codex"),
          USER: "odd2",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    await child.exited;
    cliErase = {
      code: child.exitCode ?? -1,
      verdict: verdictOf(stdout),
      output: `${stdout}\n${stderr}`,
    };
  }, 120_000);

  test("the probe really ran the CLI, and the CLI really issued a document", () => {
    // Against the schema the engine exports, not against the literal `@1` this
    // line used to hold. The literal pinned a spelling: it would have gone red
    // at the tag bump that fix1 *had* to make, and green again for any document
    // carrying the right five characters. What this test is for is the claim
    // that the probe reached the CLI and got a parsed certificate back, so that
    // the two assertions after it are about behaviour and not about silence.
    expect(cliErase.output).toContain(CERTIFICATE_SCHEMA);
    expect(cliErase.verdict).not.toBe("(no certificate in the output)");
    expect(cliErase.verdict).not.toBe("(the certificate did not parse)");
  });

  test("the CLI does not issue that certificate either", () => {
    expect(cliErase.verdict).not.toBe("erased-and-verified");
    expect(cliErase.verdict).toBe("nothing-found");
  });

  test("and the exit code a script reads is not a success", () => {
    // Separate from the verdict on purpose: the exit code is the only part of
    // this a hook, a CI job or `&&` can see, and it was the part that said a
    // withdrawal succeeded over a machine that held nothing to withdraw.
    // 3 rather than 1, because 1 from this command means *something survived*
    // and a script is entitled to read that as an alarm.
    expect(cliErase.code).not.toBe(0);
    expect(cliErase.code).toBe(3);
  });
});

/** What one CLI run of `erase` produced, measured once in `beforeAll`. */
let cliErase: { code: number; verdict: string; output: string } = {
  code: -1,
  verdict: "(the probe did not run)",
  output: "",
};

/**
 * The `verdict` field out of a `--json` certificate, or why there is none.
 *
 * Parses the whole of stdout. It used to start at `stdout.indexOf("{")`, which
 * was this file copying the same slice `test/cli/erase.test.ts` had: `erase
 * --json` printed its human plan on stdout ahead of the document, and every
 * reader that scanned for a brace agreed to that rather than reporting it. The
 * probe is stricter for it — a document with anything in front of it now
 * returns "did not parse", which is what `jq` would have said all along.
 */
function verdictOf(stdout: string): string {
  if (stdout.trim() === "") return "(no certificate in the output)";
  try {
    return (JSON.parse(stdout) as { verdict?: unknown }).verdict as string;
  } catch {
    return "(the certificate did not parse)";
  }
}

// ---------------------------------------------------------------------------
// 2. Identity — a level, and a stability, over nothing measured
// ---------------------------------------------------------------------------

/** A backend that is never available, so no turn is ever spent on it. */
function silentBackend(id: string): ExecBackend {
  return {
    id,
    display: id,
    kind: "cli",
    identityStrength: "user",
    available: () => Promise.resolve({ ok: false, detail: "not installed, in this probe" }),
    run: () => {
      throw new Error(`${id}.run() must not be reached — available() said no`);
    },
  };
}

/**
 * A report of one backend that never ran, built rather than measured.
 *
 * Constructed by hand because the thing under test is the *rule*, and a rule
 * should be askable about a report without spawning anything to get one.
 */
function silentReport(): VerifyReport {
  return {
    subject: subjectId("never-existed"),
    runs: 1,
    backends: [
      {
        backend: "a",
        display: "a",
        level: "silent",
        reason: "did not run, in this probe",
        channel: { kind: "instruction-file", strength: "none", note: "no target, in this probe" },
        file: { state: "missing", detail: "no target resolved for this backend" },
        reachable: false,
        runs: [],
        stability: [],
        flipped: 0,
        stable: null,
        caveats: [],
      },
    ],
    caveats: [],
    stable: null,
    unmeasured: ["a"],
  };
}

/** Measure a synthetic soul against backends that cannot answer. */
async function verifyAgainstNothing(backends: NonEmpty<ExecBackend>): Promise<VerifyReport> {
  const parent = await sandbox("mind-odd2-soul-");
  const dir = await writeSoul(parent, SOUL_A);
  const loaded = await loadSoul(dir, subjectId(SOUL_A.subject));
  if (!loaded.ok) throw new Error(`the synthetic soul did not load: ${loaded.issues.join("; ")}`);
  return verifySoul(loaded.soul, backends, { targets: [], runs: 1 });
}

describe("identity — what `verify` says when no backend answered", () => {
  test("every backend that could not run is reported `silent`", async () => {
    // The part that holds, measured first: the level itself is honest.
    const report = await verifyAgainstNothing([silentBackend("a"), silentBackend("b")]);
    expect(report.backends.map((row) => row.level)).toEqual(["silent", "silent"]);
    expect(report.backends.every((row) => row.runs.length === 0)).toBe(true);
  });

  test("`stable` is null — not true, and not false — when nothing was measured", async () => {
    // Closed by fix2. This was `test.failing` with `toBe(false)` written as the
    // repair, and **the repair was written at the wrong value**. `false` is the
    // claim that these backends were asked and wavered — ADR 0001 §2's `silent`
    // collapsed into `failed`, which is the one move this project exists to
    // refuse. What was wrong with `true` was never that the opposite was true;
    // it was that nothing was measured at all, and that has its own word.
    //
    // Both halves are asserted, so this row goes red for either mistake: the
    // original free pass, and the over-correction the probe used to ask for.
    const report = await verifyAgainstNothing([silentBackend("a"), silentBackend("b")]);
    expect(report.stable).toBeNull();
    expect(report.stable).not.toBe(true);
    expect(report.stable).not.toBe(false);
  });

  test("a silent backend's own row is not marked stable either", async () => {
    const report = await verifyAgainstNothing([silentBackend("a")]);
    expect(report.backends[0]!.stable).toBeNull();
    expect(report.backends[0]!.flipped).toBe(0);
    expect(report.backends[0]!.runs).toEqual([]);
  });

  test("a report that does not know says which backend it does not know about", async () => {
    // The owner's condition on the `null`: one silent row makes the whole
    // report unknown, and a reader must not have to guess which row did that,
    // nor lose what the other rows measured. `unmeasured` names them.
    const report = await verifyAgainstNothing([silentBackend("a"), silentBackend("b")]);
    expect(report.unmeasured).toEqual(["a", "b"]);
    expect(report.backends.map((row) => row.backend)).toEqual(["a", "b"]);
  });

  test("`soul verify`'s exit rule refuses a report that measured nothing", () => {
    // Closed by fix2, and the way it was closed is the point. This probe used
    // to hold a **transcribed copy** of the two lines in bin/commands/soul.ts:
    //   const allConfirmed = result.backends.every((b) => b.level === "confirmed");
    //   return allConfirmed && result.stable ? 0 : 1;
    // and assert against the copy. A copy goes green the day somebody repairs
    // the original and green the day nobody does — it is a test of itself. The
    // rule is now `verifyPasses` in src/, and this calls it.
    expect(verifyPasses(silentReport())).toBe(false);
  });

  test("…and that the rule the command runs is this one", async () => {
    // The coupling, checked rather than assumed: a rule extracted into `src/`
    // proves nothing if the command kept its own copy.
    const source = await Bun.file(join(ROOT, "bin", "commands", "soul.ts")).text();
    expect(source).toContain("verifyPasses(result)");
    expect(source).not.toContain('every((b) => b.level === "confirmed")');
  });

  test("an empty backend list no longer typechecks, which is what closed this", () => {
    // The reachability field, and it has moved from a measurement to a proof.
    // It used to count the two `named.length > 0 ? named : [...PHASE_A_BACKENDS]`
    // fallbacks in the command's source, because the empty list was reachable
    // in principle and kept out by argument handling alone. `NonEmpty` closes
    // it at the compiler instead, and `@ts-expect-error` is how that is pinned:
    // this file goes red at `npm run typecheck` — not here — on the day the
    // type is widened back to `readonly BackendReport[]`.
    const report: VerifyReport = {
      subject: subjectId("never-existed"),
      runs: 1,
      // @ts-expect-error — a report of no backends is not constructible, and
      // this line is the guard on that: widening the type makes tsc report an
      // unused @ts-expect-error and the typecheck fails.
      backends: [],
      caveats: [],
      stable: true,
      unmeasured: [],
    };
    // Said plainly, because the honest version of this is less comfortable than
    // the comfortable one: `verifyPasses` on that object **still returns true**
    // at run time — `every` over nothing is true, and no run-time check was
    // added to say otherwise. What was closed is the *state*, not the
    // arithmetic over it. A guard clause here would be one more line somebody
    // can delete as redundant in a state nothing can reach.
    // `.length`, not `toEqual([])`: bun's typed `expect` takes the receiver's
    // type for its argument, so even the assertion cannot name an empty list
    // here — which is its own small proof of what the type now says.
    expect(report.backends.length).toBe(0);
    expect(PHASE_A_BACKENDS.length).toBeGreaterThan(0);
  });

  test("levelFor([]) is silent, never confirmed", () => {
    // The guard that makes the level honest, pinned so it cannot be deleted as
    // a redundant early return: both `every` calls below it are vacuously true.
    expect(levelFor([])).toBe("silent");
  });

  test("isolationHeld refuses a report with no probe runs in it", () => {
    // Two shapes of "nothing was asked", and both are refused. The first is
    // the one that is still constructible: a backend that was asked for and
    // never ran. The second is now closed by the type, and is pinned here
    // anyway — `isolationHeld` keeps its own guard clause, because it is a
    // statement about *probe runs* rather than about the list of backends, and
    // a report of two backends that both answered nothing is the reachable
    // version of the same emptiness.
    expect(isolationHeld(silentReport())).toBe(false);

    const empty: VerifyReport = {
      subject: subjectId("alpha-keeper"),
      runs: 1,
      // @ts-expect-error — see the H5 block above: not constructible any more,
      // and this line goes red at `npm run typecheck` if that stops being true.
      backends: [],
      caveats: [],
      stable: true,
      unmeasured: [],
    };
    expect(isolationHeld(empty)).toBe(false);
  });

  test("wornReport of no targets is `none`, and wears nobody", async () => {
    const report = await wornReport([]);
    expect(report.verdict).toBe("none");
    expect(wearsOnly(report, subjectId("alpha-keeper"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. I-6 — the pre-commit scan, and what a pass means over an empty index
// ---------------------------------------------------------------------------

/** A git repository with one commit, under a temporary home. */
async function repoWithACommit(): Promise<string> {
  const dir = await sandbox("mind-odd2-repo-");
  expect((await git(dir, ["init", "-q"])).code).toBe(0);
  await writeFile(join(dir, "kept.md"), "an ordinary file with nothing in it\n");
  expect((await git(dir, ["add", "kept.md"])).code).toBe(0);
  expect((await git(dir, ["commit", "-q", "-m", "first"])).code).toBe(0);
  return dir;
}

describe("I-6 — `guard scan` over nothing staged", () => {
  test("scanStaged([]) finds nothing, which is the whole of what a pass means", () => {
    expect(scanStaged([])).toEqual([]);
  });

  test("a commit that only deletes files stages no bytes for the scan to read", async () => {
    // Reachability for the row below, measured on a real repository rather than
    // argued from the flag: the filter drops deletions on purpose — blocking
    // somebody from removing a secret would be backwards — so a delete-only
    // commit reaches the scanner with an empty list. It is still empty after
    // fix2: `D` is not in the filter, and nothing here asks for it to be.
    const repo = await repoWithACommit();
    expect((await git(repo, ["rm", "-q", "kept.md"])).code).toBe(0);
    expect(await stagedFiles(repo)).toEqual([]);
    expect(await stagedDeletions(repo)).toEqual(["kept.md"]);
  }, 60_000);

  test("a symlink replaced by a real file full of token IS scanned", async () => {
    // The hole this family actually had, and it is a different one from the
    // probe's. Looking for "why is the list empty?" the right question turned
    // out to be "what does the filter throw away?" — and
    // `--diff-filter=ACMR` threw away `T`, git's word for a path whose blob
    // kind changed. A symlink replaced by a regular file holding a token is a
    // typechange, carries every one of its bytes into the commit, and reached
    // the scanner as *nothing at all*.
    //
    // Measured, then fixed: the filter is `ACMRT` now, which is strictly more
    // than it read before — the only direction I-6 lets this move.
    const repo = await repoWithACommit();
    await symlink("kept.md", join(repo, "link.md"));
    expect((await git(repo, ["add", "-A"])).code).toBe(0);
    expect((await git(repo, ["commit", "-q", "-m", "a symlink"])).code).toBe(0);

    await rm(join(repo, "link.md"));
    // A token shaped like the thing the rules look for, invented here and
    // matching nothing real.
    await writeFile(join(repo, "link.md"), "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB\n");
    expect((await git(repo, ["add", "-A"])).code).toBe(0);

    const staged = await stagedFiles(repo);
    expect(staged.map((file) => file.path)).toEqual(["link.md"]);
    expect(scanStaged(staged).length).toBeGreaterThan(0);
  }, 60_000);

  // Measured once, for the reason given beside the `erase` probe above.
  beforeAll(async () => {
    const repo = await repoWithACommit();
    if ((await git(repo, ["rm", "-q", "kept.md"])).code !== 0) return;

    const child = Bun.spawn([BUN, "run", BIN, "guard", "scan", "--staged", repo], {
      cwd: repo,
      env: { HOME: repo, PATH: process.env["PATH"] ?? "", ...GIT_ENV },
      stdout: "pipe",
      stderr: "pipe",
    });
    await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    await child.exited;
    cliScan = { code: child.exitCode ?? -1, err: stderr };
  }, 120_000);

  test("the probe really ran the scan, and the scan really read nothing", () => {
    expect(cliScan.err).toContain("nothing staged carries bytes");
    expect(cliScan.err).toContain("1 staged deletion(s)");
  });

  test("a scan that read no file does not say `passed`", () => {
    // What changed, and what deliberately did not.
    //
    // The word is gone: "0 staged file(s) passed 18 rules" reported a pass over
    // a scan that read nothing, which is this whole file's subject.
    expect(cliScan.err).not.toContain("passed");
    expect(cliScan.err).toContain("This is not a pass and not a block");
  });

  test("…and the exit code stays 0, which is a decision and not an oversight", () => {
    // The probe for this row was `test.failing` on `expect(cliScan.code).not.
    // toBe(0)`, and that assertion was **judged wrong and removed**. It is
    // written here as a comment rather than left as a `test.failing`, because
    // `test.failing` means "a promise waiting to come true": a rejected
    // expectation parked there would go red on the day somebody implemented it,
    // which is a trap laid for whoever comes next rather than a note to them.
    //
    // The reasoning, so it can be argued with rather than rediscovered: the
    // reachable way to stage no bytes is a commit that only deletes files, and
    // such a commit carries nothing into git. Exiting non-zero there would
    // block every delete-only commit — including the one somebody makes to
    // remove a secret — and the first thing a person does about a hook that
    // blocks correct work is `git commit --no-verify`, which turns the guard
    // off for everything, permanently. A guard that is disabled protects
    // nothing. So the exit code is honest at 0 and the *sentence* carries the
    // warning, which is the half that was lying.
    expect(cliScan.code).toBe(0);
  });
});

/** What one CLI run of `guard scan` over an empty index produced. */
let cliScan: { code: number; err: string } = { code: -1, err: "(the probe did not run)" };

// ---------------------------------------------------------------------------
// 4. The same zero, guarded in one caller and not the other
// ---------------------------------------------------------------------------

/** A directory holding a valid soul and no repository — what `--agent` needs. */
async function looseSoul(): Promise<string> {
  const agent = await sandbox("mind-odd2-loose-soul-");
  await mkdir(join(agent, "soul"), { recursive: true });
  const parent = await sandbox("mind-odd2-soul-src-");
  const written = await writeSoul(parent, SOUL_A);
  for (const name of ["role.md", "person.md"]) {
    await writeFile(join(agent, "soul", name), await Bun.file(join(written, name)).text());
  }
  return agent;
}

/** Plan an erase of `SOUL_A` against a given agent directory. */
async function planAgainst(agent: string): Promise<ErasePlan> {
  const home = await sandbox("mind-odd2-erase-home-");
  return planErase(
    {
      home,
      env: { HOME: home, XDG_STATE_HOME: join(home, "state"), XDG_DATA_HOME: join(home, "data") },
      now: () => new Date("2026-09-22T00:00:00.000Z"),
    },
    {
      subject: subjectId(SOUL_A.subject),
      agentDir: agent,
      scope: "all",
      by: "odd2 probe",
      needles: [],
      instructionFiles: [],
      soulName: SOUL_A.name,
      personalValues: [],
    },
  );
}

describe("git facts — `0 commits` for a directory git could not read", () => {
  test("historyFacts now has the arm it was missing", async () => {
    // Closed by fix2, at the source rather than at the callers. This used to
    // assert the hole — `commits: 0, remotes: []` for a directory that is no
    // repository — with a note that the function never claimed an arm for
    // "could not look". It has one now, and having it there is what forced all
    // three callers to deal with the case at compile time.
    const notARepo = await sandbox("mind-odd2-notrepo-");
    const facts = await historyFacts(notARepo);
    expect(facts.readable).toBe(false);
    if (facts.readable) throw new Error("unreachable — asserted above");
    expect(facts.why).toBe("not-a-repository");
  }, 30_000);

  test("doctor asks whether it is a repository before it counts anything", async () => {
    // The caller that holds. `enclosingGitRepo` runs first, and a directory
    // that is not a repository gets a `warn` that says the count would have
    // come back empty either way — never an `ok` line carrying a zero.
    const notARepo = await sandbox("mind-odd2-notrepo-doctor-");
    const report = await runDoctor(
      doctorEnv(notARepo, { agent: notARepo, subject: subjectId("never-existed") }),
    );
    const ids = allFindings(report).map((finding) => finding.id);
    expect(ids).toContain("agent.notrepo");
    expect(ids).not.toContain("agent.commits");
  }, 30_000);

  test("planErase reports no history for a directory with no repository", async () => {
    // The caller that did not hold, and the assertion has moved. This was
    // `test.failing` asking for `plan.git === null`, and **`null` was the wrong
    // repair**: it is the value `--no-agent` uses to mean "nobody asked", and
    // reusing it here would tell a reader that no repository was examined when
    // one was looked for and not found. Those are different sentences on a
    // document somebody is going to quote.
    //
    // What the probe was right about is that a *number* must not be printed.
    const plan = await planAgainst(await looseSoul());
    expect(plan.git).not.toBeNull();
    expect(plan.git?.readable).toBe(false);
    expect(plan.notes.join("\n")).not.toContain("0 commit");

    const cert = certificate({
      plan,
      result: null,
      verification: null,
      observedAccount: "odd2",
      engine: "0.0.0",
      issuedAt: "2026-09-22T00:00:00.000Z",
    });
    expect(cert.agent.history).toBe("not-a-repository");
    expect(cert.agent.commits).toBeNull();
    expect(formatCertificate(cert).join("\n")).not.toContain("0 commit(s)");
  }, 30_000);

  test("and the case the probe had backwards: a real history git will not read", async () => {
    // The dangerous direction, which `plan.git === null` would have waved
    // straight through. This repository holds two commits and a remote; its
    // `.git/config` is unparseable, which is also what `safe.directory` looks
    // like from in here when a checkout belongs to another uid — a container,
    // or `sudo`. `.git` is right there, so every "is this a repository?" test
    // passes, and the old certificate printed `git 0 commit(s) · no remote
    // configured` over a history that has both. Telling somebody that git is
    // keeping *less* than it is, is the S0.4 AC5 failure that matters.
    const agent = await looseSoul();
    expect((await git(agent, ["init", "-q"])).code).toBe(0);
    await writeFile(join(agent, "kept.md"), "an ordinary file\n");
    expect((await git(agent, ["add", "-A"])).code).toBe(0);
    expect((await git(agent, ["commit", "-q", "-m", "first"])).code).toBe(0);
    expect((await git(agent, ["remote", "add", "origin", "file:///tmp/nowhere.git"])).code).toBe(0);
    await writeFile(join(agent, ".git", "config"), "[core\nnot a config file at all\n");

    const plan = await planAgainst(agent);
    expect(plan.git?.readable).toBe(false);

    const cert = certificate({
      plan,
      result: null,
      verification: null,
      observedAccount: "odd2",
      engine: "0.0.0",
      issuedAt: "2026-09-22T00:00:00.000Z",
    });
    expect(cert.agent.history).toBe("unreadable");
    expect(cert.agent.commits).toBeNull();
    expect(cert.agent.remotes).toEqual([]);

    // Not just absent from the fields — said, in the sentences under the
    // verdict, which is the part of this document that gets read.
    const page = formatCertificate(cert).join("\n");
    expect(page).not.toContain("0 commit(s)");
    expect(page).not.toContain("no remote configured");
    expect(page).toContain("UNKNOWN");
    expect(cert.statement.join("\n")).toContain("not zero");
    // And the warning about what a commit puts beyond reach is still printed,
    // because it is more true here, not less.
    expect(page).toContain("git log -p");
  }, 60_000);

  test("guard status still refuses a directory that is no repository", async () => {
    // Kept, and no longer the only thing standing between that command and a
    // printed zero: `hookStatus` throwing first was a guard unrelated to the
    // thing it guarded, so reordering two lines moved it. The command now asks
    // `historySentence`, which cannot print a number it does not have.
    const notARepo = await sandbox("mind-odd2-notrepo-guard-");
    await expect(hookStatus(notARepo)).rejects.toThrow("does not look like a git repository");
    const source = await Bun.file(join(ROOT, "bin", "commands", "guard.ts")).text();
    expect(source).toContain("historySentence(facts)");
    expect(source).not.toContain("${facts.commits} commit(s)");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 5. The coverage gate, asked about an empty repository
// ---------------------------------------------------------------------------

/** Readings for a repository with no source in it at all. */
function emptyReadings(overrides: Partial<Readings> = {}): Readings {
  return {
    lcov: "",
    src: [],
    bin: [],
    scripts: [],
    code: new Map(),
    lines: new Map(),
    digests: new Map(),
    argv: [],
    ...overrides,
  };
}

describe("the coverage gate over an empty tree", () => {
  test("judge() refuses a repository with nothing in it — via the stray check", () => {
    // Measured, and the result was not the predicted one. `verdict([], …)` is
    // vacuously clean and `sizeVerdict` reports its missing paths last, so the
    // branch that actually refuses is `stray`: PROVED_OTHERWISE names two files
    // under scripts/ and neither is on disk. The gate holds — and it holds
    // through a clause written for a different purpose, which is worth knowing
    // before anybody simplifies that list.
    const judged = judge(emptyReadings());
    expect(judged.code).toBe(1);
    expect(judged.err.join("\n")).toContain("written down but not on disk");
  });

  test("an unparseable report fails on absence rather than passing on an empty parse", () => {
    const judged = judge(emptyReadings({ lcov: "not an lcov report at all", src: ["src/a.ts"] }));
    expect(judged.code).toBe(1);
    expect(judged.err.join("\n")).toContain("no test ever loads");
  });

  test("verdict() reports absence before it reports the floor", () => {
    const seen = verdict(["src/a.ts"], new Map(), 85);
    expect(seen.unseen).toEqual(["src/a.ts"]);
    expect(seen.below).toEqual([]);
  });

  test("sizeVerdict reports a recorded path that is not on disk", () => {
    const drift = sizeVerdict(new Map(), new Map([["bin/gone.ts", { lines: 10, why: "probe" }]]));
    expect(drift.missing).toEqual(["bin/gone.ts"]);
  });

  test("nothing measured at all is a failure, not a clean run", () => {
    const judged = judge(emptyReadings({ lcov: undefined }));
    expect(judged.code).toBe(1);
    expect(judged.err.join("\n")).toContain("nothing was measured");
  });
});

// ---------------------------------------------------------------------------
// 6. doctor — the command written against this exact failure
// ---------------------------------------------------------------------------

/** A machine that has nothing on it, described entirely in arguments. */
function doctorEnv(home: string, overrides: Partial<DoctorEnv> = {}): DoctorEnv {
  return {
    home,
    cwd: home,
    env: {},
    engineRoot: undefined,
    which: () => null,
    run: () => Promise.resolve({ code: -1, stdout: "", stderr: "", timedOut: false }),
    getJson: (url: string) =>
      Promise.resolve(
        url.endsWith("/collections")
          ? { ok: true as const, body: { result: { collections: [] } } }
          : { ok: false as const, reason: "nothing is listening, in this probe" },
      ),
    ollamaHost: DEAD_OLLAMA,
    qdrantHost: DEAD_QDRANT,
    models: [],
    backends: [],
    probeVersions: false,
    ...overrides,
  };
}

function allFindings(report: DoctorReport): readonly Finding[] {
  return report.sections.flatMap((section) => section.findings);
}

describe("doctor — the three gates in front of the word `clean`", () => {
  test("no checkout means `not checked`, and never `clean`", async () => {
    const report = await runDoctor(doctorEnv(await sandbox("mind-odd2-doctor-")));
    const ids = allFindings(report).map((finding) => finding.id);
    expect(ids).toContain("engine.unchecked");
    expect(ids).not.toContain("engine.clean");
  }, 30_000);

  test("a root that is not the engine's source is `not checked` too", async () => {
    const empty = await sandbox("mind-odd2-doctor-root-");
    const report = await runDoctor(doctorEnv(await sandbox("mind-odd2-doctor-home-"), { engineRoot: empty }));
    const engine = allFindings(report).find((finding) => finding.id === "engine.unchecked");
    expect(engine?.detail).toContain("not the engine's source");
  }, 30_000);

  test("an unreachable local route is still the one thing that exits 1", async () => {
    const report = await runDoctor(doctorEnv(await sandbox("mind-odd2-doctor-exit-")));
    expect(blockers(report).map((finding) => finding.id)).toContain("ollama.unreachable");
  }, 30_000);

  test("no `ok` finding carries a count of zero, when the store answers", async () => {
    // The inverted row, and the repair went to the finding rather than to the
    // rule. `test/cli/binary.test.ts` forbids `severity === "ok"` beside a
    // zero, with no exception; `qdrant.reachable` used to end `· 0
    // collection(s)`, and a reachable store with no collection yet is the
    // ordinary state of a freshly installed machine — so the *rule* was correct
    // and the finding was the thing saying something it should not.
    //
    // `binary.test.ts` never reaches this row at all: it passes `--ollama <dead
    // port>` and leaves the store at its default, so on a machine with nothing
    // there the probe fails before a finding is made. That is why this file
    // holds the measurement, with the regex copied from that file character for
    // character, and why **not one character of the rule over there was
    // touched** to make this green.
    const report = await runDoctor(doctorEnv(await sandbox("mind-odd2-doctor-qdrant-")));
    const zeroed = allFindings(report).filter(
      (finding) => finding.severity === "ok" && /(^|\s)0\s+\S/.test(finding.detail),
    );
    expect(zeroed).toEqual([]);

    // And the row is still there saying what it does certify — the store
    // answered, and the list parsed. A finding deleted to satisfy a rule would
    // pass this test too.
    const store = allFindings(report).find((finding) => finding.id === "qdrant.reachable");
    expect(store?.severity).toBe("ok");
    expect(store?.detail).toContain("no collection yet");
  }, 30_000);

  test("the rule this repository already had is the one still being met", async () => {
    // The guard on the guard. The tempting repair for an inverted check is to
    // narrow the check, and the one line that would have done it is in a file
    // this task was told not to touch — so the coupling is asserted rather than
    // trusted: the regex in `binary.test.ts` is still exactly this.
    const source = await Bun.file(join(ROOT, "test", "cli", "binary.test.ts")).text();
    expect(source).toContain('f.severity === "ok" && /(^|\\s)0\\s+\\S/.test(f.detail)');
  });
});

// ---------------------------------------------------------------------------
// 7. The checkers that hold — kept on as permanent guards
// ---------------------------------------------------------------------------

describe("checkers that refuse the empty case on purpose", () => {
  test("auditClears is false when no field was judged at all", () => {
    expect(auditClears([])).toBe(false);
    expect(auditClears([{ field: "kind", judged: 0, correct: 0, pct: 0 }])).toBe(false);
  });

  test("a fallback chain of no backends is a programmer error, not an empty pass", () => {
    expect(() => new FallbackExec([])).toThrow("at least one backend");
  });

  test("searchTree over a root that is not there reads nothing and says nothing is wrong", async () => {
    // Judged by its caller, not on its own: `erase` is right that "deleted" and
    // "never there" are the same fact on disk, and `doctor.checkEngine` had to
    // put three gates in front of the same return value to stop it meaning
    // `clean`. Pinned here so the shared half keeps its documented behaviour.
    const result = await searchTree("probe", join(tmpdir(), "mind-odd2-absent-root"), [
      { label: "subject id", text: "never-existed", boundary: true, quotable: true },
    ]);
    expect(result.filesRead).toBe(0);
    expect(result.hits).toEqual([]);
    expect(result.unreadable).toBeUndefined();
  });

  test("the registry is not empty, which is what keeps two vacuous truths unreachable", () => {
    // `isProjectScopedOnly` is `instructionFiles.every(…)` and `derivedStatus`
    // compares two joined lists; both are true of nothing. Neither is reachable
    // while these two lists have entries in them, and `notes/odd2-driver.ts`
    // measures what happens when they do not.
    expect(VENDORS.length).toBeGreaterThan(0);
    expect(DERIVATIONS.length).toBeGreaterThan(0);
    expect(VENDORS.some((spec) => !isProjectScopedOnly(spec))).toBe(true);
  });

  test("derivedStatus over a directory with nothing built is `missing`, not `fresh`", async () => {
    const empty = await sandbox("mind-odd2-derived-");
    const status = await derivedStatus(empty, subjectId("never-existed"));
    expect(status.state).toBe("missing");
  }, 30_000);
});

describe("`soul apply` with no target to write", () => {
  /** A loaded synthetic soul and the environment to apply it in. */
  async function applyEnv(): Promise<{ soul: Awaited<ReturnType<typeof loadSoul>>; env: ApplyEnv }> {
    const parent = await sandbox("mind-odd2-apply-");
    const home = await sandbox("mind-odd2-apply-home-");
    const dir = await writeSoul(parent, SOUL_A);
    const soul = await loadSoul(dir, subjectId(SOUL_A.subject));
    return {
      soul,
      env: {
        home,
        env: { HOME: home, XDG_STATE_HOME: join(home, "state") },
        now: () => new Date("2026-09-22T00:00:00.000Z"),
        explicit: new Set<string>(),
      },
    };
  }

  test("commitApply says which kind of nothing it wrote, and `ok` stays true", async () => {
    // The probe for this row asked for `ok: false`, and **that repair was
    // refused**. `pending.length === 0` is the ordinary outcome of applying the
    // same soul twice, and the only outcome on a machine whose one backend is
    // ollama — where the identity travels in the system field and there is no
    // file to write at all. Turning either into a failure would make `soul
    // apply` exit non-zero on the local-only route, which is I-1 broken to
    // satisfy a probe.
    //
    // What was really wrong is below: three different situations produced one
    // answer, and the command read that answer as the most reassuring of them.
    const { soul, env } = await applyEnv();
    if (!soul.ok) throw new Error(`the synthetic soul did not load: ${soul.issues.join("; ")}`);

    const plan = await planApply(soul.soul, [], env);
    expect(plan.plans).toEqual([]);

    const committed = await commitApply(plan, env);
    expect(committed.ok).toBe(true);
    expect(committed.outcome).toBe("nothing-applicable");
    expect(committed.written).toEqual([]);
  }, 30_000);

  test("a target that was skipped is not a target that holds this identity", async () => {
    // The lie that was reachable *today*, which the `ok: false` framing hid.
    // Every target off PATH is `skipped`, nothing is pending, and `soul apply`
    // printed "Nothing to write — every target already holds this identity" —
    // about files it had not read, for backends that are not installed.
    const { soul, env } = await applyEnv();
    if (!soul.ok) throw new Error(`the synthetic soul did not load: ${soul.issues.join("; ")}`);

    const targets = await resolveTargets(["claude"], {
      home: env.home,
      cwd: await sandbox("mind-odd2-apply-cwd-"),
      env: {},
      which: () => Promise.resolve(false),
    });
    const plan = await planApply(soul.soul, targets, env);
    expect(plan.plans.map((item) => item.action)).toEqual(["skipped"]);

    const committed = await commitApply(plan, env);
    expect(committed.ok).toBe(true);
    // Not `already-current`: nothing here holds anything.
    expect(committed.outcome).toBe("nothing-applicable");
  }, 30_000);

  test("…and the command no longer prints the reassuring sentence for it", async () => {
    // Asserted against the command's source rather than by spawning it: making
    // a real run reach the all-skipped branch means a home with no vendor CLI
    // and `--apply` writing into it, which is a test that touches more than the
    // sentence under examination.
    const source = await Bun.file(join(ROOT, "bin", "commands", "soul.ts")).text();
    const sentence = "every target already holds this identity";
    expect(source).not.toContain(sentence);
    expect(source).toContain('case "already-current":');
    expect(source).toContain('case "nothing-applicable":');
  });

  test("resolving any known backend yields at least one target", async () => {
    // The reachability field for the row above. It goes red the day
    // `resolveTargets` can return nothing for a non-empty backend list, which
    // is the day the hole above becomes reachable.
    const targets = await resolveTargets([...PHASE_A_BACKENDS], {
      home: await sandbox("mind-odd2-targets-"),
      cwd: await sandbox("mind-odd2-targets-cwd-"),
      env: {},
      which: () => Promise.resolve(false),
    });
    expect(targets.length).toBeGreaterThan(0);
  }, 30_000);
});

describe("D-021 — what these two new files may not carry", () => {
  // The same guard `test/notes/sp1-note.test.ts` puts on the SP-1 note, put on
  // the two files this task added. `notes/` is opened with the repository, and
  // a survey of this machine is exactly the sort of document a path gets typed
  // into by hand afterwards.
  for (const relative of ["notes/odd2-free-pass-survey.md", "notes/odd2-driver.ts"]) {
    test(`${relative} holds no path under anybody's home`, async () => {
      const text = await Bun.file(join(ROOT, relative)).text();
      expect(text).not.toMatch(/\/(?:home|Users)\//);
      expect(text).not.toMatch(/~\//);
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
    });
  }
});
