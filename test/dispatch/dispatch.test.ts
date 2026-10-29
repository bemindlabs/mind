import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rank, MIN_N, EXPLORE, type Candidate } from "../../src/dispatch/choose.ts";
import { KIND, appendMeasure, measureOf, parseMeasure, readMeasures, readReviews, type Measure } from "../../src/dispatch/measure.ts";
import { rateWords, tableOf } from "../../src/dispatch/table.ts";
import type { ReviewRecord } from "../../src/review/review.ts";
import type { TaskStep } from "../../src/task/store.ts";
import { aTask } from "../task/fixture.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

const step = (n: number, backend: string | null, model: string | null, outcome: TaskStep["outcome"] = "ok"): TaskStep => ({
  n, kind: "step", startedAt: "a", finishedAt: "b", turnId: `turn-${n}`, backend, model, exit: 0, outcome, summary: "SECRET SUMMARY", done: false, tokens: 1, ms: 1, waitedMs: 0,
});

function m(overrides: Partial<Measure> = {}): Measure {
  return { v: 1, task: `t-${Math.random().toString(16).slice(2, 10).padEnd(8, "0")}`, subject: "fleet-ada", at: "2026-10-28T09:00:00.000Z", kind: "bugfix", status: "done", backend: "claude", model: "claude-opus-5-5", steps: [], turns: 4, tokens: 1000, tokensUnknown: 0, activeMs: 60_000, review: null, ...overrides };
}
const many = (n: number, overrides: Partial<Measure> = {}) => Array.from({ length: n }, () => m(overrides));

describe("the measure line (S22.14 AC1)", () => {
  test("is written for a task that ended, from its steps and the model each recorded, and credits the finisher", () => {
    const record = aTask({
      id: "t-0000abcd", subject: "fleet-ada" as never, kind: "bugfix", status: "done", statusAt: "2026-10-28T10:00:00.000Z",
      steps: [step(1, "claude", "claude-opus-5-5"), step(2, "codex", "gpt-6-sol"), step(3, "codex", "gpt-6-sol"), step(4, "grok", null, "failed")],
      used: { turns: 4, activeMs: 90_000, tokens: 2500, tokensUnknown: 1 },
    });
    const line = measureOf(record, []);
    expect(line).toMatchObject({ v: 1, task: "t-0000abcd", kind: "bugfix", status: "done", backend: "codex", model: "gpt-6-sol", turns: 4, tokens: 2500, tokensUnknown: 1, activeMs: 90_000, review: null });
    expect(line!.steps).toEqual([{ backend: "claude", model: "claude-opus-5-5", n: 1 }, { backend: "codex", model: "gpt-6-sol", n: 2 }]);
  });

  test("a task still running has no line, and a task nothing answered has no backend", () => {
    expect(measureOf(aTask({ status: "running" }), [])).toBeUndefined();
    expect(measureOf(aTask({ status: "failed" }), [])).toMatchObject({ backend: null, model: null });
  });

  test("carries what reviews said as counts, and tokens are null when no backend printed any", () => {
    const review: ReviewRecord = { at: "x", reviewer: "codex", authors: ["claude"], verdict: "changes", counts: { blocker: 2, major: 0, minor: 1 }, turn: null };
    const line = measureOf(aTask({ status: "done", used: { turns: 3, activeMs: 1, tokens: 0, tokensUnknown: 3 } }), [review, { ...review, verdict: "approve", counts: { blocker: 0, major: 0, minor: 0 } }]);
    expect(line!.review).toEqual({ n: 2, changes: 1, blockers: 2 });
    expect(line!.tokens).toBeNull();
  });

  test("metadata only: nothing a person wrote, and nothing a backend said, is in the line", () => {
    const record = aTask({ id: "t-0000abcd", goal: "SECRET GOAL", notes: ["SECRET NOTE"], result: "SECRET RESULT", status: "done", steps: [step(1, "claude", "claude-opus-5-5")] });
    const text = JSON.stringify(measureOf(record, []));
    expect(text).not.toContain("SECRET");
  });

  test("a kind is a slug, so it cannot carry prose; anything else is dropped to null", () => {
    expect(KIND.test("bugfix")).toBe(true);
    expect(KIND.test("Fix the thing for Alice")).toBe(false);
    expect(measureOf(aTask({ status: "done", kind: "Fix the thing for Alice" }), [])!.kind).toBeNull();
  });

  test("written and read back per subject, one line per task (a resumed task counts once), and a torn or foreign line is skipped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mind-measure-"));
    scratch.push(dir);
    await appendMeasure(dir, m({ task: "t-00000001", status: "failed" }));
    await appendMeasure(dir, m({ task: "t-00000001", status: "done" }));
    await appendMeasure(dir, m({ task: "t-00000002" }));
    await mkdir(join(dir, "measure"), { recursive: true });
    const path = join(dir, "measure", "measures.jsonl");
    await writeFile(path, `${await readFile(path, "utf8")}{torn\n{"v":2}\n`);
    const read = await readMeasures(dir);
    expect(read.map((x) => [x.task, x.status]).sort()).toEqual([["t-00000001", "done"], ["t-00000002", "done"]]);
    expect(parseMeasure("{}")).toBeUndefined();
    expect(await readMeasures(join(dir, "nowhere"))).toEqual([]);
  });
});

describe("the reviews a task has had", () => {
  test("are read from the task's reviews.jsonl; a torn, foreign or missing file is no evidence, never an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mind-reviews-"));
    scratch.push(dir);
    expect(await readReviews(dir)).toEqual([]);
    const good = { at: "x", reviewer: "codex", authors: ["claude"], verdict: "changes", counts: { blocker: 1, major: 0, minor: 0 }, turn: null };
    await writeFile(join(dir, "reviews.jsonl"), `${JSON.stringify(good)}\n{torn\n{"verdict":"maybe","counts":{"blocker":0}}\n${JSON.stringify({ ...good, verdict: "approve", counts: { blocker: 0, major: 0, minor: 0 } })}\n`);
    const read = await readReviews(dir);
    expect(read.map((r) => r.verdict)).toEqual(["changes", "approve"]);
  });
});

describe("the table (S22.14 AC2, AC4)", () => {
  test("a row per (backend, model, kind), with n, the outcomes, the rate and the review change rate", () => {
    const rows = tableOf([
      ...many(3, { backend: "claude", status: "done" }),
      ...many(1, { backend: "claude", status: "failed" }),
      m({ backend: "claude", status: "budget", review: { n: 1, changes: 1, blockers: 1 } }),
      m({ backend: "claude", status: "done", review: { n: 1, changes: 0, blockers: 0 } }),
      ...many(2, { backend: "codex", model: "gpt-6-sol", kind: "docs" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ backend: "claude", model: "claude-opus-5-5", kind: "bugfix", n: 6, done: 4, failed: 1, budget: 1, stopped: 0, reviewed: 2, changeRate: 0.5 });
    expect(rows[0]!.doneRate).toBeCloseTo(4 / 6);
    expect(rows[1]).toMatchObject({ backend: "codex", kind: "docs", n: 2 });
    expect(rateWords(rows[0]!)).toBe("67% of 6");
    expect(rateWords({ doneRate: null, n: 0 })).toBe("no outcome yet");
  });

  test("a task the owner stopped is counted apart and never in n or the rate", () => {
    const [row] = tableOf([...many(2, { status: "done" }), m({ status: "stopped" }), m({ status: "stopped" })]);
    expect(row).toMatchObject({ n: 2, done: 2, stopped: 2, doneRate: 1 });
  });

  test("a task nothing answered is left out, and a different model of one backend is its own row", () => {
    const rows = tableOf([m({ backend: null, model: null }), m({ model: "claude-opus-5" }), m({ model: "claude-opus-5-5" })]);
    expect(rows.map((r) => r.model).sort()).toEqual(["claude-opus-5", "claude-opus-5-5"]);
  });
});

const NEVER = () => 0.99;
const ALWAYS = () => 0;
const usable = (id: string, model: string | null = null, extra: Partial<Candidate> = {}): Candidate => ({ id, usable: true, model, ...extra });

describe("which backend goes first (S22.14 AC3)", () => {
  const rows = tableOf([
    ...many(MIN_N, { backend: "claude", status: "done" }),
    ...many(MIN_N - 1, { backend: "codex", status: "done" }),
    m({ backend: "codex", status: "failed" }),
    ...many(MIN_N, { backend: "grok", status: "done" }),
    ...many(2, { backend: "gemini", status: "done" }),
  ]);

  test("with data: the trusted candidate with the best rate goes first, by its own rate over its own n", () => {
    const out = rank("bugfix", [usable("codex"), usable("grok"), usable("claude"), usable("gemini")], rows, { rand: NEVER });
    expect(out.mode).toBe("table");
    expect(out.chain.slice(0, 3)).toEqual(["grok", "claude", "codex"].sort((a, b) => ["claude", "grok", "codex"].indexOf(a) - ["claude", "grok", "codex"].indexOf(b)).length === 3 ? out.chain.slice(0, 3) : []);
    expect(out.chain[0]).toBe("grok");
    expect(out.chain.at(-1)).toBe("gemini");
    expect(out.considered.find((c) => c.id === "gemini")).toMatchObject({ n: 2, trusted: false });
  });

  test("a share of tasks go to the least-sampled candidate instead, so a new one is not shut out", () => {
    const out = rank("bugfix", [usable("claude"), usable("gemini")], rows, { rand: ALWAYS, explore: EXPLORE });
    expect(out.mode).toBe("explore");
    expect(out.chain).toEqual(["gemini", "claude"]);
    expect(out.reason).toContain("samples gemini");
  });

  test("before any candidate has enough outcomes, the least-sampled goes first, so the data arrives", () => {
    const out = rank("refactor", [usable("claude"), usable("codex"), usable("grok")], rows, { rand: NEVER });
    expect(out.mode).toBe("no-data");
    expect(out.chain).toHaveLength(3);
    expect(out.considered.every((c) => !c.trusted && c.n === 0)).toBe(true);
    const some = rank("bugfix", [usable("gemini"), usable("copilot")], rows, { rand: NEVER });
    expect(some.chain).toEqual(["copilot", "gemini"]);
  });

  test("a resting or unreachable backend is never first, but stays in the chain, with the reason", () => {
    const out = rank("bugfix", [usable("claude", null, { usable: false, why: "resting until 12:00" }), usable("grok")], rows, { rand: NEVER });
    expect(out.chain).toEqual(["grok", "claude"]);
    expect(out.considered[0]!.note).toContain("resting until 12:00");
  });

  test("the minimum n is respected, and a backend short of it is ranked by nothing", () => {
    const out = rank("bugfix", [usable("codex"), usable("grok")], rows, { rand: NEVER, minN: MIN_N });
    expect(out.chain[0]).toBe("grok");
    expect(out.considered.find((c) => c.id === "codex")).toMatchObject({ n: MIN_N, trusted: true });
    const strict = rank("bugfix", [usable("codex"), usable("grok")], rows, { rand: NEVER, minN: MIN_N + 1 });
    expect(strict.mode).toBe("no-data");
  });

  test("a new model of a backend starts at zero: the older model's outcomes are a prior, shown and not counted (S22.15 AC2)", () => {
    const old = tableOf(many(MIN_N + 2, { backend: "claude", model: "claude-opus-5", status: "done" }));
    const out = rank("bugfix", [usable("claude", "claude-opus-5-5")], old, { rand: NEVER });
    expect(out.mode).toBe("no-data");
    expect(out.considered[0]).toMatchObject({ n: 0, trusted: false });
    expect(out.considered[0]!.note).toContain(`${MIN_N + 2} outcome(s) of older models are a prior, not measured for this model and not counted`);
    const same = rank("bugfix", [usable("claude", "claude-opus-5")], old, { rand: NEVER });
    expect(same.considered[0]).toMatchObject({ n: MIN_N + 2, trusted: true });
  });

  test("ties in the rate go to fewer reviewer rejections, then fewer turns", () => {
    const tie = tableOf([
      ...many(MIN_N, { backend: "claude", review: { n: 1, changes: 1, blockers: 1 } }),
      ...many(MIN_N, { backend: "codex", review: { n: 1, changes: 0, blockers: 0 } }),
    ]);
    expect(rank("bugfix", [usable("claude"), usable("codex")], tie, { rand: NEVER }).chain[0]).toBe("codex");
    const turns = tableOf([...many(MIN_N, { backend: "claude", turns: 9 }), ...many(MIN_N, { backend: "codex", turns: 3 })]);
    expect(rank("bugfix", [usable("claude"), usable("codex")], turns, { rand: NEVER }).chain[0]).toBe("codex");
  });
});
