/**
 * A browser task's record, and the one docker call that ends a container.
 *
 * Kept apart from `runtime.ts` (which also probes ports and HTTP) so `erase`
 * can end a subject's containers through the spawn chokepoint without a socket
 * entering its import closure (`test/erase/no-network.test.ts`).
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runGuarded } from "../spawn.ts";
import { STATE_DIR_MODE, STATE_FILE_MODE, stateRoot } from "../state.ts";
import type { SubjectId } from "../types.ts";
import { browserDirFor, browserRoot, recordPath, wiringDir, type BrowserEnv } from "./paths.ts";

export type { BrowserEnv } from "./paths.ts";

/** @2 since the PR #19 review: records live under their subject and carry the task's token. */
export const BROWSER_SCHEMA = "mind/browser@2";
export const CONTAINER_PREFIX = "mind-browser-";
export const BROWSER_LABEL = "dev.mind.browser";

/** One task's container, as recorded before it was started. Mode 600: it holds the token. */
export interface BrowserRecord {
  readonly schema: string;
  readonly task: string;
  readonly subject: SubjectId;
  readonly container: string;
  readonly image: string;
  /** Host side: `127.0.0.1:<port>`. */
  readonly port: number;
  /** The bearer token the container's guard asks for (`docker/browser/guard.mjs`). */
  readonly token: string;
  /** Normalised origins (`scheme://host:port`). */
  readonly allowed: readonly string[];
  /**
   * The container's operate level (D-153), fixed at `up`: its guard serves the look tools at 1 and the act
   * tools at 2. A turn's own level can only narrow this, never widen it.
   */
  readonly operate: 1 | 2;
  /** The task's recording: trace, screenshots, action log, egress log. */
  readonly outDir: string;
  /** The process whose death ends the container, or `null` for one a person started. */
  readonly owner: { readonly pid: number; readonly start: number | null } | null;
  readonly startedAt: string;
  readonly ttlSeconds: number;
  /**
   * D-156: how long a held sensitive action waits in the container for the owner's answer; absent or 0 for a
   * browser nobody can answer for (`mind browser up`), where held stays refused.
   */
  readonly approvalWaitSeconds?: number;
  /**
   * D-156 (review of PR #24, round 3): the Ed25519 public key the container checks releases with (base64 SPKI
   * DER). Public: it can only verify. The private key is the runner's, in its memory, and nowhere else.
   */
  readonly releasePublicKey?: string;
}

/** A record as it may be printed: everything but the token. (The release key is never in a record.) */
export function shown(record: BrowserRecord): Omit<BrowserRecord, "token"> {
  const { token, ...rest } = record;
  void token;
  return rest;
}

/** A docker CLI call: argv after `docker`, output decoded, and extra environment for the CLI. */
export interface DockerIo {
  run(
    args: readonly string[],
    env?: Readonly<Record<string, string>>,
  ): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
}

/**
 * The docker verbs Mind uses, and no others. `push`, `login` and `save` are
 * not here: the image is built on this machine and stays on it.
 */
export const DOCKER_VERBS: readonly string[] = ["run", "kill", "ps", "build", "image"];


/** Why Mind will not run this docker argv, or `undefined`. */
export function dockerRefusal(args: readonly string[]): string | undefined {
  const verb = args[0];
  if (verb === undefined || !DOCKER_VERBS.includes(verb)) {
    return `docker ${verb ?? ""} is not one of the verbs Mind runs (${DOCKER_VERBS.join(", ")})`.trim();
  }
  if (verb === "image" && args[1] !== "inspect") return "docker image may only inspect";
  return undefined;
}

/**
 * The real docker CLI, through the spawn chokepoint (`src/spawn.ts`). `extra`
 * is how a secret reaches `docker run --env NAME`: in the CLI's environment
 * (`base` with `extra` over it), never its argv, which any local user can read
 * in `/proc`.
 */
export function dockerIo(base?: Readonly<Record<string, string | undefined>>): DockerIo {
  return {
    async run(args, extra) {
      const refused = dockerRefusal(args);
      if (refused !== undefined) return { code: 126, stdout: "", stderr: refused };
      // `extra` lands on `base`; with no base, docker inherits this process's environment and gets no extra —
      // a caller with a secret to pass names its environment (browserUp does), so nothing here reads one.
      const env = extra === undefined || base === undefined ? base : { ...base, ...extra };
      try {
        const result = await runGuarded(["docker", ...args], env === undefined ? {} : { env });
        return { code: result.code, stdout: new TextDecoder().decode(result.stdout), stderr: result.stderr };
      } catch (error) {
        return { code: 127, stdout: "", stderr: `docker could not be started (${String(error)})` };
      }
    },
  };
}

/** A short hash of the state root: in every container's labels and name, so a sweep only touches its own. */
export function rootLabel(env: BrowserEnv): string {
  return createHash("sha256").update(stateRoot(env.home, env.env)).digest("hex").slice(0, 16);
}

/** Container names are global to docker; the state root's hash keeps two roots' tasks apart. */
export function containerName(env: BrowserEnv, task: string): string {
  return `${CONTAINER_PREFIX}${rootLabel(env).slice(0, 8)}-${task}`;
}

async function privateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: STATE_DIR_MODE });
  await chmod(path, STATE_DIR_MODE);
}

/**
 * Write a new record, refusing one that exists (`wx`): two `up` calls for one
 * task cannot both believe they own it.
 */
export async function createRecord(env: BrowserEnv, record: BrowserRecord): Promise<{ readonly ok: boolean }> {
  await privateDir(browserRoot(env));
  await privateDir(browserDirFor(env, record.subject));
  try {
    await writeFile(recordPath(env, record.subject, record.task), `${JSON.stringify(record, null, 2)}\n`, {
      mode: STATE_FILE_MODE,
      flag: "wx",
    });
    return { ok: true };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return { ok: false };
    throw cause;
  }
}

/** Replace a record this process created (the port changed after a lost race). */
export async function updateRecord(env: BrowserEnv, record: BrowserRecord): Promise<void> {
  await writeFile(recordPath(env, record.subject, record.task), `${JSON.stringify(record, null, 2)}\n`, {
    mode: STATE_FILE_MODE,
  });
}

/** Forget a task: its record and the config files that pointed at its port. */
export async function removeRecord(env: BrowserEnv, record: Pick<BrowserRecord, "subject" | "task">): Promise<void> {
  await unlink(recordPath(env, record.subject, record.task)).catch(() => undefined);
  await rm(wiringDir(env, record.subject, record.task), { recursive: true, force: true }).catch(() => undefined);
}

function isRecord(value: unknown): value is BrowserRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record["schema"] === BROWSER_SCHEMA &&
    typeof record["task"] === "string" &&
    typeof record["subject"] === "string" &&
    typeof record["container"] === "string" &&
    typeof record["port"] === "number" &&
    typeof record["token"] === "string" &&
    (record["operate"] === 1 || record["operate"] === 2) &&
    Array.isArray(record["allowed"]) &&
    typeof record["outDir"] === "string"
  );
}

async function entries(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch {
    return [];
  }
}

/**
 * Every record under the state root, or under one subject; an unreadable one is
 * reported, not thrown.
 */
export async function readBrowserRecords(
  env: BrowserEnv,
  only?: SubjectId,
): Promise<{ readonly records: readonly BrowserRecord[]; readonly unreadable: readonly string[] }> {
  const subjects = only === undefined ? await entries(browserRoot(env)) : [only];
  const records: BrowserRecord[] = [];
  const unreadable: string[] = [];
  for (const subject of subjects) {
    const dir = join(browserRoot(env), subject);
    for (const name of (await entries(dir)).filter((entry) => entry.endsWith(".json"))) {
      const path = join(dir, name);
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        if (isRecord(parsed) && parsed.subject === subject) records.push(parsed);
        else unreadable.push(path);
      } catch {
        unreadable.push(path);
      }
    }
  }
  return { records, unreadable };
}

export async function killContainer(io: DockerIo, container: string): Promise<{ readonly ok: boolean; readonly detail: string }> {
  const killed = await io.run(["kill", container]);
  if (killed.code === 0) return { ok: true, detail: "killed" };
  // Already gone is the outcome being asked for.
  if (/no such container|is not running/i.test(killed.stderr)) return { ok: true, detail: "already gone" };
  return { ok: false, detail: killed.stderr || `docker kill exited ${killed.code}` };
}

/** What `erase` did to one of the subject's browser tasks. */
export interface EndedBrowser {
  readonly task: string;
  readonly container: string;
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * `docker kill` every container of one subject's records — the same step
 * `erase` takes (`src/erase/plan.ts`) before the tree holding the records is
 * removed. A kill docker refuses is reported; erase counts it as a failure, so
 * its verdict is not clean while a container may still be running.
 */
export async function endSubjectBrowsers(
  env: BrowserEnv,
  subject: SubjectId,
  io: DockerIo = dockerIo(),
): Promise<readonly EndedBrowser[]> {
  const { records } = await readBrowserRecords(env, subject);
  const ended: EndedBrowser[] = [];
  for (const record of records) {
    const killed = await killContainer(io, record.container);
    ended.push({ task: record.task, container: record.container, ...killed });
  }
  return ended;
}
