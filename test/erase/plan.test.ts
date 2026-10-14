/**
 * S7.2 end to end at the module level — plan, commit, re-read, decide.
 *
 * The fixture below is the point of this file. A subject with data in *every*
 * place Mind can write to — a soul in a working tree, a derived `.mind/`, a
 * capture tree under the personal directory, a month of ledger lines, a backup
 * of an instruction file, and an applied block inside that file — plus a second
 * subject with the same, so that I-3 is checked by comparing bytes rather than
 * by reading the code.
 *
 * Every assertion about "it is gone" is taken from the filesystem *after* the
 * deletion. None is derived from what the plan said it would do: the control in
 * `test/observer/purge.test.ts` showed exactly how a command that reports its
 * own plan back prints `0 remaining` over a file still sitting on disk, and
 * this command has four trees to get that wrong in instead of one.
 *
 * Three controls carry more weight than the happy path:
 *
 * - a planted identifier in the state root makes the verdict
 *   `erased-with-remainder`, so AC3's zero is falsifiable;
 * - something at the address D-014 reserves for a `not-built` place refuses the
 *   whole run, so AC1's "two of these do not exist" is enforced rather than
 *   printed;
 * - a dry run changes no byte, compared file by file.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { templateFiles } from "../../src/agent/template.ts";
import { certificate, formatCertificate } from "../../src/erase/certificate.ts";
import { commitErase, planErase, verifyErase, type EraseEnv } from "../../src/erase/plan.ts";
import { BROWSER_SCHEMA, containerName, createRecord } from "../../src/browser/store.ts";
import { recordPath, wiringDir } from "../../src/browser/paths.ts";
import { confirmationsPath, setConfirmation } from "../../src/decide/confirm.ts";
import { collectionFor } from "../../src/memory/collection.ts";
import { RAG_MARKER_FILE, ragDirFor, writeRagMarker } from "../../src/memory/marker.ts";
import { splice } from "../../src/soul/block.ts";
import type { LedgerEntry } from "../../src/ledger/entry.ts";
import { append, canAppend, ledgerDir } from "../../src/ledger/store.ts";
import { LOCK_TIMING, type ThisMachine } from "../../src/ledger/lock.ts";
import { UNREPORTED_USAGE, subjectId, type SubjectId } from "../../src/types.ts";
import { identityDirFor, keyPath } from "../../src/identity/dir.ts";
import { ensureAgentKey } from "../../src/identity/key.ts";

const SUBJECT = subjectId("example");
const OTHER = subjectId("somebody-else");
/** Where this subject's vectors are indexed: from the one function that names it. */
const COLLECTION = collectionFor(SUBJECT);

/** A string that exists nowhere else, planted so "not found" is evidence. */
const CANARY = "canary-4e19c2-erase";

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-erase-plan-"));
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

function entryFor(subject: SubjectId, text: string): LedgerEntry {
  return {
    v: 1,
    kind: "turn",
    id: `${subject}-1`,
    turn: `${subject}-turn`,
    at: "2026-09-21T09:00:00.000Z",
    subject,
    backend: "ollama",
    model: null,
    content: "full",
    prompt: text,
    prompt_bytes: text.length,
    text: "an answer",
    text_bytes: 9,
    confidence: "confirmed",
    exit: 0,
    duration_ms: 12,
    cost: null,
    usage: UNREPORTED_USAGE,
    identity: "system",
    soul_sha: null,
  };
}

/** Everything one subject can have on disk, in all five kinds of place. */
async function fixture(
  home: string,
  subject: SubjectId,
): Promise<{ agent: string; instruction: string }> {
  const env = envFor(home);
  const agent = join(home, "agents", subject);

  for (const file of templateFiles(subject, subject)) {
    await Bun.write(join(agent, file.path), file.content);
  }
  await Bun.write(join(agent, ".mind", "soul", "rendered.md"), `# ${subject}\n${CANARY}\n`);
  await Bun.write(join(agent, ".mind", "manifest.json"), `{"subject":"${subject}"}\n`);
  // What an earlier release left under its own name: erase counts it, removes it and searches for the canary after.
  await Bun.write(join(agent, ".mind", "soul", "rendered.md"), `# ${subject}\n${CANARY}\n`);
  await Bun.write(join(agent, ".mind", "manifest.json"), `{"subject":"${subject}"}\n`);

  await Bun.write(
    join(home, "data", "mind", subject, "personal", "observer", "raw.jsonl"),
    `{"subject":"${subject}","what":"typed","note":"${CANARY}"}\n`,
  );

  await append(env, entryFor(subject, `a prompt holding ${CANARY}`));

  // An instruction file with this subject's block in it, and the backup
  // `soul apply` would have taken before writing it.
  // The human's own text deliberately does not mention the subject: what has
  // to survive the strip is somebody else's writing, and what has to disappear
  // is Mind's block.
  const instruction = join(home, `.${subject}`, "CLAUDE.md");
  const spliced = splice("# my own notes\n\nkeep this.\n", {
    subject,
    body: `# identity\n\nsubject ${subject}`,
  });
  if (spliced.kind !== "spliced") throw new Error(spliced.reason);
  await Bun.write(instruction, spliced.next);

  const backup = join(home, "state", "mind", "backups", subject, "20260921T090000000Z");
  await Bun.write(join(backup, "1-CLAUDE.md"), spliced.next);
  await Bun.write(
    join(backup, "manifest.json"),
    JSON.stringify({ schema: "mind/soul-apply-backup@1", subject, files: [{ path: instruction }] }),
  );

  return { agent, instruction };
}

/** Every regular file under `root` that holds `needle`, as bytes. */
async function grepTree(root: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && (await Bun.file(path).text()).includes(needle)) hits.push(path);
    }
  };
  await walk(root);
  return hits;
}

function request(agent: string | null, instruction: string[], over: Partial<Parameters<typeof planErase>[1]> = {}) {
  return {
    subject: SUBJECT,
    agentDir: agent,
    scope: "all" as const,
    by: "the owner",
    needles: [] as readonly string[],
    instructionFiles: instruction,
    soulName: SUBJECT as string | null,
    personalValues: [] as readonly string[],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

describe("a subject's tasks end before anything is removed (review of PR #22)", () => {
  test("the dry run names them; the commit stops them first — runner signalled, step turn ended — then erases", async () => {
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);
    const env = envFor(home);
    const tasks = join(home, "data", "mind", SUBJECT, "personal", "tasks");
    const { TASK_SCHEMA } = await import("../../src/task/store.ts");
    const base = {
      schema: TASK_SCHEMA, subject: SUBJECT, goal: "g", dir: mine.agent, cwd: home, createdAt: "2026-10-05T00:00:00.000Z", via: "cli", backend: null, model: null,
      operate: 0, allow: [], budget: { turns: 5, minutes: 5, tokens: null }, stepSeconds: 60, approvalSeconds: 60, statusAt: "x", reason: null, plan: null, steps: [],
      result: null, used: { turns: 0, activeMs: 0, tokens: 0, tokensUnknown: 0 }, runner: null, current: null, browser: null, notes: [], generation: 1,
    };
    for (const [id, status] of [["t-0000aaaa", "running"], ["t-0000bbbb", "done"]] as const) {
      await mkdir(join(tasks, id), { recursive: true });
      await writeFile(join(tasks, id, "task.json"), JSON.stringify({ ...base, id, status }));
    }
    const plan = await planErase(env, request(mine.agent, [mine.instruction]));
    expect(plan.tasks).toEqual(["t-0000aaaa"]);
    expect(plan.notes.join(" ")).toContain("1 task(s) of this subject have not ended (t-0000aaaa)");
    const order: string[] = [];
    const result = await commitErase(plan, undefined, async (at, subject, runs) => {
      order.push(`tasks ${at === tasks} ${subject} ${runs === join(home, "state", "mind", "runs")}`);
      // Nothing was removed yet when the tasks were ended.
      order.push(`task file still there: ${await Bun.file(join(tasks, "t-0000aaaa", "task.json")).exists()}`);
      return [{ id: "t-0000aaaa", runner: "ended", turn: null }];
    });
    expect(order).toEqual([`tasks true ${SUBJECT} true`, "task file still there: true"]);
    expect(result.tasks).toEqual([{ id: "t-0000aaaa", runner: "ended", turn: null }]);
    expect((await verifyErase(plan, result)).verdict).toBe("erased-and-verified");
    expect(await Bun.file(join(tasks, "t-0000aaaa", "task.json")).exists()).toBe(false);
  }, 30_000);
});

describe("a full erase", () => {
  test("everything Mind can delete goes, and the recount is read off the disk", async () => {
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);
    // A bot approval (S9 AC5): erase has to take it with the rest.
    const botConsent = join(home, "state", "mind", "bots", SUBJECT, "consent.json");
    await Bun.write(botConsent, JSON.stringify({ approvals: [{ botId: "bot-a", endpointOrigin: "http://127.0.0.1:1", approvedBy: CANARY, approvedAt: "t" }] }));

    // The control for the control: the canary really is there to begin with.
    expect((await grepTree(home, CANARY)).length).toBeGreaterThan(0);

    const env = envFor(home);
    const plan = await planErase(env, request(mine.agent, [mine.instruction]));
    expect(plan.refusals).toEqual([]);
    // Fifteen trees: the soul, the derived directory, the backups, the level-3
    // confirmations (D-042), the rag marker (D-038), the run records (S5.4), the browser task records (D-151),
    // the trigger fire times (S5.3), the A2A peers (D-063), the chat
    // allowlist (D-066), the bot approvals (S9 AC5), the push handles (D-130), the basis records (D-077), the personal directory and the
    // agent's signing key (S15.8). The block and the ledger lines are counted separately.
    expect(plan.trees.length).toBe(15);
    expect(plan.blocks.filter((block) => block.outcome === "strip").length).toBe(1);
    expect(plan.ledger.matched.length).toBe(1);

    const result = await commitErase(plan);
    const verification = await verifyErase(plan, result);

    expect(verification.search.scopes.flatMap((scope) => scope.hits)).toEqual([]);
    expect(verification.verdict).toBe("erased-and-verified");
    expect(verification.remainingFiles).toBe(0);
    expect(verification.failures).toBe(0);
    expect(verification.search.deletableHits).toBe(0);
    expect(verification.search.gitHits).toBe(0);

    // I-4's own words: search afterwards and the text is not there.
    expect(await grepTree(join(home, "state"), CANARY)).toEqual([]);
    expect(await grepTree(join(home, "data"), CANARY)).toEqual([]);
    expect(await grepTree(mine.agent, CANARY)).toEqual([]);

    // The three soul locations, each checked rather than assumed.
    expect(await Bun.file(join(mine.agent, "soul", "role.md")).exists()).toBe(false);
    expect(await Bun.file(join(mine.agent, ".mind", "manifest.json")).exists()).toBe(false);
    expect(await Bun.file(join(mine.agent, ".mind", "manifest.json")).exists()).toBe(false);
    expect(await Bun.file(mine.instruction).text()).toBe("# my own notes\n\nkeep this.\n");
    expect(await Bun.file(join(home, "state", "mind", "backups", SUBJECT)).exists()).toBe(false);
    expect(await Bun.file(ledgerDir(env, SUBJECT)).exists()).toBe(false);
    expect(await Bun.file(botConsent).exists()).toBe(false);

    // And what is deliberately kept: the files that were never this subject's
    // to begin with, and the repository itself.
    expect(await Bun.file(join(mine.agent, "memory", "README.md")).exists()).toBe(true);
    expect(await Bun.file(join(mine.agent, ".gitignore")).exists()).toBe(true);
  }, 30_000);

  test("the ledger's lock: a killed turn's lock does not hold an erase up, and erase's own is this machine's (D-145)", async () => {
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);
    // What `bin/commands/erase.ts` hands in, read the same way (`thisMachine()` in bin/shared.ts).
    const here: ThisMachine = { host: hostname(), bootedAt: Date.now() - uptime() * 1000 };
    const env: EraseEnv = { ...envFor(home), machine: here };

    // A turn killed while it held the ledger's lock: its owner names this machine, and its pid is gone.
    const dead = Bun.spawn([process.execPath, "-e", "0"], { stdout: "ignore", stderr: "ignore" });
    await dead.exited;
    const lock = join(ledgerDir(env, SUBJECT), ".lock");
    await mkdir(lock, { recursive: true, mode: 0o700 });
    const owner = { pid: dead.pid, host: here.host, started: new Date().toISOString() };
    await writeFile(join(lock, `owner.${crypto.randomUUID()}.json`), JSON.stringify(owner));

    const plan = await planErase(env, request(mine.agent, [mine.instruction]));
    // Carried to the commit, so the commit judges the lock as a turn would — and writes its own owner with it.
    expect(plan.ledger.machine).toEqual(here);
    const began = performance.now();
    const result = await commitErase(plan);
    // Broken at once, not waited on for the five seconds an owner of unknown machine gets, then refused.
    expect(performance.now() - began).toBeLessThan(LOCK_TIMING.waitMs);
    expect((await verifyErase(plan, result)).verdict).toBe("erased-and-verified");
    expect(await Bun.file(ledgerDir(env, SUBJECT)).exists()).toBe(false);

    // And the lock an erase killed in the middle leaves behind now names this machine, so the next turn
    // clears it at once — where one naming none, as an erase used to leave, refuses turns until it is ten
    // minutes old.
    const turn = { home, env: env.env, now: env.now, machine: here };
    await mkdir(lock, { recursive: true, mode: 0o700 });
    await writeFile(join(lock, `owner.${crypto.randomUUID()}.json`), JSON.stringify({ ...owner, host: null }));
    const unnamed = await canAppend(turn, SUBJECT, { ...LOCK_TIMING, waitMs: 200 });
    expect(unnamed.ok ? undefined : unnamed.kind).toBe("locked");
    await rm(lock, { recursive: true });
    await mkdir(lock, { recursive: true, mode: 0o700 });
    await writeFile(join(lock, `owner.${crypto.randomUUID()}.json`), JSON.stringify(owner));
    expect((await canAppend(turn, SUBJECT, { ...LOCK_TIMING, waitMs: 200 })).ok).toBe(true);

    // Without a machine — a caller that did not say — the plan has none, and every lock is judged by age.
    expect((await planErase(envFor(home), request(null, []))).ledger.machine).toBeUndefined();
  }, 30_000);

  test("the empty directory that is only the subject's name goes too", async () => {
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);

    const plan = await planErase(envFor(home), request(mine.agent, [mine.instruction]));
    await commitErase(plan);

    // `$XDG_DATA_HOME/mind/<subject>/` would otherwise be left behind: empty,
    // and still the identifier AC3 says must be findable nowhere.
    expect(await Bun.file(join(home, "data", "mind", SUBJECT)).exists()).toBe(false);
  }, 30_000);

  test("I-3 — the other subject's bytes are identical afterwards, everywhere", async () => {
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);
    const theirs = await fixture(home, OTHER);

    const before = {
      soul: await Bun.file(join(theirs.agent, "soul", "role.md")).text(),
      capture: await Bun.file(
        join(home, "data", "mind", OTHER, "personal", "observer", "raw.jsonl"),
      ).text(),
      instruction: await Bun.file(theirs.instruction).text(),
      backups: await readdir(join(home, "state", "mind", "backups", OTHER)),
      ledger: await readdir(ledgerDir(envFor(home), OTHER)),
    };

    const plan = await planErase(
      envFor(home),
      // Both instruction files are offered, which is the interesting case: the
      // other subject's block must be recognised and left.
      request(mine.agent, [mine.instruction, theirs.instruction]),
    );
    const result = await commitErase(plan);

    expect(result.blocks.filter((block) => block.removed).map((block) => block.path)).toEqual([
      mine.instruction,
    ]);
    expect(await Bun.file(join(theirs.agent, "soul", "role.md")).text()).toBe(before.soul);
    expect(
      await Bun.file(join(home, "data", "mind", OTHER, "personal", "observer", "raw.jsonl")).text(),
    ).toBe(before.capture);
    expect(await Bun.file(theirs.instruction).text()).toBe(before.instruction);
    expect(await readdir(join(home, "state", "mind", "backups", OTHER))).toEqual(before.backups);
    expect(await readdir(ledgerDir(envFor(home), OTHER))).toEqual(before.ledger);
  }, 30_000);

  test("D-029 — a proposal is reached by the existing places, and a file outside personal/ is not", async () => {
    // The measurement D-029 asked for by name, and refused to let anybody
    // assume. S5.2's store is under `personal/proposals/` rather than being a
    // sixth `PlaceId`, so nothing in the type system says `erase` registered
    // it. What says so is this: a canary seeded in a proposal is gone, the
    // plan still has exactly five trees (no sixth place appeared), and the
    // control — the same bytes one directory higher, outside `personal/` —
    // survives, which is what makes "not found" evidence rather than a search
    // that looks nowhere.
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);
    const personal = join(home, "data", "mind", SUBJECT, "personal");

    await Bun.write(
      join(personal, "proposals", "11111111-1111-4111-8111-111111111111.json"),
      JSON.stringify({ schema: "mind/proposal@1", what: `delete ${CANARY}` }),
    );
    // One under another schema id: erase removes what is in the store, whatever it says.
    const earlierProposal = join(personal, "proposals", "22222222-2222-4222-8222-222222222222.json");
    await Bun.write(earlierProposal, JSON.stringify({ schema: "other/proposal@1", what: `delete ${CANARY}` }));
    const control = join(home, "data", "mind", SUBJECT, "proposals", "outside.json");
    await Bun.write(control, JSON.stringify({ what: `delete ${CANARY}` }));

    const plan = await planErase(envFor(home), request(mine.agent, [mine.instruction]));
    // No new tree: the store is a subtree of a tree that was already planned.
    expect(plan.trees.length).toBe(15);
    const observed = plan.trees.find((tree) => tree.plan.dir === personal);
    expect(observed).toBeDefined();
    expect(observed!.plan.before.paths.some((path) => path.includes("proposals"))).toBe(true);
    expect(observed!.plan.before.paths).toContain(earlierProposal);
    // The label on the certificate names what goes, rather than only the place
    // id it is counted under.
    expect(observed!.label).toContain("proposal store");

    await commitErase(plan);

    expect(await grepTree(personal, CANARY)).toEqual([]);
    expect(await Bun.file(join(personal, "proposals")).exists()).toBe(false);
    // The control, which is the half that makes the line above mean something.
    expect(await Bun.file(control).exists()).toBe(true);
    expect(await Bun.file(control).text()).toContain(CANARY);
  }, 30_000);

  test("a dry run changes no byte — it is the absence of the second call", async () => {
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);

    const snapshot = async (): Promise<Map<string, string>> => {
      const seen = new Map<string, string>();
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) await walk(path);
          else if (entry.isFile()) seen.set(path, await Bun.file(path).text());
        }
      };
      await walk(home);
      return seen;
    };

    const before = await snapshot();
    const plan = await planErase(envFor(home), request(mine.agent, [mine.instruction]));
    expect(plan.trees.length).toBe(15);
    const after = await snapshot();

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, text] of before) expect(after.get(path), path).toBe(text);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The controls that make the verdict mean something
// ---------------------------------------------------------------------------

describe("the controls", () => {
  test("a planted identifier in the state root makes it erased-with-remainder", async () => {
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);
    // Somewhere no deleter looks: a stray file directly under the state root.
    await Bun.write(join(home, "state", "mind", "stray.log"), `wore ${SUBJECT} once\n`);

    const plan = await planErase(envFor(home), request(mine.agent, [mine.instruction]));
    const verification = await verifyErase(plan, await commitErase(plan));

    expect(verification.verdict).toBe("erased-with-remainder");
    expect(verification.search.deletableHits).toBe(1);
    const hit = verification.search.scopes
      .flatMap((scope) => scope.hits)
      .find((found) => found.path.endsWith("stray.log"));
    expect(hit).toEqual({
      path: join(home, "state", "mind", "stray.log"),
      line: 1,
      needle: "subject id",
      inName: false,
    });
  }, 30_000);

  test("a hit in a git-tracked file is a remainder, and the file is not deleted", async () => {
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);
    const note = join(mine.agent, "memory", "note.md");
    await Bun.write(note, `worked with ${SUBJECT} on the migration\n`);

    const plan = await planErase(envFor(home), request(mine.agent, [mine.instruction]));
    const verification = await verifyErase(plan, await commitErase(plan));

    expect(verification.verdict).toBe("erased-with-remainder");
    expect(verification.search.gitHits).toBe(1);
    // Deleting somebody's committed note on their behalf is not Mind's call.
    expect(await Bun.file(note).text()).toBe(`worked with ${SUBJECT} on the migration\n`);
  }, 30_000);

  test("data at a reserved address refuses the run — nothing is deleted", async () => {
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);
    await Bun.write(join(mine.agent, ".mind", "adapters", "lora.bin"), "weights\n");

    const plan = await planErase(envFor(home), request(mine.agent, [mine.instruction]));

    expect(plan.refusals.length).toBe(1);
    expect(plan.refusals[0]).toContain("S6.3");
    expect(plan.refusals[0]).toContain("no deleter");
    // The caller is what stops; the plan itself still wrote nothing.
    expect(await Bun.file(join(mine.agent, "soul", "role.md")).exists()).toBe(true);
  }, 30_000);

  test("a hand-edited block refuses the run, and the backups stay", async () => {
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);
    const written = await Bun.file(mine.instruction).text();
    await Bun.write(mine.instruction, written.replace("# identity", "# identity + my note"));

    const plan = await planErase(envFor(home), request(mine.agent, [mine.instruction]));

    expect(plan.refusals.length).toBe(1);
    expect(plan.refusals[0]).toContain("edited by hand");
    expect(
      await Bun.file(
        join(home, "state", "mind", "backups", SUBJECT, "20260921T090000000Z", "1-CLAUDE.md"),
      ).exists(),
    ).toBe(true);
  }, 30_000);

  test("the control: a file that cannot be unlinked keeps the count above zero", async () => {
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);
    const locked = join(mine.agent, ".mind", "locked");
    await Bun.write(join(locked, "stuck.bin"), `${CANARY}\n`);

    const plan = await planErase(envFor(home), request(mine.agent, [mine.instruction]));
    const { chmod } = await import("node:fs/promises");
    await chmod(locked, 0o500);
    try {
      const verification = await verifyErase(plan, await commitErase(plan));

      // A command that subtracted its own successes from its own plan would
      // print zero here, over a file that is still on disk.
      expect(verification.remainingFiles).toBeGreaterThan(0);
      expect(verification.failures).toBeGreaterThan(0);
      expect(verification.verdict).toBe("erased-with-remainder");
    } finally {
      await chmod(locked, 0o700);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// --personal (AC5)
// ---------------------------------------------------------------------------

describe("--personal", () => {
  test("person.md goes, role.md is byte-identical, and the ledger goes whole", async () => {
    const home = await sandbox();
    const env = envFor(home);
    const mine = await fixture(home, SUBJECT);
    const roleBefore = await Bun.file(join(mine.agent, "soul", "role.md")).text();
    const roleMode = (await stat(join(mine.agent, "soul", "role.md"))).mode;

    const plan = await planErase(
      env,
      request(mine.agent, [mine.instruction], {
        scope: "personal",
        personalValues: ["a phrase only person.md held"],
      }),
    );
    expect(plan.files).toEqual([join(mine.agent, "soul", "person.md")]);
    // Eleven trees, not thirteen: `soul/` stays, because `role.md` is in it, and so does the agent's signing
    // key — the agent's identity, not the person's data (S15.8 review; D-138).
    expect(plan.trees.length).toBe(13);
    expect(plan.trees.some((tree) => tree.label.includes("signing key"))).toBe(false);
    // No key was made in this fixture, so none is said to be kept (S15.8 re-review; the cases with one are below).
    expect(plan.notes.some((note) => note.includes("keeps the agent's signing key"))).toBe(false);

    const result = await commitErase(plan);
    expect(result.files).toEqual([{ path: join(mine.agent, "soul", "person.md"), removed: true }]);
    expect(await Bun.file(join(mine.agent, "soul", "person.md")).exists()).toBe(false);
    expect(await Bun.file(join(mine.agent, "soul", "role.md")).text()).toBe(roleBefore);
    expect((await stat(join(mine.agent, "soul", "role.md"))).mode).toBe(roleMode);
    expect(await Bun.file(join(mine.agent, "memory", "README.md")).exists()).toBe(true);
    expect(await Bun.file(ledgerDir(env, SUBJECT)).exists()).toBe(false);
  }, 30_000);

  /**
   * S15.8 re-review: under `--personal`, `kept` is only the key file and a directory holding nothing but it —
   * checked on disk. The name hit on `$DATA/mind/<subject>` is often the only sign of a place nobody knows
   * about, so it may not be filed as the key's unless the key is really all that is there.
   */
  describe("what --personal keeps is the key file, and only while it is really there and alone", () => {
    const KEPT_NOTE = "keeps the agent's signing key";

    // The fixture makes data/mind and data/mind/<subject> implicitly, with the process's umask. The engine refuses a key
    // whose parents others can write (src/identity/key.ts), as it should, so these tests make their parents the way a
    // normal user's shell does: umask 022, restored afterwards. The engine's check is not touched, and the control
    // test below makes a parent group-writable on purpose to show it still refuses.
    let callersUmask = 0;
    beforeEach(() => {
      callersUmask = process.umask(0o022);
    });
    afterEach(() => {
      process.umask(callersUmask);
    });

    async function personalRun(home: string, arrange: (env: EraseEnv, subjectData: string) => Promise<void>) {
      const env = envFor(home);
      const mine = await fixture(home, SUBJECT);
      await arrange(env, join(home, "data", "mind", SUBJECT));
      const plan = await planErase(env, request(mine.agent, [mine.instruction], { scope: "personal" }));
      const verification = await verifyErase(plan, await commitErase(plan));
      const hits = (kind: string) =>
        verification.search.scopes.filter((scope) => scope.kind === kind).flatMap((scope) => scope.hits.map((hit) => hit.path));
      return { plan, verification, hits };
    }

    const leftover = async (_env: EraseEnv, subjectData: string) => {
      // No subject id in its name or its bytes: the directory it sits in is the only thing that says whose it is.
      await Bun.write(join(subjectData, "forgotten", "blob.bin"), "nothing to find in here\n");
    };
    const withKey = async (env: EraseEnv) => {
      expect((await ensureAgentKey(identityDirFor(env, SUBJECT))).state).toBe("present");
    };

    test("a leftover and no key: the subject's directory is a deletable remainder, and nothing is said about a key", async () => {
      const { plan, verification, hits } = await personalRun(await sandbox(), leftover);
      expect(verification.search.deletableHits).toBe(1);
      expect(verification.search.keptHits).toBe(0);
      expect(hits("deletable")).toEqual([join(plan.dataRoot, SUBJECT)]);
      expect(plan.notes.some((note) => note.includes(KEPT_NOTE))).toBe(false);
      expect(verification.verdict).toBe("erased-with-remainder");
    });

    test("a leftover beside the key: the leftover is deletable, the key stays and is said to", async () => {
      const home = await sandbox();
      const { plan, verification, hits } = await personalRun(home, async (env, subjectData) => {
        await withKey(env);
        await leftover(env, subjectData);
      });
      expect(verification.search.deletableHits).toBe(1);
      expect(verification.search.keptHits).toBe(0);
      expect(hits("deletable")).toEqual([join(plan.dataRoot, SUBJECT)]);
      expect(await Bun.file(keyPath(identityDirFor(envFor(home), SUBJECT))).exists()).toBe(true);
      expect(plan.notes.some((note) => note.includes(KEPT_NOTE))).toBe(true);
    });

    test("the key alone: kept 1, deletable 0", async () => {
      const home = await sandbox();
      const { plan, verification, hits } = await personalRun(home, withKey);
      expect(verification.search.keptHits).toBe(1);
      expect(verification.search.deletableHits).toBe(0);
      expect(hits("kept")).toEqual([join(plan.dataRoot, SUBJECT)]);
      expect(await Bun.file(keyPath(identityDirFor(envFor(home), SUBJECT))).exists()).toBe(true);
    });

    test("control: a group-writable parent still refuses the key, whatever the umask of the run", async () => {
      const home = await sandbox();
      const env = envFor(home);
      const dir = identityDirFor(env, SUBJECT);
      await mkdir(join(dir, ".."), { recursive: true });
      await chmod(join(dir, ".."), 0o775);
      const refused = await ensureAgentKey(dir);
      expect(refused.state).not.toBe("present");
      expect(JSON.stringify(refused)).toContain("can be written by others");
    });

    test("a file at the key's path that is not a key is not kept, and nothing is said about a key", async () => {
      const home = await sandbox();
      const { plan, verification } = await personalRun(home, async (env) => {
        const dir = identityDirFor(env, SUBJECT);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await Bun.write(keyPath(dir), `${SUBJECT}'s diary\n`);
        await chmod(keyPath(dir), 0o600);
      });
      expect(verification.search.keptHits).toBe(0);
      expect(verification.search.deletableHits).toBeGreaterThanOrEqual(1);
      expect(plan.notes.some((note) => note.includes(KEPT_NOTE))).toBe(false);
      expect(verification.verdict).toBe("erased-with-remainder");
    });

    test("a stray file in identity/ is not the key: it, and the directory holding it, are deletable", async () => {
      const home = await sandbox();
      const { plan, verification, hits } = await personalRun(home, async (env) => {
        await withKey(env);
        await Bun.write(join(identityDirFor(env, SUBJECT), "stray.txt"), `left by hand for ${SUBJECT}\n`);
      });
      expect(verification.search.keptHits).toBe(0);
      expect(hits("deletable").sort()).toEqual([join(plan.dataRoot, SUBJECT), join(identityDirFor(envFor(home), SUBJECT), "stray.txt")].sort());
    });
  });

  test("the ledger note says it goes whole because it cannot be split", async () => {
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);

    const plan = await planErase(
      envFor(home),
      request(mine.agent, [mine.instruction], { scope: "personal" }),
    );

    const note = plan.notes.find((line) => line.includes("whole ledger"))!;
    expect(note).toContain("cannot split it");
    expect(note).toContain("not because all of it is personal");
    expect(note).toContain("D-022");
  }, 30_000);

  test("a value person.md held, found in a file that was kept, is a remainder", async () => {
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);
    // Separate files are not separate contents: the same phrase, in the file
    // `--personal` keeps.
    await Bun.write(join(mine.agent, "memory", "note.md"), "she always says ที่รัก first\n");

    const plan = await planErase(
      envFor(home),
      request(mine.agent, [mine.instruction], {
        scope: "personal",
        personalValues: ["ที่รัก"],
      }),
    );
    const verification = await verifyErase(plan, await commitErase(plan));

    expect(verification.personal).not.toBeNull();
    expect(verification.personal!.gitHits).toBe(1);
    expect(verification.verdict).toBe("erased-with-remainder");
    // Reported as file:line, never auto-deleted.
    expect(verification.personal!.scopes[0]!.hits[0]!.path).toBe(
      join(mine.agent, "memory", "note.md"),
    );
    expect(await Bun.file(join(mine.agent, "memory", "note.md")).exists()).toBe(true);
  }, 30_000);

  test("no personal values means no content check ran, rather than a check that passed", async () => {
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);

    const plan = await planErase(
      envFor(home),
      request(mine.agent, [mine.instruction], { scope: "personal" }),
    );
    const verification = await verifyErase(plan, await commitErase(plan));
    expect(verification.personal).toBeNull();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Nothing to erase — I-4's other half
// ---------------------------------------------------------------------------

/** Plan, commit and verify, with the fixture's own defaults. */
async function eraseOnce(
  home: string,
  agent: string | null,
  instruction: readonly string[],
  over: Partial<Parameters<typeof planErase>[1]> = {},
) {
  const plan = await planErase(envFor(home), request(agent, [...instruction], over));
  const result = await commitErase(plan);
  return { plan, result, verification: await verifyErase(plan, result) };
}

describe("a subject that is not here", () => {
  test("an empty home gets `nothing-found`, and no certificate of erasure", async () => {
    const home = await sandbox();
    const { verification } = await eraseOnce(home, null, []);

    expect(verification.verdict).toBe("nothing-found");
    expect(verification.found.total).toBe(0);
    expect(verification.removed.total).toBe(0);
    expect(verification.filesRead).toBe(0);
  }, 30_000);

  test("the dangerous one: a mistyped id in a home holding another subject", async () => {
    // The case a rule keyed on `filesRead === 0` waves straight through, and
    // the reason the verdict is decided by what was found and removed instead.
    // Files are read here — plenty of them — and none of them is this id's.
    const home = await sandbox();
    const theirs = await fixture(home, OTHER);

    const before = {
      soul: await Bun.file(join(theirs.agent, "soul", "role.md")).text(),
      capture: await Bun.file(
        join(home, "data", "mind", OTHER, "personal", "observer", "raw.jsonl"),
      ).text(),
      instruction: await Bun.file(theirs.instruction).text(),
      backups: await readdir(join(home, "state", "mind", "backups", OTHER)),
      ledger: await readdir(ledgerDir(envFor(home), OTHER)),
    };

    // SUBJECT is not OTHER: the id being erased has never existed on this
    // machine, and the real data sits under a different spelling.
    const { verification } = await eraseOnce(home, null, [theirs.instruction]);

    expect(verification.verdict).toBe("nothing-found");
    expect(verification.filesRead).toBeGreaterThan(0);
    expect(verification.found.total).toBe(0);
    expect(verification.removed.total).toBe(0);

    // I-3, by bytes rather than by reading the code: the other subject is
    // untouched in all five kinds of place.
    expect(await Bun.file(join(theirs.agent, "soul", "role.md")).text()).toBe(before.soul);
    expect(
      await Bun.file(join(home, "data", "mind", OTHER, "personal", "observer", "raw.jsonl")).text(),
    ).toBe(before.capture);
    expect(await Bun.file(theirs.instruction).text()).toBe(before.instruction);
    expect(await readdir(join(home, "state", "mind", "backups", OTHER))).toEqual(before.backups);
    expect(await readdir(ledgerDir(envFor(home), OTHER))).toEqual(before.ledger);
  }, 30_000);

  test("erasing twice: the second run is `nothing-found`, and cannot say why", async () => {
    // The behaviour behind the sentence on the certificate. Mind keeps no
    // record that a subject was erased — such a record is a trace of the
    // subject, and the next run's AC3 search would find it — so a second run
    // over a subject it removed an instant ago is byte-for-byte the same
    // situation as a subject that was never here, and says so rather than
    // inventing a distinction it cannot make.
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);

    const first = await eraseOnce(home, mine.agent, [mine.instruction]);
    expect(first.verification.verdict).toBe("erased-and-verified");
    expect(first.verification.found.total).toBeGreaterThan(0);
    expect(first.verification.removed.total).toBeGreaterThan(0);

    const second = await eraseOnce(home, mine.agent, [mine.instruction]);
    expect(second.verification.verdict).toBe("nothing-found");
    expect(second.verification.removed.total).toBe(0);
  }, 30_000);

  test("the sole subject erased with --no-agent still earns the verdict, reading nothing after", async () => {
    // The other direction of the same measurement. After this run both roots
    // are empty, so the search reads zero files — exactly the number the empty
    // home produces — and the verdict here is deserved, because something was
    // found before and something went.
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);
    // Everything of this subject's that lives outside a repository, and nothing
    // else on the machine.
    await rm(mine.agent, { recursive: true, force: true });
    await rm(mine.instruction, { force: true });

    const { verification } = await eraseOnce(home, null, []);

    expect(verification.verdict).toBe("erased-and-verified");
    expect(verification.filesRead).toBe(0);
    expect(verification.found.total).toBeGreaterThan(0);
    expect(verification.removed.total).toBeGreaterThan(0);
  }, 30_000);

  test("an empty directory named for the subject is a trace, and removing it counts", async () => {
    // Measured before it was decided: `census` cannot see such a directory at
    // all — empty and absent are both `0 files` — and the only evidence one was
    // there is that `commitPurge`'s `rmdir` succeeded. So `found` is zero here
    // and `removed` is not, which is what keeps this out of `nothing-found`.
    const home = await sandbox();
    await mkdir(join(home, "data", "mind", SUBJECT, "personal"), { recursive: true });
    await mkdir(join(home, "state", "mind", "backups", SUBJECT), { recursive: true });

    const { verification } = await eraseOnce(home, null, []);

    expect(verification.found.total).toBe(0);
    expect(verification.removed.files).toBe(0);
    expect(verification.removed.directories).toBeGreaterThan(0);
    expect(verification.verdict).toBe("erased-and-verified");
    // And the identifier really is gone from the path it was in.
    expect(await Bun.file(join(home, "data", "mind", SUBJECT)).exists()).toBe(false);
  }, 30_000);

  test("a scope that could not be read is not a scope that was found clean", async () => {
    // The same hole family as the one above, in the arm nobody surveyed:
    // `searchTree` answers "zero hits" for a root it could not open, exactly as
    // it does for a root that is not there. Only `unreadable` separates them,
    // and nothing used to look at it.
    const home = await sandbox();
    const { chmod } = await import("node:fs/promises");
    const state = join(home, "state", "mind");
    await mkdir(state, { recursive: true });
    await chmod(state, 0o000);
    try {
      const { verification } = await eraseOnce(home, null, []);

      expect(verification.unreadableScopes).toEqual(["state root"]);
      expect(verification.verdict).not.toBe("erased-and-verified");
      expect(verification.verdict).not.toBe("nothing-found");
    } finally {
      await chmod(state, 0o700);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// --no-agent
// ---------------------------------------------------------------------------

describe("--no-agent", () => {
  test("the two out-of-repository places still go, and the rest is recorded as not examined", async () => {
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);

    const plan = await planErase(envFor(home), request(null, [mine.instruction]));

    // Backups, confirmations, run records, browser task records, trigger fire times, A2A peers, the
    // chat allowlist, the push handles, the basis records, the rag marker, the
    // personal directory and the signing key need no repository; soul/ and .mind/ are not visited at all.
    expect(plan.trees.length).toBe(13);
    expect(plan.git).toBeNull();
    expect(plan.notes.join("\n")).toContain("--no-agent");
    // The reserved addresses cannot be probed either, and that is said.
    expect(plan.reserved.every((probe) => probe.path === null)).toBe(true);

    await commitErase(plan);
    expect(await Bun.file(join(mine.agent, "soul", "role.md")).exists()).toBe(true);
    expect(await Bun.file(join(home, "state", "mind", "backups", SUBJECT)).exists()).toBe(false);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Browser tasks (D-151; review of PR #19)
// ---------------------------------------------------------------------------

describe("a subject with a browser task", () => {
  test("its container is docker-killed first, then its record and wiring go, and verification is clean", async () => {
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);
    const env = envFor(home);
    const record = {
      schema: BROWSER_SCHEMA,
      task: "t-erase",
      subject: SUBJECT,
      container: containerName(env, "t-erase"),
      image: "mind-browser:test",
      port: 30_740,
      token: "77".repeat(32),
      operate: 1 as const,
      allowed: ["https://example.com:443"],
      outDir: join(home, "data", "mind", SUBJECT, "personal", "browser", "t-erase"),
      owner: null,
      startedAt: new Date().toISOString(),
      ttlSeconds: 600,
    };
    expect((await createRecord(env, record)).ok).toBe(true);
    await mkdir(wiringDir(env, SUBJECT, "t-erase"), { recursive: true });
    await Bun.write(join(wiringDir(env, SUBJECT, "t-erase"), "claude-mcp.json"), "{}");

    const plan = await planErase(env, request(mine.agent, [mine.instruction]));
    expect(plan.browsers).toEqual([{ task: "t-erase", container: record.container }]);
    expect(plan.notes.join("\n")).toContain("1 browser task(s)");

    const killed: string[] = [];
    const docker = {
      run: async (args: readonly string[]) => {
        killed.push(args.join(" "));
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const result = await commitErase(plan, docker);
    expect(killed).toEqual([`kill ${record.container}`]);
    expect(result.browsers).toEqual([{ task: "t-erase", container: record.container, ok: true, detail: "killed" }]);
    expect(await Bun.file(recordPath(env, SUBJECT, "t-erase")).exists()).toBe(false);
    const verification = await verifyErase(plan, result);
    expect(verification.verdict).toBe("erased-and-verified");
  }, 30_000);

  test("a container docker will not kill is a failure, and the verdict is not clean", async () => {
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);
    const env = envFor(home);
    await createRecord(env, {
      schema: BROWSER_SCHEMA,
      task: "t-stuck",
      subject: SUBJECT,
      container: containerName(env, "t-stuck"),
      image: "mind-browser:test",
      port: 30_741,
      token: "78".repeat(32),
      operate: 1 as const,
      allowed: ["https://example.com:443"],
      outDir: join(home, "x"),
      owner: null,
      startedAt: new Date().toISOString(),
      ttlSeconds: 600,
    });
    const plan = await planErase(env, request(mine.agent, [mine.instruction]));
    const result = await commitErase(plan, { run: async () => ({ code: 1, stdout: "", stderr: "permission denied" }) });
    expect(result.browsers[0]).toMatchObject({ ok: false, detail: "permission denied" });
    const verification = await verifyErase(plan, result);
    expect(verification.failures).toBeGreaterThan(0);
    expect(verification.verdict).not.toBe("erased-and-verified");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The vector collection (S4.1, D-038)
// ---------------------------------------------------------------------------

/**
 * A stand-in Qdrant on a real loopback socket. `erase` takes no fetch seam —
 * the commit takes no environment — so the stand-in has to be a server.
 */
function fakeQdrant(collections: Map<string, number>) {
  const asked: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      asked.push(`${req.method} ${url.pathname}`);
      const name = url.pathname.replace(/^\/collections\//, "");
      if (req.method === "GET") {
        const points = collections.get(name);
        return points === undefined
          ? new Response("{}", { status: 404 })
          : Response.json({ result: { points_count: points } });
      }
      if (req.method === "DELETE") {
        collections.delete(name);
        return Response.json({ result: true });
      }
      return new Response("", { status: 405 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, asked, stop: () => server.stop(true) };
}

async function withMarker(home: string, qdrantUrl: string): Promise<void> {
  const env = envFor(home);
  await writeRagMarker(ragDirFor(home, env.env, SUBJECT), SUBJECT, qdrantUrl, new Date());
}

describe("the vector collection", () => {
  test("found, dropped whole, asked again, and the verdict rests on the answer", async () => {
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);
    const collections = new Map([[COLLECTION, 12], ["docs", 400]]);
    const store = fakeQdrant(collections);
    try {
      await withMarker(home, store.url);
      const plan = await planErase(envFor(home), request(mine.agent, [mine.instruction]));
      expect(plan.refusals).toEqual([]);
      expect(plan.vector.url).toBe(store.url);
      expect(plan.vector.state).toEqual({ kind: "present", points: 12 });

      const result = await commitErase(plan);
      expect(result.vector).toEqual({ dropped: true });
      const verification = await verifyErase(plan, result);

      expect(verification.vectorAfter).toEqual({ kind: "absent" });
      expect(verification.found.collections).toBe(1);
      expect(verification.removed.collections).toBe(1);
      expect(verification.verdict).toBe("erased-and-verified");
      // D-007: the collection Mind never wrote is untouched.
      expect(collections.get("docs")).toBe(400);
      expect(store.asked.filter((line) => line.startsWith("DELETE"))).toEqual([`DELETE /collections/${COLLECTION}`]);
    } finally {
      store.stop();
    }
  }, 30_000);

  test("the marker is where it looks, even when the environment points elsewhere", async () => {
    const home = await sandbox();
    const store = fakeQdrant(new Map([[COLLECTION, 1]]));
    try {
      await withMarker(home, store.url);
      // envFor points MIND_QDRANT_URL at a port nothing listens on.
      const plan = await planErase(envFor(home), request(null, []));
      expect(plan.vector.url).toBe(store.url);
      expect(plan.vector.state?.kind).toBe("present");
    } finally {
      store.stop();
    }
  }, 30_000);

  test("Mind wrote vectors, and the store is down: refused, nothing certified", async () => {
    const home = await sandbox();
    await withMarker(home, "http://127.0.0.1:9");
    const plan = await planErase(envFor(home), request(null, []));
    expect(plan.refusals.join(" ")).toContain("cannot reach it now");
    expect(plan.refusals.join(" ")).toContain(COLLECTION);
  }, 30_000);

  test("the refusal says what to do: wait for the store, or type the collection's name to go on without it (B1)", async () => {
    const home = await sandbox();
    await withMarker(home, "http://127.0.0.1:9");
    const plan = await planErase(envFor(home), request(null, []));
    const said = plan.refusals.join(" ");
    expect(said).toContain("--vectors-not-reached " + COLLECTION);
    expect(said).toContain("not reached: vector collection " + COLLECTION);
  }, 30_000);

  test("a wrong name typed for the acknowledgement does not open the refusal", async () => {
    const home = await sandbox();
    await withMarker(home, "http://127.0.0.1:9");
    const plan = await planErase(envFor(home), request(null, [], { acknowledgeUnreached: "mind__other" }));
    expect(plan.refusals.join(" ")).toContain("does not match");
    expect(plan.refusals.join(" ")).toContain(COLLECTION);
    expect(plan.vector.unreached).toBe(false);
  }, 30_000);

  test("the collection's name typed: the run goes on, lists the collection as not reached, and is never erased-and-verified", async () => {
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);
    await withMarker(home, "http://127.0.0.1:9");
    const plan = await planErase(envFor(home), request(mine.agent, [mine.instruction], { acknowledgeUnreached: COLLECTION }));
    expect(plan.refusals).toEqual([]);
    expect(plan.vector.unreached).toBe(true);
    const dry = certificate({ plan, result: null, verification: null, observedAccount: "t", engine: "x", issuedAt: "2026-09-21T10:00:00.000Z" });
    expect(dry.verification.notReached).toEqual([`vector collection ${COLLECTION}`]);

    const result = await commitErase(plan);
    const verification = await verifyErase(plan, result);
    expect(verification.notReached).toEqual([`vector collection ${COLLECTION}`]);
    expect(verification.verdict).toBe("erased-with-remainder");
    const issued = certificate({ plan, result, verification, observedAccount: "t", engine: "x", issuedAt: "2026-09-21T10:00:00.000Z" });
    expect(issued.statement.join(" ")).toContain(`not reached: vector collection ${COLLECTION}`);
    expect(formatCertificate(issued).join("\n")).toContain(`not reached   vector collection ${COLLECTION}`);
    // The marker went with the rest, so the certificate is the only record that a collection may still be there.
    expect(await Bun.file(join(ragDirFor(home, envFor(home).env, SUBJECT), RAG_MARKER_FILE)).exists()).toBe(false);
  }, 30_000);

  test("the acknowledgement changes nothing when the store answers or there is no marker", async () => {
    const home = await sandbox();
    const plan = await planErase(envFor(home), request(null, [], { acknowledgeUnreached: COLLECTION }));
    expect(plan.refusals).toEqual([]);
    expect(plan.vector.unreached).toBe(false);
  }, 30_000);

  test("no marker and no store: a note, not a refusal — the bare container's case", async () => {
    const home = await sandbox();
    const plan = await planErase(envFor(home), request(null, []));
    expect(plan.refusals).toEqual([]);
    expect(plan.notes.join(" ")).toContain("did not answer");
    expect(plan.vector.state?.kind).toBe("unreachable");
  }, 30_000);

  test("an unreadable marker refuses: it says something was written, and not where", async () => {
    const home = await sandbox();
    const env = envFor(home);
    const dir = ragDirFor(home, env.env, SUBJECT);
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, RAG_MARKER_FILE), "{ not json");
    const unset = { ...env, env: { ...env.env, MIND_QDRANT_URL: "http://gpu-box:10300" } };
    const plan = await planErase(unset, request(null, []));
    expect(plan.refusals.join(" ")).toContain("cannot be read to say where");
  }, 30_000);

  test("a collection that is still there after the drop is a remainder, not a pass", async () => {
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);
    const collections = new Map([[COLLECTION, 3]]);
    const store = fakeQdrant(collections);
    try {
      await withMarker(home, store.url);
      const plan = await planErase(envFor(home), request(mine.agent, [mine.instruction]));
      const result = await commitErase(plan);
      // Somebody writes it back between the drop and the re-read.
      collections.set(COLLECTION, 3);
      const verification = await verifyErase(plan, result);
      expect(verification.vectorAfter?.kind).toBe("present");
      expect(verification.verdict).toBe("erased-with-remainder");
    } finally {
      store.stop();
    }
  }, 30_000);
});

describe("D-042's confirmations are this subject's data", () => {
  test("a level-3 confirmation goes with the subject, and another subject's stays", async () => {
    const home = await sandbox();
    const env = envFor(home);
    const mine = confirmationsPath(env, join(home, "agent", "soul"), SUBJECT);
    const theirs = confirmationsPath(env, join(home, "agent", "soul"), subjectId("somebody-else"));
    await setConfirmation(mine, "write", { by: "the owner", at: "t" });
    await setConfirmation(theirs, "write", { by: "someone", at: "t" });

    const plan = await planErase(env, request(null, []));
    expect(plan.trees.some((tree) => tree.label === "the level-3 confirmations")).toBe(true);
    await commitErase(plan);

    expect(await Bun.file(mine).exists()).toBe(false);
    expect(await Bun.file(theirs).exists()).toBe(true);
  }, 30_000);
});

describe("the owner's own notes in memory/imported/ (B5 of the stranger run, D-187)", () => {
  const NOTE = ["memory", "imported", "notes", "vat.md"] as const;

  test("they are listed in the plan, and the dry run's certificate lists them under yoursToDelete", async () => {
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);
    await Bun.write(join(mine.agent, ...NOTE), "# Tax\n\nVAT is due on the 15th.\n");
    const plan = await planErase(envFor(home), request(mine.agent, [mine.instruction]));
    expect(plan.yours.map((path) => path.slice(mine.agent.length + 1))).toEqual([NOTE.join("/")]);
    const dry = certificate({ plan, result: null, verification: null, observedAccount: "t", engine: "x", issuedAt: "2026-09-21T10:00:00.000Z" });
    expect(dry.verification.yoursToDelete).toEqual([join(mine.agent, ...NOTE)]);
  }, 30_000);

  test("they stay, they are named, and the verdict is not erased-and-verified while they are there", async () => {
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);
    await Bun.write(join(mine.agent, ...NOTE), "# Tax\n\nVAT is due on the 15th.\n");
    const plan = await planErase(envFor(home), request(mine.agent, [mine.instruction]));
    const result = await commitErase(plan);
    const verification = await verifyErase(plan, result);
    expect(await Bun.file(join(mine.agent, ...NOTE)).exists()).toBe(true);
    expect(verification.yoursToDelete).toEqual([join(mine.agent, ...NOTE)]);
    expect(verification.verdict).toBe("erased-with-remainder");
    const issued = certificate({ plan, result, verification, observedAccount: "t", engine: "x", issuedAt: "2026-09-21T10:00:00.000Z" });
    const said = issued.statement.join(" ");
    expect(said).toContain("Yours to delete");
    expect(said).toContain("memory/imported/");
    expect(said).toContain("not removed by erase");
    expect(formatCertificate(issued).join("\n")).toContain(`yours to delete  ${join(mine.agent, ...NOTE)}`);
  }, 30_000);

  test("once the owner has deleted them, a run over what is left is clean", async () => {
    const home = await sandbox();
    const mine = await fixture(home, SUBJECT);
    await Bun.write(join(mine.agent, ...NOTE), "# Tax\n");
    const plan = await planErase(envFor(home), request(mine.agent, [mine.instruction]));
    const result = await commitErase(plan);
    await rm(join(mine.agent, "memory", "imported"), { recursive: true });
    const verification = await verifyErase(plan, result);
    expect(verification.yoursToDelete).toEqual([]);
    expect(verification.verdict).toBe("erased-and-verified");
  }, 30_000);

  test("no agent directory, nothing to list", async () => {
    const home = await sandbox();
    const plan = await planErase(envFor(home), request(null, []));
    expect(plan.yours).toEqual([]);
  }, 30_000);
});
