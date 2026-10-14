/**
 * S6.4 AC4 (D-062): the gates run on every push, and a release cannot pass
 * without the identity firewall judged against a real model.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

describe("CI", () => {
  test("every push and pull request runs typecheck, the tests and the coverage gate on the pinned bun", async () => {
    const ci = await Bun.file(join(ROOT, ".github", "workflows", "ci.yml")).text();
    const pinned = ((await Bun.file(join(ROOT, "package.json")).json()) as { engines: { bun: string } }).engines.bun;
    expect(ci).toContain("push:");
    expect(ci).toContain("pull_request:");
    for (const step of ["bun install --frozen-lockfile", "bun run typecheck", "bun test", "bun run coverage"]) {
      expect(ci, step).toContain(`- run: ${step}`);
    }
    expect(ci).toMatch(/bun-version: 1\.4\.\d+/);
    expect(pinned).toBe(">=1.4.0");
    expect(ci).toContain("contents: read");
    expect(ci).toContain("fetch-depth: 0");
  });
});

describe("release:check", () => {
  test("it runs the gates and the firewall's real-model test, and refuses to pass without a model", async () => {
    const script = ((await Bun.file(join(ROOT, "package.json")).json()) as { scripts: Record<string, string> }).scripts["release:check"]!;
    expect(script).toContain('test -n "$MIND_RELEASE_MODEL"');
    expect(script).toContain("MIND_REAL_FIREWALL=1");
    expect(script).toContain("test/soul/firewall.real.test.ts");
    const child = Bun.spawn(["bun", "run", "release:check"], {
      cwd: ROOT,
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    await child.exited;
    expect(child.exitCode).not.toBe(0);
    expect(stderr).toContain("does not ship");
  }, 60_000);
});
