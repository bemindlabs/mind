/**
 * "soul" is three locations on this machine, not one — and finding that out is
 * most of what this file is for.
 *
 * `mind soul apply` puts an identity in more places than the directory it was
 * read from, and an erase that only removed `<agent>/soul/` would leave two
 * working copies of the thing somebody just asked to have deleted:
 *
 * 1. **`<agent>/soul/` in git**, plus the derived `<agent>/.mind/`, which holds
 *    `soul/rendered.md` — the exact text a model was told.
 * 2. **Mind's block inside every vendor instruction file** `apply` wrote to.
 *    Those are somebody else's files: the block is delimited, and removing it
 *    is {@link strip}'s job, never a rewrite of the file.
 * 3. **`$XDG_STATE_HOME/mind/backups/<subject>/`** — the originals `apply`
 *    copies before each write. This is the one that is easy to miss and the
 *    worst to leave: a backup taken before the *second* apply contains the
 *    block written by the first, so the backup tree holds old copies of the
 *    identity that Mind itself created.
 *
 * ## Which blocks are this subject's
 *
 * Only the ones whose opening marker says `subject=<this id>` (I-3). Another
 * identity's block in the same file is left byte-identical, and the report says
 * it was found and left. A block whose body was edited by hand makes
 * {@link strip} refuse, and the refusal is the whole run's refusal: the backups
 * stay where they are and nothing is certified, because a half-erased identity
 * with a truthful-looking exit code is worse than a stopped one.
 *
 * ## Where the file list comes from
 *
 * The union of two sources, and it has to be both. The caller passes the paths
 * the vendor registry resolves *now*; this file adds every `files[].path` from
 * every backup manifest, because a CLI that has since been uninstalled is a CLI
 * whose instruction file still sits on disk with the block in it, and the
 * registry-driven list would not mention it.
 *
 * ## No second deleter
 *
 * {@link strip} is `soul apply`'s own inverse and S1.5 `soul revoke` is
 * specified to reuse it (ADR 0002). This file calls it and does not reimplement
 * it, and it does **not** do S1.5's other half: no backup is restored, nothing
 * is verified against a manifest hash. Erase removes; revoke puts back.
 */

import { chmod, lstat, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DERIVED_DIR, SOUL_DIR } from "../agent/template.ts";
import { locate, strip } from "../soul/block.ts";
import { PERSON_FILE } from "../soul/schema.ts";
import { stateRoot } from "../state.ts";
import type { SubjectId } from "../types.ts";

/** The machine facts this module may see — arguments, never ambient state. */
export interface SoulEraseEnv {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** `<state>/backups/<subject>` — every original `soul apply` ever kept for them. */
export function backupTree(env: SoulEraseEnv, subject: SubjectId): string {
  return join(stateRoot(env.home, env.env), "backups", subject);
}

/** `<agent>/soul` — the identity in git. */
export function soulTree(agentDir: string): string {
  return join(agentDir, SOUL_DIR);
}

/** `<agent>/.mind` — derived, and therefore always safe to remove (I-2). */
export function derivedTree(agentDir: string): string {
  return join(agentDir, DERIVED_DIR);
}

/** `<agent>/soul/person.md` — the one file `--personal` removes from git. */
export function personFile(agentDir: string): string {
  return join(soulTree(agentDir), PERSON_FILE);
}

/**
 * Every instruction file a backup manifest says Mind has written to.
 *
 * Read defensively: a manifest that cannot be parsed, or whose `files` is not
 * an array of objects with a string `path`, contributes nothing and is reported
 * rather than throwing. A backup tree is old data by definition, and refusing
 * an entire erase because a year-old manifest is malformed would be refusing
 * for the wrong reason.
 */
export async function manifestTargets(
  backupDir: string,
): Promise<{ readonly paths: readonly string[]; readonly unreadable: readonly string[] }> {
  const paths = new Set<string>();
  const unreadable: string[] = [];

  let stamps;
  try {
    stamps = await readdir(backupDir, { withFileTypes: true });
  } catch {
    return { paths: [], unreadable: [] };
  }

  for (const stamp of stamps) {
    if (!stamp.isDirectory()) continue;
    const manifest = join(backupDir, stamp.name, "manifest.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await Bun.file(manifest).text());
    } catch {
      if (await Bun.file(manifest).exists()) unreadable.push(manifest);
      continue;
    }
    const files = (parsed as { files?: unknown })?.files;
    if (!Array.isArray(files)) {
      unreadable.push(manifest);
      continue;
    }
    for (const entry of files) {
      const path = (entry as { path?: unknown })?.path;
      if (typeof path === "string" && path !== "") paths.add(path);
    }
  }

  return { paths: [...paths].sort(), unreadable };
}

/** What will happen to Mind's block in one file. */
export type BlockOutcome =
  /** No file, or a file with no Mind block in it. Nothing to do. */
  | "absent"
  /** A block belonging to a different subject. Left untouched (I-3). */
  | "other-subject"
  /** This subject's block, intact, will be removed. */
  | "strip"
  /** Mind will not touch this file, and says why. Refuses the whole run. */
  | "refused";

/**
 * One instruction file, decided before anything is written.
 *
 * Named `BlockRemoval` rather than `BlockPlan` because `src/soul/block.ts`
 * already owns that name for the opposite operation — what `apply` is about to
 * write in. Two types called the same thing, one for putting a block in and one
 * for taking it out, is a confusion nobody needs at a call site.
 */
export interface BlockRemoval {
  readonly path: string;
  readonly outcome: BlockOutcome;
  /** Why, for `refused` and `other-subject`. */
  readonly reason?: string;
  /** The whole next file. Present only for `strip`. */
  readonly next?: string;
  /** Permission bits to preserve. */
  readonly mode?: number;
}

/**
 * Work out what would come out of each file, touching nothing.
 *
 * Duplicate paths collapse: the registry and a backup manifest routinely name
 * the same file, and stripping it twice would be a second write that finds no
 * block and reports a second success.
 */
export async function planBlocks(
  paths: readonly string[],
  subject: SubjectId,
): Promise<readonly BlockRemoval[]> {
  const plans: BlockRemoval[] = [];

  for (const path of [...new Set(paths)].sort()) {
    let mode: number;
    try {
      // A link is refused, not followed or replaced: renaming a stripped copy over it would put a plain file where
      // the link was and leave the block in the file it pointed to (review 2026-09-27). Callers hand over resolved
      // paths; one that is still a link is a path nobody resolved.
      if ((await lstat(path)).isSymbolicLink()) {
        plans.push({ path, outcome: "refused", reason: "a symbolic link — Mind strips the file it points to, and was handed the link" });
        continue;
      }
      const info = await stat(path);
      if (!info.isFile()) {
        plans.push({ path, outcome: "refused", reason: "not a regular file" });
        continue;
      }
      mode = info.mode & 0o777;
    } catch {
      plans.push({ path, outcome: "absent" });
      continue;
    }

    const bytes = await Bun.file(path).bytes();
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      plans.push({
        path,
        outcome: "refused",
        reason:
          "not valid UTF-8 — Mind will not rewrite a file it cannot read as text, and cannot " +
          "tell you whether a block is in it",
      });
      continue;
    }

    const found = locate(text);
    if (found.kind === "refused") {
      plans.push({ path, outcome: "refused", reason: found.reason });
      continue;
    }
    if (found.kind === "absent") {
      plans.push({ path, outcome: "absent" });
      continue;
    }
    if (found.block.subject !== subject) {
      plans.push({
        path,
        outcome: "other-subject",
        reason:
          `holds the block of subject ${found.block.subject}, which is not the one being ` +
          `erased — left byte-identical (I-3)`,
      });
      continue;
    }

    const stripped = strip(text);
    if (stripped.kind === "refused") {
      plans.push({ path, outcome: "refused", reason: stripped.reason });
      continue;
    }
    if (stripped.kind === "absent") {
      plans.push({ path, outcome: "absent" });
      continue;
    }
    plans.push({ path, outcome: "strip", next: stripped.text, mode });
  }

  return plans;
}

/** What a file's block-removal actually did. */
export interface BlockRemovalResult {
  readonly path: string;
  readonly outcome: BlockOutcome;
  readonly removed: boolean;
  readonly reason?: string;
}

/**
 * Remove the planned blocks.
 *
 * Takes no environment, like `commitForget` and `commitPurge`: everything it
 * needs is in the plan, so a commit cannot act on a file the plan never read.
 * Written through a temporary file in the same directory and renamed, so a
 * crash leaves either the old file or the new one — these are somebody else's
 * instruction files and a truncated one is the worst available outcome.
 */
export async function commitBlocks(
  plans: readonly BlockRemoval[],
): Promise<readonly BlockRemovalResult[]> {
  const results: BlockRemovalResult[] = [];

  for (const [index, plan] of plans.entries()) {
    if (plan.outcome !== "strip" || plan.next === undefined) {
      results.push({
        path: plan.path,
        outcome: plan.outcome,
        removed: false,
        ...(plan.reason === undefined ? {} : { reason: plan.reason }),
      });
      continue;
    }

    const mode = plan.mode ?? 0o600;
    const temp = `${plan.path}.mind-erase-${process.pid}-${index}.tmp`;
    try {
      await writeFile(temp, plan.next, { mode });
      await chmod(temp, mode);
      await rename(temp, plan.path);
      results.push({ path: plan.path, outcome: "strip", removed: true });
    } catch (cause) {
      await unlink(temp).catch(() => undefined);
      results.push({
        path: plan.path,
        outcome: "refused",
        removed: false,
        reason: `could not be rewritten: ${String(cause)}`,
      });
    }
  }

  return results;
}
