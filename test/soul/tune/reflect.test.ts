/** S21.6 (D-196): the reflection step of a round, with a scripted reflector over a real git repository. */

import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { appendEntry, lessonKey, recordDecision, writeLessonsFile } from "../../../src/soul/lessons.ts";
import { runTune, tuneLines, type TuneOutcome } from "../../../src/soul/tune/round.ts";
import { reflectInputOf, withoutLesson } from "../../../src/soul/tune/reflect.ts";
import { HELD, KEEP, fakeRun, PERSON_MARK, TRAIN, contextOf, fakeDeps, g, makeFixture, proposal, repoState, task, tasksOf, withRules, type Fixture } from "../../support/tune-fixture.ts";

const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});
async function fx(): Promise<Fixture> {
  const f = await makeFixture();
  fixtures.push(f);
  return f;
}
const done = (o: TuneOutcome) => {
  if (o.kind !== "done") throw new Error(`expected a finished round, got ${JSON.stringify(o).slice(0, 300)}`);
  return o;
};
const style = { bold: (s: string) => s, dim: (s: string) => s };

const ROW = (verdict: string) => `<verdicts>\nrow: 1\npassage: Added: RULE-t1\ncandidates: INV\nchange: adds a rule for t1\nobserved: t1 passes now, it failed before\nverdict: ${verdict}\n</verdicts>`;
const LESSON = (cue = "A question about restarting a service after a deploy", lesson = "Check the unit before restarting it.", evidence = "rows 1: t1 passed once the check was named") => `<lesson>\ncue: ${cue}\nlesson: ${lesson}\nevidence: ${evidence}\n</lesson>`;
const GOOD = `${ROW("helped")}\n${LESSON()}`;

/** INV adds t1, h1, h2; DOM keeps. Two rollouts, so a row may be something other than confounded. */
const round = async (f: Fixture, reflector: (attempt: 1 | 2, prompt: string) => string, tasks = tasksOf()) => {
  const fake = fakeDeps(f, tasks, { proposer: (d) => (d === "INV" ? proposal(withRules(f, "t1", "h1", "h2")) : KEEP), reflector }, 2);
  const out = done(await runTune(contextOf(f, tasks, 2), fake.deps, false));
  return { fake, out };
};

describe("a reflection that proposes a lesson", () => {
  test("rows and the one lesson are in the tune record; the winner is unchanged; nothing is written to the agent repository", async () => {
    const f = await fx();
    const before = await repoState(f);
    const { fake, out } = await round(f, () => GOOD);
    expect(fake.reflections).toHaveLength(1);
    expect(out.record.verdict.winner).toBe("INV");
    expect(out.record.reflection).toMatchObject({ status: "done", reason: "", tries: 1, lesson: { cue: "A question about restarting a service after a deploy", lesson: "Check the unit before restarting it.", rows: [1] } });
    expect(out.record.reflection!.rows).toMatchObject([{ row: 1, verdict: "helped", candidates: ["INV"] }]);
    // The proposal is in the record, which is outside git; the repository is as it was and has no lessons.md.
    expect(await repoState(f)).toBe(before);
    expect(await g(f.agent, "status", "--porcelain")).toBe("");
    expect(await Bun.file(join(f.agent, "lessons.md")).exists()).toBe(false);
    expect((await readdir(f.runs)).filter((n) => !n.startsWith("tn-"))).toEqual([]);
    const text = tuneLines(out.record, out.diffs, style).join("\n");
    expect(text).toContain("row 1  helped");
    expect(text).toContain("proposed lesson — cue: A question about restarting a service after a deploy");
    expect(text).toContain(`mind soul tune lessons accept ${out.record.runId}`);
  });

  test("the reflection input holds held-out results as numbers only: no held-out ask, no expect or reject phrase, nothing of person.md", async () => {
    const f = await fx();
    const tasks = tasksOf();
    const { fake } = await round(f, () => GOOD, tasks);
    const bytes = fake.reflections.map((r) => new TextEncoder().encode(r.prompt));
    expect(bytes.length).toBeGreaterThan(0);
    for (const raw of bytes) {
      const prompt = new TextDecoder().decode(raw);
      for (const t of tasks.filter((x) => x.split === "heldout")) {
        expect(prompt).not.toContain(t.ask);
        for (const phrase of [...t.expect, ...t.reject]) expect(prompt).not.toContain(phrase);
      }
      for (const t of tasks.filter((x) => x.split === "train")) for (const phrase of t.reject) expect(prompt).not.toContain(phrase);
      for (const secret of [PERSON_MARK, "unhurried", "friend", "the keeper"]) expect(prompt).not.toContain(secret);
      // What it is meant to hold: held-out as numbers, the train asks, a train contrast.
      expect(prompt).toMatch(/Held-out: 6 tasks, pass rate [\d.]+%, \d+ flipped from pass to fail against base\. Their asks are not shown\./);
      expect(prompt).toContain("Question t1?");
      expect(prompt).toContain("Added: RULE-t1 RULE-h1 RULE-h2");
    }
  });

  test("reflectInputOf: held-out arrives as a count, a rate and a flip count", async () => {
    const f = await fx();
    const input = reflectInputOf({ soul: undefined as never, tasks: tasksOf(), repeat: 2, base: await fakeRun(f.baseRole, tasksOf(), 2, "example", true, null), candidates: [] });
    expect(input.results[0]!.heldOut.tasks).toBe(6);
    expect(input.results[0]!.heldOut.passRate).toBeCloseTo(1 / 6, 2);
    expect(input.results[0]!.heldOut.passToFail).toBe(0);
    expect(Object.keys(input.results[0]!.heldOut).sort()).toEqual(["passRate", "passToFail", "tasks"]);
  });
});

describe("an invalid reflection", () => {
  test("is retried once with the issues listed; a good second answer is used", async () => {
    const f = await fx();
    const { fake, out } = await round(f, (attempt) => (attempt === 1 ? "I think it went well." : GOOD));
    expect(fake.reflections.map((r) => r.attempt)).toEqual([1, 2]);
    expect(fake.reflections[1]!.prompt).toContain("YOUR PREVIOUS ANSWER WAS REFUSED");
    expect(fake.reflections[1]!.prompt).toContain("a <verdicts> block is required");
    expect(out.record.reflection).toMatchObject({ status: "done", tries: 2, lesson: { cue: expect.any(String) } });
  });

  test("twice invalid is no lesson, and the round's verdict stands", async () => {
    const f = await fx();
    const { fake, out } = await round(f, () => "nonsense");
    expect(fake.reflections).toHaveLength(2);
    expect(out.record.reflection).toMatchObject({ status: "failed", tries: 2, rows: [], lesson: null });
    expect(out.record.reflection!.reason).toContain("no lesson: no usable answer after two tries");
    expect(out.record.verdict.winner).toBe("INV");
  });

  test("a reflector that throws is retried once, then no lesson", async () => {
    const f = await fx();
    const fake = fakeDeps(f, tasksOf(), { proposer: (d) => (d === "INV" ? proposal(withRules(f, "t1", "h1", "h2")) : KEEP) }, 2);
    const deps = { ...fake.deps, reflect: async () => { throw new Error("the proposer's turn gave no answer (exit 1)"); } };
    const out = done(await runTune(contextOf(f, tasksOf(), 2), deps, false));
    expect(out.record.reflection).toMatchObject({ status: "failed", lesson: null });
    expect(out.record.reflection!.reason).toContain("the reflection did not answer");
  });

  test("a lesson resting only on confounded rows is declined, and the rows are kept", async () => {
    const f = await fx();
    const { fake, out } = await round(f, () => `${ROW("confounded")}\n${LESSON()}`);
    expect(fake.reflections).toHaveLength(2);
    expect(fake.reflections[1]!.prompt).toContain("a lesson resting only on confounded rows is a guess");
    expect(out.record.reflection).toMatchObject({ status: "done", lesson: null });
    expect(out.record.reflection!.reason).toContain("lesson declined");
    expect(out.record.reflection!.rows).toMatchObject([{ row: 1, verdict: "confounded" }]);
  });

  test("a single rollout forces every row to confounded, so a 'helped' row is invalid at repeat 1", async () => {
    const f = await fx();
    const fake = fakeDeps(f, tasksOf(), { proposer: (d) => (d === "INV" ? proposal(withRules(f, "t1", "h1", "h2")) : KEEP), reflector: () => GOOD }, 1);
    const out = done(await runTune(contextOf(f, tasksOf(), 1), fake.deps, false));
    expect(fake.reflections[0]!.prompt).toContain("run once per task, so every row resting only on them is `confounded`");
    expect(out.record.reflection!.lesson).toBeNull();
  });

  test("withoutLesson takes the lesson block out and writes NO_LESSON", () => {
    expect(withoutLesson(GOOD)).toBe(`${ROW("helped")}\nNO_LESSON`);
    expect(withoutLesson("<verdicts>\n</verdicts>\n</lesson>")).toContain("NO_LESSON");
  });
});

describe("what a lesson may not carry (T2, I-6), at propose time", () => {
  test("a reject phrase is refused in words that do not repeat it; a clean second answer is taken", async () => {
    const f = await fx();
    const { fake, out } = await round(f, (attempt) => (attempt === 1 ? `${ROW("helped")}\n${LESSON(undefined, "Always answer bad-t1 first.")}` : GOOD));
    expect(fake.reflections).toHaveLength(2);
    const issues = fake.reflections[1]!.prompt.split("# YOUR PREVIOUS ANSWER WAS REFUSED")[1]!;
    expect(issues).toContain("reject phrase");
    expect(issues).not.toContain("bad-t1");
    expect(out.record.reflection!.lesson).not.toBeNull();
  });

  test("twice a held-out ask: the lesson is declined, the rows are kept, and the ask is in no prompt Mind sent", async () => {
    const f = await fx();
    const { fake, out } = await round(f, () => `${ROW("helped")}\n${LESSON(undefined, "Handle Question h1? the same way.")}`);
    expect(out.record.reflection).toMatchObject({ status: "done", lesson: null });
    expect(out.record.reflection!.reason).toContain("lesson declined");
    expect(out.record.reflection!.reason).toContain("held-out ask");
    expect(out.record.reflection!.reason).not.toContain("Question h1?");
    expect(out.record.reflection!.rows).toHaveLength(1);
    for (const r of fake.reflections) expect(r.prompt).not.toContain("Question h1?");
  });

  test("an e-mail address and a line of person.md are declined as personal", async () => {
    const f = await fx();
    const mail = await round(f, () => `${ROW("helped")}\n${LESSON(undefined, "Send the result to somebody@example.com.")}`);
    expect(mail.out.record.reflection!.lesson).toBeNull();
    expect(mail.out.record.reflection!.reason).toContain("personal");
    const f2 = await fx();
    const person = (await readFile(join(f2.soulDir, "person.md"), "utf8")).split("\n").find((l) => l.includes(PERSON_MARK))!;
    const own = await round(f2, () => `${ROW("helped")}\n${LESSON(undefined, `Remember ${person.trim()} always.`)}`);
    expect(own.out.record.reflection!.lesson).toBeNull();
    expect(own.out.record.reflection!.reason).toContain("person.md");
  });

  test("a leak in what the reflection would be sent (a held-out ask in a proposer's notes) stops the call; the round still finishes", async () => {
    const f = await fx();
    const tasks = tasksOf();
    const fake = fakeDeps(f, tasks, { proposer: (d) => (d === "INV" ? proposal(withRules(f, "t1", "h1"), "answers Question h1? too") : KEEP) }, 2);
    const out = done(await runTune(contextOf(f, tasks, 2), fake.deps, false));
    expect(fake.reflections).toEqual([]);
    expect(out.record.reflection).toMatchObject({ status: "skipped", lesson: null });
    expect(out.record.reflection!.reason).toContain("leak guard refused the reflection's input");
    expect(out.record.verdict.winner).not.toBeUndefined();
  });
});

describe("what is not proposed", () => {
  test("no candidate changed the body: nothing is asked", async () => {
    const f = await fx();
    const fake = fakeDeps(f, tasksOf(), { reflector: () => GOOD }, 2);
    const out = done(await runTune(contextOf(f, tasksOf(), 2), fake.deps, false));
    expect(fake.reflections).toEqual([]);
    expect(out.record.reflection).toMatchObject({ status: "skipped", rows: [], lesson: null });
  });

  test("a lesson the owner refused is not proposed again, though another run proposes it", async () => {
    const f = await fx();
    await recordDecision(f.runs, { run: "tn-20260101T000000Z-aaaa", outcome: "refused", key: lessonKey({ cue: "A question about restarting a service after a deploy", lesson: "Check the unit before restarting it." }), at: "2026-01-01T00:00:00Z" });
    const { out } = await round(f, () => GOOD);
    expect(out.record.reflection).toMatchObject({ status: "done", lesson: null });
    expect(out.record.reflection!.reason).toContain("refused or accepted before");
    expect(out.record.reflection!.rows).toHaveLength(1);
  });

  test("a lesson already in lessons.md is not proposed again", async () => {
    const f = await fx();
    await writeLessonsFile(f.agent, appendEntry(null, { cue: "A question about restarting a service after a deploy", lesson: "Check the unit before restarting it.", evidence: "rows 1: x", run: "tn-20260101T000000Z-aaaa", date: "2026-01-01", soul: f.head }));
    const { out } = await round(f, () => GOOD);
    expect(out.record.reflection!.lesson).toBeNull();
    expect(out.record.reflection!.reason).toContain("refused or accepted before");
  });
});

describe("accepted lessons reach the next round's proposers", () => {
  const ASK = "How do I restart the gateway service after a deploy?";
  const tasks = () => [...TRAIN.map((id) => task(id, "train", { ask: id === "t1" ? ASK : `Question ${id}?` })), ...HELD.map((id) => task(id, "heldout"))];

  test("a lesson whose cue matches the failed asks is in the proposer mission and named in the record; one that does not match is not", async () => {
    const f = await fx();
    const e = { evidence: "rows 1: t1 passed once the unit was named", date: "2026-10-20", soul: f.head };
    let file = appendEntry(null, { ...e, cue: "A question about restarting a service after a deploy", lesson: "Name the unit before you restart it.", run: "tn-20261020T101500Z-ab12" });
    file = appendEntry(file, { ...e, cue: "A weekly report that has no owner on it", lesson: "Put the owner first.", run: "tn-20261021T101500Z-cd34" });
    await writeLessonsFile(f.agent, file);
    const fake = fakeDeps(f, tasks());
    const out = done(await runTune(contextOf(f, tasks()), fake.deps, false));
    const mission = fake.prompts[0]!.prompt;
    expect(mission).toContain("Name the unit before you restart it.");
    expect(mission).not.toContain("Put the owner first.");
    expect(out.record.lessonsShown).toEqual(["tn-20261020T101500Z-ab12"]);
    // Nothing matches, nothing is shown.
    const f2 = await fx();
    await writeLessonsFile(f2.agent, file);
    const plain = fakeDeps(f2, tasksOf());
    done(await runTune(contextOf(f2), plain.deps, false));
    expect(plain.prompts[0]!.prompt).toContain("None yet.");
  });

  test("a lesson that holds a held-out ask (a hand-edited lessons.md) is not carried", async () => {
    const f = await fx();
    await writeLessonsFile(f.agent, appendEntry(null, { cue: "A question about restarting a service after a deploy", lesson: "Treat Question h1? as the same thing.", evidence: "rows 1: x", run: "tn-20261020T101500Z-ab12", date: "2026-10-20", soul: f.head }));
    const fake = fakeDeps(f, tasks());
    const out = done(await runTune(contextOf(f, tasks()), fake.deps, false));
    expect(out.record.lessonsShown).toEqual([]);
    expect(fake.prompts[0]!.prompt).not.toContain("Question h1?");
  });

  test("--dry-run shows the lesson too, and still calls no model", async () => {
    const f = await fx();
    await writeLessonsFile(f.agent, appendEntry(null, { cue: "A question about restarting a service after a deploy", lesson: "Name the unit before you restart it.", evidence: "rows 1: x", run: "tn-20261020T101500Z-ab12", date: "2026-10-20", soul: f.head }));
    const fake = fakeDeps(f, tasks());
    const out = await runTune(contextOf(f, tasks()), fake.deps, true);
    expect(out.kind).toBe("dry-run");
    expect(out.kind === "dry-run" && out.missions[0]!.mission).toContain("Name the unit before you restart it.");
    expect(fake.prompts).toEqual([]);
    expect(fake.reflections).toEqual([]);
  });
});
