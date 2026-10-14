/**
 * The guard as a person meets it: `mind new`, then `git commit`.
 *
 * Everything here runs real processes against a real repository under a
 * temporary `HOME`, because the properties worth checking only exist once git
 * is the one calling the hook. A unit test can prove the scanner recognises a
 * key; only this can prove that typing `git commit` is what stops.
 *
 * The last test in the first block is deliberately a *failure* of the guard:
 * `--no-verify` commits the same file the hook just refused. It is here rather
 * than in prose because a limit nobody measured is a limit nobody will believe
 * — and because if a future change ever makes that test fail, the honest note
 * in `GUARD_LIMITS` has become wrong and has to be rewritten.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCAN_RULE_COUNT } from "../../src/guard/scan.ts";
import { git, GIT_ENV } from "../support/trap-git.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SUBJECT = "example";

// Assembled at run time (D-021): the engine repository holds no string shaped
// like a live credential.
const AWS_KEY = "AK" + "IA" + "ABCDEFGHIJKLMNOP";

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

async function run(home: string, args: readonly string[], cwd = ROOT) {
  const child = Bun.spawn(["bun", "run", BIN, ...args], {
    cwd,
    env: {
      HOME: home,
      PATH: process.env["PATH"] ?? "",
      XDG_STATE_HOME: join(home, "state"),
      XDG_DATA_HOME: join(home, "data"),
      ...GIT_ENV,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  return { code: child.exitCode ?? -1, stdout, stderr };
}

/** A fresh agent, created the way a person would create one. */
async function makeAgent(home: string): Promise<string> {
  const parent = await sandbox("mind-guard-agents-");
  const result = await run(home, ["new", "example", "--subject", SUBJECT, "--dir", parent]);
  expect(result.code).toBe(0);
  return join(parent, "example");
}

const commit = (agent: string, message: string, extra: readonly string[] = []) =>
  git(agent, ["commit", "-q", ...extra, "-m", message]);

describe("a commit that carries a secret does not happen", () => {
  test("the hook blocks it, names the file and the rule, and prints neither the key nor a promise", async () => {
    const home = await sandbox("mind-guard-home-");
    const agent = await makeAgent(home);

    await writeFile(join(agent, "memory", "notes.md"), `aws_key = ${AWS_KEY}\n`);
    expect((await git(agent, ["add", "-A"])).code).toBe(0);

    const blocked = await commit(agent, "first");
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toContain("memory/notes.md:1");
    expect(blocked.stderr).toContain("aws-access-key-id");
    // The whole key never reaches a terminal. Four characters that name the
    // vendor do, which is what makes the message actionable.
    expect(blocked.stderr).not.toContain(AWS_KEY);
    expect(blocked.stderr).toContain("AKIA");
    // And nothing was committed.
    expect((await git(agent, ["rev-parse", "--verify", "--quiet", "HEAD"])).code).not.toBe(0);
  }, 30_000);

  test("it says what it cannot see, on the run where it blocked", async () => {
    const home = await sandbox("mind-guard-home-");
    const agent = await makeAgent(home);
    await writeFile(join(agent, "memory", "notes.md"), `aws_key = ${AWS_KEY}\n`);
    await git(agent, ["add", "-A"]);

    const blocked = await commit(agent, "first");
    expect(blocked.stderr).toContain("prose");
    expect(blocked.stderr).toContain("--no-verify");
    expect(blocked.stderr).toContain("vendor CLI");
  }, 30_000);

  test("the limit, measured: --no-verify commits the same file anyway", async () => {
    const home = await sandbox("mind-guard-home-");
    const agent = await makeAgent(home);
    await writeFile(join(agent, "memory", "notes.md"), `aws_key = ${AWS_KEY}\n`);
    await git(agent, ["add", "-A"]);

    expect((await commit(agent, "first")).code).not.toBe(0);
    // This is the hole `GUARD_LIMITS` describes. If this assertion ever fails,
    // that note has become wrong and has to be rewritten rather than removed.
    expect((await commit(agent, "first", ["--no-verify"])).code).toBe(0);
  }, 30_000);
});

describe("what the scan looks at", () => {
  test("the index, not the working tree — a clean file on disk does not help", async () => {
    const home = await sandbox("mind-guard-home-");
    const agent = await makeAgent(home);
    const notes = join(agent, "memory", "notes.md");

    await writeFile(notes, `aws_key = ${AWS_KEY}\n`);
    await git(agent, ["add", "-A"]);
    // Cleaned up afterwards, which is exactly the mistake: the commit keeps
    // what was staged.
    await writeFile(notes, "nothing to see\n");

    const blocked = await commit(agent, "first");
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toContain("aws-access-key-id");
  }, 30_000);

  test("AC4 — a file staged under personal/ is refused by location alone", async () => {
    const home = await sandbox("mind-guard-home-");
    const agent = await makeAgent(home);

    await Bun.write(join(agent, "personal", "diary.md"), "an ordinary sentence\n");
    await git(agent, ["add", "-A"]);

    const blocked = await commit(agent, "first");
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toContain("personal/diary.md");
    expect(blocked.stderr).toContain("personal-path");
    expect(blocked.stderr).toContain("D-014");
  }, 30_000);

  test("a clean commit goes through, and is still told what the scan cannot see", async () => {
    const home = await sandbox("mind-guard-home-");
    const agent = await makeAgent(home);

    await git(agent, ["add", "-A"]);
    const clean = await commit(agent, "first");
    expect(clean.code).toBe(0);
    expect(clean.stderr).toContain(`passed ${SCAN_RULE_COUNT} rules`);
    // The person reading "passed" is the person about to believe it is safe.
    expect(clean.stderr).toContain("prose");
    expect((await git(agent, ["rev-parse", "--verify", "--quiet", "HEAD"])).code).toBe(0);
  }, 30_000);
});

describe("when the guard itself is broken", () => {
  test("an engine the hook cannot find blocks the commit rather than passing it", async () => {
    const home = await sandbox("mind-guard-home-");
    const agent = await makeAgent(home);
    const hook = join(agent, ".git", "hooks", "pre-commit");

    const script = await readFile(hook, "utf8");
    await writeFile(hook, script.replaceAll(/'\/[^']*bun[^']*'/g, "'/nowhere/bun'"));

    await git(agent, ["add", "-A"]);
    const blocked = await commit(agent, "first");
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toContain("nothing scanned");
    expect(blocked.stderr).toContain("mind guard install");
  }, 30_000);
});

describe("mind new, and what it says about git", () => {
  test("it installs the hooks and lists them as not being in git", async () => {
    const home = await sandbox("mind-guard-home-");
    const parent = await sandbox("mind-guard-agents-");
    const created = await run(home, ["new", "example", "--subject", SUBJECT, "--dir", parent]);

    expect(created.stdout).toContain("pre-commit");
    expect(created.stdout).toContain("not in git");
    for (const name of ["pre-commit", "pre-push"]) {
      expect(await Bun.file(join(parent, "example", ".git", "hooks", name)).exists()).toBe(true);
    }
  }, 30_000);

  test("AC5 — it says what git will keep before there is anything to keep", async () => {
    const home = await sandbox("mind-guard-home-");
    const parent = await sandbox("mind-guard-agents-");
    const created = await run(home, ["new", "example", "--subject", SUBJECT, "--dir", parent]);

    expect(created.stdout).toContain("Before the first commit");
    expect(created.stdout).toContain("reflog");
    expect(created.stdout).toContain("clone");
  }, 30_000);

  test("AC1 — it says it cannot see a remote's visibility, rather than claiming private", async () => {
    const home = await sandbox("mind-guard-home-");
    const parent = await sandbox("mind-guard-agents-");
    const created = await run(home, ["new", "example", "--subject", SUBJECT, "--dir", parent]);

    expect(created.stdout).toContain("cannot see");
    for (const line of created.stdout.split("\n")) {
      if (!line.includes("private")) continue;
      expect(line.includes("cannot see") || line.includes("not tell you"), line).toBe(true);
    }
  }, 30_000);
});

describe("mind guard", () => {
  test("status reports installed hooks, the commit count and every remote", async () => {
    const home = await sandbox("mind-guard-home-");
    const agent = await makeAgent(home);
    await git(agent, ["add", "-A"]);
    await commit(agent, "first");
    await git(agent, ["remote", "add", "origin", "file:///tmp/origin.git"]);

    const status = await run(home, ["guard", "status", agent]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("pre-commit");
    expect(status.stdout).toContain("installed");
    expect(status.stdout).toContain("1 commit(s)");
    expect(status.stdout).toContain("file:///tmp/origin.git");
    expect(status.stdout).toContain("cannot see whether a remote is private");
    expect(status.stdout).toContain("What this guard does not prevent");
  }, 30_000);

  test("a clone has no hooks, status says so with exit 1, and install fixes it", async () => {
    const home = await sandbox("mind-guard-home-");
    const agent = await makeAgent(home);
    await git(agent, ["add", "-A"]);
    await commit(agent, "first");

    const elsewhere = await sandbox("mind-guard-clone-");
    const clone = join(elsewhere, "copy");
    expect((await git(elsewhere, ["clone", "-q", agent, clone])).code).toBe(0);

    const before = await run(home, ["guard", "status", clone]);
    expect(before.code).toBe(1);
    expect(before.stdout).toContain("absent");
    expect(before.stdout).toContain("mind guard install");

    expect((await run(home, ["guard", "install", clone])).code).toBe(0);
    expect((await run(home, ["guard", "status", clone])).code).toBe(0);

    // And the installed hook works in the clone, which is the point of the
    // command existing at all.
    await writeFile(join(clone, "memory", "notes.md"), `aws_key = ${AWS_KEY}\n`);
    await git(clone, ["add", "-A"]);
    expect((await commit(clone, "second")).code).not.toBe(0);
  }, 30_000);

  test("scan without --staged is a usage error, not a scan of something else", async () => {
    const home = await sandbox("mind-guard-home-");
    const agent = await makeAgent(home);

    const result = await run(home, ["guard", "scan", agent]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--staged");
  }, 30_000);

  test("an unknown subcommand names the ones that exist", async () => {
    const home = await sandbox("mind-guard-home-");
    const result = await run(home, ["guard", "enable"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("install");
  }, 30_000);

  test("help lists the guard commands", async () => {
    const home = await sandbox("mind-guard-home-");
    const result = await run(home, ["help"]);
    expect(result.stdout).toContain("mind guard install");
    expect(result.stdout).toContain("mind guard scan --staged");
    expect(result.stdout).toContain("mind guard status");
  }, 30_000);
});
