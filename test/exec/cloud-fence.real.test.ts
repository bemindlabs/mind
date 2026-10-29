/**
 * The cloud fence, tried on the real claude, codex and grok CLIs at level 2 — opt-in (D-192).
 *
 *     MIND_REAL_CLOUD_FENCE=1 bun test test/exec/cloud-fence.real.test.ts
 *
 * Skipped otherwise, and on a kernel that cannot fence. Each case spends one real turn on the owner's logged-in
 * vendor, through the production path (`CliExec`, its home of Mind's own, the fence argv, the helper, the
 * supervisor), and asks the vendor's shell to run one script in the working directory. The script writes what it
 * found to `result.txt`, and the test reads that file from the disk — not the model's account of it:
 *
 * - (a) a canary file in a fresh directory under the owner's home, outside every grant, cannot be read;
 * - (b) the working directory can be written (the result file is the proof);
 * - (c) a TCP connect to a loopback port — LiteLLM's 10400, and a listener this test opens — is refused;
 * - (d) the vendor's own API answers: the turn completes, `confirmed`.
 *
 * The canary holds a random token and nothing else; the script reports only "READ" or "denied", never the
 * content. Nothing here reads, or asks a model to read, `~/.secrets`, `~/.ssh` or any credential: the vendor's
 * login is copied into Mind's home by the code under test, and its content is never printed. Mind's state for
 * the turn is a temporary directory, so the owner's own state root is not touched.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fenceSupport } from "../../src/exec/fence.ts";
import { BUN } from "../support/bare-path.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const DRIVER = join(ROOT, "test", "exec", "support", "cloud-vendor-driver.ts");
const ENABLED = process.env["MIND_REAL_CLOUD_FENCE"] === "1";
const support = fenceSupport();
const scratch: string[] = [];

afterEach(async () => {
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true });
});

const PROMPT =
  "Run this exact shell command in the current working directory: sh probe.sh\n" +
  "Then reply with the exact contents of the file result.txt and nothing else.";

describe.skipIf(!ENABLED || !support.ok)(
  `the cloud fence on the real claude, codex and grok${ENABLED ? "" : " — skipped: set MIND_REAL_CLOUD_FENCE=1"}`,
  () => {
    for (const id of ["claude", "codex", "grok"] as const) {
      test.skipIf(Bun.which(id) === null)(
        `${id} at level 2: (a) the canary is refused, (b) the cwd is written, (c) loopback is refused, (d) the turn completes`,
        async () => {
          const canaryDir = await mkdtemp(join(homedir(), "mind-canary-"));
          const work = await mkdtemp(join(tmpdir(), "mind-real-cloud-work-"));
          const state = await mkdtemp(join(tmpdir(), "mind-real-cloud-state-"));
          scratch.push(canaryDir, work, state);
          const token = `CANARY-${crypto.randomUUID()}`;
          await writeFile(join(canaryDir, "canary.txt"), `${token}\n`);
          let touched = 0;
          const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() { touched += 1; }, data() {} } });
          await writeFile(
            join(work, "probe.sh"),
            [
              "#!/bin/sh",
              "{",
              `  if cat ${JSON.stringify(join(canaryDir, "canary.txt"))} >/dev/null 2>&1; then echo "canary=READ"; else echo "canary=denied"; fi`,
              `  if timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/10400' 2>/dev/null; then echo "litellm=CONNECTED"; else echo "litellm=refused"; fi`,
              `  if timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/${listener.port}' 2>/dev/null; then echo "loopback=CONNECTED"; else echo "loopback=refused"; fi`,
              '  echo "write=ok"',
              "} > result.txt",
              "",
            ].join("\n"),
          );
          try {
            const child = Bun.spawn([BUN, "run", DRIVER, id, state, work, "2", PROMPT], {
              cwd: ROOT,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              env: process.env,
            });
            const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
            await child.exited;
            const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
              fenced?: boolean;
              confidence?: string;
              text?: string;
              raw?: string;
              login?: string | null;
            };
            const written = await readFile(join(work, "result.txt"), "utf8").catch(() => "");
            console.log(`[${id}] fenced=${result.fenced} confidence=${result.confidence} login=${result.login ?? "unchanged"}`);
            console.log(`[${id}] result.txt: ${written.trim().split("\n").join(" | ") || "(not written)"}`);
            expect(result.fenced).toBe(true);
            // (b) the working directory was written, by the vendor's shell, inside the fence.
            expect(written).toContain("write=ok");
            // (a) the canary was refused, and its token reached neither the reply nor the vendor's output.
            expect(written).toContain("canary=denied");
            expect(`${result.text}${result.raw}`).not.toContain(token);
            // (c) loopback refused: LiteLLM's port and this test's own listener, which saw no connection.
            expect(written).toContain("litellm=refused");
            expect(written).toContain("loopback=refused");
            expect(touched).toBe(0);
            // (d) the vendor's API answered and the turn completed.
            expect(result.confidence, `${stdout}\n${stderr}`).toBe("confirmed");
          } finally {
            listener.stop(true);
          }
        },
        300_000,
      );
    }
  },
);
