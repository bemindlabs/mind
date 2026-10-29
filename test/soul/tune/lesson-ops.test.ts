/** S21.6 (D-196): `mind soul tune lessons` list, accept and reject, over a real tune record. */

import { afterEach, describe, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LESSONS_FILE, readDecisions, readLessons, renderEntry } from "../../../src/soul/lessons.ts";
import { acceptLesson, lessonLines, listProposed, rejectLesson, type LessonEnv } from "../../../src/soul/tune/lesson-ops.ts";
import { runTune } from "../../../src/soul/tune/round.ts";
import { KEEP, contextOf, fakeDeps, g, makeFixture, proposal, repoState, tasksOf, withRules, type Fixture } from "../../support/tune-fixture.ts";

const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});

const ROW = "<verdicts>\nrow: 1\npassage: Added: RULE-t1\ncandidates: INV\nchange: adds a rule for t1\nobserved: t1 passes now\nverdict: helped\n</verdicts>";
const LESSON = (cue = "A question about restarting a service after a deploy", lesson = "Check the unit before restarting it.") => `<lesson>\ncue: ${cue}\nlesson: ${lesson}\nevidence: rows 1: t1 passed once the check was named\n</lesson>`;

/** A fixture and one finished round whose reflection proposed `answer`'s lesson. */
async function proposed(answer = `${ROW}\n${LESSON()}`) {
  const f = await makeFixture();
  fixtures.push(f);
  const fake = fakeDeps(f, tasksOf(), { proposer: (d) => (d === "INV" ? proposal(withRules(f, "t1", "h1", "h2")) : KEEP), reflector: () => answer }, 2);
  const out = await runTune(contextOf(f, tasksOf(), 2), fake.deps, false);
  if (out.kind !== "done") throw new Error(out.kind);
  return { f, runId: out.record.runId };
}

const NOW = new Date("2026-10-20T12:00:00Z");
const envOf = (f: Fixture, over: Partial<LessonEnv> = {}): LessonEnv & { asked: number } => {
  const env = { agentDir: f.agent, runsDir: f.runs, interactive: true, confirm: async () => { env.asked += 1; return true; }, now: () => NOW, asked: 0, ...over };
  return env;
};
const style = { bold: (s: string) => s, dim: (s: string) => s };

describe("list", () => {
  test("shows cue, lesson, evidence, the rows it cites and which run; writes nothing", async () => {
    const { f, runId } = await proposed();
    const before = await repoState(f);
    const list = await listProposed(f.runs);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ run: runId, status: "proposed", base: f.head, lesson: { cue: "A question about restarting a service after a deploy" } });
    expect(list[0]!.rows).toMatchObject([{ row: 1, verdict: "helped" }]);
    const text = lessonLines(list, style, false).join("\n");
    expect(text).toContain(runId);
    expect(text).toContain("cue       A question about restarting a service after a deploy");
    expect(text).toContain("lesson    Check the unit before restarting it.");
    expect(text).toContain("row 1  helped");
    expect(text).toContain(`mind soul tune lessons accept ${runId}`);
    expect(await repoState(f)).toBe(before);
    expect(await Bun.file(join(f.agent, LESSONS_FILE)).exists()).toBe(false);
    expect(await readDecisions(f.runs)).toEqual([]);
  });

  test("nothing proposed, or nothing waiting, says so; --all lists the decided ones", async () => {
    const empty = await makeFixture();
    fixtures.push(empty);
    expect(await listProposed(join(empty.home, "nowhere"))).toEqual([]);
    expect(lessonLines([], style, false)[0]).toContain("No lesson waits for you");
    expect(lessonLines([], style, true)[0]).toContain("No lesson has been proposed");
    const { f, runId } = await proposed();
    await rejectLesson(envOf(f), runId);
    const list = await listProposed(f.runs);
    expect(lessonLines(list, style, false)[0]).toContain("No lesson waits for you");
    expect(lessonLines(list, style, true).join("\n")).toContain("refused (refused 2026-10-20)");
  });
});

describe("accept", () => {
  test("appends one entry to lessons.md, records the decision, commits nothing", async () => {
    const { f, runId } = await proposed();
    const head = await g(f.agent, "rev-parse", "HEAD");
    const env = envOf(f);
    const done = await acceptLesson(env, runId, tasksOf(), "");
    expect(done.ok).toBe(true);
    expect(env.asked).toBe(1);
    const read = await readLessons(f.agent);
    expect(read).toEqual({ ok: true, skipped: 0, entries: [{ cue: "A question about restarting a service after a deploy", lesson: "Check the unit before restarting it.", evidence: "rows 1: t1 passed once the check was named", run: runId, date: "2026-10-20", soul: f.head }] });
    expect(await readFile(join(f.agent, LESSONS_FILE), "utf8")).toContain(renderEntry(read.ok ? read.entries[0]! : (undefined as never)));
    // The owner commits it: HEAD has not moved, the file is untracked.
    expect(await g(f.agent, "rev-parse", "HEAD")).toBe(head);
    expect(await g(f.agent, "status", "--porcelain")).toBe(`?? ${LESSONS_FILE}`);
    expect((await readDecisions(f.runs)).map((d) => [d.run, d.outcome])).toEqual([[runId, "accepted"]]);
    expect((await listProposed(f.runs))[0]!.status).toBe("accepted");
    expect(done.ok && done.notice.join("\n")).toContain("Mind does not commit it");
  });

  test("a second lesson is appended after the first; the file stays one valid lessons file", async () => {
    const { f, runId } = await proposed();
    expect((await acceptLesson(envOf(f), runId, tasksOf(), "")).ok).toBe(true);
    const fake = fakeDeps(f, tasksOf(), { proposer: (d) => (d === "INV" ? proposal(withRules(f, "t1", "h1", "h2")) : KEEP), reflector: () => `${ROW}\n${LESSON("A weekly report with no date on it", "Put the date first.")}` }, 2);
    const out = await runTune(contextOf(f, tasksOf(), 2), fake.deps, false);
    if (out.kind !== "done") throw new Error(out.kind);
    expect((await acceptLesson(envOf(f), out.record.runId, tasksOf(), "")).ok).toBe(true);
    const read = await readLessons(f.agent);
    expect(read.ok && read.entries.map((e) => e.cue)).toEqual(["A question about restarting a service after a deploy", "A weekly report with no date on it"]);
  });

  test("without a terminal it is refused, and nothing is asked, written or recorded", async () => {
    const { f, runId } = await proposed();
    const env = envOf(f, { interactive: false });
    const done = await acceptLesson(env, runId, tasksOf(), "");
    expect(done).toMatchObject({ ok: false, reason: expect.stringContaining("needs a terminal") });
    expect(env.asked).toBe(0);
    expect(await Bun.file(join(f.agent, LESSONS_FILE)).exists()).toBe(false);
    expect(await readDecisions(f.runs)).toEqual([]);
  });

  test("an answer that is not yes writes nothing", async () => {
    const { f, runId } = await proposed();
    const done = await acceptLesson(envOf(f, { confirm: async () => false }), runId, tasksOf(), "");
    expect(done).toMatchObject({ ok: false, reason: expect.stringContaining("not yes") });
    expect(await Bun.file(join(f.agent, LESSONS_FILE)).exists()).toBe(false);
    expect((await listProposed(f.runs))[0]!.status).toBe("proposed");
  });

  test("the leak check runs again at accept time, against the task set as it is now", async () => {
    const { f, runId } = await proposed();
    // The set has changed since: a held-out ask now sits inside the lesson's cue.
    const later = tasksOf().map((t) => (t.id === "h2" ? { ...t, ask: "restarting a service after a deploy" } : t));
    const env = envOf(f);
    const done = await acceptLesson(env, runId, later, "");
    expect(done).toMatchObject({ ok: false, reason: expect.stringContaining("held-out ask") });
    expect(String(done.ok ? "" : done.reason)).not.toContain("restarting a service after a deploy");
    expect(env.asked).toBe(0);
    expect(await Bun.file(join(f.agent, LESSONS_FILE)).exists()).toBe(false);
    // A record edited by hand to hold personal text is refused the same way.
    const person = await acceptLesson(envOf(f), runId, tasksOf(), "Notes.\nCheck the unit before restarting it.");
    expect(person).toMatchObject({ ok: false, reason: expect.stringContaining("person.md") });
    expect(await readDecisions(f.runs)).toEqual([]);
  });

  test("an unknown run, a run with no lesson, a decided lesson, a foreign lessons.md", async () => {
    const { f, runId } = await proposed();
    expect(await acceptLesson(envOf(f), "tn-20200101T000000Z-aaaa", tasksOf(), "")).toMatchObject({ ok: false, reason: expect.stringContaining("no readable tune run") });
    expect(await acceptLesson(envOf(f), "nope", tasksOf(), "")).toMatchObject({ ok: false });
    await writeFile(join(f.agent, LESSONS_FILE), "notes of my own\n");
    expect(await acceptLesson(envOf(f), runId, tasksOf(), "")).toMatchObject({ ok: false, reason: expect.stringContaining("cannot be read") });
    expect(await readFile(join(f.agent, LESSONS_FILE), "utf8")).toBe("notes of my own\n");
    await Bun.$`rm ${join(f.agent, LESSONS_FILE)}`;
    expect((await acceptLesson(envOf(f), runId, tasksOf(), "")).ok).toBe(true);
    expect(await acceptLesson(envOf(f), runId, tasksOf(), "")).toMatchObject({ ok: false, reason: expect.stringContaining("already accepted") });
    const none = await proposed(`${ROW}\nNO_LESSON`);
    expect(await acceptLesson(envOf(none.f), none.runId, tasksOf(), "")).toMatchObject({ ok: false, reason: expect.stringContaining("proposed no lesson") });
  });
});

describe("reject", () => {
  test("is the owner's too, remembers the refusal 0600, writes nothing to the agent, and the next round does not propose the same lesson", async () => {
    const { f, runId } = await proposed();
    const before = await repoState(f);
    const env = envOf(f, { interactive: false });
    expect(await rejectLesson(env, runId)).toMatchObject({ ok: false, reason: expect.stringContaining("needs a terminal") });
    expect(await readDecisions(f.runs)).toEqual([]);
    expect((await rejectLesson(envOf(f), runId)).ok).toBe(true);
    expect((await stat(join(f.runs, "lessons-decisions.json"))).mode & 0o777).toBe(0o600);
    expect(await repoState(f)).toBe(before);
    expect(await Bun.file(join(f.agent, LESSONS_FILE)).exists()).toBe(false);
    expect(await rejectLesson(envOf(f), runId)).toMatchObject({ ok: false, reason: expect.stringContaining("already refused") });
    // The same lesson again, from a new round: not proposed, and not listed as waiting.
    const fake = fakeDeps(f, tasksOf(), { proposer: (d) => (d === "INV" ? proposal(withRules(f, "t1", "h1", "h2")) : KEEP), reflector: () => `${ROW}\n${LESSON()}` }, 2);
    const again = await runTune(contextOf(f, tasksOf(), 2), fake.deps, false);
    if (again.kind !== "done") throw new Error(again.kind);
    expect(again.record.reflection!.lesson).toBeNull();
    expect((await listProposed(f.runs)).filter((e) => e.status === "proposed")).toEqual([]);
    // Accepting it is refused too, since it was refused.
    expect(await acceptLesson(envOf(f), runId, tasksOf(), "")).toMatchObject({ ok: false, reason: expect.stringContaining("already refused") });
  });
});
