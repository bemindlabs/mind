/**
 * The entry point of a child process that runs one real local-CLI turn through the production path.
 *
 * `LocalCliExec` builds the fence and re-enters the engine as `<runtime> run <entry> __fence …`, where the entry is
 * whatever file the process was started from. In a test that is this file, so it answers the two hidden commands
 * the real entry (`bin/mind.ts`) answers and otherwise runs the turn. Used by `test/exec/fence-reads.real.test.ts`
 * and nothing else.
 *
 *     bun run test/exec/support/local-vendor-driver.ts <claude-local|grok-local> <root> <port> <level>
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runFenceHelper, runFenceSupervisor } from "../../../src/exec/fence.ts";
import { LocalCliExec, type LocalCliId } from "../../../src/exec/local-cli.ts";
import { subjectId } from "../../../src/types.ts";
import { atLevel } from "../../support/restraint.ts";

const [first, ...rest] = process.argv.slice(2);
if (first === "__fence-supervisor") process.exit(runFenceSupervisor(rest));
if (first === "__fence") process.exit(runFenceHelper(rest));

const [root = "", portText = "", levelText = "2"] = rest;
const id = first as LocalCliId;
const home = join(root, "home");
const work = join(root, "work");
const keyFile = join(home, ".secrets", ".env.mind-litellm");
for (const dir of [join(home, ".secrets"), work, join(home, "state")]) await mkdir(dir, { recursive: true });
await writeFile(keyFile, "LITELLM_API_KEY=synthetic-virtual-key\n");
await writeFile(join(work, "hello.txt"), "hello from the workdir\n");

const exec = new LocalCliExec(id, {
  home,
  env: { XDG_STATE_HOME: join(home, "state"), PATH: process.env["PATH"], USER: "fixture", MIND_LITELLM_KEY_FILE: keyFile },
  baseUrl: `http://127.0.0.1:${portText}`,
  cwd: () => work,
});
const result = await exec.run({
  prompt: "do the thing",
  subject: subjectId("example"),
  restraint: atLevel(Number(levelText) as 1 | 2),
  cwd: work,
  timeoutMs: 120_000,
});
console.log(JSON.stringify({ backend: result.backend, confidence: result.confidence, text: result.text, raw: String(result.evidence.raw).slice(0, 600) }));
