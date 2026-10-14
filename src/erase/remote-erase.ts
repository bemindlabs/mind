/**
 * `erase --remote`, step 3 — remove the subject's directories on the remote machine (S13.5 AC2, D-100 #2, #4).
 *
 * The same trees, in the same order as the local half (the data map's own
 * order, the ledger last), each removed by one `rm -rf` sent through the
 * runner somebody hands in. Like the probe, this file starts no process: a
 * real runner is wired by the caller, and every test here runs on a fake one.
 *
 * ## What it does not claim
 *
 * `ran` means the command came back 0, not that the directory is gone. Whether
 * anything is left is a second question put to the machine afterwards (step 4),
 * and an unreachable machine is never reported as a removal.
 *
 * ## Guards
 *
 * - **A phrase typed by the owner.** Nothing is sent unless `typed` is exactly
 *   {@link erasePhrase} — it names the subject and the machine, so a habit
 *   cannot carry it from one erase to another (D-100 #4). Reading it at a
 *   terminal is the caller's job; this file only compares.
 * - **Only under the volume.** A directory that is not strictly inside the
 *   remote volume, or has a `..` in it, is refused before any command is built.
 * - **No key or personal word in an argv.** Every word is a constant or a path
 *   from the layout, and {@link remote} refuses a word a remote shell would split.
 */

import { reachFor, remote } from "../deploy/commands.ts";
import type { SubjectId } from "../types.ts";
import { remoteTrees, type RemoteErasePlan } from "./remote.ts";
import type { Runner } from "./remote-probe.ts";

/** The phrase the owner types at a terminal before the remote half runs. */
export function erasePhrase(subject: SubjectId, machine: string): string {
  return `erase ${subject} on ${machine}`;
}

/** What happened to one remote directory. */
export interface RemoteTreeResult {
  readonly label: string;
  readonly dir: string;
  /** `ran`: the command exited 0. `failed`: it did not. `not-attempted`: an earlier failure ended the run. */
  readonly outcome: "ran" | "failed" | "not-attempted";
  readonly detail: string;
}

export type RemoteEraseResult =
  | { readonly ok: true; readonly trees: readonly RemoteTreeResult[] }
  | {
      readonly ok: false;
      readonly reason: "phrase" | "unsupported-provider" | "outside-volume" | "unreachable" | "failed";
      readonly detail: string;
      /** Empty when nothing was sent. */
      readonly trees: readonly RemoteTreeResult[];
    };

/** ssh's own exit status when it cannot connect or authenticate. */
const SSH_FAILED = 255;

function insideVolume(volume: string, dir: string): boolean {
  return dir.startsWith(`${volume}/`) && dir.length > volume.length + 1 && !dir.split("/").includes("..");
}

/**
 * The ssh command line that removes one remote directory, or `undefined` when the target is not ssh.
 *
 * @throws {Error} when `dir` is not strictly inside one of the plan's volumes.
 */
export function eraseArgv(plan: RemoteErasePlan, dir: string): string[] | undefined {
  if (plan.target.provider !== "ssh") return undefined;
  const volume = plan.layout.volume;
  if (!insideVolume(volume, dir)) throw new Error(`not strictly inside ${volume}: ${JSON.stringify(dir)}`);
  return remote(reachFor(plan.target).shell, ["rm", "-rf", "--", dir]);
}

/**
 * Remove every directory of the remote half, in erase's order. Stops at the first machine that cannot be
 * reached; carries on past a directory that failed, so one stuck tree does not hide the rest.
 */
export async function eraseRemote(plan: RemoteErasePlan, typed: string, run: Runner): Promise<RemoteEraseResult> {
  const expected = erasePhrase(plan.subject, plan.target.name);
  if (typed !== expected) {
    return { ok: false, reason: "phrase", detail: "the typed phrase is not the one this erase asks for; nothing was sent", trees: [] };
  }
  if (plan.target.provider !== "ssh") {
    return { ok: false, reason: "unsupported-provider", detail: `${plan.machine}: only an ssh target can be erased so far`, trees: [] };
  }

  // Every command is built before the first is sent, so a bad path stops the run with nothing done.
  const queued: { label: string; dir: string; argv: string[] }[] = [];
  for (const { label, dir } of remoteTrees(plan)) {
    try {
      const argv = eraseArgv(plan, dir);
      if (argv !== undefined) queued.push({ label, dir, argv });
    } catch (error) {
      return { ok: false, reason: "outside-volume", detail: error instanceof Error ? error.message : String(error), trees: [] };
    }
  }

  const trees: RemoteTreeResult[] = [];
  let unreachable: string | undefined;
  let failed = false;
  for (const { label, dir, argv } of queued) {
    if (unreachable !== undefined) {
      trees.push({ label, dir, outcome: "not-attempted", detail: "an earlier directory could not be reached" });
      continue;
    }
    try {
      const result = await run(argv);
      if (result.code === SSH_FAILED) {
        unreachable = `ssh could not reach ${plan.machine}: ${result.stderr.trim()}`;
        trees.push({ label, dir, outcome: "failed", detail: unreachable });
      } else if (result.code === 0) {
        trees.push({ label, dir, outcome: "ran", detail: "" });
      } else {
        failed = true;
        trees.push({ label, dir, outcome: "failed", detail: `exit ${result.code}: ${result.stderr.trim()}` });
      }
    } catch (error) {
      unreachable = error instanceof Error ? error.message : String(error);
      trees.push({ label, dir, outcome: "failed", detail: unreachable });
    }
  }
  if (unreachable !== undefined) return { ok: false, reason: "unreachable", detail: unreachable, trees };
  if (failed) return { ok: false, reason: "failed", detail: "at least one directory could not be removed", trees };
  return { ok: true, trees };
}
