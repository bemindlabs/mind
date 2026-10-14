/**
 * S18.1 — the runner's own unit: the `systemd-run` argv, the environment file, and the fallback without systemd.
 * No systemd is run here (a fake `run` answers); the real round trip is `test/e2e/always-on.e2e.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ENV_FILE_PREFIX,
  NO_SYSTEMD_ENV,
  UNIT_STOP_SECONDS,
  carriedEnv,
  LEFT_EXIT_CODE,
  RUNNER_EXIT_CODES,
  STALE_ENV_FILE_MS,
  endTaskUnit,
  envFileText,
  runShort,
  sweepStaleEnvFiles,
  writeEnvFile,
  envFileValue,
  startRunner,
  systemdRunArgv,
  taskUnitActive,
  taskUnitName,
  userManager,
  type RunCommand,
} from "../../src/task/unit.ts";
import { cleanup, tempHome } from "./fixture.ts";

const scratch: string[] = [];
afterEach(() => cleanup(scratch));

const SECRET = "sk-test-not-a-real-key-0123456789";

/** A fake `run`: answers each command by its first words, and keeps what it was asked. */
function fakeRun(answers: Record<string, { code: number; stdout?: string; stderr?: string } | (() => never)>) {
  const asked: string[][] = [];
  const seenFiles: { path: string; text: string; mode: number }[] = [];
  const run: RunCommand = async (argv) => {
    asked.push([...argv]);
    const file = argv.find((a) => a.startsWith("--property=EnvironmentFile="))?.slice("--property=EnvironmentFile=".length);
    if (file !== undefined) seenFiles.push({ path: file, text: await readFile(file, "utf8"), mode: (await stat(file)).mode & 0o777 });
    const key = Object.keys(answers).find((k) => argv.join(" ").startsWith(k));
    const answer = key === undefined ? { code: 1 } : answers[key]!;
    if (typeof answer === "function") answer();
    const a = answer as { code: number; stdout?: string; stderr?: string };
    return { code: a.code, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
  return { run, asked, seenFiles };
}

describe("the runner's unit (S18.1)", () => {
  test("the systemd-run argv: its own unit, collected, mixed kill with time to stop, no restart, no values on it", () => {
    const argv = systemdRunArgv("t-0000abcd", "/work", "/data/tasks/t-0000abcd/runner-env-x", ["bun", "run", "/om/bin/mind.ts", "task", "run", "t-0000abcd", "/agents/a", "--subject", "s", "--detached"]);
    expect(argv.slice(0, 4)).toEqual(["systemd-run", "--user", "--unit", "mind-task-t-0000abcd"]);
    expect(argv).toContain("--collect");
    expect(argv).toContain("--property=KillMode=mixed");
    expect(argv).toContain(`--property=TimeoutStopSec=${UNIT_STOP_SECONDS}`);
    expect(argv).toContain("--property=Restart=no");
    // The runner's own exit codes (stopped 4, parked 6, left for resume 75, …) are outcomes, not a failed unit.
    expect(argv).toContain(`--property=SuccessExitStatus=${RUNNER_EXIT_CODES}`);
    expect(RUNNER_EXIT_CODES.split(" ").map(Number)).toContain(LEFT_EXIT_CODE);
    expect(RUNNER_EXIT_CODES.split(" ").map(Number)).toContain(4);
    expect(argv).toContain("--property=Type=exec");
    expect(argv).toContain("--property=EnvironmentFile=/data/tasks/t-0000abcd/runner-env-x");
    expect(argv).toContain("--working-directory=/work");
    // The runner's argv follows `--` untouched; nothing is passed as --setenv / -E.
    expect(argv.slice(argv.indexOf("--") + 1)).toEqual(["bun", "run", "/om/bin/mind.ts", "task", "run", "t-0000abcd", "/agents/a", "--subject", "s", "--detached"]);
    expect(argv.some((a) => a.startsWith("--setenv") || a === "-E" || a.startsWith("--property=Environment="))).toBe(false);
    expect(() => taskUnitName("../etc")).toThrow("not a task id");
  });

  test("a user manager: asked once with systemctl; degraded counts; off by MIND_NO_SYSTEMD, off a non-Linux, or when nothing answers", async () => {
    expect(await userManager({}, fakeRun({ "systemctl --user is-system-running": { code: 0, stdout: "running\n" } }).run, "linux")).toEqual({ ok: true });
    expect(await userManager({}, fakeRun({ "systemctl --user is-system-running": { code: 1, stdout: "degraded\n" } }).run, "linux")).toEqual({ ok: true });
    const off = fakeRun({});
    expect(await userManager({ [NO_SYSTEMD_ENV]: "1" }, off.run, "linux")).toEqual({ ok: false, reason: "MIND_NO_SYSTEMD=1" });
    expect(off.asked).toEqual([]);
    expect(await userManager({}, off.run, "darwin")).toEqual({ ok: false, reason: "no systemd on darwin" });
    const none = await userManager({}, fakeRun({ "systemctl --user is-system-running": { code: 1, stdout: "offline\n", stderr: "Failed to connect to bus" } }).run, "linux");
    expect(none).toEqual({ ok: false, reason: "no user systemd manager answered (offline)" });
    const quiet = await userManager({}, fakeRun({ "systemctl --user is-system-running": { code: 1, stderr: "Failed to connect to bus: No medium found" } }).run, "linux");
    expect(quiet.ok).toBe(false);
    if (!quiet.ok) expect(quiet.reason).toContain("Failed to connect to bus");
    const thrown = await userManager({}, fakeRun({ "systemctl": () => { throw new Error("ENOENT: systemctl"); } }).run, "linux");
    expect(thrown).toEqual({ ok: false, reason: "systemctl could not be run (ENOENT: systemctl)" });
  });

  test("the environment file: every value double-quoted with \\ \" $ ` escaped; names systemd cannot carry and the starter's own unit variables left out", () => {
    expect(envFileValue(`a'b"c\\d$HOME \`x\` \n\t end `)).toBe(`"a'b\\"c\\\\d\\$HOME \\\`x\\\` \n\t end "`);
    const carried = carriedEnv({ HOME: "/h", A_KEY: SECRET, "BASH_FUNC_x%%": "() { :; }", INVOCATION_ID: "abc", JOURNAL_STREAM: "1:2", NOTIFY_SOCKET: "/run/x", UNSET: undefined, NUL: "a\0b" });
    expect(carried).toEqual({ HOME: "/h", A_KEY: SECRET });
    expect(envFileText({ HOME: "/h", Q: 'say "hi"' })).toBe(`HOME="/h"\nQ="say \\"hi\\""\n`);
  });

  test("started in a unit: the env file holds the environment (600) only while systemd-run runs, and is gone after; the key is never in argv", async () => {
    const box = await tempHome(scratch);
    const taskDir = join(box.tasks, "t-0000abcd");
    await mkdir(taskDir, { recursive: true });
    const fake = fakeRun({
      "systemctl --user is-system-running": { code: 0, stdout: "running" },
      "systemd-run": { code: 0 },
      "systemctl --user show --property=MainPID": { code: 0, stdout: "31337\n" },
    });
    let plain = 0;
    // umask 0: a mode the code asked for wrongly would show, where the usual umask would hide it by taking bits away.
    const umask = process.umask(0);
    let started;
    try {
      started = await startRunner({
      id: "t-0000abcd",
      taskDir,
      cwd: "/work",
      runner: ["bun", "run", "mind.ts", "task", "run", "t-0000abcd", "/a", "--subject", "s", "--detached"],
      env: { HOME: box.home, PATH: "/usr/bin", ANTHROPIC_API_KEY: SECRET, INVOCATION_ID: "web-unit" },
      run: fake.run,
      plain: () => ++plain,
      platform: "linux",
      });
    } finally {
      process.umask(umask);
    }
    expect(started).toEqual({ how: "unit", unit: "mind-task-t-0000abcd", pid: 31337 });
    expect(plain).toBe(0);
    expect(fake.seenFiles).toHaveLength(1);
    const file = fake.seenFiles[0]!;
    expect(file.mode).toBe(0o600);
    expect(file.path.startsWith(join(taskDir, ENV_FILE_PREFIX))).toBe(true);
    expect(file.text).toContain(`ANTHROPIC_API_KEY="${SECRET}"`);
    expect(file.text).not.toContain("INVOCATION_ID");
    expect(fake.asked.flat().join(" ")).not.toContain(SECRET);
    expect((await readdir(taskDir)).filter((n) => n.startsWith(ENV_FILE_PREFIX))).toEqual([]);
  });

  test("no manager: the plain background process, and why; systemd-run failing: the same, and its env file removed", async () => {
    const box = await tempHome(scratch);
    const taskDir = join(box.tasks, "t-0000abcd");
    await mkdir(taskDir, { recursive: true });
    const base = { id: "t-0000abcd", taskDir, cwd: "/work", runner: ["x"], plain: () => 4242, platform: "linux" };
    const off = await startRunner({ ...base, env: { [NO_SYSTEMD_ENV]: "1" }, run: fakeRun({}).run });
    expect(off).toEqual({ how: "process", pid: 4242, why: "MIND_NO_SYSTEMD=1" });
    const failing = fakeRun({
      "systemctl --user is-system-running": { code: 0, stdout: "running" },
      "systemd-run": { code: 1, stderr: "Failed to start transient service unit: Unit mind-task-t-0000abcd.service was already loaded" },
    });
    const failed = await startRunner({ ...base, env: { ANTHROPIC_API_KEY: SECRET }, run: failing.run });
    expect(failed).toEqual({ how: "process", pid: 4242, why: "systemd-run failed (Failed to start transient service unit: Unit mind-task-t-0000abcd.service was already loaded)" });
    expect(failing.seenFiles).toHaveLength(1);
    expect((await readdir(taskDir)).filter((n) => n.startsWith(ENV_FILE_PREFIX))).toEqual([]);
    const thrown = await startRunner({ ...base, env: {}, run: fakeRun({ "systemctl --user is-system-running": { code: 0, stdout: "running" }, "systemd-run": () => { throw new Error("spawn failed"); } }).run });
    expect(thrown).toEqual({ how: "process", pid: 4242, why: "systemd-run failed (spawn failed)" });
    // A unit whose main pid cannot be read is still a unit.
    const noPid = await startRunner({ ...base, env: {}, run: fakeRun({ "systemctl --user is-system-running": { code: 0, stdout: "running" }, "systemd-run": { code: 0 } }).run });
    expect(noPid).toEqual({ how: "unit", unit: "mind-task-t-0000abcd", pid: null });
  });

  test("a task's unit is named for the task", () => {
    expect(taskUnitName("t-0000abcd")).toBe("mind-task-t-0000abcd");
    expect(() => taskUnitName("not-a-task")).toThrow("not a task id");
  });

  test("ending a unit: queued with --no-block; none when there is no manager or no such unit; is-active read", async () => {
    const fake = fakeRun({ "systemctl --user is-system-running": { code: 0, stdout: "running" }, "systemctl --user stop": { code: 0 } });
    expect(await endTaskUnit("t-0000abcd", fake.run, {})).toBe("asked");
    expect(fake.asked.slice(-1)).toEqual([["systemctl", "--user", "stop", "--no-block", "mind-task-t-0000abcd.service"]]);
    expect(await endTaskUnit("t-0000abcd", fakeRun({ "systemctl --user is-system-running": { code: 0, stdout: "running" }, "systemctl --user stop": { code: 5 } }).run, {})).toBe("none");
    const off = fakeRun({});
    expect(await endTaskUnit("t-0000abcd", off.run, { [NO_SYSTEMD_ENV]: "1" })).toBe("none");
    expect(off.asked).toEqual([]);
    expect(await taskUnitActive("t-0000abcd", fakeRun({ "systemctl --user is-active": { code: 0, stdout: "active\n" } }).run)).toBe(true);
    expect(await taskUnitActive("t-0000abcd", fakeRun({ "systemctl --user is-active": { code: 3, stdout: "inactive\n" } }).run)).toBe(false);
    expect(await taskUnitActive("t-0000abcd", fakeRun({ "systemctl": () => { throw new Error("x"); } }).run)).toBe(false);
  });
});

describe("S18.1 review fixes", () => {
  test("a start while the unit is alive: 'already', nothing spawned, no fallback", async () => {
    const box = await tempHome(scratch);
    const taskDir = join(box.tasks, "t-0000abcd");
    await mkdir(taskDir, { recursive: true });
    const fake = fakeRun({
      "systemctl --user is-system-running": { code: 0, stdout: "running" },
      "systemd-run": { code: 1, stderr: "Failed to start transient service unit: Unit mind-task-t-0000abcd.service was already loaded or has a fragment file." },
      "systemctl --user is-active": { code: 0, stdout: "active\n" },
    });
    let plain = 0;
    const out = await startRunner({ id: "t-0000abcd", taskDir, cwd: "/w", runner: ["x"], env: {}, run: fake.run, plain: () => ++plain, platform: "linux" });
    expect(out).toEqual({ how: "already", unit: "mind-task-t-0000abcd" });
    expect(plain).toBe(0);
    expect((await readdir(taskDir)).filter((n) => n.startsWith(ENV_FILE_PREFIX))).toEqual([]);
  });

  test("the env file is exactly 600 even under a umask that would let a wrong mode through", async () => {
    const box = await tempHome(scratch);
    await mkdir(box.tasks, { recursive: true });
    const umask = process.umask(0);
    try {
      const path = await writeEnvFile(box.tasks, { A: "1" });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(umask);
    }
  });

  test("stale env files (over a minute) are swept on the next start; fresh ones and other files are left", async () => {
    const box = await tempHome(scratch);
    const taskDir = join(box.tasks, "t-0000abcd");
    await mkdir(taskDir, { recursive: true });
    const old = join(taskDir, `${ENV_FILE_PREFIX}${"a".repeat(32)}`);
    const young = join(taskDir, `${ENV_FILE_PREFIX}${"b".repeat(32)}`);
    const other = join(taskDir, "task.json");
    for (const path of [old, young, other]) await writeFile(path, "x", { mode: 0o600 });
    const past = new Date(Date.now() - STALE_ENV_FILE_MS - 5000);
    await utimes(old, past, past);
    expect(await sweepStaleEnvFiles(taskDir)).toBe(1);
    expect((await readdir(taskDir)).sort()).toEqual([`${ENV_FILE_PREFIX}${"b".repeat(32)}`, "task.json"]);
    expect(await sweepStaleEnvFiles(join(taskDir, "nowhere"))).toBe(0);
    // And startRunner does it: an old file is gone after a start.
    await writeFile(old, "x", { mode: 0o600 });
    await utimes(old, past, past);
    await startRunner({ id: "t-0000abcd", taskDir, cwd: "/w", runner: ["x"], env: {}, run: fakeRun({ "systemctl --user is-system-running": { code: 0, stdout: "running" }, "systemd-run": { code: 0 } }).run, plain: () => 1, platform: "linux" });
    expect(await readdir(taskDir)).not.toContain(`${ENV_FILE_PREFIX}${"a".repeat(32)}`);
  });

  test("a short command has a deadline: one that hangs is ended and answers 124, one that returns is untouched", async () => {
    const hung = await runShort(["sleep", "30"], 150, 100);
    expect(hung.code).toBe(124);
    expect(hung.stderr).toContain("did not answer");
    const fine = await runShort(["echo", "hi"], 5000);
    expect(fine).toEqual({ code: 0, stdout: "hi\n", stderr: "" });
  });
});
