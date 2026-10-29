/**
 * The entry point of a child process that runs one real cloud turn through the production path (D-192).
 *
 * `CliExec` fences a cloud turn and re-enters the engine as `<runtime> run <entry> __fence …`, where the entry is
 * whatever file the process was started from. In a test that is this file, so it answers the two hidden commands
 * the real entry (`bin/mind.ts`) answers and otherwise runs the turn. Used by `test/exec/cloud-fence.real.test.ts`
 * and nothing else.
 *
 *     bun run test/exec/support/cloud-vendor-driver.ts <claude|codex> <state-dir> <work-dir> <level> <prompt>
 *
 * The owner's real home is where the vendor's credential is copied from (that is what is being tested); Mind's
 * state — and with it the vendor's home of Mind's own — is `<state-dir>`, never the owner's.
 */

import { homedir } from "node:os";
import { runFenceHelper, runFenceSupervisor } from "../../../src/exec/fence.ts";
import { CliExec } from "../../../src/exec/cli-exec.ts";
import { vendor } from "../../../src/exec/registry.ts";
import { subjectId } from "../../../src/types.ts";
import { atLevel } from "../../support/restraint.ts";

const [first, ...rest] = process.argv.slice(2);
if (first === "__fence-supervisor") process.exit(runFenceSupervisor(rest));
if (first === "__fence") process.exit(runFenceHelper(rest));

const [state = "", work = "", levelText = "2", prompt = ""] = rest;
const exec = new CliExec(vendor(first ?? ""), undefined, {
  cloud: { home: homedir(), env: { ...process.env, XDG_STATE_HOME: state } },
});
const request = {
  prompt,
  subject: subjectId("example"),
  restraint: atLevel(Number(levelText) as 1 | 2),
  cwd: work,
  timeoutMs: 240_000,
};
const fenced = exec.appliesFence(request);
const result = await exec.run(request);
console.log(
  JSON.stringify({
    backend: result.backend,
    fenced,
    confidence: result.confidence,
    exitCode: result.evidence.exitCode ?? null,
    text: result.text.slice(0, 2000),
    raw: String(result.evidence.raw).slice(0, 2000),
    unfenced: result.unfenced ?? null,
    login: result.login ?? null,
  }),
);
