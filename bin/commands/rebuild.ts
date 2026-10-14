/** `mind rebuild` — put `.mind/` back from what git holds. */

import { DERIVED_DIR, derivedStatus, rebuildDerived } from "../../src/agent/index.ts";
import { subjectId } from "../../src/types.ts";
import { bold, dim, parseArgs, report, usageError } from "../shared.ts";

/**
 * `mind rebuild` — the command I-2 is measured by.
 *
 * `--check` is the read-only half: it answers fresh, stale or missing and
 * touches nothing. The exit code is usable in a script — 0 for fresh, 1 for
 * anything a rebuild would change — because "is this machine's derived state
 * current?" is a question CI asks too. `doctor --agent` reports the same
 * `derivedStatus`, and reports it as a warning rather than a failure: a stale
 * `.mind/` costs one rebuild, which is not the same as a machine that cannot
 * work.
 */
export async function cmdRebuild(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, ["check"]);
  const dir = positional[0];
  const subject = options.get("subject");
  if (dir === undefined || dir === "" || subject === undefined || subject === "") {
    return usageError("usage: mind rebuild <dir> --subject <id> [--check]");
  }

  let id;
  try {
    id = subjectId(subject);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }

  if (options.has("check")) {
    const status = await derivedStatus(dir, id);
    console.log(`${bold(status.state)} — ${status.reason}`);
    for (const path of status.unowned) {
      console.log(dim(`  ${path} — no derivation produces this; a rebuild would remove it`));
    }
    return status.state === "fresh" ? 0 : 1;
  }

  const result = await rebuildDerived(dir, { subject: id, now: () => new Date() });
  if (!result.ok) return report(result.issues);

  for (const path of result.built) console.log(`built ${path}`);
  for (const path of result.removed) {
    console.log(dim(`removed ${path} — no derivation produces it, so nothing could rebuild it`));
  }
  console.log(
    dim(
      `${DERIVED_DIR}/ can be deleted at any time; everything in it is derived from what git holds (I-2). ` +
        `Only built_at changes between two rebuilds of an unchanged repository.`,
    ),
  );
  return 0;
}
