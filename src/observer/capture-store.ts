/**
 * Where a captured action lands, and how it comes back.
 *
 * `$XDG_DATA_HOME/mind/<subject>/personal/observer/capture/YYYY-MM.jsonl`,
 * mode 0600 under a tree mode 0700, one JSON object per line. Plain files for
 * the reason the ledger uses plain files (`src/ledger/store.ts`): an owner with
 * `jq` can read every byte Mind wrote about them without Mind installed,
 * and an owner with `rm` can end it. That is what makes I-4 checkable by
 * somebody who does not trust this code.
 *
 * ## One append, and no lock
 *
 * The ledger takes a `mkdir` lock around every append, and that is right for
 * the ledger: one writer per turn, and a lost line is a turn nobody can look
 * back at. It would be wrong here. Hooks fire per tool call, several tools can
 * run concurrently, and `withLock` *throws* when the lock is held — so a lock
 * would turn "two tools finished at once" into "one of them was never
 * recorded", silently, which is the failure this project exists to refuse.
 *
 * So: `O_APPEND`, one `write()` per record, and a cap on the size of a record
 * so that the write stays inside what a filesystem will not interleave. The cap
 * is not a guess about POSIX guarantees — it is why `target` is bounded in
 * `record.ts` and why nothing here carries text. A record that somehow exceeds
 * it is refused rather than written torn.
 *
 * There is no `fsync`. The ledger's sync is there because "the turn happened
 * and was recorded" has to survive a power cut in that order; a capture record
 * is not a receipt for anything that left this machine, and an `fsync` per tool
 * call would put a disk flush in front of every command the owner runs.
 *
 * ## Coming back out flagged
 *
 * {@link readCaptured} returns a `Personal<T>`. Everything in this directory is
 * a record of what a person did, so it is on the far side of the door S3.5
 * built: a `Personal<T>` reaches a backend only through `runPersonal`
 * (`src/exec/local.ts`), which takes only a backend `asLocal()` minted. The
 * counting and the de-duplication happen *before* the flag goes on, because a
 * count is not the owner's data — the records are.
 */

import { mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { STATE_DIR_MODE, STATE_FILE_MODE } from "../state.ts";
import { flagPersonal, type Personal } from "../types.ts";
import { formatRecord, parseRecord, type CaptureRecord } from "./record.ts";

/** The directory records live in, under the observer directory. */
export const CAPTURE_SUBDIR = "capture";

/**
 * The largest line this will write.
 *
 * Every field is bounded by construction — no text, no output, a clamped target
 * — so a record over this size means something upstream started carrying
 * content, and refusing is how that is found out rather than discovering it in
 * a file six weeks later.
 */
export const RECORD_MAX_BYTES = 4096;

/** `<observer>/capture`. */
export function captureDir(observerPath: string): string {
  return join(observerPath, CAPTURE_SUBDIR);
}

/** `YYYY-MM.jsonl`, in UTC, so the file a record lands in never depends on a timezone. */
export function monthFileName(at: Date): string {
  const month = `${at.getUTCMonth() + 1}`.padStart(2, "0");
  return `${at.getUTCFullYear()}-${month}.jsonl`;
}

/**
 * Create the capture directory.
 *
 * Called from exactly one place — `observe enable`, after consent — and never
 * from the hook path. {@link appendRecord} deliberately cannot do this: a hook
 * that created its own directory would rebuild the tree a purge had removed,
 * and capture would resume without anybody agreeing to it a second time.
 */
export async function ensureCaptureDir(observerPath: string): Promise<string> {
  const dir = captureDir(observerPath);
  await mkdir(dir, { recursive: true, mode: STATE_DIR_MODE });
  return dir;
}

/** Month files under a capture directory, oldest first. */
async function monthFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort();
  } catch {
    return [];
  }
}

/** Why a record was not written. A refusal, never an exception thrown at a hook. */
export type AppendOutcome =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Append one record.
 *
 * Does **not** create the observer directory. That is the point: bringing the
 * capture tree into existence requires a `CaptureNotice`, which only
 * `announceCapture` mints, and the hook path must never be able to do it. A
 * missing directory here is "capture is not enabled", which is a refusal and
 * not an error.
 *
 * @param at The record's own time, so the month file matches the record rather
 *   than the moment the write happened.
 */
export async function appendRecord(
  observerPath: string,
  record: CaptureRecord,
  at: Date,
): Promise<AppendOutcome> {
  const line = formatRecord(record);
  const bytes = new TextEncoder().encode(line).length;
  if (bytes > RECORD_MAX_BYTES) {
    return { ok: false, reason: `a record of ${bytes} bytes is over the ${RECORD_MAX_BYTES}-byte cap` };
  }

  const path = join(captureDir(observerPath), monthFileName(at));
  let handle;
  try {
    handle = await open(path, "a", STATE_FILE_MODE);
  } catch (cause) {
    return { ok: false, reason: `cannot append to ${path}: ${String(cause)}` };
  }
  try {
    // One write of a whole line. Two writes would let a concurrent hook's line
    // land between them, and a half line is a line nobody can read back.
    await handle.write(line);
  } catch (cause) {
    return { ok: false, reason: `cannot write to ${path}: ${String(cause)}` };
  } finally {
    await handle.close();
  }
  return { ok: true, path };
}

/** What a read back found. Counts only — the records themselves are flagged. */
export interface CapturedReport {
  readonly files: readonly string[];
  readonly lines: number;
  readonly records: number;
  /** Records dropped because their key had already been seen (AC7). */
  readonly duplicates: number;
  /** Lines that could not be read, by the one-word reason. */
  readonly skipped: Readonly<Record<string, number>>;
}

/**
 * Read every record back, de-duplicated by key.
 *
 * The de-duplication is not optional and not a flag. `S3.1 AC7` exists because
 * 5.3% of claude's transcript records appear in more than one file, and because
 * the hook and the seed both mint a key for the same tool call — so a seed run
 * after a week of capture would otherwise count that week twice. An action
 * counted twice is a preference invented.
 *
 * A missing directory is an empty result, not an error: "nothing has been
 * captured yet" and "everything captured has been purged" are the same fact on
 * disk, and both are things `observe status` has to be able to say.
 */
export async function readCaptured(observerPath: string): Promise<{
  readonly report: CapturedReport;
  readonly records: Personal<readonly CaptureRecord[]>;
}> {
  const dir = captureDir(observerPath);
  const kept: CaptureRecord[] = [];
  const seen = new Set<string>();
  const skipped = new Map<string, number>();
  const files: string[] = [];
  let lines = 0;
  let duplicates = 0;

  for (const name of await monthFiles(dir)) {
    const path = join(dir, name);
    files.push(path);
    const text = await Bun.file(path)
      .text()
      .catch(() => "");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      lines += 1;
      const parsed = parseRecord(line);
      if (!parsed.ok) {
        skipped.set(parsed.reason, (skipped.get(parsed.reason) ?? 0) + 1);
        continue;
      }
      if (seen.has(parsed.record.key)) {
        duplicates += 1;
        continue;
      }
      seen.add(parsed.record.key);
      kept.push(parsed.record);
    }
  }

  kept.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  return {
    report: {
      files,
      lines,
      records: kept.length,
      duplicates,
      skipped: Object.fromEntries(skipped),
    },
    // Flagged on the way out, and only here. Everything above is arithmetic
    // over the owner's data; what leaves is the data.
    records: flagPersonal(kept as readonly CaptureRecord[]),
  };
}

/** Keys already on disk, so a seed does not re-add what a hook already wrote. */
export async function capturedKeys(observerPath: string): Promise<Set<string>> {
  const keys = new Set<string>();
  const dir = captureDir(observerPath);
  for (const name of await monthFiles(dir)) {
    const text = await Bun.file(join(dir, name))
      .text()
      .catch(() => "");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const parsed = parseRecord(line);
      if (parsed.ok) keys.add(parsed.record.key);
    }
  }
  return keys;
}
