/**
 * What a turn that was allowed to act changed — S5.2 AC4 (D-043).
 *
 * At level 2 a vendor CLI runs without its read-only flag. "Act, then report"
 * needs a report, and before this file there was only a warning printed
 * *before* the turn. So Mind takes a snapshot of the directory the vendor
 * runs in before and after, and says what differs before the turn ends.
 *
 * A snapshot is size and mtime per file, not a hash: it is taken twice per
 * turn over a tree that may be large, and the question is *did this change*,
 * which size-or-mtime answers for every write that is not deliberately
 * disguised. What it cannot see is printed with it ({@link REPORT_LIMITS}).
 */

import { lstat, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** The most files a snapshot will look at. Above it, the report says so. */
export const SNAPSHOT_MAX = 20_000;

/** Directories never walked: their churn is a tool's, and they are huge. */
export const SNAPSHOT_SKIP: readonly string[] = [".git", "node_modules"];

/** path → "size:mtime", or `null` when the tree was bigger than the cap. */
export type Snapshot = ReadonlyMap<string, string> | null;

/** Walk `root` without following links. */
export async function snapshotTree(root: string, max: number = SNAPSHOT_MAX): Promise<Snapshot> {
  const out = new Map<string, string>();
  let over = false;
  const walk = async (dir: string): Promise<void> => {
    if (over) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (over) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SNAPSHOT_SKIP.includes(entry.name)) await walk(path);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (out.size >= max) {
        over = true;
        return;
      }
      try {
        const st = await lstat(path);
        out.set(relative(root, path).split(sep).join("/"), `${st.size}:${st.mtimeMs}`);
      } catch {
        // Gone between readdir and lstat — the after-snapshot will say so.
      }
    }
  };
  await walk(root);
  return over ? null : out;
}

/** What differs, sorted. `null` when either side was not measured. */
export interface TreeChange {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
}

export function diffSnapshots(before: Snapshot, after: Snapshot): TreeChange | null {
  if (before === null || after === null) return null;
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [path, stamp] of after) {
    const was = before.get(path);
    if (was === undefined) added.push(path);
    else if (was !== stamp) changed.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) removed.push(path);
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

/** What this report cannot see. Printed with it every time. */
export const REPORT_LIMITS: readonly string[] = [
  "files outside the directory the backend ran in",
  "commands that ran and left no file behind, and anything sent over the network",
  "a file changed and changed back within the turn (same size and mtime)",
  `anything under ${SNAPSHOT_SKIP.map((d) => `${d}/`).join(" or ")}`,
];

/** The report as lines, at most `shown` paths per kind. */
export function formatTreeChange(root: string, change: TreeChange | null, shown = 20): readonly string[] {
  if (change === null) {
    return [
      `what this turn changed in ${root}: NOT MEASURED — more than ${SNAPSHOT_MAX} files there. ` +
        `Run turns that may act from a smaller directory to get a report.`,
    ];
  }
  const total = change.added.length + change.changed.length + change.removed.length;
  const lines = [
    total === 0
      ? `what this turn changed in ${root}: nothing`
      : `what this turn changed in ${root}: ${change.added.length} added · ` +
        `${change.changed.length} changed · ${change.removed.length} removed`,
  ];
  const list = (mark: string, paths: readonly string[]) => {
    for (const path of paths.slice(0, shown)) lines.push(`  ${mark} ${path}`);
    if (paths.length > shown) lines.push(`  ${mark} … and ${paths.length - shown} more`);
  };
  list("+", change.added);
  list("~", change.changed);
  list("-", change.removed);
  lines.push(`  not seen by this report: ${REPORT_LIMITS.join(" · ")}`);
  return lines;
}
