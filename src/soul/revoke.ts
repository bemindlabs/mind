/**
 * `soul revoke` — every file `soul apply` touched, back as it was (S1.5).
 *
 * Two facts make "as it was" checkable rather than hoped. `strip` returns the
 * text outside Mind's markers byte for byte (Phase A criterion 3), and every
 * apply wrote a manifest recording, per file, whether it existed and the
 * sha256 of what it held before. So each file is stripped and its new bytes
 * are compared with the **earliest** recorded sha — the state before Mind
 * ever wrote there. A file Mind created, and that holds nothing once the
 * block is gone, is removed: absent is what it was.
 *
 * A file that no longer matches — somebody edited around the block since — is
 * still stripped, keeps the edits, and says so. Revoke takes back what Mind
 * wrote and nothing else.
 *
 * Plan, then commit, like `apply` and `erase`: {@link planRevoke} reads and
 * writes nothing; {@link commitRevoke} takes the plan.
 */

import { chmod, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SubjectId } from "../types.ts";
import { locate, sha256, strip } from "./block.ts";

/** What the earliest apply recorded about one path. */
export interface BeforeApply {
  readonly existedBefore: boolean;
  /** sha256 of the bytes before the first apply; of "" when there was no file. */
  readonly sha256: string;
}

/**
 * Per path, the entry of the oldest manifest that mentions it.
 *
 * Stamps sort by name, and they are ISO-like timestamps, so name order is time
 * order. A manifest that cannot be read is reported, never guessed around.
 */
export async function beforeApply(
  backupDir: string,
): Promise<{ readonly paths: ReadonlyMap<string, BeforeApply>; readonly unreadable: readonly string[] }> {
  const paths = new Map<string, BeforeApply>();
  const unreadable: string[] = [];
  let stamps;
  try {
    stamps = (await readdir(backupDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return { paths, unreadable };
  }
  for (const stamp of stamps) {
    const manifest = join(backupDir, stamp, "manifest.json");
    let files: unknown;
    try {
      files = (JSON.parse(await Bun.file(manifest).text()) as { files?: unknown }).files;
    } catch {
      unreadable.push(manifest);
      continue;
    }
    if (!Array.isArray(files)) {
      unreadable.push(manifest);
      continue;
    }
    for (const entry of files as Record<string, unknown>[]) {
      const path = entry["path"];
      if (typeof path !== "string" || paths.has(path)) continue;
      paths.set(path, {
        existedBefore: entry["existedBefore"] === true,
        sha256: typeof entry["sha256"] === "string" ? entry["sha256"] : "",
      });
    }
  }
  return { paths, unreadable };
}

export type RevokeAction =
  /** The block goes; the file stays. */
  | "strip"
  /** Mind created the file and nothing else is in it: it goes. */
  | "delete"
  /** No file, or no Mind block in it. */
  | "absent"
  /** Somebody else's block (I-3). Untouched. */
  | "other-subject"
  /** A block edited by hand, a file that is not text: untouched, and the run is refused. */
  | "refused";

export interface RevokeFile {
  readonly path: string;
  readonly action: RevokeAction;
  readonly reason?: string;
  readonly next?: string;
  readonly mode?: number;
  /**
   * Whether the result equals the file before Mind's first apply. `null` when
   * no manifest mentions the path, so there is nothing to compare with.
   */
  readonly identical: boolean | null;
}

/** Decide, reading only. */
export async function planRevoke(
  paths: readonly string[],
  subject: SubjectId,
  history: ReadonlyMap<string, BeforeApply>,
): Promise<readonly RevokeFile[]> {
  const out: RevokeFile[] = [];
  for (const path of [...new Set(paths)].sort()) {
    let mode: number;
    try {
      const info = await stat(path);
      if (!info.isFile()) {
        out.push({ path, action: "refused", reason: "not a regular file", identical: null });
        continue;
      }
      mode = info.mode & 0o777;
    } catch {
      out.push({ path, action: "absent", identical: null });
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(await Bun.file(path).bytes());
    } catch {
      out.push({ path, action: "refused", reason: "not valid UTF-8", identical: null });
      continue;
    }
    const found = locate(text);
    if (found.kind === "refused") {
      out.push({ path, action: "refused", reason: found.reason, identical: null });
      continue;
    }
    if (found.kind === "absent") {
      out.push({ path, action: "absent", identical: null });
      continue;
    }
    if (found.block.subject !== subject) {
      out.push({
        path,
        action: "other-subject",
        reason: `holds subject ${found.block.subject}'s block, not this one's — left byte-identical (I-3)`,
        identical: null,
      });
      continue;
    }
    const stripped = strip(text);
    if (stripped.kind !== "stripped") {
      out.push({ path, action: "refused", reason: stripped.kind === "refused" ? stripped.reason : "no block", identical: null });
      continue;
    }
    const before = history.get(path);
    const created = before !== undefined && !before.existedBefore;
    if (created && stripped.text === "") {
      out.push({ path, action: "delete", identical: true });
      continue;
    }
    out.push({
      path,
      action: "strip",
      next: stripped.text,
      mode,
      identical: before === undefined ? null : !created && sha256(stripped.text) === before.sha256,
    });
  }
  return out;
}

/** Carry out the plan. Refuses as a whole if anything was refused. */
export async function commitRevoke(plan: readonly RevokeFile[]): Promise<{ readonly changed: number }> {
  if (plan.some((file) => file.action === "refused")) throw new Error("a refused plan cannot be committed");
  let changed = 0;
  for (const [index, file] of plan.entries()) {
    if (file.action === "delete") {
      await rm(file.path, { force: true });
      changed += 1;
    } else if (file.action === "strip" && file.next !== undefined) {
      const temp = `${file.path}.mind-revoke-${process.pid}-${index}.tmp`;
      await writeFile(temp, file.next, { mode: file.mode });
      if (file.mode !== undefined) await chmod(temp, file.mode);
      await rename(temp, file.path);
      changed += 1;
    }
  }
  return { changed };
}
