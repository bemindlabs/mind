/**
 * `mind new` and `mind rebuild`, as a person types them.
 *
 * The property these spawn a real process to check is the one AC7 is actually
 * about: the sequence a human performs — create, build, `rm -rf .mind`, build
 * again — and not the function calls underneath it. `--check`'s exit code is
 * here for the same reason: it is meant to be usable from a script, and an exit
 * code is not visible from inside the function that decided it.
 *
 * `HOME` is a temporary directory in every invocation, and every agent is
 * created under `$TMPDIR`, which is not inside any git repository. Nothing here
 * can reach the real home or the engine's own working tree.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SUBJECT = "example";

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

/** Create an agent under a fresh parent directory, and return its path. */
async function makeAgent(home: string): Promise<string> {
  const parent = await sandbox("mind-agents-");
  const result = await run(home, ["new", "example", "--subject", SUBJECT, "--dir", parent]);
  expect(result.code).toBe(0);
  return join(parent, "example");
}

describe("mind new", () => {
  test("AC1/AC2 — it lays out the repository, with a one-line .gitignore", async () => {
    const home = await sandbox("mind-home-");
    const agent = await makeAgent(home);

    expect(await readFile(join(agent, ".gitignore"), "utf8")).toBe("/.mind/\n");
    for (const file of ["soul/role.md", "soul/person.md", "memory/README.md", "consent/README.md"]) {
      expect(await Bun.file(join(agent, file)).exists(), file).toBe(true);
    }
    expect(await Bun.file(join(agent, ".git", "HEAD")).exists()).toBe(true);
  });

  test("the created soul passes `soul check` unedited", async () => {
    const home = await sandbox("mind-home-");
    const agent = await makeAgent(home);

    const checked = await run(home, ["soul", "check", join(agent, "soul"), "--subject", SUBJECT]);
    expect(checked.code).toBe(0);
    expect(checked.stdout).toContain("discloses it is an AI");
  });

  test("it says it committed nothing, and names the hard stop", async () => {
    const home = await sandbox("mind-home-");
    const parent = await sandbox("mind-agents-");
    const result = await run(home, ["new", "example", "--subject", SUBJECT, "--dir", parent]);

    expect(result.stdout).toContain("Nothing was committed");
    expect(result.stdout).toContain("S1.6");
  });

  test("a missing --subject is a usage error — an identity is never inferred", async () => {
    const home = await sandbox("mind-home-");
    const parent = await sandbox("mind-agents-");
    const result = await run(home, ["new", "example", "--dir", parent]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--subject");
  });

  test("a name that is not a safe directory segment is refused", async () => {
    const home = await sandbox("mind-home-");
    const parent = await sandbox("mind-agents-");
    const result = await run(home, ["new", "../escape", "--subject", SUBJECT, "--dir", parent]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("directory name");
  });

  test("D-021 — creating one inside the engine repository is refused", async () => {
    const home = await sandbox("mind-home-");
    const result = await run(home, ["new", "example", "--subject", SUBJECT, "--dir", join(ROOT, "agents")]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("engine repository");
    expect(await Bun.file(join(ROOT, "agents", "example", ".gitignore")).exists()).toBe(false);
  });
});

describe("mind rebuild", () => {
  test("AC7 — rm -rf .mind, rebuild, and only built_at differs", async () => {
    const home = await sandbox("mind-home-");
    const agent = await makeAgent(home);

    expect((await run(home, ["rebuild", agent, "--subject", SUBJECT])).code).toBe(0);
    const firstRendered = await readFile(join(agent, ".mind", "soul", "rendered.md"), "utf8");
    const firstManifest = await readFile(join(agent, ".mind", "manifest.json"), "utf8");

    expect((await run(home, ["rebuild", agent, "--subject", SUBJECT, "--check"])).code).toBe(0);

    await rm(join(agent, ".mind"), { recursive: true, force: true });
    const missing = await run(home, ["rebuild", agent, "--subject", SUBJECT, "--check"]);
    expect(missing.code).toBe(1);
    expect(missing.stdout).toContain("missing");

    expect((await run(home, ["rebuild", agent, "--subject", SUBJECT])).code).toBe(0);
    const secondRendered = await readFile(join(agent, ".mind", "soul", "rendered.md"), "utf8");
    const secondManifest = await readFile(join(agent, ".mind", "manifest.json"), "utf8");

    expect(secondRendered).toBe(firstRendered);

    const before = firstManifest.split("\n");
    const after = secondManifest.split("\n");
    expect(after).toHaveLength(before.length);
    for (const [index, line] of before.entries()) {
      if (line === after[index]) continue;
      expect(line).toContain("built_at");
    }

    expect((await run(home, ["rebuild", agent, "--subject", SUBJECT, "--check"])).code).toBe(0);
  });

  test("AC6 — --check reports stale after a source file changes, and writes nothing", async () => {
    const home = await sandbox("mind-home-");
    const agent = await makeAgent(home);
    await run(home, ["rebuild", agent, "--subject", SUBJECT]);

    const rendered = join(agent, ".mind", "soul", "rendered.md");
    const before = await readFile(rendered, "utf8");

    const role = join(agent, "soul", "role.md");
    await writeFile(role, (await readFile(role, "utf8")).replace("not described yet", "tends a fixture"));

    const checked = await run(home, ["rebuild", agent, "--subject", SUBJECT, "--check"]);
    expect(checked.code).toBe(1);
    expect(checked.stdout).toContain("stale");
    expect(await readFile(rendered, "utf8")).toBe(before);

    expect((await run(home, ["rebuild", agent, "--subject", SUBJECT])).code).toBe(0);
    expect(await readFile(rendered, "utf8")).toContain("tends a fixture");
  });

  test("I-3 — rebuilding for the wrong subject is refused and writes nothing", async () => {
    const home = await sandbox("mind-home-");
    const agent = await makeAgent(home);

    const result = await run(home, ["rebuild", agent, "--subject", "somebody-else"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("soul/role.md");
    expect(await Bun.file(join(agent, ".mind", "manifest.json")).exists()).toBe(false);
  });

  test("I-2 — deleting .mind never changes what a command answers", async () => {
    const home = await sandbox("mind-home-");
    const agent = await makeAgent(home);
    await run(home, ["rebuild", agent, "--subject", SUBJECT]);

    const withDerived = await run(home, ["soul", "check", join(agent, "soul"), "--subject", SUBJECT]);
    await rm(join(agent, ".mind"), { recursive: true, force: true });
    const without = await run(home, ["soul", "check", join(agent, "soul"), "--subject", SUBJECT]);

    expect(without.code).toBe(withDerived.code);
    expect(without.stdout).toBe(withDerived.stdout);
  });

  test("help lists both commands", async () => {
    const home = await sandbox("mind-home-");
    const result = await run(home, ["help"]);
    expect(result.stdout).toContain("mind new <name>");
    expect(result.stdout).toContain("mind rebuild <dir>");
  });
});

