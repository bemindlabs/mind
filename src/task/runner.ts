/**
 * D-154 — the loop that carries a task: plan, step, observe, decide next, until the goal is reached, the budget
 * is spent, or somebody stops it.
 *
 * Pure of processes: everything that touches the world — running a step's turn, the brake, the browser, the
 * clock — is handed in ({@link RunnerDeps}), so every branch is tested without a model. `bin/commands/task.ts`
 * wires the real ones; `spawn-turn.ts` is the one that runs `mind turn`.
 *
 * ## Each step is an ordinary turn
 *
 * The runner does not talk to a backend. It writes the step's prompt and runs `mind turn` with it, as a
 * child — the way a trigger does (D-054) — so the ledger, the dial, the fence, egress, recall, the run record
 * that `mind stop` finds, and D-043's report all apply to every step exactly as to a typed message. A step's
 * turn is refused by everything a typed one is refused by.
 *
 * ## One runner at a time, and after a crash
 *
 * A runner claims a *generation* before it touches the record: `runners/<n>.json`, linked into place
 * (`linkClaim`, D-144's exclusive step), where `n` is one more than the record's. Two `task resume` at once both
 * read the same record and race for the same name; one gets it. A claim whose process is gone (pid and start
 * time, as run records check them) is passed over to the next number — nothing is ever unlinked, so a late
 * process cannot remove a live claim.
 *
 * A runner that dies leaves the record as it was: a status that needs a runner, with none alive behind it
 * (`interrupted`, `shownStatus`), and possibly a step with no end. The next runner closes that step as
 * `interrupted` — it counts as a turn spent, because its turn may have reached a backend — tells the next
 * step's turn so, and carries on from there. The browser does not survive: the old container's owner is gone,
 * so the sweep ends it, and the new runner brings up a fresh one (a clean profile, D-151).
 *
 * ## When the backend is not there (S18.2)
 *
 * Before every step the runner asks {@link RunnerDeps.backendReady}. While the answer is no — the local model asleep
 * because media-gen has the GPU, or down — the task is `waiting-backend`: no step starts, so no turn is spent and no
 * minute counts (the budget's minutes are the steps' own time). A step whose turn got no answer and whose backend
 * is found not ready right after is `no-backend`, not `failed`: it counts against nothing. A wait that passes its
 * limit ({@link DEFAULT_BACKEND_WAIT_MINUTES}, or the task's own) parks the task — `parked`, with the reason, no
 * runner; `task resume` carries it on and `task stop` ends it. Not `failed`: nothing about the task went wrong.
 *
 * ## Ended from outside (S18.1)
 *
 * A runner in a unit of its own is sent SIGTERM when that unit is stopped. With a stop asked (`task stop`,
 * `mind stop`, erase) that is {@link RunnerDeps.stopping}; with none — the user's manager going down for a reboot
 * — it is {@link RunnerDeps.leaving}: the runner ends its step's turn, closes the step as interrupted and leaves the
 * task as a crash would, for `task resume`, but with the record written.
 */

import { join } from "node:path";
import { linkClaim } from "../decide/proposals.ts";
import { readFile } from "node:fs/promises";
import { activeLimitMs, budgetSpent } from "./budget.ts";
import { LEFT_EXIT_CODE } from "./unit.ts";
import { DEFAULT_BACKEND_WAIT_MINUTES, type BackendState } from "./backend-ready.ts";
import { TASK_BLOCK, planPrompt, readPlan, readStep, stepPrompt } from "./prompt.ts";
import {
  alive,
  isFinal,
  openStep,
  stopRequested,
  taskDirIn,
  writeTask,
  type ProcessId,
  type TaskRecord,
  type TaskStatus,
  type TaskStep,
} from "./store.ts";

export const RUNNERS_DIR = "runners";
/** Exit codes of `mind turn` that mean nothing was sent: usage (2), and the dial or an approval saying no (4). */
const NOTHING_SENT = new Set([2, 4]);
const MAX_FAILED_IN_A_ROW = 2;
const MAX_UNREADABLE_IN_A_ROW = 3;

/** What one step's turn came back with. */
export interface StepTurn {
  readonly code: number;
  readonly text: string;
  readonly turnId: string | null;
  readonly backend: string | null;
  /** Input + output tokens, or `null` when the backend did not say. */
  readonly tokens: number | null;
  readonly ms: number;
  /** The last lines of the turn's stderr: why, when it did not answer. */
  readonly error: string;
}

/** What the approval channel (D-156) says while a step runs. */
export interface StepWatch {
  /** A sensitive action is paused on the owner's answer right now. */
  readonly waiting: boolean;
  /** How long this step has spent paused so far. */
  readonly waitedMs: number;
  /** Said to the next step: an owner's no, an answer that did not come. */
  readonly notes: readonly string[];
  /** The owner said no and asked for the task to stop. */
  readonly stop: boolean;
}

export interface RunnerDeps {
  /** `personal/tasks/` of the task's subject. */
  readonly tasks: string;
  readonly now: () => Date;
  readonly say: (line: string) => void;
  /** Is the brake (`mind stop`) on? */
  readonly brake: () => Promise<boolean>;
  /** Run one step's turn. `started` is told the turn's process the moment it exists. */
  readonly turn: (record: TaskRecord, prompt: string, n: number, started: (process_: ProcessId) => Promise<void>) => Promise<StepTurn>;
  /** Bring up the task's browser when it has one (operate ≥ 1). */
  readonly browserUp?: (record: TaskRecord, level: 1 | 2) => Promise<{ readonly ok: true; readonly task: string; readonly port: number } | { readonly ok: false; readonly reason: string }>;
  /**
   * Make this runner not dumpable (`notDumpable`, src/task/harden.ts) before a browser that can ask is started:
   * its memory holds that browser's private release key (review of PR #24, round 3). Fails closed: absent, or
   * failing, and an operate-2 browser does not start.
   */
  readonly harden?: () => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  /** The dial's browser level for this agent now (`min(operate, reach)`, D-153). Absent: the task's own. */
  readonly dialOperate?: () => Promise<number>;
  readonly browserDown?: (record: TaskRecord) => Promise<void>;
  /** Asked every {@link RunnerDeps.pollMs} while a step runs (D-156). */
  readonly watch?: (record: TaskRecord, step: TaskStep, ended: boolean) => Promise<StepWatch>;
  /**
   * End the step's turn early (`mind stop`'s way, through its run record): when its active time — the wall
   * time minus the time paused on the owner — passes the step's own limit, or when the dial lowers the
   * browser below its container's level mid-step (reviews of PR #24, findings 5 and 9).
   */
  readonly endTurn?: (process_: ProcessId) => Promise<void>;
  readonly pollMs?: number;
  /** This runner. */
  readonly self: ProcessId;
  /** True once this runner was asked to stop (SIGTERM). */
  readonly stopping: () => boolean;
  readonly stat?: (pid: number) => { readonly startTicks: number } | null;
  /** S18.2: is the backend this task's steps need ready? Absent: always. */
  readonly backendReady?: (record: TaskRecord) => Promise<BackendState>;
  /** How often a task waiting on its backend asks again. */
  readonly backendPollMs?: number;
  /** S18.1: this runner is being ended from outside with no stop asked; it leaves the task for `task resume`. */
  readonly leaving?: () => boolean;
}

/** A task's record disappeared under its runner — erased (I-4). The runner stops and writes nothing more. */
export class TaskGone extends Error {}

export type RunOutcome =
  | { readonly ok: true; readonly record: TaskRecord }
  | { readonly ok: false; readonly reason: string; readonly code: number };

/** Claim the next runner generation, or say which live runner holds the task. */
export async function claimRunner(
  taskDir: string,
  from: number,
  self: ProcessId,
  since: string,
  stat?: (pid: number) => { readonly startTicks: number } | null,
): Promise<{ readonly ok: true; readonly generation: number } | { readonly ok: false; readonly holder: ProcessId }> {
  for (let generation = from + 1; generation < from + 1000; generation++) {
    const claim = join(taskDir, RUNNERS_DIR, `${generation}.json`);
    const made = await linkClaim(claim, { pid: String(self.pid), start: String(self.start ?? ""), since });
    if (made === "made") return { ok: true, generation };
    const holder = await readHolder(claim);
    if (holder !== undefined && alive(holder, stat)) return { ok: false, holder };
  }
  throw new Error(`no runner generation could be claimed in ${join(taskDir, RUNNERS_DIR)}`);
}

async function readHolder(path: string): Promise<ProcessId | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as { pid?: string; start?: string };
    const pid = Number(raw.pid);
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    return { pid, start: raw.start === undefined || raw.start === "" ? null : Number(raw.start) };
  } catch {
    // Being written (a claim is written whole before it is linked, so this is a dead writer's leftover): not live.
    return undefined;
  }
}

/**
 * Carry a task until it ends or this runner is stopped. Returns the last record written.
 *
 * Refused, with nothing written, when the task is already final or another runner has it.
 */
export async function runTask(start: TaskRecord, deps: RunnerDeps): Promise<RunOutcome> {
  if (isFinal(start.status)) return { ok: false, reason: `task ${start.id} is ${start.status} already`, code: 5 };
  const taskDir = taskDirIn(deps.tasks, start.id);
  const claimed = await claimRunner(taskDir, start.generation ?? 0, deps.self, deps.now().toISOString(), deps.stat);
  if (!claimed.ok) {
    return { ok: false, reason: `task ${start.id} is being run already, by pid ${claimed.holder.pid}`, code: 5 };
  }

  let record: TaskRecord = start;
  const save = async (next: TaskRecord): Promise<void> => {
    record = next;
    try {
      await writeTask(deps.tasks, record);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw new TaskGone(`task ${start.id} is gone (erased?)`);
      throw cause;
    }
  };
  const at = () => deps.now().toISOString();
  const setStatus = (status: TaskStatus, reason: string | null = record.reason) => ({ ...record, status, statusAt: at(), reason });
  const leaving = () => deps.leaving?.() === true;

  // This runner is the task's now. A step the last one left open is closed as interrupted.
  const open = openStep(record);
  let resumed = { ...record, generation: claimed.generation, runner: { ...deps.self, since: at() }, current: null };
  if (open !== undefined) {
    resumed = {
      ...resumed,
      steps: [...record.steps.slice(0, -1), { ...open, finishedAt: at(), outcome: "interrupted", summary: "interrupted — the runner stopped during this step, so what it did is not known" }],
      used: { ...record.used, turns: record.used.turns + 1 },
      notes: [...record.notes, `Step ${open.n} was interrupted before it reported. Check what state things are in before repeating anything it may have done.`],
    };
    deps.say(`task ${record.id}: step ${open.n} was interrupted; carrying on from there`);
  }
  // A parked task's reason was why it was parked; carried on, that is history.
  await save({ ...resumed, status: record.plan === null ? "planning" : "running", statusAt: at(), ...(record.status === "parked" ? { reason: null } : {}) });

  let browserUp = false;
  try {
    // Review of PR #22: the container runs at min(task, dial) — and comes down to the dial's level, or away,
    // when the dial is lowered while the task runs. Never above either.
    const levelNow = async (): Promise<0 | 1 | 2> =>
      Math.max(0, Math.min(record.operate, deps.dialOperate === undefined ? record.operate : await deps.dialOperate())) as 0 | 1 | 2;
    const bringUp = async (level: 1 | 2): Promise<RunOutcome | undefined> => {
      if (deps.browserUp === undefined) return await finish("failed", "this task has a browser and none can be started here");
      if (level === 2) {
        const hardened = deps.harden === undefined ? { ok: false as const, reason: "nothing here can make it so" } : await deps.harden();
        if (!hardened.ok) {
          return await finish("failed", `its browser can act, and this runner — which would hold its release key — could not be made not dumpable (${hardened.reason})`);
        }
      }
      const up = await deps.browserUp(record, level);
      if (!up.ok) return await finish("failed", `its browser did not start: ${up.reason}`);
      browserUp = true;
      await save({ ...record, browser: { task: up.task, port: up.port, operate: level } });
      deps.say(`task ${record.id}: its browser is up (127.0.0.1:${up.port}, operate ${level})`);
      return undefined;
    };
    if (record.operate >= 1) {
      const level = await levelNow();
      if (level === 0) return await finish("failed", "the dial's browser level is 0 (min(operate, reach), D-153), so this task's browser cannot start");
      const failed = await bringUp(level);
      if (failed !== undefined) return failed;
    }

    /** S18.2: wait until the backend is ready, or the task is stopped, left or parked. */
    const backendWait = async (): Promise<RunOutcome | undefined> => {
      if (deps.backendReady === undefined) return undefined;
      let state = await deps.backendReady(record);
      if (state.ready) return undefined;
      const since = deps.now().getTime();
      const limitMs = (record.backendWaitMinutes ?? DEFAULT_BACKEND_WAIT_MINUTES) * 60_000;
      const working: TaskStatus = record.plan === null ? "planning" : "running";
      await save(setStatus("waiting-backend", `waiting for its backend: ${state.reason}`));
      deps.say(`task ${record.id}: waiting for its backend — ${state.reason}`);
      for (;;) {
        if (deps.stopping() || (await stopRequested(taskDir))) return await finish("stopped", "it was asked to stop");
        if (await deps.brake()) return await finish("stopped", "the brake is on (`mind stop`)");
        if (leaving()) return await leave(undefined);
        const waited = deps.now().getTime() - since;
        if (waited >= limitMs) {
          return await finish(
            "parked",
            `its backend was not ready for ${Math.round(waited / 60_000)} min (${state.reason}) — \`mind task resume\` carries it on, \`mind task stop\` ends it`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(deps.backendPollMs ?? 5000, Math.max(1, limitMs - waited))));
        state = await deps.backendReady!(record);
        if (state.ready) {
          await save(setStatus(working, null));
          deps.say(`task ${record.id}: its backend is ready again after ${Math.round((deps.now().getTime() - since) / 1000)} s`);
          return undefined;
        }
        if (record.reason !== `waiting for its backend: ${state.reason}`) await save(setStatus("waiting-backend", `waiting for its backend: ${state.reason}`));
      }
    };

    let failedInARow = 0;
    let unreadableInARow = 0;
    for (;;) {
      if (deps.stopping() || (await stopRequested(taskDir))) return await finish("stopped", "it was asked to stop");
      if (await deps.brake()) return await finish("stopped", "the brake is on (`mind stop`)");
      if (leaving()) return await leave(undefined);
      const spent = budgetSpent(record);
      if (spent !== undefined) return await finish("budget", spent);
      const waited = await backendWait();
      if (waited !== undefined) return waited;
      if (record.browser !== null) {
        const level = await levelNow();
        if (level === 0) return await finish("stopped", "the dial's browser level went to 0 while the task ran, so its browser was ended");
        if (level < (record.browser.operate ?? record.operate)) {
          deps.say(`task ${record.id}: the dial lowered the browser to ${level}; its container restarts at ${level}`);
          if (deps.browserDown !== undefined) await deps.browserDown(record);
          browserUp = false;
          await save({ ...record, browser: null });
          const failed = await bringUp(level as 1 | 2);
          if (failed !== undefined) return failed;
        }
      }

      const kind = record.plan === null ? "plan" : "step";
      const n = kind === "plan" ? 0 : record.steps.filter((entry) => entry.kind === "step").length + 1;
      const prompt = kind === "plan" ? planPrompt(record) : stepPrompt(record);
      const step: TaskStep = {
        n,
        kind,
        startedAt: at(),
        finishedAt: null,
        turnId: null,
        backend: null,
        exit: null,
        outcome: null,
        summary: "",
        done: false,
        tokens: null,
        ms: null,
        waitedMs: 0,
      };
      // The notes were said in this prompt; they are not said twice.
      await save({ ...record, steps: [...record.steps, step], notes: [], status: kind === "plan" ? "planning" : "running", statusAt: at() });
      deps.say(`task ${record.id}: ${kind === "plan" ? "planning" : `step ${n}`}…`);

      const watched = { waitedMs: 0, notes: [] as string[], stop: false, ended: null as string | null };
      let turnDone = false;
      const began = deps.now().getTime();
      const limitMs = activeLimitMs(record);
      const watching = (async () => {
        if (deps.watch === undefined && deps.endTurn === undefined) return;
        while (!turnDone) {
          await new Promise((resolve) => setTimeout(resolve, deps.pollMs ?? 500));
          if (turnDone) break;
          if (deps.watch !== undefined) {
            const seen = await deps.watch(record, record.steps.at(-1)!, false);
            watched.waitedMs = seen.waitedMs;
            watched.notes.push(...seen.notes);
            watched.stop = watched.stop || seen.stop;
            const status: TaskStatus = seen.waiting ? "waiting" : kind === "plan" ? "planning" : "running";
            if (status !== record.status) await save(setStatus(status));
          }
          if (deps.endTurn === undefined || watched.ended !== null || record.current === null) continue;
          // The step's own limit counts active time only: every hold is taken off, however many there were.
          const active = deps.now().getTime() - began - watched.waitedMs;
          const lowered = record.browser !== null && (await levelNow()) < (record.browser.operate ?? record.operate);
          if (active > limitMs || lowered) {
            watched.ended = lowered ? "the dial lowered the browser during the step" : "the step ran past its own time";
            await deps.endTurn(record.current);
          }
        }
      })();
      let ran: StepTurn;
      try {
        ran = await deps.turn(record, prompt, n, (process_) => save({ ...record, current: process_ }));
      } finally {
        turnDone = true;
        await watching;
      }
      if (deps.watch !== undefined) {
        // The step is over: what it left waiting is expired, and released as a no (review finding 5).
        const last = await deps.watch(record, record.steps.at(-1)!, true);
        watched.waitedMs = last.waitedMs;
        watched.notes.push(...last.notes);
        watched.stop = watched.stop || last.stop;
      }

      const answered = ran.text.trim() !== "";
      const stopped = deps.stopping() || (await stopRequested(taskDir)) || (await deps.brake()) || watched.stop;
      const unanswered = ran.code !== 0 && !answered;
      // Ended from outside before its turn answered: what the step did is not known. One that answered is recorded,
      // and the runner leaves at the top of the loop.
      if (leaving() && !stopped && unanswered) return await leave(ran);
      const read = kind === "plan" ? readPlan(ran.text) : readStep(ran.text);
      // S18.2: a turn with no answer while the backend is not ready is the backend's, not the step's.
      const down = unanswered && !stopped && !NOTHING_SENT.has(ran.code) && deps.backendReady !== undefined ? await deps.backendReady(record) : undefined;
      const noBackend = down !== undefined && !down.ready ? down.reason : undefined;
      const sent = !NOTHING_SENT.has(ran.code) && noBackend === undefined;
      const outcome: TaskStep["outcome"] =
        unanswered ? (stopped ? "stopped" : noBackend !== undefined ? "no-backend" : "failed") : read.ok ? "ok" : "unreadable";
      const summary =
        outcome === "no-backend"
          ? `no answer — its backend was not ready (${noBackend}); this step counts against nothing`
          : outcome === "failed" || outcome === "stopped"
          ? `${outcome === "stopped" ? "stopped" : "the turn failed"} (exit ${ran.code})${ran.error === "" ? "" : `: ${ran.error}`}`
          : kind === "plan"
            ? read.ok && "plan" in read ? `planned ${read.plan.length} step(s)` : "the plan could not be read; working towards the goal directly"
            : "summary" in read ? read.summary : "";
      const finished: TaskStep = {
        ...record.steps.at(-1)!,
        finishedAt: at(),
        turnId: ran.turnId,
        backend: ran.backend,
        exit: ran.code,
        outcome,
        summary,
        done: kind === "step" && read.ok && "done" in read && read.done,
        tokens: ran.tokens,
        ms: ran.ms,
        waitedMs: watched.waitedMs,
      };
      await save({
        ...record,
        steps: [...record.steps.slice(0, -1), finished],
        current: null,
        notes: [...record.notes, ...watched.notes],
        // A plan turn that got no answer leaves no plan, so the next turn plans again.
        plan: kind === "plan" && outcome !== "failed" && outcome !== "stopped" && outcome !== "no-backend" ? (read.ok && "plan" in read ? read.plan : []) : record.plan,
        used: {
          turns: record.used.turns + (sent ? 1 : 0),
          activeMs: record.used.activeMs + (noBackend === undefined ? Math.max(0, ran.ms - watched.waitedMs) : 0),
          tokens: record.used.tokens + (ran.tokens ?? 0),
          tokensUnknown: record.used.tokensUnknown + (sent && ran.tokens === null ? 1 : 0),
        },
      });
      deps.say(`task ${record.id}: ${kind === "plan" ? "plan" : `step ${n}`} — ${outcome}: ${summary}`);

      if (stopped && (outcome === "stopped" || outcome === "failed" || watched.stop)) {
        return await finish("stopped", watched.stop ? "the owner said no and asked it to stop" : (await deps.brake()) ? "the brake is on (`mind stop`)" : "it was asked to stop");
      }
      if (ran.code === 4 && !answered) return await finish("failed", `the turn was refused before anything was sent: ${ran.error}`);
      if (ran.code === 2) return await finish("failed", `the turn could not be started: ${ran.error}`);
      // The runner waits for the backend at the top of the loop; nothing about this step counts.
      if (outcome === "no-backend") continue;
      if (outcome === "failed") {
        failedInARow += 1;
        if (failedInARow >= MAX_FAILED_IN_A_ROW) return await finish("failed", `${failedInARow} steps in a row got no answer: ${ran.error}`);
        continue;
      }
      failedInARow = 0;
      if (outcome === "unreadable") {
        unreadableInARow += 1;
        if (unreadableInARow >= MAX_UNREADABLE_IN_A_ROW) {
          return await finish("failed", `${unreadableInARow} answers in a row ended without a readable ${TASK_BLOCK} block`);
        }
        continue;
      }
      unreadableInARow = 0;
      if (finished.done) {
        const result = kind === "step" && read.ok && "result" in read ? read.result : null;
        await save({ ...record, result: result ?? finished.summary });
        return await finish("done", "the goal was reached");
      }
    }
  } catch (cause) {
    if (cause instanceof TaskGone) return { ok: false, reason: cause.message, code: 1 };
    // Something of the runner's own failed: the task says so rather than looking as if it still ran.
    try {
      return await finish("failed", `the runner failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } catch {
      throw cause;
    }
  } finally {
    if (browserUp && deps.browserDown !== undefined) await deps.browserDown(record).catch(() => undefined);
  }

  /**
   * S18.1: ended from outside with no stop asked. The step that ran (`ran`, its turn already ended) is closed as
   * interrupted — a turn spent, as a crash's is — and the record is left with no runner, which every reader shows as
   * `interrupted`: `task resume` carries it on.
   */
  async function leave(ran: StepTurn | undefined): Promise<RunOutcome> {
    if (browserUp && deps.browserDown !== undefined) {
      await deps.browserDown(record).catch(() => undefined);
      browserUp = false;
    }
    const open = openStep(record);
    const steps =
      open === undefined
        ? record.steps
        : [
            ...record.steps.slice(0, -1),
            { ...open, finishedAt: at(), outcome: "interrupted" as const, turnId: ran?.turnId ?? null, backend: ran?.backend ?? null, exit: ran?.code ?? null, tokens: ran?.tokens ?? null, ms: ran?.ms ?? null, summary: "interrupted — its runner was ended from outside (its unit stopped) during this step, so what it did is not known" },
          ];
    await save({
      ...record,
      steps,
      used: open === undefined ? record.used : { ...record.used, turns: record.used.turns + 1, tokens: record.used.tokens + (ran?.tokens ?? 0) },
      notes: open === undefined ? record.notes : [...record.notes, `Step ${open.n} was interrupted before it reported. Check what state things are in before repeating anything it may have done.`],
      // Back to the status a runner works in: with no runner behind it, it is shown as interrupted.
      status: record.status === "waiting-backend" || record.status === "waiting" ? (record.plan === null ? "planning" : "running") : record.status,
      runner: null,
      current: null,
      browser: null,
    });
    deps.say(`task ${record.id}: its runner was ended from outside; left as it was — \`mind task resume\` carries it on`);
    return { ok: false, reason: `task ${record.id} was left for \`task resume\`: its runner was ended from outside`, code: LEFT_EXIT_CODE };
  }

  async function finish(status: TaskStatus, reason: string): Promise<RunOutcome> {
    if (browserUp && deps.browserDown !== undefined) {
      await deps.browserDown(record).catch(() => undefined);
      browserUp = false;
    }
    await save({ ...setStatus(status, reason), runner: null, current: null, browser: null });
    deps.say(`task ${record.id}: ${status} — ${reason}`);
    return { ok: true, record };
  }
}
