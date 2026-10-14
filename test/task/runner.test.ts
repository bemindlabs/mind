import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claimRunner, runTask, type RunnerDeps, type StepTurn, type StepWatch } from "../../src/task/runner.ts";
import { createTask, readTask, requestStop, taskDirIn, type TaskRecord } from "../../src/task/store.ts";
import { aTask, cleanup, said, SUBJECT, tempHome } from "./fixture.ts";
import { waitFor } from "../support/wait.ts";

const scratch: string[] = [];
afterEach(() => cleanup(scratch));

const SELF = { pid: process.pid, start: 1 };
const stat = (pid: number) => (pid === process.pid ? { startTicks: 1 } : null);

function answer(text: string, overrides: Partial<StepTurn> = {}): StepTurn {
  return { code: 0, text, turnId: crypto.randomUUID(), backend: "ollama", tokens: 10, ms: 1000, error: "", ...overrides };
}

/** A runner with turns that answer from a script, and everything else harmless. */
async function setup(record: TaskRecord, script: (prompt: string, n: number) => StepTurn | Promise<StepTurn>, more: Partial<RunnerDeps> = {}) {
  const box = await tempHome(scratch);
  await createTask(box.tasks, record);
  const prompts: string[] = [];
  const lines: string[] = [];
  const started: number[] = [];
  const deps: RunnerDeps = {
    tasks: box.tasks,
    now: () => new Date("2026-10-05T12:00:00Z"),
    say: (line) => lines.push(line),
    brake: async () => false,
    turn: async (_record, prompt, n, onStart) => {
      prompts.push(prompt);
      await onStart({ pid: 4242, start: 9 });
      started.push(n);
      return script(prompt, n);
    },
    self: SELF,
    stopping: () => false,
    stat,
    harden: async () => ({ ok: true }),
    ...more,
  };
  const reread = async () => {
    const read = await readTask(box.tasks, SUBJECT, record.id);
    if (!read.ok) throw new Error(read.reason);
    return read.record;
  };
  return { box, deps, prompts, lines, started, reread };
}

const plan = said({ plan: ["open", "answer"] });

describe("the task runner (D-154)", () => {
  test("plan, steps, done: every step is a turn, recorded with its id, and the result kept", async () => {
    let steps = 0;
    const { deps, prompts, reread } = await setup(aTask(), (prompt) => {
      if (prompt.includes("only make the plan")) return answer(plan);
      steps += 1;
      return answer(said(steps < 2 ? { done: false, summary: `did ${steps}` } : { done: true, summary: "all", result: "42" }));
    });
    const out = await runTask(aTask(), deps);
    expect(out.ok).toBe(true);
    const record = await reread();
    expect(record.status).toBe("done");
    expect(record.result).toBe("42");
    expect(record.plan).toEqual(["open", "answer"]);
    expect(record.steps.map((s) => [s.kind, s.n, s.outcome])).toEqual([["plan", 0, "ok"], ["step", 1, "ok"], ["step", 2, "ok"]]);
    expect(record.steps.every((s) => s.turnId !== null && s.finishedAt !== null)).toBe(true);
    expect(record.used).toEqual({ turns: 3, activeMs: 3000, tokens: 30, tokensUnknown: 0 });
    expect(record.runner).toBeNull();
    expect(record.current).toBeNull();
    expect(record.generation).toBe(1);
    expect(prompts[2]).toContain("- step 1: did 1");
  });

  test("the budget stops a task that never says done — at the limit, not past it", async () => {
    const { deps, reread } = await setup(aTask({ budget: { turns: 3, minutes: 30, tokens: null } }), (prompt) =>
      answer(prompt.includes("only make the plan") ? plan : said({ done: false, summary: "again" }), { tokens: null }),
    );
    await runTask(aTask({ budget: { turns: 3, minutes: 30, tokens: null } }), deps);
    const record = await reread();
    expect(record.status).toBe("budget");
    expect(record.reason).toContain("3 turn(s)");
    expect(record.used.turns).toBe(3);
    expect(record.used.tokensUnknown).toBe(3);
  });

  test("a stop request, the brake, and a SIGTERM each end it before the next step", async () => {
    for (const how of ["file", "brake", "signal"] as const) {
      let brake = false;
      let stopping = false;
      const box: { tasks?: string } = {};
      const { deps, reread } = await setup(aTask(), async (prompt) => {
        if (how === "file") await requestStop(taskDirIn(box.tasks!, "t-0000abcd"), "test", new Date());
        if (how === "brake") brake = true;
        if (how === "signal") stopping = true;
        return answer(prompt.includes("only make the plan") ? plan : said({ done: false, summary: "x" }));
      }, { brake: async () => brake, stopping: () => stopping });
      box.tasks = deps.tasks;
      await runTask(aTask(), deps);
      const record = await reread();
      expect(record.status).toBe("stopped");
      expect(record.steps).toHaveLength(1);
      expect(record.reason).toBe(how === "brake" ? "the brake is on (`mind stop`)" : "it was asked to stop");
    }
  });

  test("a step's turn killed by a stop is recorded as stopped, and no next step starts", async () => {
    let brake = false;
    const { deps, reread } = await setup(aTask(), () => {
      brake = true;
      return answer("", { code: 1, error: "killed" });
    }, { brake: async () => brake });
    await runTask(aTask(), deps);
    const record = await reread();
    expect(record.status).toBe("stopped");
    expect(record.steps[0]!.outcome).toBe("stopped");
    expect(record.steps[0]!.summary).toContain("stopped (exit 1): killed");
  });

  test("two failed steps in a row fail the task; one is retried", async () => {
    let calls = 0;
    const { deps, reread } = await setup(aTask(), () => {
      calls += 1;
      return calls === 1 ? answer("", { code: 1, error: "no backend answered" }) : calls === 2 ? answer(plan) : answer("", { code: 1, error: "down" });
    });
    await runTask(aTask(), deps);
    const record = await reread();
    expect(record.status).toBe("failed");
    expect(record.reason).toBe("2 steps in a row got no answer: down");
    expect(record.steps.map((s) => s.outcome)).toEqual(["failed", "ok", "failed", "failed"]);
  });

  test("a turn refused before sending, or not started, fails it at once and spends no turn", async () => {
    for (const [code, words] of [[4, "refused before anything was sent"], [2, "could not be started"]] as const) {
      const { deps, reread } = await setup(aTask(), () => answer("", { code, error: "the dial is at 0" }));
      await runTask(aTask(), deps);
      const record = await reread();
      expect(record.status).toBe("failed");
      expect(record.reason).toContain(words);
      expect(record.used.turns).toBe(0);
    }
  });

  test("an unreadable plan means no plan; three unreadable steps in a row end it", async () => {
    const { deps, reread } = await setup(aTask(), () => answer("I will just do it"));
    await runTask(aTask(), deps);
    const record = await reread();
    expect(record.plan).toEqual([]);
    expect(record.steps[0]!.summary).toContain("could not be read");
    expect(record.status).toBe("failed");
    expect(record.reason).toContain("3 answers in a row");
  });

  test("after a crash: the open step is closed as interrupted, counted, told to the next step, and the task carries on", async () => {
    const crashed = aTask({
      status: "running",
      plan: ["a"],
      runner: { pid: 999_999, start: 1, since: "x" },
      generation: 1,
      steps: [
        { n: 0, kind: "plan", startedAt: "a", finishedAt: "b", turnId: "p", backend: "x", exit: 0, outcome: "ok", summary: "planned", done: false, tokens: 1, ms: 1, waitedMs: 0 },
        { n: 1, kind: "step", startedAt: "c", finishedAt: null, turnId: null, backend: null, exit: null, outcome: null, summary: "", done: false, tokens: null, ms: null, waitedMs: 0 },
      ],
      used: { turns: 1, activeMs: 1, tokens: 1, tokensUnknown: 0 },
    });
    const { deps, prompts, lines, reread } = await setup(crashed, () => answer(said({ done: true, summary: "checked, done", result: "ok" })));
    await runTask(crashed, deps);
    const record = await reread();
    expect(record.status).toBe("done");
    expect(record.steps[1]!.outcome).toBe("interrupted");
    expect(record.steps[2]!.n).toBe(2);
    expect(record.used.turns).toBe(3);
    expect(record.generation).toBe(2);
    expect(prompts[0]).toContain("Step 1 was interrupted before it reported");
    expect(lines[0]).toContain("step 1 was interrupted");
  });

  test("one runner at a time: a live claim refuses the second; a dead one is passed over", async () => {
    const box = await tempHome(scratch);
    await createTask(box.tasks, aTask());
    const dir = taskDirIn(box.tasks, "t-0000abcd");
    expect(await claimRunner(dir, 0, SELF, "x", stat)).toEqual({ ok: true, generation: 1 });
    expect(await claimRunner(dir, 0, { pid: 1, start: 1 }, "x", stat)).toEqual({ ok: false, holder: SELF });
    // A claim by a process that is gone, and one that cannot be read, are both passed over.
    await mkdir(join(dir, "runners"), { recursive: true });
    await writeFile(join(dir, "runners", "2.json"), JSON.stringify({ pid: "999999", start: "5" }));
    await writeFile(join(dir, "runners", "3.json"), "{");
    expect(await claimRunner(dir, 1, SELF, "x", stat)).toEqual({ ok: true, generation: 4 });
  });

  test("a final task, or one another runner has, is refused with nothing written", async () => {
    const { deps } = await setup(aTask({ status: "done" }), () => answer(plan));
    expect(await runTask(aTask({ status: "done" }), deps)).toEqual({ ok: false, reason: "task t-0000abcd is done already", code: 5 });
    const other = await setup(aTask(), () => answer(plan));
    await claimRunner(taskDirIn(other.deps.tasks, "t-0000abcd"), 0, SELF, "x", stat);
    expect(await runTask(aTask(), { ...other.deps, self: { pid: 2, start: 2 } })).toMatchObject({ ok: false, code: 5 });
  });

  test("a task erased under its runner stays erased", async () => {
    const { deps, box } = await setup(aTask(), async () => {
      await rm(box.tasks, { recursive: true, force: true });
      return answer(plan);
    });
    const out = await runTask(aTask(), deps);
    expect(out).toMatchObject({ ok: false, code: 1 });
  });

  test("a browser task brings its browser up, records its port, and ends it however the task ends", async () => {
    const downs: string[] = [];
    const record = aTask({ operate: 2, allow: ["http://a:1"] });
    const { deps, reread, lines } = await setup(record, (prompt) => answer(prompt.includes("only make the plan") ? plan : said({ done: true, summary: "x" })), {
      browserUp: async (current) => ({ ok: true, task: current.id, port: 30_731 }),
      browserDown: async (current) => {
        downs.push(current.browser?.task ?? "none");
      },
    });
    await runTask(record, deps);
    expect(downs).toEqual(["t-0000abcd"]);
    expect(lines.join("\n")).toContain("127.0.0.1:30731");
    const after = await reread();
    expect(after.browser).toBeNull();
    expect(after.result).toBe("x");
  });

  test("round 3: an acting browser starts only once the runner is made not dumpable — failing, or absent, it does not start", async () => {
    const record = aTask({ operate: 2, allow: ["http://a:1"] });
    const order: string[] = [];
    const ok = await setup(record, (prompt) => answer(prompt.includes("only make the plan") ? plan : said({ done: true, summary: "x" })), {
      harden: async () => (order.push("harden"), { ok: true }),
      browserUp: async (current, level) => (order.push(`up ${level}`), { ok: true, task: current.id, port: 30_731 }),
    });
    await runTask(record, ok.deps);
    expect(order).toEqual(["harden", "up 2"]);
    for (const absent of [false, true]) {
      const ups: number[] = [];
      const failing = await setup(record, () => answer(plan), {
        harden: async () => ({ ok: false, reason: "prctl failed" }),
        browserUp: async (current, level) => (ups.push(level), { ok: true, task: current.id, port: 30_731 }),
      });
      const { harden, ...without } = failing.deps;
      void harden;
      await runTask(record, absent ? without : failing.deps);
      expect(ups).toEqual([]);
      expect((await failing.reread()).status).toBe("failed");
      expect(failing.lines.join("\n")).toContain("could not be made not dumpable");
    }
    // A browser that only looks holds no key: no hardening asked for.
    const looking = aTask({ operate: 1, allow: ["http://a:1"] });
    const calls: string[] = [];
    const look = await setup(looking, (prompt) => answer(prompt.includes("only make the plan") ? plan : said({ done: true, summary: "x" })), {
      harden: async () => (calls.push("harden"), { ok: true }),
      browserUp: async (current, level) => (calls.push(`up ${level}`), { ok: true, task: current.id, port: 30_731 }),
    });
    await runTask(looking, look.deps);
    expect(calls).toEqual(["up 1"]);
  });

  test("the container runs at min(task, dial), and comes down — or away — when the dial is lowered mid-task (review of PR #22)", async () => {
    const ups: number[] = [];
    let downs = 0;
    let dial = 1;
    const record = aTask({ operate: 2, allow: ["http://a:1"] });
    let steps = 0;
    const { deps, reread, lines } = await setup(record, (prompt) => {
      if (prompt.includes("only make the plan")) return answer(plan);
      steps += 1;
      if (steps === 1) dial = 1;
      return answer(said({ done: steps >= 3, summary: `s${steps}` }));
    }, {
      dialOperate: async () => dial,
      browserUp: async (current, level) => {
        ups.push(level);
        return { ok: true, task: current.id, port: 30_730 + ups.length };
      },
      browserDown: async () => {
        downs += 1;
      },
    });
    dial = 2;
    await runTask(record, deps);
    // Up at 2 (task 2, dial 2); the dial fell to 1 during step 1; the next step found a container at 1.
    expect(ups).toEqual([2, 1]);
    expect(downs).toBe(2);
    expect(lines.join("\n")).toContain("the dial lowered the browser to 1");
    expect((await reread()).status).toBe("done");

    const capped = await setup(aTask({ operate: 2, allow: ["http://a:1"] }), (prompt) => answer(prompt.includes("only make the plan") ? plan : said({ done: true, summary: "x" })), {
      dialOperate: async () => 1,
      browserUp: async (current, level) => {
        ups.push(level);
        return { ok: true, task: current.id, port: 30_740 };
      },
      browserDown: async () => undefined,
    });
    ups.length = 0;
    await runTask(aTask({ operate: 2, allow: ["http://a:1"] }), capped.deps);
    expect(ups).toEqual([1]);

    const none = await setup(aTask({ operate: 1, allow: ["http://a:1"] }), () => answer(plan), { dialOperate: async () => 0, browserUp: async () => ({ ok: true, task: "x", port: 1 }) });
    await runTask(aTask({ operate: 1, allow: ["http://a:1"] }), none.deps);
    expect((await none.reread()).reason).toContain("browser level is 0");

    let gone = 2;
    const away = await setup(aTask({ operate: 2, allow: ["http://a:1"] }), (prompt) => {
      gone = 0;
      return answer(prompt.includes("only make the plan") ? plan : said({ done: false, summary: "x" }));
    }, { dialOperate: async () => gone, browserUp: async (current) => ({ ok: true, task: current.id, port: 30_741 }), browserDown: async () => undefined });
    await runTask(aTask({ operate: 2, allow: ["http://a:1"] }), away.deps);
    const after = await away.reread();
    expect([after.status, after.browser]).toEqual(["stopped", null]);
    expect(after.reason).toContain("went to 0");
  });

  test("a step past its own active time is ended by the runner — holds do not count; a dial lowered mid-step ends it too (review of PR #24, findings 5 and 9)", async () => {
    // Active time: the clock runs, the holds are taken off. 10 s of wall time with 9 s held is 1 s active.
    let clock = 0;
    const ended: number[] = [];
    let held = 0;
    const record = aTask({ operate: 2, allow: ["http://a:1"], stepSeconds: 30 });
    const { deps } = await setup(record, async (prompt) => {
      if (prompt.includes("only make the plan")) return answer(plan);
      // Wall time passes; most of it is a hold, and then far more than the step's own 30 s of active time.
      held = 25_000;
      clock += 40_000;
      expect(await waitFor(() => ended.length === 0, { within: 200, every: 5 })).toBe(true);
      clock += 30_000;
      expect(await waitFor(() => ended.length === 1, { every: 5 })).toBe(true);
      return answer("", { code: 1, error: "ended" });
    }, {
      now: () => new Date(1_000_000 + clock),
      pollMs: 1,
      browserUp: async (current) => ({ ok: true, task: current.id, port: 30_731 }),
      browserDown: async () => undefined,
      watch: async () => ({ waiting: false, waitedMs: held, notes: [], stop: false }),
      endTurn: async (process_) => {
        ended.push(process_.pid);
      },
      dialOperate: async () => 2,
    });
    await runTask(record, { ...deps, turn: async (r, p, n, s) => {
      await s({ pid: 4242, start: 9 });
      return deps.turn(r, p, n, async () => undefined);
    } });
    expect(ended).toEqual([4242]);

    let dial = 2;
    const lowered: number[] = [];
    const mid = await setup(aTask({ operate: 2, allow: ["http://a:1"] }), async (prompt) => {
      if (prompt.includes("only make the plan")) return answer(plan);
      dial = 1;
      expect(await waitFor(() => lowered.length === 1, { every: 5 })).toBe(true);
      return answer(said({ done: true, summary: "x" }));
    }, {
      pollMs: 1,
      browserUp: async (current) => ({ ok: true, task: current.id, port: 30_732 }),
      browserDown: async () => undefined,
      endTurn: async (process_) => {
        lowered.push(process_.pid);
      },
      dialOperate: async () => dial,
    });
    await runTask(aTask({ operate: 2, allow: ["http://a:1"] }), mid.deps);
    expect(lowered).toEqual([4242]);
  });

  test("a browser that does not start fails the task; no runner for one fails it too", async () => {
    const record = aTask({ operate: 1, allow: ["http://a:1"] });
    const one = await setup(record, () => answer(plan), { browserUp: async () => ({ ok: false, reason: "no docker" }) });
    await runTask(record, one.deps);
    expect((await one.reread()).reason).toBe("its browser did not start: no docker");
    const two = await setup(record, () => answer(plan));
    await runTask(record, two.deps);
    expect((await two.reread()).reason).toBe("this task has a browser and none can be started here");
  });

  test("while a step runs, the approval channel pauses the task, takes its wait off the clock, and passes its notes on", async () => {
    // No wall time anywhere in this test. The runner asks `watch` once per poll, one poll after the last was saved,
    // so the Nth call to `watch` is itself the event "the answer to call N-1 has been written to the record":
    //   call 1 says the step waits  -> at call 2 the record says `waiting`; call 2 says the owner answered, with a note
    //   call 2 returns             -> at call 3 the record says `running`; call 3 lets the step's turn finish.
    // The step's turn waits on a promise that call 3 resolves, not on a sleep or a poll of the disk.
    let calls = 0;
    const statuses: string[] = [];
    let finishStep: () => void = () => undefined;
    const stepMayFinish = new Promise<void>((resolve) => {
      finishStep = resolve;
    });
    const record = aTask({ operate: 2, allow: ["http://a:1"] });
    const { deps, reread, prompts } = await setup(
      record,
      async (prompt) => {
        if (prompt.includes("only make the plan")) return answer(plan);
        if (prompts.length === 2) {
          await stepMayFinish;
          return answer(said({ done: false, summary: "asked" }), { ms: 5000 });
        }
        return answer(said({ done: true, summary: "x" }));
      },
      {
        pollMs: 1,
        browserUp: async () => ({ ok: true, task: "t-0000abcd", port: 30_731 }),
        browserDown: async () => undefined,
        watch: async (_record, step, ended): Promise<StepWatch> => {
          if (step.n !== 1 || ended) return { waiting: false, waitedMs: ended && step.n === 1 ? 4000 : 0, notes: [], stop: false };
          calls += 1;
          if (calls === 1) return { waiting: true, waitedMs: 4000, notes: [], stop: false };
          statuses.push((await reread()).status);
          if (calls === 2) return { waiting: false, waitedMs: 4000, notes: ["The owner said no to: click Delete"], stop: false };
          finishStep();
          return { waiting: false, waitedMs: 4000, notes: [], stop: false };
        },
      },
    );
    await runTask(record, deps);
    const after = await reread();
    expect(statuses).toEqual(["waiting", "running"]);
    expect(after.steps[1]!.waitedMs).toBe(4000);
    expect(after.used.activeMs).toBe(1000 + 1000 + 1000);
    expect(prompts[2]).toContain("The owner said no to: click Delete");
    expect(after.status).toBe("done");
  });

  test("the owner's no with stop ends the task", async () => {
    const record = aTask({ operate: 2, allow: ["http://a:1"] });
    const { deps, reread } = await setup(record, (prompt) => answer(prompt.includes("only make the plan") ? plan : said({ done: false, summary: "held" })), {
      pollMs: 1,
      browserUp: async () => ({ ok: true, task: "t-0000abcd", port: 30_731 }),
      browserDown: async () => undefined,
      watch: async (_r, step) => ({ waiting: false, waitedMs: 0, notes: [], stop: step.kind === "step" }),
    });
    await runTask(record, deps);
    const after = await reread();
    expect(after.status).toBe("stopped");
    expect(after.reason).toBe("the owner said no and asked it to stop");
  });

  test("a failure of the runner's own is the task's failure, said", async () => {
    const { deps, reread } = await setup(aTask(), () => {
      throw new Error("disk on fire");
    });
    await runTask(aTask(), deps);
    const after = await reread();
    expect(after.status).toBe("failed");
    expect(after.reason).toBe("the runner failed: disk on fire");
  });
});
