/**
 * S3.5 AC1 and AC3 — one address, and a delete that proves itself.
 *
 * ## AC1: the address, and why it is this one (D-025)
 *
 * D-014 put observer data under `.mind/observer/`, on the understanding that
 * E3 could mine it back out of vendor transcripts. SP-1 measured the retention
 * and D-024 changed the epic: capture now happens at the moment something
 * happens, and the capture is the only copy there will ever be. `.mind/` holds
 * what a rebuild can reconstruct and a rebuild *sweeps out* the rest —
 * `test/agent/rebuild.test.ts` has asserted since S0.3 that it deletes
 * `.mind/observer/raw.jsonl` by name. Git is not the answer either: a record of
 * what a person did is the most withdrawable thing Mind will ever hold (I-4),
 * and git remembers what it was asked to forget.
 *
 * So: `personalDir(subject)/observer/`, and nowhere else. Building on
 * `personalDir` rather than beside it is what makes three properties free
 * instead of re-implemented — refused inside a git repository, blocked by the
 * pre-commit scan if staged, created 0700 — and the tests for those live in
 * `test/guard/personal.test.ts`. What is re-checked here is only that the
 * observer directory really is *under* that path, so a later edit cannot quietly
 * move it out from behind them.
 *
 * ## AC3: "purge deletes everything and verification finds nothing"
 *
 * The number a purge prints is read back **off the filesystem after the
 * unlinks**, never derived from how many of them returned successfully. That
 * distinction is the whole criterion: a command that subtracted its own
 * successes from its own plan would print `0 remaining` on a run where a file
 * it never managed to delete is still sitting on disk. So there is a control
 * for exactly that — a file inside a directory this test makes unwritable,
 * which the purge cannot remove and must therefore refuse to report as gone.
 *
 * The other half of I-4 is the half usually skipped: *do not claim to delete
 * what cannot be deleted*. `OBSERVER_UNDELETABLE` is printed on every run
 * including a dry run and a run that found nothing, and the tests at the bottom
 * are what make that "every" checkable.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { personalDir } from "../../src/guard/personal.ts";
import {
  announceCapture,
  census,
  commitPurge,
  ensureObserverDir,
  observerDir,
  OBSERVER_DIR,
  OBSERVER_UNDELETABLE,
  planPurge,
  type ObserverEnv,
} from "../../src/observer/index.ts";
import { subjectId } from "../../src/types.ts";
import { BUN } from "../support/bare-path.ts";

/**
 * The capture notice, minted once for this file (S7.2 AC4).
 *
 * `ensureObserverDir` cannot be called without one, which is the point: the
 * list of what a purge will not reach has to have been written *before* the
 * directory that holds the records exists. Discarded here because a test is
 * not the reader it exists for; `test/observer/capture-notice.test.ts` is where
 * the lines themselves are asserted.
 */
const NOTICE = announceCapture(() => undefined);

const ROOT = resolve(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SUBJECT = subjectId("example");
const OTHER = subjectId("somebody-else");

/**
 * A string that exists nowhere else on this machine.
 *
 * Grepped for after the purge across both roots. "The census says zero" and
 * "the bytes are not findable" are different claims, and AC3 asks for the
 * second one.
 */
const CANARY = "canary-6f3a1b-observer-raw";

const scratch: string[] = [];
const restoreMode: Array<[string, number]> = [];

afterEach(async () => {
  // Undone first: a directory left at 0500 makes the removal below fail and
  // leaves a temp tree behind.
  for (const [path, mode] of restoreMode.splice(0)) await chmod(path, mode).catch(() => undefined);
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-purge-"));
  scratch.push(dir);
  return dir;
}

function envFor(home: string): ObserverEnv {
  return { home, env: { XDG_DATA_HOME: join(home, "data") } };
}

/** Every regular file under `root` whose bytes contain `needle`. */
async function grepTree(root: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  const bytes = new TextEncoder().encode(needle);

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const data = new Uint8Array(await Bun.file(path).arrayBuffer());
      if (indexOfBytes(data, bytes) >= 0) hits.push(path);
    }
  };

  await walk(root);
  return hits;
}

/** Substring search over bytes, so a file that is not valid UTF-8 still counts. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * A tree of the awkward shapes a real capture directory grows.
 *
 * Deliberately not valid JSON throughout: w4 owns the record schema and has not
 * written it, and a purge that understood the schema would be a purge that
 * stopped deleting on the day the schema changed.
 */
async function fixture(dir: string): Promise<void> {
  await Bun.write(join(dir, "raw.jsonl"), `{"what":"typed","text":"${CANARY}"}\n`);
  // No trailing newline: the last line still counts as a line.
  await Bun.write(join(dir, "partial.jsonl"), `{"what":"interrupted`);
  await Bun.write(join(dir, "2026", "09", "21.jsonl"), `${CANARY}\n${CANARY}\n`);
  // Not text at all, and not decodable as UTF-8. Counted in bytes regardless.
  await writeFile(join(dir, "blob.bin"), new Uint8Array([0x00, 0xff, 0xfe, 0x0a]));
}

/** Run the real CLI against a sandbox home, with stdout piped so it stays plain. */
async function cli(home: string, args: readonly string[]) {
  const child = Bun.spawn([BUN, "run", BIN, ...args], {
    cwd: home,
    env: {
      HOME: home,
      PATH: dirname(BUN),
      XDG_DATA_HOME: join(home, "data"),
      XDG_STATE_HOME: join(home, "state"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  return { code: child.exitCode ?? -1, stdout, stderr };
}

// ---------------------------------------------------------------------------
// AC1 — the one address
// ---------------------------------------------------------------------------

describe("AC1 — where raw capture lives", () => {
  test("it is under the personal directory, so S0.4's three checks cover it", async () => {
    const home = await sandbox();
    const env = envFor(home);

    const personal = await personalDir(env, SUBJECT);
    const resolved = await observerDir(env, SUBJECT);

    expect(resolved.ok).toBe(true);
    expect(resolved.path).toBe(join(personal.path, OBSERVER_DIR));
    expect(resolved.path).toContain(join("mind", SUBJECT, "personal", "observer"));
  });

  test("resolving does not create it — asking where is not putting it there", async () => {
    const home = await sandbox();
    const resolved = await observerDir(envFor(home), SUBJECT);

    expect(resolved.ok).toBe(true);
    expect(await Bun.file(resolved.path).exists()).toBe(false);
  });

  test("a data root inside a git repository is refused, inherited from personalDir", async () => {
    const home = await sandbox();
    const checkout = join(home, "notes");
    await mkdir(join(checkout, ".git"), { recursive: true });

    const resolved = await observerDir({ home, env: { XDG_DATA_HOME: checkout } }, SUBJECT);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toContain("D-014");

    // And it is refused on the creating path too, not only the resolving one.
    const created = await ensureObserverDir(
      { home, env: { XDG_DATA_HOME: checkout } },
      SUBJECT,
      NOTICE,
    );
    expect(created.ok).toBe(false);
  });

  test("I-3 — two subjects never share a directory", async () => {
    const home = await sandbox();
    const env = envFor(home);

    const mine = await observerDir(env, SUBJECT);
    const theirs = await observerDir(env, OTHER);
    expect(mine.path).not.toBe(theirs.path);
  });
});

// ---------------------------------------------------------------------------
// AC3 — counting, then deleting, then counting again
// ---------------------------------------------------------------------------

describe("census — bytes and lines, never records", () => {
  test("it counts the shapes a capture directory actually grows", async () => {
    const home = await sandbox();
    const created = await ensureObserverDir(envFor(home), SUBJECT, NOTICE);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await fixture(created.path);

    const counted = await census(created.path);
    expect(counted.files).toBe(4);
    // 1 + 1 (no trailing newline) + 2 + 1 (the 0x0a in the binary file).
    expect(counted.lines).toBe(5);
    expect(counted.bytes).toBeGreaterThan(0);
    expect(counted.directories.length).toBe(2);
    expect(counted.paths.length).toBe(4);
  });

  test("a directory that does not exist is zero, not an error", async () => {
    const home = await sandbox();
    const counted = await census(join(home, "never-created"));

    expect(counted.files).toBe(0);
    expect(counted.lines).toBe(0);
    expect(counted.bytes).toBe(0);
    expect(counted.paths).toEqual([]);
  });
});

describe("purge — and the recount that makes it a claim", () => {
  test("everything goes, and the canary is findable nowhere afterwards", async () => {
    const home = await sandbox();
    const env = envFor(home);
    const created = await ensureObserverDir(env, SUBJECT, NOTICE);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await fixture(created.path);

    // The control for the control: the canary really is there to begin with,
    // so "not found afterwards" is evidence rather than a search that never
    // worked.
    expect((await grepTree(join(home, "data"), CANARY)).length).toBeGreaterThan(0);

    const plan = await planPurge(env, SUBJECT);
    expect("ok" in plan).toBe(false);
    if ("ok" in plan) return;
    expect(plan.before.files).toBe(4);

    const result = await commitPurge(plan);
    expect(result.removed.length).toBe(4);
    expect(result.failed).toEqual([]);
    expect(result.dirRemoved).toBe(true);

    // The acceptance criterion, read off the filesystem rather than computed.
    expect(result.remaining.files).toBe(0);
    expect(result.remaining.bytes).toBe(0);

    // I-4's second half: search and the text is not there. Both roots, because
    // a leak into the state root is the interesting one.
    expect(await grepTree(join(home, "data"), CANARY)).toEqual([]);
    expect(await grepTree(join(home, "state"), CANARY)).toEqual([]);
  });

  test("the control: a file it cannot delete keeps `remaining` above zero", async () => {
    const home = await sandbox();
    const env = envFor(home);
    const created = await ensureObserverDir(env, SUBJECT, NOTICE);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await Bun.write(join(created.path, "deletable.jsonl"), "{}\n");
    const locked = join(created.path, "locked");
    await mkdir(locked, { recursive: true });
    await Bun.write(join(locked, "stuck.jsonl"), `${CANARY}\n`);
    // Unlinking needs write on the *directory*, not on the file.
    await chmod(locked, 0o500);
    restoreMode.push([locked, 0o700]);

    const plan = await planPurge(env, SUBJECT);
    expect("ok" in plan).toBe(false);
    if ("ok" in plan) return;

    const result = await commitPurge(plan);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]!.path).toBe(join(locked, "stuck.jsonl"));

    // This is what the test exists for. A purge that reported its own plan
    // back would say 0 here, and the canary would still be on disk.
    expect(result.remaining.files).toBe(1);
    expect(result.dirRemoved).toBe(false);
    expect(await grepTree(join(home, "data"), CANARY)).not.toEqual([]);
  });

  test("the control: purging one subject leaves the other's count untouched", async () => {
    const home = await sandbox();
    const env = envFor(home);

    const mine = await ensureObserverDir(env, SUBJECT, NOTICE);
    const theirs = await ensureObserverDir(env, OTHER, NOTICE);
    expect(mine.ok && theirs.ok).toBe(true);
    if (!mine.ok || !theirs.ok) return;
    await fixture(mine.path);
    await fixture(theirs.path);

    const before = await census(theirs.path);
    expect(before.files).toBe(4);

    const plan = await planPurge(env, SUBJECT);
    if ("ok" in plan) throw new Error(plan.reason);
    const result = await commitPurge(plan);
    expect(result.remaining.files).toBe(0);

    const after = await census(theirs.path);
    expect(after).toEqual(before);
  });

  test("a symlink is unlinked and its target is not followed", async () => {
    const home = await sandbox();
    const env = envFor(home);
    const created = await ensureObserverDir(env, SUBJECT, NOTICE);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const outside = join(home, "elsewhere.txt");
    await Bun.write(outside, `${CANARY}\n`);
    await symlink(outside, join(created.path, "link.jsonl"));

    const counted = await census(created.path);
    expect(counted.symlinks).toEqual([join(created.path, "link.jsonl")]);

    const plan = await planPurge(env, SUBJECT);
    if ("ok" in plan) throw new Error(plan.reason);
    const result = await commitPurge(plan);

    expect(result.remaining.files).toBe(0);
    // The link is gone; what it pointed at never was inside the one declared
    // path, so deleting it would have been a purge reaching outside its promise.
    await expect(lstat(join(created.path, "link.jsonl"))).rejects.toThrow();
    expect(await Bun.file(outside).text()).toContain(CANARY);
    // And the output says so, rather than leaving the owner to assume.
    expect(OBSERVER_UNDELETABLE.join("\n")).toContain("the target of any symlink");
  });

  test("an observer directory that is itself a symlink is refused, not purged", async () => {
    const home = await sandbox();
    const env = envFor(home);

    // Build the personal directory, then put a link where `observer/` goes.
    const created = await ensureObserverDir(env, SUBJECT, NOTICE);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const real = join(home, "somewhere-else");
    await mkdir(real, { recursive: true });
    await Bun.write(join(real, "raw.jsonl"), `${CANARY}\n`);
    await rm(created.path, { recursive: true, force: true });
    await symlink(real, created.path);

    const plan = await planPurge(env, SUBJECT);
    expect("ok" in plan).toBe(true);
    if (!("ok" in plan)) return;
    expect(plan.reason).toContain("symlink");

    // Nothing was touched: refusing beats reporting a truthful-looking zero.
    expect(await Bun.file(join(real, "raw.jsonl")).text()).toContain(CANARY);
  });
});

// ---------------------------------------------------------------------------
// The command — including what it prints on the runs that delete nothing
// ---------------------------------------------------------------------------

describe("observe purge, as a command", () => {
  test("it deletes, recounts from disk, and exits 0", async () => {
    const home = await sandbox();
    const created = await ensureObserverDir(envFor(home), SUBJECT, NOTICE);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await fixture(created.path);

    const run = await cli(home, ["observe", "purge", "--subject", SUBJECT]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("removed 4 file(s)");
    expect(run.stdout).toContain("remaining: 0 file(s) · 0 line(s) · 0 byte(s)");
    expect(await grepTree(join(home, "data"), CANARY)).toEqual([]);
  }, 30_000);

  test("--dry-run counts and removes nothing", async () => {
    const home = await sandbox();
    const created = await ensureObserverDir(envFor(home), SUBJECT, NOTICE);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await fixture(created.path);

    const run = await cli(home, ["observe", "purge", "--subject", SUBJECT, "--dry-run"]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("4 file(s)");
    expect(run.stdout).toContain("Nothing was removed.");
    expect((await census(created.path)).files).toBe(4);
  }, 30_000);

  test("the limits are printed on every run, including the ones that delete nothing", async () => {
    const home = await sandbox();

    // Three runs that between them cover every exit from the command: a purge
    // with data, a dry run, and a purge with nothing there at all. The moment
    // somebody is entitled to know what a purge cannot reach is the moment
    // before they believe it reached everything — which includes these.
    const created = await ensureObserverDir(envFor(home), SUBJECT, NOTICE);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await fixture(created.path);

    const dry = await cli(home, ["observe", "purge", "--subject", SUBJECT, "--dry-run"]);
    const real = await cli(home, ["observe", "purge", "--subject", SUBJECT]);
    const empty = await cli(home, ["observe", "purge", "--subject", SUBJECT]);
    const status = await cli(home, ["observe", "status", "--subject", SUBJECT]);

    for (const run of [dry, real, empty, status]) {
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toContain("What this does not reach:");
      for (const note of OBSERVER_UNDELETABLE) {
        // The first clause of each, which is enough to tell them apart and
        // does not re-assert the wrapping.
        expect(run.stdout).toContain(note.split(" — ")[0]!.split(". ")[0]!);
      }
    }

    expect(empty.stdout).toContain("removed 0 file(s)");
  }, 60_000);

  test("a subject that is not a valid id is a usage error, and creates nothing", async () => {
    const home = await sandbox();

    const run = await cli(home, ["observe", "purge", "--subject", "../escape"]);
    expect(run.code).not.toBe(0);
    expect(await Bun.file(join(home, "data")).exists()).toBe(false);
  }, 30_000);
});
