/**
 * The compiled binary, asserted against — because nothing else here is.
 *
 * Every other test in this repository runs from the checkout, and a whole class
 * of fault is invisible from there: `import.meta.dir` resolves to a real
 * directory in a checkout and to a path inside the executable under
 * `bun build --compile`. `doctor` used to walk that path, read nothing, find
 * nothing, and print `ok clean · 0 file(s)`. Three green gates and a parity
 * harness all agreed, and the owner found it by running the binary once.
 *
 * The binary is also what `scripts/demo-bare-container.sh` ships and what
 * anyone else would be handed, so "it works from source" is not the claim worth
 * defending.
 *
 * **Not gated behind an environment variable.** The opt-in tests here exist
 * because they spend vendor quota or touch something real; a build spends
 * neither, and a test nobody runs by default is the same hole this file closes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");

/** A port nothing is listening on, so the local route is absent, not slow. */
const DEAD = "http://127.0.0.1:59997";

let binary = "";
let home = "";
const scratch: string[] = [];

beforeAll(async () => {
  const out = await mkdtemp(join(tmpdir(), "mind-binary-"));
  home = await mkdtemp(join(tmpdir(), "mind-binary-home-"));
  scratch.push(out, home);
  binary = join(out, "mind");

  const build = Bun.spawn(
    ["bun", "build", join(ROOT, "bin", "mind.ts"), "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--outfile", binary],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(build.stderr).text();
  await build.exited;
  if (build.exitCode !== 0) throw new Error(`build failed: ${stderr}`);
}, 120_000);

afterAll(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Ran {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/**
 * Run the built binary with a throwaway home and nothing of this machine's.
 *
 * `where` exists because one case below needs a git repository to run inside,
 * and putting it in the shared home would make the order of the tests an
 * undeclared precondition: a `doctor` case appended after it would silently run
 * inside a git branch, and nothing would say so.
 */
async function run(args: readonly string[], where: string = home): Promise<Ran> {
  const child = Bun.spawn([binary, ...args], {
    cwd: where,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env["PATH"] ?? "", HOME: where },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  return { stdout, stderr, code: child.exitCode ?? -1 };
}

interface Finding {
  readonly id: string;
  readonly severity: string;
  readonly detail: string;
}

/** Every finding in a `doctor --json` run, flattened across its sections. */
function findings(stdout: string): Finding[] {
  const report = JSON.parse(stdout) as {
    sections: Array<{ findings: Finding[] }>;
  };
  return report.sections.flatMap((section) => section.findings);
}

describe("the compiled binary", () => {
  test("it runs at all, with no runtime installed beside it", async () => {
    const version = await run(["version"]);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("the engine check says it did not check, rather than that it is clean", async () => {
    // The regression, stated as the two things that must both be true: the
    // honest finding is present, and the reassuring one is absent. Asserting
    // only the first would pass on a report that printed both.
    const report = await run(["doctor", "--no-version", "--ollama", DEAD, "--json"]);
    const ids = findings(report.stdout).map((f) => f.id);

    expect(ids).toContain("engine.unchecked");
    expect(ids).not.toContain("engine.clean");

    const engine = findings(report.stdout).find((f) => f.id === "engine.unchecked")!;
    expect(engine.severity).toBe("warn");
    // A reader has to be told where the answer can be had instead.
    expect(engine.detail).toContain("checkout");
  });

  test("no check anywhere reports success over nothing", async () => {
    // The general rule the regression produced: an `ok` reporting a count of
    // zero is a check that looked at an empty set and approved of it. Asserted
    // for every finding the binary can produce, not only the one that was
    // caught.
    const report = await run(["doctor", "--no-version", "--ollama", DEAD, "--json"]);
    // Not anchored to the start: the bug happened to put its zero first, and a
    // later `clean · 0 file(s) scanned` would be the same fault wearing a
    // different sentence. A word boundary keeps `10 file(s)` out of it.
    const zeroed = findings(report.stdout).filter(
      (f) => f.severity === "ok" && /(^|\s)0\s+\S/.test(f.detail),
    );
    expect(zeroed).toEqual([]);
  });

  test("no output names the executable's virtual filesystem as a place on disk", async () => {
    // `/$bunfs` is where a compiled module lives. A path under it appearing in
    // a report means something walked it and described the result as a
    // directory this machine has.
    const report = await run(["doctor", "--no-version", "--ollama", DEAD]);
    expect(report.stdout).not.toContain("$bunfs");
    expect(report.stderr).not.toContain("$bunfs");
  });

  test("an unreachable local route still exits 1 from the binary", async () => {
    // I-1's exit code is the one thing `doctor` promises to a script, and it
    // has to mean the same from the binary as from a checkout.
    const report = await run(["doctor", "--no-version", "--ollama", DEAD]);
    expect(report.code).toBe(1);
  });

  test("`new` is still refused inside a git repository", async () => {
    // The guard that compares against the engine's own root cannot match from a
    // binary. What refuses this is the git check — asserted here so that a
    // later change cannot quietly leave neither of them doing the work.
    const repo = await mkdtemp(join(tmpdir(), "mind-binary-repo-"));
    scratch.push(repo);
    const init = Bun.spawn(["git", "init", "-q"], { cwd: repo, stdout: "ignore", stderr: "ignore" });
    await init.exited;

    const made = await run(["new", "somebody", "--subject", "somebody"], repo);
    expect(made.code).not.toBe(0);
    expect(made.stderr).toContain("git repository");
  });

  test("the commands that read files read the right ones", async () => {
    // `doctor` is not the only thing that resolves a path. Making an agent and
    // then reading it back exercises the commands where `import.meta.dir` would
    // matter most after it — and where a binary that resolved paths against its
    // own insides would find an empty directory and say something agreeable
    // about it, which is the whole shape of the fault this file exists for.
    const work = await mkdtemp(join(tmpdir(), "mind-binary-agent-"));
    scratch.push(work);

    const made = await run(["new", "reader", "--subject", "reader", "--dir", work], work);
    expect(made.code).toBe(0);

    const soul = join(work, "reader", "soul");

    // Reads two files off disk and reports what is in them. A count of zero
    // prohibitions would mean it had found a file and parsed nothing out of it.
    const checked = await run(["soul", "check", soul, "--subject", "reader"], work);
    expect(checked.code).toBe(0);
    expect(checked.stdout).toContain("reader");
    expect(checked.stdout).toMatch(/[1-9]\d* prohibition/);

    // Reads the instruction files of a home that has none of Mind's blocks in
    // it, and has to say so rather than report an empty read as agreement.
    const wearing = await run(["worn", "--backend", "claude", "--home", work], work);
    expect(wearing.stdout + wearing.stderr).toContain("nothing");
    expect(wearing.stdout).not.toContain("$bunfs");

    // A soul that was never applied is not worn, and the exit code says so.
    expect(wearing.code).not.toBe(0);
  });
});
