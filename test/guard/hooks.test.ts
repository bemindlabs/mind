/**
 * The hooks: the text, the install, and the one property that is easy to lose.
 *
 * **Fail closed.** A hook that cannot find the engine blocks the commit. The
 * temptation is to warn and continue — the hook is, after all, only a
 * convenience — but the run where the guard is broken is exactly the run where
 * nothing scanned what was staged, and "nothing scanned it" must never look
 * like "it passed". That behaviour is checked here by running the generated
 * script under `sh` with a path that does not exist, rather than by reading it.
 *
 * The scripts are also checked for being valid shell (`sh -n`), because they
 * are generated from constants that people will edit, and a syntax error in a
 * pre-commit hook is a repository nobody can commit to.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  engineCommand,
  HOOK_MARKER,
  HOOK_NAMES,
  hookCommand,
  hookScript,
  hookStatus,
  hooksDir,
  installHooks,
  preCommitScript,
  prePushScript,
  shellQuote,
  type EngineCommand,
} from "../../src/guard/hooks.ts";
import { git, GIT_ENV } from "../support/trap-git.ts";

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-hooks-"));
  scratch.push(dir);
  return dir;
}

async function repo(): Promise<string> {
  const parent = await sandbox();
  const path = join(parent, "agent");
  expect((await git(parent, ["init", "-q", path])).code).toBe(0);
  return path;
}

/** Run a generated hook under `sh`, the way git would. */
async function runHook(
  script: string,
  options: { cwd: string; argv?: readonly string[]; env?: Record<string, string> },
): Promise<{ code: number; stderr: string }> {
  const path = join(await sandbox(), "hook.sh");
  await writeFile(path, script);
  await chmod(path, 0o700);
  const child = Bun.spawn([path, ...(options.argv ?? [])], {
    cwd: options.cwd,
    env: { PATH: process.env["PATH"] ?? "", ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  return { code: child.exitCode ?? -1, stderr };
}

/** `sh -n`: parse the script without running any of it. */
async function shellParses(script: string): Promise<boolean> {
  const path = join(await sandbox(), "parse.sh");
  await writeFile(path, script);
  const child = Bun.spawn(["sh", "-n", path], { stdout: "pipe", stderr: "pipe" });
  await child.exited;
  return child.exitCode === 0;
}

const FAKE: EngineCommand = {
  argv: ["/opt/bun", "run", "/engine/bin/mind.ts"],
  paths: ["/opt/bun", "/engine/bin/mind.ts"],
};

describe("how a hook starts the engine", () => {
  test("a checkout runs the entry point; a compiled binary runs itself", () => {
    expect(hookCommand("/opt/bun", "/engine/bin/mind.ts", () => true)).toEqual({
      argv: ["/opt/bun", "run", "/engine/bin/mind.ts"],
      paths: ["/opt/bun", "/engine/bin/mind.ts"],
    });
    // A compiled binary's entry point also ends in `.ts` and is inside the
    // executable, where no shell can reach it — hence the existence check.
    expect(hookCommand("/usr/local/bin/mind", "/$bunfs/root/bin/mind.ts", () => false)).toEqual({
      argv: ["/usr/local/bin/mind"],
      paths: ["/usr/local/bin/mind"],
    });
    expect(hookCommand("/usr/local/bin/mind", "/usr/local/bin/mind", () => true)).toEqual({
      argv: ["/usr/local/bin/mind"],
      paths: ["/usr/local/bin/mind"],
    });
    // A relative main is not a path a hook can use from another directory.
    expect(hookCommand("/opt/bun", "bin/mind.ts", () => true).argv).toEqual(["/opt/bun"]);
  });

  test("the engine running this test can name itself, absolutely", () => {
    const command = engineCommand();
    expect(command.paths.length).toBeGreaterThan(0);
    for (const path of command.paths) expect(path.startsWith("/")).toBe(true);
    expect(command.argv[0]).toBe(command.paths[0]);
  });

  test("a path with a quote in it survives being put into a shell script", async () => {
    expect(shellQuote("/tmp/it's here/bun")).toBe(`'/tmp/it'\\''s here/bun'`);
    const script = preCommitScript({
      argv: ["/tmp/it's here/bun"],
      paths: ["/tmp/it's here/bun"],
    });
    expect(await shellParses(script)).toBe(true);
  });
});

describe("the pre-commit hook", () => {
  test("it is valid shell, marked as Mind's, and runs the scan on the index", async () => {
    const script = preCommitScript(FAKE);
    expect(await shellParses(script)).toBe(true);
    expect(script).toContain(HOOK_MARKER);
    expect(script).toContain("guard scan --staged .");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
  });

  test("a missing engine blocks the commit and says how to fix it", async () => {
    const script = preCommitScript({
      argv: ["/nowhere/bun", "run", "/nowhere/mind.ts"],
      paths: ["/nowhere/bun", "/nowhere/mind.ts"],
    });
    const result = await runHook(script, { cwd: await sandbox() });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("/nowhere/bun");
    expect(result.stderr).toContain("nothing scanned");
    expect(result.stderr).toContain("mind guard install");
  });
});

describe("the pre-push hook", () => {
  test("it refuses a push happening underneath Mind", async () => {
    const result = await runHook(prePushScript(), {
      cwd: await sandbox(),
      argv: ["origin", "file:///tmp/nowhere.git"],
      env: { MIND_SUBJECT: "example" },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("refusing a push");
    expect(result.stderr).toContain("D-013");
    // The limits are printed on the refusal too: somebody who hits this has to
    // learn from the same message that `--no-verify` exists.
    expect(result.stderr).toContain("--no-verify");
    expect(result.stderr).toContain("MIND_SUBJECT=example");
  });

  test("a human's push is informed and allowed, and Mind does not claim to see", async () => {
    const result = await runHook(prePushScript(), {
      cwd: await sandbox(),
      argv: ["origin", "file:///tmp/nowhere.git"],
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("origin");
    expect(result.stderr).toContain("file:///tmp/nowhere.git");
    expect(result.stderr).toContain("cannot see whether that remote is private");
    // AC1, as far as it can honestly go: the word `private` never appears in a
    // line that is not also saying Mind cannot check it.
    for (const line of result.stderr.split("\n")) {
      if (!line.includes("private")) continue;
      expect(line.includes("cannot see") || line.includes("not tell you"), line).toBe(true);
    }
    // AC5, at the moment it is most relevant.
    expect(result.stderr).toContain("reflog");
    expect(result.stderr).toContain("clone");
  });

  test("it is valid shell even with no arguments at all", async () => {
    expect(await shellParses(prePushScript())).toBe(true);
    const result = await runHook(prePushScript(), { cwd: await sandbox() });
    expect(result.code).toBe(0);
  });
});

describe("installing into a repository", () => {
  test("both hooks land, executable, and `status` sees them", async () => {
    const agent = await repo();
    const outcome = await installHooks(agent, FAKE);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.written).toHaveLength(HOOK_NAMES.length);

    const dir = await hooksDir(agent);
    expect(dir).toBe(join(agent, ".git", "hooks"));
    for (const name of HOOK_NAMES) {
      const path = join(dir, name);
      expect((await stat(path)).mode & 0o777).toBe(0o700);
      expect(await Bun.file(path).text()).toContain(HOOK_MARKER);
    }

    expect((await hookStatus(agent)).map((hook) => hook.state)).toEqual(
      HOOK_NAMES.map(() => "installed"),
    );
  });

  test("installing twice is how you fix a moved engine, not an error", async () => {
    const agent = await repo();
    await installHooks(agent, FAKE);
    const again = await installHooks(agent, {
      argv: ["/elsewhere/mind"],
      paths: ["/elsewhere/mind"],
    });

    expect(again.ok).toBe(true);
    const script = await Bun.file(join(agent, ".git", "hooks", "pre-commit")).text();
    expect(script).toContain("/elsewhere/mind");
    expect(script).not.toContain("/opt/bun");
  });

  test("somebody else's hook is never overwritten, and nothing else is written either", async () => {
    const agent = await repo();
    const mine = join(agent, ".git", "hooks", "pre-commit");
    await writeFile(mine, "#!/bin/sh\n# a formatter somebody set up\nexit 0\n");

    const outcome = await installHooks(agent, FAKE);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain(mine);
    expect(await Bun.file(mine).text()).toContain("a formatter somebody set up");
    // The other hook is not written either: a half-installed guard is worse
    // than none, because `status` would then report one of each.
    expect(await Bun.file(join(agent, ".git", "hooks", "pre-push")).exists()).toBe(false);

    const status = await hookStatus(agent);
    expect(status.map((hook) => hook.state)).toEqual(["foreign", "absent"]);
  });

  test("a directory that is not a repository is refused with the reason", async () => {
    const outcome = await installHooks(await sandbox(), FAKE);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("does not look like a git repository");
  });

  test("the hooks directory is asked of git, not assumed", async () => {
    const agent = await repo();
    // A repository-local core.hooksPath is a normal thing to have, and git is
    // the only thing that knows where it points.
    const inside = join(agent, ".githooks");
    expect((await git(agent, ["config", "core.hooksPath", inside], GIT_ENV)).code).toBe(0);

    expect(await hooksDir(agent)).toBe(inside);
    const outcome = await installHooks(agent, FAKE);
    expect(outcome.ok).toBe(true);
    expect(await Bun.file(join(inside, "pre-commit")).exists()).toBe(true);
  });

  test("a shared hooks path outside the repository is refused, not written into", async () => {
    // `core.hooksPath` is usually set globally — husky sets it — and git
    // honours it here. Installing there would put Mind's scan in front of
    // every commit on the machine, in repositories that never asked for it.
    const agent = await repo();
    const shared = join(await sandbox(), "shared-hooks");
    expect((await git(agent, ["config", "core.hooksPath", shared], GIT_ENV)).code).toBe(0);

    const outcome = await installHooks(agent, FAKE);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain(shared);
    expect(outcome.reason).toContain("core.hooksPath");
    expect(await Bun.file(join(shared, "pre-commit")).exists()).toBe(false);
  });

  test("Mind installs exactly two hooks and knows nothing about any other", () => {
    expect([...HOOK_NAMES]).toEqual(["pre-commit", "pre-push"]);
    expect(hookScript("post-commit", FAKE)).toBeUndefined();
  });
});
