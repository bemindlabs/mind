/**
 * `--as <dir>` — the one flag that decides *whose identity* a command runs as.
 *
 * It is sugar over `<dir> --subject <id>`, and sugar is exactly where a wrong
 * answer is cheapest to produce and dearest to notice: every refusal below is a
 * command line where two things each name an identity, and the alternative to
 * refusing is picking one of them quietly. I-3 is the invariant — identities do
 * not bleed — and `--as` is the one place a directory name could become an
 * identity by accident, so the subject is read out of `role.md` and then the
 * whole soul is loaded *as* that subject, which is what makes `person.md` have
 * to agree.
 *
 * Called here rather than spawned. `test/cli/turn.test.ts` and
 * `test/cli/worn.test.ts` already run `--as` through the real CLI end to end;
 * what they cannot do is report which of these lines ran, because bun measures
 * nothing in a process it spawned — `bin/as.ts` read 11.51%. {@link expandAs}
 * takes an argv and returns one, touches no global, and reads only the files it
 * is pointed at, so the whole of it can be asked directly.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AS_COMMANDS, expandAs } from "../../bin/as.ts";
import { SOUL_DIR } from "../../src/agent/index.ts";
import { ROLE_FILE, ROLE_SCHEMA } from "../../src/soul/index.ts";
import { SOUL_A, SOUL_B, writeSoul } from "../support/synthetic-soul.ts";

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-as-"));
  scratch.push(dir);
  return dir;
}

/** {@link expandAs}, with the stderr it writes collected instead of printed. */
async function expand(
  argv: readonly string[],
): Promise<{
  readonly result: Awaited<ReturnType<typeof expandAs>>;
  readonly said: string;
}> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    return { result: await expandAs(argv), said: lines.join("\n") };
  } finally {
    console.error = original;
  }
}

/** The argv a successful expansion produced, or a failure this test did not want. */
async function expanded(argv: readonly string[]): Promise<readonly string[]> {
  const { result, said } = await expand(argv);
  expect(result.ok, said).toBe(true);
  return result.ok ? result.argv : [];
}

/** The exit code a refused expansion asks for, with what it said. */
async function refused(argv: readonly string[]): Promise<{ code: number; said: string }> {
  const { result, said } = await expand(argv);
  expect(result.ok, `expected a refusal, got ${JSON.stringify(result)}`).toBe(false);
  return { code: result.ok ? 0 : result.code, said };
}

describe("a command line with no --as in it", () => {
  test("comes back as the very array it went in as", async () => {
    // `toBe`, not `toEqual`: every command line the CLI runs passes through
    // here, and the cheapest proof that the no-op case is a no-op is identity.
    const argv = ["doctor", "--json"];
    const { result } = await expand(argv);
    expect(result.ok && result.argv).toBe(argv);
  });
});

describe("--as with no directory after it", () => {
  test("at the end of the line, or followed by another flag, or spelled empty", async () => {
    const want = "--as needs the directory of a soul, or of an agent";
    for (const argv of [["turn", "--as"], ["--as", "--json", "turn"], ["--as=", "turn"]]) {
      const { code, said } = await refused(argv);
      expect(code, JSON.stringify(argv)).toBe(2);
      expect(said, JSON.stringify(argv)).toContain(want);
    }
  });
});

describe("--as only fills in what a command already takes", () => {
  test("a command that takes --subject directly is refused, and told so", async () => {
    const { code, said } = await refused(["--as", "./anywhere", "doctor"]);
    expect(code).toBe(2);
    expect(said).toContain(`--as does not apply to "doctor"`);
    // The refusal lists what it *does* expand, out of the map rather than out
    // of a sentence someone would have to remember to update.
    for (const key of AS_COMMANDS.keys()) expect(said).toContain(`\`${key}\``);
    expect(said).toContain("Other commands take --subject directly");
  });

  test("`soul` with no subcommand, and no command at all", async () => {
    expect((await refused(["--as", "./anywhere", "soul"])).said).toContain(
      `--as does not apply to "soul"`,
    );
    expect((await refused(["--as", "./anywhere"])).said).toContain(
      `--as does not apply to "no command"`,
    );
  });
});

describe("--as and a second way of saying the same thing", () => {
  test("--as with --subject is two answers to one question, and is refused", async () => {
    const dir = await tmp();
    const soul = await writeSoul(dir, SOUL_A);
    const { code, said } = await refused(["--as", soul, "turn", "--subject", SOUL_B.subject]);
    expect(code).toBe(2);
    expect(said).toContain("--as and --subject both name an identity; pass one");
    // And the refusal is not a lecture about which one it would have picked —
    // picking one is the failure.
    expect(said).not.toContain(SOUL_A.subject);
  });

  test("--as with a directory argument is refused, naming the argument to drop", async () => {
    const dir = await tmp();
    const soul = await writeSoul(dir, SOUL_A);
    const { code, said } = await refused(["--as", soul, "soul", "verify", "./elsewhere"]);
    expect(code).toBe(2);
    expect(said).toContain(`already says where the soul is; drop "./elsewhere"`);
  });

  test("whether a token is a positional is decided by that command's own flag list", async () => {
    // `--json` is in `WORN_BOOLEANS`, so it takes no value and `extra` is a
    // positional — which is the refusal below. Were `--as` parsing with a list
    // of its own that had gone stale, `extra` would read as the value of
    // `--json` and this command line would be expanded instead of refused.
    const dir = await tmp();
    const soul = await writeSoul(dir, SOUL_A);
    expect((await refused(["--as", soul, "worn", "--json", "extra"])).said).toContain(
      `drop "extra"`,
    );
    // Control: the same line without the stray token is fine.
    expect(await expanded(["--as", soul, "worn", "--json"])).toContain("--subject");
  });
});

describe("the directory --as is given has to hold a soul", () => {
  test("an empty directory is refused, and both paths it looked at are named", async () => {
    const dir = await tmp();
    const { code, said } = await refused(["--as", dir, "turn"]);
    expect(code).toBe(2);
    expect(said).toContain(`no soul at ${dir}`);
    expect(said).toContain(join(dir, SOUL_DIR, ROLE_FILE));
    expect(said).toContain(join(dir, ROLE_FILE));
  });

  test("an agent repository is accepted through its soul/ directory", async () => {
    // Both are things a person would point at: `--as ./my-agent` and
    // `--as ./my-agent/soul`. The nested one wins when both exist, and which
    // one was used is in the argv rather than left to guesswork.
    const dir = await tmp();
    const nested = await writeSoul(dir, SOUL_A, SOUL_DIR);
    expect(await expanded(["--as", dir, "turn"])).toEqual([
      "turn",
      nested,
      "--subject",
      SOUL_A.subject,
    ]);
  });
});

describe("the subject comes out of the files, never out of the directory name", () => {
  test("a soul in a directory named after someone else still runs as its own subject", async () => {
    // I-3, as the one command line that would break it: the directory is
    // called `beta-keeper` and holds alpha's soul. The name is a hint; the
    // file is the claim.
    const dir = await tmp();
    const soul = await writeSoul(dir, SOUL_A, SOUL_B.subject);
    expect(await expanded(["--as", soul, "turn", "--prompt", "hi"])).toEqual([
      "turn",
      soul,
      "--subject",
      SOUL_A.subject,
      "--prompt",
      "hi",
    ]);
  });

  test("role.md without a subject key is reported with a line number, not guessed at", async () => {
    const dir = await tmp();
    const soul = await writeSoul(dir, SOUL_A);
    await writeFile(
      join(soul, ROLE_FILE),
      `+++\nschema = "${ROLE_SCHEMA}"\nname = "No Subject"\n+++\n\n# no subject\n`,
    );

    const { code, said } = await refused(["--as", soul, "worn"]);
    // 1, not 2: the command line was readable and the files were not. A caller
    // that mapped both onto one code would lose that difference.
    expect(code).toBe(1);
    expect(said).toContain("Mind will not take the identity from the directory name");
    expect(said).toContain("1 problem.");
  });

  test("a subject that is not a subject id is refused the same way", async () => {
    const dir = await tmp();
    const soul = await writeSoul(dir, SOUL_A);
    await writeFile(
      join(soul, ROLE_FILE),
      `+++\nschema = "${ROLE_SCHEMA}"\nsubject = "Not An Id"\nname = "x"\n+++\n\n# x\n`,
    );
    const { code, said } = await refused(["--as", soul, "worn"]);
    expect(code).toBe(1);
    expect(said).toContain("must be a subject id");
  });

  test("role.md that does not parse is reported rather than read past", async () => {
    const dir = await tmp();
    const soul = await writeSoul(dir, SOUL_A);
    await writeFile(join(soul, ROLE_FILE), `+++\nsubject = "unclosed\n+++\n\n# broken\n`);
    expect((await refused(["--as", soul, "worn"])).code).toBe(1);
  });

  test("a person.md belonging to someone else stops the whole expansion", async () => {
    // The second half of the check, and the one a directory-name reading would
    // never make: `role.md` says alpha, so the soul is loaded *as* alpha, and
    // beta's `person.md` fails that load. Two files that disagree are not an
    // identity, and `--as` refuses rather than wearing half of one.
    const dir = await tmp();
    const alpha = await writeSoul(dir, SOUL_A);
    const beta = await writeSoul(dir, SOUL_B);
    await copyFile(join(beta, "person.md"), join(alpha, "person.md"));

    const { code, said } = await refused(["--as", alpha, "turn"]);
    expect(code).toBe(1);
    expect(said).toContain("problem");
  });
});

describe("what a good --as expands into", () => {
  test("a command that needs a directory gets one; a command that does not, does not", async () => {
    const dir = await tmp();
    const soul = await writeSoul(dir, SOUL_A);

    // `turn` is `dir-and-subject`.
    expect(await expanded(["--as", soul, "turn"])).toEqual([
      "turn",
      soul,
      "--subject",
      SOUL_A.subject,
    ]);
    // `worn` is `subject-only` — it is a question about an identity, not about
    // a directory, and handing it one would be a second thing to keep in step.
    expect(await expanded(["--as", soul, "worn"])).toEqual(["worn", "--subject", SOUL_A.subject]);
  });

  test("a two-word command keeps both of its words in front", async () => {
    const dir = await tmp();
    const soul = await writeSoul(dir, SOUL_A);
    expect(await expanded(["--as", soul, "soul", "verify", "--json"])).toEqual([
      "soul",
      "verify",
      soul,
      "--subject",
      SOUL_A.subject,
      "--json",
    ]);
  });

  test("`--as=<dir>` is the same as `--as <dir>`", async () => {
    const dir = await tmp();
    const soul = await writeSoul(dir, SOUL_A);
    expect(await expanded([`--as=${soul}`, "turn"])).toEqual(
      await expanded(["--as", soul, "turn"]),
    );
  });

  test("--as may come after the command, and the command's own flags survive it", async () => {
    const dir = await tmp();
    const soul = await writeSoul(dir, SOUL_A);
    expect(await expanded(["turn", "--private", "--prompt", "hi", "--as", soul])).toEqual([
      "turn",
      soul,
      "--subject",
      SOUL_A.subject,
      "--private",
      "--prompt",
      "hi",
    ]);
  });

  test("every command the map claims to expand really does expand", async () => {
    // The map is the list the refusal message above reads from, so an entry
    // that does not work would advertise itself and then fail.
    const dir = await tmp();
    const soul = await writeSoul(dir, SOUL_A);
    for (const [key, spec] of AS_COMMANDS) {
      const argv = await expanded(["--as", soul, ...key.split(" ")]);
      expect(argv.slice(0, key.split(" ").length), key).toEqual(key.split(" "));
      expect(argv, key).toContain("--subject");
      expect(argv.at(-1), key).toBe(SOUL_A.subject);
      expect(argv.includes(soul), `${key} — needs ${spec.needs}`).toBe(
        spec.needs === "dir-and-subject",
      );
    }
  });
});

describe("--as and a bare -- (D-152)", () => {
  test("for `memory ask`, --as=… after -- is its question, left where it is", async () => {
    const argv = ["memory", "ask", "./agent", "--subject", "x", "--", "--as=/elsewhere", "--as", "y"];
    expect(await expanded(argv)).toEqual(argv);
  });

  test("for every other command a -- changes nothing: --as after it is still read as --as", async () => {
    const { said } = await refused(["turn", "--", "--as=/nowhere/at/all"]);
    expect(said).toContain("no soul at /nowhere/at/all");
  });
});
