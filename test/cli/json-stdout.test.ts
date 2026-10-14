/**
 * `--json` means stdout is a document — asked of every command that takes it,
 * through a pipe a person could have typed.
 *
 * ## Why this file exists at all
 *
 * As of 2026-09-22 this repository had 1331 tests and `scripts/cli-parity.ts`
 * had 128 invocations across its matrix, and **not one of them read the CLI the
 * way a human reads it**. Every single one starts the engine with
 * `Bun.spawn({ stdout: "pipe" })`, which is not a shell pipeline: measured under
 * bun 1.4.2, one `console.log` of 20001 bytes arrives whole through `Bun.spawn`
 * and can arrive cut to 8192 bytes — silently, with no error and no short write
 * reported anywhere — through `sh -c '… | cat'`, once anything in the process
 * has read `process.stdout`. Whether it is cut at all depends on how busy the
 * machine is (the numbers, and a fresh measurement on every run, are in
 * `test/cli/streams.test.ts`), which is its own hazard: it is fine on the
 * laptop and short in CI. `bin/shared.ts` read `process.stdout.isTTY` at
 * import, so that was every command, and `mind help | less` showed 8192 of
 * its 17363 bytes with the last visible line being `erase`'s usage.
 *
 * So the question "does `--json` produce JSON?" had been asked of six of the
 * seven commands that take the flag — and asked in a way that could not have
 * found this. The seventh was `erase`, and it was not an oversight either:
 * `test/cli/erase.test.ts` and `test/odd2/free-pass.test.ts` wrote
 * `JSON.parse(stdout.slice(stdout.indexOf("{")))`, which is a test shaped around
 * the bug rather than a test that reports it. That idiom arrived with S7.2's
 * first commit and was copied twice more.
 *
 * Both of those are why every row below goes through {@link runThroughPipe},
 * and why two of the rows assert that the output they just parsed was **over
 * 8192 bytes**: a guard that only ever measured short output would be green on
 * a runtime that still cuts long output, which is the failure this file is here
 * to make impossible. Those two rows are safe to assert — they say the whole
 * document arrived, which held in every condition measured once the engine
 * stopped reading the getter. What the getter *does* is load-dependent and is
 * therefore reported rather than asserted, over in `test/cli/streams.test.ts`.
 *
 * ## What "a document" means, and the two answers that are allowed
 *
 * Under `--json`, stdout is either:
 *
 * - one JSON document, parseable **whole** — `JSON.parse(stdout)`, no slicing,
 *   no scanning for a brace; or
 * - empty, with a non-zero exit code, for a command line the CLI would not run.
 *
 * Everything a human would want to read goes to stderr. `observe actions` has
 * done this since it was written (`say()` in `bin/commands/observe.ts`) and is
 * the shape the others are held to.
 *
 * ## Why a new command goes red by itself
 *
 * The sites are found by walking each file's syntax tree for an array literal
 * holding `"json"` — which catches both `parseArgs(argv, ["json", …])` and a
 * named constant like `WORN_BOOLEANS`. A file with such a list and no row in
 * {@link ROWS} is reported as `unasked`, and a row naming a file that no longer
 * declares the flag is reported too. Neither can be satisfied by editing this
 * comment.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { USAGE } from "../../bin/usage.ts";
import { arrayLiteralsContaining, sourceFiles } from "../support/ast.ts";
import { barePath, BUN, expectNoVendorOn } from "../support/bare-path.ts";
import { runThroughPipe } from "../support/real-pipe.ts";
import { GIT_ENV, REAL_GIT } from "../support/trap-git.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const COMMANDS = join(ROOT, "bin", "commands");
const SOUL = join(ROOT, "test", "fixtures", "soul-valid");
const SUBJECT = "example";

/** A port nothing listens on, so no probe in `doctor` can reach a service. */
const DEAD = "http://127.0.0.1:1";

/**
 * The size a row has to beat to have proved anything about the cut.
 *
 * One byte past the largest truncated output ever measured here: every run that
 * lost bytes came back at exactly 8192, whatever was asked for. A row under
 * this would parse on a runtime that cuts long output and on one that does not,
 * and so would say nothing.
 */
const OVER_THE_CUT = 8193;

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A sandbox, and the two ways to run the engine in it
// ---------------------------------------------------------------------------

interface Sandbox {
  readonly home: string;
  readonly path: string;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * A temporary HOME, and a PATH holding `bun` and `git` and nothing else.
 *
 * `git` is there because `new`, `rebuild` and `erase` all really run one.
 * `sh` and `cat` are deliberately *not*: {@link runThroughPipe} resolves both
 * absolutely, so the engine still runs with no vendor CLI within reach (I-1)
 * even while the test around it is building a pipeline.
 */
async function sandbox(): Promise<Sandbox> {
  const home = await mkdtemp(join(tmpdir(), "mind-json-home-"));
  scratch.push(home);
  const path = await barePath(home);
  await symlink(REAL_GIT, join(path, "git")).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code !== "EEXIST") throw cause;
  });
  expectNoVendorOn(path);
  return {
    home,
    path,
    env: {
      HOME: home,
      PATH: path,
      XDG_STATE_HOME: join(home, "state"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_CONFIG_HOME: join(home, "config"),
      CODEX_HOME: join(home, ".codex"),
      USER: "the-test",
      ...GIT_ENV,
    },
  };
}

/** Setup only: an ordinary spawn, because nothing here is being measured. */
async function setup(box: Sandbox, argv: readonly string[]): Promise<void> {
  const child = Bun.spawn([BUN, "run", BIN, ...argv], {
    cwd: box.home,
    env: box.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  await new Response(child.stdout).text();
  await child.exited;
  expect(child.exitCode, `setup failed: mind ${argv.join(" ")}\n${stderr}`).toBe(0);
}

/**
 * A first commit, made by the real git as a person would: `deploy plan` refuses
 * a repository a clone would carry nothing of. The pre-commit hook `new`
 * installed runs too, with this sandbox's PATH.
 */
async function commitIn(box: Sandbox, dir: string): Promise<void> {
  for (const argv of [["add", "-A"], ["commit", "-q", "-m", "first"]]) {
    const child = Bun.spawn([REAL_GIT, ...argv], { cwd: dir, env: box.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(child.stderr).text();
    await new Response(child.stdout).text();
    await child.exited;
    expect(child.exitCode, `git ${argv.join(" ")}\n${stderr}`).toBe(0);
  }
}

/** An agent repository with all three soul places on disk. */
async function agentIn(box: Sandbox): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "mind-json-agents-"));
  scratch.push(parent);
  await setup(box, ["new", SUBJECT, "--subject", SUBJECT, "--dir", parent]);
  const agent = join(parent, SUBJECT);
  await setup(box, ["rebuild", agent, "--subject", SUBJECT]);
  return agent;
}

// ---------------------------------------------------------------------------
// The table: one row per way of reaching a `--json` site
// ---------------------------------------------------------------------------

interface Row {
  /** The file under `bin/commands/` whose flag list this row is about. */
  readonly file: string;
  readonly id: string;
  /** The exit code this row must keep. `--json` moves bytes, never codes. */
  readonly code: number;
  /** `document` — stdout parses whole. `empty` — stdout is zero bytes. */
  readonly stdout: "document" | "empty";
  /** Set where the row is also the proof that a long document survives a pipe. */
  readonly atLeast?: number;
  readonly build: (box: Sandbox) => Promise<readonly string[]>;
}

const ROWS: readonly Row[] = [
  {
    file: "doctor.ts",
    id: "doctor --json",
    code: 1,
    stdout: "document",
    // The longest report any command prints without being given data first,
    // and the one that made the truncation visible outside `erase`.
    atLeast: OVER_THE_CUT,
    build: async () => ["doctor", "--json", "--no-version", "--ollama", DEAD, "--qdrant", DEAD],
  },
  {
    file: "worn.ts",
    id: "worn --json",
    code: 1,
    stdout: "document",
    build: async () => ["worn", "--json"],
  },
  {
    file: "soul.ts",
    id: "soul verify --json",
    code: 1,
    stdout: "document",
    build: async () => ["soul", "verify", SOUL, "--subject", SUBJECT, "--runs", "1", "--json"],
  },
  {
    file: "turn.ts",
    id: "turn --json",
    code: 1,
    stdout: "document",
    build: async () => ["turn", SOUL, "--subject", SUBJECT, "--prompt", "a question", "--json"],
  },
  {
    file: "ledger.ts",
    id: "ledger show --json",
    code: 0,
    stdout: "document",
    build: async () => ["ledger", "show", "--subject", SUBJECT, "--json"],
  },
  {
    file: "observe.ts",
    id: "observe actions --json",
    code: 0,
    stdout: "document",
    build: async () => ["observe", "actions", "--subject", SUBJECT, "--json"],
  },
  {
    file: "persona.ts",
    id: "persona show --json (no draft)",
    code: 0,
    stdout: "document",
    build: async () => ["persona", "show", "--subject", SUBJECT, "--json"],
  },
  {
    file: "memory.ts",
    id: "memory distill show --json (no draft)",
    code: 0,
    stdout: "document",
    build: async () => ["memory", "distill", "show", "--subject", SUBJECT, "--json"],
  },
  {
    file: "memory.ts",
    id: "memory ask --json (an empty question)",
    code: 2,
    // Refused before anything is read: the usage line goes to stderr, and stdout stays empty rather than half an answer.
    stdout: "empty",
    build: async () => ["memory", "ask", SOUL, "--subject", SUBJECT, "--json", "   "],
  },
  {
    file: "eval.ts",
    id: "eval --json (no task set)",
    code: 1,
    // No evals.md beside the fixture soul: the refusal goes to stderr and
    // stdout stays empty rather than half a document.
    stdout: "empty",
    build: async () => ["eval", SOUL, "--subject", SUBJECT, "--json"],
  },
  {
    file: "proposal.ts",
    id: "proposal list --json",
    code: 0,
    stdout: "document",
    // An empty store rather than a seeded one: the document has to parse whole
    // on the machine that has never filed a proposal too, and the refusals this
    // command prints on every run go to stderr, where a `| jq` cannot see them.
    build: async () => ["proposal", "list", SOUL, "--subject", SUBJECT, "--json"],
  },
  {
    file: "erase.ts",
    id: "erase --json, a dry run",
    code: 0,
    stdout: "document",
    // The certificate is ~14 KB, which is the whole reason B had to be fixed
    // here: "the certificate parses" is false through a pipe without it.
    atLeast: OVER_THE_CUT,
    build: async (box) => [
      "erase",
      SUBJECT,
      "--agent",
      await agentIn(box),
      "--by",
      "a reviewer",
      "--json",
    ],
  },
  {
    file: "erase.ts",
    id: "erase --yes --json",
    code: 0,
    stdout: "document",
    atLeast: OVER_THE_CUT,
    build: async (box) => [
      "erase",
      SUBJECT,
      "--agent",
      await agentIn(box),
      "--by",
      "a reviewer",
      "--yes",
      "--json",
    ],
  },
  {
    file: "erase.ts",
    id: "erase --yes --json --out, over a subject this machine never held",
    // Three, and it stays three: the document is not a certificate of erasure
    // and `&&` must not read it as one (S7.2 AC6).
    code: 3,
    stdout: "document",
    build: async (box) => [
      "erase",
      "never-existed",
      "--no-agent",
      "--by",
      "a reviewer",
      "--yes",
      "--json",
      "--out",
      join(box.home, "certificate.json"),
    ],
  },
  {
    file: "deploy.ts",
    id: "deploy plan --json",
    code: 0,
    stdout: "document",
    // ~25 KB: every command, every unit file, every limit — past the cut.
    atLeast: OVER_THE_CUT,
    build: async (box) => {
      const agent = await agentIn(box);
      await commitIn(box, agent);
      const target = join(box.home, "target.json");
      await Bun.write(target, JSON.stringify({ name: "vps-1", provider: "ssh", ssh: { host: "203.0.113.10", user: "deploy" } }));
      return ["deploy", "plan", agent, "--subject", SUBJECT, "--target", target, "--json"];
    },
  },
  {
    file: "deploy.ts",
    id: "deploy plan --json with a command line the CLI will not run",
    code: 2,
    stdout: "empty",
    build: async () => ["deploy", "plan", "--json"],
  },
  {
    file: "usage.ts",
    id: "usage report --json",
    code: 0,
    stdout: "document",
    // The signed envelope alone; what a person reads — the totals, what was left out — is on stderr.
    build: async (box) => {
      await setup(box, ["key", SOUL, "--subject", SUBJECT]);
      return ["usage", "report", SOUL, "--subject", SUBJECT, "--json"];
    },
  },
  {
    file: "usage.ts",
    id: "usage prices --json",
    code: 0,
    stdout: "document",
    // The tables in force — the shipped one, and where the owner's would be (S15.9).
    build: async () => ["usage", "prices", "--json"],
  },
  {
    file: "usage.ts",
    id: "usage report --json with no key to sign with",
    // Nothing on stdout: an unsigned report is not a report, and half of one would be worse.
    code: 1,
    stdout: "empty",
    build: async () => ["usage", "report", SOUL, "--subject", SUBJECT, "--json"],
  },
  {
    file: "key.ts",
    id: "key prove --json",
    code: 0,
    stdout: "document",
    // The signed proof alone (D-141); what a person reads — the market, listing and nonce it names — is on stderr.
    build: async (box) => {
      await setup(box, ["key", SOUL, "--subject", SUBJECT]);
      return ["key", "prove", SOUL, "--subject", SUBJECT, "--market", "https://market.example", "--listing", "ts-reviewer", "--nonce", "A".repeat(43), "--json"];
    },
  },
  {
    file: "key.ts",
    id: "key prove --json with no key to sign with",
    // Nothing on stdout: a proof is never made with a key made for it, and there is none.
    code: 1,
    stdout: "empty",
    build: async () => ["key", "prove", SOUL, "--subject", SUBJECT, "--market", "https://market.example", "--listing", "ts-reviewer", "--nonce", "A".repeat(43), "--json"],
  },
  {
    file: "key.ts",
    id: "key prove --json with a market that is not an origin",
    code: 2,
    stdout: "empty",
    build: async () => ["key", "prove", SOUL, "--subject", SUBJECT, "--market", "https://market.example/", "--listing", "ts-reviewer", "--nonce", "A".repeat(43), "--json"],
  },
  {
    file: "task.ts",
    id: "task list --json with no tasks",
    code: 0,
    stdout: "document",
    build: async () => ["task", "list", SOUL, "--subject", SUBJECT, "--json"],
  },
  {
    file: "task.ts",
    id: "task show --json of a task that does not exist",
    code: 2,
    stdout: "empty",
    build: async () => ["task", "show", "t-11111111", SOUL, "--subject", SUBJECT, "--json"],
  },
  {
    file: "task.ts",
    id: "task stop --json of a task that does not exist",
    code: 2,
    stdout: "empty",
    build: async () => ["task", "stop", "t-11111111", SOUL, "--subject", SUBJECT, "--json"],
  },
  {
    file: "task.ts",
    id: "task new --json with no goal",
    code: 2,
    stdout: "empty",
    build: async () => ["task", "new", SOUL, "--subject", SUBJECT, "--json"],
  },
  {
    file: "task.ts",
    id: "task approve --json not at a terminal",
    code: 4,
    stdout: "empty",
    build: async () => ["task", "approve", "t-11111111", "a-11111111-2222-4333-8444-555555555555", SOUL, "--subject", SUBJECT, "--json"],
  },
  {
    file: "task.ts",
    id: "task deny --json not at a terminal",
    code: 4,
    stdout: "empty",
    build: async () => ["task", "deny", "t-11111111", "a-11111111-2222-4333-8444-555555555555", SOUL, "--subject", SUBJECT, "--json"],
  },
  {
    file: "task.ts",
    id: "task resume --json of a task that does not exist",
    code: 2,
    stdout: "empty",
    build: async () => ["task", "resume", "t-11111111", SOUL, "--subject", SUBJECT, "--json"],
  },
  {
    file: "browser.ts",
    id: "browser status --json where there is no docker",
    // This sandbox's PATH has bun and git only: the answer is still one document, and says why.
    code: 1,
    stdout: "document",
    build: async () => ["browser", "status", "--json"],
  },
  {
    file: "browser.ts",
    id: "browser up --json where there is no docker",
    code: 1,
    stdout: "document",
    build: async () => ["browser", "up", "--subject", SUBJECT, "--allow", "https://example.com", "--json"],
  },
  {
    file: "browser.ts",
    id: "browser up --json with an allowlist the CLI will not take",
    code: 2,
    stdout: "empty",
    build: async () => ["browser", "up", "--subject", SUBJECT, "--allow", "https://*.example.com", "--json"],
  },
  {
    file: "browser.ts",
    id: "browser down --json where there is no docker",
    code: 1,
    stdout: "document",
    build: async () => ["browser", "down", "t-none", "--json"],
  },
  {
    file: "browser.ts",
    id: "browser mcp-config --json for a task that is not up",
    code: 1,
    stdout: "empty",
    build: async () => ["browser", "mcp-config", "t-none", "--vendor", "claude", "--json"],
  },
  {
    file: "erase.ts",
    id: "erase --json with a command line the CLI will not run",
    // Nothing on stdout at all: a usage error has no document to give, and
    // printing half of one would be worse than printing none.
    code: 2,
    stdout: "empty",
    build: async () => ["erase", SUBJECT, "--json"],
  },
];

// ---------------------------------------------------------------------------
// Discovery — which commands take the flag, according to the tree
// ---------------------------------------------------------------------------

/** Every file under `bin/commands/` that declares `--json` in a flag list. */
async function sitesOnDisk(): Promise<Map<string, string[]>> {
  const sites = new Map<string, string[]>();
  for (const path of await sourceFiles(COMMANDS)) {
    const hits = arrayLiteralsContaining(path, await Bun.file(path).text(), "json");
    if (hits.length > 0) sites.set(relative(COMMANDS, path), hits);
  }
  return sites;
}

describe("every command that takes --json is asked about it here", () => {
  test("the scan finds the flag lists, and finds more than a couple", async () => {
    const sites = await sitesOnDisk();
    // A discovery that silently went empty would make both directions below
    // vacuously true, which is the failure mode of every whole-tree check here.
    expect(sites.size).toBeGreaterThan(4);
    expect([...sites.keys()]).toContain("erase.ts");
    expect([...sites.keys()]).toContain("observe.ts");
  });

  test("a site with no row is `unasked`, which is how a new command goes red", async () => {
    const sites = await sitesOnDisk();
    const asked = new Set(ROWS.map((row) => row.file));
    const unasked = [...sites.keys()].filter((file) => !asked.has(file)).sort();
    expect(
      unasked,
      "these files declare --json and no row below runs them. Add a row; do not add an " +
        "exception — the row is the only thing that proves the flag prints a document.",
    ).toEqual([]);
  });

  test("a row naming a file that no longer declares the flag is red too", async () => {
    const sites = await sitesOnDisk();
    const stale = [...new Set(ROWS.map((row) => row.file))].filter((file) => !sites.has(file)).sort();
    expect(stale, "these rows name a file with no --json flag list in it").toEqual([]);
  });

  test("the help text advertises the flag exactly as often as the tree declares it", async () => {
    // Counted per flag list, not per file: `usage.ts` declares it for two
    // subcommands (`report` and, since S15.9, `prices`), each with its own
    // list and its own line in the help.
    const sites = await sitesOnDisk();
    const declared = [...sites.values()].reduce((sum, hits) => sum + hits.length, 0);
    const advertised = USAGE.split("[--json]").length - 1;
    expect(advertised, "USAGE and bin/commands/ disagree about who takes --json").toBe(declared);
  });
});

// ---------------------------------------------------------------------------
// The rows, run through a pipe
// ---------------------------------------------------------------------------

describe("under --json, stdout is a document or it is empty", () => {
  for (const row of ROWS) {
    test(
      row.id,
      async () => {
        const box = await sandbox();
        const argv = await row.build(box);
        const ran = await runThroughPipe([BUN, "run", BIN, ...argv], {
          cwd: box.home,
          env: box.env,
        });

        expect(ran.code, `stderr:\n${ran.stderr}`).toBe(row.code);

        if (row.stdout === "empty") {
          expect(ran.stdout, "a usage error has no document to print").toBe("");
          return;
        }

        // Whole, from the first byte. Not `slice(indexOf("{"))` — that idiom is
        // what let this go unnoticed for three tasks, and it is banned in
        // test/cli/erase.test.ts and test/odd2/free-pass.test.ts as of odd3.
        const parsed = JSON.parse(ran.stdout) as Record<string, unknown>;
        expect(typeof parsed).toBe("object");

        if (row.atLeast !== undefined) {
          // Without this the row would be green on a runtime that cuts long
          // output: a short document survives the cut and proves nothing about
          // a long one. 8192 is what every truncated run under bun 1.4.2 came
          // back with, so 8193 is the smallest number that is evidence.
          expect(
            ran.stdout.length,
            `${row.id} printed ${ran.stdout.length} bytes, which is inside the 8192 bytes a cut ` +
              `run has always left behind, and therefore proves nothing about a pipe`,
          ).toBeGreaterThanOrEqual(row.atLeast);
        }
      },
      120_000,
    );
  }
});

// ---------------------------------------------------------------------------
// The control: the pipe is real, and it is what makes this file different
// ---------------------------------------------------------------------------

describe("the instrument", () => {
  test("`mind help` arrives whole, which through Bun.spawn was never in doubt", async () => {
    const box = await sandbox();
    const piped = await runThroughPipe([BUN, "run", BIN, "help"], { cwd: box.home, env: box.env });

    expect(piped.code).toBe(0);
    // Over the cut, so the assertion has something to be about, and ending
    // where the help text ends rather than mid-sentence at byte 8192.
    expect(piped.stdout.length).toBeGreaterThan(OVER_THE_CUT);
    // The line a piped reader used to stop just after, and the last line of the
    // text, which is 9132 bytes further on and was never reached.
    expect(piped.stdout).toContain("mind erase <subject>");
    expect(piped.stdout).toContain("mind soul revoke");
  }, 120_000);

  test("the code it reports is the engine's, not the one `cat` exited with", async () => {
    // Every row above asserts an exit code, and a pipeline's status is the
    // status of its *last* command — `cat`, which succeeds almost always. If
    // `runThroughPipe` read that instead of the engine's own, every code
    // assertion in this file would be an assertion about `cat`.
    const box = await sandbox();
    const unknown = await runThroughPipe([BUN, "run", BIN, "wat"], {
      cwd: box.home,
      env: box.env,
    });

    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain("unknown command");
    expect(unknown.stdout).toBe("");
  }, 120_000);
});
