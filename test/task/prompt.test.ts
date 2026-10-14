import { describe, expect, test } from "bun:test";
import { activeLimitMs, budgetSpent, stepTimeoutMs, wholeNumber } from "../../src/task/budget.ts";
import { browserTaskProblem, browserToolTimeoutMs } from "../../src/task/policy.ts";
import { lastBlock, planPrompt, readPlan, readStep, stepPrompt, TASK_BLOCK } from "../../src/task/prompt.ts";
import { aTask, said } from "./fixture.ts";

describe("what a task's turns are asked (D-154)", () => {
  test("the plan turn quotes the goal, says what browser it has, and asks for a plan only", () => {
    const text = planPrompt(aTask({ goal: "fill the form" }));
    expect(text).toContain("<<<\nfill the form\n>>>");
    expect(text).toContain("no web browser");
    expect(text).toContain("Do not carry any of them out yet");
    expect(text).toContain("```mind-task");
    expect(planPrompt(aTask({ operate: 1, allow: ["http://a:1"] }))).toContain("cannot click or type");
    expect(planPrompt(aTask({ operate: 2, allow: [] }))).toContain("on: no site");
  });

  test("a step's turn gets the plan, what was done, the notes, and the next step only", () => {
    const step = { n: 1, kind: "step" as const, startedAt: "a", finishedAt: "b", turnId: "t", backend: "x", exit: 0, outcome: "ok" as const, summary: "opened the page", done: false, tokens: 1, ms: 1, waitedMs: 0 };
    const text = stepPrompt(aTask({ plan: ["open", "fill"], steps: [step, { ...step, n: 2, outcome: "interrupted", summary: "cut" }], notes: ["the owner said no"], operate: 2, allow: ["http://a:1"] }));
    expect(text).toContain("1. open\n2. fill");
    expect(text).toContain("- step 1: opened the page");
    expect(text).toContain("- step 2 (interrupted): cut");
    expect(text).toContain("Since the last step:\n- the owner said no");
    expect(text).toContain("pause until the person says yes");
    const empty = stepPrompt(aTask({ plan: [] }));
    expect(empty).toContain("(none was made");
    expect(empty).toContain("(nothing yet)");
    expect(empty).not.toContain("Since the last step");
  });

  test("the last task block is read; a json block is the fallback; nothing is guessed", () => {
    expect(lastBlock(`${said({ a: 1 })}\n${said({ a: 2 })}`)).toEqual({ a: 2 });
    expect(lastBlock("```json\n{\"b\":1}\n```")).toEqual({ b: 1 });
    expect(lastBlock(`${said({ a: 1 })}\n\`\`\`json\n{"b":1}\n\`\`\``)).toEqual({ a: 1 });
    expect(lastBlock(`\`\`\`${TASK_BLOCK}\n{bad\n\`\`\``)).toBeUndefined();
    expect(lastBlock("no block")).toBeUndefined();
  });

  test("the block's fence is mind-task, and the step prompt asks for it too", () => {
    expect(TASK_BLOCK).toBe("mind-task");
    expect(stepPrompt(aTask({ plan: ["a"] }))).toContain("```mind-task\n");
  });

  test("a plan is a list of words; an empty or missing one is unreadable", () => {
    expect(readPlan(said({ plan: ["a", " ", 3, "b"] }))).toEqual({ ok: true, plan: ["a", "b"] });
    expect(readPlan(said({ plan: [] }))).toEqual({ ok: false });
    expect(readPlan(said({ steps: ["a"] }))).toEqual({ ok: false });
    expect(readPlan("nothing")).toEqual({ ok: false });
    const long = readPlan(said({ plan: Array.from({ length: 30 }, (_, i) => `s${i}`) }));
    expect(long.ok && long.plan.length).toBe(12);
  });

  test("a step says done or not, with a summary; without a block the answer's start is the summary", () => {
    expect(readStep(said({ done: false, summary: "  typed   it " }))).toEqual({ ok: true, done: false, summary: "typed it", result: null });
    expect(readStep(said({ done: true, summary: "", result: "42" }, "all done"))).toEqual({ ok: true, done: true, summary: "all done", result: "42" });
    expect(readStep("I did a thing")).toEqual({ ok: false, summary: "I did a thing" });
    expect(readStep(said({ done: "yes" }))).toMatchObject({ ok: false });
    expect(readStep("")).toEqual({ ok: false, summary: "(no answer text)" });
    expect((readStep(said({ done: false, summary: "x".repeat(2000) })) as { summary: string }).summary.length).toBe(600);
  });
});

describe("a task's budget", () => {
  test("turns, active minutes and tokens each end it, and say which", () => {
    expect(budgetSpent(aTask())).toBeUndefined();
    expect(budgetSpent(aTask({ used: { turns: 12, activeMs: 0, tokens: 0, tokensUnknown: 0 } }))).toContain("12 turn(s)");
    expect(budgetSpent(aTask({ used: { turns: 1, activeMs: 30 * 60_000, tokens: 0, tokensUnknown: 0 } }))).toContain("30 minute(s)");
    expect(budgetSpent(aTask({ budget: { turns: 9, minutes: 9, tokens: 100 }, used: { turns: 1, activeMs: 0, tokens: 100, tokensUnknown: 2 } }))).toContain("2 step(s) reported none");
    expect(budgetSpent(aTask({ budget: { turns: 9, minutes: 9, tokens: 100 }, used: { turns: 1, activeMs: 0, tokens: 100, tokensUnknown: 0 } }))).toBe("its budget of 100 token(s) is spent (100 counted)");
  });

  test("a step's timeout is its own or the minutes left, at least ten seconds, plus room for every hold at operate 2", () => {
    expect(stepTimeoutMs(aTask({ stepSeconds: 60 }))).toBe(60_000);
    expect(stepTimeoutMs(aTask({ stepSeconds: 600, budget: { turns: 1, minutes: 2, tokens: null }, used: { turns: 0, activeMs: 90_000, tokens: 0, tokensUnknown: 0 } }))).toBe(30_000);
    expect(stepTimeoutMs(aTask({ budget: { turns: 1, minutes: 1, tokens: null }, used: { turns: 0, activeMs: 120_000, tokens: 0, tokensUnknown: 0 } }))).toBe(10_000);
    expect(stepTimeoutMs(aTask({ stepSeconds: 60, operate: 2, approvalSeconds: 30 }))).toBe(60_000 + 4 * 30_000);
    expect(activeLimitMs(aTask({ stepSeconds: 60, operate: 2, approvalSeconds: 30 }))).toBe(60_000);
    expect(browserToolTimeoutMs(aTask({ operate: 2, approvalSeconds: 30 }))).toBe(150_000);
    expect(browserToolTimeoutMs(aTask({ operate: 1 }))).toBeUndefined();
  });

  test("numbers on the command line are whole, and in range", () => {
    expect(wholeNumber(undefined, "--x", 1, 5)).toEqual({ ok: true, value: undefined });
    expect(wholeNumber("3", "--x", 1, 5)).toEqual({ ok: true, value: 3 });
    expect(wholeNumber("3.5", "--x", 1, 5)).toEqual({ ok: false, reason: "--x takes a whole number" });
    expect(wholeNumber("0x3", "--x", 1, 5)).toMatchObject({ ok: false });
    expect(wholeNumber("9", "--x", 1, 5)).toEqual({ ok: false, reason: "--x must be 1–5" });
  });
});

describe("what a step with a browser may run on (D-155, D-157)", () => {
  test("claude and claude-local only, and only while the dial lets the browser be used", () => {
    expect(browserTaskProblem(["claude-local"], 2)).toBeUndefined();
    expect(browserTaskProblem(["claude", "claude-local"], 1)).toBeUndefined();
    expect(browserTaskProblem(["claude-local", "grok-local"], 2)).toContain("grok-local");
    expect(browserTaskProblem([], 2)).toContain("nothing");
    expect(browserTaskProblem(["claude"], 0)).toContain("browser level for this turn is 0");
  });
});

describe("the task a turn's --task names", () => {
  test("found when it is this subject's and has not ended; said otherwise", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { taskForTurn } = await import("../../src/task/policy.ts");
    const { createTask } = await import("../../src/task/store.ts");
    const { SUBJECT } = await import("./fixture.ts");
    const home = await mkdtemp(join(tmpdir(), "mind-task-policy-"));
    try {
      const env = { home, env: { XDG_DATA_HOME: join(home, "data") } };
      const tasks = join(home, "data", "mind", SUBJECT, "personal", "tasks");
      await createTask(tasks, aTask());
      await createTask(tasks, aTask({ id: "t-0000abce", status: "stopped" }));
      expect((await taskForTurn(env, SUBJECT, "t-0000abcd")).ok).toBe(true);
      expect(await taskForTurn(env, SUBJECT, "t-0000abce")).toEqual({ ok: false, reason: "task t-0000abce is stopped; its steps are over" });
      expect((await taskForTurn(env, SUBJECT, "t-11111111")).ok).toBe(false);
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(home, "data", ".git"));
      expect((await taskForTurn(env, SUBJECT, "t-0000abcd")).ok).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("a step of a task with a browser acts through the browser only (review of PR #24)", () => {
  test("write and run are held at 1; reach and operate keep their levels; a lower dial is left alone", async () => {
    const { browserOnly, effectiveDial } = await import("../../src/decide/effective.ts");
    const at = (write: 0 | 1 | 2, run: 0 | 1 | 2) =>
      effectiveDial({ stored: { read: 2, write, run, reach: 2, operate: 2, setBy: null, setAt: null }, source: "file", envValue: undefined, stopped: false });
    const held = browserOnly(at(2, 2));
    expect([held.act, held.operate, held.dial.write, held.dial.run, held.dial.reach]).toEqual([1, 2, 1, 1, 2]);
    expect(held.clamps.map((c) => c.category)).toEqual(expect.arrayContaining(["write", "run"]));
    expect(held.notes.at(-1)).toContain("browser only");
    const low = at(0, 1);
    expect(browserOnly(low)).toBe(low);
  });
});
