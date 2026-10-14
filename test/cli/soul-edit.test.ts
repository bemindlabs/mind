/** D-074 through the binary: `soul edit` shows, writes only with --yes, and never writes a soul that would not load. */

import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { barePath, BUN } from "../support/bare-path.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SOUL = join(ROOT, "test", "fixtures", "soul-valid");
const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("mind soul edit", () => {
  test("print, dry run, write; a name that is a source person's is refused", async () => {
    const home = await mkdtemp(join(tmpdir(), "mind-soul-edit-"));
    scratch.push(home);
    const agent = join(home, "agent");
    await cp(SOUL, join(agent, "soul"), { recursive: true });
    const env = { HOME: home, PATH: await barePath(home), XDG_STATE_HOME: join(home, "state"), MIND_NO_UPDATE_CHECK: "1" };
    const run = async (args: readonly string[]) => {
      const child = Bun.spawn([BUN, "run", BIN, "soul", "edit", agent, "--subject", "example", ...args], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      await child.exited;
      return { code: child.exitCode ?? -1, stdout, stderr };
    };
    const printed = await run(["--print"]);
    const profile = JSON.parse(printed.stdout);
    expect(profile.name).toBe("Example Keeper");
    const file = join(home, "p.json");

    await writeFile(file, JSON.stringify(profile));
    expect((await run(["--profile", file])).stdout).toContain("Nothing differs");

    await writeFile(file, JSON.stringify({ ...profile, tone: ["brief"], principles: [...profile.principles, "keep every change reversible"] }));
    const dry = await run(["--profile", file]);
    expect(dry.stdout).toContain("would change: tone, principles");
    expect(await readFile(join(agent, "soul", "person.md"), "utf8")).not.toContain("keep every change reversible");
    const wet = await run(["--profile", file, "--yes"]);
    expect(wet.code, wet.stderr).toBe(0);
    expect(await readFile(join(agent, "soul", "person.md"), "utf8")).toContain("keep every change reversible");

    // S6.4 AC3: the agent may not carry the name of a person it inherits from.
    await writeFile(file, JSON.stringify({ ...profile, name: "Somchai Jaidee", inheritsFrom: ["Somchai Jaidee"] }));
    const refused = await run(["--profile", file, "--yes"]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("would not load");
    expect(await readFile(join(agent, "soul", "role.md"), "utf8")).toContain("Example Keeper");

    await writeFile(file, "{not json");
    expect((await run(["--profile", file])).code).toBe(1);
    await writeFile(file, JSON.stringify({ name: 1 }));
    expect((await run(["--profile", file])).code).toBe(1);
    expect((await run([])).code).toBe(2);
  }, 60_000);
});
