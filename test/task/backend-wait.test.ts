/**
 * S18.2 and S18.1 in the runner: a task waits for its backend instead of spending steps on it, is parked after the
 * wait's limit, does not count a step the backend was missing for — and a runner ended from outside with no stop
 * asked leaves the task for `task resume`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { runTask, type RunnerDeps, type StepTurn } from "../../src/task/runner.ts";
import { createTask, readTask, requestStop, resumable, shownStatus, taskDirIn, type TaskRecord } from "../../src/task/store.ts";
import { summarise, showLines, listLine } from "../../src/task/view.ts";
import { LEFT_EXIT_CODE } from "../../src/task/unit.ts";
import type { BackendState } from "../../src/task/backend-ready.ts";
import { aTask, cleanup, said, SUBJECT, tempHome } from "./fixture.ts";

const scratch: string[] = [];
afterEach(() => cleanup(scratch));

const SELF = { pid: process.pid, start: 1 };
const stat = (pid: number) => (pid === process.pid ? { startTicks: 1 } : null);
const plan = said({ plan: ["one"] });
const DOWN: BackendState = { ready: false, reason: "vLLM (http://127.0.0.1:9) is asleep" };

function answer(text: string, overrides: Partial<StepTurn> = {}): StepTurn {
  return { code: 0, text, turnId: crypto.randomUUID(), backend: "claude-local", tokens: 10, ms: 1000, error: "", ...overrides };
}

/** A runner on a clock this test moves, with a backend that answers from `ready`. */
async function setup(record: TaskRecord, script: (prompt: string) => StepTurn | Promise<StepTurn>, ready: () => BackendState, more: Partial<RunnerDeps> = {}) {
  const box = await tempHome(scratch);
  await createTask(box.tasks, record);
  const clock = { ms: Date.parse("2026-10-06T12:00:00Z") };
  const statuses: string[] = [];
  const probes = { n: 0 };
  const deps: RunnerDeps = {
    tasks: box.tasks,
    now: () => new Date(clock.ms),
    say: () => undefined,
    brake: async () => false,
    turn: async (current, prompt, _n, onStart) => {
      statuses.push(current.status);
      await onStart({ pid: 4242, start: 9 });
      return script(prompt);
    },
    self: SELF,
    stopping: () => false,
    stat,
    backendReady: async () => {
      probes.n += 1;
      return ready();
    },
    backendPollMs: 1,
    ...more,
  };
  const reread = async () => {
    const read = await readTask(box.tasks, SUBJECT, record.id);
    if (!read.ok) throw new Error(read.reason);
    return read.record;
  };
  return { box, deps, clock, statuses, probes, reread };
}

describe("waiting for the backend (S18.2)", () => {
  test("not ready before a step: the task waits (waiting-backend, with the reason), then carries on — no turn and no minute spent", async () => {
    let probe = 0;
    const seen: { status: string; reason: string | null }[] = [];
    const box: { reread?: () => Promise<TaskRecord> } = {};
    const { deps, reread, clock } = await setup(
      aTask({ backend: "claude-local" }),
      (prompt) => answer(prompt.includes("only make the plan") ? plan : said({ done: true, summary: "all", result: "42" })),
      () => {
        probe += 1;
        // Down for the first three asks (one before the plan, two while waiting), then up.
        return probe <= 3 ? DOWN : { ready: true };
      },
    );
    box.reread = reread;
    const watched = { ...deps, backendReady: async (r: TaskRecord) => {
      const read = await box.reread!();
      seen.push({ status: read.status, reason: read.reason });
      clock.ms += 60_000;
      return deps.backendReady!(r);
    } };
    const out = await runTask(aTask({ backend: "claude-local" }), watched);
    expect(out.ok).toBe(true);
    const record = await reread();
    expect(record.status).toBe("done");
    expect(seen.some((s) => s.status === "waiting-backend" && s.reason?.includes("is asleep") === true)).toBe(true);
    expect(record.steps.map((s) => s.outcome)).toEqual(["ok", "ok"]);
    expect(record.used.turns).toBe(2);
    expect(record.used.activeMs).toBe(2000);
    expect(record.reason).toBe("the goal was reached");
  });

  test("a step whose turn got no answer while the backend is down is no-backend: not a failure, no turn, no minute", async () => {
    let down = false;
    let steps = 0;
    const { deps, reread } = await setup(
      aTask({ backend: "claude-local" }),
      (prompt) => {
        if (prompt.includes("only make the plan")) return answer(plan);
        steps += 1;
        // Three steps in a row get nothing while the model sleeps — more than the two failures that end a task.
        if (steps <= 3) {
          down = true;
          return answer("", { code: 1, error: "LiteLLM: 500", tokens: null, ms: 4000 });
        }
        return answer(said({ done: true, summary: "all", result: "42" }));
      },
      () => {
        if (down) {
          down = false;
          return DOWN;
        }
        return { ready: true };
      },
    );
    await runTask(aTask({ backend: "claude-local" }), deps);
    const record = await reread();
    expect(record.status).toBe("done");
    expect(record.steps.map((s) => s.outcome)).toEqual(["ok", "no-backend", "no-backend", "no-backend", "ok"]);
    expect(record.steps.filter((s) => s.outcome === "failed")).toHaveLength(0);
    expect(record.steps[1]!.summary).toContain("counts against nothing");
    expect(record.used.turns).toBe(2);
    expect(record.used.activeMs).toBe(2000);
  });

  test("a turn with no answer while the backend is ready is still a failure, and two in a row end the task", async () => {
    const { deps, reread } = await setup(
      aTask({ backend: "claude-local" }),
      (prompt) => (prompt.includes("only make the plan") ? answer(plan) : answer("", { code: 1, error: "boom", tokens: null })),
      () => ({ ready: true }),
    );
    await runTask(aTask({ backend: "claude-local" }), deps);
    const record = await reread();
    expect(record.status).toBe("failed");
    expect(record.steps.map((s) => s.outcome)).toEqual(["ok", "failed", "failed"]);
  });

  test("past its limit the task is parked, with the reason and no runner; resume carries it on, and its reason is cleared", async () => {
    const task = aTask({ backend: "claude-local", backendWaitMinutes: 5 });
    const { deps, reread, clock } = await setup(task, (prompt) => answer(prompt.includes("only make the plan") ? plan : said({ done: true, summary: "all", result: "42" })), () => DOWN);
    const moving = { ...deps, backendReady: async (r: TaskRecord) => {
      clock.ms += 2 * 60_000;
      return deps.backendReady!(r);
    } };
    const out = await runTask(task, moving);
    expect(out.ok).toBe(true);
    const parked = await reread();
    expect(parked.status).toBe("parked");
    expect(parked.reason).toContain("its backend was not ready for 6 min");
    expect(parked.reason).toContain("is asleep");
    expect(parked.runner).toBeNull();
    expect(parked.steps).toHaveLength(0);
    // Parked is shown as parked — not interrupted — and may be resumed or stopped.
    expect(shownStatus(parked, stat)).toBe("parked");
    expect(resumable(shownStatus(parked, stat))).toBe(true);
    const summary = summarise(parked, stat);
    expect(summary).toMatchObject({ resumable: true, stoppable: true });
    expect(showLines(summary).join("\n")).toContain("it was parked");
    expect(listLine(summary)).toContain("parked");

    const again = await runTask(parked, { ...deps, backendReady: async () => ({ ready: true }) });
    expect(again.ok).toBe(true);
    const done = await reread();
    expect(done.status).toBe("done");
    expect(done.generation).toBe(2);
  });

  test("a stop request, the brake, or a leaving runner end the wait", async () => {
    for (const how of ["file", "brake", "leave"] as const) {
      let brake = false;
      let leaving = false;
      const box: { tasks?: string } = {};
      const { deps, reread } = await setup(aTask({ backend: "claude-local" }), () => answer(plan), () => {
        if (how === "file") void requestStop(taskDirIn(box.tasks!, "t-0000abcd"), "test", new Date());
        if (how === "brake") brake = true;
        if (how === "leave") leaving = true;
        return DOWN;
      }, { brake: async () => brake, leaving: () => leaving });
      box.tasks = deps.tasks;
      const out = await runTask(aTask({ backend: "claude-local" }), deps);
      const record = await reread();
      if (how === "leave") {
        expect(out.ok).toBe(false);
        expect(record.status).toBe("planning");
        expect(record.runner).toBeNull();
        expect(shownStatus(record, stat)).toBe("interrupted");
      } else {
        expect(record.status).toBe("stopped");
        expect(record.reason).toBe(how === "brake" ? "the brake is on (`mind stop`)" : "it was asked to stop");
      }
    }
  });

  test("a task without the probe never waits", async () => {
    const { deps, reread, probes } = await setup(aTask(), (prompt) => answer(prompt.includes("only make the plan") ? plan : said({ done: true, summary: "all", result: "1" })), () => DOWN);
    const { backendReady: _unused, ...without } = deps;
    await runTask(aTask(), without);
    expect((await reread()).status).toBe("done");
    expect(probes.n).toBe(0);
  });

  test("the reason is updated while waiting when the backend says something else", async () => {
    let n = 0;
    const reasons: (string | null)[] = [];
    const { deps, reread } = await setup(aTask({ backend: "claude-local" }), (prompt) => answer(prompt.includes("only make the plan") ? plan : said({ done: true, summary: "x", result: "1" })), () => {
      n += 1;
      if (n === 1) return DOWN;
      if (n === 2) return { ready: false, reason: "LiteLLM (http://127.0.0.1:9) did not answer: refused" };
      return { ready: true };
    });
    const tracked = { ...deps, backendReady: async (r: TaskRecord) => {
      reasons.push((await reread()).reason);
      return deps.backendReady!(r);
    } };
    await runTask(aTask({ backend: "claude-local" }), tracked);
    expect(reasons.some((r) => r?.includes("LiteLLM") === true)).toBe(true);
  });
});

describe("a runner ended from outside (S18.1)", () => {
  test("SIGTERM with no stop asked, mid-step: the step is closed as interrupted, the record left for resume", async () => {
    let leaving = false;
    const { deps, reread } = await setup(aTask({ backend: "claude-local" }), (prompt) => {
      if (prompt.includes("only make the plan")) return answer(plan);
      leaving = true;
      // The handler ended the turn: it comes back with nothing.
      return answer("", { code: 143, tokens: 5, ms: 700 });
    }, () => ({ ready: true }), { leaving: () => leaving });
    const out = await runTask(aTask({ backend: "claude-local" }), deps);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe(LEFT_EXIT_CODE);
    const record = await reread();
    expect(record.status).toBe("running");
    expect(record.runner).toBeNull();
    expect(record.current).toBeNull();
    expect(record.steps.map((s) => s.outcome)).toEqual(["ok", "interrupted"]);
    expect(record.steps[1]!.summary).toContain("ended from outside");
    expect(record.used.turns).toBe(2);
    expect(record.notes.join(" ")).toContain("was interrupted");
    expect(shownStatus(record, stat)).toBe("interrupted");
  });

  test("SIGTERM with a stop asked is a stop, as before", async () => {
    let stopping = false;
    const { deps, reread } = await setup(aTask(), (prompt) => {
      if (prompt.includes("only make the plan")) return answer(plan);
      stopping = true;
      return answer("", { code: 143 });
    }, () => ({ ready: true }), { stopping: () => stopping, leaving: () => false });
    await runTask(aTask(), deps);
    const record = await reread();
    expect(record.status).toBe("stopped");
    expect(record.steps.at(-1)!.outcome).toBe("stopped");
  });

  test("leaving between steps closes nothing and writes the record with no runner", async () => {
    let leaving = false;
    const { deps, reread } = await setup(aTask(), (prompt) => {
      if (!prompt.includes("only make the plan")) throw new Error("no step may start");
      leaving = true;
      return answer(plan);
    }, () => ({ ready: true }), { leaving: () => leaving });
    await runTask(aTask(), deps);
    const record = await reread();
    expect(record.steps.map((s) => s.outcome)).toEqual(["ok"]);
    expect(record.runner).toBeNull();
    expect(record.used.turns).toBe(1);
  });
});
