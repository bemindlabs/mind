/**
 * The read fence, tried on the real claude and grok CLIs — opt-in.
 *
 *     MIND_REAL_FENCE=1 bun test test/exec/fence-reads.real.test.ts
 *
 * Skipped otherwise. It starts each CLI that is installed (claude, grok) through the production path
 * (`LocalCliExec`, the fence argv, the helper, the supervisor), pointed at a stand-in model on a loopback port
 * instead of LiteLLM, and the stand-in's one move is to ask the vendor's shell to read a canary file that no
 * grant covers, a file in the working directory, and the owner's home directory.
 *
 * What it can say that the default suite cannot: that the real binaries still start, run a tool and finish a
 * turn when reads are confined to the grants of `readGrants`. A CLI that needed a directory nobody listed would
 * fail here with "Permission denied" in its own start-up, and the stand-in would never be reached.
 *
 * Nothing leaves the machine and nothing is spent: the only network is the loopback port the fence allows. The
 * vendor's home is a temporary directory; the owner's files are not read (the home directory is only listed,
 * and the fence is expected to refuse that).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fenceSupport } from "../../src/exec/fence.ts";
import { startFakeModel } from "./support/fake-model-server.ts";
import { BUN } from "../support/bare-path.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const DRIVER = join(ROOT, "test", "exec", "support", "local-vendor-driver.ts");
const ENABLED = process.env["MIND_REAL_FENCE"] === "1";
const support = fenceSupport();
const scratch: string[] = [];

afterEach(async () => {
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true });
});

const VENDORS = [
  ["claude-local", "claude"],
  ["grok-local", "grok"],
] as const;

describe.skipIf(!ENABLED || !support.ok)(`the read fence on the real local CLIs${ENABLED ? "" : " — skipped: set MIND_REAL_FENCE=1"}`, () => {
  for (const [id, binary] of VENDORS) {
    test.skipIf(Bun.which(binary) === null)(
      `${id}: runs a shell tool in the fence; the canary and the home directory are refused, the working directory is read`,
      async () => {
        const root = await mkdtemp(join(tmpdir(), "mind-real-fence-"));
        scratch.push(root);
        await mkdir(join(root, "outside"), { recursive: true });
        const canary = join(root, "outside", "canary.txt");
        await writeFile(canary, "CANARY: nothing may read this");
        const model = startFakeModel(
          `cat ${canary}; echo; cat ${join(root, "work", "hello.txt")}; ls ${homedir()} 2>&1 | head -3`,
        );
        try {
          const child = Bun.spawn([BUN, "run", DRIVER, id, root, String(model.port), "2"], {
            cwd: ROOT,
            stdout: "pipe",
            stderr: "pipe",
            stdin: "ignore",
            env: process.env,
          });
          const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
          await child.exited;
          const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { confidence?: string; text?: string; raw?: string };
          expect(result.confidence, `${stdout}\n${stderr}`).toBe("confirmed");
          const seen = model.toolResults().join("\n");
          expect(seen, "the shell tool never reported").not.toBe("");
          expect(seen).not.toContain("CANARY");
          expect(seen).toContain("Permission denied");
          expect(seen).toContain("hello from the workdir");
          expect(seen).not.toMatch(/\.bashrc|\.ssh|\.secrets/);
        } finally {
          model.stop();
        }
      },
      180_000,
    );
  }
});
