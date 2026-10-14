/**
 * The demo script, checked for the things a demo run cannot check about itself.
 *
 * `scripts/demo-bare-container.sh` needs docker, a GPU and a pulled model, so
 * the run itself is not a unit test and is not pretended to be one — the
 * negative control inside the script is what stops that run from lying. What
 * *is* testable here, cheaply and hermetically, is the surface around it:
 *
 * - **Preflight refuses before it touches anything.** `--model` has no default
 *   (D-021), and a missing one has to exit 2 — "did not run" — before docker,
 *   git or a temporary directory is involved. Every assertion below runs the
 *   real script, so a future edit that moves an argument check after the first
 *   `docker` call fails here rather than on somebody's machine.
 * - **Nothing about one machine is written down.** No home path, no private
 *   address, no model id. The demo reads all three at run time, which is the
 *   only reason this script can live in a repository meant to be opened.
 * - **Cleanup cannot widen.** `docker system prune` and `docker rmi -f` would
 *   both pass a demo run and destroy somebody's unrelated containers, so their
 *   absence is pinned here rather than left to review.
 *
 * The last test reads `docs/demo.md` instead of the script. The limits that
 * document states — the clone runs on the host, and the demo does not prove
 * there is no egress — are the two claims a reader is most likely to overstate
 * on Mind's behalf, and a document that quietly loses them is worse than one
 * that never had them.
 */

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

import { PROOFS, PROVED_OTHERWISE, sha256 } from "../../scripts/check-coverage.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "scripts", "demo-bare-container.sh");
const REL = "scripts/demo-bare-container.sh";
const DOC = join(ROOT, "docs", "demo.md");

async function runDemo(args: readonly string[]): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = Bun.spawn(["bash", SCRIPT, ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  return { exitCode: child.exitCode ?? -1, stdout, stderr };
}

describe("the demo script refuses before it runs anything", () => {
  test("npm run demo points at a script that is there", async () => {
    const manifest = await Bun.file(join(ROOT, "package.json")).json();
    expect(manifest.scripts.demo).toBe("bash scripts/demo-bare-container.sh");
    expect(await Bun.file(SCRIPT).exists()).toBe(true);
  });

  test("no --model is exit 2, not a failed demo", async () => {
    const result = await runDemo([]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--model is required");
    // Nothing was started, so nothing needs cleaning up.
    expect(result.stdout).not.toContain("container");
  });

  test("an unknown argument is exit 2 and prints the usage", async () => {
    const result = await runDemo(["--backend", "ollama"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown argument --backend");
    expect(result.stderr).toContain("usage:");
  });

  test("--model with no value does not loop forever", async () => {
    // An argument parser that `shift 2`s past the end and carries on reading
    // the same token never returns, and a demo that hangs looks like a slow
    // GPU rather than a bug.
    const result = await runDemo(["--model"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("needs a value");
  });

  test("--help explains all three exit codes", async () => {
    const result = await runDemo(["--help"]);
    expect(result.exitCode).toBe(0);
    for (const meaning of ["0 proven", "1 ran and did not pass", "2 did not run"]) {
      expect(result.stdout).toContain(meaning);
    }
  });
});

describe("the demo carries no facts about one machine (D-021)", () => {
  test("no home directory, no private address, no model id", async () => {
    const source = await Bun.file(SCRIPT).text();

    expect(source).not.toMatch(/\/(?:home|Users)\//);
    // Loopback is used on purpose — the negative control points at a port
    // nobody listens on — so only routable private ranges are forbidden.
    expect(source).not.toMatch(/\b(?:10|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(source).not.toMatch(/\b(?:qwen|gemma|llama|mistral|typhoon|phi\d)\b/i);
  });

  test("the model id is read from the command line, and the ollama address from docker", async () => {
    const source = await Bun.file(SCRIPT).text();
    expect(source).toContain("docker network inspect bridge");
    expect(source).toContain('"--model is required and has no default"');
  });
});

describe("cleanup cannot reach anything the demo did not create", () => {
  test("no prune, no name pattern, no forced image removal", async () => {
    const source = await Bun.file(SCRIPT).text();

    expect(source).not.toMatch(/docker[^\n]*\bprune\b/);
    expect(source).not.toMatch(/docker\s+rmi\s+-f/);
    // Containers are removed by the id `docker run` handed back, so a stray
    // container belonging to somebody else can never match.
    expect(source).toContain('docker rm -f "$CID"');
  });

  test("the run is labelled, and the label is only ever read", async () => {
    const source = await Bun.file(SCRIPT).text();
    expect(source).toContain('--label "mind.demo=${RUN_ID}"');
    // The label is used to assert nothing survived — never as a delete filter.
    expect(source).not.toMatch(/docker\s+rm[^\n]*--filter/);
  });
});

/**
 * What the two criteria added in dod1 are, read off the script.
 *
 * None of this can say the demo *passed* — that is the proof record's job, and
 * the limits of that are stated below. What it can say is that the script still
 * asks the questions those criteria are named after, because each of them has a
 * cheaper shape that would keep the row and lose the evidence:
 *
 * - `erase` asked in **one** direction. A command whose verdict is a constant
 *   passes either direction alone; only both together can fail.
 * - the typechange **assumed** rather than asserted. If git stops reporting `T`
 *   for a symlink replaced by a file, the case that escaped `100b791` is no
 *   longer the case being run, and a block would be a pass for another reason.
 * - a literal token in the file. The demo needs a string that trips a scan
 *   rule; writing one down would put a token-shaped string in a repository
 *   meant to be opened, and Mind's own guard would block the commit.
 * - a control counted as a criterion. The number would grow while the evidence
 *   stayed where it was.
 */
describe("the demo still asks what its criteria are named after", () => {
  test("erase is asked in both directions, in the same container", async () => {
    const source = await Bun.file(SCRIPT).text();
    expect(source).toContain("--no-agent");
    expect(source).toContain('--agent /agent');
    // And the certificate is read for the state the container is really in:
    // no git, which must not arrive as a commit count of zero.
    expect(source).toContain('"no-git"');
  });

  test("the typechange is asserted before it is relied on", async () => {
    const source = await Bun.file(SCRIPT).text();
    expect(source).toContain("--name-status");
    expect(source).toMatch(/\^T\[\[:space:\]\]/);
  });

  test("no token is written down; the one it uses is built from the run id", async () => {
    const source = await Bun.file(SCRIPT).text();
    expect(source).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/);
    expect(source).not.toMatch(/\bsk-[A-Za-z0-9]{20,}\b/);
    expect(source).toContain('GUARD_TOKEN="ghp_${RUN_ID}');
  });

  test("controls are reported and not counted", async () => {
    const source = await Bun.file(SCRIPT).text();
    const rows = source.match(/^record "PASS"/gm) ?? [];
    // 12 from MVP-lite, 1 for the guard, 2 for the two erase directions. If a
    // control is ever promoted to a row this number moves and the reason has to
    // be written down here.
    expect(rows).toHaveLength(15);
    // Controls report through `note` and abort the whole run when they fail.
    expect(source).toMatch(/note "control:/);
    expect(source).not.toMatch(/record "PASS" "\$(?:GUARD|ERASE)_CONTROLS"/);
    expect(source).toContain('abort "$GUARD_CONTROLS"');
    expect(source).toContain('abort "$ERASE_CONTROLS"');
  });

  test("the guard row says, in the output, that it was proved on the host", async () => {
    const source = await Bun.file(SCRIPT).text();
    // A reader of the table must not have to open docs/demo.md to learn that
    // one of the fifteen was not proved in the bare container.
    const row = source.match(/^record "PASS" "\$GUARD_CRITERION" "(.*)"$/m);
    expect(row, "the guard criterion no longer records a row").not.toBeNull();
    expect(row![1]).toContain("host");
    expect(source).toContain("on the host)");
  });

  test("the zero grep returns inside .git is printed with what it is worth", async () => {
    const source = await Bun.file(SCRIPT).text();
    // GIT_UNDELETABLE is printed on every erase; a bare `0` from grepping a
    // pack file would read as the opposite, so the script says why it is not
    // evidence rather than leaving the number to speak.
    expect(source).toContain("compressed");
    expect(source).toContain("/agent/.git");
  });
});

/**
 * The question this file is asked on the coverage gate's behalf.
 *
 * `bun test --coverage` cannot see a line of bash, and the run this script
 * exists for needs docker, a GPU and a pulled model — so it can never be a unit
 * test, and the gate over `scripts/` has to ask it something else. What it asks
 * is **"has this been edited since the run that proved it?"**, answered by a
 * digest recorded beside the date and the result.
 *
 * Say the limits, because they are large and the assertions below look strong:
 *
 *   - a digest can be updated by hand without the run being redone. It is an
 *     honour system, exactly as the numbers in `SPAWN_ONLY` are. What it buys
 *     is that the edit cannot be *silent*;
 *   - an unchanged digest says nothing about today. `src/` can move underneath
 *     this script and break the demo without a byte of it changing, and nothing
 *     that fits inside `bun test` would notice.
 *
 * `bash -n` is the one thing here that is not on trust: it parses the real file
 * and would catch the class of edit — an unclosed `if`, a stray `fi` — that a
 * digest update can wave through by accident.
 */
describe("the demo is the file that was proved, and is still a script", () => {
  test("the gate asks this file a question, and names this file as the asker", () => {
    const asked = PROVED_OTHERWISE.get(REL);
    expect(asked, `${REL} is not in PROVED_OTHERWISE — the gate would fail it as unasked`).toBeDefined();
    expect(asked!.by).toBe("test/scripts/demo.test.ts");
  });

  test("its bytes are the ones the recorded run was done on", async () => {
    const proof = PROOFS.get(REL);
    expect(proof, `${REL} has a question but no proof record`).toBeDefined();
    expect(sha256(await Bun.file(SCRIPT).text()), `re-run ${proof!.by} and update PROOFS`).toBe(
      proof!.sha256,
    );
  });

  test("the record says when, how and what came out, so it can be re-run by hand", () => {
    const proof = PROOFS.get(REL)!;
    expect(proof.provedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(proof.by).toContain("npm run demo");
    // The shape, not the number. `toContain("12/12")` was here until dod1 added
    // three criteria, and it went red on the commit that did the work properly
    // — a test pinning the spelling of a result rather than what the result
    // has to say, which is the same trap as the registry test that pinned an
    // argv and the certificate test that pinned `@1`. What the record has to
    // carry is a count of criteria in which every one passed; a run where some
    // failed is not a proof and must not be recorded as one.
    const scored = /(\d+)\/(\d+) criteri/.exec(proof.result);
    expect(scored, `the result should say "N/N criteria …", not ${JSON.stringify(proof.result)}`)
      .not.toBeNull();
    expect(scored![1], "a proof record may only hold a run where every criterion passed").toBe(
      scored![2],
    );
    // D-021: the run took a model on the command line and the record keeps it
    // that way. A model id written down here would be a fact about one machine
    // in a file meant to be opened — and the demo's own test forbids one in
    // the script for the same reason.
    expect(`${proof.by} ${proof.result}`).not.toMatch(/\b(?:qwen|gemma|llama|mistral|typhoon|phi\d)\b/i);
  });

  test("bash can still parse it — the one check here that is not on trust", async () => {
    const parsed = Bun.spawn(["bash", "-n", SCRIPT], { stdout: "pipe", stderr: "pipe" });
    const complaint = await new Response(parsed.stderr).text();
    await parsed.exited;
    expect(parsed.exitCode, complaint).toBe(0);
  });
});

describe("the documented limits are still documented", () => {
  test("docs/demo.md keeps the two claims a reader would overstate", async () => {
    const doc = await Bun.file(DOC).text();

    expect(doc).toContain("does not prove there is no egress");
    expect(doc).toMatch(/not\*? a firewall/);
    expect(doc).toContain("`git clone` runs on the host, not inside the container");
  });

  test("docs/demo.md states the same three exit codes the script does", async () => {
    const doc = await Bun.file(DOC).text();
    expect(doc).toContain("proven");
    expect(doc).toContain("ran, and did not pass");
    expect(doc).toContain("did not run");
  });
});
