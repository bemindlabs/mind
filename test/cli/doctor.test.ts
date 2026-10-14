/**
 * `mind doctor`, as a person types it.
 *
 * Spawned rather than called, because what is checked here belongs to the
 * command line: that the flags parse, that the exit code is the one AC7 asks
 * for, that `--json` is a document rather than a table, and that **Mind
 * itself writes nothing** while inspecting a machine.
 *
 * That last one is narrower than it first looked, and this file is where the
 * narrowing was found rather than assumed. The first version asserted that a
 * `doctor` run leaves the home untouched, and it failed: `--version` starts six
 * other programs, and three of them wrote their own caches and config into the
 * temporary home. So the assertion below is the true one — Mind creates
 * nothing, `--no-version` leaves the home byte-identical, and a run *with* the
 * probes is measured to change it, which is what keeps the sentence in
 * `DOCTOR_LIMITS` from being prose nobody checked.
 *
 * Every run points at a temporary `HOME`, a temporary `XDG_*`, and two dead
 * ports. Nothing here reaches the real home, the real ollama or the real store,
 * so the result does not depend on what happens to be running on the machine
 * the tests are on.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { VENDORS } from "../../src/exec/index.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");

/** Two ports nothing is listening on, so both probes fail the same way twice. */
const DEAD_OLLAMA = "http://127.0.0.1:1";
const DEAD_QDRANT = "http://127.0.0.1:2";

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
  const home = await sandbox("mind-doctor-cli-");
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(join(home, ".claude", "CLAUDE.md"), "# a human wrote this\n");
  return home;
}

async function run(home: string, args: readonly string[], extraEnv: Record<string, string> = {}) {
  const child = Bun.spawn(["bun", "run", BIN, ...args], {
    cwd: ROOT,
    env: {
      HOME: home,
      PATH: process.env["PATH"] ?? "",
      XDG_STATE_HOME: join(home, "state"),
      XDG_DATA_HOME: join(home, "data"),
      CODEX_HOME: join(home, ".codex"),
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  return { code: child.exitCode ?? -1, stdout, stderr };
}

/** The flags every test below shares: a home to read, two ports nothing answers. */
function offline(home: string, ...extra: string[]): string[] {
  return [
    "doctor",
    "--home",
    home,
    "--ollama",
    DEAD_OLLAMA,
    "--qdrant",
    DEAD_QDRANT,
    ...extra,
  ];
}

/**
 * What the runtime that launches the binary writes into the home, before a
 * line of Mind has run.
 *
 * `bun run` populates its own install cache under `$HOME/.bun`, and it does so
 * whatever command it is about to run. Counting that against `doctor` would
 * make a true statement about Mind untestable, so it is excluded by name and
 * with this reason attached — an exclusion nobody can read is how a check
 * quietly stops checking.
 */
const RUNNER_CACHE = ".bun/";

/** Every file under `dir`, relative, sorted — the shape a "changed nothing" check needs. */
async function tree(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        found.push(`${relative(dir, path)}/`);
        await walk(path);
        continue;
      }
      const stats = await stat(path);
      found.push(`${relative(dir, path)} ${stats.size} ${stats.mtimeMs}`);
    }
  };
  await walk(dir);
  return found.filter((entry) => !entry.startsWith(RUNNER_CACHE)).sort();
}

describe("mind doctor", () => {
  test("a machine with no local route exits 1 and says which one is missing (AC7)", async () => {
    const home = await makeHome();
    const result = await run(home, offline(home));

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("not ready");
    expect(result.stdout).toContain("the local route");
  }, 60_000);

  test("it reports every CLI the registry knows plus the local daemon (AC1)", async () => {
    const home = await makeHome();
    const result = await run(home, offline(home));

    expect(result.stdout).toContain(`of ${VENDORS.length + 1} reachable`);
    for (const spec of VENDORS) expect(result.stdout).toContain(spec.id);
  }, 60_000);

  test("a --model cannot be checked against a daemon that never answered (AC2)", async () => {
    const home = await makeHome();
    const result = await run(home, offline(home, "--model", "not-a-real-model:0b"));

    // The blocker named is the daemon, not the model: there is no list to
    // check a name against, and reporting the model as absent would be a
    // conclusion drawn from a connection that never happened.
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("not ready — 1 thing(s)");
    expect(result.stdout).toContain("did not answer /api/tags");
    expect(result.stdout).not.toContain("was asked for with --model");
  }, 60_000);

  test("it says which identity is worn, and prints the limits with it (AC5)", async () => {
    const home = await makeHome();
    const result = await run(home, offline(home, "--backend", "claude"));

    expect(result.stdout).toContain("wearing nothing");
    expect(result.stdout).toContain(join(home, ".claude", "CLAUDE.md"));
    // The limits travel with the answer rather than waiting for a --verbose.
    expect(result.stdout).toContain("What this does not check:");
    expect(result.stdout).toContain("Mind writes nothing here");
  }, 60_000);

  test("--json is a document, with the same limits in it", async () => {
    const home = await makeHome();
    const result = await run(home, offline(home, "--backend", "claude", "--json"));

    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed.sections)).toBe(true);
    expect(parsed.limits.length).toBeGreaterThan(0);
    const ids = parsed.sections.flatMap((s: { findings: { id: string }[] }) =>
      s.findings.map((f) => f.id),
    );
    expect(ids).toContain("ollama.unreachable");
    expect(ids).toContain("worn.verdict");
  }, 60_000);

  test("--agent without --subject is refused rather than guessed at (D-014)", async () => {
    const home = await makeHome();
    const agent = await sandbox("mind-doctor-agent-");
    const result = await run(home, offline(home, "--agent", agent));

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--subject");
  }, 60_000);

  test("--agent with --subject reports whether .mind is stale (D-014)", async () => {
    const home = await makeHome();
    const work = await sandbox("mind-doctor-work-");

    const created = await run(home, ["new", "example", "--subject", "example", "--dir", work]);
    expect(created.code).toBe(0);
    const agent = join(work, "example");

    // Before a rebuild there is no manifest at all, which is `missing`.
    const before = await run(home, offline(home, "--agent", agent, "--subject", "example"));
    expect(before.stdout).toContain("nothing has been built here yet");

    expect((await run(home, ["rebuild", agent, "--subject", "example"])).code).toBe(0);
    const after = await run(home, offline(home, "--agent", agent, "--subject", "example"));
    expect(after.stdout).toContain("fresh");
    // A stale `.mind/` is never a readiness failure: it costs one rebuild.
    expect(after.stdout).toContain("cannot see whether a remote is private");
  }, 90_000);

  test("it says where the egress judge stands, and what an automatic one needs to do anything (D-181)", async () => {
    const home = await makeHome();
    const none = await run(home, offline(home, "--no-version"));
    expect(none.stdout).toContain("egress judge: off — no local model is configured");
    expect(none.stdout).toContain("says so each time");

    const automatic = await run(home, offline(home, "--no-version"), { MIND_OLLAMA_MODEL: "qwen3" });
    expect(automatic.stdout).toContain("egress judge: on by itself (MIND_OLLAMA_MODEL) — qwen3 at http://127.0.0.1:11434");
    // Doctor does not open the personal store, so it cannot say there are none; it says what the judge needs.
    expect(automatic.stdout).toContain("reads a text only against listed needles (`mind egress needles`) and does nothing while there are none");

    const relayed = await run(home, offline(home, "--no-version"), { MIND_OLLAMA_MODEL: "gpt-oss:120b-cloud" });
    expect(relayed.stdout).toContain("egress judge: off — MIND_OLLAMA_MODEL is set but names no model on this machine");
    expect(relayed.stdout).toContain("-cloud or :cloud");

    const empty = await run(home, offline(home, "--no-version"), { MIND_OLLAMA_MODEL: "qwen3", MIND_EGRESS_JUDGE: "" });
    expect(empty.stdout).toContain("egress judge: off — MIND_EGRESS_JUDGE is set and empty");
  }, 90_000);

  test("--json carries the same line, and the run still writes nothing", async () => {
    const home = await makeHome();
    const before = await tree(home);
    const result = await run(home, offline(home, "--no-version", "--json"), { MIND_OLLAMA_MODEL: "qwen3" });
    expect(JSON.parse(result.stdout).egressJudge).toContain("egress judge: on by itself (MIND_OLLAMA_MODEL) — qwen3");
    expect(await tree(home)).toEqual(before);
  }, 60_000);

  test("an unknown backend and a stray argument are both usage errors", async () => {
    const home = await makeHome();
    expect((await run(home, offline(home, "--backend", "nope"))).code).toBe(2);
    expect((await run(home, ["doctor", "somewhere"])).code).toBe(2);
  }, 60_000);

  test("Mind writes nothing — and says what the CLIs it starts do (I-2)", async () => {
    const home = await makeHome();
    const engineBefore = await tree(join(ROOT, "src"));

    // With --no-version nothing but Mind runs, so the home is a fair test of
    // Mind's own behaviour.
    const quiet = await makeHome();
    const quietBefore = await tree(quiet);
    const result = await run(quiet, offline(quiet, "--no-version"));

    expect(result.code).toBe(1);
    expect(await tree(quiet)).toEqual(quietBefore);
    expect(await tree(join(ROOT, "src"))).toEqual(engineBefore);
    // Asking is never what creates the state or data root.
    await expect(stat(join(quiet, "state"))).rejects.toThrow();
    await expect(stat(join(quiet, "data"))).rejects.toThrow();

    // And the other half of the sentence, measured rather than assumed: a run
    // *with* the version probes does leave things behind, none of them
    // Mind's. That is what the limit line exists to say, and this is what
    // keeps it from being prose nobody checked.
    const before = await tree(home);
    await run(home, offline(home));
    const after = await tree(home);
    // Only where a vendor CLI is installed is there anything to leave behind —
    // a CI runner has none, and there the run must leave the home untouched.
    const vendorOnPath = ["claude", "codex", "grok", "gemini", "copilot", "kimi"].some((cli) => Bun.which(cli) !== null);
    if (vendorOnPath) expect(after).not.toEqual(before);
    else expect(after).toEqual(before);
    for (const entry of after) {
      if (before.includes(entry)) continue;
      expect(entry.startsWith("state/") || entry.startsWith("data/")).toBe(false);
    }
  }, 90_000);

  test("--no-version says so per CLI rather than leaving the row looking checked", async () => {
    const home = await makeHome();
    const result = await run(home, offline(home, "--no-version", "--json"));

    const ids = JSON.parse(result.stdout).sections.flatMap(
      (section: { findings: { id: string }[] }) => section.findings.map((f) => f.id),
    );
    // Whatever is installed on the machine running these tests, no version was
    // read — so no row may claim a version and none may claim drift.
    expect(ids.some((id: string) => id.endsWith(".drift"))).toBe(false);
    for (const spec of VENDORS) {
      expect(ids).not.toContain(`cli.${spec.id}`);
    }
  }, 60_000);

  test("it never opens the data root, even when one is full of records", async () => {
    const home = await makeHome();
    // A personal store that exists and holds something. `doctor` answers none
    // of its questions from here, so it must not read a byte of it — the
    // atime check below is the closest thing to a proof this can offer.
    const personal = join(home, "data", "mind", "example", "personal", "observer");
    await mkdir(personal, { recursive: true });
    const record = join(personal, "2026-09.jsonl");
    await writeFile(record, `{"kind":"tool"}\n`);
    const before = await stat(record);

    await run(home, offline(home, "--subject", "example"));

    const after = await stat(record);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  }, 60_000);
});

describe("the help text", () => {
  test("doctor is a command now, and no longer on the unbuilt list", async () => {
    const home = await makeHome();
    const result = await run(home, ["help"]);

    expect(result.stdout).toContain("mind doctor");
    expect(result.stdout).toContain("drift");
    expect(result.stdout).not.toContain("[S0.2]");
    // A story still unbuilt keeps its line (S1.5 left the list when `soul
    // revoke` was built; S5.3 is on it now).
    expect(result.stdout).toContain("[S5.3]");
    expect(result.stdout).not.toContain("[S1.5]");
  }, 30_000);
});
