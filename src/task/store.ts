/**
 * D-154 — a task: a goal handed to the agent, worked on one ordinary `turn` at a time until it is done, it runs
 * out of budget, or somebody stops it.
 *
 * ## Where it lives, and why there
 *
 * `$XDG_DATA_HOME/mind/<subject>/personal/tasks/<task>/` — beside the proposal store, for the reason that store
 * is where it is (D-029): a goal, a plan and a step's summary are free text, and free text never goes into git
 * (S3.2 AC5). Under `personal/`, so `mind erase` removes every task with everything else personal (I-4), and
 * a runner that finds its directory gone stops rather than make it again ({@link writeTask} never creates one).
 *
 * | file | what | who writes it |
 * |---|---|---|
 * | `task.json` | the record: goal, budget, plan, every step, status | `task new`, then the task's runner alone — and `task stop` once that runner is gone |
 * | `stop` | a request to stop | `task stop`, `mind stop` |
 * | `prompt-<n>.txt` | the prompt of the step running now (600, removed after the step) | the runner |
 * | `runner.log` | what a detached runner would have printed | the runner |
 * | `runner-env-<random>` | the environment a runner started in a unit of its own is to run with, as an `EnvironmentFile=` (600; S18.1, `unit.ts`) | `task new\|resume --detach`; systemd reads it as it starts the runner and the starter removes it at once (leftovers over a minute old are swept on the next start) |
 * | `approvals/` | the sensitive browser actions this task asked about (D-156, `approvals.ts`) | the runner, `task approve`/`deny` |
 *
 * One writer per file at a time is the whole concurrency rule. `task.json` is replaced whole (a temporary name,
 * then `rename`), so a reader never sees half of it; the runner is the only process that rewrites it while it
 * lives, and anything else that wants something of a running task writes its own file (`stop`, an approval's
 * claim) and lets the runner read it.
 *
 * ## What is not here
 *
 * The ledger. Each step is an ordinary turn and the turn writes its own ledger line (S2.2); the step records the
 * turn's id, which is the link between the two. Nothing here reads the ledger back (D-022).
 */

import { chmod, mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { procStat } from "../decide/runs.ts";
import { personalDir, type PersonalEnv } from "../guard/personal.ts";
import { STATE_DIR_MODE, STATE_FILE_MODE } from "../state.ts";
import type { SubjectId } from "../types.ts";

/** The id a task record is written under. */
export const TASK_SCHEMA = "mind/task@1";
export const TASKS_DIR = "tasks";
export const TASK_FILE = "task.json";
export const STOP_FILE = "stop";
export const LOG_FILE = "runner.log";

export type TaskEnv = PersonalEnv;

/**
 * Where a task is. `planning`, `running`, `waiting` (paused on an owner's answer, D-156) and `waiting-backend`
 * (the backend its steps need is not ready — the local model asleep or down, S18.2) are a runner's to set while it
 * lives. `parked` (S18.2, D-164) is set by a runner as it leaves: the task is set aside, not ended, with no runner
 * behind it — `task resume` carries it on, `task stop` ends it. The other four are final and never left.
 */
export type TaskStatus = "planning" | "running" | "waiting" | "waiting-backend" | "parked" | "done" | "failed" | "stopped" | "budget";

/** What a reader is told: the record's status, or `interrupted` when no runner is behind a status that needs one. */
export type ShownStatus = TaskStatus | "interrupted";

/** Statuses a person may carry on with `task resume`. */
export function resumable(status: ShownStatus): boolean {
  return status === "interrupted" || status === "parked";
}

export const FINAL_STATUSES: readonly TaskStatus[] = ["done", "failed", "stopped", "budget"];

export function isFinal(status: TaskStatus): boolean {
  return FINAL_STATUSES.includes(status);
}

/** The most a task may spend. `tokens: null` is no token limit — turns and minutes always apply. */
export interface Budget {
  readonly turns: number;
  readonly minutes: number;
  readonly tokens: number | null;
}

/** One step: one turn, from its start to what it said. */
export interface TaskStep {
  readonly n: number;
  /** `plan` is the first turn (the plan, nothing done); every other turn is a `step`. */
  readonly kind: "plan" | "step";
  readonly startedAt: string;
  /** `null` while the turn runs — or after a crash, until the next runner closes it as interrupted. */
  readonly finishedAt: string | null;
  /** The turn's own id: the same id its ledger line carries. `null` when the turn never said one. */
  readonly turnId: string | null;
  readonly backend: string | null;
  readonly exit: number | null;
  /**
   * `no-backend` (S18.2): the turn got no answer and the backend was found not ready right after — the local model
   * asleep or down. It is not a failed step: it does not count against the turns, the minutes or the two failures in
   * a row, and the runner waits for the backend before the next one.
   */
  readonly outcome: "ok" | "unreadable" | "failed" | "no-backend" | "interrupted" | "stopped" | null;
  /** The model's own one or two sentences about the step, or why there are none. */
  readonly summary: string;
  readonly done: boolean;
  /** Input + output tokens as the backend counted them; `null` when it did not say. */
  readonly tokens: number | null;
  readonly ms: number | null;
  /** Time this step spent paused on an owner's answer (D-156): not counted against the budget's minutes. */
  readonly waitedMs: number;
}

/** A runner process, as `/proc` identifies it: pid and start time, so a reused pid is not mistaken for it. */
export interface ProcessId {
  readonly pid: number;
  readonly start: number | null;
}

export interface TaskRecord {
  readonly schema: string;
  readonly id: string;
  readonly subject: SubjectId;
  /** The agent directory every step's turn is run with (`turn <dir>`). */
  readonly dir: string;
  /** Where every step's turn runs: D-043's report of changed files is about this directory. */
  readonly cwd: string;
  readonly goal: string;
  readonly createdAt: string;
  readonly via: "cli" | "web";
  /** `turn --backend`, as given; `null` for the usual chain. */
  readonly backend: string | null;
  readonly model: string | null;
  /** The browser this task may have (D-153): 0 none, 1 look, 2 act on {@link allow}. The dial can only lower it. */
  readonly operate: 0 | 1 | 2;
  /** Normalised origins the task's browser may reach. */
  readonly allow: readonly string[];
  readonly budget: Budget;
  /** One step's turn may run this long (its own timeout), plus one approval's wait. */
  readonly stepSeconds: number;
  /** How long a sensitive action waits for the owner's answer before it is a no (D-156). */
  readonly approvalSeconds: number;
  readonly status: TaskStatus;
  readonly statusAt: string;
  /** Why a final status was reached, in words — or why it waits on its backend, or was parked (S18.2). */
  readonly reason: string | null;
  readonly plan: readonly string[] | null;
  readonly steps: readonly TaskStep[];
  /** The model's answer to the goal, when it said the goal was reached. */
  readonly result: string | null;
  readonly used: {
    readonly turns: number;
    /** Wall time of the steps, minus the time paused on an owner's answer. */
    readonly activeMs: number;
    readonly tokens: number;
    /** Steps whose backend did not report tokens: the token count is then a floor, said as such. */
    readonly tokensUnknown: number;
  };
  /** The process working on it now, or `null`. */
  readonly runner: (ProcessId & { readonly since: string }) | null;
  /** The step's `mind turn` process while one runs. */
  readonly current: ProcessId | null;
  /** The task's browser while it is up (no token here: that is in the browser record, 600). */
  readonly browser: { readonly task: string; readonly port: number; readonly operate?: 1 | 2 } | null;
  /** Said to the next step's turn, then cleared: an interrupted step, an owner's no. */
  readonly notes: readonly string[];
  /** How many runners have claimed this task (`runner.ts`): the next one claims `generation + 1`. */
  readonly generation: number;
  /** S18.2: how long it waits for its backend before it is parked. Absent: `DEFAULT_BACKEND_WAIT_MINUTES` (30). */
  readonly backendWaitMinutes?: number;
}

const TASK_ID = /^t-[0-9a-f]{8}$/;

/** A task id: `t-` and eight hex — also a valid browser task id (`src/browser/runtime.ts`). */
export function isTaskId(id: string): boolean {
  return TASK_ID.test(id);
}

export function newTaskId(): string {
  return `t-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/** `personal/tasks/`, if the personal directory is outside git — resolved, not created. */
export async function tasksDir(env: TaskEnv, subject: SubjectId): Promise<{ readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string }> {
  const parent = await personalDir(env, subject);
  if (!parent.ok) return { ok: false, reason: parent.reason };
  return { ok: true, path: join(parent.path, TASKS_DIR) };
}

export function taskDirIn(tasks: string, id: string): string {
  if (!isTaskId(id)) throw new Error(`not a task id: ${JSON.stringify(id)}`);
  return join(tasks, id);
}

async function privateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: STATE_DIR_MODE });
  await chmod(path, STATE_DIR_MODE);
}

/** Replace a file whole: written and synced under a temporary name, then renamed. Never creates a directory. */
export async function replaceFile(path: string, text: string): Promise<void> {
  const temp = `${path}.mind-${process.pid}-${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    const handle = await open(temp, "wx", STATE_FILE_MODE);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (cause) {
    await unlink(temp).catch(() => undefined);
    throw cause;
  }
}

/** Create a task's directory and its first record. Refuses a task that exists (`wx`). */
export async function createTask(tasks: string, record: TaskRecord): Promise<string> {
  await privateDir(tasks);
  const dir = taskDirIn(tasks, record.id);
  await mkdir(dir, { mode: STATE_DIR_MODE });
  const path = join(dir, TASK_FILE);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: STATE_FILE_MODE, flag: "wx" });
  return path;
}

/**
 * Rewrite a task's record. Into a directory that exists or not at all: a task erased under a running runner
 * stays erased, and the runner learns it from the error.
 */
export async function writeTask(tasks: string, record: TaskRecord): Promise<void> {
  await replaceFile(join(taskDirIn(tasks, record.id), TASK_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

function isRecord(value: unknown): value is TaskRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  const budget = r["budget"] as Record<string, unknown> | undefined;
  return (
    r["schema"] === TASK_SCHEMA &&
    typeof r["id"] === "string" &&
    isTaskId(r["id"]) &&
    typeof r["subject"] === "string" &&
    typeof r["goal"] === "string" &&
    typeof r["dir"] === "string" &&
    typeof r["cwd"] === "string" &&
    typeof r["status"] === "string" &&
    Array.isArray(r["steps"]) &&
    Array.isArray(r["allow"]) &&
    (r["operate"] === 0 || r["operate"] === 1 || r["operate"] === 2) &&
    typeof budget === "object" &&
    budget !== null &&
    typeof budget["turns"] === "number" &&
    typeof budget["minutes"] === "number" &&
    typeof r["used"] === "object" &&
    r["used"] !== null
  );
}

export type ReadTask =
  | { readonly ok: true; readonly record: TaskRecord; readonly dir: string }
  | { readonly ok: false; readonly reason: string; readonly missing: boolean };

/** One task, by id — refused when the record on disk is not one, or names another task or subject. */
export async function readTask(tasks: string, subject: SubjectId, id: string): Promise<ReadTask> {
  if (!isTaskId(id)) return { ok: false, reason: `${JSON.stringify(id)} is not a task id (t- and eight hex)`, missing: true };
  const dir = join(tasks, id);
  let raw: string;
  try {
    raw = await readFile(join(dir, TASK_FILE), "utf8");
  } catch {
    return { ok: false, reason: `no task ${id} for subject ${subject}`, missing: true };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { ok: false, reason: `${join(dir, TASK_FILE)} is not a task record`, missing: false };
    if (parsed.id !== id || parsed.subject !== subject) {
      return { ok: false, reason: `${join(dir, TASK_FILE)} names another task or subject`, missing: false };
    }
    return { ok: true, record: parsed, dir };
  } catch {
    return { ok: false, reason: `${join(dir, TASK_FILE)} is not JSON`, missing: false };
  }
}

/** Every task of a subject, newest first; what does not read is reported, not thrown. */
export async function listTasks(
  tasks: string,
  subject: SubjectId,
): Promise<{ readonly records: readonly TaskRecord[]; readonly unreadable: readonly string[] }> {
  let names: string[];
  try {
    names = await readdir(tasks);
  } catch {
    return { records: [], unreadable: [] };
  }
  const records: TaskRecord[] = [];
  const unreadable: string[] = [];
  for (const name of names.filter(isTaskId)) {
    const read = await readTask(tasks, subject, name);
    if (read.ok) records.push(read.record);
    else unreadable.push(read.reason);
  }
  records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { records, unreadable };
}

/** Ask a task to stop: a file the runner looks for before every step, and while it waits. */
export async function requestStop(taskDir: string, by: string, at: Date): Promise<void> {
  await writeFile(join(taskDir, STOP_FILE), `${JSON.stringify({ by, at: at.toISOString() })}\n`, { mode: STATE_FILE_MODE });
}

export async function stopRequested(taskDir: string): Promise<boolean> {
  try {
    await readFile(join(taskDir, STOP_FILE));
    return true;
  } catch {
    return false;
  }
}

/** Is this the process the record names — the same pid, started at the same moment? */
export function alive(
  process_: ProcessId | null | undefined,
  stat: (pid: number) => { readonly startTicks: number } | null = procStat,
): boolean {
  if (process_ === null || process_ === undefined) return false;
  const now = stat(process_.pid);
  if (now === null) return false;
  return process_.start === null || now.startTicks === process_.start;
}

/** This process, as a record names it. */
export function thisProcess(stat: (pid: number) => { readonly startTicks: number } | null = procStat): ProcessId {
  return { pid: process.pid, start: stat(process.pid)?.startTicks ?? null };
}

/**
 * The status a person is told. A record that says `running` with no runner behind it was interrupted — killed,
 * crashed, or its machine rebooted — and `task resume` picks it up from the step it was on.
 */
export function shownStatus(
  record: TaskRecord,
  stat: (pid: number) => { readonly startTicks: number } | null = procStat,
  now: number = Date.now(),
): ShownStatus {
  if (isFinal(record.status) || record.status === "parked") return record.status;
  if (alive(record.runner, stat)) return record.status;
  // A task just made with --detach, whose runner has not claimed it yet, is starting — not interrupted.
  const young = now - Date.parse(record.createdAt) < STARTING_MS;
  return (record.generation ?? 0) === 0 && young ? record.status : "interrupted";
}

/** How long a task nobody has run yet counts as starting rather than interrupted. */
export const STARTING_MS = 60_000;

/** The step running now: the last one, if it has not finished. */
export function openStep(record: TaskRecord): TaskStep | undefined {
  const last = record.steps.at(-1);
  return last !== undefined && last.finishedAt === null ? last : undefined;
}
