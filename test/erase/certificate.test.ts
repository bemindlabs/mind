/**
 * AC2 — the certificate: what, how many records, when, who asked.
 *
 * The interesting assertions here are all about what the document must *not*
 * say. A certificate is the artefact somebody keeps and quotes later, so every
 * way it could overstate is a way a person acts on a deletion that did not
 * happen:
 *
 * - it must never put a `5` next to a deletion, because two of AC1's five
 *   places have no code behind them;
 * - it must not carry the text of a `--needle`, because echoing the thing
 *   somebody asked to delete into a file they will keep is the opposite of the
 *   request;
 * - it must not carry a hash of what was removed either — a digest of a name,
 *   an address or a short prompt is guessable, which is the same reasoning that
 *   keeps `--private` from storing one;
 * - `who` must read as a claim rather than as an attestation, because Mind
 *   authenticates nobody.
 *
 * And one about what it must say: on a dry run, that the verification did not
 * run. A document whose verification section is full of zeros because nothing
 * was checked looks exactly like one where everything was clean.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { templateFiles } from "../../src/agent/template.ts";
import {
  CERTIFICATE_SCHEMA,
  certificate,
  formatCertificate,
} from "../../src/erase/certificate.ts";
import { commitErase, planErase, verifyErase, type EraseEnv } from "../../src/erase/plan.ts";
import { subjectId } from "../../src/types.ts";
import { git } from "../support/trap-git.ts";

const SUBJECT = subjectId("example");
const SECRET = "a phrase nobody should see twice";

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-erase-cert-"));
  scratch.push(dir);
  return dir;
}

function envFor(home: string): EraseEnv {
  return {
    home,
    env: {
      XDG_STATE_HOME: join(home, "state"),
      XDG_DATA_HOME: join(home, "data"),
      // Port 9 (discard) on loopback: nothing listens, so the vector store is
      // unreachable and the run never asks the Qdrant on this machine anything.
      // With no marker that is a note, not a refusal (D-038).
      MIND_QDRANT_URL: "http://127.0.0.1:9",
    },
    now: () => new Date("2026-09-21T10:00:00.000Z"),
  };
}

/** An agent with a soul and one captured record. Enough for every row. */
async function fixture(home: string): Promise<string> {
  const agent = join(home, "agents", SUBJECT);
  for (const file of templateFiles(SUBJECT, SUBJECT)) {
    await Bun.write(join(agent, file.path), file.content);
  }
  await Bun.write(
    join(home, "data", "mind", SUBJECT, "personal", "observer", "raw.jsonl"),
    `{"what":"typed"}\n`,
  );
  return agent;
}

async function planFor(home: string, agent: string) {
  return planErase(envFor(home), {
    subject: SUBJECT,
    agentDir: agent,
    scope: "all",
    by: "a reviewer",
    needles: [SECRET],
    instructionFiles: [],
    soulName: "Example Agent",
    personalValues: [],
  });
}

function issue(
  plan: Awaited<ReturnType<typeof planFor>>,
  result: Awaited<ReturnType<typeof commitErase>> | null,
  verification: Awaited<ReturnType<typeof verifyErase>> | null,
) {
  return certificate({
    plan,
    result,
    verification,
    observedAccount: "ci",
    engine: "0.0.1-test",
    issuedAt: "2026-09-21T10:00:01.000Z",
  });
}

// ---------------------------------------------------------------------------
// What it says
// ---------------------------------------------------------------------------

describe("the document", () => {
  test("it carries all four of AC2's questions", async () => {
    const home = await sandbox();
    const agent = await fixture(home);
    const plan = await planFor(home, agent);
    const result = await commitErase(plan);
    const cert = issue(plan, result, await verifyErase(plan, result));

    expect(cert.schema).toBe(CERTIFICATE_SCHEMA);
    // *what*: one row per place, in AC1's order.
    expect(cert.places.map((place) => place.place)).toEqual([
      "soul",
      "observer",
      "rag",
      "ledger",
      "lora",
    ]);
    // *how many records*: counted, per place.
    expect(cert.places.find((place) => place.place === "soul")!.records).toBeGreaterThan(0);
    // *when*: both instants, because a plan and its document are not the same
    // moment and a reader deciding whether this is current needs the later one.
    expect(cert.plannedAt).toBe("2026-09-21T10:00:00.000Z");
    expect(cert.issuedAt).toBe("2026-09-21T10:00:01.000Z");
    // *who asked*, as two different kinds of thing.
    expect(cert.by.claimed).toBe("a reviewer");
    expect(cert.by.observed).toBe("ci");
    expect(cert.by.note).toContain("authenticates neither");
  }, 30_000);

  test("it says 4 of 4 that exist and 1 of 5 not built — never 5 deleted", async () => {
    const home = await sandbox();
    const agent = await fixture(home);
    const plan = await planFor(home, agent);
    const cert = issue(plan, null, null);

    expect(cert.tally).toContain("4 of 4 places that exist were visited");
    expect(cert.tally).toContain("1 of 5 are not built");

    const whole = JSON.stringify(cert);
    expect(whole).not.toContain("5 of 5");
    expect(whole).not.toContain("5/5");

    for (const id of ["lora"] as const) {
      const row = cert.places.find((place) => place.place === id)!;
      expect(row.status).toBe("not-built");
      expect(row.records).toBe(0);
      expect(row.owedBy).toBeString();
      expect(row.reserved?.path).toContain(".mind");
      expect(row.detail.join(" ")).toContain("nothing in Mind writes here");
    }
  }, 30_000);

  test("the soul row names all three of its locations", async () => {
    const home = await sandbox();
    const agent = await fixture(home);
    const cert = issue(await planFor(home, agent), null, null);

    const detail = cert.places.find((place) => place.place === "soul")!.detail.join("\n");
    expect(detail).toContain("the soul in git");
    expect(detail).toContain("the derived directory");
    expect(detail).toContain("the apply backups");
    expect(detail).toContain("three places, not one");
  }, 30_000);

  test("the ledger row names who already received the lines", async () => {
    const home = await sandbox();
    const agent = await fixture(home);
    const cert = issue(await planFor(home, agent), null, null);

    const detail = cert.places.find((place) => place.place === "ledger")!.detail.join("\n");
    // Nothing was ever sent in this fixture, and the row says that rather than
    // leaving the heading with nothing under it.
    expect(detail).toContain("no backend is named in these lines");
  }, 30_000);

  test("git is a count and a disclosure, never a search", async () => {
    const home = await sandbox();
    const agent = await fixture(home);
    // `mind new` makes a repository; this fixture writes the template files
    // without one, so the document has to say the history was not counted
    // rather than count it. Under `@2` it said `git 0 commit(s) · no remote
    // configured` here, which is a statement about a repository there isn't.
    await git(agent, ["init", "-q"]);
    const cert = issue(await planFor(home, agent), null, null);

    expect(cert.agent.examined).toBe(true);
    expect(cert.agent.history).toBe("read");
    expect(cert.agent.note).toContain("object database was never searched");
    expect(cert.verification.notSearched.join("\n")).toContain("git objects");
    // And git's own undeletable list is on the document, under the soul place.
    const undeletable = cert.undeletable.find((entry) => entry.place === "soul")!;
    expect(undeletable.lines.join("\n")).toContain("Rewriting history");

    // Counted, and zero — so the row says which zero it is rather than
    // printing one. `mind new` leaves exactly this state behind (D-013).
    expect(cert.agent.commits).toBe(0);
    const page = formatCertificate(cert).join("\n");
    expect(page).toContain("no commit yet");
    expect(page).not.toContain("0 commit(s)");
  }, 30_000);

  test("a directory with no repository is said, not counted", async () => {
    const home = await sandbox();
    const cert = issue(await planFor(home, await fixture(home)), null, null);

    expect(cert.agent.examined).toBe(true);
    expect(cert.agent.history).toBe("not-a-repository");
    expect(cert.agent.commits).toBeNull();
    expect(cert.agent.remotes).toEqual([]);
    expect(cert.agent.note).toContain("not a git repository");

    const page = formatCertificate(cert).join("\n");
    expect(page).toContain("no repository at this path");
    expect(page).not.toContain("0 commit(s)");
    // `examined: true` and no number is not a contradiction: the directory was
    // visited, and what was there to count was nothing rather than zero.
    expect(page).not.toContain("not examined");
  }, 30_000);

  test("a machine with no git says so, and says it is not a zero", async () => {
    // dod1's fifth state, and the one the DoD's own evidence is issued under:
    // the bare container has no git by design, so every certificate the demo
    // produces carries this. The plan's facts are substituted rather than
    // measured — `certificate` is pure, and making the real `planErase` produce
    // them needs a process with no git in it, which is
    // `test/guard/history.test.ts`'s job and is proved there.
    const home = await sandbox();
    const plan = await planFor(home, await fixture(home));
    const cert = issue(
      {
        ...plan,
        git: { readable: false, why: "no-git", detail: 'Executable not found in $PATH: "git"' },
      },
      null,
      null,
    );

    // `@5` since S15.8, which added the `kept` scope kind; `no-git` is `@4`'s and still means what it did.
    // The id is on the wire, so it follows the one switch: the pair's member, never a spelling typed here.
    expect(cert.schema).toBe(CERTIFICATE_SCHEMA);
    expect(cert.agent.history).toBe("no-git");
    expect(cert.agent.commits).toBeNull();
    expect(cert.agent.remotes).toEqual([]);

    // The reader must be sent to the right place. "git is not here" and "git
    // would not read this repository" are fixed by different people doing
    // different things, so the note may not read as the other one.
    expect(cert.agent.note).toContain("no git on this machine");
    expect(cert.agent.note).not.toContain("declined to read");

    const page = formatCertificate(cert).join("\n");
    expect(page).toContain("UNKNOWN");
    expect(page).not.toContain("0 commit(s)");
    expect(page).not.toContain("not examined");
    // And the sentence is in the statement, where a reader meets it, rather
    // than only in a field three sections down.
    expect(cert.statement.join("\n")).toContain("no git on this machine");
    expect(cert.statement.join("\n")).toContain("not zero");
  }, 30_000);

  test("the five states of `history` each print a different line", async () => {
    // The control for the test above: it would pass just as well if every state
    // printed the same words. Nothing here reads a number — what is checked is
    // that five distinct answers reach the page as five distinct sentences.
    const home = await sandbox();
    const plan = await planFor(home, await fixture(home));
    const states = [
      null,
      { readable: true, commits: 2, remotes: [{ name: "origin", url: "file:///x" }] },
      { readable: false, why: "not-a-repository", detail: "not a git repository" },
      { readable: false, why: "unreadable", detail: "fatal: bad config line 1" },
      { readable: false, why: "no-git", detail: 'Executable not found in $PATH: "git"' },
    ] as const;

    const lines = states.map((git) => {
      const page = formatCertificate(issue({ ...plan, git }, null, null));
      return page.find((line) => line.startsWith("git "))!;
    });

    expect(lines.filter((line) => line !== undefined)).toHaveLength(5);
    expect(new Set(lines).size, `two states print the same line: ${lines.join(" | ")}`).toBe(5);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// What it must not say
// ---------------------------------------------------------------------------

describe("what never reaches the document", () => {
  test("a --needle is counted and its text is nowhere in the certificate", async () => {
    const home = await sandbox();
    const agent = await fixture(home);
    // Plant it where a search will find it, so the count is real.
    await Bun.write(join(home, "state", "mind", "note.txt"), `${SECRET}\n`);

    const plan = await planFor(home, agent);
    expect(plan.needles.some((needle) => needle.text === SECRET)).toBe(true);

    const result = await commitErase(plan);
    const verification = await verifyErase(plan, result);
    const cert = issue(plan, result, verification);

    expect(verification.search.deletableHits).toBeGreaterThan(0);
    expect(cert.verification.where.join("\n")).toContain("--needle #1");
    // The whole document, serialised. This is the assertion that matters.
    expect(JSON.stringify(cert)).not.toContain(SECRET);
    expect(formatCertificate(cert).join("\n")).not.toContain(SECRET);
  }, 30_000);

  test("there is no hash of anything that was deleted", async () => {
    const home = await sandbox();
    const agent = await fixture(home);
    const plan = await planFor(home, agent);
    const result = await commitErase(plan);
    const cert = issue(plan, result, await verifyErase(plan, result));

    // A 64-character hex run is what a sha256 looks like on the page. The
    // reasoning is `--private`'s: a digest of a short prompt or a name is
    // guessable, so "proof of what was removed" would leak what was removed.
    expect(JSON.stringify(cert)).not.toMatch(/[0-9a-f]{64}/);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The dry run
// ---------------------------------------------------------------------------

describe("a dry run", () => {
  test("the verdict is dry-run and the verification says it did not run", async () => {
    const home = await sandbox();
    const agent = await fixture(home);
    const cert = issue(await planFor(home, agent), null, null);

    expect(cert.verdict).toBe("dry-run");
    expect(cert.verification.ran).toBe(false);
    expect(cert.verification.where).toEqual([]);
    // A section full of zeros because nothing was checked reads exactly like
    // one where everything was clean, so the human form says so in words.
    expect(formatCertificate(cert).join("\n")).toContain("verification did not run");
  }, 30_000);

  test("it reports what would go, not what went", async () => {
    const home = await sandbox();
    const agent = await fixture(home);
    const cert = issue(await planFor(home, agent), null, null);

    const soul = cert.places.find((place) => place.place === "soul")!;
    expect(soul.records).toBeGreaterThan(0);
    expect(await Bun.file(join(agent, "soul", "role.md")).exists()).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// A document over nothing — what `@2` exists for
// ---------------------------------------------------------------------------

/** Erase a subject this home has never held, and issue the document for it. */
async function overNothing(home: string) {
  const plan = await planErase(envFor(home), {
    subject: SUBJECT,
    agentDir: null,
    scope: "all",
    by: "a reviewer",
    needles: [],
    instructionFiles: [],
    soulName: null,
    personalValues: [],
  });
  const result = await commitErase(plan);
  const verification = await verifyErase(plan, result);
  return { verification, cert: issue(plan, result, verification) };
}

describe("nothing was found", () => {
  test("the document says so in words, and says it is not a certificate of erasure", async () => {
    const home = await sandbox();
    const { cert } = await overNothing(home);
    const statement = cert.statement.join("\n");

    expect(cert.verdict).toBe("nothing-found");
    expect(statement).toContain("NOTHING WAS ERASED");
    expect(statement).toContain("This document is not a certificate of erasure");
    // The claim this whole task is about must be nowhere on the page, in either
    // form — the verdict is what a script reads, the prose is what a person
    // reads, and a document that says "erased and verified" anywhere would be
    // quoted for that sentence alone.
    const whole = `${JSON.stringify(cert)}\n${formatCertificate(cert).join("\n")}`;
    expect(whole).not.toContain("erased-and-verified");
    expect(whole).not.toContain("erased and verified");
    expect(cert.verification.removed.total).toBe(0);
    expect(cert.verification.found.total).toBe(0);
  }, 30_000);

  test("it states the limit: never existed and erased earlier cannot be told apart", async () => {
    const home = await sandbox();
    const { cert } = await overNothing(home);
    const statement = cert.statement.join("\n");

    expect(statement).toContain('Mind cannot tell "this subject never existed here"');
    expect(statement).toContain("keeps no record of past erasures");
    // And where the evidence of an earlier erasure actually is, since it is not
    // here: the certificate that run issued, which the owner keeps.
    expect(statement).toContain("the certificate that run issued is the evidence");
  }, 30_000);

  test("with no file read at all, it says the roots may be pointed elsewhere", async () => {
    const home = await sandbox();
    const { cert } = await overNothing(home);

    expect(cert.verification.filesRead).toBe(0);
    expect(cert.statement.join("\n")).toContain("XDG_STATE_HOME");
  }, 30_000);

  test("with files read, it says to check the spelling — and names no other subject", async () => {
    // The mistyped id, as the document meets it. The count of files is on the
    // page; which other identities this machine holds is not. This document may
    // be handed to the person whose data was withdrawn, and a list of their
    // neighbours would be a leak committed by the instrument of privacy itself.
    const home = await sandbox();
    const elsewhere = "somebody-else";
    await Bun.write(
      join(home, "state", "mind", "ledger", elsewhere, "turns.jsonl"),
      `{"subject":"${elsewhere}","prompt":"their words"}\n`,
    );

    const { cert } = await overNothing(home);

    expect(cert.verdict).toBe("nothing-found");
    expect(cert.verification.filesRead).toBeGreaterThan(0);
    const statement = cert.statement.join("\n");
    expect(statement).toContain("check the spelling");
    expect(statement).toContain("its data has not been touched");
    expect(JSON.stringify(cert)).not.toContain(elsewhere);
    expect(formatCertificate(cert).join("\n")).not.toContain(elsewhere);
  }, 30_000);

  test("the page carries found, removed and read — the three numbers a claim rests on", async () => {
    const home = await sandbox();
    const { cert } = await overNothing(home);
    const text = formatCertificate(cert).join("\n");

    expect(text).toContain("found        before deletion: 0 file(s)");
    expect(text).toContain("removed      0 thing(s)");
    expect(text).toContain("read         after: 0 file(s)");
    // Per scope, so that a zero says over how many places it is a zero.
    expect(text).toContain("state root 0");
    expect(cert.verification.scopes.map((scope) => scope.label)).toContain("data root");
  }, 30_000);

  test("a dry run over nothing says --yes would issue no erasure verdict", async () => {
    const home = await sandbox();
    const plan = await planErase(envFor(home), {
      subject: SUBJECT,
      agentDir: null,
      scope: "all",
      by: "a reviewer",
      needles: [],
      instructionFiles: [],
      soulName: null,
      personalValues: [],
    });
    const cert = issue(plan, null, null);

    expect(cert.verdict).toBe("dry-run");
    expect(cert.statement.join("\n")).toContain("would issue no erasure verdict");
    expect(cert.verification.found.total).toBe(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The human form
// ---------------------------------------------------------------------------

describe("formatCertificate", () => {
  test("every place, every list and both scopes of the search are on the page", async () => {
    const home = await sandbox();
    const agent = await fixture(home);
    const plan = await planFor(home, agent);
    const result = await commitErase(plan);
    const text = formatCertificate(issue(plan, result, await verifyErase(plan, result))).join("\n");

    expect(text).toContain("erase certificate");
    expect(text).toContain("verdict      erased-and-verified");
    for (const id of ["soul", "observer", "rag", "ledger", "lora"]) expect(text).toContain(id);
    expect(text).toContain("searched:");
    expect(text).toContain("not searched, and therefore not certified:");
    expect(text).toContain("how coarse this search is:");
    expect(text).toContain("what deletion does not reach — soul:");
    expect(text).toContain("what deletion does not reach — lora:");
  }, 30_000);

  test("--no-agent is on the page as `not examined`, not as `clean`", async () => {
    const home = await sandbox();
    await fixture(home);

    const plan = await planErase(envFor(home), {
      subject: SUBJECT,
      agentDir: null,
      scope: "all",
      by: "a reviewer",
      needles: [],
      instructionFiles: [],
      soulName: null,
      personalValues: [],
    });
    const cert = issue(plan, null, null);

    expect(cert.agent.examined).toBe(false);
    expect(cert.agent.commits).toBeNull();
    expect(cert.agent.note).toContain("at the requester's word");
    expect(formatCertificate(cert).join("\n")).toContain("git          not examined");

    // The soul place is still *reached* without a repository — the backups are
    // one of its three locations — so the tally is honest at 4 of 4 and the
    // narrowing lives in the agent note, where it names the two locations that
    // were skipped rather than hiding inside a number.
    expect(cert.tally).toContain("4 of 4 places that exist were visited");
    expect(cert.agent.note).toContain("soul/, .mind/ and the working tree were not");
    const soul = cert.places.find((place) => place.place === "soul")!;
    expect(soul.detail.join("\n")).toContain("the apply backups");
    expect(soul.detail.join("\n")).not.toContain("the soul in git");
  }, 30_000);
});
