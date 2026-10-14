/**
 * `mind task` — a goal carried over several ordinary turns (D-154). The store, the loop, the budget, the stop
 * and the views are `src/task/`, on the coverage floor; what is here is parsing, printing and wiring the real
 * world into the runner (the turn child, the brake, the browser).
 */

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { isatty } from "node:tty";
import type { KeyObject } from "node:crypto";
import { parseAllowlist } from "../../src/browser/allowlist.ts";
import { MAX_TTL_SECONDS, browserDown, browserOutDir, browserUp } from "../../src/browser/runtime.ts";
import { isStopped } from "../../src/decide/stop.ts";
import { reasonsIn } from "../../src/decide/sensitive-lang.ts";
import { chosenLanguage } from "../../src/lang.ts";
import { engineCommand } from "../../src/guard/hooks.ts";
import { isKnownBackend, loadSoul } from "../../src/soul/index.ts";
import { isLocalCliId } from "../../src/exec/local-cli.ts";
import {
  DEFAULT_APPROVAL_SECONDS,
  DEFAULT_BUDGET,
  DEFAULT_STEP_SECONDS,
  LOG_FILE,
  MAX_APPROVAL_SECONDS,
  MAX_MINUTES,
  MAX_TURNS,
  NOT_ALLOWED_YET,
  VALUE_NOT_SHOWN,
  TASK_SCHEMA,
  approvalsOf,
  browserTaskProblem,
  agentAncestor,
  runnerTaint,
  answerCode,
  answerHeld,
  notDumpable,
  endStepTurn,
  describeHeld,
  watchApprovals,
  createTask,
  listLine,
  listTasks,
  newTaskId,
  readTask,
  runTask,
  showLines,
  shownStatus,
  spawnStepTurn,
  stopTask,
  summarise,
  taskDirIn,
  tasksDir,
  thisProcess,
  wholeNumber,
  backendReadiness,
  endTaskUnit,
  resumable,
  startRunner,
  runShort,
  termHandler,
  stopRequested,
  MAX_BACKEND_WAIT_MINUTES,
  type Started,
  type TaskRecord,
} from "../../src/task/index.ts";
import { spawnGuarded } from "../../src/spawn.ts";
import { subjectId, type SubjectId } from "../../src/types.ts";
import { decideDial, dialEnv } from "../dial.ts";
import { parseArgs, report, usageError } from "../shared.ts";

const USAGE =
  "usage: mind task new <dir> --subject <id> --goal <text> [--backend a,b] [--model <m>] [--budget-turns <n>] [--budget-minutes <n>] " +
  "[--budget-tokens <n>] [--operate 0|1|2] [--allow <origin>…] [--step-minutes <n>] [--approve-within <minutes>] [--backend-wait-minutes <n>] [--detach] [--json]\n" +
  "       mind task list <dir> --subject <id> [--json]\n" +
  "       mind task show <task> <dir> --subject <id> [--json]\n" +
  "       mind task stop <task> <dir> --subject <id> [--json]\n" +
  "       mind task resume <task> <dir> --subject <id> [--detach] [--json]\n" +
  "       mind task run <task> <dir> --subject <id> [--detached]\n" +
  "       mind task approve <task> <approval> <dir> --subject <id> [--json]\n" +
  "       mind task deny <task> <approval> <dir> --subject <id> [--stop] [--json]";

/** One flag list per subcommand, so the help and the tree agree on who takes --json (test/cli/json-stdout.test.ts). */
const NEW_BOOLEANS: readonly string[] = ["json", "detach"];
const LIST_BOOLEANS: readonly string[] = ["json"];
const SHOW_BOOLEANS: readonly string[] = ["json"];
const STOP_BOOLEANS: readonly string[] = ["json"];
const RUN_BOOLEANS: readonly string[] = ["json", "detach", "detached"];
const APPROVE_BOOLEANS: readonly string[] = ["json"];
const DENY_BOOLEANS: readonly string[] = ["json", "stop"];

/** Exit codes: 0 done · 1 failed · 3 out of budget · 4 stopped · 5 already running or already ended · 6 parked · 75 left for resume. */
const EXIT: Readonly<Record<string, number>> = { done: 0, failed: 1, budget: 3, stopped: 4, parked: 6 };

function allValues(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === `--${name}` && argv[index + 1] !== undefined && !argv[index + 1]!.startsWith("--")) values.push(argv[++index]!);
    else if (token.startsWith(`--${name}=`)) values.push(token.slice(name.length + 3));
  }
  return values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter((value) => value !== "");
}

interface Place {
  readonly dir: string;
  readonly subject: SubjectId;
  readonly tasks: string;
}

async function place(dir: string | undefined, rawSubject: string | undefined): Promise<{ ok: true; place: Place } | { ok: false; code: number }> {
  if (dir === undefined || rawSubject === undefined || rawSubject === "") return { ok: false, code: usageError(USAGE) };
  let subject: SubjectId;
  try {
    subject = subjectId(rawSubject);
  } catch (error) {
    return { ok: false, code: usageError(error instanceof Error ? error.message : String(error)) };
  }
  const tasks = await tasksDir(dialEnv(), subject);
  if (!tasks.ok) {
    console.error(`mind task: ${tasks.reason}`);
    return { ok: false, code: 1 };
  }
  return { ok: true, place: { dir: resolve(dir), subject, tasks: tasks.path } };
}

/** The runner, wired to this machine: the turn child, the brake, the browser. Output to `say`. */
async function carry(record: TaskRecord, where: Place, say: (line: string) => void): Promise<number> {
  const env = dialEnv();
  const taskDir = taskDirIn(where.tasks, record.id);
  const told = new Set<string>();
  // D-156 (reviews of PR #24): the private release key of the task's current container — in this process's
  // memory only; the runner makes itself not dumpable before it starts such a container (`harden`).
  let releaseKey: KeyObject | null = null;
  // Round 4: this runner's own memory of every loosened turn it sees, so a turn that deletes or flips its run
  // record cannot make a claim it wrote look clean (src/task/taint-watch.ts).
  const { tainted, stop: stopWatching } = await runnerTaint(env, record.operate === 2);
  // S18.1: SIGTERM is how systemd stops this runner's unit (`task stop`, `mind stop`, a reboot). The step's turn
  // is ended the way `mind stop` ends any turn; then, with a stop asked, the task closes as stopped — with none
  // (the user's manager going down), it is left for `task resume`. Either way the record is written before exit.
  const term = termHandler({
    stopAsked: async () => (await stopRequested(taskDir)) || (await isStopped(env)),
    endTurn: async () => {
      const now = await readTask(where.tasks, where.subject, record.id);
      if (now.ok && now.record.current !== null) await endStepTurn(env, now.record.current, {});
    },
    exit: (code) => process.exit(code),
  });
  process.on("SIGTERM", term.onTerm);
  const outcome = await runTask(record, {
    tasks: where.tasks,
    now: () => new Date(),
    say,
    brake: () => isStopped(env),
    turn: (current, prompt, n, started) => spawnStepTurn(engineCommand().argv, taskDir, current, prompt, n, started, process.env),
    harden: () => notDumpable(),
    dialOperate: async () => (await decideDial(where.dir, env, where.subject)).effective.operate,
    browserUp: async (current, level) => {
      const up = await browserUp({
        env,
        subject: where.subject,
        allow: current.allow,
        operate: level,
        task: current.id,
        owner: process.pid,
        // D-156: at operate 2 a held action waits this long for the owner's answer; at 1 nothing is ever held.
        approvalWaitSeconds: level === 2 ? current.approvalSeconds : 0,
        ttlSeconds: Math.min(MAX_TTL_SECONDS, Math.max(60, current.budget.minutes * 120 + current.approvalSeconds + 300)),
      });
      if (!up.ok) return { ok: false, reason: up.reason };
      releaseKey = up.releaseKey ?? null;
      return { ok: true, task: up.record.task, port: up.record.port };
    },
    browserDown: async (current) => {
      if (current.browser !== null) await browserDown(env, current.browser.task);
    },
    // D-156: while a step runs, what the container holds is filed and shown, and an answer is released by this
    // runner, which alone holds the key; when the step ends, what it left waiting is released as a no.
    ...(record.operate === 2
      ? {
          watch: async (current: TaskRecord, step: { readonly n: number }, ended: boolean) =>
            releaseKey === null
              ? { waiting: false, waitedMs: 0, notes: [], stop: false }
              : watchApprovals({ taskDir, outDir: browserOutDir(env, where.subject, current.id), task: current.id, step: step.n, now: new Date(), told, key: releaseKey, ended, tainted }),
        }
      : {}),
    endTurn: async (process_) => {
      await endStepTurn(env, process_, {});
    },
    self: thisProcess(),
    stopping: term.stopping,
    leaving: term.leaving,
    backendReady: backendReadiness(process.env),
  }).finally(() => {
    process.off("SIGTERM", term.onTerm);
    term.dispose();
    stopWatching();
  });
  if (!outcome.ok) {
    say(`mind task: ${outcome.reason}`);
    return outcome.code;
  }
  return EXIT[outcome.record.status] ?? 1;
}

/**
 * Start `task run` for this task so that it outlives this process — and, S18.1, whatever started this one: a unit
 * of its own when a user systemd manager answers (`src/task/unit.ts`), else a detached child as before, said once.
 */
async function detach(record: TaskRecord, where: Place): Promise<Started> {
  const runner = [...engineCommand().argv, "task", "run", record.id, where.dir, "--subject", where.subject, "--detached"];
  const started = await startRunner({
    id: record.id,
    taskDir: taskDirIn(where.tasks, record.id),
    cwd: record.cwd,
    runner,
    env: process.env,
    run: runShort,
    plain: () => {
      const child = spawnGuarded(runner, { cwd: record.cwd, detached: true });
      child.unref();
      return child.pid;
    },
  });
  if (started.how === "process") {
    console.error(`mind task: no unit of its own (${started.why}) — the runner is a background process of whatever started it, and ends if that is stopped`);
  }
  return started;
}

const where_ = (started: Started): string =>
  started.how === "unit" ? `unit ${started.unit}${started.pid === null ? "" : `, pid ${started.pid}`}` : started.how === "already" ? `unit ${started.unit}` : `pid ${started.pid}`;

/** Said when the task's unit was alive already: nothing was started, and the exit code is 5 like any "already running". */
function alreadyRunning(id: string, started: Extract<Started, { how: "already" }>): number {
  console.error(`mind task: ${id} is running already (unit ${started.unit}) — nothing was started.`);
  return 5;
}

/**
 * Review of PR #24, round 2: a task is started by a person, not from inside a turn — a turn that started a
 * runner would be that runner's ancestor. Refused, with nothing written.
 */
async function underTurn(where: Place): Promise<number | undefined> {
  const above = await agentAncestor(dialEnv(), where.tasks, where.subject);
  if (above === undefined) return undefined;
  console.error(`mind task: nothing was started — this command runs under ${above}. A task is started by a person (a terminal, the web page or the app), not from inside a turn.`);
  return 4;
}

async function cmdNew(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, NEW_BOOLEANS);
  const goal = (options.get("goal") ?? "").trim();
  if (positional.length !== 1 || goal === "") return usageError(USAGE);
  if (goal.length > 4000) return usageError("--goal is at most 4000 characters");
  const got = await place(positional[0], options.get("subject"));
  if (!got.ok) return got.code;
  const where = got.place;
  const nested = await underTurn(where);
  if (nested !== undefined) return nested;
  const loaded = await loadSoul(where.dir, where.subject);
  if (!loaded.ok) return report(loaded.issues);

  const turns = wholeNumber(options.get("budget-turns"), "--budget-turns", 1, MAX_TURNS);
  const minutes = wholeNumber(options.get("budget-minutes"), "--budget-minutes", 1, MAX_MINUTES);
  const tokens = wholeNumber(options.get("budget-tokens"), "--budget-tokens", 1, 1_000_000_000);
  const step = wholeNumber(options.get("step-minutes"), "--step-minutes", 1, 120);
  const approve = wholeNumber(options.get("approve-within"), "--approve-within", 1, MAX_APPROVAL_SECONDS / 60);
  const backendWait = wholeNumber(options.get("backend-wait-minutes"), "--backend-wait-minutes", 1, MAX_BACKEND_WAIT_MINUTES);
  for (const parsed of [turns, minutes, tokens, step, approve, backendWait]) if (!parsed.ok) return usageError(parsed.reason);
  const operateRaw = options.get("operate") ?? "0";
  if (!["0", "1", "2"].includes(operateRaw)) return usageError("--operate is 0 (no browser), 1 (look) or 2 (act on --allow)");
  const operate = Number(operateRaw) as 0 | 1 | 2;
  const backend = options.get("backend") ?? null;
  const chain = (backend ?? "").split(",").map((b) => b.trim()).filter((b) => b !== "");
  for (const name of chain) if (!isKnownBackend(name) && !isLocalCliId(name)) return usageError(`unknown backend ${JSON.stringify(name)}`);
  const allowed = allValues(argv, "allow");
  if (operate === 0 && allowed.length > 0) return usageError("--allow is for a task with a browser: give --operate 1 or 2 with it");
  const allow = allowed.length === 0 ? { ok: true as const, origins: [] } : parseAllowlist(allowed);
  if (!allow.ok) return usageError(allow.errors.join("; "));

  const verdict = await decideDial(where.dir, dialEnv(), where.subject);
  if (verdict.effective.stopped) {
    console.error("mind task: nothing was started — the brake is on (`mind stop`); `mind autonomy resume` releases it.");
    return 4;
  }
  if (operate >= 1) {
    if (allow.origins.length === 0) return usageError("a task with a browser (--operate 1 or 2) needs --allow <origin> for every site it may reach");
    const problem = browserTaskProblem(chain, verdict.effective.operate);
    if (problem !== undefined) {
      console.error(`mind task: nothing was started — ${problem}`);
      return 4;
    }
    if (verdict.effective.operate < operate) {
      console.error(`mind task: the dial's browser level is ${verdict.effective.operate}, below this task's ${operate}: every step gets ${verdict.effective.operate}.`);
    }
  }

  const now = new Date().toISOString();
  const record: TaskRecord = {
    schema: TASK_SCHEMA,
    id: newTaskId(),
    subject: where.subject,
    dir: where.dir,
    cwd: process.cwd(),
    goal,
    createdAt: now,
    via: options.get("via") === "web" ? "web" : "cli",
    backend: chain.length === 0 ? null : chain.join(","),
    model: options.get("model") ?? null,
    operate,
    allow: allow.origins.map((origin) => origin.text),
    budget: { turns: turns.ok ? (turns.value ?? DEFAULT_BUDGET.turns) : 0, minutes: minutes.ok ? (minutes.value ?? DEFAULT_BUDGET.minutes) : 0, tokens: tokens.ok ? (tokens.value ?? null) : null },
    stepSeconds: step.ok && step.value !== undefined ? step.value * 60 : DEFAULT_STEP_SECONDS,
    approvalSeconds: approve.ok && approve.value !== undefined ? approve.value * 60 : DEFAULT_APPROVAL_SECONDS,
    status: "planning",
    statusAt: now,
    reason: null,
    plan: null,
    steps: [],
    result: null,
    used: { turns: 0, activeMs: 0, tokens: 0, tokensUnknown: 0 },
    runner: null,
    current: null,
    browser: null,
    notes: [],
    generation: 0,
    ...(backendWait.ok && backendWait.value !== undefined ? { backendWaitMinutes: backendWait.value } : {}),
  };
  await createTask(where.tasks, record);

  if (options.has("detach")) {
    const started = await detach(record, where);
    if (started.how === "already") return alreadyRunning(record.id, started);
    if (options.has("json")) {
      console.log(JSON.stringify({ ok: true, id: record.id, detached: true, pid: "pid" in started ? started.pid : null, unit: started.how === "unit" ? started.unit : null }));
    } else {
      console.log(record.id);
      console.error(`mind task: ${record.id} is running in the background (${where_(started)}) — \`mind task show ${record.id} ${where.dir} --subject ${where.subject}\``);
    }
    return 0;
  }
  console.error(`mind task: ${record.id} — ${goal}`);
  const code = await carry(record, where, (line) => console.error(line));
  return printFinal(where, record.id, options.has("json"), code);
}

async function printFinal(where: Place, id: string, json: boolean, code: number): Promise<number> {
  const read = await readTask(where.tasks, where.subject, id);
  if (!read.ok) return code;
  const summary = summarise(read.record);
  if (json) console.log(JSON.stringify(summary));
  else if (summary.result !== null) console.log(summary.result);
  return code;
}

async function cmdRun(argv: readonly string[], resuming: boolean): Promise<number> {
  const { positional, options } = parseArgs(argv, RUN_BOOLEANS);
  if (positional.length !== 2) return usageError(USAGE);
  const got = await place(positional[1], options.get("subject"));
  if (!got.ok) return got.code;
  const where = got.place;
  const nested = await underTurn(where);
  if (nested !== undefined) return nested;
  const read = await readTask(where.tasks, where.subject, positional[0]!);
  if (!read.ok) return usageError(read.reason);
  if (resuming && !resumable(shownStatus(read.record))) {
    console.error(`mind task: ${read.record.id} is ${shownStatus(read.record)}, not interrupted or parked — nothing to resume.`);
    return 5;
  }
  if (resuming && options.has("detach")) {
    const started = await detach(read.record, where);
    if (started.how === "already") return alreadyRunning(read.record.id, started);
    console.log(read.record.id);
    console.error(`mind task: ${read.record.id} resumes in the background (${where_(started)})`);
    return 0;
  }
  // A detached runner has no one reading its output: every line goes to the task's own log (600).
  const log = `${taskDirIn(where.tasks, read.record.id)}/${LOG_FILE}`;
  const say = options.has("detached")
    ? (line: string) => appendFileSync(log, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
    : (line: string) => console.error(line);
  const code = await carry(read.record, where, say);
  return options.has("detached") ? code : printFinal(where, read.record.id, options.has("json"), code);
}

async function cmdList(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, LIST_BOOLEANS);
  if (positional.length !== 1) return usageError(USAGE);
  const got = await place(positional[0], options.get("subject"));
  if (!got.ok) return got.code;
  const { records, unreadable } = await listTasks(got.place.tasks, got.place.subject);
  const summaries = records.map((record) => summarise(record));
  if (options.has("json")) {
    console.log(JSON.stringify({ tasks: summaries, unreadable }));
    return 0;
  }
  for (const bad of unreadable) console.error(`mind task: ${bad}`);
  if (summaries.length === 0) console.log("no tasks");
  for (const summary of summaries) console.log(listLine(summary));
  return 0;
}

async function cmdShow(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, SHOW_BOOLEANS);
  if (positional.length !== 2) return usageError(USAGE);
  const got = await place(positional[1], options.get("subject"));
  if (!got.ok) return got.code;
  const read = await readTask(got.place.tasks, got.place.subject, positional[0]!);
  if (!read.ok) {
    console.error(`mind task: ${read.reason}`);
    return read.missing ? 2 : 1;
  }
  const summary = summarise(read.record);
  const approvals = await approvalsOf(dialEnv(), got.place.tasks, read.record, new Date());
  // GL-01: a held action's reasons are English, and carry the Thai meaning only when Thai is chosen.
  const language = chosenLanguage(process.env);
  if (options.has("json")) console.log(JSON.stringify({ ...summary, approvals: approvals.map((a) => ({ ...a, reasons: reasonsIn(a.reasons, language) })) }));
  else {
    for (const line of showLines(summary)) console.log(line);
    if (approvals.length > 0) console.log("  sensitive actions (D-156):");
    for (const a of approvals) {
      console.log(`    ${a.id} — ${a.status === "refused" ? NOT_ALLOWED_YET : a.status}${a.status === "pending" ? ` until ${a.expiresAt}` : ""}: ${describeHeld(a)}`);
      if (a.follows !== null) console.log(`      it follows the yes to: ${describeHeld(a.follows)}`);
      if (a.carriesValue) console.log(`      ${VALUE_NOT_SHOWN}`);
      if (a.status === "pending") console.log(`      \`mind task approve ${summary.id} ${a.id} ${positional[1]} --subject ${got.place.subject}\` · or deny`);
    }
  }
  return 0;
}

async function cmdDecide(argv: readonly string[], verdict: "approve" | "deny"): Promise<number> {
  const { positional, options } = parseArgs(argv, verdict === "approve" ? APPROVE_BOOLEANS : DENY_BOOLEANS);
  if (positional.length !== 3) return usageError(USAGE);
  const got = await place(positional[2], options.get("subject"));
  if (!got.ok) return got.code;
  // Review of PR #24, finding 1: an answer is a person's, at a terminal (or on the web page, behind its key).
  // A script or an agent's shell has a pipe at one end — the same test D-032 uses for `origin`, on all three
  // streams. `script` can fake a terminal, so `answerHeld` also refuses from below a recorded turn or runner.
  if (!(isatty(0) && isatty(1) && isatty(2))) {
    console.error(
      "mind task: nothing was answered — an approval is answered by a person: at a terminal, or with " +
        "Yes / No on the web page. This command was not run at a terminal.",
    );
    return 4;
  }
  const answer = await answerHeld({
    env: dialEnv(),
    tasks: got.place.tasks,
    subject: got.place.subject,
    task: positional[0]!,
    approval: positional[1]!,
    verdict,
    by: "the owner, at a terminal",
    stop: options.has("stop"),
    now: new Date(),
    from: "terminal",
  });
  if (options.has("json")) {
    const language = chosenLanguage(process.env);
    console.log(JSON.stringify(answer.ok ? { ok: true, approval: { ...answer.approval, reasons: reasonsIn(answer.approval.reasons, language) } } : { ok: false, kind: answer.kind, reason: answer.reason }));
  }
  if (!answer.ok) {
    console.error(`mind task: ${answer.reason}`);
    return answerCode(answer).exit;
  }
  console.error(`mind task: ${verdict === "approve" ? "approved — it happens once, now" : "denied — it does not happen, and the task is told"}: ${describeHeld(answer.approval)}`);
  return 0;
}

async function cmdStop(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, STOP_BOOLEANS);
  if (positional.length !== 2) return usageError(USAGE);
  const got = await place(positional[1], options.get("subject"));
  if (!got.ok) return got.code;
  const stopped = await stopTask(dialEnv(), got.place.tasks, got.place.subject, positional[0]!, {
    now: () => new Date(),
    by: "mind task stop",
    endBrowser: async (task) => {
      await browserDown(dialEnv(), task);
    },
    endUnit: (task) => endTaskUnit(task, runShort, process.env),
  });
  if (!stopped.ok) {
    console.error(`mind task: ${stopped.reason}`);
    return 2;
  }
  const { result } = stopped;
  if (options.has("json")) console.log(JSON.stringify({ ok: true, id: result.id, outcome: result.outcome, status: result.status }));
  else {
    console.log(
      result.outcome === "already-final"
        ? `${result.id} had ended already (${result.status})`
        : result.outcome === "stopped"
          ? `${result.id} stopped${result.turn === null ? "" : " — its step's turn was ended"}`
          : `${result.id} was asked to stop; its runner has not closed it yet`,
    );
    for (const survivor of result.turn?.survivors ?? []) console.log(`  still alive: pid ${survivor.pid} — kill -KILL -${survivor.pgid}`);
  }
  return result.turn !== null && result.turn.survivors.length > 0 ? 1 : 0;
}

export async function cmdTask(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "new":
      return cmdNew(rest);
    case "list":
      return cmdList(rest);
    case "show":
      return cmdShow(rest);
    case "stop":
      return cmdStop(rest);
    case "run":
      return cmdRun(rest, false);
    case "resume":
      return cmdRun(rest, true);
    case "approve":
      return cmdDecide(rest, "approve");
    case "deny":
      return cmdDecide(rest, "deny");
    default:
      return usageError(USAGE);
  }
}
