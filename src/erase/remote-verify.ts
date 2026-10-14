/**
 * `erase --remote`, step 4 — ask the remote again after deleting (S13.5 AC2; the S7.2 / I-4 rule).
 *
 * The delete said `ran`; this is the second question: is anything of the
 * subject still there? The answer comes from the machine, through the same
 * read-only probe as step 2, and not from the delete's own exit codes.
 *
 * ## Three verdicts, never a boolean
 *
 * - `erased-and-verified` — the machine was asked and every directory is not there.
 * - `remaining` — the machine was asked and something is there, even an empty directory.
 * - `not-verified` — the machine could not be asked. This is **never** `erased`:
 *   a look that did not happen proves nothing (I-4).
 *
 * Like the other two files this starts no process; the runner is handed in.
 */

import type { SubjectId } from "../types.ts";
import type { RemoteErasePlan } from "./remote.ts";
import { erasePhrase, eraseRemote, type RemoteEraseResult } from "./remote-erase.ts";
import { probeRemote, type ProbeResult, type RemoteTreeState, type Runner } from "./remote-probe.ts";

export type RemoteVerdict =
  | { readonly verdict: "erased-and-verified" }
  | { readonly verdict: "remaining"; readonly left: readonly RemoteTreeState[] }
  | { readonly verdict: "not-verified"; readonly reason: string };

/** What the second look found. Pure: the probe's result in, a verdict out. */
export function judgeProbe(probe: ProbeResult): RemoteVerdict {
  if (!probe.ok) return { verdict: "not-verified", reason: `${probe.reason}: ${probe.detail}` };
  const left = probe.trees.filter((tree) => tree.state === "present");
  return left.length === 0 ? { verdict: "erased-and-verified" } : { verdict: "remaining", left };
}

/** Ask the machine again. */
export async function verifyRemote(plan: RemoteErasePlan, run: Runner): Promise<RemoteVerdict> {
  return judgeProbe(await probeRemote(plan, run));
}

/** A script's exit code for the remote half: 0 only for a verified erase; 1 for something left; 4 for 'could not look'. */
export function remoteExitCode(verdict: RemoteVerdict): number {
  switch (verdict.verdict) {
    case "erased-and-verified":
      return 0;
    case "remaining":
      return 1;
    case "not-verified":
      return 4;
  }
}

export interface RemoteErasure {
  /** The plan the run used. Absent when nothing was looked at. */
  readonly plan?: RemoteErasePlan;
  /** What the delete reported. Its own `ok` does not decide the verdict; the second look does. */
  readonly erase: RemoteEraseResult;
  readonly verdict: RemoteVerdict;
}

/**
 * Erase, then ask. The ask runs even when the delete reported a failure — what is left is exactly what a
 * person needs to read then — and the verdict rests on what the second look saw, not on the delete's report.
 */
export async function eraseAndVerifyRemote(plan: RemoteErasePlan, typed: string, run: Runner): Promise<RemoteErasure> {
  if (typed !== erasePhrase(plan.subject, plan.target.name)) {
    const erase = await eraseRemote(plan, typed, run);
    return { erase, verdict: { verdict: "not-verified", reason: "nothing was sent, so nothing was erased and nothing was looked at" } };
  }
  const erase = await eraseRemote(plan, typed, run);
  return { plan, erase, verdict: await verifyRemote(plan, run) };
}

/** The lines a person reads under the remote half. */
export function formatRemoteVerdict(plan: RemoteErasePlan, subject: SubjectId, result: RemoteVerdict): string[] {
  switch (result.verdict) {
    case "erased-and-verified":
      return [`remote — ${plan.machine}: erased-and-verified. Asked again after deleting; nothing of ${subject} is there.`];
    case "remaining":
      return [
        `remote — ${plan.machine}: remaining. Asked again after deleting, and this is still there:`,
        ...result.left.map((tree) => `  ${tree.dir} — ${tree.entries} entries, ${tree.bytes} bytes`),
      ];
    case "not-verified":
      return [
        `remote — ${plan.machine}: NOT VERIFIED. ${result.reason}`,
        "  This is not an erasure certificate: the machine could not be asked, so nothing is claimed about what is there.",
      ];
  }
}
