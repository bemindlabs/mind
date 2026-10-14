/**
 * `erase --remote`, step 2 — look at the remote machine, read-only (S13.5 AC2, D-100 #2).
 *
 * One `find` per directory the remote data map names, sent through a runner
 * somebody hands in. This file starts no process and opens no socket: the
 * runner is the only thing that does, so every test here runs on a fake one
 * and a real one is wired where the spawn chokepoint already lives.
 *
 * ## What it must never do
 *
 * - **Read "could not look" as "nothing there".** A directory is `absent` only
 *   when the far side says, in so many words, that it does not exist. An
 *   unreachable machine, a permission error or any other failure makes the
 *   whole probe fail, so a later "erased" can never rest on a look that did
 *   not happen (S7.2, I-4).
 * - **Put a secret or a personal word in an argv.** Every word is built from
 *   constants and the layout's paths, and {@link remote} refuses a word a
 *   remote shell would split.
 */

import { reachFor, remote } from "../deploy/commands.ts";
import type { Target } from "../deploy/target.ts";
import { remoteTrees, type RemoteErasePlan } from "./remote.ts";

/** What a command run for us came back with. */
export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one command line and says what happened. Never throws for a non-zero exit. */
export type Runner = (argv: readonly string[]) => Promise<RunResult>;

/** What is at one remote directory. */
export interface RemoteTreeState {
  readonly label: string;
  readonly dir: string;
  readonly state: "present" | "absent";
  /** Everything that is not a directory: files, links, sockets. */
  readonly entries: number;
  /** The bytes of the regular files. */
  readonly bytes: number;
}

export type ProbeFailure =
  /** ssh could not connect, or the runner itself failed. */
  | "unreachable"
  /** The far side answered, and the answer was not "absent" or a listing. */
  | "unreadable"
  /** The target is not an ssh machine; only ssh is built so far. */
  | "unsupported-provider";

export type ProbeResult =
  | { readonly ok: true; readonly trees: readonly RemoteTreeState[] }
  | { readonly ok: false; readonly reason: ProbeFailure; readonly detail: string };

/** ssh's own exit status when it cannot connect or authenticate. */
const SSH_FAILED = 255;

/**
 * The ssh command line that lists one remote directory: the type letter and the
 * size of everything under it, comma-separated (`f120,d4096,`).
 */
export function probeArgv(target: Target, dir: string): string[] | undefined {
  if (target.provider !== "ssh") return undefined;
  return remote(reachFor(target).shell, ["find", dir, "-printf", "%y%s,"]);
}

/** `f120,d4096,l9,` → the entries that are not directories, and the bytes of the regular files. */
function parseListing(stdout: string): { entries: number; bytes: number } | undefined {
  let entries = 0;
  let bytes = 0;
  for (const item of stdout.split(",")) {
    if (item === "") continue;
    const match = /^([a-zA-Z])(\d+)$/.exec(item);
    if (!match) return undefined;
    if (match[1] === "d") continue;
    entries += 1;
    if (match[1] === "f") bytes += Number(match[2]);
  }
  return { entries, bytes };
}

/** Whether `find` said, and only said, that the directory is not there. */
function isAbsent(result: RunResult): boolean {
  const lines = result.stderr.split("\n").filter((line) => line.trim() !== "");
  return (
    result.code === 1 &&
    result.stdout.trim() === "" &&
    lines.length > 0 &&
    lines.every((line) => line.endsWith("No such file or directory"))
  );
}

/** Look at every directory the remote half would remove. Reads only; stops at the first look that did not happen. */
export async function probeRemote(plan: RemoteErasePlan, run: Runner): Promise<ProbeResult> {
  const trees: RemoteTreeState[] = [];
  for (const { label, dir } of remoteTrees(plan)) {
    const argv = probeArgv(plan.target, dir);
    if (argv === undefined) {
      return { ok: false, reason: "unsupported-provider", detail: `${plan.machine}: only an ssh target can be looked at so far` };
    }
    let result: RunResult;
    try {
      result = await run(argv);
    } catch (error) {
      return { ok: false, reason: "unreachable", detail: `${label}: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (result.code === SSH_FAILED) {
      return { ok: false, reason: "unreachable", detail: `${label}: ssh could not reach ${plan.machine}: ${result.stderr.trim()}` };
    }
    if (isAbsent(result)) {
      trees.push({ label, dir, state: "absent", entries: 0, bytes: 0 });
      continue;
    }
    const listing = result.code === 0 ? parseListing(result.stdout) : undefined;
    if (listing === undefined) {
      return { ok: false, reason: "unreadable", detail: `${label}: ${dir}: exit ${result.code}: ${result.stderr.trim() || "no listing"}` };
    }
    trees.push({ label, dir, state: "present", ...listing });
  }
  return { ok: true, trees };
}

/** The lines a person reads: what is there, per directory, and nothing about what is not looked at. */
export function formatProbe(result: ProbeResult): string[] {
  if (!result.ok) return [`remote — could not look (${result.reason}): ${result.detail}`];
  return result.trees.flatMap((tree) => [
    `  ${tree.label}`,
    tree.state === "absent" ? `    ${tree.dir} — not there` : `    ${tree.dir} — ${tree.entries} entries, ${tree.bytes} bytes`,
  ]);
}
