/** S21.5 — one tuning round with a scripted proposer and a fake evaluator, over a real git repository. */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listEvalRuns } from "../../../src/soul/eval-runs.ts";
import { dryRunLines, readTuneRun, runTune, tuneLines, usableBase, costOf, type TuneOutcome } from "../../../src/soul/tune/round.ts";
import { PERSON_MARK, TRAIN, branches, contextOf, fakeDeps, fakeRun, g, HELD, KEEP, makeFixture, proposal, repoState, task, tasksOf, withRules, type Fixture } from "../../support/tune-fixture.ts";

const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});
async function fx(): Promise<Fixture> {
  const f = await makeFixture();
  fixtures.push(f);
  return f;
}
const style = { bold: (s: string) => s, dim: (s: string) => s };
const reasons = (o: TuneOutcome): string => (o.kind === "refused" ? o.reasons.join("\n") : `not refused: ${o.kind}`);
const done = (o: TuneOutcome) => {
  if (o.kind !== "done") throw new Error(`expected a finished round, got ${JSON.stringify(o).slice(0, 300)}`);
  return o;
};

describe("preconditions: each one a clear refusal", () => {
  test("a soul that does not load", async () => {
    const f = await fx();
    await writeFile(join(f.soulDir, "role.md"), "not a role");
    await g(f.agent, "commit", "-qam", "break it");
    const out = await runTune(contextOf(f), fakeDeps(f, tasksOf()).deps, false);
    expect(out).toMatchObject({ kind: "refused" });
    expect(reasons(out)).toContain("the soul does not load");
  });

  test("no train task, and no held-out task", async () => {
    const f = await fx();
    const noTrain = await runTune(contextOf(f, HELD.map((id) => task(id, "heldout"))), fakeDeps(f, []).deps, false);
    expect(reasons(noTrain)).toContain("no train task");
    const noHeld = await runTune(contextOf(f, TRAIN.map((id) => task(id, "train"))), fakeDeps(f, []).deps, false);
    expect(reasons(noHeld)).toContain("no held-out task");
  });

  test("the brake is on: nothing starts, and the base is never asked", async () => {
    const f = await fx();
    const fake = fakeDeps(f, tasksOf(), { stopAt: 1 });
    const out = await runTune(contextOf(f), fake.deps, false);
    expect(reasons(out)).toContain("the brake is on");
    expect(fake.calls.baseRuns).toBe(0);
    // A dry run asks no model and starts nothing, so the brake does not stop it.
    const dry = await runTune(contextOf(f), fakeDeps(f, tasksOf(), { stopAt: 1 }).deps, true);
    expect(dry.kind).toBe("dry-run");
  });

  test("not in a git repository, and a soul with uncommitted edits", async () => {
    const f = await fx();
    await writeFile(join(f.soulDir, "role.md"), `${f.baseRole}\nan edit\n`);
    const dirty = await runTune(contextOf(f), fakeDeps(f, tasksOf()).deps, false);
    expect(reasons(dirty)).toContain("edits that are not committed");
    await g(f.agent, "checkout", "-q", "--", ".");
    await writeFile(join(f.soulDir, "autonomy.md"), "autonomy: edited\n");
    // The `soul/` directory is the soul: any file in it counts.
    expect(reasons(await runTune(contextOf(f), fakeDeps(f, tasksOf()).deps, false))).toContain("edits that are not committed");
    await g(f.agent, "checkout", "-q", "--", ".");
    await Bun.$`rm -rf ${join(f.agent, ".git")}`;
    const bare = await runTune(contextOf(f), fakeDeps(f, tasksOf()).deps, false);
    expect(reasons(bare)).toContain("is not in a git repository");
  });
});

describe("a round", () => {
  /** INV answers t1 and h1 and h2; DOM answers t2 and h1 only: INV has the larger held-out gain. */
  const both = (inv: string[], dom: string[]) => (f: Fixture) => (dimension: "INV" | "DOM") => proposal(withRules(f, ...(dimension === "INV" ? inv : dom)));

  test("the larger held-out gain wins; candidates are branches made without touching HEAD, the index or the working tree", async () => {
    const f = await fx();
    const before = await repoState(f);
    const script = both(["t1", "h1", "h2"], ["t2", "h1"])(f);
    const fake = fakeDeps(f, tasksOf(), { proposer: (d) => script(d) });
    const out = done(await runTune(contextOf(f), fake.deps, false));
    expect(out.record.verdict.winner).toBe("INV");
    expect(out.record.verdict.reason).toContain("larger held-out gain");
    const [inv, dom] = out.record.candidates;
    expect(inv).toMatchObject({ dimension: "INV", outcome: "edit", verdict: "adopt", branch: `tune/${out.record.runId}-inv` });
    expect(dom).toMatchObject({ dimension: "DOM", verdict: "adopt" });
    expect(inv!.heldout!.delta).toBeGreaterThan(dom!.heldout!.delta);
    expect(inv!.changes.map((c) => c.task)).toContain("h1");
    // HEAD, the index, the current branch and the working tree are exactly as they were.
    expect(await repoState(f)).toBe(before);
    expect((await branches(f)).sort()).toEqual([`tune/${out.record.runId}-dom`, `tune/${out.record.runId}-inv`]);
    // A candidate differs from the base in role.md only, and its frontmatter is the base's byte for byte.
    for (const c of out.record.candidates) {
      expect(await g(f.agent, "diff", "--name-only", f.head, c.branch!)).toBe("soul/role.md");
      const text = await g(f.agent, "show", `${c.branch}:soul/role.md`);
      expect(text.slice(0, text.indexOf("\n+++\n"))).toBe(f.baseRole.slice(0, f.baseRole.indexOf("\n+++\n")));
      expect(await g(f.agent, "show", `${c.branch}:soul/person.md`)).toBe(await g(f.agent, "show", `${f.head}:soul/person.md`));
      expect(await g(f.agent, "log", "-1", "--format=%an <%ae>", c.branch!)).toBe("Example Keeper (Mind agent) <example@agents.mind.invalid>");
      expect((await g(f.agent, "rev-parse", `${c.branch}^`))).toBe(f.head);
    }
    // Probed once each, on the branch.
    expect(fake.calls.candidateRuns.sort()).toEqual([inv!.branch!, dom!.branch!].sort());
    expect(fake.calls.baseRuns).toBe(1);
  });

  test("the record: schema, links, cost, 0600 in a 0700 directory, and the listing of eval runs leaves it alone", async () => {
    const f = await fx();
    const script = both(["t1", "h1", "h2"], [])(f);
    const out = done(await runTune(contextOf(f, tasksOf(), 2), fakeDeps(f, tasksOf(), { proposer: (d) => (d === "INV" ? script("INV") : KEEP) }, 2).deps, false));
    expect((await stat(out.path)).mode & 0o777).toBe(0o600);
    expect((await stat(f.runs)).mode & 0o777).toBe(0o700);
    const read = await readTuneRun(f.runs, out.record.runId);
    expect(read.ok).toBe(true);
    const rec = (read as { record: typeof out.record }).record;
    expect(rec).toMatchObject({ schema: "mind/tune-run@1", subject: "example", repeat: 2, backend: "stub", model: "stub", prompts: "mind/tune-prompts@1", adopted: null, cost: { turns: 42, tokens: 1234, tokensUnknown: 0 }, base: { commit: f.head, heldoutTasks: 6 }, verdict: { winner: "INV" } });
    expect(rec.base.runId).toMatch(/^ev-/);
    expect(rec.candidates[0]).toMatchObject({ outcome: "edit", runId: expect.stringMatching(/^ev-/), commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(rec.candidates[1]).toMatchObject({ dimension: "DOM", outcome: "keep-base", branch: null });
    expect(JSON.stringify(rec)).not.toContain(PERSON_MARK);
    expect(await readdir(f.runs)).toEqual([`${rec.runId}.json`]);
    expect(await listEvalRuns(f.runs)).toEqual({ runs: [], unreadable: [] });
    expect((await readTuneRun(f.runs, "tn-20260101T000000Z-aaaa")).ok).toBe(false);
    expect((await readTuneRun(f.runs, "nope")).ok).toBe(false);
    await writeFile(join(f.runs, "tn-20260101T000000Z-bbbb.json"), "{}");
    expect((await readTuneRun(f.runs, "tn-20260101T000000Z-bbbb")).ok).toBe(false);
    await chmod(f.runs, 0o700);
  });

  test("the report: deltas, flips, verdicts, the body diff, the cost", async () => {
    const f = await fx();
    const script = both(["t1", "h1", "h2"], ["h1"])(f);
    const out = done(await runTune(contextOf(f), fakeDeps(f, tasksOf(), { proposer: (d) => script(d) }).deps, false));
    const text = tuneLines(out.record, out.diffs, style).join("\n");
    expect(text).toContain(`${out.record.runId} — harness tuning of example`);
    expect(text).toMatch(/train +[\d.]+% → [\d.]+% \(\+/);
    expect(text).toMatch(/held-out +[\d.]+% → [\d.]+% \(\+/);
    expect(text).toMatch(/h1 +soul +heldout +fail→pass/);
    expect(text).toContain("verdict: adopt INV");
    expect(text).toContain("+Added: RULE-t1 RULE-h1 RULE-h2");
    expect(text).toContain("cost: 42 turn(s) in the ledger, 1234 token(s)");
    expect(text).toContain("refused until the tuner is proved, S21.7");
  });

  test("a tie in held-out gain is no winner: KEEP_BASE", async () => {
    const f = await fx();
    const script = both(["t1", "h1"], ["t2", "h1"])(f);
    const out = done(await runTune(contextOf(f), fakeDeps(f, tasksOf(), { proposer: (d) => script(d) }).deps, false));
    expect(out.record.candidates.map((c) => c.verdict)).toEqual(["adopt", "adopt"]);
    expect(out.record.verdict.winner).toBeNull();
    expect(out.record.verdict.reason).toContain("a tie keeps the base");
  });

  test("a held-out task that loses a pass blocks a candidate, whatever it gains elsewhere", async () => {
    const f = await fx();
    // The base answers h3 through "RULE-h3"; this body drops that line and adds two other held-out rules.
    const dropped = withRules(f, "h1", "h2").replace("Known: RULE-t5 RULE-h3", "");
    const out = done(await runTune(contextOf(f), fakeDeps(f, tasksOf(), { proposer: (d) => (d === "INV" ? proposal(dropped) : KEEP) }).deps, false));
    const inv = out.record.candidates[0]!;
    expect(inv.verdict).toBe("keep-base");
    expect(inv.why).toContain("h3 [soul] pass→fail");
    expect(out.record.verdict.winner).toBeNull();
    expect(out.record.verdict.reason).toBe("KEEP_BASE: no candidate passes T6");
  });

  test("under 6 held-out tasks the verdict is forced to keep-base, though T6 alone would adopt", async () => {
    const f = await fx();
    const five = HELD.slice(0, 5);
    const script = both(["t1", "h1", "h2"], ["h1"])(f);
    const tasks = tasksOf(five);
    const out = done(await runTune(contextOf(f, tasks), fakeDeps(f, tasks, { proposer: (d) => script(d) }).deps, false));
    const inv = out.record.candidates[0]!;
    expect(inv.selection!.verdict).toBe("adopt");
    expect(inv.verdict).toBe("keep-base");
    expect(inv.why).toContain("forced keep-base: the held-out set has 5 task(s), fewer than 6");
    expect(out.record.verdict.winner).toBeNull();
  });

  test("no train failure: nothing to learn from, no model call, KEEP_BASE", async () => {
    const f = await fx();
    const tasks = [task("t5", "train"), task("h3", "heldout"), ...["h1", "h2", "h4", "h5", "h6"].map((id) => task(id, "heldout"))];
    const fake = fakeDeps(f, tasks);
    const out = done(await runTune(contextOf(f, tasks), fake.deps, false));
    expect(fake.prompts).toEqual([]);
    expect(out.record.candidates.map((c) => c.outcome)).toEqual(["keep-base", "keep-base"]);
    expect(out.record.candidates[0]!.reason).toContain("nothing to learn from");
    expect(await branches(f)).toEqual([]);
  });
});

describe("what the proposer receives", () => {
  test("the asks and answers of train failures, and nothing of expect, reject, held-out text or person.md", async () => {
    const f = await fx();
    const tasks = tasksOf();
    const fake = fakeDeps(f, tasks, { proposer: () => KEEP });
    await runTune(contextOf(f, tasks), fake.deps, false);
    expect(fake.prompts.map((p) => [p.dimension, p.attempt])).toEqual([["INV", 1], ["DOM", 1]]);
    for (const { prompt } of fake.prompts) {
      for (const t of tasks.filter((x) => x.split === "heldout")) {
        expect(prompt).not.toContain(t.ask);
        for (const phrase of [...t.expect, ...t.reject]) expect(prompt).not.toContain(phrase);
      }
      // The train failures are there, with the agent's answer; their grading phrases are not.
      for (const id of ["t1", "t2", "t3", "t4"]) {
        expect(prompt).toContain(`Question ${id}?`);
        expect(prompt).not.toContain(`ok-${id}`);
        expect(prompt).not.toContain(`bad-${id}`);
      }
      expect(prompt).toContain("nope");
      // I-6: nothing from person.md (its body mark, its tone, its address for the user) is in a mission.
      for (const secret of [PERSON_MARK, "unhurried", "friend", "the keeper", "say what was skipped"]) expect(prompt).not.toContain(secret);
    }
  });

  test("a mission that would leak is refused before any model is asked: a held-out ask in the role body, a phrase outside the evidence", async () => {
    const f = await fx();
    await writeFile(join(f.soulDir, "role.md"), `${f.baseRole}\nRemember: Question h1?\n`);
    await g(f.agent, "commit", "-qam", "a held-out ask in the body");
    const fake = fakeDeps(f, tasksOf());
    const out = await runTune(contextOf(f), fake.deps, false);
    expect(out.kind).toBe("refused");
    expect(reasons(out)).toContain("held-out ask");
    expect(fake.prompts).toEqual([]);
    // A task's kind is printed outside the fence: a kind that is a grading phrase is a leak the relaxed mode still catches.
    const f2 = await fx();
    const tasks = tasksOf().map((t) => (t.id === "t1" ? { ...t, kind: "ok-t1" } : t));
    const fake2 = fakeDeps(f2, tasks);
    const out2 = await runTune(contextOf(f2, tasks), fake2.deps, false);
    expect(out2.kind).toBe("refused");
    expect(reasons(out2)).toContain('expect phrase "ok-t1"');
    expect(fake2.prompts).toEqual([]);
  });

  test("a passing train answer may hold its expect phrase (relaxed mode); held-out asks are checked everywhere", async () => {
    const f = await fx();
    const tasks = tasksOf();
    const fake = fakeDeps(f, tasks);
    const out = await runTune(contextOf(f, tasks), fake.deps, false);
    expect(out.kind).toBe("done");
    // t5 passes in the base: its answer "ok-t5" is in the mission's "do not break" section.
    expect(fake.prompts[0]!.prompt).toContain("ok-t5");
  });
});

describe("an invalid proposal", () => {
  test("is retried once with the issues listed; a good second answer is used", async () => {
    const f = await fx();
    const fake = fakeDeps(f, tasksOf(), { proposer: (d, attempt) => (d === "INV" ? (attempt === 1 ? "I think you should add more rules." : proposal(withRules(f, "t1", "h1"))) : KEEP) });
    const out = done(await runTune(contextOf(f), fake.deps, false));
    const inv = fake.prompts.filter((p) => p.dimension === "INV");
    expect(inv.map((p) => p.attempt)).toEqual([1, 2]);
    expect(inv[1]!.prompt).toContain("YOUR PREVIOUS ANSWER WAS REFUSED");
    expect(inv[1]!.prompt).toContain("<notes>");
    expect(out.record.candidates[0]).toMatchObject({ outcome: "edit", tries: 2 });
  });

  test("twice invalid is KEEP_BASE for that dimension only, and no branch for it", async () => {
    const f = await fx();
    const fake = fakeDeps(f, tasksOf(), { proposer: (d) => (d === "INV" ? "nonsense" : proposal(withRules(f, "t2", "h1"))) });
    const out = done(await runTune(contextOf(f), fake.deps, false));
    expect(fake.prompts.filter((p) => p.dimension === "INV")).toHaveLength(2);
    expect(out.record.candidates[0]).toMatchObject({ dimension: "INV", outcome: "keep-base", branch: null, tries: 2 });
    expect(out.record.candidates[0]!.reason).toContain("no usable proposal after two tries");
    expect(out.record.candidates[1]).toMatchObject({ dimension: "DOM", outcome: "edit" });
    expect(await branches(f)).toEqual([`tune/${out.record.runId}-dom`]);
  });

  test("a body over the size budget, or one that would be a second frontmatter fence, is invalid", async () => {
    const f = await fx();
    const big = `${withRules(f, "t1")}\n${"x".repeat(900)}`;
    const fence = `${withRules(f, "t1")}\n+++\nname = "Somebody Else"\n+++\n`;
    for (const body of [big, fence]) {
      const fake = fakeDeps(f, tasksOf(), { proposer: (d) => (d === "INV" ? proposal(body) : KEEP) });
      const out = done(await runTune(contextOf(f), fake.deps, false));
      expect(out.record.candidates[0]).toMatchObject({ outcome: "keep-base", tries: 2 });
      expect(await branches(f)).toEqual([]);
    }
  });

  test("a proposer that throws is retried once, then KEEP_BASE", async () => {
    const f = await fx();
    const fake = fakeDeps(f, tasksOf());
    const deps = { ...fake.deps, propose: async () => { throw new Error("the proposer's turn gave no answer (exit 1)"); } };
    const out = done(await runTune(contextOf(f), deps, false));
    expect(out.record.candidates.map((c) => c.outcome)).toEqual(["keep-base", "keep-base"]);
    expect(out.record.candidates[0]!.reason).toContain("the proposer did not answer");
  });
});

describe("the brake, asked between every step", () => {
  /** How many times a clean round asks, so each later point can be hit in turn. */
  async function asks(f: Fixture): Promise<number> {
    const script = (d: "INV" | "DOM") => proposal(withRules(f, d === "INV" ? "h1" : "h2"));
    const fake = fakeDeps(f, tasksOf(), { proposer: (d) => script(d) });
    done(await runTune(contextOf(f), fake.deps, false));
    return fake.calls.stoppedAsked;
  }

  test("at every point it is asked, setting it ends the round: no branch, no record, HEAD untouched", async () => {
    const probe = await fx();
    const total = await asks(probe);
    expect(total).toBeGreaterThanOrEqual(8);
    for (let at = 1; at <= total; at++) {
      const f = await fx();
      const before = await repoState(f);
      const script = (d: "INV" | "DOM") => proposal(withRules(f, d === "INV" ? "h1" : "h2"));
      const fake = fakeDeps(f, tasksOf(), { proposer: (d) => script(d), stopAt: at });
      const out = await runTune(contextOf(f), fake.deps, false);
      expect(["stopped", "refused"], `stop at ${at}`).toContain(out.kind);
      expect(await branches(f), `stop at ${at}`).toEqual([]);
      expect(await repoState(f), `stop at ${at}`).toBe(before);
      await expect(readdir(f.runs).catch(() => [])).resolves.toEqual([]);
    }
  }, 120_000);
});

describe("--dry-run", () => {
  test("builds both missions and checks the leak guard; no model, no eval, nothing written", async () => {
    const f = await fx();
    const fake = fakeDeps(f, tasksOf());
    const before = await repoState(f);
    const out = await runTune(contextOf(f), fake.deps, true);
    expect(out.kind).toBe("dry-run");
    const dry = out as Extract<TuneOutcome, { kind: "dry-run" }>;
    expect(dry.illustrative).toBe(true);
    expect(dry.missions.map((m) => m.dimension)).toEqual(["INV", "DOM"]);
    expect(dry.missions[0]!.mission).toContain("Question t1?");
    expect(fake.prompts).toEqual([]);
    expect(fake.calls.baseRuns).toBe(0);
    expect(await repoState(f)).toBe(before);
    await expect(readdir(f.runs).catch(() => [])).resolves.toEqual([]);
    const text = dryRunLines(dry, style).join("\n");
    expect(text).toContain("=== INV mission");
    expect(text).toContain("=== DOM mission");
    expect(text).toContain("leak guard: passed");
    expect(text).toContain("illustrative");
  });

  test("uses the newest recorded run of this soul and task set when there is one", async () => {
    const f = await fx();
    const tasks = tasksOf();
    const run = await fakeRun(f.baseRole, tasks, 1, f.subject, true, null);
    const fake = fakeDeps(f, tasks);
    const out = await runTune(contextOf(f, tasks), { ...fake.deps, recordedBase: async () => run }, true);
    expect((out as Extract<TuneOutcome, { kind: "dry-run" }>).illustrative).toBe(false);
    expect((out as Extract<TuneOutcome, { kind: "dry-run" }>).missions[0]!.mission).toContain("nope");
  });

  test("a leak is refused in a dry run too", async () => {
    const f = await fx();
    await writeFile(join(f.soulDir, "role.md"), `${f.baseRole}\nRemember: Question h2?\n`);
    await g(f.agent, "commit", "-qam", "leak");
    const out = await runTune(contextOf(f), fakeDeps(f, tasksOf()).deps, true);
    expect(out.kind).toBe("refused");
  });
});

describe("helpers", () => {
  test("usableBase: a plain run of the same soul and task set that kept its answers, newest first", async () => {
    const tasks = tasksOf();
    const mk = async (extra: Record<string, unknown>) => ({ ...(await fakeRun("role", tasks, 1, "example", true, null)), ...extra }) as Awaited<ReturnType<typeof fakeRun>>;
    const good = await mk({});
    const sha = good.evalsSha256;
    const content = good.soul.contentSha256;
    expect(usableBase([await mk({ keptAnswers: false }), await mk({ split: "train" }), await mk({ compare: { id: "c", role: "base", ref: "x", commit: "y" } }), await mk({ evalsSha256: "other" }), good], sha, content)).toBe(good);
    expect(usableBase([], sha, content)).toBeNull();
    expect(usableBase([good], sha, "other")).toBeNull();
  });

  test("costOf: total, else input + output, else unknown", () => {
    const usage = (total: number | null, input: number | null, output: number | null) => ({ usage: { total, input, output } });
    expect(costOf([usage(10, null, null), usage(null, 3, 4), usage(null, 3, null), {}])).toEqual({ turns: 4, tokens: 17, tokensUnknown: 2 });
  });
});
