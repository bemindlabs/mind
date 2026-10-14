/**
 * `mind deploy` — S13.1: the plan, and nothing else yet (E13, D-100).
 *
 * `plan` reads a target file and this machine's data map and prints what a
 * deploy would do. `apply`, `status`, `update` and `destroy` are named and
 * refused with exit 2, so a person who guesses them hears which story owes
 * them instead of an unknown-command page. They are handled in `default`
 * rather than as `case`s on purpose: `test/cli/usage-dispatch.test.ts` reads
 * the `case` labels as the commands that exist.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { planDeploy } from "../../src/deploy/plan.ts";
import { renderPlan } from "../../src/deploy/render.ts";
import { formatProblem, parseTarget } from "../../src/deploy/target.ts";
import { loadSoul } from "../../src/soul/load.ts";
import { subjectId, type SubjectId } from "../../src/types.ts";
import { VERSION } from "../../src/version.ts";
import { OUT, parseArgs, report, usageError } from "../shared.ts";

const PLAN_USAGE = "usage: mind deploy plan <agent-dir> --subject <id> --target <file> [--json]";

/** What is named and not built, and the story that owes it. */
const NOT_BUILT: ReadonlyMap<string, string> = new Map([
  ["apply", "S13.2–S13.4"],
  ["status", "S13.5"],
  ["update", "S13.5"],
  ["destroy", "S13.5"],
]);

async function cmdPlan(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, ["json"]);
  const dir = positional[0];
  const rawSubject = options.get("subject");
  const targetFile = options.get("target");
  if (dir === undefined || positional.length > 1 || rawSubject === undefined || rawSubject === "" || targetFile === undefined || targetFile === "") {
    return usageError(PLAN_USAGE);
  }
  let subject: SubjectId;
  try {
    subject = subjectId(rawSubject);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }

  const agentDir = resolve(dir);
  if (!(await stat(agentDir).catch(() => undefined))?.isDirectory()) {
    console.error(`mind: ${agentDir} is not a directory — deploy plan takes the agent's repository`);
    return 1;
  }

  const text = await Bun.file(resolve(targetFile)).text().catch(() => undefined);
  if (text === undefined) {
    console.error(`mind: cannot read the target file ${resolve(targetFile)}`);
    return 1;
  }
  const parsed = parseTarget(text, targetFile);
  if (!parsed.ok) {
    for (const problem of parsed.problems) console.error(`${targetFile}: ${formatProblem(problem)}`);
    console.error(`\n${parsed.problems.length} problem${parsed.problems.length === 1 ? "" : "s"} — nothing was planned.`);
    return 1;
  }

  // The subject is a claim, checked against the soul in the repository (I-3):
  // a plan for the wrong identity would move somebody else's data.
  const soul = await loadSoul(agentDir, subject);
  if (!soul.ok) return report(soul.issues);

  const plan = await planDeploy({
    target: parsed.target,
    defaulted: parsed.defaulted,
    agentDir,
    subject,
    engine: VERSION,
    local: { home: homedir(), env: process.env },
    now: () => new Date(),
  });

  if (options.has("json")) OUT.line(JSON.stringify(plan, null, 2));
  else for (const line of renderPlan(plan)) OUT.line(line);
  return plan.refusals.length > 0 ? 1 : 0;
}

export async function cmdDeploy(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "plan":
      return cmdPlan(rest);
    default: {
      const story = sub === undefined ? undefined : NOT_BUILT.get(sub);
      if (story !== undefined) {
        console.error(
          `mind deploy ${sub}: not built yet (${story}). \`mind deploy plan\` shows what it would do, ` +
            "and does none of it.",
        );
        return 2;
      }
      return usageError(
        `unknown deploy subcommand ${JSON.stringify(sub ?? "")} — "plan" is built; apply, status, update ` +
          "and destroy are not yet (S13.2–S13.5)",
      );
    }
  }
}
