/**
 * What the web page shows of a task (D-154, S17.10): the recent tasks for `/api/state`, and the newest screenshot
 * its browser took (`docker/browser/record.cjs` writes one after every page load, under the subject's personal
 * directory). Read here, in the page's process, the way the page reads the proposal store.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { browserOutDir, type BrowserEnv } from "../browser/paths.ts";
import { isSubjectId, type SubjectId } from "../types.ts";
import { dataRoot } from "../state.ts";
import { readApprovals, type ActionApproval } from "./approvals.ts";
import { listTasks, readTask, taskDirIn, tasksDir, type TaskRecord } from "./store.ts";
import { summarise, type TaskSummary } from "./view.ts";

/** A task's approvals (D-156), from its store and — while its browser runs — from its recording. */
export async function approvalsOf(env: BrowserEnv, tasks: string, record: TaskRecord, now: Date): Promise<readonly ActionApproval[]> {
  if (record.operate < 2) return [];
  return readApprovals(taskDirIn(tasks, record.id), browserOutDir(env, record.subject, record.id), record.id, now);
}

/** Every approval still waiting for the owner, across the newest tasks: what the page's "Waiting for you" shows. */
export async function pendingApprovals(env: BrowserEnv, subject: SubjectId, now: Date, limit = 10): Promise<readonly (ActionApproval & { readonly goal: string })[]> {
  const dir = await tasksDir(env, subject);
  if (!dir.ok) return [];
  const out: (ActionApproval & { goal: string })[] = [];
  for (const record of (await listTasks(dir.path, subject)).records.slice(0, limit)) {
    for (const approval of await approvalsOf(env, dir.path, record, now)) if (approval.status === "pending") out.push({ ...approval, goal: record.goal });
  }
  return out;
}

/** The newest tasks, as every channel is shown them. */
export async function recentTasks(env: BrowserEnv, subject: SubjectId, limit = 10): Promise<readonly TaskSummary[]> {
  const dir = await tasksDir(env, subject);
  if (!dir.ok) return [];
  return (await listTasks(dir.path, subject)).records.slice(0, limit).map((record) => summarise(record));
}

/** At most this many bytes of screenshot are sent to a page. */
export const SCREEN_MAX_BYTES = 6 * 1024 * 1024;

/** The task's newest screenshot as a `data:image/png` URL, or why there is none. */
export async function latestScreen(
  env: BrowserEnv,
  subject: SubjectId,
  id: string,
): Promise<{ readonly ok: true; readonly image: string; readonly at: string } | { readonly ok: false; readonly reason: string }> {
  const dir = await tasksDir(env, subject);
  if (!dir.ok) return { ok: false, reason: dir.reason };
  const read = await readTask(dir.path, subject, id);
  if (!read.ok) return { ok: false, reason: read.reason };
  if (read.record.operate === 0) return { ok: false, reason: "this task has no browser" };
  const screens = join(browserOutDir(env, subject, id), "screens");
  let names: string[];
  try {
    names = (await readdir(screens)).filter((name) => /^[0-9]{4}-[0-9]+\.png$/.test(name)).sort();
  } catch {
    return { ok: false, reason: "its browser has taken no screenshot yet" };
  }
  const newest = names.at(-1);
  if (newest === undefined) return { ok: false, reason: "its browser has taken no screenshot yet" };
  const path = join(screens, newest);
  const info = await stat(path);
  if (info.size > SCREEN_MAX_BYTES) return { ok: false, reason: "the newest screenshot is too large to show here" };
  const bytes = await readFile(path);
  return { ok: true, image: `data:image/png;base64,${bytes.toString("base64")}`, at: info.mtime.toISOString() };
}

/**
 * Every approval still waiting, across **all** of the owner's agents under this data root (review of PR #24,
 * round 2): a turn that can run commands does not start while any of them waits — another agent's turn has
 * the same reach as this one's.
 */
export async function pendingAnywhere(env: BrowserEnv, now: Date): Promise<readonly (ActionApproval & { readonly goal: string; readonly subject: SubjectId })[]> {
  let names: string[];
  try {
    names = await readdir(dataRoot(env.home, env.env));
  } catch {
    return [];
  }
  const out: (ActionApproval & { readonly goal: string; readonly subject: SubjectId })[] = [];
  for (const name of names.filter(isSubjectId)) {
    for (const approval of await pendingApprovals(env, name as SubjectId, now)) out.push({ ...approval, subject: name as SubjectId });
  }
  return out;
}
