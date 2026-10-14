/** `mind new` — an agent repository, and nothing that publishes it. */

import { relative, resolve } from "node:path";
import { SIDE_BY_SIDE_NOTE, newAgent } from "../../src/agent/index.ts";
import { GIT_UNDELETABLE } from "../../src/guard/index.ts";
import { isSubjectId, subjectId } from "../../src/types.ts";
import { ENGINE_CHECKOUT, OUT, bold, dim, parseArgs, printPlaceNotices, usageError } from "../shared.ts";

/**
 * `mind new` — an agent repository, and nothing that publishes it.
 *
 * `--subject` is required rather than taken from `<name>`. A directory name is
 * a hint and an identity is a claim (see `src/soul/load.ts`); letting the first
 * become the second is how an agent quietly ends up wearing the wrong one. The
 * two are usually the same word, and typing it twice is the cost of nobody ever
 * having inferred it.
 */
export async function cmdNew(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const name = positional[0];
  const subject = options.get("subject");
  if (name === undefined || name === "" || subject === undefined || subject === "") {
    return usageError("usage: mind new <name> --subject <id> [--dir <parent>]");
  }

  let id;
  try {
    id = subjectId(subject);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }

  // The name becomes a directory, and later a path inside somebody's clone of
  // it. The subject alphabet is already the one chosen for exactly that.
  if (!isSubjectId(name)) {
    return usageError(
      `invalid agent name ${JSON.stringify(name)} — it becomes a directory name, so: lowercase ` +
        `letters, digits, dash and underscore, starting with a letter or digit`,
    );
  }

  const parent = options.get("dir");
  const dir = resolve(parent === undefined || parent === "" ? process.cwd() : parent, name);

  // `undefined` from the compiled binary, where there is no checkout to
  // compare a destination against. The git refusal is what holds there.
  const result = await newAgent({ dir, subject: id, name, engineRoot: ENGINE_CHECKOUT });
  if (!result.ok) {
    console.error(`mind: ${result.reason}`);
    return result.kind === "refused" ? 2 : 1;
  }

  console.log(`created ${result.dir}`);
  for (const file of result.files) console.log(dim(`  ${file}`));
  for (const hook of result.hooks) console.log(dim(`  ${relative(result.dir, hook)}  (not in git)`));
  console.log();
  console.log(
    dim(
      "Nothing was committed and no remote was set — publishing an identity is a human act (D-013). " +
        "Make the first commit yourself.",
    ),
  );
  console.log(
    dim(
      "No remote exists yet, and Mind cannot see whether one you add later is private. It never " +
        "asks a host anything, so it will not tell you this repository is private — only that it " +
        "cannot see. Check the visibility yourself, on the host, before the first push.",
    ),
  );
  console.log();
  // Printed now rather than when somebody asks to delete something, which is
  // the whole of AC5's timing: the moment to know a commit is permanent is
  // before it exists (`erase` itself is S7.2).
  console.log(bold("Before the first commit, what git will keep whatever you do later:"));
  for (const note of GIT_UNDELETABLE) console.log(dim(`  - ${note}`));
  console.log();
  // And the other four, now rather than when somebody asks to delete. Two of
  // them have no code behind them yet, and saying so here is the only moment
  // at which that is useful: `WEIGHTS_UNDELETABLE` is advice nobody can act on
  // once an adapter has been trained.
  printPlaceNotices(OUT);
  console.log();
  console.log(dim(`Then: mind rebuild ${result.dir} --subject ${id}`));
  console.log(dim(SIDE_BY_SIDE_NOTE));
  return 0;
}
