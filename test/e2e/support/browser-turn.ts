/**
 * One claude-local turn handed a task's browser, run as its own process for
 * `test/e2e/browser.e2e.ts`.
 *
 * Why a process of its own: D-118's fence re-enters *the running engine* as
 * its hidden helper (`<bun> run <Bun.main> __fence …`, src/exec/fence.ts). Under
 * `bun test`, `Bun.main` is the test file, which cannot be re-entered. So this
 * file is the main, and it answers the two hidden verbs exactly as
 * the CLI entry file does before doing anything else — the fence that runs is the
 * engine's own code, not a copy.
 *
 * Input: one JSON argument {home, env, port, token, dir, prompt, timeoutMs, subject}. Output:
 * the TurnResult as JSON on stdout.
 */

import { runFenceHelper, runFenceSupervisor } from "../../../src/exec/fence.ts";
import { LocalCliExec } from "../../../src/exec/local-cli.ts";
import { refusal } from "../../../src/spawn.ts";
import { subjectId } from "../../../src/types.ts";
import { operating } from "../../support/restraint.ts";

const argv = Bun.argv.slice(2);
if (argv[0] === "__fence-supervisor") process.exit(await runFenceSupervisor(argv.slice(1)));
if (argv[0] === "__fence") {
  const no = refusal(argv);
  if (no !== undefined) {
    console.error(`browser-turn fence: refused to run: ${no}`);
    process.exit(126);
  }
  process.exit(await runFenceHelper(argv.slice(1)));
}

const input = JSON.parse(argv[0] ?? "{}") as {
  home: string;
  env: Record<string, string>;
  port: number;
  token: string;
  operate: 1 | 2;
  dir: string;
  prompt: string;
  timeoutMs: number;
  subject: string;
};
const backend = new LocalCliExec("claude-local", { home: input.home, env: input.env, cwd: () => input.home });
const result = await backend.run({
  subject: subjectId(input.subject),
  prompt: input.prompt,
  // operate 1: look and propose (D-153) — the look tools only.
  restraint: operating(1),
  browser: { port: input.port, token: input.token, operate: input.operate, dir: input.dir },
  timeoutMs: input.timeoutMs,
});
console.log(JSON.stringify(result));
