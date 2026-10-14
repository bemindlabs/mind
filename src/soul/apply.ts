/**
 * Writing an identity into files that belong to somebody else.
 *
 * Split into two functions that do not call each other. {@link planApply}
 * reads and decides; {@link commitApply} writes. A dry run — which is the
 * default (AC2) — is literally the absence of the second call, not a flag
 * threaded through a function that also knows how to write. There is no code
 * path where a mistake in argument handling turns a preview into a write.
 *
 * Everything this module knows about the machine arrives as an argument: home,
 * environment, clock, PATH lookup. That is not general-purpose tidiness. The
 * files at stake are the operator's live instruction files, read by the CLI
 * that is probably running this code, and a test that resolved the real `$HOME`
 * would be one typo away from editing them.
 *
 * What is protected, and how:
 *
 * - **A human's own text survives every write.** Before writing, the bytes
 *   outside Mind's block in the *new* text are compared with the bytes
 *   outside the block in the text on disk. Not similar — equal. Anything else
 *   is refused with no write attempted (AC4).
 * - **The previous file is kept.** Every file that existed is copied, byte for
 *   byte, under a timestamped backup directory with a manifest, and the
 *   command to put it back is printed. S1.5 will automate that; until then a
 *   human with `cp` can undo this (backlog §7: *ห้ามตัด AC นี้*).
 * - **Nothing is written on a stale read.** The plan records a hash of each
 *   file; the commit re-reads and refuses the whole batch if any of them moved
 *   between the two. Another tool writing the same file mid-run is ordinary
 *   here, not exotic.
 * - **Switching identity leaves no residue.** Each file holds one block, so
 *   applying subject B replaces subject A's block whole, and the report names
 *   whose identity was displaced (AC5, D-011).
 */

import { chmod, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stateRoot } from "../state.ts";
import type { SubjectId } from "../types.ts";
import { sha256, splice, strip } from "./block.ts";
import { diffStat, unifiedDiff, type DiffStat } from "./diff.ts";
import { renderIssues, renderSoul } from "./render.ts";
import type { Soul, SoulIssue } from "./schema.ts";
import type { FileTarget, Target } from "./targets.ts";

/**
 * Schema tag of the manifest each apply writes beside its backups. Nothing compares it: `soul revoke` and
 * `erase` read the `files` list.
 */
export const APPLY_BACKUP_SCHEMA = "mind/soul-apply-backup@1";

/** Mode for a file Mind creates. Identity text is not world-readable. */
const NEW_FILE_MODE = 0o600;
/** Mode for directories Mind creates, including the backup tree. */
const NEW_DIR_MODE = 0o700;

/** What will happen to one target. */
export type PlanAction =
  /** The file does not exist; Mind will create it holding only its block. */
  | "create"
  /** The file exists and has no block; one will be appended. */
  | "insert"
  /** A block is there already and will be replaced. */
  | "replace"
  /** The file already says exactly this. Nothing to write. */
  | "unchanged"
  /** The vendor's CLI is not installed, and the operator did not name it. */
  | "skipped"
  /** Something about the file means Mind will not touch it. */
  | "refused"
  /** Not a file at all: delivered on each request instead. */
  | "system-field";

/** The decision for one target, and the evidence behind it. */
export interface TargetPlan {
  readonly target: Target;
  readonly action: PlanAction;
  /** Why, for `skipped`, `refused`, and `system-field`. */
  readonly reason?: string;
  /** Whose identity this write displaces, when it is not the same subject. */
  readonly replacedSubject?: SubjectId;
  /** Unified diff of what is on disk against what would be written. */
  readonly diff: string;
  readonly stat: DiffStat;
  readonly existed: boolean;
  /** sha256 of the bytes read, or the empty string when there was no file. */
  readonly beforeSha: string;
  /** The whole next file. Present only for actions that write. */
  readonly next?: string;
  /** Permission bits to preserve, or {@link NEW_FILE_MODE} for a new file. */
  readonly mode: number;
}

/** A whole run, planned but not performed. */
export interface ApplyPlan {
  readonly subject: SubjectId;
  /** The identity text, identical for every target. */
  readonly rendered: string;
  readonly plans: readonly TargetPlan[];
  /** Where {@link commitApply} would put the originals. */
  readonly backupDir: string;
  /** Reasons the soul itself cannot be rendered. Non-empty means: write nothing. */
  readonly issues: readonly SoulIssue[];
}

/** Everything `apply` is allowed to know about this machine. */
export interface ApplyEnv {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Injected so a backup directory name is reproducible in a test. */
  readonly now: () => Date;
  /**
   * Backends the operator named on the command line.
   *
   * A vendor CLI that is not installed is skipped by default — writing an
   * identity for a program that is not there is noise. But when someone names
   * it explicitly, they mean it: the file is often read by a CLI installed
   * later, or in a container built from this home.
   */
  readonly explicit: ReadonlySet<string>;
}

/**
 * `20260920T143012789Z` — sortable, UTC, safe as a directory name.
 *
 * Milliseconds are in there so two runs cannot land in the same directory and
 * quietly overwrite each other's originals. `commitApply` refuses a directory
 * that already holds a manifest rather than relying on that alone.
 */
function stamp(when: Date): string {
  return when.toISOString().replace(/[-:.]/g, "");
}

/**
 * Where originals are kept: outside the repo, outside the vendors' directories.
 *
 * The XDG part of that answer is `stateRoot`'s, not this file's — the ledger
 * (S2.2) has to land under the same root, and two copies of the rule would be
 * one typo away from a tree `mind erase` never visits.
 */
export function backupRoot(env: ApplyEnv, subject: SubjectId): string {
  return join(stateRoot(env.home, env.env), "backups", subject, stamp(env.now()));
}

type FileRead =
  | { readonly ok: true; readonly existed: boolean; readonly text: string; readonly mode: number; readonly sha: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Read a target file as text, refusing anything Mind cannot faithfully rewrite.
 *
 * The round-trip check is the point. Mind works in strings; if decoding and
 * re-encoding the file does not give the original bytes back — invalid UTF-8,
 * a byte-order mark, a lone surrogate — then writing the string back would
 * silently rewrite parts of the file nobody asked it to touch.
 */
async function readTarget(path: string): Promise<FileRead> {
  let mode = NEW_FILE_MODE;
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return { ok: false, reason: `not a regular file` };
    }
    mode = info.mode & 0o777;
  } catch {
    return { ok: true, existed: false, text: "", mode: NEW_FILE_MODE, sha: "" };
  }

  const bytes = await Bun.file(path).bytes();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "not valid UTF-8 — Mind will not rewrite a file it cannot read as text" };
  }
  const roundTrip = new TextEncoder().encode(text);
  if (roundTrip.length !== bytes.length || !roundTrip.every((byte, index) => byte === bytes[index])) {
    return {
      ok: false,
      reason: "does not survive a UTF-8 round trip (a byte-order mark, or an unpaired surrogate) — " +
        "rewriting it would change bytes outside Mind's block",
    };
  }

  return { ok: true, existed: true, text, mode, sha: sha256(bytes) };
}

function planFor(
  target: Target,
  subject: SubjectId,
  rendered: string,
  read: FileRead,
  reachable: boolean,
  explicit: boolean,
): TargetPlan {
  const empty = { target, diff: "", stat: { added: 0, removed: 0 }, existed: false, beforeSha: "", mode: NEW_FILE_MODE };

  if (target.kind === "system-field") {
    return {
      ...empty,
      action: "system-field",
      reason: "no instruction file at any scope — the identity travels in the system field of each request",
    };
  }

  if (!reachable && !explicit) {
    return {
      ...empty,
      action: "skipped",
      reason: `${target.backend} is not on PATH — name it with --backend to write the file anyway`,
    };
  }

  if (!read.ok) return { ...empty, action: "refused", reason: read.reason };

  const before = read.text;
  const humanBefore = strip(before);
  if (humanBefore.kind === "refused") {
    return { ...empty, existed: read.existed, beforeSha: read.sha, mode: read.mode, action: "refused", reason: humanBefore.reason };
  }

  const spliced = splice(before, { subject, body: rendered });
  if (spliced.kind === "refused") {
    return { ...empty, existed: read.existed, beforeSha: read.sha, mode: read.mode, action: "refused", reason: spliced.reason };
  }

  // The promise of AC4, checked rather than argued: everything outside the
  // block is the same before and after, to the byte.
  const humanAfter = strip(spliced.next);
  if (humanAfter.kind === "refused" || humanAfter.text !== humanBefore.text) {
    return {
      ...empty,
      existed: read.existed,
      beforeSha: read.sha,
      mode: read.mode,
      action: "refused",
      reason:
        "the write would change text outside Mind's block — refusing. This is a bug in Mind, " +
        "not in your file; please report it with the file's first and last few lines.",
    };
  }

  if (spliced.next === before) {
    return { ...empty, existed: read.existed, beforeSha: read.sha, mode: read.mode, action: "unchanged" };
  }

  const label = target.path;
  return {
    target,
    action: read.existed ? spliced.action : "create",
    diff: unifiedDiff(before, spliced.next, { beforeLabel: `a${label}`, afterLabel: `b${label}` }),
    stat: diffStat(before, spliced.next),
    existed: read.existed,
    beforeSha: read.sha,
    next: spliced.next,
    mode: read.mode,
    ...(spliced.replacedSubject === undefined ? {} : { replacedSubject: spliced.replacedSubject }),
  };
}

/**
 * Decide what would happen, touching nothing.
 *
 * Read-only by construction: the only filesystem calls below are `stat` and
 * `read`. This is what `--dry-run` runs, and it is also the first half of what
 * `--apply` runs, so the preview and the write can never disagree about what
 * was planned.
 */
export async function planApply(
  soul: Soul,
  targets: readonly Target[],
  env: ApplyEnv,
): Promise<ApplyPlan> {
  const issues = renderIssues(soul);
  const backupDir = backupRoot(env, soul.subject);
  if (issues.length > 0) {
    return { subject: soul.subject, rendered: "", plans: [], backupDir, issues };
  }

  const rendered = renderSoul(soul);
  const plans: TargetPlan[] = [];

  for (const target of targets) {
    if (target.kind === "system-field") {
      plans.push(planFor(target, soul.subject, rendered, { ok: true, existed: false, text: "", mode: NEW_FILE_MODE, sha: "" }, true, true));
      continue;
    }
    const explicit = env.explicit.has(target.backend);
    const read =
      target.reachable || explicit
        ? await readTarget(target.path)
        : ({ ok: true, existed: false, text: "", mode: NEW_FILE_MODE, sha: "" } as const);
    plans.push(planFor(target, soul.subject, rendered, read, target.reachable, explicit));
  }

  return { subject: soul.subject, rendered, plans, backupDir, issues: [] };
}

/** True when this plan would change a file. */
export function writesFile(plan: TargetPlan): boolean {
  return plan.next !== undefined;
}

/** One file that was written, and how to put it back. */
export interface WriteRecord {
  readonly path: string;
  readonly backend: string;
  readonly action: PlanAction;
  /** Absent when the file did not exist before: there is nothing to restore. */
  readonly backupPath?: string;
  /** A command a human can paste to undo this one file. */
  readonly restore: string;
}

/**
 * Why a run wrote nothing, for the three reasons that are not the same reason.
 *
 * odd2's H10 asked for `ok: false` when a plan writes nothing, and that is the
 * wrong repair: writing nothing is the **ordinary** outcome of applying the
 * same soul twice, and it is the only outcome on a machine whose one backend is
 * ollama, where the identity travels in the system field and there is no file
 * to write. Failing either of those would punish the local route, which I-1
 * exists to protect.
 *
 * The lie that was reachable was a sentence, not an exit code: `soul apply`
 * printed *"Nothing to write — every target already holds this identity"* for
 * every run that wrote nothing, including runs where every target was skipped
 * for being off PATH and runs where every target was refused. "There was
 * nothing to write" and "every target is current" are different facts, and the
 * command was printing the reassuring one for both.
 */
export type CommitOutcome =
  /** At least one file was written. */
  | "wrote"
  /** Nothing to write because every writable target already holds this soul. */
  | "already-current"
  /** Nothing to write because no target could be written at all. */
  | "nothing-applicable";

/** What `commitApply` did, or declined to do. */
export interface CommitResult {
  /**
   * Nothing was refused.
   *
   * Deliberately **not** "something was written": see {@link CommitOutcome} for
   * why a run that writes nothing is an ordinary success, and {@link outcome}
   * for the field that says which kind of nothing it was.
   */
  readonly ok: boolean;
  /** Which of the three things happened. */
  readonly outcome: CommitOutcome;
  /** Absent when nothing needed writing. */
  readonly backupDir?: string;
  readonly written: readonly WriteRecord[];
  /** Targets that changed under us, or could not be written. */
  readonly refused: readonly { readonly path: string; readonly reason: string }[];
}

/**
 * Which kind of "nothing was written" this plan is.
 *
 * `unchanged` is the only action that means *this target holds this soul right
 * now* — `planFor` returns it after reading the file and comparing the bytes.
 * `skipped`, `refused` and `system-field` all reach the same empty write list
 * by other roads, and none of them is evidence that an identity is in place.
 */
function outcomeOf(plan: ApplyPlan): Exclude<CommitOutcome, "wrote"> {
  return plan.plans.some((item) => item.action === "unchanged")
    ? "already-current"
    : "nothing-applicable";
}

/** One entry in the backup manifest — enough to restore without Mind. */
interface ManifestEntry {
  readonly path: string;
  readonly backend: string;
  readonly existedBefore: boolean;
  readonly sha256: string;
  readonly mode: string;
  readonly backup?: string;
  readonly symlinkedFrom?: string;
}

/**
 * Perform the plan.
 *
 * Verifies every target first and writes nothing at all if any of them moved
 * since the plan was made. A run that half-applies an identity is worse than
 * one that applies none of it: `verify` would then measure a machine that is
 * in neither state.
 */
export async function commitApply(plan: ApplyPlan, env: ApplyEnv): Promise<CommitResult> {
  const pending = plan.plans.filter(writesFile);
  // `ok: true` and it stays `true`: nothing was refused, and there was nothing
  // to write. What changes is that the caller is now told *which* nothing this
  // was, instead of being left to read it as "every target is current".
  if (pending.length === 0) return { ok: true, outcome: outcomeOf(plan), written: [], refused: [] };

  // Pre-flight: re-read everything, refuse the batch on any surprise.
  const refused: { path: string; reason: string }[] = [];
  for (const item of pending) {
    const target = item.target as FileTarget;
    const now = await readTarget(target.path);
    if (!now.ok) {
      refused.push({ path: target.path, reason: now.reason });
      continue;
    }
    if (now.sha !== item.beforeSha) {
      refused.push({
        path: target.path,
        reason: "changed on disk since the diff above was computed — nothing was written; run again to see the new diff",
      });
    }
  }
  if (refused.length > 0) return { ok: false, outcome: "nothing-applicable", written: [], refused };

  const backupDir = plan.backupDir;
  const manifestPath = join(backupDir, "manifest.json");
  if (await Bun.file(manifestPath).exists()) {
    return {
      ok: false,
      outcome: "nothing-applicable",
      written: [],
      refused: [{ path: backupDir, reason: "a backup already exists here — refusing to write over previous originals" }],
    };
  }
  await mkdir(backupDir, { recursive: true, mode: NEW_DIR_MODE });

  const written: WriteRecord[] = [];
  const manifest: ManifestEntry[] = [];

  for (const [index, item] of pending.entries()) {
    const target = item.target as FileTarget;
    const next = item.next!;

    let backupPath: string | undefined;
    if (item.existed) {
      backupPath = join(backupDir, `${index + 1}-${basename(target.path)}`);
      const original = await Bun.file(target.path).bytes();
      await writeFile(backupPath, original, { mode: NEW_FILE_MODE });
    }

    await mkdir(dirname(target.path), { recursive: true, mode: NEW_DIR_MODE });
    const temp = `${target.path}.mind-${process.pid}-${index}.tmp`;
    await writeFile(temp, next, { mode: item.mode });
    await chmod(temp, item.mode);
    await rename(temp, target.path);

    manifest.push({
      path: target.path,
      backend: target.backend,
      existedBefore: item.existed,
      sha256: item.beforeSha,
      mode: item.mode.toString(8).padStart(3, "0"),
      ...(backupPath === undefined ? {} : { backup: basename(backupPath) }),
      ...(target.symlinkedFrom === undefined ? {} : { symlinkedFrom: target.symlinkedFrom }),
    });

    written.push({
      path: target.path,
      backend: target.backend,
      action: item.action,
      ...(backupPath === undefined ? {} : { backupPath }),
      restore:
        backupPath === undefined
          ? `rm ${shellQuote(target.path)}   # Mind created this file; it did not exist before`
          : `cp ${shellQuote(backupPath)} ${shellQuote(target.path)}`,
    });
  }

  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schema: APPLY_BACKUP_SCHEMA,
        subject: plan.subject,
        createdAt: env.now().toISOString(),
        files: manifest,
      },
      null,
      2,
    )}\n`,
    { mode: NEW_FILE_MODE },
  );

  return { ok: true, outcome: "wrote", backupDir, written, refused: [] };
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Quote a path for a shell, so the printed restore command works as printed. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Where the identity actually goes, said plainly.
 *
 * Two of the three phase-A backends are cloud CLIs, and text placed in their
 * instruction files is uploaded with every turn they take. Nothing in the
 * system is flagged `personal` yet — the backlog's hard stop keeps it that way
 * until S0.4 and S3.5 land — but the person running this command should not
 * have to infer where their words are about to travel (I-6).
 */
export function egressNote(plans: readonly TargetPlan[]): string | undefined {
  const cloud = plans.filter((p) => writesFile(p)).map((p) => p.target.backend);
  if (cloud.length === 0) return undefined;
  return (
    `The text above is sent to ${[...new Set(cloud)].join(" and ")} on every turn those CLIs take. ` +
    `Write nothing here you would not send to a cloud vendor.`
  );
}
