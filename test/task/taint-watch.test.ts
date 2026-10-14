/**
 * The runner's own memory of loosened turns (review of PR #24, round 4): a turn that writes a claim, then
 * deletes or flips its run record — or is SIGKILLed before `noteEnded` — still taints that claim.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { describeRun, noteEnded, procStat, readRuns, writeRunRecord, type RunRecord } from "../../src/decide/runs.ts";
import { TAINT_GRACE_MS, taintedAt } from "../../src/task/answer.ts";
import { runnerTaint, TAINT_POLL_MS, TaintWatch } from "../../src/task/taint-watch.ts";
import { subjectId } from "../../src/types.ts";
import { waitFor } from "../support/wait.ts";
import { cleanup, tempHome } from "./fixture.ts";

const scratch: string[] = [];
const children: Bun.Subprocess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await cleanup(scratch);
});

const OTHER = subjectId("other-one");

async function env() {
  const box = await tempHome(scratch);
  return { home: box.home, env: box.env };
}

/** A loosened turn's run record for a process that is (or was) really running. */
function loosenedFor(pid: number, startedAt: Date, loosened = true): RunRecord {
  return { ...describeRun({ turnId: `chat-${pid}`, subject: OTHER, backends: ["claude"], at: startedAt, loosened }), pid, pidStart: procStat(pid)?.startTicks ?? null };
}

function sleeper(): Bun.Subprocess {
  const child = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
  children.push(child);
  return child;
}

describe("TaintWatch", () => {
  test("polls often enough to see a record that lives half a second", () => {
    expect(TAINT_POLL_MS).toBeLessThanOrEqual(500);
  });

  test("delete: a record that goes away without an end note taints every later claim, for good", async () => {
    const e = await env();
    const child = sleeper();
    const started = new Date(Date.now() - 5000);
    const path = await writeRunRecord(e, loosenedFor(child.pid, started));
    const watch = new TaintWatch(e);
    await watch.poll(Date.now());
    expect(watch.tainted(Date.now())).toContain("running");
    // The turn deletes its record (and keeps running, or not): what is on disk now looks clean …
    await rm(path);
    expect(await taintedAt(e, Date.now() + 60_000)).toBeUndefined();
    // … but this runner remembers.
    await watch.poll(Date.now());
    child.kill("SIGKILL");
    await child.exited;
    await watch.poll(Date.now());
    expect(watch.tainted(Date.now() + 3_600_000)).toContain("without an end note");
    expect(watch.tainted(started.getTime() - 1)).toBeUndefined();
  });

  test("flip: a record that stops saying loosened, without an end note, is the same", async () => {
    const e = await env();
    const child = sleeper();
    const started = new Date(Date.now() - 5000);
    await writeRunRecord(e, loosenedFor(child.pid, started));
    const watch = new TaintWatch(e);
    await watch.poll(Date.now());
    await writeRunRecord(e, loosenedFor(child.pid, started, false));
    expect((await readRuns(e)).runs.some(({ record }) => record.loosened === true)).toBe(false);
    await watch.poll(Date.now());
    expect(watch.tainted(Date.now() + 3_600_000)).toContain("without an end note");
  });

  test("SIGKILL: a real turn process killed before it notes its end — the record left, or deleted first", async () => {
    const e = await env();
    // Left behind: the record stays, its process is dead.
    const left = sleeper();
    const leftStart = new Date(Date.now() - 5000);
    await writeRunRecord(e, loosenedFor(left.pid, leftStart));
    const watch = new TaintWatch(e);
    await watch.poll(Date.now());
    left.kill("SIGKILL");
    await left.exited;
    await watch.poll(Date.now());
    expect(await taintedAt(e, Date.now())).toContain("stopped without a note");
    expect(watch.tainted(Date.now())).toBeDefined();
    // Deleted first, then killed: only the runner's memory still knows.
    const e2 = await env();
    const gone = sleeper();
    const goneStart = new Date(Date.now() - 5000);
    const path = await writeRunRecord(e2, loosenedFor(gone.pid, goneStart));
    const watch2 = new TaintWatch(e2);
    const stop = await watch2.start();
    try {
      await rm(path);
      gone.kill("SIGKILL");
      await gone.exited;
      expect(await waitFor(() => watch2.tainted(Date.now()) !== undefined && watch2.tainted(Date.now())!.includes("without an end note"), { within: 5000, every: 50 })).toBe(true);
      expect(await taintedAt(e2, Date.now())).toBeUndefined();
    } finally {
      stop();
    }
  });

  test("an honest end: the note, then the record removed, then the process gone — tainted until it is seen dead, plus the grace", async () => {
    const e = await env();
    const child = sleeper();
    const started = new Date(Date.now() - 5000);
    const record = loosenedFor(child.pid, started);
    const path = await writeRunRecord(e, record);
    const watch = new TaintWatch(e);
    await watch.poll(Date.now());
    await noteEnded(e, record, new Date());
    await rm(path);
    await watch.poll(Date.now());
    // A note does not end it while its process still runs: a turn could write one and carry on.
    expect(watch.tainted(Date.now() + 60_000)).toContain("ended");
    child.kill("SIGKILL");
    await child.exited;
    const seenDead = Date.now();
    await watch.poll(seenDead);
    expect(watch.tainted(seenDead + 1000)).toContain("ended");
    expect(watch.tainted(seenDead + TAINT_GRACE_MS + 1)).toBeUndefined();
  });

  test("the grace is real: a claim one second after an end note still counts", async () => {
    expect(TAINT_GRACE_MS).toBeGreaterThanOrEqual(1000);
    const e = await env();
    const started = new Date(Date.now() - 60_000);
    const record = { ...describeRun({ turnId: "chat-g", subject: OTHER, backends: ["claude"], at: started, loosened: true }), pid: 2 ** 22 + 7, pidStart: 1 };
    const ended = new Date(started.getTime() + 30_000);
    await noteEnded(e, record, ended);
    expect(await taintedAt(e, ended.getTime() + 1000, () => null)).toContain("chat-g");
  });
});

describe("the runner asks its own memory first (final review: task.ts consulting TaintWatch)", () => {
  test("runnerTaint: a record deleted after the runner saw it still taints; what is on disk alone would not", async () => {
    const e = await env();
    const child = sleeper();
    const path = await writeRunRecord(e, loosenedFor(child.pid, new Date(Date.now() - 5000)));
    const runner = await runnerTaint(e, true);
    try {
      await rm(path);
      child.kill("SIGKILL");
      await child.exited;
      expect(await taintedAt(e, Date.now())).toBeUndefined();
      expect(await runner.tainted(Date.now())).toContain("without an end note");
    } finally {
      runner.stop();
    }
    // With nothing seen, it falls through to what is on disk.
    const quiet = await runnerTaint(await env(), false);
    expect(await quiet.tainted(Date.now())).toBeUndefined();
  });

  test("the task command's runner signs through runnerTaint, and hands its answer to every release", async () => {
    const source = await Bun.file(new URL("../../bin/commands/task.ts", import.meta.url)).text();
    expect(source).toMatch(/const \{ tainted, stop: stopWatching \} = await runnerTaint\(env, record\.operate === 2\);/);
    expect(source).toMatch(/watchApprovals\(\{[^}]*\btainted \}\)/);
    expect(source).not.toMatch(/tainted: \(at: number\) => taintedAt\(/);
  });
});
