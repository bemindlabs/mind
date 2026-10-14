/**
 * `mind proposal`, and the two things D-029 said had to be measured.
 *
 * ## The first: deleting this store changes exactly one thing
 *
 * D-022 says of the ledger that removing it must change *nothing*. This store
 * is the opposite case on purpose, and the difference is the whole reason it
 * exists separately: remove it and the agent forgets it was told no, which is
 * this store's job rather than a side effect. Both halves are measured here —
 * a refusal that stops a repeat, and stops stopping it once `rm -rf` has been
 * run; and a turn with no `--proposal` that is **byte-identical** before and
 * after, on stdout, on stderr through the declared normalisers, and on its exit
 * code. That second half is the shape `test/ledger/read-back.test.ts` uses for
 * the ledger, borrowed rather than reinvented, and it is what says the store is
 * not quietly in the path of ordinary work.
 *
 * ## The second: an approval is spent once
 *
 * `turn --proposal <id>` claims the approval at the check, before anything else
 * happens, and a second turn naming the same id is refused with 4 — including
 * one started at the same moment, since the claim is one exclusive step across
 * processes; and a turn that fails after its claim keeps it spent (D-144). The alternative — an
 * approval that keeps working — is how "I allowed it once" becomes "it has been
 * doing that ever since", and the owner decided against it on 2026-09-22.
 *
 * Nothing here touches the operator's home, spends a vendor turn, or reaches a
 * network: every run gets a temporary `HOME`, a `PATH` holding one symlink to
 * `bun` (checked by {@link expectNoVendorOn}), and a stub ollama on loopback.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROPOSALS_DIR, PROPOSAL_SCHEMA, REFILED_DIR, REFILE_SCHEMA } from "../../src/decide/proposals.ts";
import { monthFileName } from "../../src/ledger/store.ts";
import { allowedHosts, handler, TOKEN_HEADER, type WebDeps } from "../../src/web/server.ts";
import { barePath, BUN, expectNoVendorOn } from "../support/bare-path.ts";
import { serveOllama } from "../support/stub-ollama.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SOUL = join(ROOT, "test", "fixtures", "soul-valid");
const OTHER_SOUL = join(ROOT, "test", "fixtures", "soul-valid-b");
const SUBJECT = "example";

/** The subject `test/fixtures/soul-valid-b` really belongs to. */
const OTHER_SUBJECT = "other-example";

/** Exit 5 — already asked, and answered no (or still waiting). */
const REPEATED = 5;
/** Exit 4 — this machine has been told not to. Shared with the dial. */
const REFUSED = 4;

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Box {
  readonly home: string;
  readonly env: Record<string, string>;
}

async function sandbox(): Promise<Box> {
  const home = await mkdtemp(join(tmpdir(), "mind-proposal-cli-"));
  scratch.push(home);
  const bare = await barePath(home);
  expectNoVendorOn(bare);
  return {
    home,
    env: {
      HOME: home,
      PATH: bare,
      XDG_STATE_HOME: join(home, "state"),
      XDG_DATA_HOME: join(home, "data"),
      CODEX_HOME: join(home, ".codex"),
      // A port nothing answers on, so no probe can reach a model unless a case
      // hands over a stub's URL itself.
      OLLAMA_HOST: "http://127.0.0.1:1",
      // The same for the vector store, should anything ever ask it.
      MIND_QDRANT_URL: "http://127.0.0.1:9",
    },
  };
}

async function run(box: Box, args: readonly string[], over: Record<string, string> = {}) {
  const child = Bun.spawn([BUN, "run", BIN, ...args], {
    cwd: ROOT,
    env: { ...box.env, ...over },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  return { code: child.exitCode ?? -1, stdout, stderr };
}

/** `$XDG_DATA_HOME/mind/<subject>/personal/proposals`. */
function storeIn(box: Box, subject = SUBJECT): string {
  return join(box.home, "data", "mind", subject, "personal", PROPOSALS_DIR);
}

/** File one, and hand back the id it printed on stdout. */
async function file(
  box: Box,
  what: string,
  extra: readonly string[] = [],
): Promise<{ id: string; code: number; stderr: string; stdout: string }> {
  const result = await run(box, [
    "proposal",
    "new",
    SOUL,
    "--subject",
    SUBJECT,
    "--what",
    what,
    "--why",
    "because the disk is full",
    "--impact",
    "files older than a year",
    ...extra,
  ]);
  return { id: result.stdout.trim(), ...result };
}

// ---------------------------------------------------------------------------
// Filing, and the memory of a refusal
// ---------------------------------------------------------------------------

describe("filing a proposal", () => {
  test("the id is the whole of stdout, and the record is under personal/", async () => {
    const box = await sandbox();
    const filed = await file(box, "delete the old logs");

    expect(filed.code).toBe(0);
    expect(filed.id).toMatch(/^[0-9a-f-]{36}$/);
    // stdout is the id and nothing else, so `id=$(mind proposal new …)` is a
    // command somebody can write.
    expect(filed.stdout).toBe(`${filed.id}\n`);
    expect(filed.stderr).toContain("filed:");

    const store = storeIn(box);
    expect(await readdir(store)).toEqual([`${filed.id}.json`]);
    const record = await Bun.file(join(store, `${filed.id}.json`)).json();
    expect(record.what).toBe("delete the old logs");
    expect(record.why).toBe("because the disk is full");
    expect(record.impact).toBe("files older than a year");
    expect(record.decision).toBeNull();
    expect(record.usedByTurn).toBeNull();

    // Free text about what the owner does: 0700 all the way down, and outside
    // every git repository (D-014, D-025).
    expect((await stat(store)).mode & 0o777).toBe(0o700);
    expect((await stat(join(store, `${filed.id}.json`))).mode & 0o777).toBe(0o600);
  }, 30_000);

  test("--from reads the three fields off stdin, so they are not in argv", async () => {
    const box = await sandbox();
    const document = JSON.stringify({
      what: "delete the old logs",
      why: "the disk is full",
      impact: "files older than a year",
    });
    const path = join(box.home, "proposal.json");
    await writeFile(path, document);

    const result = await run(box, [
      "proposal",
      "new",
      SOUL,
      "--subject",
      SUBJECT,
      "--from",
      path,
    ]);
    expect(result.code).toBe(0);
    const record = await Bun.file(join(storeIn(box), `${result.stdout.trim()}.json`)).json();
    expect(record.what).toBe("delete the old logs");

    // Both at once is refused: two documents is two proposals, and picking one
    // would be Mind deciding which of them somebody meant.
    const both = await run(box, [
      "proposal", "new", SOUL, "--subject", SUBJECT, "--from", path, "--what", "something else",
    ]);
    expect(both.code).toBe(2);
    expect(both.stderr).toContain("two different proposals");

    // A document missing one of the three is refused as well: AC1 asks for
    // what, why and what it affects, and two of three is not a judgeable ask.
    const partial = join(box.home, "partial.json");
    await writeFile(partial, JSON.stringify({ what: "x", why: "y" }));
    const short = await run(box, ["proposal", "new", SOUL, "--subject", SUBJECT, "--from", partial]);
    expect(short.code).toBe(2);
    expect(short.stderr).toContain("AC1 asks for all three");
  }, 30_000);

  test("a refusal is remembered — the same `what` is exit 5 until --changed says what is new", async () => {
    const box = await sandbox();
    const first = await file(box, "delete the old logs");
    expect(first.code).toBe(0);

    // Pending blocks too: two copies of one unanswered question is not a
    // second question.
    const twice = await file(box, "delete the old logs");
    expect(twice.code).toBe(REPEATED);
    expect(twice.stderr).toContain("has not been answered yet");
    expect(await readdir(storeIn(box))).toHaveLength(1);

    const refused = await run(box, [
      "proposal", "decide", first.id, SOUL, "--subject", SUBJECT,
      "--refuse", "--note", "those logs are the only copy",
    ]);
    expect(refused.code).toBe(0);
    expect(refused.stdout).toContain("refused by");

    // The refusal now bites, through the normalisation and nothing wider.
    const again = await file(box, "Delete  the old   logs ");
    expect(again.code).toBe(REPEATED);
    expect(again.stderr).toContain("It was refused, and a refusal is remembered");
    expect(again.stderr).toContain("those logs are the only copy");
    expect(await readdir(storeIn(box))).toHaveLength(1);

    // …and --changed is the declared way past it, recorded against the old one.
    const changed = await file(box, "delete the old logs", [
      "--changed",
      "there is a copy on the backup drive now",
    ]);
    expect(changed.code).toBe(0);
    expect(changed.stderr).toContain(`supersedes ${first.id}`);
    const record = await Bun.file(join(storeIn(box), `${changed.id}.json`)).json();
    expect(record.supersedes).toBe(first.id);
    expect(record.changed).toBe("there is a copy on the backup drive now");

    // The hole, measured rather than described: one extra word is a new
    // proposal to an exact key, and this is why the refusals are printed on
    // every run instead of being matched against by something fuzzy.
    const reworded = await file(box, "delete the old logs quickly");
    expect(reworded.code).toBe(0);
    expect(reworded.stderr).toContain("this subject has been refused");
    expect(reworded.stderr).toContain("delete the old logs");
  }, 60_000);

  test("the refusals are printed on every run, filtered by nothing", async () => {
    const box = await sandbox();
    for (const what of ["delete the old logs", "restart the service"]) {
      const filed = await file(box, what);
      const refused = await run(box, [
        "proposal", "decide", filed.id, SOUL, "--subject", SUBJECT, "--refuse",
      ]);
      expect(refused.code).toBe(0);
    }

    // A proposal about something else entirely still prints both — a program
    // that showed only the "related" ones would be the loose comparison this
    // store refuses to make, moved somewhere less visible.
    const unrelated = await file(box, "write a summary of this week");
    expect(unrelated.code).toBe(0);
    expect(unrelated.stderr).toContain("2 thing(s) this subject has been refused");
    expect(unrelated.stderr).toContain("delete the old logs");
    expect(unrelated.stderr).toContain("restart the service");

    // And on the two commands a person reads before deciding.
    const shown = await run(box, ["proposal", "show", unrelated.id, SOUL, "--subject", SUBJECT]);
    expect(shown.stderr).toContain("2 thing(s) this subject has been refused");
    const listed = await run(box, ["proposal", "list", SOUL, "--subject", SUBJECT]);
    expect(listed.stderr).toContain("2 thing(s) this subject has been refused");
    expect(listed.stdout).toContain("write a summary of this week");
  }, 60_000);
});

describe("deciding", () => {
  test("a decision is written once, and a second one is refused rather than applied", async () => {
    const box = await sandbox();
    const filed = await file(box, "delete the old logs");

    const first = await run(box, [
      "proposal", "decide", filed.id, SOUL, "--subject", SUBJECT, "--approve",
    ]);
    expect(first.code).toBe(0);
    expect(first.stderr).toContain("Good for one turn");

    const second = await run(box, [
      "proposal", "decide", filed.id, SOUL, "--subject", SUBJECT, "--refuse",
    ]);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("was already approved");
    expect((await Bun.file(join(storeIn(box), `${filed.id}.json`)).json()).decision.outcome).toBe(
      "approved",
    );
  }, 30_000);

  test("refusing says what has now been refused — the refusal just made included, not the list from before it (B6)", async () => {
    const box = await sandbox();
    const filed = await file(box, "delete the old logs");
    const refused = await run(box, ["proposal", "decide", filed.id, SOUL, "--subject", SUBJECT, "--refuse", "--note", "not now"]);
    expect(refused.code).toBe(0);
    expect(refused.stderr).not.toContain("Nothing has been refused");
    expect(refused.stderr).toContain("1 thing(s) this subject has been refused");
    expect(refused.stderr).toContain("delete the old logs");
    expect(refused.stderr).toContain("note: not now");

    // Approving a proposal refuses nothing, and says so truthfully.
    const another = await file(box, "restart the service");
    const approved = await run(box, ["proposal", "decide", another.id, SOUL, "--subject", SUBJECT, "--approve"]);
    expect(approved.stderr).toContain("1 thing(s) this subject has been refused");
  }, 60_000);

  test("neither flag, both flags, and an id nothing filed are each refused", async () => {
    const box = await sandbox();
    const filed = await file(box, "delete the old logs");

    const neither = await run(box, ["proposal", "decide", filed.id, SOUL, "--subject", SUBJECT]);
    expect(neither.code).toBe(2);
    expect(neither.stderr).toContain("exactly one of --approve and --refuse");

    const both = await run(box, [
      "proposal", "decide", filed.id, SOUL, "--subject", SUBJECT, "--approve", "--refuse",
    ]);
    expect(both.code).toBe(2);

    const nothing = await run(box, [
      "proposal", "decide", "not-an-id", SOUL, "--subject", SUBJECT, "--approve",
    ]);
    expect(nothing.code).toBe(1);
    expect(nothing.stderr).toContain("no proposal");
  }, 30_000);

  test("I-3 — one subject's store is not reachable through another's soul", async () => {
    const box = await sandbox();
    const filed = await file(box, "delete the old logs");

    // The other fixture's soul really is a different subject, so this is the
    // ordinary way somebody would ask: the directory is the answer and the
    // subject is the claim (I-3).
    const across = await run(box, [
      "proposal", "show", filed.id, OTHER_SOUL, "--subject", OTHER_SUBJECT,
    ]);
    expect(across.code).toBe(1);
    expect(across.stderr).toContain("no proposal");

    // And a subject that does not match the soul in that directory is refused
    // before the store is opened at all.
    const mismatched = await run(box, [
      "proposal", "list", SOUL, "--subject", "somebody-else",
    ]);
    expect(mismatched.code).toBe(1);
    expect(await Bun.file(storeIn(box, "somebody-else")).exists()).toBe(false);
  }, 30_000);

  test("usage errors name the four subcommands and write nothing", async () => {
    const box = await sandbox();
    for (const argv of [
      ["proposal"],
      ["proposal", "wat"],
      ["proposal", "new"],
      ["proposal", "new", SOUL, "--subject", SUBJECT],
      ["proposal", "list"],
      ["proposal", "show"],
      ["proposal", "decide"],
    ]) {
      const result = await run(box, argv);
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.stderr, argv.join(" ")).toContain("mind proposal");
    }
    expect(await Bun.file(join(box.home, "data")).exists()).toBe(false);
  }, 60_000);
});

describe("--json is one document on stdout", () => {
  test("list and show parse whole, and the refusals still go to stderr", async () => {
    const box = await sandbox();
    const filed = await file(box, "delete the old logs");
    await run(box, ["proposal", "decide", filed.id, SOUL, "--subject", SUBJECT, "--refuse"]);
    const second = await file(box, "restart the service");

    const listed = await run(box, ["proposal", "list", SOUL, "--subject", SUBJECT, "--json"]);
    expect(listed.code).toBe(0);
    const document = JSON.parse(listed.stdout);
    expect(document.schema).toBe("mind/proposal-list@1");
    expect(document.subject).toBe(SUBJECT);
    expect(document.proposals).toHaveLength(2);
    expect(listed.stderr).toContain("1 thing(s) this subject has been refused");

    // Every record is in that one document, which is why `show` has no --json
    // of its own: one JSON shape per command, and no second one to drift.
    expect(document.proposals.map((proposal: { id: string }) => proposal.id)).toContain(second.id);
    const shown = await run(box, ["proposal", "show", second.id, SOUL, "--subject", SUBJECT]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("restart the service");
    expect(shown.stdout).toContain("spent   no");
  }, 30_000);

  test("a file in the store that is not a proposal is reported and counted nowhere", async () => {
    const box = await sandbox();
    await file(box, "delete the old logs");
    await writeFile(join(storeIn(box), "junk.json"), "{ not json");

    const listed = await run(box, ["proposal", "list", SOUL, "--subject", SUBJECT, "--json"]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout).proposals).toHaveLength(1);
    expect(listed.stderr).toContain("is not a proposal");
    // The sentence that matters: if that file was a refusal, this command has
    // forgotten it, and it says so rather than reporting a clean store.
    expect(listed.stderr).toContain("this command has forgotten it");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// D-029's measurements
// ---------------------------------------------------------------------------

describe("deleting the store changes one thing, and it is the thing the store is for", () => {
  test("the refusal is forgotten afterwards, and only the refusal", async () => {
    const box = await sandbox();
    const filed = await file(box, "delete the old logs");
    await run(box, ["proposal", "decide", filed.id, SOUL, "--subject", SUBJECT, "--refuse"]);
    expect((await file(box, "delete the old logs")).code).toBe(REPEATED);

    await rm(storeIn(box), { recursive: true, force: true });

    // `rm` is how an owner says "ask me again". Nothing else about Mind
    // changed: the same command line that was refused a moment ago is accepted.
    const after = await file(box, "delete the old logs");
    expect(after.code).toBe(0);
    expect(after.stderr).toContain("Nothing has been refused for this subject yet");
  }, 60_000);

  test("a turn with no --proposal is byte-identical before and after the store is deleted", async () => {
    const box = await sandbox();
    const ollama = serveOllama();
    try {
      // A store with something in it, so "before" is a run with a populated
      // store rather than a run with none.
      const filed = await file(box, "delete the old logs");
      await run(box, ["proposal", "decide", filed.id, SOUL, "--subject", SUBJECT, "--refuse"]);
      expect(await Bun.file(join(storeIn(box), `${filed.id}.json`)).exists()).toBe(true);

      const turn = () =>
        run(
          box,
          [
            "turn", SOUL, "--subject", SUBJECT,
            "--prompt", "Reply with the token t5d029 and nothing else.",
            "--backend", "ollama", "--model", "stub",
          ],
          { OLLAMA_HOST: ollama.url },
        );

      const before = await turn();
      expect(before.code).toBe(0);
      expect(before.stdout.trim()).toBe("t5d029 from ollama with-soul");

      await rm(storeIn(box), { recursive: true, force: true });
      const after = await turn();

      // Byte for byte on stdout and on the exit code; stderr through the one
      // thing that legitimately differs between two runs — how long it took.
      const settle = (text: string) => text.replace(/\b\d+\.\d+s\b/g, "<took>");
      expect(after.stdout).toBe(before.stdout);
      expect(after.code).toBe(before.code);
      expect(settle(after.stderr)).toBe(settle(before.stderr));

      // And the backend was handed the same two things both times, which is
      // the half a comparison of Mind's own output cannot see.
      expect(ollama.systems).toHaveLength(2);
      expect(ollama.systems[1]).toBe(ollama.systems[0]!);
      expect(ollama.prompts[1]).toBe(ollama.prompts[0]!);

      // A guard on the comparison: an empty stderr would make it agree about
      // nothing.
      expect(before.stderr).toContain("answered by ollama");
    } finally {
      await ollama.server.stop(true);
    }
  }, 60_000);
});

describe("turn --proposal spends an approval once", () => {
  test("D-153: a different prompt is refused and spends nothing; the approved action runs once, built from the record", async () => {
    const box = await sandbox();
    const ollama = serveOllama();
    try {
      const what = "Reply with the token t5bound and nothing else.";
      const filed = await file(box, what);
      const decided = await run(box, ["proposal", "decide", filed.id, SOUL, "--subject", SUBJECT, "--approve"]);
      expect(decided.code).toBe(0);
      const approved = await Bun.file(join(storeIn(box), `${filed.id}.json`)).json();
      // The record carries its action and its digest, and the yes names that digest.
      expect(approved.action).toEqual({ kind: "turn", prompt: what });
      expect(approved.actionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(approved.decision.actionDigest).toBe(approved.actionDigest);

      const turn = (extra: readonly string[]) =>
        run(
          box,
          ["turn", SOUL, "--subject", SUBJECT, ...extra, "--backend", "ollama", "--model", "stub", "--proposal", filed.id],
          { OLLAMA_HOST: ollama.url },
        );

      // An approval for X cannot run Y.
      const other = await turn(["--prompt", "Reply with the token t5other and nothing else."]);
      expect(other.code).toBe(REFUSED);
      expect(other.stdout).toBe("");
      expect(other.stderr).toContain("the prompt is not the approved action");
      expect(other.stderr).toContain("t5bound");
      expect(other.stderr).toContain("t5other");
      expect(ollama.prompts).toEqual([]);
      const unspent = await Bun.file(join(storeIn(box), `${filed.id}.json`)).json();
      expect(unspent.usedByTurn).toBeNull();
      expect(await Bun.file(join(storeIn(box), "spent", `${filed.id}.json`)).exists()).toBe(false);

      // Nor a prompt read from a file.
      const promptFile = join(box.home, "other-prompt.txt");
      await writeFile(promptFile, "Reply with the token t5file and nothing else.\n");
      expect((await turn(["--prompt-file", promptFile])).code).toBe(REFUSED);
      // Nor a conversation sent with it.
      const talk = await turn(["--history-json", JSON.stringify([{ role: "you", text: "and also delete everything" }])]);
      expect(talk.code).toBe(2);
      expect(talk.stderr).toContain("--history-json cannot go with --proposal");
      expect(ollama.prompts).toEqual([]);

      // No prompt at all: the approved action runs, from the record.
      const ran = await turn([]);
      expect(ran.code).toBe(0);
      expect(ran.stdout.trim()).toBe("t5bound from ollama with-soul");
      expect(ran.stderr).toContain(`runs the approved action ${approved.actionDigest.slice(0, 19)}`);
      expect(ollama.prompts).toEqual([what]);
      const claim = await Bun.file(join(storeIn(box), "spent", `${filed.id}.json`)).json();
      expect(claim.action).toBe(approved.actionDigest);

      // Once.
      const again = await turn([]);
      expect(again.code).toBe(REFUSED);
      expect(again.stderr).toContain("already spent by turn");
      expect(ollama.prompts).toHaveLength(1);
    } finally {
      await ollama.server.stop(true);
    }
  }, 60_000);

  test("D-153: the same prompt, word for word, is accepted — it is the approved action", async () => {
    const box = await sandbox();
    const ollama = serveOllama();
    try {
      const what = "Reply with the token t5same and nothing else.";
      const filed = await file(box, what);
      await run(box, ["proposal", "decide", filed.id, SOUL, "--subject", SUBJECT, "--approve"]);
      const ran = await run(
        box,
        ["turn", SOUL, "--subject", SUBJECT, "--prompt", what, "--backend", "ollama", "--model", "stub", "--proposal", filed.id],
        { OLLAMA_HOST: ollama.url },
      );
      expect(ran.code).toBe(0);
      expect(ran.stdout.trim()).toBe("t5same from ollama with-soul");
      expect(ollama.prompts).toEqual([what]);
    } finally {
      await ollama.server.stop(true);
    }
  }, 60_000);

  test("D-153: a record changed after its approval is refused, and the approval is not spent", async () => {
    const box = await sandbox();
    const ollama = serveOllama();
    try {
      const filed = await file(box, "Reply with the token t5before and nothing else.");
      await run(box, ["proposal", "decide", filed.id, SOUL, "--subject", SUBJECT, "--approve"]);
      const path = join(storeIn(box), `${filed.id}.json`);
      const record = await Bun.file(path).json();
      // An edit after the yes: what and its action both changed, the decision's digest left as it was.
      const changed = "Reply with the token t5after and nothing else.";
      await writeFile(path, JSON.stringify({ ...record, what: changed, action: { kind: "turn", prompt: changed } }));

      const result = await run(
        box,
        ["turn", SOUL, "--subject", SUBJECT, "--backend", "ollama", "--model", "stub", "--proposal", filed.id],
        { OLLAMA_HOST: ollama.url },
      );
      expect(result.code).toBe(REFUSED);
      expect(result.stderr).toContain("changed after the yes");
      expect(ollama.prompts).toEqual([]);
      expect(await Bun.file(join(storeIn(box), "spent", `${filed.id}.json`)).exists()).toBe(false);
    } finally {
      await ollama.server.stop(true);
    }
  }, 60_000);

  test("D-153: an approval that names no action is refused — an old one, or an edit with its digest stripped (review of #18)", async () => {
    const box = await sandbox();
    const ollama = serveOllama();
    try {
      const store = storeIn(box);
      await mkdir(store, { recursive: true, mode: 0o700 });
      const id = "5a1e0c3d-2b4f-4e6a-8c9d-0e1f2a3b4c5d";
      const what = "Reply with the token t5legacy and nothing else.";
      await writeFile(
        join(store, `${id}.json`),
        JSON.stringify({
          schema: PROPOSAL_SCHEMA, id, subject: SUBJECT, at: "2026-09-29T08:00:00.000Z",
          what, why: "because", impact: "nothing", supersedes: null, changed: null,
          decision: { outcome: "approved", at: "2026-09-29T09:00:00.000Z", by: "the owner", note: null },
          usedByTurn: null, usedAt: null,
        }),
      );
      const other = await run(
        box,
        ["turn", SOUL, "--subject", SUBJECT, "--prompt", "Reply with the token t5sneak and nothing else.", "--backend", "ollama", "--model", "stub", "--proposal", id],
        { OLLAMA_HOST: ollama.url },
      );
      expect(other.code).toBe(REFUSED);
      const ran = await run(
        box,
        ["turn", SOUL, "--subject", SUBJECT, "--backend", "ollama", "--model", "stub", "--proposal", id],
        { OLLAMA_HOST: ollama.url },
      );
      expect(ran.code).toBe(REFUSED);
      expect(ran.stderr).toContain("Approve it again");
      // D-153 follow-up: it points at the button and at `--refile`, not at typing the proposal out again.
      expect(ran.stderr).toContain('"File it again for a yes" on the web page');
      expect(ran.stderr).toContain(`mind proposal new <dir> --subject ${SUBJECT} --refile ${id}`);
      expect(ran.stderr).not.toContain("file the same what");
      expect(ollama.prompts).toEqual([]);
      expect(await Bun.file(join(store, "spent", `${id}.json`)).exists()).toBe(false);
      void what;

      // The review's measurement: approve properly, then edit what, delete action and the decision's digest.
      const filed = await file(box, "Reply with the token t5good and nothing else.");
      await run(box, ["proposal", "decide", filed.id, SOUL, "--subject", SUBJECT, "--approve"]);
      const path = join(store, `${filed.id}.json`);
      const record = await Bun.file(path).json();
      delete record.action;
      delete record.decision.actionDigest;
      record.what = "Reply with the token EVIL edited";
      await writeFile(path, JSON.stringify(record));
      const evil = await run(
        box,
        ["turn", SOUL, "--subject", SUBJECT, "--backend", "ollama", "--model", "stub", "--proposal", filed.id],
        { OLLAMA_HOST: ollama.url },
      );
      expect(evil.code).toBe(REFUSED);
      expect(evil.stderr).toContain("the approval names no action");
      expect(ollama.prompts).toEqual([]);
    } finally {
      await ollama.server.stop(true);
    }
  }, 60_000);

  test("D-153 follow-up: `--refile` files an approval from before approvals named their action again, once — a new question, nothing run", async () => {
    const box = await sandbox();
    const ollama = serveOllama();
    try {
      const store = storeIn(box);
      await mkdir(store, { recursive: true, mode: 0o700 });
      const old = "6b1d2c3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
      await writeFile(
        join(store, `${old}.json`),
        JSON.stringify({
          schema: PROPOSAL_SCHEMA, id: old, subject: SUBJECT, at: "2026-09-29T08:00:00.000Z",
          what: "Reply with the token t5legacy2 and nothing else.", why: "because", impact: "nothing",
          supersedes: null, changed: null,
          decision: { outcome: "approved", at: "2026-09-29T09:00:00.000Z", by: "the owner", note: null },
          usedByTurn: null, usedAt: null, filedBy: "agent", fromTurn: "turn-that-asked",
        }),
      );

      // Three at once — a page, an app and a terminal: one files it, the others are told which.
      const results = await Promise.all(
        Array.from({ length: 3 }, () => run(box, ["proposal", "new", SOUL, "--subject", SUBJECT, "--refile", old])),
      );
      const filed = results.filter((r) => r.code === 0);
      expect(filed).toHaveLength(1);
      expect(results.filter((r) => r.code === REPEATED)).toHaveLength(2);
      const newId = filed[0]!.stdout.trim();
      expect(newId).toMatch(/^[0-9a-f-]{36}$/);
      expect(filed[0]!.stderr).toContain(
        `filed again from ${old}, approved before approvals named their action (D-153), so no turn would run that yes. ` +
          `${old} leaves every list. It waits for a yes of its own; nothing was approved or run.`,
      );
      const fresh = await Bun.file(join(store, `${newId}.json`)).json();
      expect(fresh).toMatchObject({
        what: "Reply with the token t5legacy2 and nothing else.", why: "because", impact: "nothing",
        decision: null, usedByTurn: null, supersedes: old,
        changed: "filed again: approved 2026-09-29T09:00:00.000Z before approvals named their action (D-153), so that yes cannot run",
        filedBy: "agent", fromTurn: "turn-that-asked",
      });
      expect(fresh.actionDigest).toMatch(/^sha256:/);
      // The old record is untouched — still an approval no turn will run — and no turn ran.
      const still = await Bun.file(join(store, `${old}.json`)).json();
      expect(still.decision.actionDigest).toBeUndefined();
      expect(still.usedByTurn).toBeNull();
      expect(await Bun.file(join(store, "spent", `${old}.json`)).exists()).toBe(false);
      expect(ollama.prompts).toEqual([]);

      // Once: later, one at a time, it is still filed already.
      const again = await run(box, ["proposal", "new", SOUL, "--subject", SUBJECT, "--refile", old]);
      expect(again.code).toBe(REPEATED);
      expect(again.stderr).toContain(`${old} was filed again already, as ${newId}`);

      // The new one, approved, runs once; the old one still does not.
      await run(box, ["proposal", "decide", newId, SOUL, "--subject", SUBJECT, "--approve"]);
      const turn = (id: string) =>
        run(box, ["turn", SOUL, "--subject", SUBJECT, "--backend", "ollama", "--model", "stub", "--proposal", id], { OLLAMA_HOST: ollama.url });
      expect((await turn(old)).code).toBe(REFUSED);
      const ran = await turn(newId);
      expect(ran.code).toBe(0);
      expect(ran.stdout.trim()).toBe("t5legacy2 from ollama with-soul");
      expect(ollama.prompts).toHaveLength(1);
    } finally {
      await ollama.server.stop(true);
    }
  }, 60_000);

  test("D-153 follow-up: an old approval whose what was already asked again by hand is not filed a second time", async () => {
    // The owner's case: 63268cfb approved before v0.10.0, then the same what filed by hand, approved and spent.
    const box = await sandbox();
    const store = storeIn(box);
    await mkdir(store, { recursive: true, mode: 0o700 });
    const old = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    const what = "read the real state of the server";
    await writeFile(
      join(store, `${old}.json`),
      JSON.stringify({
        schema: PROPOSAL_SCHEMA, id: old, subject: SUBJECT, at: "2026-09-29T08:00:00.000Z",
        what, why: "because", impact: "nothing", supersedes: null, changed: null,
        decision: { outcome: "approved", at: "2026-09-29T09:00:00.000Z", by: "the owner", note: null },
        usedByTurn: null, usedAt: null,
      }),
    );
    const twin = await file(box, what);
    expect(twin.code).toBe(0);

    // Waiting: a twin is waiting already.
    const waiting = await run(box, ["proposal", "new", SOUL, "--subject", SUBJECT, "--refile", old]);
    expect(waiting.code).toBe(REPEATED);
    expect(waiting.stderr).toContain(`${old} was asked again already, as ${twin.id}`);

    // Approved and spent, as the owner's was: still asked again already — no new copy of the question.
    await run(box, ["proposal", "decide", twin.id, SOUL, "--subject", SUBJECT, "--approve"]);
    const spent = join(store, `${twin.id}.json`);
    await writeFile(spent, JSON.stringify({ ...(await Bun.file(spent).json()), usedByTurn: "turn-ran", usedAt: "2026-10-05T15:48:23.008Z" }));
    const after = await run(box, ["proposal", "new", SOUL, "--subject", SUBJECT, "--refile", old]);
    expect(after.code).toBe(REPEATED);
    expect(after.stderr).toContain(`${old} was asked again already, as ${twin.id}`);
    expect((await readdir(store)).filter((name) => name.endsWith(".json")).sort()).toEqual([`${old}.json`, `${twin.id}.json`].sort());
    expect(await Bun.file(join(store, "refiled", `${old}.json`)).exists()).toBe(false);
  }, 60_000);

  test("review of PR #29: a refile past a refusal its record supersedes is filed — by the CLI and by /refile, spent or not", async () => {
    // Repro: A "Restart nginx" refused; B the same what, filed with --changed (supersedes A), approved with no
    // digest. B was listed under "File it again for a yes", and the refile was refused for A: listed forever.
    const box = await sandbox();
    const store = storeIn(box);
    const decide = (id: string, answer: "--approve" | "--refuse") => run(box, ["proposal", "decide", id, SOUL, "--subject", SUBJECT, answer]);
    /** A refused, then B past it with --changed, approved; B's digest stripped as one from before v0.10.0. */
    const pastRefusal = async (what: string) => {
      const a = await file(box, what);
      expect((await decide(a.id, "--refuse")).code).toBe(0);
      const b = await file(box, what, ["--changed", "the config is fixed"]);
      expect(b.code).toBe(0);
      expect((await decide(b.id, "--approve")).code).toBe(0);
      const path = join(store, `${b.id}.json`);
      const record = await Bun.file(path).json();
      expect(record.supersedes).toBe(a.id);
      delete record.decision.actionDigest;
      await writeFile(path, JSON.stringify(record));
      return b.id;
    };
    const filedFrom = async (old: string) => {
      const all = await Promise.all((await readdir(store)).filter((n) => n.endsWith(".json")).map((n) => Bun.file(join(store, n)).json()));
      return all.filter((r) => r.supersedes === old);
    };

    // The CLI.
    const viaCli = await pastRefusal("Restart nginx");
    const refiled = await run(box, ["proposal", "new", SOUL, "--subject", SUBJECT, "--refile", viaCli]);
    expect(refiled.code).toBe(0);
    expect(refiled.stderr).not.toContain("a refusal is remembered");
    const [fresh] = await filedFrom(viaCli);
    expect(fresh).toMatchObject({ id: refiled.stdout.trim(), what: "Restart nginx", decision: null, supersedes: viaCli });

    // The route, with the real CLI behind it: 200, a new proposal, and nothing approved or run.
    const viaRoute = await pastRefusal("Restart postgres");
    const deps = { dir: SOUL, subject: SUBJECT, run: (args: readonly string[]) => run(box, args) } as unknown as WebDeps;
    const post = (id: string) => {
      const headers = new Headers({ host: "127.0.0.1:30701", [TOKEN_HEADER]: "tok" });
      return handler(deps, "tok", allowedHosts("127.0.0.1", 30701))(
        new Request(`http://127.0.0.1:30701/api/proposals/${id}/refile`, { method: "POST", headers, body: "{}" }),
      );
    };
    const res = await post(viaRoute);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    const [routed] = await filedFrom(viaRoute);
    expect(routed).toMatchObject({ id: body.id, what: "Restart postgres", decision: null, supersedes: viaRoute });
    // Once: the second press is told, with 409.
    expect((await post(viaRoute)).status).toBe(409);

    // The spent-refile path (D-144 §2) asks the same rule: an approval past a refusal whose turn sent nothing.
    const a = await file(box, "Restart redis");
    await decide(a.id, "--refuse");
    const s = await file(box, "Restart redis", ["--changed", "the cache is cold"]);
    await decide(s.id, "--approve");
    const spentPath = join(store, `${s.id}.json`);
    await writeFile(spentPath, JSON.stringify({ ...(await Bun.file(spentPath).json()), usedByTurn: "turn-unsent", usedAt: new Date().toISOString(), sentNothing: true }));
    expect((await run(box, ["proposal", "new", SOUL, "--subject", SUBJECT, "--refile", s.id])).code).toBe(0);
  }, 90_000);

  test("review of PR #29: the twin rule is measured against the yes — a refusal the yes came after does not hide it", async () => {
    // Repro: C filed; D, the same what, filed past it and refused; C approved after that, with no digest.
    const box = await sandbox();
    const store = storeIn(box);
    const c = await file(box, "rotate the logs");
    const d = await file(box, "rotate the logs", ["--changed", "only the old ones"]);
    expect(d.code).toBe(0);
    await run(box, ["proposal", "decide", d.id, SOUL, "--subject", SUBJECT, "--refuse"]);
    await Bun.sleep(5);
    await run(box, ["proposal", "decide", c.id, SOUL, "--subject", SUBJECT, "--approve"]);
    const path = join(store, `${c.id}.json`);
    const record = await Bun.file(path).json();
    delete record.decision.actionDigest;
    await writeFile(path, JSON.stringify(record));

    const refiled = await run(box, ["proposal", "new", SOUL, "--subject", SUBJECT, "--refile", c.id]);
    expect(refiled.code).toBe(0);
    expect(refiled.stderr).toContain(`filed again from ${c.id}, approved before approvals named their action`);
  }, 60_000);

  test("review of PR #29: a record changed after its yes is refused by turn, pointed at --refile, and filed again from its record", async () => {
    const box = await sandbox();
    const ollama = serveOllama();
    try {
      const store = storeIn(box);
      const filed = await file(box, "Reply with the token t5moved and nothing else.");
      await run(box, ["proposal", "decide", filed.id, SOUL, "--subject", SUBJECT, "--approve"]);
      const path = join(store, `${filed.id}.json`);
      const record = await Bun.file(path).json();
      record.what = "Reply with the token t5edited and nothing else.";
      record.action = { kind: "turn", prompt: record.what };
      await writeFile(path, JSON.stringify(record));

      const ran = await run(
        box,
        ["turn", SOUL, "--subject", SUBJECT, "--backend", "ollama", "--model", "stub", "--proposal", filed.id],
        { OLLAMA_HOST: ollama.url },
      );
      expect(ran.code).toBe(REFUSED);
      expect(ran.stderr).toContain("changed after the yes");
      expect(ran.stderr).toContain(`--refile ${filed.id}`);
      expect(ollama.prompts).toEqual([]);

      const refiled = await run(box, ["proposal", "new", SOUL, "--subject", SUBJECT, "--refile", filed.id]);
      expect(refiled.code).toBe(0);
      expect(refiled.stderr).toContain("whose record no longer holds the action its yes named (D-153)");
      const fresh = await Bun.file(join(store, `${refiled.stdout.trim()}.json`)).json();
      // What is asked again is what the record holds now, waiting for a yes of its own.
      expect(fresh).toMatchObject({ what: "Reply with the token t5edited and nothing else.", decision: null, supersedes: filed.id });
      expect(fresh.changed).toContain("the record no longer holds the action that yes named");
    } finally {
      await ollama.server.stop(true);
    }
  }, 60_000);

  test("approved runs and is spent; the same id a second time is refused", async () => {
    const box = await sandbox();
    const ollama = serveOllama();
    try {
      const filed = await file(box, "Reply with the token t5spend and nothing else.");
      await run(box, ["proposal", "decide", filed.id, SOUL, "--subject", SUBJECT, "--approve"]);

      const turn = (id: string) =>
        run(
          box,
          [
            "turn", SOUL, "--subject", SUBJECT,
            "--backend", "ollama", "--model", "stub", "--proposal", id,
          ],
          { OLLAMA_HOST: ollama.url },
        );

      const first = await turn(filed.id);
      expect(first.code).toBe(0);
      expect(first.stdout.trim()).toBe("t5spend from ollama with-soul");
      expect(first.stderr).toContain("is spent on this turn");

      const record = await Bun.file(join(storeIn(box), `${filed.id}.json`)).json();
      expect(record.usedByTurn).toMatch(/^[0-9a-f-]{36}$/);
      expect(record.usedAt).not.toBeNull();

      const second = await turn(filed.id);
      expect(second.code).toBe(REFUSED);
      expect(second.stderr).toContain("already spent by turn");
      // Nothing was sent the second time: one prompt reached the daemon, not two.
      expect(ollama.prompts).toHaveLength(1);
    } finally {
      await ollama.server.stop(true);
    }
  }, 60_000);

  test("three turns at once on one approval: exactly one runs, the others are refused and send nothing (D-144)", async () => {
    // The race the review of the app's pull request 19 found: two taps on "Do it now", or
    // "Run now" in the app, start two `turn --proposal` processes at once. Both
    // used to read the approval as unspent and both ran it. The spend is now one
    // exclusive step at the check, so the order the processes arrive in does not
    // matter: one takes it, and every other one is told whose turn it went to.
    const box = await sandbox();
    const ollama = serveOllama();
    try {
      const filed = await file(box, "Reply with the token t5race and nothing else.");
      await run(box, ["proposal", "decide", filed.id, SOUL, "--subject", SUBJECT, "--approve"]);

      const turn = () =>
        run(
          box,
          [
            "turn", SOUL, "--subject", SUBJECT,
            "--backend", "ollama", "--model", "stub", "--proposal", filed.id,
          ],
          { OLLAMA_HOST: ollama.url },
        );

      const results = await Promise.all([turn(), turn(), turn()]);
      const ran = results.filter((r) => r.code === 0);
      const refused = results.filter((r) => r.code === REFUSED);
      expect(ran).toHaveLength(1);
      expect(refused).toHaveLength(2);
      expect(ran[0]!.stdout.trim()).toBe("t5race from ollama with-soul");
      // One prompt reached the backend, not three.
      expect(ollama.prompts).toHaveLength(1);

      const record = await Bun.file(join(storeIn(box), `${filed.id}.json`)).json();
      expect(record.usedByTurn).toMatch(/^[0-9a-f-]{36}$/);
      expect(ran[0]!.stderr).toContain(`is spent on this turn (${record.usedByTurn})`);
      for (const loser of refused) {
        expect(loser.stdout).toBe("");
        expect(loser.stderr).toContain("nothing was sent");
        // Named: the turn that did take it, which is the one the record names.
        expect(loser.stderr).toContain(`already spent by turn ${record.usedByTurn}`);
      }
    } finally {
      await ollama.server.stop(true);
    }
  }, 60_000);

  test("a turn that claimed the approval and sent nothing leaves it spent and says so; `--refile` files it again, once, and runs nothing (D-144 §2)", async () => {
    const box = await sandbox();
    const ollama = serveOllama();
    try {
      const filed = await file(box, "Reply with the token t5fail and nothing else.");
      await run(box, ["proposal", "decide", filed.id, SOUL, "--subject", SUBJECT, "--approve"]);

      const turn = (id: string, host: string) =>
        run(
          box,
          [
            "turn", SOUL, "--subject", SUBJECT,
            "--backend", "ollama", "--model", "stub", "--proposal", id,
          ],
          { OLLAMA_HOST: host },
        );

      // The backend is down: the turn took the approval as its last step, and
      // then no backend was there to be handed the prompt. It is not handed
      // back (D-144 §2, the owner's decision) — and the turn says so, last,
      // where the web page's error line reads it.
      const failed = await turn(filed.id, "http://127.0.0.1:1");
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain("no backend answered");
      const record = await Bun.file(join(storeIn(box), `${filed.id}.json`)).json();
      expect(record.usedByTurn).toMatch(/^[0-9a-f-]{36}$/);
      const last = failed.stderr.trimEnd().split("\n").at(-1)!;
      expect(last).toContain(`proposal ${filed.id} stays spent — turn ${record.usedByTurn} took its approval and nothing was sent`);
      expect(last).toContain(`file it again — \`mind proposal new <dir> --subject ${SUBJECT} --refile ${filed.id}\``);
      // Marked, which is what lets it be filed again from its own record.
      expect(record.sentNothing).toBe(true);

      // The backend is back; the approval is not.
      const again = await turn(filed.id, ollama.url);
      expect(again.code).toBe(REFUSED);
      expect(again.stderr).toContain(`already spent by turn ${record.usedByTurn}`);
      // This one took nothing, so it has nothing to say about keeping it.
      expect(again.stderr).not.toContain("stays spent");
      expect(ollama.prompts).toEqual([]);

      // Asking again is the way: filed again from its own record, as a new
      // proposal that waits — nothing approved, nothing run.
      const refile = (id: string, extra: readonly string[] = []) =>
        run(box, ["proposal", "new", SOUL, "--subject", SUBJECT, "--refile", id, ...extra]);
      const refiled = await refile(filed.id);
      expect(refiled.code).toBe(0);
      const newId = refiled.stdout.trim();
      expect(newId).toMatch(/^[0-9a-f-]{36}$/);
      expect(newId).not.toBe(filed.id);
      expect(refiled.stderr).toContain("nothing was approved or run");
      const fresh = await Bun.file(join(storeIn(box), `${newId}.json`)).json();
      expect(fresh).toMatchObject({
        what: "Reply with the token t5fail and nothing else.",
        why: "because the disk is full",
        impact: "files older than a year",
        decision: null,
        usedByTurn: null,
        supersedes: filed.id,
        changed: `filed again: turn ${record.usedByTurn} took its approval and sent nothing`,
        filedBy: "person",
      });
      expect(ollama.prompts).toEqual([]);

      // Once: the second click finds it filed again, and files nothing.
      const twice = await refile(filed.id);
      expect(twice.code).toBe(5);
      expect(twice.stderr).toContain(`was filed again already, as ${newId}`);
      // Nothing but the record: an unknown id, and text from the command line.
      expect((await refile("00000000-0000-4000-8000-000000000000")).code).toBe(2);
      expect((await refile(filed.id, ["--what", "something else"])).code).toBe(2);
      expect((await readdir(storeIn(box))).filter((name) => name.endsWith(".json")).sort()).toEqual(
        [`${filed.id}.json`, `${newId}.json`].sort(),
      );

      // Approved — a new yes — it runs once.
      await run(box, ["proposal", "decide", newId, SOUL, "--subject", SUBJECT, "--approve"]);
      const ran = await turn(newId, ollama.url);
      expect(ran.code).toBe(0);
      expect(ran.stdout.trim()).toBe("t5fail from ollama with-soul");
      expect(ran.stderr).not.toContain("stays spent");
      expect(ollama.prompts).toHaveLength(1);
    } finally {
      await ollama.server.stop(true);
    }
  }, 60_000);

  test("a turn that stops before its claim — here, an unwritable ledger — spends nothing (D-144 review)", async () => {
    // The claim is the last step before the prompt goes, so everything that
    // does not depend on the proposal is asked first. A ledger that cannot be
    // written stops the turn with the approval still ready — as it did before
    // D-144 — and the turn has nothing to say about an approval it never took.
    const box = await sandbox();
    const ollama = serveOllama();
    try {
      const filed = await file(box, "Reply with the token t5early and nothing else.");
      await run(box, ["proposal", "decide", filed.id, SOUL, "--subject", SUBJECT, "--approve"]);
      const turn = (over: Record<string, string>) =>
        run(
          box,
          [
            "turn", SOUL, "--subject", SUBJECT,
            "--backend", "ollama", "--model", "stub", "--proposal", filed.id,
          ],
          { OLLAMA_HOST: ollama.url, ...over },
        );

      // A file where the ledger's directory should be: the ledger cannot be made,
      // and nothing else the turn reads (the dial, the brake) is in the way.
      const ledgers = join(box.home, "state", "mind", "ledger");
      await mkdir(join(box.home, "state", "mind"), { recursive: true });
      await writeFile(ledgers, "");
      const stopped = await turn({});
      expect(stopped.code).toBe(1);
      expect(stopped.stderr).toContain("Nothing was sent");
      expect(stopped.stderr).not.toContain("is spent on this turn");
      expect(stopped.stderr).not.toContain("stays spent");
      const record = await Bun.file(join(storeIn(box), `${filed.id}.json`)).json();
      expect(record.usedByTurn).toBeNull();
      expect(await Bun.file(join(storeIn(box), "spent", `${filed.id}.json`)).exists()).toBe(false);
      expect(ollama.prompts).toEqual([]);

      // The ledger fixed, the same approval runs — once.
      await rm(ledgers);
      const ran = await turn({});
      expect(ran.code).toBe(0);
      expect(ran.stdout.trim()).toBe("t5early from ollama with-soul");
      expect(ollama.prompts).toHaveLength(1);
    } finally {
      await ollama.server.stop(true);
    }
  }, 60_000);

  test("a turn whose backend answered but whose ledger line failed says it ran — and does not say to file it again (D-144 review)", async () => {
    // Following "file it again" here would run the action a second time. The
    // ledger's month file is a directory, so the line cannot be appended after
    // the answer arrives — without depending on how the ledger's lock behaves.
    const box = await sandbox();
    const ollama = serveOllama();
    try {
      const filed = await file(box, "Reply with the token t5ran and nothing else.");
      await run(box, ["proposal", "decide", filed.id, SOUL, "--subject", SUBJECT, "--approve"]);
      const ledger = join(box.home, "state", "mind", "ledger", SUBJECT);
      const now = new Date();
      for (const at of [now, new Date(now.getTime() + 86_400_000)]) {
        await mkdir(join(ledger, monthFileName(at)), { recursive: true });
      }

      const result = await run(
        box,
        [
          "turn", SOUL, "--subject", SUBJECT,
          "--backend", "ollama", "--model", "stub", "--proposal", filed.id,
        ],
        { OLLAMA_HOST: ollama.url },
      );
      expect(result.code).toBe(1);
      expect(result.stdout.trim()).toBe("t5ran from ollama with-soul");
      expect(result.stderr).toContain("were sent and not recorded");
      const record = await Bun.file(join(storeIn(box), `${filed.id}.json`)).json();
      const last = result.stderr.trimEnd().split("\n").at(-1)!;
      expect(last).toBe(
        `mind: proposal ${filed.id} was spent by this turn (${record.usedByTurn}) and it ran — ollama answered, ` +
          `and the ledger did not record it. Do not file it again to retry: that would run it a second time.`,
      );
      expect(result.stderr).not.toContain("file it again (");
      expect(result.stderr).not.toContain("stays spent");
      expect(ollama.prompts).toHaveLength(1);
      // It ran, so it is not offered to be filed again.
      expect(record.sentNothing).toBeUndefined();
      const refused = await run(box, ["proposal", "new", SOUL, "--subject", SUBJECT, "--refile", filed.id]);
      expect(refused.code).toBe(4);
      expect(refused.stderr).toContain("ran it or may have");
    } finally {
      await ollama.server.stop(true);
    }
  }, 60_000);

  test("six `--refile` at once file one new proposal; five are told it was filed already — and it keeps who first filed it (D-144 follow-up)", async () => {
    // A bulk "File it again", or a page and a terminal: every process read the
    // store before any of them wrote, so each found the approval not yet filed
    // again, and six filed six. The refile is now claimed before it is written.
    const box = await sandbox();
    const store = storeIn(box);
    await mkdir(store, { recursive: true, mode: 0o700 });
    const old = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    // Filed by the agent in a level-1 turn, approved, and spent by a turn that sent nothing.
    await writeFile(
      join(store, `${old}.json`),
      JSON.stringify({
        schema: PROPOSAL_SCHEMA, id: old, subject: SUBJECT, at: "2026-09-29T08:00:00.000Z",
        what: "delete the old logs", why: "because the disk is full", impact: "files older than a year",
        supersedes: null, changed: null,
        decision: { outcome: "approved", at: "2026-09-29T09:00:00.000Z", by: "the owner", note: null },
        usedByTurn: "turn-that-sent-nothing", usedAt: "2026-09-29T10:00:00.000Z", sentNothing: true,
        filedBy: "agent", fromTurn: "turn-that-asked",
      }),
    );

    const results = await Promise.all(
      Array.from({ length: 6 }, () => run(box, ["proposal", "new", SOUL, "--subject", SUBJECT, "--refile", old])),
    );
    const filed = results.filter((r) => r.code === 0);
    const told = results.filter((r) => r.code === REPEATED);
    expect(filed).toHaveLength(1);
    expect(told).toHaveLength(5);
    const newId = filed[0]!.stdout.trim();
    for (const r of told) {
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(`${old} was filed again already, as ${newId}. Nothing was filed.`);
    }
    const records = (await readdir(store)).filter((name) => name.endsWith(".json")).sort();
    expect(records).toEqual([`${old}.json`, `${newId}.json`].sort());
    expect(await Bun.file(join(store, "refiled", `${old}.json`)).json()).toMatchObject({ proposal: old, as: newId });

    // The new one: the same words, waiting, and still the agent's.
    const fresh = await Bun.file(join(store, `${newId}.json`)).json();
    expect(fresh).toMatchObject({
      what: "delete the old logs", decision: null, usedByTurn: null, supersedes: old,
      filedBy: "agent", fromTurn: "turn-that-asked",
    });
    expect(filed[0]!.stderr).toContain("First filed by the agent (turn turn-that-asked).");

    // And later, one at a time, it is still once.
    const again = await run(box, ["proposal", "new", SOUL, "--subject", SUBJECT, "--refile", old]);
    expect(again.code).toBe(REPEATED);
    expect(again.stderr).toContain(`was filed again already, as ${newId}`);
  }, 60_000);

  test("a refile claimed by an attempt that never wrote its proposal says so, and names no proposal nobody can find", async () => {
    // A crash between the refile claim and the new record: the claim names an id that is in no record.
    const box = await sandbox();
    const store = storeIn(box);
    await mkdir(join(store, REFILED_DIR), { recursive: true, mode: 0o700 });
    const old = "3f2c1a9e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
    const never = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
    await writeFile(
      join(store, `${old}.json`),
      JSON.stringify({
        schema: PROPOSAL_SCHEMA, id: old, subject: SUBJECT, at: "2026-09-29T08:00:00.000Z",
        what: "rotate the logs", why: "the disk is full", impact: "files older than a year",
        supersedes: null, changed: null,
        decision: { outcome: "approved", at: "2026-09-29T09:00:00.000Z", by: "the owner", note: null },
        usedByTurn: "turn-that-sent-nothing", usedAt: "2026-09-29T10:00:00.000Z", sentNothing: true,
      }),
    );
    await writeFile(
      join(store, REFILED_DIR, `${old}.json`),
      JSON.stringify({ schema: REFILE_SCHEMA, proposal: old, as: never, at: "2026-09-29T11:00:00.000Z" }),
    );

    const result = await run(box, ["proposal", "new", SOUL, "--subject", SUBJECT, "--refile", old]);

    expect(result.code).toBe(REPEATED);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      `mind: the refile of ${old} was used up by an attempt that did not finish; file the same text with ` +
        "`mind proposal new`. Nothing was filed.",
    );
    expect(result.stderr).not.toContain("filed again already");
    expect(result.stderr).not.toContain(never);
    expect((await readdir(store)).filter((name) => name.endsWith(".json"))).toEqual([`${old}.json`]);
  }, 60_000);

  test("a turn that answered and then threw says it ran, not that it may have (D-144 follow-up)", async () => {
    // The answer is known the moment the backend's `run` returns it. Anything
    // that throws after that — here the after-snapshot a level-2 turn takes,
    // made to throw by a plugin preloaded into the CLI — must not turn "it ran"
    // into "it may have run": the owner would check for an action that did happen
    // as if it might not have.
    const box = await sandbox();
    const ollama = serveOllama();
    try {
      const agent = join(box.home, "agent", "soul");
      await cp(SOUL, agent, { recursive: true });
      const work = join(box.home, "work");
      await mkdir(work, { recursive: true });
      for (const category of ["write", "run", "reach"]) {
        const set = await run(box, ["autonomy", "set", category, "2", agent, "--subject", SUBJECT]);
        expect(set.code, set.stderr).toBe(0);
      }
      const filed = await run(box, [
        "proposal", "new", agent, "--subject", SUBJECT,
        "--what", "Reply with the token t5threw and nothing else.", "--why", "because the disk is full", "--impact", "files older than a year",
      ]);
      const id = filed.stdout.trim();
      await run(box, ["proposal", "decide", id, agent, "--subject", SUBJECT, "--approve"]);

      const preload = join(box.home, "snapshot-throws.ts");
      await writeFile(
        preload,
        `import { plugin } from "bun";
plugin({
  name: "the second snapshot throws",
  setup(build) {
    build.onLoad({ filter: /[\\\\/]src[\\\\/]decide[\\\\/]report\\.ts$/ }, async (args) => {
      const text = await Bun.file(args.path).text();
      const contents =
        text.replace("export async function snapshotTree(", "async function realSnapshotTree(") +
        "\\nlet snapshotCalls = 0;\\nexport async function snapshotTree(...args) { snapshotCalls += 1; " +
        "if (snapshotCalls === 2) throw new Error('the after-snapshot failed (test)'); return realSnapshotTree(...args); }\\n";
      return { contents, loader: "ts" };
    });
  },
});
`,
      );
      const child = Bun.spawn(
        [BUN, "run", "--preload", preload, BIN, "turn", agent, "--subject", SUBJECT,
          "--backend", "ollama", "--model", "stub", "--proposal", id],
        { cwd: work, env: { ...box.env, OLLAMA_HOST: ollama.url }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const stderr = await new Response(child.stderr).text();
      await new Response(child.stdout).text();
      await child.exited;

      // The plugin took: the snapshot really threw after the answer arrived.
      expect(stderr).toContain("the after-snapshot failed (test)");
      expect(child.exitCode).not.toBe(0);
      expect(ollama.prompts).toHaveLength(1);
      const record = await Bun.file(join(storeIn(box), `${id}.json`)).json();
      expect(stderr).toContain(`proposal ${id} was spent by this turn (${record.usedByTurn}) and it ran — ollama answered.`);
      expect(stderr).not.toContain("may have run");
      expect(record.sentNothing).toBeUndefined();
    } finally {
      await ollama.server.stop(true);
    }
  }, 60_000);

  test("a turn whose request reached a backend that did not answer says it may have run (D-144 review)", async () => {
    const box = await sandbox();
    let asked = 0;
    // Up, and failing the one request it is handed — a vendor CLI that crashed
    // mid-turn looks the same from here, and may have acted before it did.
    const failing = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/tags") return Response.json({ models: [{ name: "stub" }] });
        asked += 1;
        return new Response("boom", { status: 500 });
      },
    });
    try {
      const filed = await file(box, "Reply with the token t5maybe and nothing else.");
      await run(box, ["proposal", "decide", filed.id, SOUL, "--subject", SUBJECT, "--approve"]);
      const result = await run(
        box,
        [
          "turn", SOUL, "--subject", SUBJECT,
          "--backend", "ollama", "--model", "stub", "--proposal", filed.id,
        ],
        { OLLAMA_HOST: `http://127.0.0.1:${failing.port}` },
      );
      expect(result.code).toBe(1);
      expect(asked).toBe(1);
      const record = await Bun.file(join(storeIn(box), `${filed.id}.json`)).json();
      const last = result.stderr.trimEnd().split("\n").at(-1)!;
      expect(last).toBe(
        `mind: proposal ${filed.id} was spent by this turn (${record.usedByTurn}) and it may have run — the request ` +
          `reached ollama before the turn failed. Check what it did before asking for it again: a second approval would run it again.`,
      );
      expect(result.stderr).not.toContain("file it again (");
      // It may have run, so it is not offered to be filed again either.
      expect(record.sentNothing).toBeUndefined();
      const refused = await run(box, ["proposal", "new", SOUL, "--subject", SUBJECT, "--refile", filed.id]);
      expect(refused.code).toBe(4);
      expect((await readdir(storeIn(box))).filter((name) => name.endsWith(".json"))).toEqual([`${filed.id}.json`]);
    } finally {
      await failing.stop(true);
    }
  }, 60_000);

  test("pending, refused and unknown each stop the turn before anything is sent", async () => {
    const box = await sandbox();
    const ollama = serveOllama();
    try {
      const pending = await file(box, "delete the old logs");
      const refused = await file(box, "restart the service");
      await run(box, ["proposal", "decide", refused.id, SOUL, "--subject", SUBJECT, "--refuse", "--note", "not today"]);

      const turn = (id: string) =>
        run(
          box,
          [
            "turn", SOUL, "--subject", SUBJECT,
            "--prompt", "Reply with the token t5stop and nothing else.",
            "--backend", "ollama", "--model", "stub", "--proposal", id,
          ],
          { OLLAMA_HOST: ollama.url },
        );

      const waiting = await turn(pending.id);
      expect(waiting.code).toBe(REFUSED);
      expect(waiting.stderr).toContain("It has not been answered");

      const said = await turn(refused.id);
      expect(said.code).toBe(REFUSED);
      expect(said.stderr).toContain("It was refused: not today");

      // An id nothing filed is a usage error, not a refusal: a loop that
      // retried on 4 would otherwise retry a typo until somebody looked.
      const typo = await turn("not-an-id");
      expect(typo.code).toBe(2);
      expect(typo.stderr).toContain("no proposal");

      // …and `--proposal` with nothing after it is refused rather than read as
      // "no proposal was asked for". Running that as an ordinary turn is the
      // free pass this flag exists to prevent, arriving through a typo.
      const empty = await run(
        box,
        [
          "turn", SOUL, "--subject", SUBJECT,
          "--prompt", "Reply with the token t5stop and nothing else.",
          "--backend", "ollama", "--model", "stub", "--proposal",
        ],
        { OLLAMA_HOST: ollama.url },
      );
      expect(empty.code).toBe(2);
      expect(empty.stderr).toContain("--proposal takes the id of a proposal");

      // Nothing reached the backend on any of the three, and no ledger line
      // was written for a turn that never happened.
      expect(ollama.prompts).toEqual([]);
      expect(await Bun.file(join(box.home, "state", "mind", "ledger", SUBJECT)).exists()).toBe(
        false,
      );
    } finally {
      await ollama.server.stop(true);
    }
  }, 60_000);
});
