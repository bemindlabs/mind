/**
 * D-151 — one browser container per task: up, down, status, and the sweep that
 * keeps a dead turn from leaving one behind.
 *
 * ## What a task's container is
 *
 * `docker/browser/` (built here, never pushed): headless Chromium and the
 * pinned Playwright MCP server as the owner's uid with no capabilities, an
 * egress firewall that lets packets out only from the allowlist proxy, a fresh
 * in-memory profile, and the MCP port published on `127.0.0.1` only, reachable
 * from the bridge's gateway only, behind a per-task bearer token. Its one
 * host mount is the task's output directory, under the subject's `personal/`
 * so `mind erase` removes it with everything else personal (I-4).
 *
 * ## The record, and why it is written before `docker run`
 *
 * `<state root>/browser/<subject>/<task>.json` (mode 600, created exclusively)
 * names the container, its port and token, the allowlist, where the recording
 * goes and who owns it — the same reason a turn
 * writes its run record before the prompt goes (`src/decide/runs.ts`): a
 * process that dies between starting the container and writing the record
 * would leave a container nothing names. Every container also carries labels
 * (`dev.mind.browser.root` — a hash of the state root), so one nothing
 * names is still found by the sweep, and a sweep never touches another state
 * root's containers.
 *
 * ## No orphans
 *
 * Five things end a container, from the most to the least deliberate:
 *
 * 1. `mind browser down <task>` or {@link withBrowser}'s `finally`;
 * 2. `mind stop` — `docker kill` on every container of this state root;
 * 3. the sweep ({@link sweepBrowsers}), run by every `up` and `status` and by
 *    `stop`: a record past its deadline (`startedAt + ttl` and a minute's
 *    grace, whoever owns it), a record whose owner process is gone (pid and
 *    start time, as run records check them), a container with no record, a
 *    record with no container;
 * 4. the container's own deadline (`MIND_TTL`, default 30 minutes), kept by a
 *    root `timeout` the browser's uid cannot stop: if nothing on this machine
 *    ever runs Mind again, it still ends itself;
 * 5. `mind erase` of the subject (`endSubjectBrowsers`, `src/browser/store.ts`).
 *
 * `up` refuses while the brake is on (`mind stop`), as a turn does.
 *
 * Every container is started with `--rm`, so a killed one leaves nothing in
 * `docker ps -a`.
 */

import { generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { procStat } from "../decide/runs.ts";
import { isStopped, stopPath } from "../decide/stop.ts";
import { STATE_DIR_MODE } from "../state.ts";
import type { SubjectId } from "../types.ts";
import { parseAllowlist } from "./allowlist.ts";
import { browserOutDir, type BrowserEnv } from "./paths.ts";
import { BROWSER_PORT_FIRST, BROWSER_PORT_LAST } from "./ports.ts";
import {
  BROWSER_LABEL,
  BROWSER_SCHEMA,
  containerName,
  createRecord,
  dockerIo,
  killContainer,
  readBrowserRecords,
  removeRecord,
  rootLabel,
  updateRecord,
  type BrowserRecord,
  type DockerIo,
} from "./store.ts";

export * from "./paths.ts";
export * from "./store.ts";

/** The pinned Playwright MCP release the image is built with (`docker/browser/Dockerfile`). */
export const PLAYWRIGHT_MCP_VERSION = "0.0.83";
/**
 * sha256 over `docker/browser/` — each file's name and bytes, sorted by name.
 * Part of the tag, so an edited proxy or entrypoint is a different image and
 * `up` builds it instead of starting the old one. `test/browser/runtime.test.ts`
 * recomputes it: edit a file there and that test names the new value.
 */
export const BROWSER_CONTEXT_SHA256 = "d7368fdef3ef1abdae482ea90913abc255cce8e014e2a03019266f507527d398";
/** The local tag; never pushed. */
export const BROWSER_IMAGE = `mind-browser:${PLAYWRIGHT_MCP_VERSION}-${BROWSER_CONTEXT_SHA256.slice(0, 12)}`;
/** The port the guard in front of the MCP server listens on inside the container. */
export const CONTAINER_MCP_PORT = 8931;
export const DEFAULT_TTL_SECONDS = 30 * 60;
export const MAX_TTL_SECONDS = 4 * 60 * 60;
const MIN_TTL_SECONDS = 60;
/** How long a record may exist before its container does, and how long past its deadline one may run. */
export const START_GRACE_MS = 60_000;
const TASK_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Where Mind's own copy of the image's build context is, when this is a checkout. */
export const BROWSER_BUILD_DIR = fileURLToPath(new URL("../../docker/browser/", import.meta.url));

export function taskProblem(task: string): string | undefined {
  return TASK_PATTERN.test(task) ? undefined : `invalid task id ${JSON.stringify(task)}: expected ${TASK_PATTERN}`;
}

export function newTaskId(): string {
  return `t-${crypto.randomUUID().slice(0, 8)}`;
}

/** A task's bearer token: 32 random bytes, hex. */
export function newToken(): string {
  return randomBytes(32).toString("hex");
}

/** The `docker run` argv for a record — pure, so a test can read every flag. */
export function dockerRunArgs(
  record: BrowserRecord,
  ids: { readonly uid: number; readonly gid: number },
  root: string,
): string[] {
  return [
    "run",
    "--detach",
    "--rm",
    "--init",
    "--name",
    record.container,
    "--label",
    `${BROWSER_LABEL}=1`,
    "--label",
    `${BROWSER_LABEL}.task=${record.task}`,
    "--label",
    `${BROWSER_LABEL}.root=${root}`,
    // Loopback only, and inside the container from the bridge's gateway only
    // (entrypoint.sh) — other containers on the bridge cannot reach it — and
    // behind a bearer token (guard.mjs).
    "--publish",
    `127.0.0.1:${record.port}:${CONTAINER_MCP_PORT}`,
    // What the entrypoint needs before everything it starts drops to nothing:
    // the firewall (NET_ADMIN), the uid changes (SETUID, SETGID), the deadline
    // (KILL), and SETPCAP, without which a bounding set cannot be cut at all.
    "--cap-drop",
    "ALL",
    "--cap-add",
    "NET_ADMIN",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    "--cap-add",
    "KILL",
    "--cap-add",
    "SETPCAP",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=512m",
    "--tmpfs",
    "/run:rw,nosuid,nodev,size=8m",
    "--tmpfs",
    "/home/browser:rw,nosuid,nodev,size=256m",
    "--shm-size",
    "1g",
    "--memory",
    "2g",
    "--pids-limit",
    "1024",
    "--cpus",
    "2",
    // Lets an allowlist name this machine on purpose (`http://host.docker.internal:<port>`);
    // the proxy refuses a public name that resolves to a private address.
    "--add-host",
    "host.docker.internal:host-gateway",
    // The only host path the container sees.
    "--mount",
    `type=bind,source=${record.outDir},target=/out`,
    "--env",
    `MIND_ALLOW=${record.allowed.join(",")}`, // allowEnv's form: the origins parseAllowlist normalised
    "--env",
    `MIND_UID=${ids.uid}`,
    "--env",
    `MIND_GID=${ids.gid}`,
    "--env",
    `MIND_HOST_PORT=${record.port}`,
    "--env",
    `MIND_TTL=${record.ttlSeconds}`,
    // The name only: the value is in docker's own environment (DockerIo's `extra`), never in an argv.
    "--env",
    `MIND_OPERATE=${record.operate}`,
    "--env",
    "MIND_TOKEN",
    // D-156: a task that can ask — its wait, and (by name only, like the token) its release key.
    // D-156: a task that can ask — its wait. The release key is handed in after start (`handKey`), never here.
    ...(record.approvalWaitSeconds === undefined || record.approvalWaitSeconds === 0 ? [] : ["--env", `MIND_APPROVAL_WAIT=${record.approvalWaitSeconds}`]),
    // Its release *public* key — it can only verify (review of PR #24, round 3).
    ...(record.releasePublicKey === undefined ? [] : ["--env", `MIND_RELEASE_PUBKEY=${record.releasePublicKey}`]),
    record.image,
  ];
}

/** Is the record's owner still the process it was written about? */
export function ownerAlive(
  owner: BrowserRecord["owner"],
  stat: (pid: number) => { readonly startTicks: number } | null = procStat,
): boolean {
  if (owner === null) return true;
  const now = stat(owner.pid);
  if (now === null) return false;
  return owner.start === null || now.startTicks === owner.start;
}

/** Past `startedAt + ttl` and the grace: the container should have ended itself. */
export function pastDeadline(record: Pick<BrowserRecord, "startedAt" | "ttlSeconds">, now = Date.now()): boolean {
  const started = Date.parse(record.startedAt);
  return !Number.isFinite(started) || now > started + record.ttlSeconds * 1000 + START_GRACE_MS;
}

/** The names of this state root's containers that are running. */
async function liveContainers(
  env: BrowserEnv,
  io: DockerIo,
): Promise<{ readonly names: readonly string[]; readonly error?: string }> {
  const listed = await io.run(["ps", "--filter", `label=${BROWSER_LABEL}.root=${rootLabel(env)}`, "--format", "{{.Names}}"]);
  if (listed.code !== 0) return { names: [], error: listed.stderr || `docker ps exited ${listed.code}` };
  return { names: [...new Set(listed.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== ""))] };
}

/** One thing the sweep did, in words a person can act on. */
export interface SweepAction {
  readonly container: string;
  readonly task: string | null;
  readonly why: "past its deadline" | "owner gone" | "no record" | "container gone" | "stopped";
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * End what nothing owns any more, or what has outlived its deadline. With
 * `all`, end everything of this state root's — that is `mind stop`.
 */
export async function sweepBrowsers(
  env: BrowserEnv,
  options: {
    readonly io?: DockerIo;
    readonly all?: boolean;
    readonly stat?: (pid: number) => { readonly startTicks: number } | null;
    readonly now?: () => number;
  } = {},
): Promise<{ readonly actions: readonly SweepAction[]; readonly error?: string }> {
  const io = options.io ?? dockerIo();
  const now = (options.now ?? Date.now)();
  const live = await liveContainers(env, io);
  // Without a list of what runs, a record cannot be judged "gone": leave records alone.
  if (live.error !== undefined) return { actions: [], error: live.error };
  const { records } = await readBrowserRecords(env);
  const actions: SweepAction[] = [];
  const named = new Set<string>();
  for (const record of records) {
    named.add(record.container);
    const running = live.names.includes(record.container);
    // A record is written before `docker run`, so a young one with no container may be another
    // process's `up` in progress — not gone. Left for a later sweep.
    const young = now - Date.parse(record.startedAt) < START_GRACE_MS;
    if (!running && young && options.all !== true) continue;
    if (!running) {
      await removeRecord(env, record);
      actions.push({ container: record.container, task: record.task, why: "container gone", ok: true, detail: "record removed" });
      continue;
    }
    const why: SweepAction["why"] | undefined =
      options.all === true
        ? "stopped"
        : pastDeadline(record, now)
          ? "past its deadline"
          : ownerAlive(record.owner, options.stat)
            ? undefined
            : "owner gone";
    if (why === undefined) continue;
    const killed = await killContainer(io, record.container);
    if (killed.ok) await removeRecord(env, record);
    actions.push({ container: record.container, task: record.task, why, ...killed });
  }
  for (const container of live.names) {
    if (named.has(container)) continue;
    const killed = await killContainer(io, container);
    actions.push({ container, task: null, why: options.all === true ? "stopped" : "no record", ...killed });
  }
  return { actions };
}

/**
 * Is nothing answering on `127.0.0.1:<port>`? Asked by connecting, not by
 * listening: Mind's engine has two listeners and this is not a third
 * (`test/guard/no-push.test.ts`). Two `up` calls can still both see a port
 * free; the loser's `docker run` fails "port is already allocated", and
 * {@link browserUp} moves on to the next one.
 */
export function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    const settle = (free: boolean) => {
      socket.destroy();
      done(free);
    };
    socket.setTimeout(1_000, () => settle(false));
    socket.once("connect", () => settle(false));
    socket.once("error", (error: NodeJS.ErrnoException) => settle(error.code === "ECONNREFUSED"));
  });
}

/**
 * Does the browser server answer yet — through the guard, with the token? docker accepts the TCP connection
 * before anything listens, and the guard answers before Playwright MCP behind it does (with a 502), so neither
 * a connect nor any answer is enough: an authorised request that is not the guard's 502 is.
 */
export async function mcpAnswers(port: number, token: string): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000),
    });
    await response.body?.cancel();
    return response.status !== 502 && response.status !== 401;
  } catch {
    return false;
  }
}

export interface BrowserUpOptions {
  readonly env: BrowserEnv;
  readonly subject: SubjectId;
  readonly allow: readonly string[];
  /** The container's operate level: 1 (look, the default) or 2 (act). Its guard serves no more than that. */
  readonly operate?: 1 | 2;
  readonly task?: string;
  readonly ttlSeconds?: number;
  /** The process whose death ends the container; `null` for one a person starts. */
  readonly owner?: number | null;
  /**
   * D-156: a held sensitive action waits this long for the owner's answer (1–3600 s) and goes ahead once on a
   * yes. Omitted or 0: held is refused at once — a browser started by hand has nobody to ask.
   */
  readonly approvalWaitSeconds?: number;
  /** Build the image from {@link BROWSER_BUILD_DIR} when it is missing. Default true. */
  readonly build?: boolean;
  readonly io?: DockerIo;
  readonly ids?: { readonly uid: number; readonly gid: number };
  readonly portFree?: (port: number) => boolean | Promise<boolean>;
  readonly ready?: (port: number, token: string) => Promise<boolean>;
  readonly readyWithinMs?: number;
  readonly image?: string;
}

export type BrowserUp =
  | {
      readonly ok: true;
      readonly record: BrowserRecord;
      readonly built: boolean;
      readonly swept: readonly SweepAction[];
      /** D-156: the key releases are signed with — only for a browser with a wait; held by the caller alone. */
      readonly releaseKey?: KeyObject;
    }
  | { readonly ok: false; readonly reason: string; readonly swept: readonly SweepAction[] };

const PORT_TAKEN = /port is already allocated|address already in use/i;

/** Start one task's container, or say why not. Nothing is left running on a refusal. */
export async function browserUp(options: BrowserUpOptions): Promise<BrowserUp> {
  const { env } = options;
  // The caller's environment, so the token can ride in docker's (`--env MIND_TOKEN`).
  const io = options.io ?? dockerIo(env.env);
  if (await isStopped(env)) {
    return {
      ok: false,
      reason: `the brake is on (${stopPath(env)}): no browser starts while it is — \`mind autonomy resume\` releases it`,
      swept: [],
    };
  }
  const allow = parseAllowlist(options.allow);
  if (!allow.ok) return { ok: false, reason: allow.errors.join("; "), swept: [] };
  const task = options.task ?? newTaskId();
  const badTask = taskProblem(task);
  if (badTask !== undefined) return { ok: false, reason: badTask, swept: [] };
  const operate = options.operate ?? 1;
  if (operate !== 1 && operate !== 2) return { ok: false, reason: "operate is 1 (look) or 2 (act)", swept: [] };
  const approvalWaitSeconds = options.approvalWaitSeconds ?? 0;
  if (!Number.isInteger(approvalWaitSeconds) || approvalWaitSeconds < 0 || approvalWaitSeconds > 3600) {
    return { ok: false, reason: "an approval's wait is 0–3600 seconds", swept: [] };
  }
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < MIN_TTL_SECONDS || ttlSeconds > MAX_TTL_SECONDS) {
    return { ok: false, reason: `ttl must be ${MIN_TTL_SECONDS}–${MAX_TTL_SECONDS} seconds`, swept: [] };
  }
  const ids = options.ids ?? { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 };
  if (ids.uid <= 0 || ids.gid <= 0) {
    return { ok: false, reason: "the browser runs as the owner's own uid, and never as root", swept: [] };
  }

  const sweep = await sweepBrowsers(env, { io });
  if (sweep.error !== undefined) {
    return { ok: false, reason: `docker is not usable here: ${sweep.error}`, swept: [] };
  }
  const already = () => ({
    ok: false as const,
    reason: `task ${task} already has a browser — \`mind browser down ${task}\` first`,
    swept: sweep.actions,
  });
  const { records } = await readBrowserRecords(env);
  if (records.some((record) => record.task === task)) return already();

  const image = options.image ?? BROWSER_IMAGE;
  let built = false;
  if ((await io.run(["image", "inspect", image])).code !== 0) {
    if (options.build === false || !existsSync(join(BROWSER_BUILD_DIR, "Dockerfile"))) {
      return {
        ok: false,
        reason: `the image ${image} is not on this machine; build it with \`docker build -t ${image} docker/browser\` in a Mind checkout`,
        swept: sweep.actions,
      };
    }
    const building = await io.run(["build", "--tag", image, BROWSER_BUILD_DIR]);
    if (building.code !== 0) {
      return { ok: false, reason: `building ${image} failed: ${building.stderr.split("\n").slice(-3).join(" ")}`, swept: sweep.actions };
    }
    built = true;
  }

  const outDir = browserOutDir(env, options.subject, task);
  if (/[,:]/.test(outDir)) {
    return { ok: false, reason: `the output directory ${outDir} holds a ',' or ':', which a docker mount cannot take`, swept: sweep.actions };
  }

  const free = options.portFree ?? portFree;
  const tried = new Set(records.map((record) => record.port));
  const nextPort = async (): Promise<number | undefined> => {
    for (let candidate = BROWSER_PORT_FIRST; candidate <= BROWSER_PORT_LAST; candidate++) {
      if (tried.has(candidate)) continue;
      tried.add(candidate);
      if (await free(candidate)) return candidate;
    }
    return undefined;
  };
  let port = await nextPort();
  const noPort = () => ({
    ok: false as const,
    reason: `every browser port (${BROWSER_PORT_FIRST}–${BROWSER_PORT_LAST}) is in use`,
    swept: sweep.actions,
  });
  if (port === undefined) return noPort();

  await mkdir(outDir, { recursive: true, mode: STATE_DIR_MODE });
  await chmod(outDir, STATE_DIR_MODE);

  const owner = options.owner === undefined || options.owner === null
    ? null
    : { pid: options.owner, start: procStat(options.owner)?.startTicks ?? null };
  // D-156: an Ed25519 pair for a browser that can ask. Only the public half is recorded and handed in.
  const signing = approvalWaitSeconds > 0 ? generateKeyPairSync("ed25519") : undefined;
  let record: BrowserRecord = {
    schema: BROWSER_SCHEMA,
    task,
    subject: options.subject,
    container: containerName(env, task),
    image,
    port,
    token: newToken(),
    allowed: allow.origins.map((origin) => origin.text),
    operate,
    outDir,
    owner,
    startedAt: new Date().toISOString(),
    ttlSeconds,
    ...(signing === undefined ? {} : { approvalWaitSeconds, releasePublicKey: signing.publicKey.export({ type: "spki", format: "der" }).toString("base64") }),
  };
  // Exclusive: a second `up` of the same task that got past the check above loses here.
  if (!(await createRecord(env, record)).ok) return already();

  for (;;) {
    const started = await io.run(dockerRunArgs(record, ids, rootLabel(env)), { MIND_TOKEN: record.token });
    if (started.code === 0) break;
    // Another `up` took this port between the probe and the run: the next one.
    const next = PORT_TAKEN.test(started.stderr) ? await nextPort() : undefined;
    if (next === undefined) {
      await removeRecord(env, record);
      return PORT_TAKEN.test(started.stderr) ? noPort() : { ok: false, reason: `docker run failed: ${started.stderr}`, swept: sweep.actions };
    }
    record = { ...record, port: next };
    await updateRecord(env, record);
  }

  const ready = options.ready ?? mcpAnswers;
  const deadline = Date.now() + (options.readyWithinMs ?? 30_000);
  for (;;) {
    if (await ready(record.port, record.token)) break;
    if (Date.now() > deadline) {
      await killContainer(io, record.container);
      await removeRecord(env, record);
      return { ok: false, reason: `the browser did not answer on 127.0.0.1:${record.port} in time; it was killed`, swept: sweep.actions };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // D-156 (review of PR #24, round 3): the private key is returned to the caller — the task's runner, which is
  // not dumpable — and goes nowhere else: not the record, not the container, not an argv or an environment.
  if (signing !== undefined) return { ok: true, record, built, swept: sweep.actions, releaseKey: signing.privateKey };
  return { ok: true, record, built, swept: sweep.actions };
}

/** End one task's container and forget it. */
export async function browserDown(
  env: BrowserEnv,
  task: string,
  io: DockerIo = dockerIo(),
): Promise<{ readonly ok: boolean; readonly detail: string; readonly recorded: boolean }> {
  const { records } = await readBrowserRecords(env);
  const record = records.find((entry) => entry.task === task);
  const container = record?.container ?? containerName(env, task);
  const killed = await killContainer(io, container);
  if (killed.ok && record !== undefined) await removeRecord(env, record);
  return { ...killed, recorded: record !== undefined };
}

/** What runs, against what is recorded — after sweeping what nothing owns. */
export async function browserStatus(
  env: BrowserEnv,
  io: DockerIo = dockerIo(),
): Promise<{
  readonly swept: readonly SweepAction[];
  readonly running: readonly BrowserRecord[];
  readonly unreadable: readonly string[];
  readonly error?: string;
}> {
  const sweep = await sweepBrowsers(env, { io });
  const { records, unreadable } = await readBrowserRecords(env);
  return { swept: sweep.actions, running: records, unreadable, ...(sweep.error === undefined ? {} : { error: sweep.error }) };
}

/**
 * Run `work` with a task's browser, and end it however `work` ends. The
 * container's owner is this process, so if this process dies before the
 * `finally`, the next sweep ends it — and its deadline does if nothing sweeps.
 */
export async function withBrowser<T>(
  options: Omit<BrowserUpOptions, "owner">,
  work: (record: BrowserRecord) => Promise<T>,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }> {
  const up = await browserUp({ ...options, owner: process.pid });
  if (!up.ok) return { ok: false, reason: up.reason };
  try {
    return { ok: true, value: await work(up.record) };
  } finally {
    await browserDown(options.env, up.record.task, options.io ?? dockerIo());
  }
}
