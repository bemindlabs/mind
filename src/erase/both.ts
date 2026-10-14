/**
 * `erase --remote --yes`, step 6 — this machine and the remote in one run, the remote first (S13.5 AC2).
 *
 * The order is the point. If the local half went first and the remote half then
 * failed, the owner would be holding a local certificate and a half-failure on
 * a machine that still has the data. Remote first means a failure there stops
 * the run with this machine untouched and the data still where it can be
 * re-erased from; and a failure here, after the remote is verified erased,
 * leaves a remote that is clean and a local half that says it is not.
 *
 * The two halves are handed in, so this file knows neither ssh nor the local
 * deleters, and the tests inject a failure into each.
 */

import { remoteExitCode, type RemoteErasure } from "./remote-verify.ts";

export interface LocalHalf {
  readonly state: "ran" | "skipped" | "threw";
  /** The local half's exit code, or `null` when it did not run. */
  readonly exit: number | null;
  readonly detail: string;
}

export interface BothResult {
  readonly remote: RemoteErasure;
  readonly local: LocalHalf;
  /** 0 only when both halves finished clean. A script reads this one. */
  readonly exit: number;
}

/**
 * Erase the remote; only when it is `erased-and-verified`, erase here.
 *
 * @param remoteHalf erase and verify the remote.
 * @param localHalf erase here and answer with its exit code. A throw is a failed local half, not a crash.
 */
export async function eraseBoth(
  remoteHalf: () => Promise<RemoteErasure>,
  localHalf: () => Promise<number>,
): Promise<BothResult> {
  let remote: RemoteErasure;
  try {
    remote = await remoteHalf();
  } catch (error) {
    // The remote may be partly or wholly deleted by now. Say so, and do not touch this machine.
    const detail = error instanceof Error ? error.message : String(error);
    remote = {
      erase: { ok: false, reason: "failed", detail: `the remote half threw: ${detail}`, trees: [] },
      verdict: { verdict: "not-verified", reason: `the remote half threw (${detail}); the remote may be partly or wholly deleted` },
    };
  }
  if (remote.verdict.verdict !== "erased-and-verified") {
    return {
      remote,
      local: { state: "skipped", exit: null, detail: "the remote half is not erased-and-verified, so nothing was deleted here" },
      exit: remoteExitCode(remote.verdict),
    };
  }
  try {
    const exit = await localHalf();
    return { remote, local: { state: "ran", exit, detail: "" }, exit };
  } catch (error) {
    return {
      remote,
      local: { state: "threw", exit: null, detail: error instanceof Error ? error.message : String(error) },
      exit: 1,
    };
  }
}

/** What a person reads about the two halves, in the order they ran. Never says "clean" for a half that is not. */
export function formatBoth(result: BothResult): string[] {
  const remote = result.remote.verdict.verdict;
  const lines = [`remote half (first): ${remote}`];
  switch (result.local.state) {
    case "skipped":
      lines.push(
        `local half: not run. ${result.local.detail}. Fix the remote and run again; this machine still has everything.`,
      );
      break;
    case "threw":
      lines.push(
        `local half: FAILED (${result.local.detail}). The remote is erased-and-verified; this machine is not erased.`,
      );
      break;
    case "ran":
      lines.push(`local half: exit ${result.local.exit}`);
      break;
  }
  return lines;
}
