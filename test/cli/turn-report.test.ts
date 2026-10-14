/**
 * S5.2 AC4 through the binary: a turn at level 2 says what it changed before
 * it ends, and a turn at level 1 takes no snapshot at all (D-043).
 *
 * The vendor is a stub `claude` that writes a file in the directory it was
 * started in and deletes another — which is what a vendor without its
 * read-only flag is free to do.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subjectId } from "../../src/types.ts";
import { confirmationsPath, setConfirmation } from "../../src/decide/confirm.ts";
import { barePath, BUN } from "../support/bare-path.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SOUL = join(ROOT, "test", "fixtures", "soul-valid");

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

const STUB = `#!/usr/bin/env bun
import { writeFileSync, rmSync } from "node:fs";
writeFileSync(process.env.HOME + "/argv.json", JSON.stringify(process.argv.slice(2)));
writeFileSync("made-by-the-turn.txt", "hello");
rmSync("old-note.txt", { force: true });
console.log(JSON.stringify({ result: "done" }));
`;

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "mind-turn-report-"));
  scratch.push(home);
  const soul = join(home, "agent", "soul");
  await cp(SOUL, soul, { recursive: true });
  const work = join(home, "work");
  await mkdir(work, { recursive: true });
  await Bun.write(join(work, "old-note.txt"), "keep me?");
  await Bun.write(join(work, "untouched.txt"), "same");
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  await Bun.write(join(bin, "claude"), STUB);
  await chmod(join(bin, "claude"), 0o755);
  const env = {
    HOME: home,
    PATH: `${bin}:${await barePath(home)}`,
    XDG_STATE_HOME: join(home, "state"),
    XDG_DATA_HOME: join(home, "data"),
  };
  const run = async (args: readonly string[], cwd = ROOT) => {
    const child = Bun.spawn([BUN, "run", BIN, ...args], { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    await child.exited;
    return { code: child.exitCode ?? -1, stdout, stderr };
  };
  return { home, soul, work, run };
}

describe("a turn that may act reports what it changed", () => {
  test("level 2: the added and removed files are named before the turn ends, and in --json", async () => {
    const { soul, work, run } = await setup();
    for (const category of ["write", "run", "reach"]) {
      const set = await run(["autonomy", "set", category, "2", soul, "--subject", "example"]);
      expect(set.code, set.stderr).toBe(0);
    }

    const result = await run(
      ["turn", soul, "--subject", "example", "--backend", "claude", "--prompt", "tidy up", "--json"],
      work,
    );

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain(`what this turn changed in ${work}: 1 added · 0 changed · 1 removed`);
    expect(result.stderr).toContain("+ made-by-the-turn.txt");
    expect(result.stderr).toContain("- old-note.txt");
    expect(result.stderr).not.toContain("untouched.txt");
    expect(result.stderr).toContain("not seen by this report");
    // A vendor CLI has tools; the D-149 line is for a backend that has none.
    expect(result.stderr).not.toContain("has no tools");
    const json = JSON.parse(result.stdout) as { changed: { added: string[]; changed: string[]; removed: string[] } };
    expect(json.changed).toEqual({ added: ["made-by-the-turn.txt"], changed: [], removed: ["old-note.txt"] });
  }, 60_000);

  test("level 1: no snapshot is taken and nothing is reported, because nothing was allowed", async () => {
    const { soul, work, run } = await setup();
    const result = await run(
      ["turn", soul, "--subject", "example", "--backend", "claude", "--prompt", "tidy up", "--json"],
      work,
    );
    expect(result.stderr).not.toContain("what this turn changed");
    expect((JSON.parse(result.stdout) as { changed: unknown }).changed).toBeNull();
  }, 60_000);

  // D-163 (Q4-D2): the grant is for a turn inside the fence (the vendor's own flags are tested in
  // test/exec/registry.test.ts). A cloud claude is held at 1 — nothing is granted — while the isolation stays.
  test("D-047 / D-163: level 2 on a cloud vendor grants nothing (held at 1), and still isolates the identity and loads no MCP", async () => {
    const { home, soul, work, run } = await setup();
    for (const category of ["write", "run", "reach"]) {
      await run(["autonomy", "set", category, "2", soul, "--subject", "example"]);
    }
    await run(["turn", soul, "--subject", "example", "--backend", "claude", "--prompt", "x"], work);
    const argv = JSON.parse(await Bun.file(join(home, "argv.json")).text()) as string[];
    expect(argv).not.toContain("acceptEdits");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("project,local");
    // The vendor's read-only flag stays ON: every built-in tool removed, exactly as at level 1.
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
  }, 60_000);

  test("level 3 (confirmed): the change is in --json, and not printed — act, not act-then-report", async () => {
    const { home, soul, work, run } = await setup();
    await run(["autonomy", "set", "reach", "2", soul, "--subject", "example"]);
    for (const category of ["write", "run"]) {
      await run(["autonomy", "set", category, "2", soul, "--subject", "example"]);
    }
    // Stand in for the terminal phrase (tested on its own through a pty):
    // the file says 3 and the confirmation record says a person agreed.
    const path = join(soul, "autonomy.md");
    await Bun.write(path, (await Bun.file(path).text()).replace("write = 2", "write = 3").replace("run = 2", "run = 3"));
    const record = confirmationsPath({ home, env: { XDG_STATE_HOME: join(home, "state") } }, soul, subjectId("example"));
    await setConfirmation(record, "write", { by: "test", at: "t" });
    await setConfirmation(record, "run", { by: "test", at: "t" });

    const result = await run(
      ["turn", soul, "--subject", "example", "--backend", "claude", "--prompt", "tidy", "--json"],
      work,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("what this turn changed");
    const json = JSON.parse(result.stdout) as { changed: { added: string[] } };
    expect(json.changed.added).toEqual(["made-by-the-turn.txt"]);
  }, 60_000);
});
