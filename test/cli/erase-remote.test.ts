/**
 * `mind erase --remote` as a process (S13.5 AC2, step 1): a dry run prints where the remote half
 * would look, a bad target stops everything, and `--yes` refuses rather than erase only the local half.
 * No ssh anywhere: step 1 has no code path that sends.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUN } from "../support/bare-path.ts";
import { sshTarget } from "../support/synthetic-agent.ts";

const BIN = join(import.meta.dir, "..", "..", "bin", "mind.ts");
const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-erase-remote-"));
  scratch.push(dir);
  return dir;
}

async function run(home: string, args: readonly string[]) {
  const child = Bun.spawn([BUN, "run", BIN, ...args], {
    cwd: home,
    env: {
      HOME: home,
      PATH: `${dirname(BUN)}:${process.env["PATH"] ?? ""}`,
      XDG_STATE_HOME: join(home, "state"),
      XDG_DATA_HOME: join(home, "data"),
      MIND_QDRANT_URL: "http://127.0.0.1:9",
      USER: "the-test",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  return { code: child.exitCode ?? -1, stdout, stderr };
}

const BASE = ["erase", "demo", "--no-agent", "--by", "the owner"];

describe("erase --remote", () => {
  test("a dry run prints the remote half under the local plan, and changes nothing", async () => {
    const home = await sandbox();
    const target = join(home, "target.json");
    await writeFile(target, sshTarget());
    const result = await run(home, [...BASE, "--remote", target]);
    expect(result.stdout + result.stderr).toContain("remote — vps-1 — ssh deploy@203.0.113.10:22");
    expect(result.stdout).toContain("/agents/demo");
    expect(result.stdout).toContain("Nothing on the remote has been looked at or changed");
    expect((await readdir(home)).filter((name) => name !== ".bun")).toEqual(["target.json"]);
  }, 60_000);

  test("with --json the remote half goes to stderr and stdout stays the document", async () => {
    const home = await sandbox();
    const target = join(home, "target.json");
    await writeFile(target, sshTarget());
    const result = await run(home, [...BASE, "--remote", target, "--json"]);
    expect(result.stderr).toContain("remote — vps-1");
    expect(result.stdout).not.toContain("remote — vps-1");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  }, 60_000);

  test("an unreadable or invalid target stops before anything is planned", async () => {
    const home = await sandbox();
    const missing = await run(home, [...BASE, "--remote", join(home, "nope.json")]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("cannot read the target file");

    const bad = join(home, "bad.json");
    await writeFile(bad, "{ not json");
    const invalid = await run(home, [...BASE, "--remote", bad]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("bad.json");
    expect(invalid.stderr).toContain("Nothing was looked at or deleted.");
  }, 60_000);

  test("--yes refuses before deleting anything, local included", async () => {
    const home = await sandbox();
    const target = join(home, "target.json");
    await writeFile(target, sshTarget());
    const result = await run(home, [...BASE, "--remote", target, "--yes"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--remote with --yes cannot run yet");
    expect(result.stderr).toContain("Nothing was deleted");
    expect(result.stdout).not.toContain("certificate");
  }, 60_000);
});
