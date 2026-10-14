/**
 * `erase --remote`, step 7 — one line per remote erase (S13.5 AC3).
 *
 * Kept outside every subject's trees on purpose. The turn ledger is the thing
 * `erase` empties, and a line written there after an erase would put the
 * subject back and be the first hit of the next search. This is a separate
 * append-only file in the state root, and a line holds only what happened to
 * the machine — when, which one, the verdict, the exit code, how many
 * directories were asked about — never the subject id, a needle or any
 * content. `test/erase/remote-log.test.ts` holds a line to that.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { remoteTrees, type RemoteErasePlan } from "./remote.ts";
import type { RemoteErasure } from "./remote-verify.ts";
import { remoteExitCode } from "./remote-verify.ts";

export const REMOTE_ERASE_LOG_VERSION = 1;

export interface RemoteEraseLine {
  readonly v: typeof REMOTE_ERASE_LOG_VERSION;
  readonly kind: "remote-erase";
  readonly at: string;
  /** The target's own name (`vps-1`), not the subject. */
  readonly machine: string;
  readonly provider: string;
  readonly verdict: RemoteErasure["verdict"]["verdict"];
  readonly exit: number;
  /** Directories the remote data map names, and how many the second look found still there (`null`: not asked). */
  readonly directories: number;
  readonly remaining: number | null;
}

/** Where the log is, under the state root. */
export function remoteEraseLogPath(stateRoot: string): string {
  return join(stateRoot, "remote-erase.jsonl");
}

/** The line for one remote erase. Pure. */
export function remoteEraseLine(base: RemoteErasePlan, erasure: RemoteErasure, at: string): RemoteEraseLine {
  const plan = erasure.plan ?? base;
  const verdict = erasure.verdict;
  return {
    v: REMOTE_ERASE_LOG_VERSION,
    kind: "remote-erase",
    at,
    machine: plan.target.name,
    provider: plan.target.provider,
    verdict: verdict.verdict,
    exit: remoteExitCode(verdict),
    directories: remoteTrees(plan).length,
    remaining: verdict.verdict === "remaining" ? verdict.left.length : verdict.verdict === "erased-and-verified" ? 0 : null,
  };
}

/** Append one line. The file is private to this user, like the rest of the state root. */
export async function appendRemoteEraseLine(stateRoot: string, line: RemoteEraseLine): Promise<void> {
  const path = remoteEraseLogPath(stateRoot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
}
