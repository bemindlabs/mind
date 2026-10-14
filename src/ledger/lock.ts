/**
 * The ledger's lock (D-145): one writer at a time, a wait instead of a refusal, and a dead writer's lock
 * broken only on evidence.
 *
 * ## Why it waits
 *
 * The lock used to be a bare `mkdir`, and a writer that found it taken threw at once. Every `turn` appends
 * after its answer has come back, so two turns that finished together raced for it, and the loser — whose
 * prompt had already gone to a vendor — exited "sent and not recorded". Measured on that code: two turns
 * with an instant stub lost a line in 10 rounds of 10; eight processes appending at once lost 7 of 8. A
 * ledger that drops lines exactly when it is busy is not a record of what was sent.
 *
 * So a writer that finds the lock taken waits for it: backoff from 5 ms doubling to 50 ms, jittered so that
 * waiters do not wake in step, for at most `waitMs` in total — 5 s when a turn asks before it sends
 * and for a line written before a send ({@link LOCK_TIMING}), a minute for a turn's line after its answer
 * ({@link RECORD_TIMING}). Only `EEXIST` is waited on.
 * Any other `mkdir` failure is thrown as it came, because "permission denied" is not "busy" and dressing it
 * up as a lock sends a person looking for a process that does not exist.
 *
 * ## What is on disk
 *
 * `<ledger dir>/.lock/owner.<uuid>.json` — `{"pid":…,"host":"…","started":"<ISO time>"}`, 600 in a 700
 * directory. The owner is written to a temporary name inside `.lock` and renamed, so a reader sees all of it
 * or none of it. After the rename the writer lists `.lock`: it holds the lock only if its own owner file is
 * the **only** thing there. Anything else means somebody else also believes they made this directory — see
 * the last section — and both step back.
 *
 * ## When a lock is stale — never guessed
 *
 * A lock is broken only on evidence:
 *
 * - its owner is on **this host** and gone: `kill(pid, 0)` says `ESRCH`, or the owner started before this
 *   machine last booted (a pid from before a boot can belong to anything now); or
 * - its owner has not been heard from for more than `maxAgeMs`, wherever it runs: not since it started, and
 *   not since its last heartbeat — a holder touches its owner file every quarter of `maxAgeMs` while it
 *   holds the lock, so a live long hold (a `forget` of a big ledger) never looks abandoned, and a process
 *   that is stopped or wedged stops touching it. That is the only rule for an owner on another host, whose
 *   pid means nothing here — and for every owner when the caller could not say which machine this is. The host name and boot time are handed in as {@link ThisMachine}, like every other
 *   fact about the machine (D-021); `ledgerEnv()` in `bin/shared.ts` is where they are read.
 * - Anything in `.lock` that is not a readable owner — an owner still being renamed into place, one a dead
 *   writer left half made, an empty `.lock` (a release older than D-145 holds its lock as an empty
 *   directory) — counts as stale only once it is older than `graceMs`.
 *
 * `EPERM` from `kill` is a live process of another user's, not a dead one. And something in the lock's way
 * that Mind did not make and cannot remove — a file where `.lock` should be, a directory inside it — is
 * never removed and never waited for: the writer stops at once and names it ({@link LedgerLocked} is only
 * for a lock somebody holds).
 *
 * ## Breaking a lock, when two waiters try at once
 *
 * The breaker unlinks the **owner file by its name**, then `rmdir`s `.lock`. The name is the owner's own
 * uuid, so of any number of waiters that judged the same owner stale exactly one unlink succeeds; the rest get
 * `ENOENT` and touch nothing. A late waiter — one that judged the old owner stale and was then descheduled
 * while somebody else broke it and took the lock — unlinks a name that is no longer there: the new holder's
 * file has another uuid. And `rmdir` removes only an empty directory, while a held lock always has its owner
 * file in it. Nothing here ever removes a lock it did not look inside first, and nothing is removed
 * recursively.
 *
 * The one directory that *can* be empty and still wanted is a lock between its `mkdir` and its owner — and
 * that is what the check after the rename is for. If a waiter removes it there, the writer's rename fails with
 * `ENOENT`, or lands in the next writer's directory beside that writer's owner; either way the listing shows
 * it is not alone, and it tries again. Mutual exclusion does not depend on `graceMs` at all
 * (`test/ledger/lock.test.ts` runs the race with it at zero); the grace period exists so that a writer is not
 * kicked out mid-`mkdir`, and so that an older Mind's empty directory is waited for rather than removed.
 */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rmdir, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STATE_DIR_MODE, STATE_FILE_MODE } from "../state.ts";

/** How long a writer waits, and when a lock is stale. All in milliseconds. */
export interface LockTiming {
  /** How long a writer waits for a lock that somebody alive holds before it gives up. */
  readonly waitMs: number;
  /** How old something in `.lock` that is not a readable owner must be before it is stale. */
  readonly graceMs: number;
  /** How old an owner must be before it is stale even when it cannot be seen to be gone. */
  readonly maxAgeMs: number;
}

/**
 * The numbers, measured rather than chosen (2026-09-29, bun 1.4.2, NVMe ext4). One append — open, write a
 * line, `fsync`, close — took 6.2 ms at the median and 15 ms at worst over 300. Eight processes appending at
 * the same instant: the last of them was done 140 ms later at the median of ten rounds, 242 ms at worst —
 * most of it spent in backoff, not on the disk.
 *
 * - **5 s wait.** Twenty times the worst eight-way round, and room for a disk whose `fsync` takes hundreds
 *   of milliseconds. A lock held longer than that by a live process is not an append — it is something
 *   stuck, and a turn should say so rather than hang. `canAppend` waits this long, so a lock held that long
 *   refuses a turn *before* its prompt is sent. After the send it is {@link RECORD_TIMING} instead.
 * - **2 s grace.** The gap it covers — `mkdir` to owner, or an older Mind's whole append — is under a
 *   millisecond to a few; two seconds is hundreds of times that, and short enough that a writer can clear a
 *   dead one's leftover inside one wait.
 * - **10 minutes max age.** A hundred thousand times one append, and longer than any `forget` of a real
 *   ledger. It only decides the cases the pid cannot: an owner on another host sharing this state
 *   directory, or a pid taken over by another process. Breaking a live lock by age lets two writers in — two
 *   appends still both land (`O_APPEND`), but a `forget` could replace a file under a line — so it is set
 *   where only a stuck process reaches it.
 */
export const LOCK_TIMING: LockTiming = { waitMs: 5_000, graceMs: 2_000, maxAgeMs: 10 * 60_000 };

/**
 * The wait for a line whose prompt has already gone — `RecordingExec`'s, after a backend answered, and no
 * other: **60 s**, everything else as {@link LOCK_TIMING}. A line written as a gate before something is sent
 * (chat, A2A) keeps `append`'s default 5 s: there, a long wait only stalls the send it guards.
 *
 * Before the send, giving up is cheap — the turn is refused and nothing has happened — so `canAppend` waits
 * 5 s and says so. After it, giving up loses the record of something that did happen, which is what the
 * ledger exists to prevent, and waiting longer costs only a slower exit. A hold that starts between the two
 * (another turn's `forget`, a slow disk) is waited out for twelve times as long. Longer than a minute and a
 * live holder is wedged; the line is reported as not recorded rather than the turn hanging for good.
 */
export const RECORD_TIMING: LockTiming = { ...LOCK_TIMING, waitMs: 60_000 };

/**
 * This machine, as the lock needs to know it: a name to tell its own owners from another host's, and when
 * it booted. The caller reads both; nothing under `src/` reads the machine for itself (D-021).
 */
export interface ThisMachine {
  readonly host: string;
  /** When this machine booted, in ms since the epoch. */
  readonly bootedAt: number;
}

const LOCK_DIR = ".lock";
const OWNER_FILE = /^owner\.[0-9a-f-]{36}\.json$/;

interface Owner {
  readonly pid: number;
  /** `null` when the writer could not say which machine it was on: judged by age alone, then. */
  readonly host: string | null;
  readonly started: string;
}

const ignore = (): undefined => undefined;

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function parseOwner(text: string): Owner | undefined {
  try {
    const value = JSON.parse(text) as Partial<Owner>;
    if (!Number.isInteger(value.pid) || (value.pid as number) <= 0) return undefined;
    // An empty host is still a host: reading a machine whose name is "" as unreadable would break its
    // live lock once the grace period was over.
    if (typeof value.host !== "string" && value.host !== null) return undefined;
    if (typeof value.started !== "string" || Number.isNaN(Date.parse(value.started))) return undefined;
    return value as Owner;
  } catch {
    return undefined;
  }
}

/**
 * How far before this boot an owner must have started to count as gone. A clock stepped after boot moves
 * a boot time worked out as "now minus uptime" by the step; a minute of slack keeps a small step from
 * making a live owner look older than the boot.
 */
const BOOT_SLACK_MS = 60_000;

/** Provably gone: on this host, and either started before this boot or not a process at all. */
function ownerGone(owner: Owner, machine: ThisMachine | undefined): boolean {
  if (machine === undefined || owner.host === null || owner.host !== machine.host) return false;
  if (Date.parse(owner.started) < machine.bootedAt - BOOT_SLACK_MS) return true;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    // EPERM is somebody else's live process. Only "no such process" means the owner is gone.
    return codeOf(error) === "ESRCH";
  }
}

/**
 * One attempt: the owner file's path if the lock is now this process's, `undefined` if somebody else has it.
 *
 * @throws the `mkdir` error itself for anything but `EEXIST`, and any error writing the owner but `ENOENT`.
 */
async function tryTake(lock: string, machine: ThisMachine | undefined): Promise<string | undefined> {
  try {
    await mkdir(lock, { mode: STATE_DIR_MODE });
  } catch (error) {
    if (codeOf(error) === "EEXIST") return undefined;
    throw error;
  }
  const name = `owner.${randomUUID()}.json`;
  const owner = join(lock, name);
  const temp = `${owner}.tmp`;
  const record: Owner = { pid: process.pid, host: machine?.host ?? null, started: new Date().toISOString() };
  try {
    await writeFile(temp, `${JSON.stringify(record)}\n`, { mode: STATE_FILE_MODE, flag: "wx" });
    await rename(temp, owner);
    const inside = await readdir(lock);
    if (inside.length === 1 && inside[0] === name) return owner;
  } catch (error) {
    // ENOENT: the directory went between the mkdir and here — a lost race, not a fault.
    if (codeOf(error) !== "ENOENT") {
      await stepBack(lock, temp, owner);
      throw error;
    }
  }
  await stepBack(lock, temp, owner);
  return undefined;
}

/** Take back what one attempt wrote. `rmdir` leaves a directory that still holds anybody else's owner. */
async function stepBack(lock: string, temp: string, owner: string): Promise<void> {
  await unlink(temp).catch(ignore);
  await unlink(owner).catch(ignore);
  await rmdir(lock).catch(ignore);
}

/**
 * What a writer found inside a lock it could not take. Both empty: it is free now (or was just broken).
 *
 * `live` is somebody entitled to it — an owner not proven gone, a writer still taking it — and passes.
 * `blocked` is something Mind did not make and will not remove, and passes only when a person moves it.
 */
interface Look {
  readonly live: readonly string[];
  readonly blocked: readonly string[];
}

/** Look inside a lock this process could not take, and break it if — and only if — it is stale. */
async function inspect(lock: string, timing: LockTiming, machine: ThisMachine | undefined): Promise<Look> {
  let names: string[];
  try {
    names = await readdir(lock);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return { live: [], blocked: [] };
    return { live: [], blocked: [`something that is not a lock Mind can read (${codeOf(error) ?? String(error)})`] };
  }

  const now = Date.now();
  const live: string[] = [];
  const blocked: string[] = [];
  let removed = 0;
  for (const name of names) {
    const path = join(lock, name);
    let owner: Owner | undefined;
    let modified: number;
    try {
      if (OWNER_FILE.test(name)) owner = parseOwner(await readFile(path, "utf8"));
      modified = (await lstat(path)).mtimeMs;
    } catch (error) {
      if (codeOf(error) === "ENOENT") continue; // released while we looked
      blocked.push(`${name}, which Mind cannot read (${codeOf(error) ?? String(error)})`);
      continue;
    }
    if (owner !== undefined) {
      // Heard from: when it started, or at its last heartbeat (the owner file's mtime), whichever is later.
      if (!ownerGone(owner, machine) && now - Math.max(Date.parse(owner.started), modified) <= timing.maxAgeMs) {
        live.push(`pid ${owner.pid} on ${owner.host ?? "a machine it did not name"}, since ${owner.started}`);
        continue;
      }
    } else if (now - modified <= timing.graceMs) {
      live.push("a writer that is still taking it");
      continue;
    }
    try {
      await unlink(path);
      removed++;
    } catch (error) {
      // ENOENT: another waiter broke it first, and the rmdir below is that waiter's to do.
      if (codeOf(error) !== "ENOENT") blocked.push(`${name}, which Mind cannot remove (${codeOf(error) ?? String(error)})`);
    }
  }
  if (live.length > 0 || blocked.length > 0) return { live, blocked };

  if (names.length === 0) {
    const made = await lstat(lock).then((info) => info.mtimeMs, ignore);
    if (made !== undefined && now - made <= timing.graceMs) return { live: ["a writer that is still taking it"], blocked: [] };
    if (made === undefined) return { live: [], blocked: [] };
  } else if (removed === 0) {
    return { live: [], blocked: [] };
  }
  await rmdir(lock).catch(ignore);
  return { live: [], blocked: [] };
}

/**
 * The lock was still held when the wait ran out — by somebody alive, as far as Mind can prove.
 *
 * Its own class so that a caller can tell "somebody else is writing" from "this cannot be written", which
 * call for opposite advice: the first passes, or clears by itself; the second needs a person to fix a path.
 */
export class LedgerLocked extends Error {
  constructor(
    readonly lock: string,
    /** Who holds it, as `inspect` described them; absent when it came free only as the wait ran out. */
    readonly holder: string | undefined,
    timing: LockTiming,
  ) {
    super(
      `ledger is locked (${lock})${holder === undefined ? "" : ` by ${holder}`}, and it was still held after ` +
        `${duration(timing.waitMs)}. Mind breaks a lock by itself only when its owner is gone from this machine ` +
        `or it is more than ${duration(timing.maxAgeMs)} old; if that process is stuck, stop it rather than ` +
        `removing the directory under it`,
    );
    this.name = "LedgerLocked";
  }
}

function backoff(attempt: number): number {
  return Math.min(50, 5 * 2 ** attempt) * (0.5 + Math.random());
}

function duration(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} minutes` : `${ms / 1000} s`;
}

/** Wait for the lock, breaking it if it is stale, until `timing.waitMs` has passed. */
async function take(lock: string, timing: LockTiming, machine: ThisMachine | undefined): Promise<string> {
  const deadline = Date.now() + timing.waitMs;
  for (let attempt = 0; ; attempt++) {
    const owner = await tryTake(lock, machine);
    if (owner !== undefined) return owner;
    const look = await inspect(lock, timing, machine);
    // Nothing Mind may remove is going to move by itself, so there is nothing to wait for.
    if (look.live.length === 0 && look.blocked.length > 0) {
      throw new Error(
        `the ledger's lock (${lock}) is blocked by ${look.blocked.join("; ")} — Mind did not make that and will ` +
          `not remove it; move it out of the way`,
      );
    }
    const holder = look.live.length > 0 ? look.live.join("; ") : undefined;
    if (Date.now() >= deadline) throw new LedgerLocked(lock, holder, timing);
    // Nothing to wait for when the look just found it free, or broke it.
    if (holder !== undefined) await new Promise((resolve) => setTimeout(resolve, backoff(attempt)));
  }
}

/**
 * Hold the lock of the directory `dir` for the duration of `body`, waiting for it first.
 *
 * `machine` is this machine's name and boot time. Without it this writer's own owner file names no host,
 * and every lock it finds is judged by age alone — never broken sooner for want of knowing where it is.
 *
 * @throws {LedgerLocked} naming the lock and its holder when it was still held after `timing.waitMs`.
 * @throws {Error} at once when something Mind did not make is in the lock's way, naming it.
 * @throws the filesystem's own error, unchanged, for anything that is not the lock being held.
 */
export async function withLock<T>(
  dir: string,
  body: () => Promise<T>,
  timing: LockTiming = LOCK_TIMING,
  machine?: ThisMachine,
): Promise<T> {
  const lock = join(dir, LOCK_DIR);
  const owner = await take(lock, timing, machine);
  // The heartbeat. `utimes` on the owner file's own name: if the lock was broken, the name is gone and this
  // fails quietly — it can never bring back an owner file, and never touches anybody else's. The period is
  // clamped because a timer's delay past 2^31 - 1 ms is taken as 1 ms, which would make this a busy loop.
  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(owner, now, now).catch(ignore);
  }, Math.min(Math.max(timing.maxAgeMs / 4, 10), 2_147_483_647));
  heartbeat.unref();
  try {
    return await body();
  } finally {
    clearInterval(heartbeat);
    // Only this process's owner file. If it is gone, the lock was broken by age and is somebody else's now.
    await unlink(owner).then(() => rmdir(lock).catch(ignore), ignore);
  }
}
