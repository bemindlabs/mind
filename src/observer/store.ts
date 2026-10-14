/**
 * Where what the owner actually did is kept, and how all of it goes away.
 *
 * ## The address (AC1), and why it moved
 *
 * D-014 sketched observer data under `.mind/observer/`, on the understanding
 * that E3 would mine it back out of vendor transcripts whenever it was needed.
 * SP-1 measured those transcripts and D-024 changed the epic: claude keeps
 * seven weeks and grok keeps eleven days, so E3 captures **at the moment
 * something happens** and the capture is the only copy there will ever be.
 *
 * That makes the old address wrong, for the same reason ADR 0002 §3 gives for
 * the ledger: `.mind/` holds only what a derivation register can rebuild, and a
 * rebuild *sweeps out* everything else. This is not a theory —
 * `test/agent/rebuild.test.ts` has asserted since S0.3 that a rebuild deletes
 * `.mind/observer/raw.jsonl` and names it while doing so. Capture into that
 * directory would have been a feature whose data the next `mind rebuild`
 * silently removed.
 *
 * Git is not the answer either. A record of what a person did, minute by
 * minute, is the most withdrawable thing Mind will ever hold (I-4), and git
 * remembers what it is asked to forget.
 *
 * So, proposed as **D-025** and decided by the owner before this file was
 * written: **raw capture is personal by default**, and it lives at exactly one
 * address —
 *
 *     $XDG_DATA_HOME/mind/<subject>/personal/observer/
 *
 * which is {@link observerDir}, built on `personalDir` (S0.4) rather than
 * beside it. Three properties come with that and none of them is re-implemented
 * here: the path is refused outright if it resolves inside a git repository,
 * the pre-commit scan blocks anything staged under a `personal/` directory, and
 * the tree is created 0700.
 *
 * The intended consequence: everything that reads observer data is reading
 * something flagged personal, so it is on the far side of `Personal<T>` and
 * `runPersonal` (`src/exec/local.ts`) — which is what S3.2 AC4 was waiting for
 * when it said "or wait for a local model after S3.5".
 *
 * ## No network, and nothing that could become one (AC2)
 *
 * Nothing under `src/observer/` may import `src/spawn.ts` or anything in
 * `src/exec/`. A subprocess is a network stack with extra steps, so the rule
 * that keeps this path local is "it cannot start one", not "it does not call
 * fetch". Getting there cost one refactor: `enclosingGitRepo` used to live in
 * `src/agent/new.ts`, which runs `git init`, so merely asking "is this inside
 * git?" pulled the chokepoint into the closure. It is `src/agent/repo.ts` now.
 *
 * `test/observer/no-network.test.ts` and `test/observer/no-socket.test.ts`
 * check that three ways — AST over the closure, traps inside the process, and
 * `strace` over the real CLI — each with a control that proves the check bites.
 *
 * ## Counting rather than parsing (AC3)
 *
 * {@link census} counts files, lines and bytes and never parses a record. That
 * is deliberate: w4 owns the capture schema and has not written it yet, and a
 * purge that understood the schema would be a purge that stopped working — and
 * stopped deleting — on the day the schema changed. Bytes are bytes.
 */

import { lstat, mkdir, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ensurePersonalDir, personalDir, type PersonalDir, type PersonalEnv } from "../guard/personal.ts";
import { mediaUndeletable, STATE_DIR_MODE } from "../state.ts";
import type { SubjectId } from "../types.ts";

/** The machine facts the observer may see — all of them arguments, as ever. */
export type ObserverEnv = PersonalEnv;

/** The directory name under a subject's personal directory. One word, declared once. */
export const OBSERVER_DIR = "observer";

/**
 * `personalDir(subject)/observer/`, if that is outside git — resolved, not created.
 *
 * Split from {@link ensureObserverDir} for the reason `personalDir` is split:
 * `observe status` prints a path and must not bring it into existence by being
 * asked where it would be.
 */
export async function observerDir(env: ObserverEnv, subject: SubjectId): Promise<PersonalDir> {
  const parent = await personalDir(env, subject);
  if (!parent.ok) return parent;
  return { ok: true, path: join(parent.path, OBSERVER_DIR) };
}

/**
 * Evidence that {@link OBSERVER_UNDELETABLE} was written somewhere before a
 * capture directory came into existence.
 *
 * S7.2 AC4 says the things that cannot be deleted must be disclosed *first* —
 * "ไม่ใช่มารู้ตอนขอลบ". For the observer, "first" means before the data exists
 * at that address, and the moment it comes into existence is
 * {@link ensureObserverDir}. So the notice is a **value that function requires**
 * rather than a step a future caller is asked to remember: w4 cannot create the
 * capture tree without having called {@link announceCapture}, because there is
 * no other way to obtain one of these, and `tsc` says so.
 *
 * Same shape as `asLocal()`/`runPersonal()` in `src/exec/local.ts`: a brand
 * minted by exactly one constructor, and an AST gate
 * (`test/observer/capture-notice.test.ts`) that refuses `as CaptureNotice`
 * outside this file — a cast would turn the check off in one keystroke with
 * nothing in review to catch the eye.
 *
 * **What it proves, and what it does not.** It proves the function ran and the
 * lines were handed to a writer. It does not prove a human read them, and no
 * type can. That limit is stated in {@link OBSERVER_LIMITS} rather than left
 * for a reader to work out.
 */
declare const ANNOUNCED: unique symbol;

/** Proof that the capture notice was printed. Mint via {@link announceCapture}. */
export type CaptureNotice = { readonly [ANNOUNCED]: "observer-undeletable-announced" };

/** Heading the capture notice is printed under. One copy, asserted by test. */
export const CAPTURE_NOTICE_HEADING =
  "Before anything is captured, what deleting it afterwards cannot reach:";

/**
 * Write the undeletable list, and hand back the proof that it was written.
 *
 * @param write Where the lines go — `console.log`, a log file, a test's array.
 *   Mind does not choose the channel, only that there was one.
 */
export function announceCapture(write: (line: string) => void): CaptureNotice {
  write(CAPTURE_NOTICE_HEADING);
  for (const note of OBSERVER_UNDELETABLE) write(`  - ${note}`);
  // An empty frozen object, branded on the way out. `ANNOUNCED` is a `declare
  // const` and therefore does not exist at run time, exactly as the brand on
  // `LocalBackend` does not: the value carries nothing, and the guarantee is
  // that `tsc` will not let one be produced anywhere but here.
  return Object.freeze({}) as CaptureNotice;
}

/**
 * The same directory, created 0700 under a personal directory created 0700.
 *
 * Takes a {@link CaptureNotice}, which is the whole of AC4 for this address:
 * the tree that holds a record of what somebody did cannot be brought into
 * existence by code that has not first said what deleting it will not reach.
 */
export async function ensureObserverDir(
  env: ObserverEnv,
  subject: SubjectId,
  notice: CaptureNotice,
): Promise<PersonalDir> {
  // Required at the type level and deliberately unused at run time: the value
  // carries no information beyond "announceCapture produced me", and reading a
  // field off it would invite somebody to fabricate the field instead.
  void notice;
  const parent = await ensurePersonalDir(env, subject);
  if (!parent.ok) return parent;
  const path = join(parent.path, OBSERVER_DIR);
  await mkdir(path, { recursive: true, mode: STATE_DIR_MODE });
  return { ok: true, path };
}

/** What is under the declared path right now. Bytes and lines, never records. */
export interface Census {
  /** Regular files, at any depth. */
  readonly files: number;
  /** Newline-terminated lines, plus one for a final line with no newline. */
  readonly lines: number;
  readonly bytes: number;
  /** Directories below the root, deepest last is not guaranteed; see {@link commitPurge}. */
  readonly directories: readonly string[];
  /** Every regular file and symlink found, absolute. */
  readonly paths: readonly string[];
  /**
   * Symlinks found under the root.
   *
   * Counted apart because a purge unlinks the link and not whatever it points
   * at, and "everything is gone" would be false about the target. They are
   * named in the output rather than followed: following one would let a purge
   * delete outside the path AC1 declares.
   */
  readonly symlinks: readonly string[];
}

/**
 * Count what is there.
 *
 * A missing directory is zero, not an error: "nothing has been captured yet"
 * and "everything captured has been purged" are the same fact on disk, and
 * both are things `observe status` has to be able to say.
 *
 * Lines are counted from the bytes — `0x0a` occurrences, plus one when the
 * last byte is not a newline. Nothing is decoded and nothing is parsed, so a
 * half-written record from an interrupted capture still counts as the line it
 * is rather than throwing on the way past (AC3, and w4's schema is its own).
 */
export async function census(root: string): Promise<Census> {
  let files = 0;
  let lines = 0;
  let bytes = 0;
  const directories: string[] = [];
  const paths: string[] = [];
  const symlinks: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks.push(path);
        paths.push(path);
        files++;
        continue;
      }
      if (entry.isDirectory()) {
        directories.push(path);
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;

      files++;
      paths.push(path);
      const data = new Uint8Array(await Bun.file(path).arrayBuffer());
      bytes += data.byteLength;
      let newlines = 0;
      for (const byte of data) if (byte === 0x0a) newlines++;
      lines += newlines + (data.byteLength > 0 && data[data.byteLength - 1] !== 0x0a ? 1 : 0);
    }
  };

  await walk(root);

  return { files, lines, bytes, directories, paths, symlinks };
}

/** What a purge would remove, worked out before anything is removed. */
export interface PurgePlan {
  readonly subject: SubjectId;
  readonly dir: string;
  readonly before: Census;
}

/** Why a purge cannot be planned at all. Nothing has been touched when this is returned. */
export interface PurgeRefused {
  readonly ok: false;
  readonly path: string;
  readonly reason: string;
}

/**
 * Work out what would go, touching nothing.
 *
 * Refuses when the observer directory is itself a symlink. A purge is a promise
 * about a named tree, and following a link would either delete something
 * outside the address AC1 declares or leave the real data untouched while
 * reporting zero — and reporting a truthful-looking zero is worse than
 * refusing.
 */
export async function planPurge(
  env: ObserverEnv,
  subject: SubjectId,
): Promise<PurgePlan | PurgeRefused> {
  const dir = await observerDir(env, subject);
  if (!dir.ok) return { ok: false, path: dir.path, reason: dir.reason };
  return planPurgeDir(subject, dir.path);
}

/**
 * The same plan, over a directory the caller names.
 *
 * Factored out for `mind erase` (S7.2), which has four trees to remove and
 * needs the same three properties for each of them: a plan taken before
 * anything is touched, a commit that takes no environment, and a recount read
 * back off the filesystem afterwards. A second walker in `src/erase/` would
 * have been a second answer to "is it really gone?", and the one in this file
 * is the one with a control behind it (`test/observer/purge.test.ts`).
 *
 * The symlink refusal travels with it, and has to: erase points this at
 * `personalDir(subject)` and at the backup tree, and a link in either place
 * would let a deletion reach outside the path the certificate names.
 */
export async function planPurgeDir(
  subject: SubjectId,
  dir: string,
): Promise<PurgePlan | PurgeRefused> {
  const top = await lstat(dir).catch(() => undefined);
  if (top !== undefined && top.isSymbolicLink()) {
    return {
      ok: false,
      path: dir,
      reason:
        `${dir} is a symlink. Purging through it would either delete outside the one ` +
        `declared path or count zero while the data sits somewhere else — replace it with a ` +
        `real directory, or move the data yourself.`,
    };
  }

  return { subject, dir, before: await census(dir) };
}

/** What a purge did, and — the part that matters — what is left afterwards. */
export interface PurgeResult {
  readonly removed: readonly string[];
  /** Files that survived, with the reason the filesystem gave. */
  readonly failed: readonly { readonly path: string; readonly reason: string }[];
  /** Counted again, from disk, after the deletions. I-4's "ลบแล้วค้นไม่เจอ". */
  readonly remaining: Census;
  /** True when the observer directory itself is gone. */
  readonly dirRemoved: boolean;
}

/**
 * Carry out a plan, then count again.
 *
 * The second count is the whole of AC3 and it is taken from the filesystem
 * rather than from the list of unlinks that succeeded. A purge that reported
 * "0 remaining" because it had subtracted its own successes from its own plan
 * would be arithmetic, not evidence; a purge that reads the tree back cannot
 * be wrong about a file it failed to delete and did not notice.
 *
 * Takes no {@link ObserverEnv}: everything it needs is in the plan, so a commit
 * cannot run somewhere the plan never looked.
 */
export async function commitPurge(plan: PurgePlan): Promise<PurgeResult> {
  const removed: string[] = [];
  const failed: { path: string; reason: string }[] = [];

  for (const path of plan.before.paths) {
    try {
      await unlink(path);
      removed.push(path);
    } catch (cause) {
      failed.push({ path, reason: String(cause) });
    }
  }

  // Deepest first, so a directory is only tried once its contents are gone.
  // `rmdir` rather than a recursive remove: a directory that is not empty is
  // Mind having miscounted, and the right move then is to leave the evidence
  // where it is and let the recount say so.
  for (const dir of [...plan.before.directories].sort((a, b) => b.length - a.length)) {
    await rmdir(dir).catch(() => undefined);
  }
  const dirRemoved = await rmdir(plan.dir).then(
    () => true,
    () => false,
  );

  return { removed, failed, remaining: await census(plan.dir), dirRemoved };
}

/**
 * What a purge cannot reach — printed every time, including on a dry run and
 * on a run that found nothing to delete.
 *
 * The first two lines are the medium's, shared with `ledger forget` through
 * {@link mediaUndeletable}: one copy of those words, not two. The rest are
 * this path's own, and every one of them is something an owner would
 * reasonably assume `observe purge --subject <id>` had handled.
 */
export const OBSERVER_UNDELETABLE: readonly string[] = [
  ...mediaUndeletable("these records", "the data directory"),
  "anything already derived from these records and written somewhere else — actions committed " +
    "to the agent's git repository are the case that exists today, and `mind guard status` " +
    "prints what git keeps whatever you delete later. An embedding or a fine-tuned weight is " +
    "the same kind of thing and is worse: `WEIGHTS_UNDELETABLE` in src/erase/places.ts holds " +
    "that list, `mind new` prints it before the first capture, and neither Mind nor anyone " +
    "else can subtract one person's records from a trained adapter.",
  "the vendor transcripts a seed was read from. They are the vendors' files in the vendors' own " +
    "directories (for example ~/.claude/projects/*.jsonl); Mind does not touch them and cannot " +
    "delete them for you.",
  "whatever another process running as this user already read. Mode 0700 keeps other accounts " +
    "out; it is not a boundary against a vendor CLI with its own tools and the same uid.",
  "the target of any symlink found under this directory. The link is removed, what it pointed " +
    "at is not — it was never inside the one path this command is about.",
];

/**
 * The size of what AC2 and AC4 actually prove — printed beside the counts.
 *
 * Written here rather than only in a document for the same reason
 * `GUARD_LIMITS` is: an acceptance criterion that promises more than it checks
 * gets ticked, and then the tick is what people read.
 */
export const OBSERVER_LIMITS: readonly string[] = [
  "AC2 is about Mind's code: nothing reachable from src/observer/ can open a socket or start " +
    "a process, checked over the import graph, with traps inside the process, and with strace " +
    "over the real CLI. It is not the claim that observer data cannot leave this machine — a " +
    "vendor CLI running as this user can read these files and has its own tools.",
  "AC3 is about this path. `remaining: 0` is counted from disk after the deletions and means " +
    "the declared directory is empty — it says nothing about copies that were derived and " +
    "written elsewhere, which is why the list above is printed every time.",
  "AC4 is about one door. A Personal<T> reaches a backend only through runPersonal(), which " +
    "takes only a backend asLocal() minted, which takes only an ollama on a loopback literal. " +
    "Loopback is not the same as local, and the flag does not survive being unwrapped.",
  "the capture notice proves a call, not a reading. ensureObserverDir() cannot be reached " +
    "without announceCapture() having written the list above to somewhere, which is a fact about " +
    "this program. Whether a human read it is not a thing any type can check, and Mind does " +
    "not claim it.",
];
