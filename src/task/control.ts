/**
 * Stopping a task (D-154): `task stop`, and `mind stop`'s reach into every task.
 *
 * A stop is asked, then made sure of:
 *
 * 1. the task's `stop` file — the runner looks for it before every step and after each one, so no next step
 *    starts;
 * 2. the step's turn, if one is running, is ended the way `mind stop` ends any turn: its run record, its pid
 *    and start time checked, SIGTERM then SIGKILL to what it started (D-044, `terminateRun`) — the step's vendor
 *    CLI runs in a process group of its own, so ending only the `turn` process would leave it running;
 * 3. the runner then closes the task as `stopped`, ends its browser and exits. A task whose runner is gone
 *    already is closed here instead — nothing else is writing its record.
 * 4. S18.1: a runner in a unit of its own (`unit.ts`) — its unit is stopped too: once the task is closed (the unit
 *    then ends with the runner), and before giving up on a runner that has not closed it in time — SIGTERM to it
 *    with the stop asked, which it answers by closing the task, and SIGKILL to what is left after
 *    `UNIT_STOP_SECONDS`.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readRuns, readRunsAt, terminateRun, type RunEnv, type TerminationReport } from "../decide/runs.ts";
import { dataRoot } from "../state.ts";
import { isSubjectId, type SubjectId } from "../types.ts";
import { UNIT_STOP_SECONDS } from "./unit.ts";
import { alive, isFinal, listTasks, readTask, requestStop, taskDirIn, tasksDir, writeTask, type TaskEnv, type TaskRecord } from "./store.ts";

export interface StopDeps {
  readonly now: () => Date;
  readonly by: string;
  /** Ends a recorded turn. Defaults to `terminateRun` with D-044's ~4 s between SIGTERM and SIGKILL. */
  readonly end?: typeof terminateRun;
  readonly stat?: (pid: number) => { readonly startTicks: number } | null;
  /** Sends a signal to the step's turn when it has no run record yet. */
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** End the task's browser container when nothing else will — its runner is gone (review of PR #24). */
  readonly endBrowser?: (task: string) => Promise<void>;
  /** How long to wait for the runner to close the task after its step ended. */
  readonly waitMs?: number;
  /** S18.1: stop the task's unit, when it has one (`endTaskUnit`). */
  readonly endUnit?: (task: string) => Promise<unknown>;
  /** How long to wait for a stopped unit's runner. */
  readonly unitWaitMs?: number;
}

export interface StopResult {
  readonly id: string;
  /** What became of it: stopped now, stopped already, ended before (final), or asked and still closing. */
  readonly outcome: "stopped" | "asked" | "already-final";
  readonly status: string;
  readonly turn: TerminationReport | null;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

/**
 * End a step's turn the way `mind stop` ends any turn: through its run record (D-044's SIGTERM, then
 * SIGKILL to what it started). The record is written just before the turn sends; a turn that has none yet has
 * started no vendor CLI, so after a second without one the turn process alone is ended.
 */
export async function endStepTurn(
  env: RunEnv,
  current: { readonly pid: number; readonly start: number | null } | null,
  deps: { readonly stat?: (pid: number) => { readonly startTicks: number } | null; readonly kill?: (pid: number, signal: NodeJS.Signals) => void; readonly end?: typeof terminateRun },
): Promise<TerminationReport | null> {
  if (current === null || !alive(current, deps.stat)) return null;
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const asked = Date.now();
  for (;;) {
    const stored = (await readRuns(env)).runs.find((run) => run.record.pid === current.pid);
    if (stored !== undefined) return (deps.end ?? terminateRun)(stored, { settle, attempts: 160 });
    if (!alive(current, deps.stat)) return null;
    if (Date.now() - asked > 1000) {
      try {
        kill(current.pid, "SIGTERM");
      } catch {
        // Gone between the check and the signal: that is what was asked for.
      }
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Stop one task of a subject. */
export async function stopTask(env: TaskEnv & RunEnv, tasks: string, subject: SubjectId, id: string, deps: StopDeps): Promise<{ readonly ok: true; readonly result: StopResult } | { readonly ok: false; readonly reason: string }> {
  const read = await readTask(tasks, subject, id);
  if (!read.ok) return { ok: false, reason: read.reason };
  if (isFinal(read.record.status)) {
    return { ok: true, result: { id, outcome: "already-final", status: read.record.status, turn: null } };
  }
  const taskDir = taskDirIn(tasks, id);
  await requestStop(taskDir, deps.by, deps.now());

  // The step's turn writes its run record just before it sends; a stop that arrives while it is still getting
  // ready finds none yet. Asked again until it appears — and a turn that has not written one has started no
  // vendor CLI either, so after a second without one, the turn process alone is ended.
  const turn = await endStepTurn(env, read.record.current, deps);

  // The runner closes it; give it a moment. A runner that is gone cannot, so it is closed here.
  let until = Date.now() + (deps.waitMs ?? 15_000);
  let unitStopped = false;
  for (;;) {
    const now = await readTask(tasks, subject, id);
    if (!now.ok) return { ok: false, reason: now.reason };
    if (isFinal(now.record.status)) {
      if (deps.endUnit !== undefined) await deps.endUnit(id).catch(() => undefined);
      return { ok: true, result: { id, outcome: "stopped", status: now.record.status, turn } };
    }
    if (!alive(now.record.runner, deps.stat)) {
      const closed: TaskRecord = {
        ...now.record,
        status: "stopped",
        statusAt: deps.now().toISOString(),
        reason: "it was asked to stop",
        runner: null,
        current: null,
        browser: null,
      };
      await writeTask(tasks, closed);
      // Its runner would have ended the container; it is gone, so this does.
      if (deps.endBrowser !== undefined) await deps.endBrowser(id).catch(() => undefined);
      if (deps.endUnit !== undefined) await deps.endUnit(id).catch(() => undefined);
      return { ok: true, result: { id, outcome: "stopped", status: "stopped", turn } };
    }
    if (Date.now() > until) {
      // The runner has not closed it: its unit is stopped, which SIGTERMs it with the stop asked — then waited on
      // for as long as systemd gives it before SIGKILL, after which the loop above closes the task itself.
      if (deps.endUnit !== undefined && !unitStopped) {
        unitStopped = true;
        await deps.endUnit(id).catch(() => undefined);
        until = Date.now() + (deps.unitWaitMs ?? (UNIT_STOP_SECONDS + 5) * 1000);
        continue;
      }
      return { ok: true, result: { id, outcome: "asked", status: now.record.status, turn } };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * `mind stop`'s reach into tasks: every task under this data root that has not ended is asked to stop. The
 * turns themselves are ended by `stop`'s own step 3 (every run record), and the browsers by its step 4.
 */
export async function askEveryTaskToStop(env: TaskEnv, now: Date, by: string): Promise<readonly { readonly subject: string; readonly id: string; readonly status: string }[]> {
  let subjects: string[];
  try {
    subjects = await readdir(dataRoot(env.home, env.env));
  } catch {
    return [];
  }
  const asked: { subject: string; id: string; status: string }[] = [];
  for (const name of subjects.filter(isSubjectId)) {
    const subject = name as SubjectId;
    const dir = await tasksDir(env, subject);
    if (!dir.ok) continue;
    const { records } = await listTasks(dir.path, subject);
    for (const record of records.filter((r) => !isFinal(r.status))) {
      await requestStop(join(dir.path, record.id), by, now);
      asked.push({ subject, id: record.id, status: record.status });
    }
  }
  return asked;
}



/** What `erase` did to one of the subject's unfinished tasks before deleting anything. */
export interface EndedTask {
  readonly id: string;
  /** The runner was signalled (SIGTERM, verified by its start time), or there was none alive. */
  readonly runner: "ended" | "none";
  /** The step's turn, if one ran: ended like `mind stop` ends a turn. */
  readonly turn: TerminationReport | null;
}

/**
 * Review of PR #22: `erase` ends a subject's tasks first — no next step, no step turn left to write a ledger
 * line after the certificate. Each unfinished task is asked to stop, its runner is ended (so it starts
 * nothing more), and its step's turn, if any, is ended through its run record (`runsRoot`, the state root's
 * `runs/`) with D-044's SIGTERM then SIGKILL.
 */
export async function endTasksForErase(
  tasks: string,
  subject: SubjectId,
  runsRoot: string,
  deps: { readonly now: Date; readonly stat?: (pid: number) => { readonly startTicks: number } | null; readonly kill?: (pid: number, signal: NodeJS.Signals) => void; readonly end?: typeof terminateRun } ,
): Promise<readonly EndedTask[]> {
  const { records } = await listTasks(tasks, subject);
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const ended: EndedTask[] = [];
  for (const record of records.filter((r) => !isFinal(r.status))) {
    await requestStop(taskDirIn(tasks, record.id), "mind erase", deps.now);
    let runner: EndedTask["runner"] = "none";
    if (record.runner !== null && alive(record.runner, deps.stat)) {
      try {
        kill(record.runner.pid, "SIGTERM");
        runner = "ended";
      } catch {
        // Gone between the check and the signal.
      }
    }
    let turn: TerminationReport | null = null;
    const current = record.current;
    if (current !== null && alive(current, deps.stat)) {
      const stored = (await readRunsAt(runsRoot)).runs.find((run) => run.record.pid === current.pid);
      if (stored !== undefined) turn = await (deps.end ?? terminateRun)(stored, { settle, attempts: 160 });
      else {
        try {
          kill(current.pid, "SIGTERM");
        } catch {
          // Gone already.
        }
      }
    }
    ended.push({ id: record.id, runner, turn });
  }
  return ended;
}
