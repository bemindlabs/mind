/** S22.12 AC2 — the gate decides done, and a green gate ends in a request to merge, never a merge. */

import { afterEach, describe, expect, test } from "bun:test";
import { handoffLines, handoffOf, MAX_GATE_RED, parseGate, redNote } from "../../src/task/gate.ts";
import { runTask, type RunnerDeps, type StepTurn } from "../../src/task/runner.ts";
import { createTask, readTask, type TaskRecord } from "../../src/task/store.ts";
import { aTask, cleanup, said, SUBJECT, tempHome } from "./fixture.ts";

const scratch: string[] = [];
afterEach(() => cleanup(scratch));

const answer = (text: string): StepTurn => ({ code: 0, text, turnId: crypto.randomUUID(), backend: "ollama", tokens: 10, ms: 1000, error: "" });
const plan = said({ plan: ["fix it"] });
const done = said({ done: true, summary: "fixed", result: "ok" });

describe("--gate", () => {
  test("a command and its arguments become an argv; a shell line is refused, not interpreted", () => {
    expect(parseGate("bun test --bail")).toEqual({ ok: true, argv: ["bun", "test", "--bail"] });
    for (const line of ["bun test && rm -rf x", "echo $HOME", "a | b", "sh -c 'x'", "ls *.js", "a; b", ""]) {
      expect(parseGate(line).ok, line).toBe(false);
    }
  });

  test("the note to the bot names the gate and the end of its output, and says the cause is the target", () => {
    const note = redNote("bun test", "x".repeat(5000) + "FAIL sum", 1);
    expect(note).toContain("`bun test` is red (attempt 1 of 3)");
    expect(note).toContain("FAIL sum");
    expect(note.length).toBeLessThan(1800);
    expect(note).toContain("Fix the cause, not the check");
  });

  test("the handoff says nothing was merged and gives the command for a person", () => {
    const handoff = handoffOf({ repo: "/r", branch: "mind/t-1", base: "main", gate: "bun test", at: "2026-10-28T00:00:00Z", diffStat: " a.js | 2 +-", untracked: ["new.js"] });
    expect(handoff.mergeCommand).toBe("git -C /r merge --ff-only mind/t-1");
    const text = handoffLines(handoff).join("\n");
    expect(text).toContain("nothing was merged");
    expect(text).toContain("new.js");
    expect(handoffLines({ ...handoff, diffStat: "", untracked: [] }).join("\n")).toContain("no change against the base");
  });
});

async function run(record: TaskRecord, gates: boolean[], more: Partial<RunnerDeps> = {}) {
  const box = await tempHome(scratch);
  await createTask(box.tasks, record);
  const prompts: string[] = [];
  const asked: string[] = [];
  const deps: RunnerDeps = {
    tasks: box.tasks,
    now: () => new Date("2026-10-28T12:00:00Z"),
    say: () => undefined,
    brake: async () => false,
    turn: async (_record, prompt, _n, onStart) => {
      prompts.push(prompt);
      await onStart({ pid: 4242, start: 9 });
      return answer(prompt.includes("only make the plan") ? plan : done);
    },
    self: { pid: process.pid, start: 1 },
    stopping: () => false,
    stat: (pid) => (pid === process.pid ? { startTicks: 1 } : null),
    harden: async () => ({ ok: true }),
    gate: async () => {
      const pass = gates.shift() ?? false;
      asked.push(pass ? "green" : "red");
      return { pass, output: pass ? "" : "FAIL sum" };
    },
    handoff: async (r) => handoffOf({ repo: "/r", branch: "mind/x", base: "main", gate: r.gate!.join(" "), at: "now", diffStat: "", untracked: [] }),
    ...more,
  };
  const outcome = await runTask(record, deps);
  const read = await readTask(box.tasks, SUBJECT, record.id);
  if (!read.ok) throw new Error(read.reason);
  return { outcome, record: read.record, prompts, asked };
}

describe("the runner with a gate", () => {
  test("red, then green: the bot is told what the gate printed, and the task ends done with a handoff", async () => {
    const { record, prompts, asked } = await run(aTask({ gate: ["bun", "test"] }), [false, true]);
    expect(asked).toEqual(["red", "green"]);
    expect(record.status).toBe("done");
    expect(record.reason).toContain("ready for a person to merge");
    expect(record.handoff?.mergeCommand).toBe("git -C /r merge --ff-only mind/x");
    expect(prompts.some((p) => p.includes("is red (attempt 1 of 3)") && p.includes("FAIL sum"))).toBe(true);
    // The step that claimed done while the gate was red does not stand as done.
    expect(record.steps.filter((step) => step.done)).toHaveLength(1);
  });

  test(`red ${MAX_GATE_RED} times: the task fails, and no handoff is written`, async () => {
    const { record, asked } = await run(aTask({ gate: ["bun", "test"] }), [false, false, false, false]);
    expect(asked).toHaveLength(MAX_GATE_RED);
    expect(record.status).toBe("failed");
    expect(record.reason).toContain("still red after 3 tries");
    expect(record.handoff).toBeUndefined();
  });

  test("a task without a gate ends as it always did, and the gate is never run", async () => {
    const { record, asked } = await run(aTask(), []);
    expect(record.status).toBe("done");
    expect(asked).toEqual([]);
    expect(record.handoff).toBeUndefined();
  });

  test("green with a handoff that cannot be read is still done, and says so", async () => {
    const { record } = await run(aTask({ gate: ["bun", "test"] }), [true], { handoff: async () => undefined });
    expect(record.status).toBe("done");
    expect(record.reason).toContain("the handoff could not be read from git");
  });
});
