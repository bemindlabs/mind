/**
 * `mind backends` end to end. It had no test of its own, and 0.8.0 shipped it crashing on the first local
 * backend (`unknown vendor "claude-local"`): the table asked the vendor registry about every backend, and the
 * local ones (E12) are not vendors — they run one. Reported by agent-fern on 0.8.1, 2026-09-27.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allBackends } from "../../src/exec/index.ts";
import { localBaseVendor } from "../../src/exec/local-cli.ts";
import { BUN } from "../support/bare-path.ts";

const BIN = join(import.meta.dir, "..", "..", "bin", "mind.ts");
const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("mind backends", () => {
  test("prints a row for every backend, local ones included, and exits 0", async () => {
    const home = await mkdtemp(join(tmpdir(), "mind-backends-"));
    scratch.push(home);
    const child = Bun.spawn([BUN, "run", BIN, "backends"], {
      cwd: home,
      env: { HOME: home, PATH: process.env["PATH"] ?? "", XDG_STATE_HOME: join(home, "state"), XDG_DATA_HOME: join(home, "data") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = [await new Response(child.stdout).text(), await new Response(child.stderr).text()];
    await child.exited;
    expect(err).not.toContain("unknown vendor");
    expect(child.exitCode, err).toBe(0);
    for (const b of allBackends()) expect(out).toContain(`${b.id.padEnd(12)} `);
    expect(out).toContain("claude's file, in a home of its own under the state root — not yours");
    expect(out).toContain("grok's file, in a home of its own under the state root — not yours");
  }, 30_000);

  test("a local backend runs its vendor's CLI", () => {
    expect(localBaseVendor("claude-local")).toBe("claude");
    expect(localBaseVendor("grok-local")).toBe("grok");
  });
});
