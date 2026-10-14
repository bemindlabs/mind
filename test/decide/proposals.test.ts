/**
 * The proposal store — where it is, what it compares, and what it refuses.
 *
 * Four things are asked here that nothing else can ask:
 *
 * 1. **The address is under `personal/`,** which is what makes `mind erase`
 *    reach it. D-029 required that to be *measured* rather than assumed, and it
 *    is measured in two places: the containment of the path here, and the
 *    canary in `test/erase/plan.test.ts` that is gone after a real erase while a
 *    control file outside `personal/` is not. A sixth `PlaceId` would have made
 *    `tsc` enforce registration; this store is inside an existing place on
 *    purpose (D-025), so the enforcement is here instead.
 * 2. **Nothing on this path can reach a network or start a process.** The store
 *    holds free text about what the owner does, which makes it the most valuable
 *    thing in the engine to anything that wanted to send data somewhere (I-6).
 * 3. **The key table.** The comparison is exact, so the pairs that are equal and
 *    the pairs that are not are written down — including the one that is the
 *    known hole, so nobody has to discover it in production.
 * 4. **A decision is written once.** Overwriting a recorded "no" would leave no
 *    trace that the question had ever been answered differently.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  ORPHAN_TEMP_MS,
  PROPOSALS_DIR,
  PROPOSAL_SCHEMA,
  REFILED_DIR,
  REFILE_SCHEMA,
  SPEND_SCHEMA,
  SPENT_DIR,
  asProposal,
  blockingProposal,
  claimApproval,
  claimRefile,
  decideProposal,
  describeProposal,
  ensureProposalsDir,
  findProposal,
  askedAgain,
  isUnboundApproval,
  unboundReason,
  isProposalId,
  needsReapproval,
  proposalKey,
  proposalLine,
  proposalPath,
  proposalsDir,
  readProposals,
  refileProblem,
  refileWritten,
  refileable,
  refusedProposals,
  spendProposal,
  spendability,
  writeProposal,
  type Proposal,
} from "../../src/decide/proposals.ts";
import { personalDir } from "../../src/guard/personal.ts";
import { subjectId } from "../../src/types.ts";
import { networkEscapes, processEscapes, reachable, sourceFiles } from "../support/ast.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const SUBJECT = subjectId("example");
const OTHER = subjectId("somebody-else");
/** Root is not stopped by a mode, so a test that needs a write refused cannot run as root. */
const AS_ROOT = process.getuid?.() === 0;

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<{ home: string; env: { home: string; env: Record<string, string> } }> {
  const home = await mkdtemp(join(tmpdir(), "mind-proposals-"));
  scratch.push(home);
  return { home, env: { home, env: { XDG_DATA_HOME: join(home, "data") } } };
}

/** One filed proposal, with everything but `what` held still. */
function proposalOf(what: string, over: Partial<Proposal> = {}): Proposal {
  return {
    ...describeProposal({
      id: `id-${what.length}`,
      subject: SUBJECT,
      at: new Date("2026-09-22T10:00:00.000Z"),
      what,
      why: "because it was asked for",
      impact: "one file in a temporary directory",
    }),
    ...over,
  };
}

/** One filed and approved, ready to be spent. */
function approvedOf(what: string): Proposal {
  const decided = decideProposal(proposalOf(what), {
    outcome: "approved",
    at: "2026-09-29T11:00:00.000Z",
    by: "the owner",
    note: null,
  });
  if (typeof decided === "string") throw new Error(decided);
  return decided;
}

// ---------------------------------------------------------------------------
// 1. the address
// ---------------------------------------------------------------------------

describe("the store is under the personal directory, which is what erase deletes", () => {
  test("proposalsDir is personalDir + proposals/, and resolving creates nothing", async () => {
    const { env } = await sandbox();
    const personal = await personalDir(env, SUBJECT);
    const dir = await proposalsDir(env, SUBJECT);

    expect(personal.ok).toBe(true);
    expect(dir.ok).toBe(true);
    if (!dir.ok || !personal.ok) return;

    // The containment, asserted as a path relation rather than as a string:
    // `join(personal.path, "proposals")` would be the same expression this is
    // checking, and would agree with itself wherever the store moved to.
    expect(relative(personal.path, dir.path)).toBe(PROPOSALS_DIR);
    expect(dir.path.startsWith(personal.path)).toBe(true);

    // And asking where it is did not bring it into existence — `proposal list`
    // prints this path on a machine that has never filed one.
    await expect(readdir(dir.path)).rejects.toThrow();
  });

  test("ensureProposalsDir creates it 0700, and readProposals is empty until something is filed", async () => {
    const { env } = await sandbox();
    const dir = await ensureProposalsDir(env, SUBJECT);
    expect(dir.ok).toBe(true);
    if (!dir.ok) return;

    expect(await readdir(dir.path)).toEqual([]);
    expect(await readProposals(dir.path)).toEqual({ proposals: [], unreadable: [] });

    // A directory that does not exist is an empty store, not an error: nothing
    // has been proposed yet and everything has been purged look the same, and
    // both are things a list has to be able to print.
    expect(await readProposals(join(dir.path, "nowhere"))).toEqual({
      proposals: [],
      unreadable: [],
    });
  });

  test("a data root inside a git repository is refused, and nothing is written", async () => {
    const { home } = await sandbox();
    // `personalDir` refuses a path inside a checkout (D-014), and this store
    // inherits that rather than re-deciding it. The engine's own repository is
    // the git repository nearest to hand.
    const env = { home: ROOT, env: { XDG_DATA_HOME: join(ROOT, "scratch-data") } };
    const dir = await proposalsDir(env, SUBJECT);
    expect(dir.ok).toBe(false);
    if (dir.ok) return;
    expect(dir.reason).toContain("must not be in version control");
    expect(await Bun.file(join(ROOT, "scratch-data")).exists()).toBe(false);
    expect(home).toContain("mind-proposals-");
  });

  test("each subject has its own directory, so one identity's store is not another's", async () => {
    const { env } = await sandbox();
    const mine = await ensureProposalsDir(env, SUBJECT);
    const theirs = await ensureProposalsDir(env, OTHER);
    expect(mine.ok && theirs.ok).toBe(true);
    if (!mine.ok || !theirs.ok) return;

    await writeProposal(mine.path, proposalOf("delete the old logs"));
    expect((await readProposals(mine.path)).proposals.length).toBe(1);
    expect((await readProposals(theirs.path)).proposals).toEqual([]);
  });
});

describe("nothing on this path can reach a network or start a process (I-6)", () => {
  test("the whole import closure is free of both, and the checker is not vacuous", async () => {
    const closure = await reachable([join(ROOT, "src", "decide", "proposals.ts")]);
    expect(closure.size).toBeGreaterThan(2);

    const hits: string[] = [];
    for (const path of closure) {
      const source = await readFile(path, "utf8");
      const rel = relative(ROOT, path);
      for (const hit of networkEscapes(path, source)) hits.push(`${rel}: ${hit}`);
      for (const hit of processEscapes(path, source, false)) hits.push(`${rel}: ${hit}`);
    }
    expect(hits).toEqual([]);

    // Control: the same two checkers do find things, over a tree that has them.
    const exec = await reachable([join(ROOT, "src", "exec", "index.ts")]);
    const found: string[] = [];
    for (const path of exec) {
      const source = await readFile(path, "utf8");
      for (const hit of networkEscapes(path, source)) found.push(hit);
    }
    expect(found).not.toEqual([]);

    // …and the closure really is transitive, rather than the one file.
    expect([...closure].some((path) => path.endsWith(join("guard", "personal.ts")))).toBe(true);
    expect((await sourceFiles(join(ROOT, "src", "decide"))).length).toBeGreaterThan(3);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 2. the key, exactly as it is and no wider
// ---------------------------------------------------------------------------

describe("the comparison key, with the hole in it written down", () => {
  test("equal pairs: whitespace, case, and Unicode form", () => {
    const same: ReadonlyArray<readonly [string, string]> = [
      ["ลบ  log เก่า", "ลบ log เก่า "],
      ["Delete logs", "delete logs"],
      ["  restart the service  ", "restart the service"],
      ["restart\tthe\nservice", "restart the service"],
      // NFD on the left, NFC on the right: the same word, different bytes.
      ["café notes", "café notes"],
    ];
    for (const [a, b] of same) {
      expect(proposalKey(a), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(proposalKey(b));
    }
  });

  test("unequal pairs — including the hole: one extra word is a new proposal", () => {
    const different: ReadonlyArray<readonly [string, string]> = [
      // The known hole, pinned rather than hidden. `ๆ` is one character and it
      // is enough to get past a refusal, which is the price of an exact key
      // and the reason every command prints the refusals in full.
      ["ลบ log เก่า", "ลบ log เก่า ๆ"],
      ["delete logs", "delete the logs"],
      ["delete logs", "delete logs now"],
      ["restart the service", "restart the sevice"],
    ];
    for (const [a, b] of different) {
      expect(proposalKey(a), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).not.toBe(
        proposalKey(b),
      );
    }
  });

  test("the key stored on a record is recomputed from `what`, never trusted", () => {
    // A hand-edited `key` would decide whether a later proposal is a repeat,
    // which is the one question this store exists to answer.
    const parsed = asProposal({
      schema: PROPOSAL_SCHEMA,
      id: "abc",
      subject: SUBJECT,
      at: "2026-09-22T10:00:00.000Z",
      what: "Delete Logs",
      why: "space",
      impact: "logs",
      key: "something else entirely",
    });
    expect(typeof parsed).not.toBe("string");
    if (typeof parsed === "string") return;
    expect(parsed.key).toBe("delete logs");
  });
});

// ---------------------------------------------------------------------------
// 3. filing, reading back, and what a bad file does
// ---------------------------------------------------------------------------

describe("records go to disk whole and come back, or are reported", () => {
  test("a filed proposal round-trips, and its path is the id", async () => {
    const { env } = await sandbox();
    const dir = await ensureProposalsDir(env, SUBJECT);
    if (!dir.ok) throw new Error(dir.reason);

    const proposal = proposalOf("delete the old logs");
    const path = await writeProposal(dir.path, proposal);
    expect(path).toBe(proposalPath(dir.path, proposal.id));

    const inventory = await readProposals(dir.path);
    expect(inventory.unreadable).toEqual([]);
    expect(inventory.proposals.map((stored) => stored.proposal)).toEqual([proposal]);
    expect(findProposal(inventory, proposal.id)?.proposal.what).toBe("delete the old logs");
    // An id nothing wrote is not found, and — the point — is never joined onto
    // a path: the lookup is over what was read, so `../../etc/passwd` is just
    // an id that matches nothing.
    expect(findProposal(inventory, "../../etc/passwd")).toBeUndefined();
  });

  test("a file that is not a proposal is reported, not skipped", async () => {
    const { env } = await sandbox();
    const dir = await ensureProposalsDir(env, SUBJECT);
    if (!dir.ok) throw new Error(dir.reason);

    await writeFile(join(dir.path, "broken.json"), "{not json");
    await writeFile(join(dir.path, "other.json"), JSON.stringify({ schema: "something/else@1" }));
    await writeFile(join(dir.path, "partial.json"), JSON.stringify({ schema: PROPOSAL_SCHEMA }));
    await writeProposal(dir.path, proposalOf("delete the old logs"));

    const inventory = await readProposals(dir.path);
    expect(inventory.proposals.length).toBe(1);
    expect(inventory.unreadable.length).toBe(3);
    // A file in here might be a refusal, and a store that quietly ignored one
    // would go back on the only promise it makes.
    expect(inventory.unreadable.map((bad) => bad.reason).join(" ")).toContain(
      `schema is not ${PROPOSAL_SCHEMA}`,
    );
    expect(inventory.unreadable.map((bad) => bad.reason).join(" ")).toContain("id is missing");
  });

  test("the parser refuses the shapes that are not a record at all", () => {
    expect(asProposal(null)).toBe("not a JSON object");
    expect(asProposal("a string")).toBe("not a JSON object");
    expect(asProposal({ schema: PROPOSAL_SCHEMA, id: "a" })).toBe("subject is missing");
    expect(asProposal({ schema: PROPOSAL_SCHEMA, id: "a", subject: "example" })).toBe(
      "what is missing",
    );
    // A decision that is not one of the two outcomes is no decision, which
    // leaves the proposal pending rather than half-answered.
    const parsed = asProposal({
      schema: PROPOSAL_SCHEMA,
      id: "a",
      subject: "example",
      what: "x",
      decision: { outcome: "maybe" },
    });
    expect(typeof parsed).not.toBe("string");
    if (typeof parsed === "string") return;
    expect(parsed.decision).toBeNull();
    expect(parsed.why).toBe("");
  });

  test("the list is newest first, which is the order every report prints", async () => {
    const { env } = await sandbox();
    const dir = await ensureProposalsDir(env, SUBJECT);
    if (!dir.ok) throw new Error(dir.reason);

    for (const [id, at] of [
      ["old", "2026-09-20T10:00:00.000Z"],
      ["new", "2026-09-22T10:00:00.000Z"],
      ["middle", "2026-09-21T10:00:00.000Z"],
    ] as const) {
      await writeProposal(dir.path, { ...proposalOf(`ask ${id}`), id, at });
    }
    const inventory = await readProposals(dir.path);
    expect(inventory.proposals.map((stored) => stored.proposal.id)).toEqual([
      "new",
      "middle",
      "old",
    ]);
  });

  test("writing into a directory that is not there throws and leaves no temporary file", async () => {
    const { home } = await sandbox();
    const nowhere = join(home, "not-created");
    await expect(writeProposal(nowhere, proposalOf("delete the old logs"))).rejects.toThrow();
    await expect(readdir(nowhere)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. what is remembered, and what may be asked again
// ---------------------------------------------------------------------------

describe("a refusal is remembered (S5.2 AC2)", () => {
  test("refused and pending block a repeat; approved does not", async () => {
    const { env } = await sandbox();
    const dir = await ensureProposalsDir(env, SUBJECT);
    if (!dir.ok) throw new Error(dir.reason);

    const refused = decideProposal(proposalOf("delete the old logs", { id: "refused" }), {
      outcome: "refused",
      at: "2026-09-22T11:00:00.000Z",
      by: "the owner",
      note: "those logs are the only copy",
    });
    const pending = proposalOf("restart the service", { id: "pending" });
    const approved = decideProposal(proposalOf("write a summary", { id: "approved" }), {
      outcome: "approved",
      at: "2026-09-22T11:00:00.000Z",
      by: "the owner",
      note: null,
    });
    if (typeof refused === "string" || typeof approved === "string") throw new Error("not decided");

    for (const proposal of [refused, pending, approved]) await writeProposal(dir.path, proposal);
    const inventory = await readProposals(dir.path);

    expect(blockingProposal(inventory, proposalKey("Delete  the old logs "))?.id).toBe("refused");
    expect(blockingProposal(inventory, proposalKey("restart the service"))?.id).toBe("pending");
    // An approval is spent once, so asking again is asking again — not a
    // repeat of a question that was already answered no.
    expect(blockingProposal(inventory, proposalKey("write a summary"))).toBeUndefined();
    expect(blockingProposal(inventory, proposalKey("something nobody asked"))).toBeUndefined();

    // The list every command prints is the refusals, and only the refusals.
    expect(refusedProposals(inventory).map((proposal) => proposal.id)).toEqual(["refused"]);
  });

  test("a decision is written once and never edited in place", () => {
    const first = decideProposal(proposalOf("delete the old logs"), {
      outcome: "refused",
      at: "2026-09-22T11:00:00.000Z",
      by: "the owner",
      note: null,
    });
    if (typeof first === "string") throw new Error(first);

    const second = decideProposal(first, {
      outcome: "approved",
      at: "2026-09-22T12:00:00.000Z",
      by: "somebody else",
      note: null,
    });
    expect(typeof second).toBe("string");
    expect(String(second)).toContain("already refused");
    // …and the original is untouched, because the refusal is the thing being
    // protected: a "no" quietly turned into a "yes" leaves no trace at all.
    expect(first.decision?.outcome).toBe("refused");
  });

  test("supersedes and changed are recorded against the proposal they answer", () => {
    const again = describeProposal({
      id: "second",
      subject: SUBJECT,
      at: new Date("2026-09-23T10:00:00.000Z"),
      what: "delete the old logs",
      why: "the disk is full",
      impact: "logs older than a year",
      supersedes: "first",
      changed: "a copy now exists on the backup drive",
    });
    expect(again.supersedes).toBe("first");
    expect(again.changed).toBe("a copy now exists on the backup drive");
    expect(again.decision).toBeNull();
    expect(again.key).toBe(proposalKey("Delete the old logs"));
  });
});

describe("an approval is good for one turn", () => {
  test("spendability names each state, and a spent approval is not ready again", () => {
    const pending = proposalOf("delete the old logs");
    expect(spendability(pending)).toEqual({ kind: "undecided" });

    const refused = decideProposal(pending, {
      outcome: "refused",
      at: "2026-09-22T11:00:00.000Z",
      by: "the owner",
      note: null,
    });
    if (typeof refused === "string") throw new Error(refused);
    expect(spendability(refused)).toEqual({ kind: "refused" });

    const approved = decideProposal(pending, {
      outcome: "approved",
      at: "2026-09-22T11:00:00.000Z",
      by: "the owner",
      note: null,
    });
    if (typeof approved === "string") throw new Error(approved);
    expect(spendability(approved)).toEqual({ kind: "ready" });

    const spent = spendProposal(approved, "turn-1", new Date("2026-09-22T12:00:00.000Z"));
    expect(spendability(spent)).toEqual({ kind: "spent", turn: "turn-1" });
    expect(spent.usedAt).toBe("2026-09-22T12:00:00.000Z");
    // The decision itself is untouched by being spent: what changed is that it
    // has been used, not what was decided.
    expect(spent.decision).toEqual(approved.decision);
  });

  test("ten claims at once on one reading: exactly one wins, and every other names its turn (D-144)", async () => {
    // The race, without processes: every caller holds the same reading, taken
    // before any of them claimed — which is what two `turn` processes that
    // started together hold. Reading it again would not help any of them.
    const { env } = await sandbox();
    const dir = await ensureProposalsDir(env, SUBJECT);
    if (!dir.ok) throw new Error(dir.reason);
    const approved = approvedOf("delete the old logs");
    await writeProposal(dir.path, approved);
    const stored = findProposal(await readProposals(dir.path), approved.id)!;
    expect(spendability(stored.proposal)).toEqual({ kind: "ready" });

    const at = new Date("2026-09-29T12:00:00.000Z");
    const claims = await Promise.all(
      Array.from({ length: 10 }, (_, n) => claimApproval(stored, `turn-${n}`, at)),
    );
    const won = claims.filter((claim) => claim.ok);
    expect(won).toHaveLength(1);
    const winner = won[0]!;
    if (!winner.ok) throw new Error("unreachable");
    const turn = winner.proposal.usedByTurn!;
    for (const claim of claims.filter((c) => !c.ok)) {
      expect(claim).toEqual({ ok: false, turn, at: at.toISOString() });
    }

    // The record says so, the claim says so, and nothing half-written is left.
    const after = findProposal(await readProposals(dir.path), approved.id)!;
    expect(spendability(after.proposal)).toEqual({ kind: "spent", turn });
    expect(await readdir(join(dir.path, SPENT_DIR))).toEqual([`${approved.id}.json`]);
    const claim = JSON.parse(await readFile(join(dir.path, SPENT_DIR, `${approved.id}.json`), "utf8"));
    expect(claim).toEqual({ schema: SPEND_SCHEMA, proposal: approved.id, turn, at: at.toISOString(), action: approved.actionDigest });

    // And a later claim, from a reading that is stale by now, still loses.
    expect(await claimApproval(stored, "turn-late", new Date())).toEqual({ ok: false, turn, at: at.toISOString() });
  });

  test("a claim is the spend, whether or not the record's own copy was written", async () => {
    const { env } = await sandbox();
    const dir = await ensureProposalsDir(env, SUBJECT);
    if (!dir.ok) throw new Error(dir.reason);
    const bare = approvedOf("delete the old logs");
    const torn = { ...approvedOf("restart the service"), id: "torn" };
    const copied = { ...approvedOf("rotate the keys now"), id: "copied" };
    for (const p of [bare, torn, copied]) await writeProposal(dir.path, p);
    await writeProposal(dir.path, spendProposal(copied, "turn-in-record", new Date("2026-09-29T09:00:00.000Z")));

    // A process killed between the claim and the copy leaves exactly this: a
    // claim, and a record that does not know. The claim wins.
    await mkdir(join(dir.path, SPENT_DIR));
    const spentAt = "2026-09-29T10:00:00.000Z";
    await writeFile(join(dir.path, SPENT_DIR, `${bare.id}.json`), JSON.stringify({ schema: SPEND_SCHEMA, proposal: bare.id, turn: "turn-a", at: spentAt }));
    // A claim somebody edited into nonsense is still a claim: it exists.
    await writeFile(join(dir.path, SPENT_DIR, "torn.json"), "{not json");
    // Where the record has its copy, the record's copy is what is read.
    await writeFile(join(dir.path, SPENT_DIR, "copied.json"), JSON.stringify({ turn: "turn-in-claim", at: spentAt }));

    const inventory = await readProposals(dir.path);
    // `spent/` is a directory, so it is neither a record nor a broken one.
    expect(inventory.unreadable).toEqual([]);
    expect(inventory.proposals).toHaveLength(3);
    const state = (id: string) => spendability(findProposal(inventory, id)!.proposal);
    expect(state(bare.id)).toEqual({ kind: "spent", turn: "turn-a" });
    expect(findProposal(inventory, bare.id)!.proposal.usedAt).toBe(spentAt);
    expect(state("torn")).toEqual({ kind: "spent", turn: "unknown" });
    expect(findProposal(inventory, "torn")!.proposal.usedAt).toBeNull();
    expect(state("copied")).toEqual({ kind: "spent", turn: "turn-in-record" });
    expect(proposalLine(findProposal(inventory, bare.id)!.proposal)).toContain("approved, spent");
  });

  // chmod does not stop root, so these two cannot be made to fail as root.
  test.skipIf(AS_ROOT)("a record that cannot take its copy is still claimed; a claim that cannot be made throws", async () => {
    const { env } = await sandbox();
    const dir = await ensureProposalsDir(env, SUBJECT);
    if (!dir.ok) throw new Error(dir.reason);
    const approved = approvedOf("delete the old logs");
    await writeProposal(dir.path, approved);
    const stored = findProposal(await readProposals(dir.path), approved.id)!;

    // `spent/` writable, the store itself not: the claim lands, the copy does not.
    await mkdir(join(dir.path, SPENT_DIR), { mode: 0o700 });
    await chmod(dir.path, 0o500);
    try {
      const claim = await claimApproval(stored, "turn-1", new Date());
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;
      expect(claim.copyFailed).toContain("EACCES");
      expect(spendability(findProposal(await readProposals(dir.path), approved.id)!.proposal)).toEqual({ kind: "spent", turn: "turn-1" });
    } finally {
      await chmod(dir.path, 0o700);
    }

    // No claim can be written at all: thrown, so the caller sends nothing.
    const other = { ...approvedOf("restart the service"), id: "other" };
    await writeProposal(dir.path, other);
    const otherStored = findProposal(await readProposals(dir.path), "other")!;
    await chmod(join(dir.path, SPENT_DIR), 0o500);
    try {
      await expect(claimApproval(otherStored, "turn-2", new Date())).rejects.toThrow();
    } finally {
      await chmod(join(dir.path, SPENT_DIR), 0o700);
    }
    expect(spendability(findProposal(await readProposals(dir.path), "other")!.proposal)).toEqual({ kind: "ready" });
  });

  test("a hand-edited id cannot reach a path: the record is refused, and a rewrite goes where the record was read (D-144 review)", async () => {
    const { home, env } = await sandbox();
    const dir = await ensureProposalsDir(env, SUBJECT);
    if (!dir.ok) throw new Error(dir.reason);

    // An approved record whose id climbs out. It used to be read, found by that
    // id, and rewritten — at `proposals/../../escaped.json`.
    await writeFile(join(dir.path, "evil.json"), JSON.stringify({ ...approvedOf("delete the old logs"), id: "../../escaped" }));
    const inventory = await readProposals(dir.path);
    expect(inventory.proposals).toEqual([]);
    expect(inventory.unreadable.map((bad) => bad.reason)).toEqual([`id "../../escaped" is not one plain file name`]);
    expect(findProposal(inventory, "../../escaped")).toBeUndefined();
    for (const bad of ["../x", "a/b", "a\\b", ".hidden", "..", "", "x".repeat(129), "nul\0"]) expect(isProposalId(bad)).toBe(false);
    for (const good of [crypto.randomUUID(), "id-19", "a", "a.b_c-d"]) expect(isProposalId(good)).toBe(true);
    expect(() => proposalPath(dir.path, "../../escaped")).toThrow("not a proposal id");

    // A record whose file name and id differ is rewritten at its file, and its
    // claim is under its id — nothing is created beside it under the id's name.
    await rm(join(dir.path, "evil.json"));
    await writeFile(join(dir.path, "on-disk-name.json"), JSON.stringify({ ...approvedOf("restart the service"), id: "the-id" }));
    const stored = findProposal(await readProposals(dir.path), "the-id")!;
    expect(stored.path).toBe(join(dir.path, "on-disk-name.json"));
    const claim = await claimApproval(stored, "turn-1", new Date());
    expect(claim.ok).toBe(true);
    expect((await readdir(dir.path)).sort()).toEqual(["on-disk-name.json", SPENT_DIR]);
    expect(await readdir(join(dir.path, SPENT_DIR))).toEqual(["the-id.json"]);
    expect(JSON.parse(await readFile(join(dir.path, "on-disk-name.json"), "utf8")).usedByTurn).toBe("turn-1");
    expect(await readdir(home)).toEqual(["data"]);
  });

  test("only `.json` names are records: a write in flight and a backup are not a second approval (D-144 review)", async () => {
    const { env } = await sandbox();
    const dir = await ensureProposalsDir(env, SUBJECT);
    if (!dir.ok) throw new Error(dir.reason);
    const approved = approvedOf("delete the old logs");
    await writeProposal(dir.path, approved);
    const record = await readFile(proposalPath(dir.path, approved.id), "utf8");
    // The same record under the names a crash and a careful person leave behind.
    await writeFile(join(dir.path, `${approved.id}.json.mind-4242.tmp`), record);
    await writeFile(join(dir.path, `${approved.id}.json.bak`), record);
    await writeFile(join(dir.path, "notes.txt"), "not a record");

    const inventory = await readProposals(dir.path);
    expect(inventory.unreadable).toEqual([]);
    expect(inventory.proposals.map((stored) => stored.path)).toEqual([proposalPath(dir.path, approved.id)]);

    // And a copy that *is* named `.json` shares the one claim its id has:
    // spent once between them, whichever of the two a turn found.
    await writeFile(join(dir.path, "a-copy.json"), record);
    const both = (await readProposals(dir.path)).proposals;
    expect(both).toHaveLength(2);
    const claims = await Promise.all(both.map((stored, n) => claimApproval(stored, `turn-${n}`, new Date())));
    expect(claims.filter((claim) => claim.ok)).toHaveLength(1);
    const after = (await readProposals(dir.path)).proposals.map((stored) => spendability(stored.proposal).kind);
    expect(after).toEqual(["spent", "spent"]);
  });

  test("a claim's temporary file left by a killed process is swept; a live one is not (D-144 review)", async () => {
    const { env } = await sandbox();
    const dir = await ensureProposalsDir(env, SUBJECT);
    if (!dir.ok) throw new Error(dir.reason);
    const approved = approvedOf("delete the old logs");
    await writeProposal(dir.path, approved);
    const spent = join(dir.path, SPENT_DIR);
    await mkdir(spent);
    const orphan = join(spent, "gone.json.mind-1-x.tmp");
    const live = join(spent, "busy.json.mind-2-y.tmp");
    await writeFile(orphan, "{}");
    await writeFile(live, "{}");
    const old = new Date(Date.now() - ORPHAN_TEMP_MS - 60_000);
    await utimes(orphan, old, old);

    const stored = findProposal(await readProposals(dir.path), approved.id)!;
    expect((await claimApproval(stored, "turn-1", new Date())).ok).toBe(true);
    expect((await readdir(spent)).sort()).toEqual(["busy.json.mind-2-y.tmp", `${approved.id}.json`]);
  });

  test("filed again only when the turn that spent it sent nothing, and only once (D-144 §2)", async () => {
    const { env } = await sandbox();
    const dir = await ensureProposalsDir(env, SUBJECT);
    if (!dir.ok) throw new Error(dir.reason);
    const at = new Date("2026-09-29T12:00:00.000Z");
    const pending = { ...proposalOf("a question still waiting"), id: "pending" };
    const ready = { ...approvedOf("approved and not run yet"), id: "ready" };
    const ran = { ...spendProposal(approvedOf("a turn ran it, or may have"), "turn-ran", at), id: "ran" };
    const unsent = { ...spendProposal(approvedOf("the turn sent nothing"), "turn-unsent", at), id: "unsent", sentNothing: true as const };
    const done = { ...spendProposal(approvedOf("sent nothing and filed again"), "turn-done", at), id: "done", sentNothing: true as const };
    // Filed again after the yes, as a refile always is (a superseder from before the yes is not a refile of it).
    const again = { ...proposalOf("sent nothing and filed again"), id: "again", supersedes: "done", at: "2026-09-29T13:00:00.000Z" };
    for (const p of [pending, ready, ran, unsent, done, again]) await writeProposal(dir.path, p);

    const inventory = await readProposals(dir.path);
    // The flag round-trips, and only where it was written.
    expect(findProposal(inventory, "unsent")!.proposal.sentNothing).toBe(true);
    expect("sentNothing" in findProposal(inventory, "ran")!.proposal).toBe(false);
    expect(refileable(inventory).map((p) => p.id)).toEqual(["unsent"]);
    const problem = (id: string) => refileProblem(inventory, findProposal(inventory, id)!.proposal);
    expect(problem("pending")?.kind).toBe("not-refileable");
    expect(problem("ready")?.kind).toBe("not-refileable");
    // A turn that ran it, or may have: never offered — a second yes would run it a second time.
    expect(problem("ran")).toEqual({ kind: "not-refileable", reason: "turn turn-ran ran it or may have — only an approval whose turn sent nothing is filed again" });
    expect(problem("done")).toEqual({ kind: "already", by: "again" });
    expect(problem("unsent")).toBeUndefined();
    expect(proposalLine(findProposal(inventory, "unsent")!.proposal)).toContain("approved, spent (sent nothing)");
  });

  test("a refile is claimed once among any number at once, and the claim alone says it was filed again (D-144 follow-up)", async () => {
    const { env } = await sandbox();
    const dir = await ensureProposalsDir(env, SUBJECT);
    if (!dir.ok) throw new Error(dir.reason);
    const at = new Date("2026-09-29T12:00:00.000Z");
    const unsent = { ...spendProposal(approvedOf("the turn sent nothing"), "turn-unsent", at), id: "unsent", sentNothing: true as const };
    await writeProposal(dir.path, unsent);
    const stored = findProposal(await readProposals(dir.path), "unsent")!;
    expect(refileProblem(await readProposals(dir.path), stored.proposal)).toBeUndefined();

    // Ten at once, each from the same reading: one claim.
    const claims = await Promise.all(Array.from({ length: 10 }, (_, n) => claimRefile(stored, `new-${n}`, at)));
    const won = claims.findIndex((claim) => claim.ok);
    expect(claims.filter((claim) => claim.ok)).toHaveLength(1);
    for (const claim of claims.filter((c) => !c.ok)) expect(claim).toEqual({ ok: false, as: `new-${won}`, at: at.toISOString() });
    expect(JSON.parse(await readFile(join(dir.path, REFILED_DIR, "unsent.json"), "utf8"))).toEqual({
      schema: REFILE_SCHEMA, proposal: "unsent", as: `new-${won}`, at: at.toISOString(),
    });

    // No record for the new id was written — a crash between the claim and the
    // write. The refile is used up all the same: folded in, never offered again.
    const inventory = await readProposals(dir.path);
    expect(inventory.unreadable).toEqual([]);
    expect(findProposal(inventory, "unsent")!.proposal.refiledAs).toBe(`new-${won}`);
    expect(refileProblem(inventory, findProposal(inventory, "unsent")!.proposal)).toEqual({ kind: "already", by: `new-${won}` });
    expect(refileable(inventory)).toEqual([]);

    // A refile claim somebody edited into nonsense is still a claim.
    const other = { ...spendProposal(approvedOf("another that sent nothing"), "turn-other", at), id: "other", sentNothing: true as const };
    await writeProposal(dir.path, other);
    await writeFile(join(dir.path, REFILED_DIR, "other.json"), "{not json");
    const after = await readProposals(dir.path);
    expect(refileProblem(after, findProposal(after, "other")!.proposal)).toEqual({ kind: "already", by: "unknown" });
  });

  test("an approval from before approvals named their action is asked for again, once, and never listed as spent or runnable (D-153 follow-up)", async () => {
    const { env } = await sandbox();
    const dir = await ensureProposalsDir(env, SUBJECT);
    if (!dir.ok) throw new Error(dir.reason);
    const at = new Date("2026-09-29T12:00:00.000Z");
    /** Approved with no digest in its decision — before v0.10.0, or stripped. */
    const legacyOf = (what: string, id: string, over: Partial<Proposal> = {}): Proposal => {
      const approved = approvedOf(what);
      const { actionDigest: _, ...decision } = approved.decision!;
      return { ...approved, decision, id, ...over };
    };
    const legacy = legacyOf("an old yes", "legacy");
    const ready = { ...approvedOf("approved and bound"), id: "ready" };
    const unsent = { ...spendProposal(approvedOf("the turn sent nothing"), "turn-unsent", at), id: "unsent", sentNothing: true as const };
    // Spent with no digest: a turn had it before D-153 — not legacy, and not filed again (it ran or may have).
    const spentOld = legacyOf("an old yes, spent", "spent-old", { usedByTurn: "turn-old", usedAt: at.toISOString() });
    // Already asked again: by the button (its supersedes), or by hand — a later twin of any state, or a pending one.
    const viaButton = legacyOf("asked again by the button", "via-button");
    const button = { ...proposalOf("asked again by the button"), id: "button-new", supersedes: "via-button", at: "2026-09-29T13:00:00.000Z" };
    const byHand = legacyOf("asked again by hand", "by-hand");
    const handTwin = { ...spendProposal(approvedOf("Asked again  by hand"), "turn-hand", at), id: "hand-twin", at: "2026-10-05T15:48:18.320Z" };
    const waitingTwin = legacyOf("a twin is waiting", "waiting-twin");
    const waiting = { ...proposalOf("a twin is waiting"), id: "waiting", at: "2026-09-01T00:00:00.000Z" };
    // An earlier twin that was approved and spent answers nothing about a later yes.
    const laterYes = legacyOf("an earlier twin ran", "later-yes");
    const earlier = { ...spendProposal(approvedOf("an earlier twin ran"), "turn-earlier", at), id: "earlier", at: "2026-09-01T00:00:00.000Z" };
    for (const p of [legacy, ready, unsent, spentOld, viaButton, button, byHand, handTwin, waitingTwin, waiting, laterYes, earlier]) {
      await writeProposal(dir.path, p);
    }

    const inventory = await readProposals(dir.path);
    const of = (id: string) => findProposal(inventory, id)!.proposal;
    expect(isUnboundApproval(of("legacy"))).toBe(true);
    expect(unboundReason(of("legacy"))).toBe("no-action");
    expect(isUnboundApproval(of("ready"))).toBe(false);
    expect(isUnboundApproval(of("spent-old"))).toBe(false);
    expect(isUnboundApproval(of("waiting"))).toBe(false);
    const problem = (id: string) => refileProblem(inventory, of(id));
    expect(problem("legacy")).toBeUndefined();
    expect(problem("later-yes")).toBeUndefined();
    expect(problem("ready")?.kind).toBe("not-refileable");
    expect(problem("spent-old")).toEqual({ kind: "not-refileable", reason: "turn turn-old ran it or may have — only an approval whose turn sent nothing is filed again" });
    expect(problem("via-button")).toEqual({ kind: "already", by: "button-new" });
    const twinOf = (id: string) => { const p = problem(id); return p?.kind === "asked-again" ? p.by.id : p; };
    expect(twinOf("by-hand")).toBe("hand-twin");
    expect(twinOf("waiting-twin")).toBe("waiting");
    // Two lists, kept apart: the spent one that sent nothing, and the old yeses still to be asked for again.
    expect(refileable(inventory).map((p) => p.id)).toEqual(["unsent"]);
    expect(needsReapproval(inventory).map((p) => p.id).sort()).toEqual(["later-yes", "legacy"]);

    // Claimed once among any number at once, the way a spend is; then it leaves the list.
    const stored = findProposal(inventory, "legacy")!;
    const claims = await Promise.all(Array.from({ length: 6 }, (_, n) => claimRefile(stored, `new-${n}`, at)));
    expect(claims.filter((claim) => claim.ok)).toHaveLength(1);
    const after = await readProposals(dir.path);
    const won = findProposal(after, "legacy")!.proposal.refiledAs;
    expect(won).toMatch(/^new-\d$/);
    expect(refileProblem(after, findProposal(after, "legacy")!.proposal)).toEqual({ kind: "already", by: won! });
    expect(needsReapproval(after).map((p) => p.id)).toEqual(["later-yes"]);
    expect(refileable(after).map((p) => p.id)).toEqual(["unsent"]);
  });

  test("one twin rule, measured against the yes: a refusal the yes came after, or one the record supersedes, does not count (review of PR #29)", async () => {
    const { env } = await sandbox();
    const dir = await ensureProposalsDir(env, SUBJECT);
    if (!dir.ok) throw new Error(dir.reason);
    const refused = (what: string, id: string, at: string, decidedAt: string, over: Partial<Proposal> = {}): Proposal => ({
      ...proposalOf(what), id, at, ...over,
      decision: { outcome: "refused", at: decidedAt, by: "the owner", note: "no" },
    });
    const yes = (what: string, id: string, at: string, decidedAt: string, over: Partial<Proposal> = {}, digest = true): Proposal => {
      const p = { ...proposalOf(what), id, at, ...over };
      const d = decideProposal(p, { outcome: "approved", at: decidedAt, by: "the owner", note: null });
      if (typeof d === "string") throw new Error(d);
      if (digest) return d;
      const { actionDigest: _, ...decision } = d.decision!;
      return { ...d, decision };
    };
    // Repro 1: A refused; B the same what, filed with --changed (supersedes A), approved with no digest.
    const a = refused("Restart nginx", "a", "2026-09-10T00:00:00.000Z", "2026-09-10T01:00:00.000Z");
    const b = yes("Restart nginx", "b", "2026-09-11T00:00:00.000Z", "2026-09-11T01:00:00.000Z", { supersedes: "a", changed: "the config is fixed" }, false);
    // Repro 2: C filed 09-10; D the same what, filed and refused 09-11; C approved 09-12 with no digest.
    const c = yes("rotate the logs", "c", "2026-09-10T00:00:00.000Z", "2026-09-12T00:00:00.000Z", {}, false);
    // Filed through the CLI, D would supersede C (--changed past a waiting twin): filed before the yes, not a refile.
    const d = refused("rotate the logs", "d", "2026-09-11T00:00:00.000Z", "2026-09-11T01:00:00.000Z", { supersedes: "c" });
    // A refusal filed after the yes is the newer answer: E leaves every list.
    const e = yes("empty the trash", "e", "2026-09-10T00:00:00.000Z", "2026-09-10T01:00:00.000Z", {}, false);
    const f = refused("empty the trash", "f", "2026-09-20T00:00:00.000Z", "2026-09-20T01:00:00.000Z");
    // The spent-refile path (D-144 §2) asks the same rule: G's turn sent nothing, and G supersedes a refusal.
    const g0 = refused("prune docker", "g0", "2026-09-10T00:00:00.000Z", "2026-09-10T01:00:00.000Z");
    const g = { ...spendProposal(yes("prune docker", "g", "2026-09-11T00:00:00.000Z", "2026-09-11T01:00:00.000Z", { supersedes: "g0" }), "turn-g", new Date("2026-09-11T02:00:00.000Z")), sentNothing: true as const };
    // Down a chain: H supersedes H1, which supersedes the refused H0, filed after H1's own refusal.
    const h0 = refused("drop the cache", "h0", "2026-09-10T00:00:00.000Z", "2026-09-10T01:00:00.000Z");
    const h1 = refused("drop the cache", "h1", "2026-09-11T00:00:00.000Z", "2026-09-11T01:00:00.000Z", { supersedes: "h0" });
    const h = yes("drop the cache", "h", "2026-09-12T00:00:00.000Z", "2026-09-12T01:00:00.000Z", { supersedes: "h1" }, false);
    for (const p of [a, b, c, d, e, f, g0, g, h0, h1, h]) await writeProposal(dir.path, p);

    const inventory = await readProposals(dir.path);
    const of = (id: string) => findProposal(inventory, id)!.proposal;
    expect(refileProblem(inventory, of("b"))).toBeUndefined();
    expect(refileProblem(inventory, of("c"))).toBeUndefined();
    expect(refileProblem(inventory, of("h"))).toBeUndefined();
    expect(refileProblem(inventory, of("g"))).toBeUndefined();
    expect(askedAgain(inventory, of("e"))?.id).toBe("f");
    expect(needsReapproval(inventory).map((p) => p.id).sort()).toEqual(["b", "c", "h"]);
    expect(refileable(inventory).map((p) => p.id)).toEqual(["g"]);
    // A twin still waiting counts whenever it was filed — even one this record supersedes.
    await writeProposal(dir.path, { ...proposalOf("drop the cache"), id: "h-wait", at: "2026-09-01T00:00:00.000Z" });
    const later = await readProposals(dir.path);
    expect(askedAgain(later, findProposal(later, "h")!.proposal)?.id).toBe("h-wait");
  });

  test("twin times are compared as instants, not as text: mixed precision in one second, and an offset (review of PR #29)", async () => {
    const { env } = await sandbox();
    const dir = await ensureProposalsDir(env, SUBJECT);
    if (!dir.ok) throw new Error(dir.reason);
    /** Approved with no digest, the yes at `yesAt`. */
    const unbound = (what: string, id: string, yesAt: string): Proposal => {
      const d = decideProposal({ ...proposalOf(what), id, at: "2026-09-11T00:00:00.000Z" }, { outcome: "approved", at: yesAt, by: "the owner", note: null });
      if (typeof d === "string") throw new Error(d);
      const { actionDigest: _, ...decision } = d.decision!;
      return { ...d, decision };
    };
    const refused = (what: string, id: string, at: string): Proposal => ({
      ...proposalOf(what), id, at, decision: { outcome: "refused", at, by: "the owner", note: null },
    });
    // As text "…05Z" sorts after "…05.500Z"; as instants the refusal came half a second before the yes.
    await writeProposal(dir.path, unbound("before by half a second", "p1", "2026-09-11T00:00:05.500Z"));
    await writeProposal(dir.path, refused("before by half a second", "t1", "2026-09-11T00:00:05Z"));
    // As text "…05.500Z" sorts before "…05Z"; as instants the refusal came half a second after the yes.
    await writeProposal(dir.path, unbound("after by half a second", "p2", "2026-09-11T00:00:05Z"));
    await writeProposal(dir.path, refused("after by half a second", "t2", "2026-09-11T00:00:05.500Z"));
    // As text "…T01:30…+02:00" sorts after "…T00:00Z"; as an instant it is 23:30 the day before.
    await writeProposal(dir.path, unbound("an offset", "p3", "2026-09-11T00:00:00Z"));
    await writeProposal(dir.path, refused("an offset", "t3", "2026-09-11T01:30:00+02:00"));

    const inventory = await readProposals(dir.path);
    const twin = (id: string) => askedAgain(inventory, findProposal(inventory, id)!.proposal)?.id;
    expect(twin("p1")).toBeUndefined();
    expect(twin("p2")).toBe("t2");
    expect(twin("p3")).toBeUndefined();
    expect(needsReapproval(inventory).map((p) => p.id).sort()).toEqual(["p1", "p3"]);
  });

  test("an approval whose record no longer matches its yes, or whose digest is not one, cannot run and is asked for again (review of PR #29)", async () => {
    const { env } = await sandbox();
    const dir = await ensureProposalsDir(env, SUBJECT);
    if (!dir.ok) throw new Error(dir.reason);
    const bound = { ...approvedOf("approved and bound"), id: "bound" };
    const empty = approvedOf("a digest that is empty");
    const mismatch = approvedOf("a digest for something else");
    await writeProposal(dir.path, bound);
    await writeProposal(dir.path, { ...empty, id: "empty", decision: { ...empty.decision!, actionDigest: "" } });
    await writeProposal(dir.path, { ...mismatch, id: "mismatch", decision: { ...mismatch.decision!, actionDigest: "sha256:0000" } });
    // `null` on disk is read as "" — kept, never taken for "no digest".
    const nulled = join(dir.path, "nulled.json");
    const raw = JSON.parse(JSON.stringify({ ...approvedOf("a digest that is null"), id: "nulled" }));
    raw.decision.actionDigest = null;
    await writeFile(nulled, JSON.stringify(raw));

    const inventory = await readProposals(dir.path);
    const of = (id: string) => findProposal(inventory, id)!.proposal;
    expect(unboundReason(of("bound"))).toBeUndefined();
    for (const id of ["empty", "mismatch", "nulled"]) {
      expect(unboundReason(of(id))).toBe("changed");
      expect(refileProblem(inventory, of(id))).toBeUndefined();
    }
    expect(needsReapproval(inventory).map((p) => p.id).sort()).toEqual(["empty", "mismatch", "nulled"]);
    expect(refileable(inventory)).toEqual([]);
  });

  test("a refile claim names a proposal that was written, one being written, or one that never will be", async () => {
    const { env } = await sandbox();
    const dir = await ensureProposalsDir(env, SUBJECT);
    if (!dir.ok) throw new Error(dir.reason);
    await writeProposal(dir.path, { ...proposalOf("already written"), id: "written" });
    expect(await refileWritten(dir.path, "written", 0)).toBe(true);

    // Claimed and never written — a crash between the two: absent once the wait is over.
    const began = Date.now();
    expect(await refileWritten(dir.path, "never", 150)).toBe(false);
    expect(Date.now() - began).toBeGreaterThanOrEqual(150);

    // The winner of a race writes right after its claim; a loser looking in between waits for it.
    const late = Bun.sleep(100).then(() => writeProposal(dir.path, { ...proposalOf("written a moment later"), id: "late" }));
    expect(await refileWritten(dir.path, "late")).toBe(true);
    await late;
  });

  test("the one-line form says pending, the outcome, and whether it was spent", () => {
    const pending = proposalOf("delete the old logs");
    expect(proposalLine(pending)).toContain("pending");
    expect(proposalLine(pending)).toContain("delete the old logs");

    const approved = decideProposal(pending, {
      outcome: "approved",
      at: "2026-09-22T11:00:00.000Z",
      by: "the owner",
      note: null,
    });
    if (typeof approved === "string") throw new Error(approved);
    expect(proposalLine(approved)).toContain("approved");
    expect(proposalLine(approved)).not.toContain("spent");
    expect(proposalLine(spendProposal(approved, "turn-1", new Date()))).toContain("approved, spent");
  });
});
