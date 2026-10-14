/**
 * The ledger on disk — append, query, and the deletion I-4 is measured by.
 *
 * Every test here runs against a temporary `XDG_STATE_HOME`. Nothing in this
 * file can reach the operator's own state directory, which matters more here
 * than anywhere else in the suite: this is the module whose job is to write
 * conversations down.
 *
 * The deletion tests do not check a return value and stop. They walk the whole
 * temporary state tree afterwards looking for the canary string, because
 * "forget removed the rows" and "the text is no longer on disk" are different
 * claims and I-4 is about the second one.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  append,
  canAppend,
  commitForget,
  ledgerDir,
  LOCK_TIMING,
  monthFileName,
  planForget,
  query,
  removeLedgerDir,
  UNDELETABLE,
  type LedgerEnv,
} from "../../src/ledger/index.ts";
import { LEDGER_VERSION, type LedgerEntry } from "../../src/ledger/entry.ts";
import { subjectId } from "../../src/types.ts";

const A = subjectId("alpha");
const B = subjectId("beta");

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeEnv(): Promise<LedgerEnv & { readonly root: string }> {
  const root = await mkdtemp(join(tmpdir(), "mind-ledger-"));
  scratch.push(root);
  return {
    root,
    home: root,
    env: { XDG_STATE_HOME: join(root, "state") },
    now: () => new Date("2026-09-21T10:00:00.000Z"),
  };
}

let counter = 0;
function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  counter++;
  return {
    v: LEDGER_VERSION,
    kind: "turn",
    id: `id-${counter}`,
    turn: "turn-1",
    at: "2026-09-21T10:00:00.000Z",
    subject: A,
    backend: "ollama",
    model: null,
    content: "full",
    prompt: "hello",
    prompt_bytes: 5,
    text: "hi",
    text_bytes: 2,
    confidence: "confirmed",
    exit: null,
    duration_ms: 1,
    cost: null,
    identity: "system",
    soul_sha: null,
    ...overrides,
  } as LedgerEntry;
}

/** Every file under a directory, recursively, as text. Used to hunt canaries. */
async function grepTree(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return hits;
  }
  for (const item of entries) {
    const path = join(dir, item.name);
    if (item.isDirectory()) hits.push(...(await grepTree(path, needle)));
    else if ((await Bun.file(path).text()).includes(needle)) hits.push(path);
  }
  return hits;
}

describe("where the ledger lives", () => {
  test("one directory per subject, beside the backups rather than over them", async () => {
    const env = await makeEnv();
    // The bug this layout exists to avoid: `backups` is a valid subject id, so
    // ADR 0002's original `<state root>/<subject>/` would have put a subject called
    // `backups` on top of the tree `soul apply` keeps originals in.
    expect(ledgerDir(env, subjectId("backups"))).toBe(
      join(env.root, "state", "mind", "ledger", "backups"),
    );
    expect(ledgerDir(env, A)).not.toBe(ledgerDir(env, B));
  });

  test("month files are named in UTC", () => {
    expect(monthFileName(new Date("2026-01-31T23:30:00Z"))).toBe("2026-01.jsonl");
    // 00:30 UTC on the 1st is still the new month no matter where you are.
    expect(monthFileName(new Date("2026-02-01T00:30:00Z"))).toBe("2026-02.jsonl");
  });
});

describe("append", () => {
  test("writes one line per call, and the directory and file are private", async () => {
    const env = await makeEnv();
    const path = await append(env, entry());
    await append(env, entry({ backend: "claude" }));

    const text = await Bun.file(path).text();
    expect(text.split("\n").filter((line) => line !== "").length).toBe(2);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(ledgerDir(env, A))).mode & 0o777).toBe(0o700);
  });

  test("lands in the month of the entry, not the month of the call", async () => {
    const env = await makeEnv();
    await append(env, entry({ at: "2026-08-31T23:00:00.000Z" }));
    await append(env, entry({ at: "2026-09-01T01:00:00.000Z" }));
    expect((await readdir(ledgerDir(env, A))).sort()).toEqual(["2026-08.jsonl", "2026-09.jsonl"]);
  });

  test("canAppend says yes on a fresh tree and leaves no probe behind", async () => {
    const env = await makeEnv();
    const writable = await canAppend(env, A);
    expect(writable.ok).toBe(true);
    expect(await readdir(ledgerDir(env, A))).toEqual([]);
  });

  test("canAppend says no, with a reason, when the directory cannot be made", async () => {
    const env = await makeEnv();
    // A file where the ledger directory needs to be.
    await mkdir(join(env.root, "state", "mind", "ledger"), { recursive: true });
    await writeFile(join(env.root, "state", "mind", "ledger", "alpha"), "in the way");

    const writable = await canAppend(env, A);
    expect(writable.ok).toBe(false);
    if (!writable.ok) {
      expect(writable.reason).toContain("alpha");
      // D-145: a path for a person to fix — and never by deleting the record of every turn.
      expect(writable.kind).toBe("unwritable");
      expect(writable.remedy).toContain("Fix what the line above names");
      expect(writable.remedy).toContain("None of these needs the ledger deleted");
      expect(writable.remedy).not.toMatch(/delete the ledger directory|fresh one/);
    }
  });

  test("a held lock is waited for, then refused by name — never assumed stale", async () => {
    const env = await makeEnv();
    await append(env, entry());
    // A live owner: this process. `test/ledger/lock.test.ts` has the rest of the lock (D-145).
    await mkdir(join(ledgerDir(env, A), ".lock"));
    await writeFile(
      join(ledgerDir(env, A), ".lock", `owner.${crypto.randomUUID()}.json`),
      JSON.stringify({ pid: process.pid, host: hostname(), started: new Date().toISOString() }),
    );

    await expect(append(env, entry(), { ...LOCK_TIMING, waitMs: 200 })).rejects.toThrow(/locked/);
    // And the line that could not be written is not silently dropped from the
    // caller's point of view: the throw is the report.
    expect((await query(env, A)).entries.length).toBe(1);
  });
});

describe("query (AC3)", () => {
  test("filters by subject and time window", async () => {
    const env = await makeEnv();
    await append(env, entry({ at: "2026-07-01T00:00:00.000Z", id: "old" }));
    await append(env, entry({ at: "2026-09-10T00:00:00.000Z", id: "mid" }));
    await append(env, entry({ at: "2026-09-20T00:00:00.000Z", id: "new" }));

    const all = await query(env, A);
    expect(all.entries.map((e) => e.id)).toEqual(["old", "mid", "new"]);

    const since = await query(env, A, { since: new Date("2026-09-01T00:00:00Z") });
    expect(since.entries.map((e) => e.id)).toEqual(["mid", "new"]);

    const window = await query(env, A, {
      since: new Date("2026-09-01T00:00:00Z"),
      until: new Date("2026-09-15T00:00:00Z"),
    });
    expect(window.entries.map((e) => e.id)).toEqual(["mid"]);
  });

  test("an empty ledger is an empty answer, not an error", async () => {
    const env = await makeEnv();
    const result = await query(env, A);
    expect(result.entries).toEqual([]);
    expect(result.files).toEqual([]);
  });

  test("I-3 — one subject's canary never appears in another's query", async () => {
    const env = await makeEnv();
    await append(env, entry({ subject: A, prompt: "canary-alpha-7f3a" }));
    await append(env, entry({ subject: B, prompt: "canary-beta-9c2d" }));

    const alpha = await query(env, A);
    const beta = await query(env, B);
    expect(JSON.stringify(alpha.entries)).toContain("canary-alpha-7f3a");
    expect(JSON.stringify(alpha.entries)).not.toContain("canary-beta-9c2d");
    expect(JSON.stringify(beta.entries)).not.toContain("canary-alpha-7f3a");
  });

  test("a line filed under the wrong subject is withheld and counted, not returned", async () => {
    const env = await makeEnv();
    await append(env, entry());
    // Hand-written into alpha's directory, claiming to be beta's.
    await writeFile(
      join(ledgerDir(env, A), "2026-09.jsonl"),
      `${JSON.stringify(entry({ subject: B, prompt: "canary-misfiled" }))}\n`,
      { flag: "a" },
    );

    const result = await query(env, A);
    expect(result.entries.length).toBe(1);
    expect(result.foreign).toBe(1);
    expect(JSON.stringify(result.entries)).not.toContain("canary-misfiled");
  });

  test("a half-written line is skipped and counted, not fatal", async () => {
    const env = await makeEnv();
    await append(env, entry());
    await writeFile(join(ledgerDir(env, A), "2026-09.jsonl"), `{"v":1,"kind":"tu\n`, { flag: "a" });
    await append(env, entry());

    const result = await query(env, A);
    expect(result.entries.length).toBe(2);
    expect(result.unreadable).toBe(1);
  });
});

describe("lines written before the counts existed (I-4)", () => {
  /** A line exactly as Mind wrote them before `usage` was a field. */
  function preUsageLine(overrides: Partial<LedgerEntry> = {}): string {
    const { usage: _dropped, ...line } = entry(overrides);
    return `${JSON.stringify(line)}\n`;
  }

  test("an old line is read, not counted as damage", async () => {
    const env = await makeEnv();
    await mkdir(ledgerDir(env, A), { recursive: true });
    await writeFile(join(ledgerDir(env, A), "2026-09.jsonl"), preUsageLine({ id: "old-1" }));

    const result = await query(env, A);
    // Not one of the unreadable ones. If it were, `ledger show` would report
    // damage on a file nothing is wrong with, and the line below could not be
    // deleted.
    expect(result.unreadable).toBe(0);
    expect(result.entries.map((e) => e.id)).toEqual(["old-1"]);
    expect(result.entries[0]!.usage).toBeUndefined();
  });

  test("an old line can still be withdrawn, by id and wholesale", async () => {
    // The failure this pins is the quiet one: a required field would make
    // these lines unparseable, `planForget` only matches lines it could read,
    // and `forget` would report success while leaving every pre-cost1 turn on
    // disk. I-4 is the right to withdraw, and a schema change must not take it.
    const env = await makeEnv();
    await mkdir(ledgerDir(env, A), { recursive: true });
    await writeFile(
      join(ledgerDir(env, A), "2026-09.jsonl"),
      preUsageLine({ id: "old-drop", prompt: "canary-old" }) +
        preUsageLine({ id: "old-keep", prompt: "canary-kept" }),
    );

    const byId = await planForget(env, A, { kind: "ids", ids: ["old-drop"] });
    expect(byId.matched.map((e) => e.id)).toEqual(["old-drop"]);
    expect(byId.backends).toEqual(["ollama"]);
    await commitForget(byId);
    expect(await grepTree(join(env.root, "state"), "canary-old")).toEqual([]);

    const rest = await planForget(env, A, { kind: "all" });
    expect(rest.matched.length).toBe(1);
    await commitForget(rest);
    expect(await grepTree(join(env.root, "state"), "canary-kept")).toEqual([]);
  });

  test("a new line beside an old one keeps its counts through the same file", async () => {
    const env = await makeEnv();
    await mkdir(ledgerDir(env, A), { recursive: true });
    await writeFile(join(ledgerDir(env, A), "2026-09.jsonl"), preUsageLine({ id: "old-1" }));
    await append(
      env,
      entry({ id: "new-1", usage: { status: "reported", input: 15, output: 24, total: null } }),
    );

    const result = await query(env, A);
    expect(result.entries.map((e) => e.usage?.status ?? "(absent)")).toEqual([
      "(absent)",
      "reported",
    ]);
  });
});

describe("forget (I-4)", () => {
  test("a dry run names the backends that already received the text", async () => {
    const env = await makeEnv();
    await append(env, entry({ backend: "claude", prompt: "canary-7f3a" }));
    await append(env, entry({ backend: "ollama", prompt: "canary-7f3a" }));

    const plan = await planForget(env, A, { kind: "all" });
    expect(plan.matched.length).toBe(2);
    expect(plan.backends).toEqual(["claude", "ollama"]);
    expect(plan.withContent).toBe(2);
    // Nothing happened yet: a plan is a plan.
    expect((await query(env, A)).entries.length).toBe(2);
  });

  test("--all leaves no file, no directory and no tombstone", async () => {
    const env = await makeEnv();
    await append(env, entry({ prompt: "canary-7f3a" }));
    await append(env, entry({ at: "2026-08-01T00:00:00.000Z", prompt: "canary-7f3a" }));

    const plan = await planForget(env, A, { kind: "all" });
    const result = await commitForget(plan);
    expect(result.removed).toBe(2);
    expect(await removeLedgerDir(env, A)).toBe(true);

    // The owner ruled out a tombstone: a marker saying "something was here" is
    // itself a trace of the thing being withdrawn.
    expect(await grepTree(join(env.root, "state"), "canary-7f3a")).toEqual([]);
    expect(await grepTree(join(env.root, "state"), "alpha")).toEqual([]);
    await expect(readdir(ledgerDir(env, A))).rejects.toThrow();
  });

  test("--id removes one line and leaves the rest byte-identical", async () => {
    const env = await makeEnv();
    await append(env, entry({ id: "keep-1", prompt: "canary-keep" }));
    await append(env, entry({ id: "drop-1", prompt: "canary-drop" }));
    await append(env, entry({ id: "keep-2", prompt: "canary-keep" }));

    const plan = await planForget(env, A, { kind: "ids", ids: ["drop-1"] });
    expect(plan.matched.map((e) => e.id)).toEqual(["drop-1"]);
    expect(plan.kept).toBe(2);
    await commitForget(plan);

    const after = await query(env, A);
    expect(after.entries.map((e) => e.id)).toEqual(["keep-1", "keep-2"]);
    expect(await grepTree(join(env.root, "state"), "canary-drop")).toEqual([]);
    expect((await grepTree(join(env.root, "state"), "canary-keep")).length).toBe(1);
  });

  test("--before removes only what is older, across month files", async () => {
    const env = await makeEnv();
    await append(env, entry({ id: "july", at: "2026-07-05T00:00:00.000Z", prompt: "canary-old" }));
    await append(env, entry({ id: "sept", at: "2026-09-05T00:00:00.000Z", prompt: "canary-new" }));

    const plan = await planForget(env, A, { kind: "before", before: new Date("2026-08-01T00:00:00Z") });
    await commitForget(plan);

    expect((await query(env, A)).entries.map((e) => e.id)).toEqual(["sept"]);
    expect(await grepTree(join(env.root, "state"), "canary-old")).toEqual([]);
    // The emptied month file goes rather than being left as an empty husk.
    expect(await readdir(ledgerDir(env, A))).toEqual(["2026-09.jsonl"]);
  });

  test("forgetting one subject does not move a byte of another's", async () => {
    const env = await makeEnv();
    await append(env, entry({ subject: A, prompt: "canary-alpha" }));
    await append(env, entry({ subject: B, prompt: "canary-beta" }));
    const betaFile = join(ledgerDir(env, B), "2026-09.jsonl");
    const before = await Bun.file(betaFile).text();

    await commitForget(await planForget(env, A, { kind: "all" }));
    await removeLedgerDir(env, A);

    expect(await Bun.file(betaFile).text()).toBe(before);
    expect(await grepTree(join(env.root, "state"), "canary-alpha")).toEqual([]);
    expect((await grepTree(join(env.root, "state"), "canary-beta")).length).toBe(1);
  });

  test("a selective forget keeps unreadable lines, and says it will", async () => {
    const env = await makeEnv();
    await append(env, entry({ id: "drop-1", prompt: "canary-drop" }));
    await writeFile(join(ledgerDir(env, A), "2026-09.jsonl"), `{"broken":"canary-broken"\n`, {
      flag: "a",
    });

    const plan = await planForget(env, A, { kind: "ids", ids: ["drop-1"] });
    expect(plan.unreadable).toBe(1);
    await commitForget(plan);

    expect(await grepTree(join(env.root, "state"), "canary-drop")).toEqual([]);
    // Kept on purpose: Mind cannot prove a broken line is one of the ones
    // being withdrawn, so it says so rather than deleting on a guess.
    expect((await grepTree(join(env.root, "state"), "canary-broken")).length).toBe(1);
  });

  test("a plan that matches nothing removes nothing", async () => {
    const env = await makeEnv();
    await append(env, entry({ id: "keep-1" }));
    const plan = await planForget(env, A, { kind: "ids", ids: ["nonesuch"] });
    expect(await commitForget(plan)).toEqual({
      removed: 0,
      filesRewritten: [],
      filesRemoved: [],
      dirRemoved: false,
    });
    expect((await query(env, A)).entries.length).toBe(1);
  });

  test("the list of what deletion cannot reach names the vendor's own transcript", async () => {
    // I-4's second half: do not claim to delete what cannot be deleted. These
    // strings are asserted because the command prints them every time, and a
    // shortened list would be a quieter promise than the code can keep.
    const text = UNDELETABLE.join("\n");
    expect(text).toContain("shred");
    expect(text).toContain("snapshot");
    expect(text).toContain("~/.claude/projects");
    expect(text).toContain("shell history");
  });
});

describe("S2.2 AC5 — the ledger is readable with jq and nothing of Mind's", () => {
  const jq = Bun.which("jq");

  test.skipIf(jq === null)("every line is a JSON object jq reads on its own, fields by name", async () => {
    const env = await makeEnv();
    await append(env, entry({ prompt: "ใช้ภาษาไทยได้ \"quoted\"\nnew line", text: "ok" }));
    await append(env, entry({ content: "withheld", prompt: null, text: null } as Partial<LedgerEntry>));
    const dir = ledgerDir(env, A);
    const file = join(dir, (await readdir(dir)).find((name) => name.endsWith(".jsonl"))!);

    const run = Bun.spawnSync([jq!, "-c", "[.subject, .backend, .prompt]", file]);
    expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
    const rows = new TextDecoder().decode(run.stdout).trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toEqual([
      ["alpha", "ollama", "ใช้ภาษาไทยได้ \"quoted\"\nnew line"],
      ["alpha", "ollama", null],
    ]);
  });
});
