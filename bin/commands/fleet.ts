/** `mind fleet check <file>` — read a fleet roster and say whether it loads. Starts nothing, sends nothing. */

import { readFile } from "node:fs/promises";
import { stat, realpath } from "node:fs/promises";
import { parseRoster } from "../../src/fleet/roster.ts";
import { CATEGORIES, confirmationsPath, readConfirmations, type Dial } from "../../src/decide/index.ts";
import { subjectId } from "../../src/types.ts";
import { dialEnv, readDial, whoIsSetting, writeDial } from "../dial.ts";
import { usageError } from "../shared.ts";

const USAGE = "usage: mind fleet check <fleet.toml>";
const DIAL_USAGE = "usage: mind fleet dial <fleet.toml> --profile <worktree|read-only> [--only <bot>] [--dry-run]";

const PROFILES: Readonly<Record<string, { readonly description: string; readonly dial: Pick<Dial, "read" | "write" | "run" | "reach" | "operate"> }>> = {
  worktree: { description: "Read, write and run in the task worktree at level 3; reach remains capped.", dial: { read: 3, write: 3, run: 3, reach: 2, operate: 0 } },
  "read-only": { description: "Read and propose without writing or running commands.", dial: { read: 1, write: 1, run: 1, reach: 1, operate: 0 } },
};

export async function cmdFleet(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "check":
      return check(rest);
    case "dial":
      return dial(rest);
    default:
      return usageError(USAGE);
  }
}

async function dial(argv: readonly string[]): Promise<number> {
  const file = argv[0];
  if (!file || file.startsWith("-")) return usageError(DIAL_USAGE);
  let profileName: string | undefined;
  let only: string | undefined;
  let dryRun = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run" && !dryRun) dryRun = true;
    else if (arg === "--profile" && profileName === undefined && argv[i + 1] && !argv[i + 1]?.startsWith("-")) profileName = argv[++i];
    else if (arg === "--only" && only === undefined && argv[i + 1] && !argv[i + 1]?.startsWith("-")) only = argv[++i];
    else return usageError(DIAL_USAGE);
  }
  const profile = profileName === undefined ? undefined : Object.hasOwn(PROFILES, profileName) ? PROFILES[profileName] : undefined;
  if (profile === undefined) return usageError(`unknown or missing profile ${JSON.stringify(profileName)}. ${DIAL_USAGE}`);
  let text: string;
  try { text = await readFile(file, "utf8"); } catch { return usageError(`cannot read ${file}`); }
  const roster = parseRoster(text);
  if (!roster.ok) return usageError(`${file} does not load: ${roster.problems.join("; ")}`);
  const bots = only === undefined ? roster.bots : roster.bots.filter((bot) => bot.id === only);
  if (bots.length === 0) return usageError(`unknown bot ${JSON.stringify(only)}`);
  const plans: { id: string; dir: string; before: Dial; after: Dial }[] = [];
  const dirs = new Set<string>();
  for (const bot of bots) {
    if (bot.dir === undefined) return usageError(`${bot.id}: roster needs an agent dir`);
    if (profileName === "worktree" && bot.scope !== "worktree") return usageError(`${bot.id}: worktree profile requires scope = "worktree"`);
    let dir: string;
    try {
      dir = await realpath(bot.dir);
      if (!(await stat(dir)).isDirectory()) throw new Error();
    } catch { return usageError(`${bot.id}: agent directory is not readable: ${bot.dir}`); }
    if (dirs.has(dir)) return usageError(`${bot.id}: agent directory is shared by another selected bot`);
    dirs.add(dir);
    const before = await readDial(bot.dir);
    if (before.source === "file-unreadable") return usageError(`${bot.id}: autonomy.md is unreadable; nothing written`);
    const confirmations = await readConfirmations(confirmationsPath(dialEnv(), bot.dir, subjectId(bot.subject)));
    for (const category of CATEGORIES) {
      if (confirmations[category] !== undefined && before.stored[category] !== profile.dial[category] && (before.stored[category] === 3 || profile.dial[category] === 3)) {
        return usageError(`${bot.id}: ${category} has a level-3 confirmation; change it with mind autonomy set first`);
      }
    }
    plans.push({ id: bot.id, dir: bot.dir, before: before.stored, after: { ...profile.dial, setBy: null, setAt: null } });
  }
  const levels = (dial: Dial) => CATEGORIES.map((category) => `${category}=${dial[category]}`).join(" ");
  for (const plan of plans) {
    if (!dryRun) await writeDial(plan.dir, { ...plan.after, setBy: await whoIsSetting(plan.dir), setAt: new Date().toISOString() });
    console.log(`${plan.id}: ${levels(plan.before)} -> ${levels(plan.after)}${dryRun ? " (dry run)" : ""}; level 3 requires existing per-category confirmation, and reach is capped at 2`);
  }
  return 0;
}

async function check(argv: readonly string[]): Promise<number> {
  const [file] = argv;
  if (file === undefined || file === "" || argv.length > 1) return usageError(USAGE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return usageError(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const roster = parseRoster(text);
  if (!roster.ok) {
    console.error(`mind: ${file} does not load (${roster.problems.length} problem${roster.problems.length === 1 ? "" : "s"}):`);
    for (const problem of roster.problems) console.error(`  - ${problem}`);
    console.error("Nothing was started.");
    return 2;
  }
  console.log(`${file} loads: ${roster.bots.length} bot(s), flat, cloud only.`);
  for (const bot of roster.bots) {
    const spares = bot.spares.length === 0 ? "no spare" : `then ${bot.spares.join(", ")}`;
    console.log(`  ${bot.id}  as ${bot.subject}  ${bot.home} (${spares})  scope ${bot.scope}`);
  }
  console.log("This checks the file only. Nothing was started, and `scope` is read here, not yet enforced (S22.8).");
  return 0;
}
