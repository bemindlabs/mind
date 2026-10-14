/** `mind worn` — which identity this machine is wearing, read off disk. */

import { homedir } from "node:os";
import { resolve } from "node:path";
import { PHASE_A_BACKENDS } from "../../src/exec/index.ts";
import {
  formatWorn,
  isKnownBackend,
  resolveTargets,
  wearsOnly,
  whichOnPath,
  wornReport,
} from "../../src/soul/index.ts";
import { subjectId } from "../../src/types.ts";
import { bold, dim, parseArgs, usageError } from "../shared.ts";

const WORN_USAGE = "usage: mind worn [--backend a,b] [--home <dir>] [--subject <id>] [--json]";

/**
 * The flags `worn` takes no value for.
 *
 * Exported because `--as` parses this command line too and needs the same list.
 * See {@link import("./soul.ts").SOUL_CHECK_BOOLEANS} for why there is one copy.
 */
export const WORN_BOOLEANS: readonly string[] = ["json"];

/**
 * Which identity this machine is wearing, read off the files themselves.
 *
 * S1.6 AC1's report, and the function S0.2's `doctor` will call for its own
 * AC5 — one implementation, so the two can never disagree about what is on.
 * Reads and prints; there is no state to write, because there is deliberately
 * no stored "currently worn" pointer to go stale (see `src/soul/worn.ts`).
 */
export async function cmdWorn(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, WORN_BOOLEANS);
  if (positional.length > 0) return usageError(WORN_USAGE);

  const asked = options.get("subject");
  let wanted;
  if (asked !== undefined && asked !== "") {
    try {
      wanted = subjectId(asked);
    } catch (error) {
      return usageError(error instanceof Error ? error.message : String(error));
    }
  }

  const named = (options.get("backend") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  for (const name of named) {
    if (!isKnownBackend(name)) return usageError(`unknown backend ${JSON.stringify(name)}`);
  }
  const backendIds = named.length > 0 ? named : [...PHASE_A_BACKENDS];

  const askedHome = options.get("home");
  const home = askedHome === undefined || askedHome === "" ? homedir() : resolve(askedHome);

  const targets = await resolveTargets(backendIds, {
    home,
    cwd: process.cwd(),
    env: process.env,
    which: whichOnPath,
  });
  const worn = await wornReport(targets);

  if (options.has("json")) {
    console.log(JSON.stringify({ ...worn, home, asked: wanted ?? null }, null, 2));
  } else {
    const [headline, ...places] = formatWorn(worn);
    console.log(bold(headline!));
    console.log(dim(`read in the home at ${home}`));
    console.log();
    for (const place of places) console.log(place);
    console.log();
    if (wanted !== undefined) {
      console.log(
        wearsOnly(worn, wanted)
          ? `${wanted} is what this machine is wearing, everywhere Mind looked`
          : `${wanted} is not what this machine is wearing`,
      );
      console.log();
    }
    for (const caveat of worn.caveats) console.log(dim(`  - ${caveat}`));
  }

  // Exit 0 means one identity, intact, everywhere Mind could look — and the
  // one that was named, when one was. `mixed` is a failure on purpose: it is a
  // switch that did not finish, and a script that treated it as success would
  // be running against a machine wearing somebody else's block in one file.
  if (wanted !== undefined) return wearsOnly(worn, wanted) ? 0 : 1;
  return worn.verdict === "one" ? 0 : 1;
}
