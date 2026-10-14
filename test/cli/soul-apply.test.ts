/**
 * The command as a person types it.
 *
 * These spawn the real entry point with a temporary `HOME`, because the things
 * being checked are properties of the command line itself and cannot be seen
 * from inside a function: that a bare run writes nothing (AC2), that `--apply`
 * does not eat the directory argument that follows it, and that the exit code
 * distinguishes "you typed it wrong" from "Mind refused something".
 *
 * `HOME` is a temporary directory in every case. There is no invocation here
 * that could reach the real one.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const FIXTURES = join(ROOT, "test", "fixtures");
const SOUL = join(FIXTURES, "soul-valid");
const SOUL_B = join(FIXTURES, "soul-valid-b");
const HUMAN = join(FIXTURES, "instructions", "human-200.md");

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "mind-cli-"));
  homes.push(home);
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(join(home, ".claude", "CLAUDE.md"), await readFile(HUMAN, "utf8"));
  // `soul apply` writes only for CLIs it finds on PATH. These stand in for them,
  // so the tests do not depend on what the machine running them has installed
  // (CI has none; the machine this was written on has all of them).
  await mkdir(join(home, "bin"), { recursive: true });
  for (const cli of ["claude", "codex"]) {
    await writeFile(join(home, "bin", cli), "#!/bin/sh\necho 0.0.0-stub\n", { mode: 0o755 });
  }
  return home;
}

async function run(home: string, args: readonly string[]) {
  const child = Bun.spawn(["bun", "run", BIN, ...args], {
    cwd: ROOT,
    env: {
      HOME: home,
      PATH: `${join(home, "bin")}:${process.env["PATH"] ?? ""}`,
      // Keep the backup tree inside the temporary home, and keep CODEX_HOME
      // from leaking in from whatever shell ran the tests.
      XDG_STATE_HOME: join(home, "state"),
      CODEX_HOME: join(home, ".codex"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  return { code: child.exitCode ?? -1, stdout, stderr };
}

const claudeMd = (home: string) => join(home, ".claude", "CLAUDE.md");

/** `Bun.file().exists()` answers false for a directory, so ask the filesystem. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("mind soul apply", () => {
  test("AC2 — a bare run prints a diff and writes nothing", async () => {
    const home = await makeHome();
    const before = await readFile(claudeMd(home), "utf8");

    const result = await run(home, ["soul", "apply", SOUL, "--subject", "example"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("dry run");
    expect(result.stdout).toContain("@@");
    expect(result.stdout).toContain("Nothing was written");

    expect(await readFile(claudeMd(home), "utf8")).toBe(before);
    expect(await exists(join(home, "state"))).toBe(false);
  });

  test("--apply writes, backs up, and prints how to undo it", async () => {
    const home = await makeHome();
    const before = await readFile(claudeMd(home), "utf8");

    const result = await run(home, ["soul", "apply", SOUL, "--subject", "example", "--apply"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("wrote");
    expect(result.stdout).toMatch(/cp .*CLAUDE\.md/);

    const after = await readFile(claudeMd(home), "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain("Example Keeper");
  });

  test("--apply before the directory does not swallow it", async () => {
    const home = await makeHome();
    const result = await run(home, ["soul", "apply", "--apply", SOUL, "--subject", "example"]);

    expect(result.code).toBe(0);
    expect(await readFile(claudeMd(home), "utf8")).toContain("Example Keeper");
  });

  test("--apply together with --dry-run is a usage error, and writes nothing", async () => {
    const home = await makeHome();
    const before = await readFile(claudeMd(home), "utf8");

    const result = await run(home, [
      "soul", "apply", SOUL, "--subject", "example", "--apply", "--dry-run",
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("contradict");
    expect(await readFile(claudeMd(home), "utf8")).toBe(before);
  });

  test("a missing subject is a usage error", async () => {
    const home = await makeHome();
    expect((await run(home, ["soul", "apply", SOUL])).code).toBe(2);
  });

  test("an unknown backend is a usage error, not a silent skip", async () => {
    const home = await makeHome();
    const result = await run(home, [
      "soul", "apply", SOUL, "--subject", "example", "--backend", "nonesuch",
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("nonesuch");
  });

  test("a soul that does not belong to the subject is reported, not applied", async () => {
    const home = await makeHome();
    const before = await readFile(claudeMd(home), "utf8");

    const result = await run(home, ["soul", "apply", SOUL, "--subject", "someone-else", "--apply"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("example");
    expect(await readFile(claudeMd(home), "utf8")).toBe(before);
  });

  test("AC5 — switching subject leaves nothing of the first identity", async () => {
    const home = await makeHome();
    const human = await readFile(claudeMd(home), "utf8");

    await run(home, ["soul", "apply", SOUL, "--subject", "example", "--apply"]);
    expect(await readFile(claudeMd(home), "utf8")).toContain("Example Keeper");

    const second = await run(home, [
      "soul", "apply", SOUL_B, "--subject", "other-example", "--apply",
    ]);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("replaces the block of subject example");

    const after = await readFile(claudeMd(home), "utf8");
    expect(after).not.toContain("Example Keeper");
    expect(after).toContain("Second Keeper");
    expect(after.startsWith(human)).toBe(true);
  });

  test("the help text no longer lists apply as unbuilt", async () => {
    const home = await makeHome();
    const result = await run(home, ["help"]);
    expect(result.stdout).toContain("mind soul apply");
    expect(result.stdout).not.toMatch(/soul apply.*\[S1\.2\]/);
  });
});
