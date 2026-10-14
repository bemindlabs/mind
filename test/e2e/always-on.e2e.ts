/**
 * E18 P0 (D-164) — tasks survive restarts, end to end: the real CLI, a real `mind web` under a real user
 * systemd manager, a real claude-local turn per step on the local model through LiteLLM inside the D-118 fence.
 *
 * Run with:
 *
 *     MIND_E2E_ALWAYS_ON=1 bun run e2e:always-on
 *
 * Named `.e2e.ts`, so `bun test` never discovers it. Without the variable every case is skipped. With it, it needs
 * a user systemd manager (`systemctl --user`), LiteLLM on :10400 with the key file of D-124
 * (`MIND_LITELLM_KEY_FILE`, default `~/.secrets/.env.mind-litellm`), and 127.0.0.1:30000 free (the throwaway
 * web's port). Optional: `MIND_E2E_REPORT=<path>` (every result as JSON).
 *
 * Everything is under a temporary HOME / XDG roots beside the checkout (`../.e2e-always-on-*`, or under
 * `MIND_E2E_ROOT`; removed after) — not inside it: `mind new` refuses an agent inside the engine repository
 * (D-021), and not in /tmp, which a unit started by the user's manager may see as another directory
 * (`PrivateTmp`). The agent is a synthetic one made by `mind new`. The web is a throwaway `mind web` in a transient unit of its own
 * (`mind-e2e-web-*`, `KillMode=mixed` as the live service has it) — never the live `mind-web-om`.
 *
 * S18.1
 * 1. **web restart** — a task started from the web page (`POST /api/tasks`) runs in `mind-task-<id>`, not in the
 *    web's cgroup; restarting the web mid-step leaves the runner alive, and the task finishes `done`. The runner
 *    has the starter's environment byte for byte (a value with quotes, `$`, a backtick and a backslash), and that
 *    value is in no property of the unit and in no file left in the task's directory.
 * 2. **the control** — the same with `MIND_NO_SYSTEMD=1` (today's behaviour, said once on stderr): the web's
 *    restart takes the runner with it and the task is `interrupted`.
 * 3. **mind stop** — a task mid-step: `mind stop` ends its turn's run record and its unit; the task is
 *    `stopped` and the unit is gone. (Run with no `docker` on its PATH.)
 * 6. **the unit stopped by hand** — `systemctl --user stop mind-task-<id>` mid-step, with no stop asked: the
 *    runner leaves the task for `task resume`: `interrupted`, its step closed as interrupted, the unit not failed.
 *
 * S18.2
 * 4. **the model sleeps mid-task** — after the first step starts, vLLM is reported asleep: the task goes to
 *    `waiting-backend`, starts no step and spends no turn while it lasts; reported awake, it carries on and ends
 *    `done` with no failed step. By default vLLM's sleep is *reported* by a stand-in `/is_sleeping` on loopback
 *    (`MIND_VLLM_URL`) that answers the real vLLM's state, or "asleep" while the test says so — the real vLLM
 *    keeps serving the turns. vLLM is shared by the whole machine, and media-gen and others put it to sleep and
 *    wake it themselves: a test that woke it in a `finally` could wake it under someone else's GPU job. With `MIND_E2E_REAL_VLLM_SLEEP=1` it is the
 *    real thing: only when vLLM is awake and media-gen is idle, asleep for at most 45 s, woken in a `finally`.
 * 5. **parked** — asleep from the start with `--backend-wait-minutes 1`: the task is `parked` after a minute with
 *    the reason, no step and no turn; resumed when awake, it finishes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { liteLLMKeyFile } from "../../src/exec/local-cli.ts";
import { envFileText, taskUnitName } from "../../src/task/unit.ts";
import { TOKEN_HEADER } from "../../src/web/token-header.ts";
import { BUN } from "../support/bare-path.ts";
import { waitFor } from "../support/wait.ts";

const ENABLED = process.env["MIND_E2E_ALWAYS_ON"] === "1";
const REAL_SLEEP = process.env["MIND_E2E_REAL_VLLM_SLEEP"] === "1";
const REPORT = process.env["MIND_E2E_REPORT"];
const KEY_FILE = liteLLMKeyFile(homedir(), process.env);
const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SUBJECT = "e2e-always-on";
const WEB_PORT = 30000;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const REAL_VLLM = "http://127.0.0.1:10410";
const MEDIA_GEN = "http://172.17.0.1:30310";
/** A value no shell, no quoting and no `$` expansion may change on its way to the runner. */
const PROBE = `e2e-${crypto.randomUUID().slice(0, 8)} it's "quoted" $HOME \`tick\` back\\slash`;

/** Three steps, so there is a step to restart under and a next step to wait before. */
const GOAL =
  "Work in exactly three steps and do not use any tools. Step 1: answer with the word ALPHA. Step 2: answer with the word BETA. " +
  "Step 3: answer with the word GAMMA and report the goal reached, with the result 'ALPHA BETA GAMMA'. Do not report the goal reached before step 3.";
const NEVER = "Count upwards by one in each step, starting at 1. Never report the goal as reached.";

interface Box {
  root: string;
  env: Record<string, string>;
  agent: string;
  work: string;
  key: string;
  keyFile: string;
  asleep: boolean;
  gets: string[];
  realAsleepSeen: number;
  fakeVllm?: ReturnType<typeof Bun.serve>;
  units: string[];
}
const box = {} as Box;
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), sleep: REAL_SLEEP ? "real" : "fake /is_sleeping" };

interface Step {
  n: number;
  kind: string;
  outcome: string | null;
  finishedAt: string | null;
  summary: string;
}
interface Record_ {
  id: string;
  status: string;
  reason: string | null;
  result: string | null;
  steps: Step[];
  used: { turns: number; activeMs: number };
  runner: { pid: number } | null;
  current: { pid: number } | null;
  generation: number;
}

async function sh(argv: readonly string[], env?: Record<string, string>, cwd?: string) {
  const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe", ...(env === undefined ? {} : { env }), ...(cwd === undefined ? {} : { cwd }) });
  const [stdout, stderr] = [await new Response(child.stdout).text(), await new Response(child.stderr).text()];
  await child.exited;
  return { code: child.exitCode ?? -1, stdout, stderr };
}

const cli = (args: readonly string[], extra: Record<string, string> = {}) => sh([BUN, "run", BIN, ...args], { ...box.env, ...extra }, box.work);
const tasksDir = () => join(box.root, "data", "mind", SUBJECT, "personal", "tasks");

async function record(id: string): Promise<Record_> {
  return JSON.parse(await readFile(join(tasksDir(), id, "task.json"), "utf8")) as Record_;
}

async function shown(id: string): Promise<{ status: string; reason: string | null; steps: Step[]; used: { turns: number } }> {
  const out = await cli(["task", "show", id, box.agent, "--subject", SUBJECT, "--json"]);
  return JSON.parse(out.stdout) as { status: string; reason: string | null; steps: Step[]; used: { turns: number } };
}

async function until<T>(what: () => Promise<T | undefined>, within: number, why: string): Promise<T> {
  let found: T | undefined;
  const held = await waitFor(async () => {
    found = await what().catch(() => undefined);
    return found !== undefined;
  }, { within, every: 500 });
  if (!held || found === undefined) throw new Error(`never happened: ${why}`);
  return found;
}

const FINAL = ["done", "failed", "stopped", "budget"];
const final = (id: string, within = 900_000) => until(async () => {
  const r = await shown(id);
  return FINAL.includes(r.status) || r.status === "interrupted" ? r : undefined;
}, within, `task ${id} ended`);
const midStep = (id: string, kind: "plan" | "step" = "step") => until(async () => {
  const r = await record(id);
  return r.current !== null && r.steps.at(-1)?.kind === kind && r.steps.at(-1)?.finishedAt === null ? r : undefined;
}, 600_000, `task ${id} mid-${kind}`);

/** A directory whose only program is `systemctl`: a PATH on which `docker` and the vendor CLIs do not exist. */
async function onlySystemctl(): Promise<string> {
  const dir = join(box.root, "only-systemctl");
  await mkdir(dir, { recursive: true });
  const found = (await sh(["which", "systemctl"])).stdout.trim();
  await rm(join(dir, "systemctl"), { force: true });
  await symlink(found, join(dir, "systemctl"));
  return dir;
}

async function unitActive(unit: string): Promise<boolean> {
  const out = await sh(["systemctl", "--user", "is-active", `${unit}.service`]);
  return ["active", "activating", "deactivating"].includes(out.stdout.trim());
}

async function mainPid(unit: string): Promise<number> {
  return Number((await sh(["systemctl", "--user", "show", "--property=MainPID", "--value", `${unit}.service`])).stdout.trim());
}

/** A throwaway `mind web` in a transient unit of its own, with the live service's KillMode. */
async function startWeb(extra: Record<string, string>): Promise<string> {
  const unit = `mind-e2e-web-${crypto.randomUUID().slice(0, 8)}`;
  const envFile = join(box.root, `${unit}.env`);
  await writeFile(envFile, envFileText({ ...box.env, ...extra }), { mode: 0o600 });
  const started = await sh([
    "systemd-run", "--user", "--unit", unit, "--collect", "--quiet",
    "--property=KillMode=mixed", "--property=TimeoutStopSec=30", `--property=EnvironmentFile=${envFile}`, `--working-directory=${box.work}`,
    "--", BUN, "run", BIN, "web", box.agent, "--subject", SUBJECT, "--port", String(WEB_PORT), "--key-file", box.keyFile,
  ]);
  expect(started.code, started.stderr).toBe(0);
  box.units.push(unit);
  await webUp();
  return unit;
}

async function webUp(): Promise<void> {
  await until(async () => ((await api("GET", "/api/tasks").catch(() => ({ status: 0 }))).status === 200 ? true : undefined), 60_000, "the web answered");
}

async function stopWeb(unit: string): Promise<void> {
  await sh(["systemctl", "--user", "stop", `${unit}.service`]);
  await until(async () => ((await unitActive(unit)) ? undefined : true), 60_000, `${unit} stopped`);
}

async function api(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${WEB}${path}`, {
    method,
    headers: { [TOKEN_HEADER]: box.key, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Real mode only: is it safe to put the shared vLLM to sleep for a moment? Said why not. */
async function safeToSleep(): Promise<string | undefined> {
  const sleeping = await fetch(`${REAL_VLLM}/is_sleeping`).then((r) => r.json() as Promise<{ is_sleeping?: boolean }>).catch(() => undefined);
  if (sleeping?.is_sleeping !== false) return `vLLM is ${sleeping === undefined ? "not answering" : "asleep already (someone else has the GPU)"}`;
  const media = await fetch(`${MEDIA_GEN}/health`).then((r) => r.json() as Promise<{ busy?: boolean }>).catch(() => undefined);
  if (media?.busy !== false) return `media-gen is ${media === undefined ? "not answering" : "mid-job"}`;
  const gpu = await sh(["nvidia-smi", "--query-compute-apps=process_name,used_memory", "--format=csv,noheader,nounits"]);
  const heavy = gpu.stdout.split("\n").filter((line) => !/vllm/i.test(line) && Number(line.split(",")[1]) > 4000);
  if (heavy.length > 0) return `another GPU job is running: ${heavy.join("; ")}`;
  return undefined;
}

const realVllm = (path: string, timeoutMs: number) => fetch(`${REAL_VLLM}${path}`, { method: "POST", signal: AbortSignal.timeout(timeoutMs) }).then((r) => r.status);

test.skipIf(ENABLED)("not run: set MIND_E2E_ALWAYS_ON=1 to run tasks under a real user systemd manager and the local model", () => {
  expect(ENABLED).toBe(false);
});

describe.skipIf(!ENABLED)("E18 P0 — tasks survive restarts, really", () => {
  beforeAll(async () => {
    expect((await sh(["ss", "-ltn", `sport = :${WEB_PORT}`])).stdout).not.toContain(`:${WEB_PORT}`);
    box.root = await mkdtemp(join(process.env["MIND_E2E_ROOT"] ?? join(ROOT, ".."), ".e2e-always-on-"));
    box.units = [];
    box.asleep = false;
    box.gets = [];
    box.realAsleepSeen = 0;
    box.fakeVllm = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      // The real vLLM's answer, or "asleep" while the test says so: others on this machine put it to sleep too
      // (media-gen and its users, several times an hour), and a task must wait through theirs as through the test's.
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (request.method !== "GET") return new Response("this fake only answers GET", { status: 405 });
        box.gets.push(path);
        if (path === "/is_sleeping") {
          const real = await fetch(`${REAL_VLLM}/is_sleeping`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json() as Promise<{ is_sleeping?: boolean }>).catch(() => undefined);
          if (real?.is_sleeping === true) box.realAsleepSeen += 1;
          return real === undefined ? new Response("vLLM did not answer", { status: 502 }) : Response.json({ is_sleeping: box.asleep || real.is_sleeping === true });
        }
        if (path === "/health") return new Response("");
        return new Response("not found", { status: 404 });
      },
    });
    box.env = {
      HOME: box.root,
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      XDG_STATE_HOME: join(box.root, "state"),
      XDG_DATA_HOME: join(box.root, "data"),
      XDG_RUNTIME_DIR: process.env["XDG_RUNTIME_DIR"] ?? `/run/user/${process.getuid?.() ?? 1000}`,
      ...(process.env["DBUS_SESSION_BUS_ADDRESS"] === undefined ? {} : { DBUS_SESSION_BUS_ADDRESS: process.env["DBUS_SESSION_BUS_ADDRESS"] }),
      MIND_LITELLM_KEY_FILE: KEY_FILE,
      MIND_QDRANT_URL: "http://127.0.0.1:9",
      MIND_CAPTURE: "off",
      MIND_NO_UPDATE_CHECK: "1",
      // Case 4 and 5's switch; the real vLLM in real mode.
      MIND_VLLM_URL: REAL_SLEEP ? REAL_VLLM : box.fakeVllm.url.origin,
    };
    box.work = join(box.root, "work");
    await mkdir(box.work, { recursive: true });
    const made = await cli(["new", "e2e-agent", "--subject", SUBJECT, "--dir", join(box.root, "agents")]);
    expect(made.code, made.stderr).toBe(0);
    box.agent = join(box.root, "agents", "e2e-agent");
    box.key = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    box.keyFile = join(box.root, "web.key");
    await writeFile(box.keyFile, `${box.key}\n`, { mode: 0o600 });
  }, 120_000);

  afterAll(async () => {
    box.asleep = false;
    for (const unit of box.units) await sh(["systemctl", "--user", "stop", `${unit}.service`]);
    // Any task unit of this run that is still there is stopped, never left running.
    for (const id of await readdir(tasksDir()).catch(() => [] as string[])) {
      if (/^t-[0-9a-f]{8}$/.test(id)) await sh(["systemctl", "--user", "stop", `${taskUnitName(id)}.service`]);
    }
    box.fakeVllm?.stop(true);
    // Every probe the runners made was a GET of /is_sleeping (the fake refuses anything else, and counts).
    report["probes"] = { gets: box.gets.length, paths: [...new Set(box.gets)], realVllmAsleepSeen: box.realAsleepSeen };
    report["endedAt"] = new Date().toISOString();
    if (REPORT !== undefined) await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`);
    if (box.root !== undefined && process.env["MIND_E2E_KEEP"] !== "1") await rm(box.root, { recursive: true, force: true });
  }, 120_000);

  test("1. web restart mid-step: the task's runner is in a unit of its own, survives, and the task finishes", async () => {
    const web = await startWeb({ MIND_E2E_PROBE: PROBE });
    const started = await api("POST", "/api/tasks", { goal: GOAL, backend: "claude-local", budgetTurns: 8 });
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    const id = started.json["id"] as string;
    expect(started.json["unit"]).toBe(taskUnitName(id));
    const unit = taskUnitName(id);
    const pid = await mainPid(unit);
    expect(pid).toBeGreaterThan(0);
    const cgroup = await readFile(`/proc/${pid}/cgroup`, "utf8");
    expect(cgroup).toContain(`${unit}.service`);
    expect(cgroup).not.toContain(web);

    // The runner's environment is the web's, the probe byte for byte; the unit's properties never hold it, and the
    // file that carried it is gone.
    const environ = (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0");
    expect(environ).toContain(`MIND_E2E_PROBE=${PROBE}`);
    expect(environ).toContain(`HOME=${box.root}`);
    expect((await sh(["systemctl", "--user", "show", `${unit}.service`])).stdout).not.toContain(PROBE.slice(0, 12));
    expect((await readdir(join(tasksDir(), id))).filter((name) => name.startsWith("runner-env-"))).toEqual([]);

    const mid = await midStep(id, "step");
    const webPidBefore = await mainPid(web);
    const restarted = await sh(["systemctl", "--user", "restart", `${web}.service`]);
    expect(restarted.code, restarted.stderr).toBe(0);
    await webUp();
    const webPidAfter = await mainPid(web);
    expect(webPidAfter).not.toBe(webPidBefore);
    // The runner is the same process, still running the same step.
    expect(await mainPid(unit)).toBe(pid);
    const during = await shown(id);
    expect(["running", "planning", "done"]).toContain(during.status);

    const ended = await final(id);
    const steps = ended.steps.map((s) => s.outcome);
    report["case1"] = { id, restartedDuringStep: mid.steps.at(-1)?.n, status: ended.status, reason: ended.reason, steps, turns: ended.used.turns };
    expect(ended.status).toBe("done");
    expect(steps).not.toContain("interrupted");
    expect((await record(id)).generation).toBe(1);
    await until(async () => ((await unitActive(unit)) ? undefined : true), 90_000, `${unit} ended with its runner`);
    await stopWeb(web);
  }, 1_200_000);

  test("2. the control: with no unit of its own (MIND_NO_SYSTEMD=1, said once), the web's restart ends the runner", async () => {
    const web = await startWeb({ MIND_NO_SYSTEMD: "1" });
    const started = await api("POST", "/api/tasks", { goal: NEVER, backend: "claude-local", budgetTurns: 6 });
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    const id = started.json["id"] as string;
    expect(started.json["unit"]).toBeNull();
    await midStep(id, "plan").catch(() => midStep(id, "step"));
    const pid = (await record(id)).runner!.pid;
    expect(await readFile(`/proc/${pid}/cgroup`, "utf8")).toContain(`${web}.service`);
    const restarted = await sh(["systemctl", "--user", "restart", `${web}.service`]);
    expect(restarted.code, restarted.stderr).toBe(0);
    await webUp();
    const after = await until(async () => {
      const r = await shown(id);
      return r.status === "interrupted" ? r : undefined;
    }, 60_000, `task ${id} interrupted by the web's restart`);
    report["case2"] = { id, status: after.status };
    expect(after.status).toBe("interrupted");
    // The CLI says the fallback once.
    const said = await cli(["task", "new", box.agent, "--subject", SUBJECT, "--goal", "x", "--backend", "claude-local", "--budget-turns", "1", "--detach"], { MIND_NO_SYSTEMD: "1" });
    expect(said.stderr.match(/no unit of its own \(MIND_NO_SYSTEMD=1\)/g)).toHaveLength(1);
    await cli(["task", "stop", said.stdout.trim(), box.agent, "--subject", SUBJECT]);
    await cli(["task", "stop", id, box.agent, "--subject", SUBJECT]);
    await stopWeb(web);
  }, 900_000);

  test("3. mind stop mid-step ends the turn's run record and the task's unit; the task is stopped", async () => {
    const started = await cli(["task", "new", box.agent, "--subject", SUBJECT, "--goal", NEVER, "--backend", "claude-local", "--budget-turns", "6", "--detach", "--json"]);
    expect(started.code, started.stderr).toBe(0);
    const { id, unit } = JSON.parse(started.stdout) as { id: string; unit: string };
    expect(unit).toBe(taskUnitName(id));
    await midStep(id, "plan").catch(() => midStep(id, "step"));
    // The step's turn has written its run record.
    await until(async () => ((await readdir(join(box.root, "state", "mind", "runs"), { recursive: true }).catch(() => [] as string[])).some((n) => n.endsWith(".json")) ? true : undefined), 120_000, "a run record");
    // `mind stop`'s step 4 sweeps browser containers: with no `docker` on this command's PATH it cannot touch any
    // (it is scoped to this test's state root anyway; this makes it impossible). Only `systemctl` is findable.
    const stopped = await cli(["stop"], { PATH: await onlySystemctl() });
    // Released for the next cases whatever happens below (what `autonomy resume` does after its typed phrase).
    const release = () => rm(join(box.root, "state", "mind", "STOP"), { force: true });
    try {
    // Only the end state is asserted: which of the brake, the stop file and the unit's SIGTERM the runner sees first
    // is a race, and every order ends in `stopped`.
    const ended = await until(async () => {
      const r = await shown(id);
      return FINAL.includes(r.status) ? r : undefined;
    }, 120_000, `task ${id} stopped`);
    await until(async () => ((await unitActive(unit)) ? undefined : true), 90_000, `${unit} gone`);
    const runs = (await readdir(join(box.root, "state", "mind", "runs"), { recursive: true }).catch(() => [] as string[])).filter((name) => name.endsWith(".json"));
    // Give a turn ended by the runner's own handler a moment to be gone.
    await waitFor(async () => (await Promise.all(runs.map((n) => readFile(join(box.root, "state", "mind", "runs", n), "utf8").then((t) => (JSON.parse(t) as { pid: number }).pid).then((pid) => readFile(`/proc/${pid}/stat`).then(() => 1, () => 0)).catch(() => 0)))).every((x) => x === 0), { within: 30_000, every: 500 });
    const left = await Promise.all(runs.map((name) => readFile(join(box.root, "state", "mind", "runs", name), "utf8").catch(() => "")));
    report["case3"] = { id, status: ended.status, reason: ended.reason, runRecordsLeft: left, stopStdout: stopped.stdout.split("\n").filter((l) => l.includes(id)) };
    expect(ended.status).toBe("stopped");
    // Every turn a record names is gone. (A record can outlive its turn when the turn was between writing it and
    // being signalled as step 3 read the records — the runner's own SIGTERM handler ends that turn; the record is
    // then stale, which every reader checks by pid and start time.)
    const pids = left.map((text) => (JSON.parse(text || "{}") as { pid?: number }).pid).filter((pid): pid is number => typeof pid === "number");
    for (const pid of pids) expect(await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "gone")).toBe("gone");
    } finally {
      await release();
    }
  }, 900_000);

  test("4. the local model sleeps mid-task: waiting-backend, no step and no turn while it lasts; awake, the task carries on with no failed step", async () => {
    if (REAL_SLEEP) {
      const unsafe = await safeToSleep();
      if (unsafe !== undefined) {
        report["case4"] = { skipped: `real sleep not safe: ${unsafe}` };
        throw new Error(`MIND_E2E_REAL_VLLM_SLEEP=1 but not safe now: ${unsafe} — run without it for the fake /is_sleeping`);
      }
    }
    const started = await cli(["task", "new", box.agent, "--subject", SUBJECT, "--goal", GOAL, "--backend", "claude-local", "--budget-turns", "8", "--detach", "--json"]);
    expect(started.code, started.stderr).toBe(0);
    const { id } = JSON.parse(started.stdout) as { id: string };
    await midStep(id, "step");
    let slept = false;
    let waiting: Awaited<ReturnType<typeof shown>> | undefined;
    let held: { turns: number; steps: number } | undefined;
    let asleepMs = 0;
    try {
      const began = Date.now();
      if (REAL_SLEEP) {
        // vLLM finishes what it is answering before it sleeps; the step in flight completes.
        expect(await realVllm("/sleep?level=1", 120_000)).toBe(200);
      } else box.asleep = true;
      slept = true;
      const asleepAt = Date.now();
      waiting = await until(async () => {
        const r = await shown(id);
        return r.status === "waiting-backend" || FINAL.includes(r.status) ? r : undefined;
      }, REAL_SLEEP ? 40_000 : 600_000, `task ${id} waiting for its backend`);
      expect(waiting.status).toBe("waiting-backend");
      held = { turns: waiting.used.turns, steps: waiting.steps.length };
      // While it waits nothing is spent.
      await waitFor(() => false, { within: REAL_SLEEP ? Math.max(1000, 40_000 - (Date.now() - asleepAt)) : 20_000, every: 1000 });
      const still = await shown(id);
      expect(still.status).toBe("waiting-backend");
      expect(still.used.turns).toBe(held.turns);
      expect(still.steps.length).toBe(held.steps);
      asleepMs = Date.now() - began;
    } finally {
      if (slept) {
        if (REAL_SLEEP) await realVllm("/wake_up", 60_000).catch(() => undefined);
        else box.asleep = false;
      }
    }
    const ended = await final(id);
    const outcomes = ended.steps.map((s) => s.outcome);
    report["case4"] = { id, sleep: REAL_SLEEP ? "real" : "fake", asleepMs, waitingReason: waiting?.reason, heldTurns: held?.turns, status: ended.status, steps: outcomes, turns: ended.used.turns };
    expect(waiting?.reason ?? "").toContain("is asleep");
    expect(ended.status).toBe("done");
    expect(outcomes).not.toContain("failed");
  }, 1_200_000);

  test("5. asleep past --backend-wait-minutes: parked with the reason, nothing spent; resumed awake, it finishes", async () => {
    box.asleep = true;
    let id = "";
    try {
      const started = await cli(["task", "new", box.agent, "--subject", SUBJECT, "--goal", GOAL, "--backend", "claude-local", "--budget-turns", "8", "--backend-wait-minutes", "1", "--detach", "--json"], REAL_SLEEP ? { MIND_VLLM_URL: box.fakeVllm!.url.origin } : {});
      expect(started.code, started.stderr).toBe(0);
      id = (JSON.parse(started.stdout) as { id: string }).id;
      const parked = await until(async () => {
        const r = await shown(id);
        return r.status === "parked" || FINAL.includes(r.status) ? r : undefined;
      }, 180_000, `task ${id} parked`);
      report["case5"] = { id, parked: parked.status, reason: parked.reason, steps: parked.steps.length, turns: parked.used.turns };
      expect(parked.status).toBe("parked");
      expect(parked.reason).toContain("its backend was not ready for 1 min");
      expect(parked.steps).toHaveLength(0);
      expect(parked.used.turns).toBe(0);
      await until(async () => ((await unitActive(taskUnitName(id))) ? undefined : true), 60_000, "the parked task's unit gone");
    } finally {
      box.asleep = false;
    }
    // Resumed awake. The task keeps its one-minute wait, and the real vLLM is put to sleep by others for longer than
    // that now and then (a video job): parked again for that reason is right, and resumed again.
    let ended: Awaited<ReturnType<typeof shown>> | undefined;
    let resumes = 0;
    for (; resumes < 8; resumes++) {
      const before = (await record(id)).generation;
      const resumed = await cli(["task", "resume", id, box.agent, "--subject", SUBJECT, "--detach"], REAL_SLEEP ? { MIND_VLLM_URL: box.fakeVllm!.url.origin } : {});
      expect(resumed.code, resumed.stderr).toBe(0);
      ended = await until(async () => {
        // Not the parked record this resume started from: the new runner's.
        if ((await record(id)).generation <= before) return undefined;
        const r = await shown(id);
        return FINAL.includes(r.status) || r.status === "parked" || r.status === "interrupted" ? r : undefined;
      }, 900_000, `task ${id} ended or parked again`);
      if (ended.status !== "parked") break;
      expect(ended.reason).toContain("is asleep");
    }
    (report["case5"] as Record<string, unknown>)["afterResume"] = { resumes: resumes + 1, status: ended!.status, steps: ended!.steps.map((s) => s.outcome), reason: ended!.reason };
    ended = ended!;
    expect(ended.status).toBe("done");
  }, 1_200_000);

  test("6. `systemctl --user stop mind-task-<id>` by hand, no stop asked: the task is left interrupted (not stopped), its step closed as interrupted", async () => {
    const started = await cli(["task", "new", box.agent, "--subject", SUBJECT, "--goal", NEVER, "--backend", "claude-local", "--budget-turns", "6", "--detach", "--json"]);
    expect(started.code, started.stderr).toBe(0);
    const { id, unit } = JSON.parse(started.stdout) as { id: string; unit: string };
    await midStep(id, "plan").catch(() => midStep(id, "step"));
    const began = Date.now();
    const stopped = await sh(["systemctl", "--user", "stop", `${unit}.service`]);
    expect(stopped.code, stopped.stderr).toBe(0);
    const after = await until(async () => {
      const r = await shown(id);
      return r.status === "interrupted" || FINAL.includes(r.status) ? r : undefined;
    }, 120_000, `task ${id} left for resume`);
    const rec = await record(id);
    const log = await readFile(join(tasksDir(), id, "runner.log"), "utf8");
    report["case6"] = { id, status: after.status, stopMs: Date.now() - began, runner: rec.runner, steps: rec.steps.map((st) => st.outcome), log: log.split("\n").filter((l) => l.includes("outside")).length };
    expect(after.status).toBe("interrupted");
    expect(rec.runner).toBeNull();
    expect(rec.steps.at(-1)?.outcome).toBe("interrupted");
    expect(log).toContain("ended from outside");
    expect(await unitActive(unit)).toBe(false);
    // Nothing was stopped: a resume carries it on, and `task stop` then ends it.
    expect((await cli(["task", "stop", id, box.agent, "--subject", SUBJECT])).code).toBe(0);
    expect((await shown(id)).status).toBe("stopped");
  }, 600_000);
});
