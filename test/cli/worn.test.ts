/**
 * `--as` and `worn`, as a person types them.
 *
 * Spawned rather than called, because everything checked here is a property of
 * the command line: that `--as` reads the subject out of the soul's files and
 * not out of the directory name, that it refuses two answers to one question,
 * and that `worn` exits non-zero on a machine that is wearing nothing, the
 * wrong thing, or two things.
 *
 * `HOME` is a temporary directory in every invocation. Nothing here can reach
 * the real one, and the souls are synthetic (D-021).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOUL_A, SOUL_B, writeSoul } from "../support/synthetic-soul.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const HUMAN = join(ROOT, "test", "fixtures", "instructions", "human-200.md");

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

async function makeHome(): Promise<string> {
  const home = await sandbox("mind-worn-cli-");
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(join(home, ".claude", "CLAUDE.md"), await readFile(HUMAN, "utf8"));
  return home;
}

async function run(home: string, args: readonly string[]) {
  const child = Bun.spawn(["bun", "run", BIN, ...args], {
    cwd: ROOT,
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

describe("mind worn", () => {
  test("a home with no block is `wearing nothing`, and exits 1", async () => {
    const home = await makeHome();
    const result = await run(home, ["worn", "--backend", "claude"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("wearing nothing");
    // The limits are printed with the answer, not kept for a --verbose nobody
    // passes.
    expect(result.stdout).toContain("I-4");
  }, 30_000);

  test("after applying A it says A, and exits 0 (AC1)", async () => {
    const home = await makeHome();
    const souls = await sandbox("mind-worn-souls-");
    const dirA = await writeSoul(souls, SOUL_A);

    const applied = await run(home, [
      "soul", "apply", dirA, "--subject", SOUL_A.subject, "--backend", "claude", "--apply",
    ]);
    expect(applied.code).toBe(0);

    const worn = await run(home, ["worn", "--backend", "claude"]);
    expect(worn.code).toBe(0);
    expect(worn.stdout).toContain(`wearing ${SOUL_A.subject}`);
    expect(worn.stdout).toContain(join(home, ".claude", "CLAUDE.md"));
  }, 30_000);

  test("--subject asks about one identity, and says no about the other", async () => {
    const home = await makeHome();
    const souls = await sandbox("mind-worn-souls-");
    const dirA = await writeSoul(souls, SOUL_A);

    await run(home, [
      "soul", "apply", dirA, "--subject", SOUL_A.subject, "--backend", "claude", "--apply",
    ]);

    const mine = await run(home, ["worn", "--backend", "claude", "--subject", SOUL_A.subject]);
    expect(mine.code).toBe(0);
    expect(mine.stdout).toContain(`${SOUL_A.subject} is what this machine is wearing`);

    const theirs = await run(home, ["worn", "--backend", "claude", "--subject", SOUL_B.subject]);
    expect(theirs.code).toBe(1);
    expect(theirs.stdout).toContain(`${SOUL_B.subject} is not what this machine is wearing`);
  }, 30_000);

  test("--json prints the report, the home it read, and what was asked", async () => {
    const home = await makeHome();
    const result = await run(home, ["worn", "--backend", "claude", "--json"]);

    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.verdict).toBe("none");
    expect(parsed.home).toBe(home);
    expect(parsed.asked).toBeNull();
    expect(parsed.places).toHaveLength(1);
  }, 30_000);

  test("a backend with no instruction file is a row, not a silence", async () => {
    const home = await makeHome();
    // The default chain includes ollama, whose only channel is the request.
    const result = await run(home, ["worn", "--json"]);

    const parsed = JSON.parse(result.stdout);
    const field = parsed.places.find((place: { backend: string }) => place.backend === "ollama");
    expect(field.state).toBe("system-field");
  }, 30_000);

  test("a directory argument is a usage error", async () => {
    const home = await makeHome();
    expect((await run(home, ["worn", "."])).code).toBe(2);
  }, 30_000);
});

describe("mind --as <dir>", () => {
  test("it fills in the directory and the subject, read from the files", async () => {
    const home = await makeHome();
    const souls = await sandbox("mind-as-souls-");
    const dirA = await writeSoul(souls, SOUL_A);

    const checked = await run(home, ["--as", dirA, "soul", "check"]);
    expect(checked.code).toBe(0);
    expect(checked.stdout).toContain(SOUL_A.name);
    expect(checked.stdout).toContain(`subject ${SOUL_A.subject}`);
  }, 30_000);

  test("it finds the soul inside an agent repository too", async () => {
    const home = await makeHome();
    const agents = await sandbox("mind-as-agent-");
    const agent = join(agents, "some-agent");
    await writeSoul(agent, SOUL_A, "soul");

    const checked = await run(home, ["--as", agent, "soul", "check"]);
    expect(checked.code).toBe(0);
    expect(checked.stdout).toContain(`subject ${SOUL_A.subject}`);
  }, 30_000);

  test("the directory name is a hint, not the identity (I-3)", async () => {
    const home = await makeHome();
    const souls = await sandbox("mind-as-souls-");
    // A directory called after B, holding A's two files.
    const misnamed = await writeSoul(souls, SOUL_A, SOUL_B.subject);

    const checked = await run(home, ["--as", misnamed, "soul", "check"]);
    expect(checked.code).toBe(0);
    expect(checked.stdout).toContain(`subject ${SOUL_A.subject}`);
    expect(checked.stdout).not.toContain(`subject ${SOUL_B.subject}`);
  }, 30_000);

  test("two files that disagree about whose they are is refused, not worn", async () => {
    const home = await makeHome();
    const souls = await sandbox("mind-as-souls-");
    const mixed = await writeSoul(souls, SOUL_A);
    // person.md now belongs to somebody else: exactly the bleed I-3 forbids.
    await writeFile(
      join(mixed, "person.md"),
      (await readFile(join(mixed, "person.md"), "utf8")).replace(SOUL_A.subject, SOUL_B.subject),
    );

    const checked = await run(home, ["--as", mixed, "soul", "check"]);
    expect(checked.code).toBe(1);
    expect(checked.stderr).toContain("person.md");
    expect(checked.stderr).toContain(SOUL_B.subject);
  }, 30_000);

  test("--as with --subject is refused rather than resolved", async () => {
    const home = await makeHome();
    const souls = await sandbox("mind-as-souls-");
    const dirA = await writeSoul(souls, SOUL_A);

    const result = await run(home, ["--as", dirA, "soul", "check", "--subject", SOUL_B.subject]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("both name an identity");
  }, 30_000);

  test("--as with a directory argument is refused rather than one of them ignored", async () => {
    const home = await makeHome();
    const souls = await sandbox("mind-as-souls-");
    const dirA = await writeSoul(souls, SOUL_A);
    const dirB = await writeSoul(souls, SOUL_B);

    const result = await run(home, ["--as", dirA, "soul", "check", dirB]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(dirB);
  }, 30_000);

  test("--as does not swallow a flag's value", async () => {
    const home = await makeHome();
    const souls = await sandbox("mind-as-souls-");
    const dirA = await writeSoul(souls, SOUL_A);

    // `--backend claude` must not read as a stray positional and trip the
    // "you already said where the soul is" refusal.
    const result = await run(home, ["--as", dirA, "worn", "--backend", "claude"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`${SOUL_A.subject} is not what this machine is wearing`);
  }, 30_000);

  test("a command that does not take --as says so, and lists the ones that do", async () => {
    const home = await makeHome();
    const souls = await sandbox("mind-as-souls-");
    const dirA = await writeSoul(souls, SOUL_A);

    const result = await run(home, ["--as", dirA, "guard", "status"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--as does not apply to");
    expect(result.stderr).toContain("soul apply");
  }, 30_000);

  test("--as with nothing after it is a usage error", async () => {
    const home = await makeHome();
    const result = await run(home, ["--as", "--", "soul", "check"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--as needs the directory");
  }, 30_000);

  test("a directory with no soul in it names both places it looked", async () => {
    const home = await makeHome();
    const empty = await sandbox("mind-as-empty-");

    const result = await run(home, ["--as", empty, "soul", "check"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(join(empty, "soul", "role.md"));
    expect(result.stderr).toContain(join(empty, "role.md"));
  }, 30_000);
});

describe("AC1 and AC3, from the command line", () => {
  test("wear A, switch to B: worn follows, and nothing of A is left", async () => {
    const home = await makeHome();
    const human = await readFile(join(home, ".claude", "CLAUDE.md"), "utf8");
    const souls = await sandbox("mind-switch-");
    const dirA = await writeSoul(souls, SOUL_A);
    const dirB = await writeSoul(souls, SOUL_B);

    expect((await run(home, ["--as", dirA, "soul", "apply", "--backend", "claude", "--apply"])).code).toBe(0);
    expect((await run(home, ["worn", "--backend", "claude", "--subject", SOUL_A.subject])).code).toBe(0);

    const switched = await run(home, ["--as", dirB, "soul", "apply", "--backend", "claude", "--apply"]);
    expect(switched.code).toBe(0);
    expect(switched.stdout).toContain(`replaces the block of subject ${SOUL_A.subject}`);

    expect((await run(home, ["worn", "--backend", "claude", "--subject", SOUL_A.subject])).code).toBe(1);
    expect((await run(home, ["worn", "--backend", "claude", "--subject", SOUL_B.subject])).code).toBe(0);

    const text = await readFile(join(home, ".claude", "CLAUDE.md"), "utf8");
    for (const fact of Object.values(SOUL_A.facts)) expect(text).not.toContain(fact);
    expect(text.startsWith(human)).toBe(true);
  }, 60_000);

  test("a half-finished switch is reported as mixed, and exits 1", async () => {
    const home = await makeHome();
    const souls = await sandbox("mind-switch-");
    const dirA = await writeSoul(souls, SOUL_A);
    const dirB = await writeSoul(souls, SOUL_B);

    // Two backends, two files, and only one of them switched — which is what a
    // run interrupted between writes leaves behind.
    await run(home, ["--as", dirA, "soul", "apply", "--backend", "claude,codex", "--apply"]);
    await run(home, ["--as", dirB, "soul", "apply", "--backend", "claude", "--apply"]);

    const worn = await run(home, ["worn", "--backend", "claude,codex"]);
    expect(worn.code).toBe(1);
    expect(worn.stdout).toContain("2 identities at once");
    expect(worn.stdout).toContain("switch that did not finish");

    // And neither one may be reported as what the machine is wearing.
    expect((await run(home, ["worn", "--backend", "claude,codex", "--subject", SOUL_A.subject])).code).toBe(1);
    expect((await run(home, ["worn", "--backend", "claude,codex", "--subject", SOUL_B.subject])).code).toBe(1);
  }, 60_000);
});

describe("the help text", () => {
  test("names worn, --as, and doctor — which S0.2 (w6) built", async () => {
    const home = await makeHome();
    const result = await run(home, ["help"]);

    expect(result.stdout).toContain("mind worn");
    expect(result.stdout).toContain("--as <dir>");
    expect(result.stdout).toContain("mind doctor");
    // It was on the unbuilt list until w6; `test/cli/doctor.test.ts` holds the
    // other half of this assertion.
    expect(result.stdout).not.toContain("[S0.2]");
  }, 30_000);
});
