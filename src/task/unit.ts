/**
 * S18.1 (D-164, AO-1) — a detached task runner in a systemd unit of its own.
 *
 * ## Why
 *
 * `task new|resume --detach` used to start the runner as a detached child of whoever ran it. Started from the web
 * page, that is a child of `mind web` — and under a service manager a detached child is still in its parent's
 * cgroup. The web's service unit has `KillMode=mixed`, so every restart of the web (an upgrade, a crash, a key
 * change) SIGKILLed every task the page had started, mid-step. Now, whenever a user systemd manager answers, the
 * runner is a transient unit of its own, `mind-task-<id>.service`, started with `systemd-run --user`, and the
 * web can restart under it.
 *
 * | property | why |
 * |---|---|
 * | `--collect` | the unit is gone when the runner ends, also when it failed — the next `resume` can use the name |
 * | `KillMode=mixed` | a stop sends SIGTERM to the runner alone, which ends its step's turn the way `mind stop` does (D-044) and writes the record; whatever is left after {@link UNIT_STOP_SECONDS} is SIGKILLed |
 * | `TimeoutStopSec` | room for that: D-044's ~4 s per turn, the browser's `docker kill`, one write |
 * | `Restart=no` | a runner is never restarted by systemd; resuming is a decision (the tick's, AO-1/AO-2 — later) |
 * | `SuccessExitStatus` | the runner's own exit codes (failed, budget, stopped, parked, left for resume) are outcomes of the task: the unit is not shown as failed for them |
 * | `Type=exec` | `systemd-run` returns only once the runner was really started, so a failure is seen here |
 *
 * ## The environment, and why not `--setenv`
 *
 * A unit gets its manager's environment, not its starter's, so the runner's environment has to be carried. What it
 * needs is the starter's whole environment — what a detached child inherited before: `HOME`, the XDG roots, `PATH`
 * (the vendor CLIs), the `MIND_*` settings, and whatever key a backend reads from it (`ANTHROPIC_API_KEY`, …).
 * That last kind is secret, and `systemd-run --setenv` writes every value into the unit's properties, which
 * `systemctl --user show` prints to anyone who asks. So no value goes through `--setenv` or argv: the environment
 * is written to `runner-env-<random>` in the task's own directory (personal, 700) with mode 600, and handed to the
 * unit as `EnvironmentFile=` — the unit's properties hold its path, never its values. systemd reads it when it
 * starts the runner; with `Type=exec`, `systemd-run` returns only after that, and the file is removed then, whatever
 * happened ({@link startRunner}). Measured 2026-10-06 against systemd's own parser: every value is written double-
 * quoted with `\`, `"`, `$` and `` ` `` escaped, and comes back byte for byte — quotes, `$HOME`, newlines, tabs,
 * trailing spaces. A name systemd cannot carry (`BASH_FUNC_x%%`) is left out.
 *
 * The runner itself does not need to know: its environment is what its starter's was.
 *
 * A leftover `runner-env-*` older than a minute (the starter died between writing and removing it) is swept on the
 * next start ({@link sweepStaleEnvFiles}).
 *
 * ## Lingering
 *
 * A user manager exists while its user is logged in. For a task to outlive the login, and to start after a reboot
 * with nobody logged in, the owner enables lingering once: `loginctl enable-linger <user>`. Without it the unit
 * ends with the last session — which is today's behaviour for a detached child too, only now it is a clean
 * SIGTERM that leaves the task for `task resume`.
 *
 * ## Without systemd
 *
 * No user manager (a container, macOS, `MIND_NO_SYSTEMD=1`, a `systemd-run` that fails): today's detached child,
 * and one line on stderr saying it will end with whatever started it.
 */

import { readMind } from "../env.ts";
import { chmod, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STATE_FILE_MODE } from "../state.ts";
import { spawnGuarded } from "../spawn.ts";
import { isTaskId } from "./store.ts";

export const TASK_UNIT_PREFIX = "mind-task-";
/** Set to `1` and no unit is ever made: the runner is a detached child, as before S18.1. */
export const NO_SYSTEMD_ENV = "MIND_NO_SYSTEMD";
export const ENV_FILE_PREFIX = "runner-env-";
/** An env file older than this is a leftover of a start that never finished (the starter died between write and rm). */
export const STALE_ENV_FILE_MS = 60_000;
/** A runner left a task for `task resume` (SIGTERM with no stop asked): not 4, which is `stopped`. */
export const LEFT_EXIT_CODE = 75;
/** Every exit code a runner gives on purpose is an outcome of the task, not a failure of the unit. */
export const RUNNER_EXIT_CODES = "1 3 4 5 6 75";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** How long a stopped unit's runner has to end its step and write the record before SIGKILL. */
export const UNIT_STOP_SECONDS = 60;

/**
 * Variables that describe the starter's own place under systemd, not the runner's: carried over, they would make
 * the runner log into the web's journal stream or answer the web's watchdog.
 */
const NOT_CARRIED = new Set([
  "INVOCATION_ID",
  "JOURNAL_STREAM",
  "SYSTEMD_EXEC_PID",
  "MANAGERPID",
  "NOTIFY_SOCKET",
  "WATCHDOG_PID",
  "WATCHDOG_USEC",
  "LISTEN_PID",
  "LISTEN_FDS",
  "LISTEN_FDNAMES",
  "MAINPID",
  "TRIGGER_UNIT",
  "TRIGGER_TIMER_REALTIME_USEC",
  "TRIGGER_TIMER_MONOTONIC_USEC",
]);

/** Runs one short command to its end: the seam the tests replace. */
export type RunCommand = (argv: readonly string[]) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;

export function taskUnitName(id: string): string {
  if (!isTaskId(id)) throw new Error(`not a task id: ${JSON.stringify(id)}`);
  return `${TASK_UNIT_PREFIX}${id}`;
}

/** The whole `systemd-run` command for a task's runner: `runner` is its argv, `envFile` its environment. */
export function systemdRunArgv(id: string, cwd: string, envFile: string, runner: readonly string[]): string[] {
  return [
    "systemd-run",
    "--user",
    "--unit",
    taskUnitName(id),
    `--description=Mind task ${id}`,
    "--collect",
    "--quiet",
    "--property=Type=exec",
    "--property=KillMode=mixed",
    `--property=TimeoutStopSec=${UNIT_STOP_SECONDS}`,
    "--property=Restart=no",
    `--property=SuccessExitStatus=${RUNNER_EXIT_CODES}`,
    `--property=EnvironmentFile=${envFile}`,
    `--working-directory=${cwd}`,
    "--",
    ...runner,
  ];
}

/** Is there a user systemd manager to start a unit under? Said why not, when not. */
export async function userManager(
  env: Readonly<Record<string, string | undefined>>,
  run: RunCommand,
  platform: string = process.platform,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  if (readMind(NO_SYSTEMD_ENV, env) === "1") return { ok: false, reason: `${NO_SYSTEMD_ENV}=1` };
  if (platform !== "linux") return { ok: false, reason: `no systemd on ${platform}` };
  let out: Awaited<ReturnType<RunCommand>>;
  try {
    out = await run(["systemctl", "--user", "is-system-running"]);
  } catch (cause) {
    return { ok: false, reason: `systemctl could not be run (${cause instanceof Error ? cause.message : String(cause)})` };
  }
  // `degraded` (a unit somewhere failed) exits non-zero and is still a manager that starts units.
  const state = out.stdout.trim();
  if (["running", "degraded", "starting", "initializing"].includes(state)) return { ok: true };
  return { ok: false, reason: `no user systemd manager answered (${state || out.stderr.trim().split("\n").at(-1) || `exit ${out.code}`})` };
}

/** The starter's environment as the runner is to have it: strings with names systemd can carry, not {@link NOT_CARRIED}. */
export function carriedEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const carried: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && ENV_NAME.test(name) && !NOT_CARRIED.has(name) && !value.includes("\0")) carried[name] = value;
  }
  return carried;
}

/** One value as systemd's `EnvironmentFile=` reads it back unchanged: double-quoted, `\ " $ \`` escaped. */
export function envFileValue(value: string): string {
  return `"${value.replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;
}

/** The text of an `EnvironmentFile=` for this environment. */
export function envFileText(env: Readonly<Record<string, string | undefined>>): string {
  return Object.entries(carriedEnv(env)).map(([name, value]) => `${name}=${envFileValue(value)}\n`).join("");
}

/** Write the environment for a runner into its task's directory (600, never over an existing file). */
export async function writeEnvFile(taskDir: string, env: Readonly<Record<string, string | undefined>>): Promise<string> {
  const path = join(taskDir, `${ENV_FILE_PREFIX}${crypto.randomUUID().replace(/-/g, "")}`);
  await writeFile(path, envFileText(env), { mode: STATE_FILE_MODE, flag: "wx" });
  // Explicit: the mode above is `mode & ~umask`, which can only take bits away — this makes the file exactly 600.
  await chmod(path, STATE_FILE_MODE);
  return path;
}

/** Remove env files in a task's directory older than {@link STALE_ENV_FILE_MS}. Returns how many. */
export async function sweepStaleEnvFiles(taskDir: string, now: number = Date.now()): Promise<number> {
  let removed = 0;
  for (const name of await readdir(taskDir).catch(() => [] as string[])) {
    if (!name.startsWith(ENV_FILE_PREFIX)) continue;
    const path = join(taskDir, name);
    const info = await stat(path).catch(() => undefined);
    if (info !== undefined && now - info.mtimeMs > STALE_ENV_FILE_MS) {
      await rm(path, { force: true });
      removed += 1;
    }
  }
  return removed;
}

export type Started =
  | { readonly how: "unit"; readonly unit: string; readonly pid: number | null }
  | { readonly how: "process"; readonly pid: number; readonly why: string }
  /** The task's unit is alive already: nothing was started, nothing spawned instead. */
  | { readonly how: "already"; readonly unit: string };

/**
 * Start a task's runner: a unit of its own when a user manager answers, else `plain()` — the detached child of
 * before. `runner` is the runner's argv; `env` is what it is to run with.
 */
export async function startRunner(options: {
  readonly id: string;
  readonly taskDir: string;
  readonly cwd: string;
  readonly runner: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly run: RunCommand;
  readonly plain: () => number;
  readonly platform?: string;
}): Promise<Started> {
  const manager = await userManager(options.env, options.run, options.platform);
  if (!manager.ok) return { how: "process", pid: options.plain(), why: manager.reason };
  await sweepStaleEnvFiles(options.taskDir);
  const file = await writeEnvFile(options.taskDir, options.env);
  const unit = taskUnitName(options.id);
  let out: Awaited<ReturnType<RunCommand>>;
  try {
    out = await options.run(systemdRunArgv(options.id, options.cwd, file, options.runner));
  } catch (cause) {
    out = { code: -1, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    // Read by systemd as it started the runner (`Type=exec`), or never to be: either way, not kept.
    await rm(file, { force: true });
  }
  if (out.code !== 0) {
    // A second start while the first runner's unit is alive: systemd-run refuses the name. That is "already
    // running" — not a reason to start a second runner outside systemd.
    if (await taskUnitActive(options.id, options.run)) return { how: "already", unit };
    const said = out.stderr.trim().split("\n").at(-1) ?? "";
    return { how: "process", pid: options.plain(), why: `systemd-run failed (${said || `exit ${out.code}`})` };
  }
  const shown = await options.run(["systemctl", "--user", "show", "--property=MainPID", "--value", `${unit}.service`]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  const pid = Number(shown.stdout.trim());
  return { how: "unit", unit, pid: shown.code === 0 && Number.isInteger(pid) && pid > 0 ? pid : null };
}

/**
 * Ask systemd to stop a task's unit, if it has one. `--no-block`: the stop is queued and this returns — run from
 * inside a turn of that very task, a blocking stop would wait on its own end. A unit that is not there is not an
 * error: the runner ended, or there never was one.
 */
export async function endTaskUnit(id: string, run: RunCommand, env: Readonly<Record<string, string | undefined>>): Promise<"asked" | "none"> {
  if ((await userManager(env, run)).ok === false) return "none";
  const out = await run(["systemctl", "--user", "stop", "--no-block", `${taskUnitName(id)}.service`]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  return out.code === 0 ? "asked" : "none";
}

/** Is a task's unit loaded and not inactive? For `task show` and the tests. */
export async function taskUnitActive(id: string, run: RunCommand): Promise<boolean> {
  const out = await run(["systemctl", "--user", "is-active", `${taskUnitName(id)}.service`]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  return ["active", "activating", "deactivating", "reloading"].includes(out.stdout.trim());
}

/** How long `systemctl` / `systemd-run` may take: a hung user bus must not hold a stop or the brake. */
export const SHORT_COMMAND_MS = 10_000;

/**
 * Run one short command with a deadline ({@link SHORT_COMMAND_MS}): at it the command gets SIGTERM, and SIGKILL
 * half a second later. A timeout is exit code 124 with the reason on stderr — to every caller here that is "no
 * answer", which every one of them treats as "no unit".
 */
export const runShort = async (argv: readonly string[], ms: number = SHORT_COMMAND_MS, graceMs = 500): ReturnType<RunCommand> => {
  const child = spawnGuarded(argv);
  let timedOut = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    grace = setTimeout(() => child.kill("SIGKILL"), graceMs);
  }, ms);
  try {
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return timedOut
      ? { code: 124, stdout, stderr: `${argv[0]} did not answer within ${Math.round(ms / 1000)} s` }
      : { code: child.exitCode ?? -1, stdout, stderr: stderr.trim() };
  } finally {
    clearTimeout(timer);
    if (grace !== undefined) clearTimeout(grace);
  }
};
