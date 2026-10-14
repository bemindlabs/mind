import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describeRun, writeRunRecord, type StoredRun } from "../../src/decide/runs.ts";
import { askEveryTaskToStop, stopTask } from "../../src/task/control.ts";
import { latestScreen, recentTasks } from "../../src/task/screen.ts";
import { readTurnJson, spawnStepTurn, stepTurnArgs, tail } from "../../src/task/spawn-turn.ts";
import { createTask, readTask, stopRequested, taskDirIn, writeTask } from "../../src/task/store.ts";
import { listLine, showLines, summarise } from "../../src/task/view.ts";
import { subjectId } from "../../src/types.ts";
import { BUN } from "../support/bare-path.ts";
import { aTask, cleanup, SUBJECT, tempHome } from "./fixture.ts";

const scratch: string[] = [];
afterEach(() => cleanup(scratch));

describe("stopping a task", () => {
  test("a task that ended is left as it is", async () => {
    const box = await tempHome(scratch);
    await createTask(box.tasks, aTask({ status: "done" }));
    const out = await stopTask({ home: box.home, env: box.env }, box.tasks, SUBJECT, "t-0000abcd", { now: () => new Date(), by: "t" });
    expect(out).toEqual({ ok: true, result: { id: "t-0000abcd", outcome: "already-final", status: "done", turn: null } });
    expect(await stopRequested(taskDirIn(box.tasks, "t-0000abcd"))).toBe(false);
  });

  test("no such task is said", async () => {
    const box = await tempHome(scratch);
    expect(await stopTask({ home: box.home, env: box.env }, box.tasks, SUBJECT, "t-11111111", { now: () => new Date(), by: "t" })).toMatchObject({ ok: false });
  });

  test("with its runner gone, the task is closed as stopped here", async () => {
    const box = await tempHome(scratch);
    await createTask(box.tasks, aTask({ status: "running", runner: { pid: 999_999, start: 1, since: "x" } }));
    const ended: string[] = [];
    const out = await stopTask({ home: box.home, env: box.env }, box.tasks, SUBJECT, "t-0000abcd", {
      now: () => new Date("2026-10-05T12:00:00Z"),
      by: "t",
      stat: () => null,
      // Review of PR #24, finding 5: with nobody left to end it, the stop ends the task's container.
      endBrowser: async (task) => {
        ended.push(task);
      },
    });
    expect(out.ok && out.result.outcome).toBe("stopped");
    expect(ended).toEqual(["t-0000abcd"]);
    const read = await readTask(box.tasks, SUBJECT, "t-0000abcd");
    expect(read.ok && [read.record.status, read.record.reason, read.record.runner]).toEqual(["stopped", "it was asked to stop", null]);
    expect(await stopRequested(taskDirIn(box.tasks, "t-0000abcd"))).toBe(true);
  });

  test("the step's turn is ended through its run record, then the live runner closes the task", async () => {
    const box = await tempHome(scratch);
    const env = { home: box.home, env: box.env };
    const turnPid = 4242;
    await createTask(box.tasks, aTask({ status: "running", runner: { pid: 7, start: 1, since: "x" }, current: { pid: turnPid, start: 3 } }));
    const record = { ...describeRun({ turnId: "turn-1", subject: SUBJECT, backends: ["ollama"], at: new Date() }), pid: turnPid };
    await writeRunRecord(env, record);
    const ended: StoredRun[] = [];
    const stat = (pid: number) => (pid === 7 ? { startTicks: 1 } : pid === turnPid ? { startTicks: 3 } : null);
    const out = await stopTask(env, box.tasks, SUBJECT, "t-0000abcd", {
      now: () => new Date(),
      by: "t",
      stat,
      waitMs: 2000,
      end: async (stored) => {
        ended.push(stored);
        // The runner sees its turn end and closes the task.
        const read = await readTask(box.tasks, SUBJECT, "t-0000abcd");
        if (read.ok) await writeTask(box.tasks, { ...read.record, status: "stopped", runner: null });
        return { record: stored.record, liveness: "live", signalled: [], survivors: [] };
      },
    });
    expect(ended.map((s) => s.record.turnId)).toEqual(["turn-1"]);
    expect(out.ok && out.result.outcome).toBe("stopped");
    expect(out.ok && out.result.turn?.liveness).toBe("live");
  });

  test("a live runner that does not close it in time is reported as asked", async () => {
    const box = await tempHome(scratch);
    await createTask(box.tasks, aTask({ status: "running", runner: { pid: 7, start: 1, since: "x" } }));
    const out = await stopTask({ home: box.home, env: box.env }, box.tasks, SUBJECT, "t-0000abcd", { now: () => new Date(), by: "t", stat: () => ({ startTicks: 1 }), waitMs: 50 });
    expect(out.ok && out.result.outcome).toBe("asked");
  });

  test("S18.1: a runner in a unit of its own — its unit is stopped once the task is closed, and before giving up on a runner that has not closed it", async () => {
    const box = await tempHome(scratch);
    await createTask(box.tasks, aTask({ id: "t-0000abce", status: "running", runner: { pid: 7, start: 1, since: "x" } }));
    const units: string[] = [];
    const endUnit = async (task: string) => {
      units.push(task);
    };
    let alive = true;
    const stat = () => (alive ? { startTicks: 1 } : null);
    // A runner that does not close it in time: its unit is stopped (SIGTERM with the stop asked) and the runner
    // ends; the task is then closed here.
    const out = await stopTask({ home: box.home, env: box.env }, box.tasks, SUBJECT, "t-0000abce", {
      now: () => new Date(),
      by: "t",
      stat,
      waitMs: 50,
      unitWaitMs: 2000,
      endUnit: async (task) => {
        await endUnit(task);
        alive = false;
      },
    });
    expect(out.ok && out.result.outcome).toBe("stopped");
    // Once to end the runner, once more after the task was closed here (a no-op for a unit already gone).
    expect(units).toEqual(["t-0000abce", "t-0000abce"]);
    const read = await readTask(box.tasks, SUBJECT, "t-0000abce");
    expect(read.ok && read.record.status).toBe("stopped");

    // A runner that closes it as asked: the unit is stopped after.
    units.length = 0;
    await createTask(box.tasks, aTask({ id: "t-0000abcf", status: "running", runner: { pid: 7, start: 1, since: "x" } }));
    alive = true;
    const closing = stopTask({ home: box.home, env: box.env }, box.tasks, SUBJECT, "t-0000abcf", { now: () => new Date(), by: "t", stat, waitMs: 5000, endUnit });
    const read2 = await readTask(box.tasks, SUBJECT, "t-0000abcf");
    if (read2.ok) await writeTask(box.tasks, { ...read2.record, status: "stopped", runner: null });
    expect((await closing).ok).toBe(true);
    expect(units).toEqual(["t-0000abcf"]);

    // A unit that will not stop leaves the task asked, after the unit's own wait.
    units.length = 0;
    await createTask(box.tasks, aTask({ id: "t-0000abd0", status: "running", runner: { pid: 7, start: 1, since: "x" } }));
    const stuck = await stopTask({ home: box.home, env: box.env }, box.tasks, SUBJECT, "t-0000abd0", { now: () => new Date(), by: "t", stat, waitMs: 20, unitWaitMs: 20, endUnit });
    expect(stuck.ok && stuck.result.outcome).toBe("asked");
    expect(units).toEqual(["t-0000abd0"]);
  });

  test("S18.2: a parked task (no runner) is closed by a stop", async () => {
    const box = await tempHome(scratch);
    await createTask(box.tasks, aTask({ status: "parked", reason: "its backend was not ready for 30 min" }));
    const out = await stopTask({ home: box.home, env: box.env }, box.tasks, SUBJECT, "t-0000abcd", { now: () => new Date(), by: "t", stat: () => null });
    expect(out.ok && out.result.outcome).toBe("stopped");
    const read = await readTask(box.tasks, SUBJECT, "t-0000abcd");
    expect(read.ok && [read.record.status, read.record.reason]).toEqual(["stopped", "it was asked to stop"]);
  });

  test("`mind stop` asks every unfinished task of every subject", async () => {
    const box = await tempHome(scratch);
    await createTask(box.tasks, aTask({ status: "running" }));
    await createTask(box.tasks, aTask({ id: "t-0000abce", status: "done" }));
    const other = subjectId("other-one");
    const otherTasks = join(box.home, "data", "mind", other, "personal", "tasks");
    await createTask(otherTasks, aTask({ id: "t-99999999", subject: other, status: "waiting" }));
    await mkdir(join(box.home, "data", "mind", "Not A Subject"), { recursive: true });
    const asked = await askEveryTaskToStop({ home: box.home, env: box.env }, new Date(), "mind stop");
    expect(asked.map((a) => a.id).sort()).toEqual(["t-0000abcd", "t-99999999"]);
    expect(await stopRequested(taskDirIn(box.tasks, "t-0000abce"))).toBe(false);
    expect(await askEveryTaskToStop({ home: join(box.home, "nowhere"), env: {} }, new Date(), "x")).toEqual([]);
  });
});

describe("a step's turn, as a child", () => {
  test("its argv is an ordinary turn with --task, the prompt in a file, and the task's backend and model", () => {
    expect(stepTurnArgs(aTask(), "/p")).toEqual(["turn", "/agents/a", "--subject", SUBJECT, "--prompt-file", "/p", "--json", "--task", "t-0000abcd"]);
    expect(stepTurnArgs(aTask({ backend: "claude-local", model: "m" }), "/p")).toContain("claude-local");
  });

  test("what `turn --json` printed is read for the step; tokens are a sum or nothing", () => {
    expect(readTurnJson("not json")).toEqual({ text: "", turnId: null, backend: null, tokens: null });
    expect(readTurnJson(JSON.stringify({ text: "hi", turn: "u", backend: "b", evidence: { usage: { input: 3, output: 4 } } }))).toEqual({ text: "hi", turnId: "u", backend: "b", tokens: 7 });
    expect(readTurnJson(JSON.stringify({ text: "hi", evidence: { usage: { input: null, output: 4 } } })).tokens).toBe(4);
    expect(readTurnJson(JSON.stringify({ evidence: {} })).tokens).toBeNull();
    expect(readTurnJson(JSON.stringify({ text: "", route: "no backend answered · 3s", evidence: { raw: "timed out after 60000ms" } })).why).toBe("no backend answered · 3s — timed out after 60000ms");
    expect(readTurnJson(JSON.stringify({ text: "ok" })).why).toBeUndefined();
    expect(tail("a\n\u001b[2mb\u001b[0m\n\nc\nd\n")).toBe("b · c · d");
    expect(tail("no backend answered · 3.0s\nmind: what this turn changed in /w: nothing\n  anything under .git/ or node_modules/\n")).toBe("no backend answered · 3.0s");
  });

  test("it runs the engine with the prompt in a private file, tells who started, and removes the file", async () => {
    const box = await tempHome(scratch);
    await createTask(box.tasks, aTask({ cwd: box.home }));
    const dir = taskDirIn(box.tasks, "t-0000abcd");
    const fake = join(box.home, "fake-engine.ts");
    await writeFile(
      fake,
      `const a = process.argv.slice(2); const f = a[a.indexOf("--prompt-file") + 1];
       const mode = (require("node:fs").statSync(f).mode & 0o777).toString(8);
       console.log(JSON.stringify({ text: require("node:fs").readFileSync(f, "utf8") + " " + mode + " " + process.cwd(), turn: "t1", backend: "fake" }));
       console.error("a note"); process.exit(0);`,
    );
    await chmod(fake, 0o700);
    const started: number[] = [];
    const ran = await spawnStepTurn([BUN, fake], dir, aTask({ cwd: box.home }), "the prompt", 3, async (p) => {
      started.push(p.pid);
    }, { PATH: process.env["PATH"] ?? "/usr/bin:/bin" });
    expect(ran.code).toBe(0);
    expect(ran.text).toBe(`the prompt 600 ${box.home}`);
    expect(ran.turnId).toBe("t1");
    expect(ran.error).toBe("a note");
    expect(started).toHaveLength(1);
    expect(await Bun.file(join(dir, "prompt-3.txt")).exists()).toBe(false);
  });
});

describe("what the page and the app are shown", () => {
  test("a summary says whether it can be stopped or resumed, and the lines say it all in words", () => {
    const step = { n: 1, kind: "step" as const, startedAt: "a", finishedAt: null, turnId: "u-1", backend: "x", exit: null, outcome: null, summary: "typing", done: false, tokens: null, ms: null, waitedMs: 12_000 };
    const live = summarise(aTask({ status: "running", runner: { pid: 7, start: 1, since: "x" }, plan: [], steps: [step], operate: 2, allow: ["http://a:1"], browser: { task: "t-0000abcd", port: 30_731 } }), () => ({ startTicks: 1 }));
    expect([live.status, live.stoppable, live.resumable, live.browser]).toEqual(["running", true, false, { port: 30_731 }]);
    const dead = summarise(aTask({ status: "running", runner: { pid: 7, start: 1, since: "x" } }), () => null);
    expect([dead.status, dead.resumable]).toEqual(["interrupted", true]);
    const done = summarise(aTask({ status: "done", result: "42", reason: "the goal was reached", used: { turns: 1, activeMs: 0, tokens: 0, tokensUnknown: 1 } }));
    expect(done.stoppable).toBe(false);
    expect(listLine(done)).toContain("t-0000abcd  done");
    expect(listLine(summarise(aTask({ goal: "x".repeat(100) })))).toContain("…");
    const lines = showLines(live).join("\n");
    expect(lines).toContain("operate 2 on http://a:1");
    expect(lines).toContain("(none could be read)");
    expect(lines).toContain("step 1 — running · turn u-1 · waited 12s for you");
    expect(showLines(done).join("\n")).toContain("result: 42");
    expect(showLines(done).join("\n")).toContain("at least");
    expect(showLines(dead).join("\n")).toContain("mind task resume");
    expect(showLines(summarise(aTask({ plan: ["a"] }))).join("\n")).toContain("1. a");
  });

  test("recent tasks for /api/state, and the newest screenshot as a data URL", async () => {
    const box = await tempHome(scratch);
    const env = { home: box.home, env: box.env };
    expect(await recentTasks(env, SUBJECT)).toEqual([]);
    await createTask(box.tasks, aTask({ operate: 1, allow: ["http://a:1"] }));
    await createTask(box.tasks, aTask({ id: "t-0000abce" }));
    expect((await recentTasks(env, SUBJECT)).map((t) => t.id).sort()).toEqual(["t-0000abcd", "t-0000abce"]);
    expect(await latestScreen(env, SUBJECT, "t-0000abce")).toEqual({ ok: false, reason: "this task has no browser" });
    expect(await latestScreen(env, SUBJECT, "t-11111111")).toMatchObject({ ok: false });
    expect(await latestScreen(env, SUBJECT, "t-0000abcd")).toEqual({ ok: false, reason: "its browser has taken no screenshot yet" });
    const screens = join(box.home, "data", "mind", SUBJECT, "personal", "browser", "t-0000abcd", "screens");
    await mkdir(screens, { recursive: true });
    expect(await latestScreen(env, SUBJECT, "t-0000abcd")).toEqual({ ok: false, reason: "its browser has taken no screenshot yet" });
    await writeFile(join(screens, "0001-1.png"), "old");
    await writeFile(join(screens, "0002-2.png"), "new");
    await writeFile(join(screens, "notes.txt"), "x");
    const shot = await latestScreen(env, SUBJECT, "t-0000abcd");
    expect(shot.ok && shot.image).toBe(`data:image/png;base64,${Buffer.from("new").toString("base64")}`);
    await writeFile(join(screens, "0003-3.png"), Buffer.alloc(7 * 1024 * 1024));
    expect(await latestScreen(env, SUBJECT, "t-0000abcd")).toEqual({ ok: false, reason: "the newest screenshot is too large to show here" });
    await mkdir(join(box.home, "data", ".git"), { recursive: true });
    expect(await recentTasks(env, SUBJECT)).toEqual([]);
    expect((await latestScreen(env, SUBJECT, "t-0000abcd")).ok).toBe(false);
  });
});

describe("a stop that comes before the step's turn has a run record", () => {
  test("the turn process alone is ended — it has started nothing yet", async () => {
    const box = await tempHome(scratch);
    await createTask(box.tasks, aTask({ status: "running", runner: { pid: 7, start: 1, since: "x" }, current: { pid: 4343, start: 3 } }));
    const killed: [number, string][] = [];
    const out = await stopTask({ home: box.home, env: box.env }, box.tasks, SUBJECT, "t-0000abcd", {
      now: () => new Date(),
      by: "t",
      stat: (pid) => (pid === 7 || pid === 4343 ? { startTicks: pid === 7 ? 1 : 3 } : null),
      waitMs: 50,
      kill: (pid, signal) => {
        killed.push([pid, signal]);
        throw new Error("ESRCH");
      },
    });
    expect(killed).toEqual([[4343, "SIGTERM"]]);
    expect(out.ok && out.result.outcome).toBe("asked");
  });
});

describe("erase ends a subject's tasks (review of PR #22)", () => {
  test("each unfinished task: asked to stop, its runner signalled, its step's turn ended through its run record", async () => {
    const { endTasksForErase } = await import("../../src/task/control.ts");
    const box = await tempHome(scratch);
    const env = { home: box.home, env: box.env };
    await createTask(box.tasks, aTask({ status: "running", runner: { pid: 7, start: 1, since: "x" }, current: { pid: 4242, start: 3 } }));
    await createTask(box.tasks, aTask({ id: "t-0000abce", status: "waiting", runner: { pid: 8, start: 1, since: "x" }, current: { pid: 4343, start: 3 } }));
    await createTask(box.tasks, aTask({ id: "t-0000abcf", status: "done" }));
    await createTask(box.tasks, aTask({ id: "t-0000abc0", status: "running", runner: { pid: 9, start: 99, since: "x" } }));
    await writeRunRecord(env, { ...describeRun({ turnId: "turn-1", subject: SUBJECT, backends: ["ollama"], at: new Date() }), pid: 4242 });
    const signals: string[] = [];
    const ended: string[] = [];
    const stat = (pid: number) => (pid === 7 || pid === 8 || pid === 9 ? { startTicks: 1 } : pid === 4242 || pid === 4343 ? { startTicks: 3 } : null);
    const out = await endTasksForErase(box.tasks, SUBJECT, join(box.home, "state", "mind", "runs"), {
      now: new Date(),
      stat,
      kill: (pid, signal) => {
        signals.push(`${pid} ${signal}`);
        if (pid === 8) throw new Error("ESRCH");
      },
      end: async (stored) => {
        ended.push(stored.record.turnId);
        return { record: stored.record, liveness: "live", signalled: [], survivors: [] };
      },
    });
    expect(out.map((t) => [t.id, t.runner, t.turn?.record.turnId ?? null]).sort()).toEqual([
      ["t-0000abc0", "none", null],
      ["t-0000abcd", "ended", "turn-1"],
      ["t-0000abce", "none", null],
    ]);
    expect(signals.sort()).toEqual(["4343 SIGTERM", "7 SIGTERM", "8 SIGTERM"]);
    expect(ended).toEqual(["turn-1"]);
    for (const id of ["t-0000abcd", "t-0000abce", "t-0000abc0"]) expect(await stopRequested(taskDirIn(box.tasks, id))).toBe(true);
    expect(await stopRequested(taskDirIn(box.tasks, "t-0000abcf"))).toBe(false);
  });
});
