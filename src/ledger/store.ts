/**
 * The ledger on disk: append, read back, and — the hard half — delete.
 *
 * Plain files and nothing else. No sqlite, no daemon, no index: an owner with
 * `cat` and `jq` can read every byte Mind wrote about them without Mind
 * installed, and an owner with `rm` can end it. That is not minimalism for its
 * own sake; it is what makes the deletion promise in I-4 checkable by someone
 * who does not trust this code.
 *
 * Where: `$XDG_STATE_HOME/mind/ledger/<subject>/YYYY-MM.jsonl`.
 *
 * ADR 0002 §3 originally said `<state root>/<subject>/`, and that is a bug rather
 * than a preference: `backups` is a valid subject id, so a subject called
 * `backups` would have landed on top of the tree `soul apply` keeps originals
 * in. The extra `ledger/` segment puts the two side by side instead, and the
 * ADR has been corrected to match.
 *
 * Why one file per month: a time-ranged query reads only the months it needs,
 * and — more to the point — a `forget` rewrites only the months it touched,
 * so the blast radius of the one operation that is not append-only stays as
 * small as the request that caused it.
 *
 * ## Append-only (AC2), and deletion (I-4), in the same file
 *
 * These do not contradict each other. The *writing* path has exactly one
 * operation: a single `O_APPEND` write of a whole line. There is no update, no
 * upsert, and no API anywhere in Mind that edits a line in place. Deletion
 * is a separate command the owner types, and it does not edit lines either —
 * it filters a file and replaces it.
 *
 * ## The lock, and why it is not optional
 *
 * `mkdir` is the lock, because it is the one filesystem operation that is
 * atomic on every filesystem worth supporting. Both append and forget take it.
 * Without it, a turn that finished during a `forget`'s rename would append to
 * a file that is about to be replaced, and the line would vanish — silently,
 * which is the failure mode this project is built to refuse.
 *
 * A lock that is held is waited for, not refused: turns that finish together
 * all reach this file, and the one that lost the race used to be the one that
 * was sent and not recorded (D-145). Mind does not guess that a lock is
 * stale, because the cost of guessing wrong is a lost record — it breaks one
 * only on evidence that its owner is gone, and it says who holds one it gave
 * up waiting for. `src/ledger/lock.ts` has the rules and the numbers.
 */

import { mkdir, open, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mediaUndeletable, STATE_DIR_MODE, STATE_FILE_MODE, stateRoot } from "../state.ts";
import type { SubjectId } from "../types.ts";
import { formatLine, parseLine, type LedgerEntry } from "./entry.ts";
import { LedgerLocked, LOCK_TIMING, withLock, type LockTiming, type ThisMachine } from "./lock.ts";

/**
 * Everything the ledger is allowed to know about this machine.
 *
 * Injected for the same reason `ApplyEnv` is: a test that resolved the real
 * `$HOME` would write a real person's conversations into a real state
 * directory, and no assertion would catch it.
 */
export interface LedgerEnv {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => Date;
  /**
   * This machine's name and boot time, for the lock and nothing else (D-145):
   * they are what let a writer tell a dead writer's lock from a live one.
   * Optional so that a caller that only reads need not say; a writer without
   * them judges every lock by its age alone, which errs toward waiting.
   */
  readonly machine?: ThisMachine;
}

/** `<state>/ledger/<subject>` — one directory per subject, never shared (I-3). */
export function ledgerDir(env: Pick<LedgerEnv, "home" | "env">, subject: SubjectId): string {
  return join(stateRoot(env.home, env.env), "ledger", subject);
}

/** `YYYY-MM.jsonl`, in UTC, so the file a line lands in never depends on a timezone. */
export function monthFileName(at: Date): string {
  const month = `${at.getUTCMonth() + 1}`.padStart(2, "0");
  return `${at.getUTCFullYear()}-${month}.jsonl`;
}

/** Month files in a subject's directory, oldest first. `.lock` is not one. */
async function monthFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort();
  } catch {
    return [];
  }
}

/** Flush a path's own bytes, or a directory's list of names, to the device. */
async function fsyncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Whether the ledger can be written, checked *before* a prompt is sent. */
export type Writability =
  | { readonly ok: true; readonly dir: string }
  | {
      readonly ok: false;
      /**
       * `locked`: somebody alive held the lock for longer than a writer waits — it passes, or clears by
       * itself. `unwritable`: the directory cannot be made or written — a person has to fix a path.
       */
      readonly kind: "locked" | "unwritable";
      /** What went wrong, naming the path. */
      readonly reason: string;
      /**
       * What to do about it, for the person who ran the turn. Never "delete the ledger": it is the record
       * of every turn, and neither kind is fixed by losing it (D-145).
       */
      readonly remedy: string;
    };

/** The advice for each kind of refusal. */
function remedyFor(kind: "locked" | "unwritable", timing: LockTiming): string {
  if (kind === "locked") {
    return (
      "Another turn is writing this agent's ledger — try again in a moment. If no mind process is running, " +
      "the lock was left by one that was stopped, and the next turn clears it by itself: at once if its process " +
      `is gone from this machine, and in any case once it is ${Math.round(timing.maxAgeMs / 60_000)} minutes old. ` +
      "Deleting the ledger would not be a fix; it is the record of every turn."
    );
  }
  return (
    "A turn nobody can look back at is the thing S2.2 exists to prevent. Fix what the line above names — the " +
    "directory's permissions, a file in its way, a full or read-only disk — and run the turn again. None of " +
    "these needs the ledger deleted, and deleting it would lose the record of every turn so far."
  );
}

function refused(kind: "locked" | "unwritable", reason: string, timing: LockTiming): Writability {
  return { ok: false, kind, reason, remedy: remedyFor(kind, timing) };
}

/**
 * Can this subject's ledger be appended to right now?
 *
 * Called before the prompt goes out, not after. A turn that is sent and then
 * cannot be recorded has already spent the quota and already handed the text
 * to a vendor, and no later error can undo either. Finding out first costs one
 * `mkdir`, one probe write, and taking the lock once.
 *
 * The lock is taken the way {@link append} will take it — waiting as long,
 * breaking a stale one — and let go at once. A lock somebody alive holds for
 * longer than that wait would fail this turn's line after the send; found
 * here, it refuses the turn before (D-145). And a lock a killed turn left
 * behind is cleared here, so the turn after it starts clean.
 */
export async function canAppend(
  env: LedgerEnv,
  subject: SubjectId,
  timing: LockTiming = LOCK_TIMING,
): Promise<Writability> {
  const dir = ledgerDir(env, subject);
  try {
    await mkdir(dir, { recursive: true, mode: STATE_DIR_MODE });
  } catch (cause) {
    return refused("unwritable", `cannot create ${dir}: ${String(cause)}`, timing);
  }

  const probe = join(dir, `.writable-${process.pid}`);
  try {
    await writeFile(probe, "", { mode: STATE_FILE_MODE });
    await unlink(probe);
  } catch (cause) {
    return refused("unwritable", `cannot write in ${dir}: ${String(cause)}`, timing);
  }

  try {
    await withLock(dir, async () => undefined, timing, env.machine);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return refused(cause instanceof LedgerLocked ? "locked" : "unwritable", reason, timing);
  }
  return { ok: true, dir };
}

/**
 * Append one line.
 *
 * `O_APPEND` plus `fsync`: the write is atomic against other appenders at the
 * size of line this format produces, and the `fsync` is what makes "the turn
 * happened and was recorded" survive a power cut in that order rather than the
 * other one.
 *
 * The lock is waited for (D-145) — turns that finish together all land here
 * at once — and `timing` is how long. The default is {@link LOCK_TIMING}'s
 * five seconds, for a line written as a gate *before* something is sent: a
 * chat message in or out, an A2A message delivered or sent. Waiting longer
 * there stalls a reply, and outlasts an A2A sender's own timeout so that it
 * reports a failure the receiver then delivers anyway. The one line written
 * *after* a send — `RecordingExec`'s, once a backend has answered — passes
 * {@link RECORD_TIMING}, a minute: by then the prompt has gone, and giving up
 * loses the record of something that happened.
 *
 * @throws {Error} when the line could not be written. The caller decides what
 *   that means; the ledger will not swallow it.
 */
export async function append(
  env: LedgerEnv,
  entry: LedgerEntry,
  timing: LockTiming = LOCK_TIMING,
): Promise<string> {
  const dir = ledgerDir(env, entry.subject);
  await mkdir(dir, { recursive: true, mode: STATE_DIR_MODE });
  const path = join(dir, monthFileName(new Date(entry.at)));

  return withLock(
    dir,
    async () => {
      const handle = await open(path, "a", STATE_FILE_MODE);
      try {
        await handle.write(formatLine(entry));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return path;
    },
    timing,
    env.machine,
  );
}

/** A time window. Both ends optional, both inclusive of the instant given. */
export interface QueryRange {
  readonly since?: Date;
  readonly until?: Date;
}

export interface QueryResult {
  readonly entries: readonly LedgerEntry[];
  /** Lines that could not be parsed — counted and reported, never hidden. */
  readonly unreadable: number;
  /**
   * Lines whose `subject` is not the directory's subject.
   *
   * Should be zero forever. It is counted rather than returned because I-3
   * says an identity's data must not surface under another's, and the safe
   * behaviour when the two disagree is to withhold the line and say so.
   */
  readonly foreign: number;
  readonly files: readonly string[];
}

/** Read one subject's ledger, filtered by time (AC3). */
export async function query(
  env: LedgerEnv,
  subject: SubjectId,
  range: QueryRange = {},
): Promise<QueryResult> {
  const dir = ledgerDir(env, subject);
  const entries: LedgerEntry[] = [];
  const files: string[] = [];
  let unreadable = 0;
  let foreign = 0;

  for (const name of await monthFiles(dir)) {
    const path = join(dir, name);
    files.push(path);
    const text = await Bun.file(path).text();
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const parsed = parseLine(line);
      if (!parsed.ok) {
        unreadable++;
        continue;
      }
      if (parsed.entry.subject !== subject) {
        foreign++;
        continue;
      }
      if (!inRange(parsed.entry, range)) continue;
      entries.push(parsed.entry);
    }
  }

  entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return { entries, unreadable, foreign, files };
}

function inRange(entry: LedgerEntry, range: QueryRange): boolean {
  const at = Date.parse(entry.at);
  if (Number.isNaN(at)) return false;
  if (range.since !== undefined && at < range.since.getTime()) return false;
  if (range.until !== undefined && at > range.until.getTime()) return false;
  return true;
}

/** What to forget. Exactly one of these is set by the command line. */
export type ForgetSelector =
  | { readonly kind: "all" }
  | { readonly kind: "ids"; readonly ids: readonly string[] }
  | { readonly kind: "before"; readonly before: Date };

/**
 * What a `forget` would remove, computed before anything is removed.
 *
 * `backends` is the reason this type exists rather than a count. Once the
 * lines are gone, so is the answer to "who already has this text?" — and that
 * answer is the one thing an owner deciding whether deletion is enough
 * actually needs. So it is printed first, from the lines themselves, while
 * they still exist.
 */
export interface ForgetPlan {
  readonly subject: SubjectId;
  readonly dir: string;
  readonly selector: ForgetSelector;
  /** Lines that match. */
  readonly matched: readonly LedgerEntry[];
  /** Lines that stay. */
  readonly kept: number;
  /** Distinct backends that received the matched prompts, sorted. */
  readonly backends: readonly string[];
  /** Whether any matched line still holds its text (a `--private` line does not). */
  readonly withContent: number;
  /**
   * Unparseable lines in the files involved.
   *
   * A selective forget keeps them — Mind cannot tell whether a broken line
   * is one of the ones being withdrawn — and says so, because "I deleted
   * everything you asked for" would then be false. `--all` removes them with
   * the files.
   */
  readonly unreadable: number;
  readonly files: readonly string[];
  /** The machine the plan was made on, so the commit judges the lock as a turn would (D-145). */
  readonly machine: ThisMachine | undefined;
}

export interface ForgetResult {
  readonly removed: number;
  readonly filesRewritten: readonly string[];
  readonly filesRemoved: readonly string[];
  /** True when the subject's directory itself is gone. */
  readonly dirRemoved: boolean;
}

function matches(entry: LedgerEntry, selector: ForgetSelector): boolean {
  switch (selector.kind) {
    case "all":
      return true;
    case "ids":
      return selector.ids.includes(entry.id);
    case "before": {
      const at = Date.parse(entry.at);
      return !Number.isNaN(at) && at < selector.before.getTime();
    }
  }
}

/** Work out what would go, touching nothing. This is what a dry run prints. */
export async function planForget(
  env: LedgerEnv,
  subject: SubjectId,
  selector: ForgetSelector,
): Promise<ForgetPlan> {
  const dir = ledgerDir(env, subject);
  const matched: LedgerEntry[] = [];
  const backends = new Set<string>();
  const files: string[] = [];
  let kept = 0;
  let unreadable = 0;
  let withContent = 0;

  for (const name of await monthFiles(dir)) {
    const path = join(dir, name);
    files.push(path);
    for (const line of (await Bun.file(path).text()).split("\n")) {
      if (line.trim() === "") continue;
      const parsed = parseLine(line);
      if (!parsed.ok) {
        unreadable++;
        continue;
      }
      // A line filed under another subject is not this subject's to delete,
      // and not this subject's to read either (I-3). It stays where it is and
      // the count above is what a reader is told.
      if (parsed.entry.subject !== subject) {
        kept++;
        continue;
      }
      if (matches(parsed.entry, selector)) {
        matched.push(parsed.entry);
        backends.add(parsed.entry.backend);
        if (parsed.entry.content === "full") withContent++;
      } else {
        kept++;
      }
    }
  }

  return {
    subject,
    dir,
    selector,
    matched,
    kept,
    backends: [...backends].sort(),
    withContent,
    unreadable,
    files,
    machine: env.machine,
  };
}

/**
 * Carry out a plan.
 *
 * Selective removal rewrites each affected month through a temporary file in
 * the same directory, `fsync`s it, renames over the original and `fsync`s the
 * directory — so a crash leaves either the old file or the new one, never a
 * truncated one. `--all` unlinks the files and removes the directory, leaving
 * no marker behind: a tombstone saying "something used to be here" is a trace
 * of the thing the owner asked to erase, and the owner ruled it out.
 *
 * Takes no `LedgerEnv`: everything it needs is in the plan, and re-resolving
 * the directory here would let a commit run somewhere the dry run never
 * looked.
 *
 * @throws {Error} when the lock is held or a write fails. A partial deletion
 *   that reported success would be the worst outcome available here.
 */
export async function commitForget(plan: ForgetPlan): Promise<ForgetResult> {
  if (plan.matched.length === 0) {
    return { removed: 0, filesRewritten: [], filesRemoved: [], dirRemoved: false };
  }

  return withLock(plan.dir, async () => {
    if (plan.selector.kind === "all") {
      const removed: string[] = [];
      for (const path of await monthFiles(plan.dir)) {
        await unlink(join(plan.dir, path));
        removed.push(join(plan.dir, path));
      }
      return {
        removed: plan.matched.length,
        filesRewritten: [],
        filesRemoved: removed,
        // The lock is inside the directory and `withLock` removes it after
        // this returns, so the directory itself goes in the caller below.
        dirRemoved: false,
      };
    }

    const ids = new Set(plan.matched.map((entry) => entry.id));
    const rewritten: string[] = [];
    const emptied: string[] = [];

    for (const name of await monthFiles(plan.dir)) {
      const path = join(plan.dir, name);
      const original = await Bun.file(path).text();
      const kept: string[] = [];
      let dropped = 0;

      for (const line of original.split("\n")) {
        if (line.trim() === "") continue;
        const parsed = parseLine(line);
        // Unparseable lines are kept verbatim: Mind cannot prove one of them
        // is not something else the owner still wants, and `planForget`
        // already warned that they may hold content.
        if (parsed.ok && ids.has(parsed.entry.id)) {
          dropped++;
          continue;
        }
        kept.push(line);
      }
      if (dropped === 0) continue;

      if (kept.length === 0) {
        await unlink(path);
        emptied.push(path);
      } else {
        const temp = `${path}.mind-${process.pid}.tmp`;
        await writeFile(temp, `${kept.join("\n")}\n`, { mode: STATE_FILE_MODE });
        await fsyncPath(temp);
        await rename(temp, path);
        rewritten.push(path);
      }
    }

    await fsyncPath(plan.dir);
    return {
      removed: plan.matched.length,
      filesRewritten: rewritten,
      filesRemoved: emptied,
      dirRemoved: false,
    };
  }, LOCK_TIMING, plan.machine);
}

/**
 * Remove the subject's directory once `--all` has emptied it.
 *
 * Separate from {@link commitForget} because the lock lives inside the
 * directory: it has to be released before the directory can go.
 */
export async function removeLedgerDir(env: LedgerEnv, subject: SubjectId): Promise<boolean> {
  return removeLedgerDirAt(ledgerDir(env, subject));
}

/**
 * The same removal, over the directory a plan already named.
 *
 * `mind erase` (S7.2) commits from a plan and takes no `LedgerEnv`, for the
 * reason {@link commitForget} gives: re-resolving a path inside a commit lets
 * it act somewhere the dry run never looked. `ForgetPlan.dir` is that path, so
 * this is the form erase calls — the same one line, not a second copy of it.
 */
export async function removeLedgerDirAt(dir: string): Promise<boolean> {
  try {
    // Deliberately not recursive: if anything is left in there, Mind has
    // miscounted and the right move is to leave the evidence alone.
    await rmdir(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * The copy Mind can never reach: the one a vendor already has.
 *
 * Its own constant rather than a line inside {@link UNDELETABLE}, because two
 * commands state this fact at two different moments and they must state the
 * same fact. `ledger forget` reads it *after* the send, which is the moment a
 * reader can do nothing about it; `src/exec/egress.ts` announces it *before*
 * `turn` hands a prompt to a cloud backend, which is S7.2 AC4's "แจ้งก่อน".
 * One string, exported, asserted by identity in the tests — so the two moments
 * cannot drift into two different promises.
 *
 * What it is **not**: a sixth entry in `PLACES` (`src/erase/places.ts`). S7.2
 * AC1 closes that registry at five, and a vendor's copy has no path on this
 * machine for `erase` to search or delete. It is `NOT_SEARCHED`, said out loud.
 */
export const VENDORS_HOLD =
  "what the vendors hold: any prompt already sent to a cloud CLI has left this machine, and each " +
  "vendor CLI also writes its own transcript here (for example ~/.claude/projects/*.jsonl). " +
  "Mind does not touch those and cannot delete them for you.";

/**
 * What deletion cannot reach — printed every time, never only documented.
 *
 * I-4's second half is the one that is usually skipped: *do not claim to
 * delete what cannot be deleted*. Each line below is something an owner would
 * reasonably assume `forget` handled, and does not.
 *
 * The first two are facts about the medium rather than about the ledger, so
 * they come from {@link mediaUndeletable} in `src/state.ts` — `observe purge`
 * (S3.5) prints the same two, and one copy of those words is easier to keep
 * true than two. The third is {@link VENDORS_HOLD}, spread in rather than
 * written out, for the same reason. The text this list produces has not
 * changed by a character; `test/ledger/store.test.ts` holds the literal it
 * used to be.
 */
export const UNDELETABLE: readonly string[] = [
  ...mediaUndeletable("these lines", "the state directory"),
  VENDORS_HOLD,
  "shell history, the process list and terminal scrollback — `--prompt <text>` puts the prompt on " +
    "a command line. `--prompt-file -` avoids that for the next turn, not for the ones already run.",
];
