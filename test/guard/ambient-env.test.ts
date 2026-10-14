/**
 * `src/` is handed its home and its environment; it does not go and look.
 *
 * Two files say so about themselves — `src/state.ts` ("Nothing here reads
 * `process.env` or `homedir()`") and `src/soul/targets.ts` ("are both
 * arguments") — and both sentences are true. What did not exist is the rule
 * those two sentences are examples of, which is why this file is a gate rather
 * than a third comment.
 *
 * **The rule.** Ambient identity and configuration — `homedir()`, `process.env`,
 * `process.cwd()` — are read at the seam where Mind starts a process or takes
 * a command line, and passed inward as values. Nothing under `src/` reads them
 * for itself, except four files that *are* that seam and are named below with
 * the reason.
 *
 * **Why it is worth a gate and not a habit.** A `src/` file that quietly called
 * `homedir()` would work, and the first thing that noticed would be the test
 * suite: every test here injects a `mkdtemp` home precisely so that nothing runs
 * against the owner's real one (D-021). A function reading ambient `homedir()`
 * cannot be given a fake, so the test that covers it either reads the machine it
 * is running on — writing into a real `~/.claude`, for instance — or is not
 * written at all. The same read also makes the same call return different answers
 * for the same soul on two machines, which is I-3's problem in slow motion.
 *
 * **What this deliberately does not forbid**, with the reason, because a gate
 * whose scope is unstated gets widened by the next person into something that
 * fails honest code:
 *
 * - `process.pid` — a suffix that makes a temp filename unique. It says nothing
 *   about who is running Mind and cannot differ per identity; four files use it
 *   and all four are writing `x.tmp-<pid>` before a rename.
 * - `process.execPath` — which runtime binary is executing, read once in
 *   `src/guard/hooks.ts` by the impure wrapper around a pure `hookCommand`. It is
 *   the seam shape this gate exists to encourage, not a violation of it.
 * - `bin/` — the seam itself. `bin/shared.ts` reads `homedir()` for `ledgerEnv`,
 *   and every command turns `--home` into a value before calling inward. That is
 *   where this is supposed to happen.
 * - `process["env"]` — not matched here and not needed:
 *   `test/guard/no-push.test.ts` already refuses computed access on `process`
 *   anywhere under `src/` and `bin/`.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { globalsUsed, memberReads, moduleSpecifiers, sourceFiles } from "../support/ast.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const SRC = join(ROOT, "src");
/** A file that must be in the scan, so a scope that went empty cannot pass. */
const INJECTED = join("src", "state.ts");

/** `process.<member>` reads that are a fact about this machine's owner or setup. */
const AMBIENT_MEMBERS: readonly string[] = ["env", "cwd"];

/** Modules whose whole purpose here is `homedir()`. */
const HOME_MODULES: readonly string[] = ["node:os", "os"];

/**
 * The four files that are the seam, and what each of them reads.
 *
 * A line each, with the reason, rather than a pattern: an exemption should cost
 * someone a justification. All four are under `src/exec/` and that is not a
 * coincidence — the seam is where a child process is configured, because a child
 * that inherits no PATH cannot run at all.
 */
const SEAM = new Map<string, string>([
  // `context.home ?? homedir()`, `context.env ?? process.env`,
  // `context.cwd ?? process.cwd()` — ambient only as the default when the caller
  // named nothing, which is what lets every test pass a temp home instead.
  [join("src", "exec", "registry.ts"), "resolves a backend's context; ambient is the default"],
  // `options.host ?? process.env["OLLAMA_HOST"]` — the local route's address,
  // which is configuration and has nowhere else to come from.
  [join("src", "exec", "ollama-exec.ts"), "OLLAMA_HOST, when no host was passed"],
  // Hands `process.env` to the vendor CLI it spawns. Without it the child has no
  // PATH and no vendor credentials, so there is no turn to record.
  [join("src", "exec", "cli-exec.ts"), "the environment the child process needs"],
  // Owns the scrubbed environment and isolated home of the two vendor CLIs
  // that talk only to LiteLLM on this machine. Tests supply both as values.
  [join("src", "exec", "local-cli.ts"), "the isolated local vendor child environment"],
]);

/** Every ambient read of identity or configuration in one file. */
function ambientReads(path: string, source: string): string[] {
  return [
    ...memberReads(path, source, "process", AMBIENT_MEMBERS),
    ...globalsUsed(path, source, ["homedir"]),
    ...moduleSpecifiers(path, source)
      .filter((specifier) => HOME_MODULES.includes(specifier))
      .map((specifier) => `imports ${specifier}`),
  ];
}

describe("nothing under src/ reads the machine it is running on", () => {
  test("only the four files at the exec seam read a home, an env or a cwd", async () => {
    const files = await sourceFiles(SRC);
    // Guards the scope. Both halves matter: a count that silently went to zero,
    // and a scan that stopped reaching a particular file.
    expect(files.length).toBeGreaterThan(20);
    expect(files.map((path) => relative(ROOT, path))).toContain(INJECTED);

    const offenders: string[] = [];
    for (const path of files) {
      const rel = relative(ROOT, path);
      if (SEAM.has(rel)) continue;
      for (const hit of ambientReads(path, await readFile(path, "utf8"))) {
        offenders.push(`${rel}: ${hit}`);
      }
    }

    expect(
      offenders,
      "a file under src/ that reads homedir(), process.env or process.cwd() for itself cannot be " +
        "handed a temp home by a test, so the test either runs against the owner's real machine " +
        "or is never written (D-021). Take it as an argument, as src/state.ts and " +
        "src/soul/targets.ts do, and let bin/ or src/exec/registry.ts read it",
    ).toEqual([]);
  }, 30_000);

  test("each exempted file really is reading what its line says it reads", async () => {
    // An exemption whose reason is false is worse than none: it reads as a
    // decision and is a leftover. So every entry has to still be earning it.
    for (const [rel, reason] of SEAM) {
      const path = join(ROOT, rel);
      expect(ambientReads(path, await readFile(path, "utf8")), `${rel}: ${reason}`).not.toEqual([]);
    }
    expect(SEAM.size).toBe(4);
  });

  test("the two files that promise this in prose are telling the truth", async () => {
    // The comments this gate generalises. If one of them ever stops being true
    // the gate above fails too — this says which sentence to go and fix.
    for (const rel of [join("src", "state.ts"), join("src", "soul", "targets.ts")]) {
      const path = join(ROOT, rel);
      const source = await readFile(path, "utf8");
      expect(source).toContain("homedir()");
      expect(ambientReads(path, source), `${rel} says it reads neither`).toEqual([]);
    }
  });

  test("the control: the checker fires on each of the four ways in", () => {
    expect(ambientReads("x.ts", `const home = homedir();`)).toEqual([
      `1: homedir`,
    ]);
    expect(ambientReads("x.ts", `import { homedir } from "node:os";`)).toEqual([
      `1: homedir`,
      `imports node:os`,
    ]);
    expect(ambientReads("x.ts", `const k = process.env["KEY"];`)).toEqual([`1: process.env`]);
    expect(ambientReads("x.ts", `const here = process.cwd();`)).toEqual([`1: process.cwd`]);
  });

  test("the control: and not on prose, nor on the reads it allows on purpose", () => {
    // Every one of these appears in `src/` today, and a gate that called any of
    // them a violation would be a gate somebody turns off.
    const prose = `// Nothing here reads process.env or homedir()\nexport const x = 1;`;
    expect(ambientReads("x.ts", prose)).toEqual([]);
    expect(ambientReads("x.ts", `const temp = \`\${path}.tmp-\${process.pid}\`;`)).toEqual([]);
    expect(ambientReads("x.ts", `return hookCommand(process.execPath, Bun.main, existsSync);`)).toEqual([]);
    expect(ambientReads("x.ts", `const env = context.env;`)).toEqual([]);
    expect(ambientReads("x.ts", `import { join } from "node:path";`)).toEqual([]);
  });
});
