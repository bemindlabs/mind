/**
 * Whose data a capture lands in — the answer D-036 gave OPEN-1.
 *
 * claude 2.1.280 stopped sending the `source` field `deriveOrigin` was built
 * on, so a hook can no longer tell the owner's turn from a fleet launcher's
 * `claude -p`. The owner chose to move the question from a label on each
 * record to the boundary between subjects: a fleet launcher declares itself
 * with `MIND_FLEET=<subject>`, and its work goes to that subject instead of
 * the one the hook names.
 *
 * ## Why an environment variable
 *
 * claude merges hooks from every settings layer, so a launcher passing its own
 * `--settings` cannot remove the one in `~/.claude/settings.json`. The
 * environment is the one thing a launcher controls that the hook's process is
 * certain to inherit. `MIND_SUBJECT` was not reused: it already means "this
 * process runs under Mind's `cli-exec`", and the guard hook refuses pushes
 * on it.
 *
 * ## The direction it fails in
 *
 * A marker that is present but not a subject id records nothing, and does not
 * fall back to the hook's subject. A launcher that templated
 * `MIND_FLEET=${NAME}` with an empty name has still said "I am the fleet",
 * and the owner's data is the one place that sentence must not end up.
 *
 * ## What this does not do
 *
 * An unmarked session is not promoted to `owner-prompted`. It is a session
 * that did not declare itself, which is weaker, and `deriveOrigin` keeps saying
 * `unknown` for it. The launcher that forgot is caught by {@link fleetLeaks},
 * which counts and changes nothing.
 */

import { readMind } from "../env.ts";
import {
  countPersonal,
  isSubjectId,
  subjectId,
  type CountTally,
  type Personal,
  type SubjectId,
} from "../types.ts";
import type { CaptureRecord } from "./record.ts";

/** The variable a fleet launcher sets on itself. */
export const FLEET_ENV = "MIND_FLEET";

/** Where one capture goes, or why it goes nowhere. */
export type CaptureTarget =
  | { readonly ok: true; readonly subject: SubjectId; readonly fleet: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * The subject a capture is written under.
 *
 * `hookSubject` is the `--subject` the hook was configured with. Any presence
 * of {@link FLEET_ENV} wins over it, including a present-but-invalid one.
 */
export function captureTarget(
  hookSubject: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): CaptureTarget {
  const fleet = readMind(FLEET_ENV, env);
  if (fleet !== undefined) {
    if (!isSubjectId(fleet)) {
      return {
        ok: false,
        reason:
          `${FLEET_ENV}=${JSON.stringify(fleet)} is not a subject id, and nothing was recorded — ` +
          `a process that declared itself fleet is never written under the hook's own subject`,
      };
    }
    return { ok: true, subject: subjectId(fleet), fleet: true };
  }
  if (hookSubject === undefined || hookSubject === "" || !isSubjectId(hookSubject)) {
    return { ok: false, reason: "--subject <id> is required, and nothing was recorded" };
  }
  return { ok: true, subject: subjectId(hookSubject), fleet: false };
}

/** Counts a record under its working directory, and nothing else. */
const LEAK_TALLIES: readonly CountTally[] = [{ key: { parts: [{ field: "project" }] } }];

/**
 * How many records in a subject came from directories a fleet runs in.
 *
 * The audit D-036 promised for a launcher that forgot the marker. It goes
 * through `countPersonal`, so the directories are the caller's words from
 * outside the box and the answer is counts under them: no project, session or
 * path the owner worked in comes out, only whether the named ones appear.
 * Anything not named is not counted — the audit can only find the leaks it was
 * told where to look for.
 */
export function fleetLeaks(
  records: Personal<readonly CaptureRecord[]>,
  fleetDirs: readonly string[],
): Readonly<Record<string, number>> {
  return countPersonal(records, LEAK_TALLIES, [...new Set(fleetDirs)]);
}

/** What the leak count can and cannot say, printed every time. */
export const FLEET_LEAK_LIMITS: readonly string[] = [
  "a directory matches only when it is exactly the working directory the session ran in. A " +
    "launcher that runs in a subdirectory of a name given here is not counted under it.",
  "only the directories named are looked for. A launcher nobody listed leaks without showing " +
    "up here, which is why the list of launchers belongs next to the list of markers.",
  `a count above zero is a launcher that ran without ${FLEET_ENV} — or the owner working in that ` +
    "directory by hand. The count cannot tell those apart; a person can.",
  "adding the marker stops new records; it does not move old ones. Those stay until purged.",
];

/** The count as lines, directories with records first. */
export function formatFleetLeaks(counts: Readonly<Record<string, number>>): readonly string[] {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (entries.length === 0) return ["  no fleet directory was named, so nothing was looked for"];
  return entries.map(([dir, n]) => `  ${String(n).padStart(6)}  ${dir}${n > 0 ? "  ← unmarked" : ""}`);
}
