/**
 * D-156 — the owner's answer to one held action, from the two places an owner answers: a terminal
 * (`task approve|deny`) and the web page (behind its key). Never from a turn.
 *
 * ## What keeps a turn from answering (reviews of PR #24)
 *
 * The owner's turns run as the owner's uid, and a turn at write/run 2 has a shell. What it could use, and what
 * stops it:
 *
 * 1. **The release itself.** Ed25519 (round 3): the runner makes the pair when the task's browser starts, after
 *    making itself not dumpable (so `/proc/<pid>/mem` is closed even to the turn that started it; it refuses to
 *    start under a turn at all), and keeps the private key in its memory only. The container gets the public
 *    key and verifies with it. The runner alone writes releases (`writeReleases`).
 * 2. **A claim written directly** in the task's store. The runner checks a yes again before it signs it: one
 *    claimed while any turn of the owner's that can run commands ran — of any agent — is tainted
 *    ({@link taintedAt}, and the runner's own memory of every such turn it saw, `taint-watch.ts`, which a turn
 *    deleting or flipping its run record cannot erase) and released as a no; a yes for a step that is not
 *    running, or a task that has ended, is released as a no.
 * 3. **`task approve` at a fake terminal** (`script`). All three streams must be terminals, and no process above
 *    may be a recorded turn or a task's runner ({@link agentAncestor}, walking `/proc` parent ids).
 * 4. **The web page's key.** While any loosened turn of the owner runs, no answer is taken from the page or the
 *    terminal ({@link loosenedTurn}); and a loosened turn does not start while any held action waits.
 *
 * **What is left, exactly (Q4, the owner's decision):** any process of the owner's user can bypass holds. That
 * includes a process left running after every loosened turn has ended (by the page's key, or a claim the runner
 * then signs), and — the larger door — **a running loosened turn through the docker socket**: the owner is in
 * the `docker` group, so such a turn can `docker exec -u 0` into the task's container and drive Chromium
 * directly, past `record.cjs` altogether. That is root-equivalent and outside this code; nothing here tries to
 * engineer around it. Closing it needs Q4: a separate user for the runner and its store, or a passkey for each
 * yes **and** no docker group for the user turns run as. Until then this is D-042's limit (anything running as
 * the owner's uid can do what the owner's uid can).
 *
 * **How the page is read (D-160), and what is left of it.** Nothing about an element is read in the page's own
 * JavaScript any more (last review round): where keys go, what is at a point, whether an element is a text
 * field or a password field, and whether a password field anywhere holds something are read through CDP in an
 * isolated world (`docker/browser/cdp-read.cjs`) — through every shadow root, closed and declarative included,
 * and every frame — so a page that redefines `tagName`, `isContentEditable`, `getAttribute`, `value` or
 * `shadowRoot` changes nothing. A shadow host is never a text field. What cannot be read — no CDP, an error, a
 * frame of another process that keys would go to — is held. Keys that would land anywhere but a text field ask.
 * What is left:
 * - A page can copy what the model typed into an ordinary field into a password field (or send it as one) at
 *   submit time, in its own script.
 * - A page can keylog an ordinary text field. D-160 classifies by the field a key lands in, not by what the
 *   page's own script does with it.
 * - And Q4 above: anything running as the owner's user — the docker socket included — can bypass the holds.
 */

import { readFileSync } from "node:fs";
import { readBrowserRecords } from "../browser/store.ts";
import type { BrowserEnv } from "../browser/paths.ts";
import { procStat, readEnded, readRuns, type RunEnv } from "../decide/runs.ts";
import type { SubjectId } from "../types.ts";
import { decideApproval, type Decision } from "./approvals.ts";
import { alive, isFinal, listTasks, openStep, readTask, requestStop, taskDirIn } from "./store.ts";

export type Answer =
  | Decision
  | { readonly ok: false; readonly kind: "no-task" | "ended" | "no-browser" | "agent"; readonly reason: string };

type Stat = (pid: number) => { readonly startTicks: number } | null;

/** The parent of a process, from `/proc/<pid>/stat`, or `null`. */
export function parentOf(pid: number, read: (path: string) => string = (path) => readFileSync(path, "utf8")): number | null {
  try {
    const raw = read(`/proc/${pid}/stat`);
    const ppid = Number(raw.slice(raw.lastIndexOf(")") + 2).split(" ")[1]);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

/** The pids above `pid`, nearest first, up to init. */
export function ancestors(pid: number, parent: (pid: number) => number | null = parentOf): number[] {
  const out: number[] = [];
  for (let at = parent(pid); at !== null && at > 1 && out.length < 256; at = parent(at)) out.push(at);
  return out;
}

/** A recorded mind turn, or a task's runner, among the processes above this one — or `undefined`. */
export async function agentAncestor(
  env: RunEnv,
  tasks: string,
  subject: SubjectId,
  options: { readonly pid?: number; readonly parent?: (pid: number) => number | null; readonly stat?: Stat } = {},
): Promise<string | undefined> {
  const above = new Set(ancestors(options.pid ?? process.pid, options.parent));
  for (const { record } of (await readRuns(env)).runs) {
    if (above.has(record.pid) && alive({ pid: record.pid, start: record.pidStart }, options.stat ?? procStat)) return `turn ${record.turnId}`;
  }
  for (const record of (await listTasks(tasks, subject)).records) {
    if (record.runner !== null && above.has(record.runner.pid) && alive(record.runner, options.stat ?? procStat)) return `task ${record.id}'s runner`;
  }
  return undefined;
}

/**
 * A running turn that may run commands, of **any** of the owner's agents, or `undefined` (review of PR #24,
 * round 2): another agent's turn has the same uid and the same reach to the page's key and the task's store.
 */
export async function loosenedTurn(env: RunEnv, stat: Stat = procStat): Promise<string | undefined> {
  for (const { record } of (await readRuns(env)).runs) {
    if (record.loosened === true && alive({ pid: record.pid, start: record.pidStart }, stat)) return `${record.turnId} (agent ${record.subject})`;
  }
  return undefined;
}

/**
 * Was a turn that could run commands running at `at` (ms) — any agent's (review of PR #24, round 3)? Running
 * now; recorded and gone without a note (killed: when it ended is not known, so from its start on); or noted
 * as ended at or after `at`. A claim made then may be that turn's own, and is never signed.
 */
export async function taintedAt(env: RunEnv, at: number, stat: Stat = procStat): Promise<string | undefined> {
  const now = await loosenedTurn(env, stat);
  if (now !== undefined) return now;
  for (const { record } of (await readRuns(env)).runs) {
    if (record.loosened === true && Date.parse(record.startedAt) <= at) return `${record.turnId} (agent ${record.subject}, stopped without a note)`;
  }
  for (const ended of await readEnded(env)) {
    if (Date.parse(ended.startedAt) <= at && at <= Date.parse(ended.endedAt) + TAINT_GRACE_MS) return `${ended.turnId} (agent ${ended.subject}, ended ${ended.endedAt})`;
  }
  return undefined;
}

/** A claim made this soon after a loosened turn ended still counts as made during it. */
export const TAINT_GRACE_MS = 2000;

export async function answerHeld(options: {
  readonly env: BrowserEnv;
  readonly tasks: string;
  readonly subject: SubjectId;
  readonly task: string;
  readonly approval: string;
  readonly verdict: "approve" | "deny";
  readonly by: string;
  readonly stop: boolean;
  readonly now: Date;
  readonly from: "terminal" | "web";
  readonly stat?: Stat;
  readonly parent?: (pid: number) => number | null;
}): Promise<Answer> {
  const read = await readTask(options.tasks, options.subject, options.task);
  if (!read.ok) return { ok: false, kind: "no-task", reason: read.reason };
  // No answer while something that runs commands for this subject is running, nor from below a turn.
  const running = await loosenedTurn(options.env, options.stat);
  if (running !== undefined) {
    return { ok: false, kind: "agent", reason: `a turn that can run commands is running (${running}); held actions are answered when it has ended` };
  }
  if (options.from === "terminal") {
    const above = await agentAncestor(options.env, options.tasks, options.subject, { ...(options.parent === undefined ? {} : { parent: options.parent }), ...(options.stat === undefined ? {} : { stat: options.stat }) });
    if (above !== undefined) return { ok: false, kind: "agent", reason: `this command runs under ${above} — a held action is answered by a person, not from inside a turn` };
  }
  // Review of PR #24, finding 5: the task and the step that asked must still be running.
  if (isFinal(read.record.status)) return { ok: false, kind: "ended", reason: `task ${read.record.id} has ended (${read.record.status}); its held actions count as no` };
  const browser = (await readBrowserRecords(options.env, options.subject)).records.find((record) => record.task === read.record.id);
  if (browser === undefined) return { ok: false, kind: "no-browser", reason: `task ${read.record.id}'s browser is gone, so there is nothing waiting to release` };
  const taskDir = taskDirIn(options.tasks, read.record.id);
  const stop = options.verdict === "deny" && options.stop;
  const decided = await decideApproval({
    taskDir,
    task: read.record.id,
    id: options.approval,
    verdict: options.verdict,
    by: options.by,
    now: options.now,
    stop,
    outDir: browser.outDir,
    openStep: openStep(read.record)?.n ?? null,
  });
  if (decided.ok && stop) await requestStop(taskDir, `${options.by}: no, and stop`, options.now);
  return decided;
}

/** The exit code / HTTP status an answer maps to. */
export function answerCode(answer: Answer): { readonly exit: number; readonly status: number } {
  if (answer.ok) return { exit: 0, status: 200 };
  if (answer.kind === "missing" || answer.kind === "no-task") return { exit: 2, status: 404 };
  if (answer.kind === "agent") return { exit: 4, status: 403 };
  return { exit: 5, status: 409 };
}
