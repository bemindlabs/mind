/** S21.6 (D-196): the lessons.md format, the guard, the refusal memory and the matching rule. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DECISIONS_FILE, MAX_LESSON_CHARS, MAX_LESSONS, appendEntry, lessonKey, lessonOfHit, lessonProblems, parseLessons, readDecisions, readLessons, recordDecision, refusedKeys, renderEntry, selectLessons, wordsOf, writeLessonsFile, type LessonEntry } from "../../src/soul/lessons.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "mind-lessons-"));
  dirs.push(d);
  return d;
};

const entry = (over: Partial<LessonEntry> = {}): LessonEntry => ({ cue: "A question about restarting a service after a deploy", lesson: "Check the unit's status before restarting it, and say which unit you checked.", evidence: "rows 1, 2: t1 passed once the check was named", run: "tn-20261020T101500Z-ab12", date: "2026-10-20", soul: "a".repeat(40), ...over });
const SOURCES = { expect: ["zz-exp-1"], reject: ["zz-rej-1"], heldOutAsks: ["HELDOUT-ASK what is the gateway port?"] };

describe("the format", () => {
  test("an entry is written and read back, field for field", () => {
    const file = appendEntry(null, entry());
    expect(file.startsWith('+++\nschema = "mind/lessons@1"\n+++\n')).toBe(true);
    expect(file).toContain("## Lesson: A question about restarting a service after a deploy");
    const parsed = parseLessons(file);
    expect(parsed).toEqual({ ok: true, entries: [entry()], skipped: 0 });
  });

  test("a second and third entry append; order and content survive", () => {
    const two = entry({ cue: "A report with no date on it", run: "tn-20261021T101500Z-cd34" });
    const three = entry({ cue: "Third pattern here", lesson: "Do the third thing.", run: "tn-20261022T101500Z-ef56" });
    const file = appendEntry(appendEntry(appendEntry(null, entry()), two), three);
    expect(parseLessons(file)).toEqual({ ok: true, entries: [entry(), two, three], skipped: 0 });
    // One piece per entry for recall: three level-2 headings.
    expect(file.match(/^## /gm)).toHaveLength(3);
    expect(file.endsWith("\n")).toBe(true);
  });

  test("a long cue is cut in the heading only; whitespace in a value is one space", () => {
    const e = entry({ cue: `${"word ".repeat(40)}end`, lesson: "first line\nsecond   line" });
    const text = renderEntry(e);
    expect(text.split("\n")[0]!.length).toBeLessThan(100);
    const back = parseLessons(appendEntry(null, e));
    expect(back.ok && back.entries[0]!.lesson).toBe("first line second line");
    expect(back.ok && back.entries[0]!.cue).toBe(e.cue.replace(/\s+/g, " ").trim());
  });

  test("not a lessons file: no front matter, another schema; an incomplete entry is skipped and counted", () => {
    expect(parseLessons("## Lesson: x\n")).toMatchObject({ ok: false });
    expect(parseLessons('+++\nschema = "other@1"\n+++\n')).toMatchObject({ ok: false, reason: expect.stringContaining("mind/lessons@1") });
    const broken = `${appendEntry(null, entry())}\n## Lesson: half\n\n- cue: only a cue\n`;
    expect(parseLessons(broken)).toEqual({ ok: true, entries: [entry()], skipped: 1 });
  });

  test("readLessons: no file is none; an unreadable file says why; the file written is the file read", async () => {
    const dir = await tmp();
    expect(await readLessons(dir)).toEqual({ ok: true, entries: [], skipped: 0 });
    await writeFile(join(dir, "lessons.md"), "not a lessons file");
    expect(await readLessons(dir)).toMatchObject({ ok: false });
    const path = await writeLessonsFile(dir, appendEntry(null, entry()));
    expect(path).toBe(join(dir, "lessons.md"));
    expect(await readLessons(dir)).toEqual({ ok: true, entries: [entry()], skipped: 0 });
  });

  test("lessonOfHit names a lesson by its cue, and only for lessons.md", () => {
    const text = renderEntry(entry());
    expect(lessonOfHit({ path: "lessons.md", text })).toEqual({ cue: entry().cue, run: entry().run });
    expect(lessonOfHit({ path: "memory/a.md", text })).toBeNull();
    expect(lessonOfHit({ path: "lessons.md", text: "no fields" })).toBeNull();
  });
});

describe("the guard: nothing graded, nothing personal", () => {
  test("a clean lesson passes", () => {
    expect(lessonProblems(entry(), SOURCES, "tone: warm")).toEqual([]);
  });

  test("an expect phrase, a reject phrase and a held-out ask are each refused, in words that do not repeat them", () => {
    for (const [field, text, word] of [["lesson", "Always say zz-exp-1 first.", "expect phrase"], ["cue", "when zz-rej-1 appears", "reject phrase"], ["evidence", "rows 1: the HELDOUT-ASK what is the gateway port? task", "held-out ask"]] as const) {
      const problems = lessonProblems({ ...entry(), [field]: text }, SOURCES, "");
      expect(problems, field).toHaveLength(1);
      expect(problems[0]).toContain(word);
      for (const secret of ["zz-exp-1", "zz-rej-1", "HELDOUT-ASK", "gateway port"]) expect(problems.join("\n")).not.toContain(secret);
    }
  });

  test("a line of person.md (I-6) and the shapes the egress filter knows are refused", () => {
    const person = '+++\nname = "x"\n+++\n\nThe owner always walks the dog before eight.\n';
    expect(lessonProblems(entry({ lesson: "Remember: the owner always walks the dog before eight." }), SOURCES, person).join()).toContain("person.md");
    expect(lessonProblems(entry({ lesson: "Mail the summary to somebody@example.com." }), SOURCES, "").join()).toContain("personal");
    expect(lessonProblems(entry({ lesson: "Use the key AKIAIOSFODNN7EXAMPLE for it." }), SOURCES, "").join()).toMatch(/secret|personal/);
  });

  test("a field over the cap is refused", () => {
    expect(lessonProblems(entry({ lesson: "x ".repeat(400) }), SOURCES, "").join()).toContain("over 600 characters");
  });
});

describe("the refusal memory", () => {
  test("a decision is kept 0600 in a 0700 directory; a refused key is found; the key ignores case and spacing", async () => {
    const dir = join(await tmp(), "evals");
    await recordDecision(dir, { run: "tn-1", outcome: "refused", key: lessonKey(entry()), at: "2026-10-20T10:00:00Z" });
    await recordDecision(dir, { run: "tn-2", outcome: "accepted", key: "other", at: "2026-10-20T11:00:00Z" });
    expect((await stat(join(dir, DECISIONS_FILE))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await readDecisions(dir)).map((d) => d.outcome)).toEqual(["refused", "accepted"]);
    const refused = await refusedKeys(dir);
    expect(refused.has(lessonKey(entry()))).toBe(true);
    expect(refused.has(lessonKey({ cue: `  ${entry().cue.toUpperCase()} `, lesson: entry().lesson.replace(" ", "   ") }))).toBe(true);
    expect(refused.has("other")).toBe(false);
  });

  test("an unreadable or foreign decisions file is no decisions", async () => {
    const dir = await tmp();
    expect(await readDecisions(dir)).toEqual([]);
    await writeFile(join(dir, DECISIONS_FILE), "{ not json");
    expect(await readDecisions(dir)).toEqual([]);
    await writeFile(join(dir, DECISIONS_FILE), JSON.stringify({ schema: "x", decisions: [] }));
    expect(await readDecisions(dir)).toEqual([]);
  });
});

describe("the matching rule", () => {
  const options = { sources: SOURCES, personText: "" };
  const restart = entry();
  const report = entry({ cue: "A weekly report that has no date or owner on it", lesson: "Put the date and the owner first.", run: "tn-20261021T101500Z-cd34" });

  test("words: Unicode segments, short and common words dropped, Thai segmented", () => {
    expect([...wordsOf("How do I restart the gateway service?")].sort()).toEqual(["gateway", "restart", "service"]);
    expect(wordsOf("ตั้งค่าเกตเวย์ใหม่หลังการติดตั้ง").size).toBeGreaterThan(2);
  });

  test("a lesson needs two words of its cue in the failed asks; one is enough for a one-word cue", () => {
    const asks = ["How do I restart the gateway service after the deploy?"];
    expect(selectLessons([restart, report], asks, options).chosen).toEqual([restart]);
    expect(selectLessons([restart], ["What is a restart?"], options).chosen).toEqual([]);
    expect(selectLessons([entry({ cue: "Restarting" })], ["restarting a thing"], options).chosen).toHaveLength(1);
    expect(selectLessons([restart], [], options).chosen).toEqual([]);
  });

  test("best score first, then file order", () => {
    const strong = entry({ cue: "restart the gateway service after a deploy", run: "tn-strong" });
    const weak = entry({ cue: "restart the deploy", run: "tn-weak" });
    const asks = ["restart the gateway service after the deploy"];
    expect(selectLessons([weak, strong], asks, options).chosen.map((e) => e.run)).toEqual(["tn-strong", "tn-weak"]);
  });

  test("at most 3 lessons, and 1500 characters in all: one that does not fit is skipped, a smaller one after it fits", () => {
    expect(MAX_LESSONS).toBe(3);
    const many = [1, 2, 3, 4, 5].map((n) => entry({ cue: "restart the gateway service", run: `tn-${n}` }));
    expect(selectLessons(many, ["restart the gateway service"], options).chosen.map((e) => e.run)).toEqual(["tn-1", "tn-2", "tn-3"]);
    const big = entry({ cue: "restart the gateway service", lesson: "y".repeat(590), run: "tn-big" });
    const small = entry({ cue: "restart the gateway service", run: "tn-small" });
    const chosen = selectLessons([big, big, { ...big, run: "tn-big3" }, small], ["restart the gateway service"], options).chosen;
    expect(chosen.map((e) => e.run)).toEqual(["tn-big", "tn-big", "tn-small"]);
    expect(chosen.reduce((n, e) => n + e.cue.length + e.lesson.length + e.evidence.length, 0)).toBeLessThanOrEqual(MAX_LESSON_CHARS);
  });

  test("a hand-edited lesson that holds a held-out ask or a person.md line is left out and counted", () => {
    const bad = entry({ lesson: "Ask: HELDOUT-ASK what is the gateway port?", cue: "restarting a service after a deploy" });
    const out = selectLessons([bad, restart], ["restarting a service after a deploy"], options);
    expect(out.chosen).toEqual([restart]);
    expect(out.refused).toBe(1);
  });
});
