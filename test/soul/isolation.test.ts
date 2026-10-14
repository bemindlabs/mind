/**
 * S1.6 AC2 — wear A, ask, switch to B, ask again, and get nothing of A back.
 *
 * This is the story's whole claim in one file, run end to end against the real
 * `apply` path: two synthetic souls with five disjoint facts each, a temporary
 * home with somebody's own `CLAUDE.md` already in it, and a backend that hands
 * back everything the channel carried.
 *
 * ## Why the oracle, and why it is not a weaker test
 *
 * `channelOracle` (`test/support/channel-oracle.ts`) reads its instruction file
 * and repeats it. That is the *leakiest* backend that could exist — a model
 * with no discretion at all — so "A's facts did not come back" here means they
 * were not reachable, not that something chose not to say them. A real model
 * would be a test of that model's mood on the day, and
 * `test/soul/isolation.real.test.ts` is the opt-in run for that.
 *
 * ## The control, which is half the evidence
 *
 * Before the switch, all five of A's facts come back. Without that, "B could
 * not answer" would be consistent with a question set that nothing can answer,
 * and the whole file would be green for the wrong reason.
 *
 * Nothing here touches the real `$HOME`: every path is under a temporary
 * directory, and the fixtures are synthetic (D-021).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitApply, planApply, type ApplyEnv } from "../../src/soul/apply.ts";
import {
  askFacts,
  factIssues,
  factKeys,
  factProbes,
  FACTS_PER_SOUL,
  isolationHeld,
  ISOLATION_LIMITS,
  leaks,
  MIN_FACT_LENGTH,
  sharedFacts,
} from "../../src/soul/isolation.ts";
import { loadSoul } from "../../src/soul/load.ts";
import { renderSoul } from "../../src/soul/render.ts";
import { resolveTargets, type Target } from "../../src/soul/targets.ts";
import { normalize, tally } from "../../src/soul/verify.ts";
import { residue, wornReport } from "../../src/soul/worn.ts";
import { subjectId } from "../../src/types.ts";
import { channelOracle } from "../support/channel-oracle.ts";
import { factValues, SOUL_A, SOUL_B, writeSoul } from "../support/synthetic-soul.ts";

const HUMAN = join(import.meta.dir, "..", "fixtures", "instructions", "human-200.md");

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-isolation-"));
  scratch.push(dir);
  return dir;
}

/** A home with one instruction file in it that a person wrote. */
async function makeHome(): Promise<{ readonly home: string; readonly human: string }> {
  const home = await sandbox();
  await mkdir(join(home, ".claude"), { recursive: true });
  const human = await readFile(HUMAN, "utf8");
  await writeFile(join(home, ".claude", "CLAUDE.md"), human);
  return { home, human };
}

/** Distinct, ordered backup directories, so two applies cannot collide. */
let clock = 0;

async function wear(dir: string, subject: string, targets: readonly Target[], home: string) {
  const loaded = await loadSoul(dir, subjectId(subject));
  expect(loaded.ok, `the ${subject} fixture no longer loads`).toBe(true);
  if (!loaded.ok) throw new Error("unreachable");

  const env: ApplyEnv = {
    home,
    env: { XDG_STATE_HOME: join(home, "state") },
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)),
    explicit: new Set(["claude"]),
  };
  const plan = await planApply(loaded.soul, targets, env);
  expect(plan.issues).toEqual([]);
  const result = await commitApply(plan, env);
  expect(result.ok, JSON.stringify(result.refused)).toBe(true);
  return loaded.soul;
}

/** The claude file target, resolved against a temporary home and nothing else. */
function targetsFor(home: string): Promise<readonly Target[]> {
  return resolveTargets(["claude"], {
    home,
    cwd: home,
    env: { HOME: home },
    // Installed or not is irrelevant to this measurement: the file is what is
    // being switched, and a machine without the CLI must still be provable.
    which: () => Promise.resolve(true),
  });
}

describe("the fixtures themselves", () => {
  test("five facts each, clearly separate, and shared by neither (AC2)", async () => {
    const dir = await sandbox();
    const a = await loadSoul(await writeSoul(dir, SOUL_A), subjectId(SOUL_A.subject));
    const b = await loadSoul(await writeSoul(dir, SOUL_B), subjectId(SOUL_B.subject));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(factKeys(a.soul)).toHaveLength(FACTS_PER_SOUL);
    expect(factKeys(b.soul)).toHaveLength(FACTS_PER_SOUL);
    expect(factIssues(a.soul)).toEqual([]);
    expect(factIssues(b.soul)).toEqual([]);

    // The control that makes a pass mean anything: neither soul's facts are
    // already in the other's rendered identity.
    expect(sharedFacts(a.soul, b.soul)).toEqual([]);
    expect(sharedFacts(b.soul, a.soul)).toEqual([]);
  });

  test("a soul with too few, too short, or duplicated facts is refused before a run", async () => {
    const dir = await sandbox();
    const thin = await writeSoul(dir, {
      subject: "thin-keeper",
      name: "Thin Keeper",
      facts: { one: "a fact that is long enough to be asked about", two: "short" },
    });
    const loaded = await loadSoul(thin, subjectId("thin-keeper"));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const issues = factIssues(loaded.soul);
    expect(issues.map((i) => i.path)).toEqual(["extra", "extra.two"]);
    expect(issues[0]!.message).toContain(`${FACTS_PER_SOUL} fact(s)`);
    expect(issues[1]!.message).toContain(`${MIN_FACT_LENGTH}`);

    const twinned = await writeSoul(dir, {
      subject: "twin-keeper",
      name: "Twin Keeper",
      facts: {
        a: "the same sentence, written once",
        b: "The same sentence; written once!",
        c: "a third sentence that is different",
        d: "a fourth sentence that is different",
        e: "a fifth sentence that is different",
      },
    });
    const twins = await loadSoul(twinned, subjectId("twin-keeper"));
    expect(twins.ok).toBe(true);
    if (!twins.ok) return;

    const duplicated = factIssues(twins.soul);
    expect(duplicated).toHaveLength(1);
    expect(duplicated[0]!.path).toBe("extra.b");
    expect(duplicated[0]!.message).toContain("[extra].a");
  });

  test("every fact reaches the block `apply` writes — otherwise the question is unfair", async () => {
    const dir = await sandbox();
    const a = await loadSoul(await writeSoul(dir, SOUL_A), subjectId(SOUL_A.subject));
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    const rendered = normalize(renderSoul(a.soul));
    for (const value of factValues(SOUL_A)) expect(rendered).toContain(normalize(value));
  });

  test("the probes are one per fact, in a fixed order, each with its own token", async () => {
    const dir = await sandbox();
    const a = await loadSoul(await writeSoul(dir, SOUL_A), subjectId(SOUL_A.subject));
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    let n = 0;
    const probes = factProbes(a.soul, () => `t${n++}`);

    expect(probes.map((p) => p.id)).toEqual(factKeys(a.soul).map((key) => `fact:${key}`));
    expect(probes.map((p) => p.nonce)).toEqual(["t0", "t1", "t2", "t3", "t4"]);
    for (const probe of probes) {
      // The shared protocol, not a second one: attribution and the run token.
      expect(probe.question).toContain("Answer only from the standing instructions");
      expect(probe.question).toContain(probe.nonce);
    }
  });
});

describe("AC2 — switch to B and A is gone", () => {
  test("A answers all five, B answers none of them, and B answers its own", async () => {
    const { home, human } = await makeHome();
    const souls = await sandbox();
    const dirA = await writeSoul(souls, SOUL_A);
    const dirB = await writeSoul(souls, SOUL_B);

    const targets = await targetsFor(home);
    const path = (targets[0] as { readonly path: string }).path;
    const oracle = channelOracle({ id: "claude", path });

    // ---- wearing A -------------------------------------------------------
    const soulA = await wear(dirA, SOUL_A.subject, targets, home);

    const control = await askFacts(soulA, [oracle], { targets, runs: 1 });
    expect(tally(control.backends[0]!)).toEqual({ passed: FACTS_PER_SOUL, total: FACTS_PER_SOUL });
    expect(control.backends[0]!.level).toBe("confirmed");
    expect(control.backends[0]!.file.state).toBe("present");

    const wornA = await wornReport(targets);
    expect(wornA.subject).toBe(subjectId(SOUL_A.subject));
    expect(residue(wornA, subjectId(SOUL_B.subject))).toEqual([]);

    // ---- switch to B -----------------------------------------------------
    const soulB = await wear(dirB, SOUL_B.subject, targets, home);

    // The question the whole story is about: A's five facts, asked of a machine
    // wearing B, of a backend that would repeat anything it was given.
    const after = await askFacts(soulA, [oracle], { targets, runs: 1 });

    expect(leaks(after)).toEqual([]);
    expect(isolationHeld(after)).toBe(true);
    expect(after.backends[0]!.runs.map((r) => r.verdict)).toEqual(
      Array.from({ length: FACTS_PER_SOUL }, () => "failed"),
    );
    // And Mind's own reading of the disk agrees, independently of the answers.
    expect(after.backends[0]!.file.state).toBe("other-subject");
    expect(after.backends[0]!.file.subject).toBe(subjectId(SOUL_B.subject));

    // B is not merely "not A": it really is wearing its own identity, which is
    // what stops this from passing on a machine where the file was deleted.
    const bee = await askFacts(soulB, [oracle], { targets, runs: 1 });
    expect(tally(bee.backends[0]!)).toEqual({ passed: FACTS_PER_SOUL, total: FACTS_PER_SOUL });

    // ---- AC3: nothing of A is left in the file ---------------------------
    const text = await readFile(path, "utf8");
    for (const value of factValues(SOUL_A)) expect(text).not.toContain(value);
    expect(text).not.toContain(renderSoul(soulA));
    expect(text).toContain(renderSoul(soulB));

    const wornB = await wornReport(targets);
    expect(wornB.verdict).toBe("one");
    expect(wornB.subject).toBe(subjectId(SOUL_B.subject));
    expect(residue(wornB, subjectId(SOUL_A.subject))).toEqual([]);

    // The human's own 200 lines are still exactly where they were (S1.2 AC4).
    expect(text.startsWith(human)).toBe(true);
  }, 30_000);

  test("the control: a leak would be caught, not shrugged at", async () => {
    const { home } = await makeHome();
    const souls = await sandbox();
    const dirA = await writeSoul(souls, SOUL_A);

    const targets = await targetsFor(home);
    const path = (targets[0] as { readonly path: string }).path;
    const soulA = await wear(dirA, SOUL_A.subject, targets, home);

    // A file that was "switched" by appending B rather than replacing A — the
    // residue AC3 forbids, staged by hand because `apply` cannot produce it.
    await writeFile(path, `${await readFile(path, "utf8")}\n\n# Beta Keeper\n`);

    const report = await askFacts(soulA, [channelOracle({ id: "claude", path })], {
      targets,
      runs: 1,
    });

    const found = leaks(report);
    expect(found).toHaveLength(FACTS_PER_SOUL);
    expect(found.map((leak) => leak.probe)).toEqual(
      factKeys(soulA).map((key) => `fact:${key}`),
    );
    expect(isolationHeld(report)).toBe(false);
  }, 30_000);

  test("a backend that never ran is not isolation", async () => {
    const { home } = await makeHome();
    const souls = await sandbox();
    const dirA = await writeSoul(souls, SOUL_A);
    const targets = await targetsFor(home);
    const soulA = await wear(dirA, SOUL_A.subject, targets, home);

    const dead = {
      ...channelOracle({ id: "claude" }),
      available: () => Promise.resolve({ ok: false, detail: "not installed" }),
    };

    const report = await askFacts(soulA, [dead], { targets, runs: 1 });

    // No leaks, because nothing was asked — and that is precisely why it is
    // not a pass. The silent success this project exists to catch.
    expect(leaks(report)).toEqual([]);
    expect(isolationHeld(report)).toBe(false);
  }, 30_000);
});

describe("what an isolation result does not cover", () => {
  test("the limits name the model, the store, and I-4", () => {
    const text = ISOLATION_LIMITS.join("\n");
    expect(text).toContain("not a claim about a model's memory");
    expect(text).toContain("I-4");
    expect(text).toContain("S4.1");
    expect(text).toContain("collectionFor");
  });
});
