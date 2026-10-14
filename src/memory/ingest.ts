/**
 * Bringing somebody's existing notes into an agent's `memory/` — S4.2 (D-040).
 *
 * The owner chose git as the place (D-037's rule, applied to data that is
 * theirs): the files are copied into `memory/imported/<name>/` in the agent
 * repository, where `memory index` and `rebuild` read them like anything else
 * in `memory/`. So the step that matters is the one *before* the copy — the
 * repo guard's own scanner (`scanStaged`, S0.4) runs over every file as it
 * would be staged, and a file it flags is not copied at all. The guard would
 * have blocked the commit anyway; refusing here means the secret never lands
 * in a working tree somebody can `git add -A`.
 *
 * ## Plan, then commit
 *
 * The same split `erase` and `observe purge` use: {@link planIngest} reads and
 * decides and writes nothing, {@link commitIngest} takes the plan and nothing
 * else. The command shows the plan without `--yes`.
 *
 * ## A mirror
 *
 * A file gone from the source is removed from `imported/<name>/`, so the
 * directory is always *what the source holds now*. Removing it from the working
 * tree is not removing it from git history, and the command says so first.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatFinding, scanStaged, type Finding } from "../guard/scan.ts";
import { MEMORY_DIR } from "./sources.ts";

/** Where imports go, under `memory/`. */
export const IMPORTED_DIR = "imported";

/** What a source may be called: it becomes a directory name in git. */
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The imported directory for one source, relative to the agent repository. */
export function importedPath(name: string): string {
  return `${MEMORY_DIR}/${IMPORTED_DIR}/${name}`;
}

/** Turn a source directory's basename into a name, or `undefined` if nothing is left. */
export function importName(raw: string): string | undefined {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return NAME.test(name) ? name : undefined;
}

/** One file the plan will write. */
export interface IngestCopy {
  /** Repo-relative, as it will be staged. */
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly change: "new" | "changed";
}

/** Everything an ingest would do, worked out before anything is touched. */
export interface IngestPlan {
  readonly agentDir: string;
  readonly target: string;
  readonly copy: readonly IngestCopy[];
  readonly unchanged: number;
  /** Repo-relative paths that are in `imported/<name>/` and no longer in the source. */
  readonly remove: readonly string[];
  /** Files the guard flagged. They are not copied, and not removed if already there. */
  readonly blocked: readonly Finding[];
  /** Entries in the source that are not top-level regular `.md` files, and why. */
  readonly ignored: readonly string[];
}

/**
 * Read the source and the target, scan, and decide. Writes nothing.
 *
 * Only regular `*.md` files at the top of `source` are candidates. A
 * subdirectory is ignored and named: the directory that prompted this story
 * holds `CLAUDE.md` files another tool generated under nested paths, and
 * walking into them would import that tool's context as the owner's memory.
 * A symlink is ignored for the reason `readMemory` gives.
 */
export async function planIngest(source: string, agentDir: string, name: string): Promise<IngestPlan> {
  if (!NAME.test(name)) throw new Error(`${JSON.stringify(name)} cannot name an import: use a-z, 0-9 and -`);
  const target = importedPath(name);

  const candidates: { file: string; bytes: Uint8Array }[] = [];
  const ignored: string[] = [];
  for (const entry of (await readdir(source, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      candidates.push({ file: entry.name, bytes: new Uint8Array(await readFile(join(source, entry.name))) });
    } else {
      ignored.push(
        `${entry.name} — ${entry.isDirectory() ? "a directory; only top-level files are read" : entry.isSymbolicLink() ? "a link; not followed" : "not a .md file"}`,
      );
    }
  }

  const staged = candidates.map((c) => ({ path: `${target}/${c.file}`, bytes: c.bytes }));
  const blocked = scanStaged(staged);
  const blockedPaths = new Set(blocked.map((finding) => finding.path));

  const existing = new Map<string, Uint8Array>();
  try {
    for (const entry of await readdir(join(agentDir, target), { withFileTypes: true })) {
      if (entry.isFile()) {
        existing.set(`${target}/${entry.name}`, new Uint8Array(await readFile(join(agentDir, target, entry.name))));
      }
    }
  } catch {
    // Nothing imported under this name yet.
  }

  const copy: IngestCopy[] = [];
  let unchanged = 0;
  for (const file of staged) {
    if (blockedPaths.has(file.path)) continue;
    const before = existing.get(file.path);
    if (before === undefined) copy.push({ ...file, change: "new" });
    else if (Buffer.compare(Buffer.from(before), Buffer.from(file.bytes)) !== 0) copy.push({ ...file, change: "changed" });
    else unchanged += 1;
  }
  const inSource = new Set(staged.map((file) => file.path));
  const remove = [...existing.keys()].filter((path) => !inSource.has(path)).sort();

  return { agentDir, target, copy, unchanged, remove, blocked, ignored };
}

/** Carry out the plan. Takes nothing but the plan. */
export async function commitIngest(plan: IngestPlan): Promise<{ readonly written: number; readonly removed: number }> {
  await mkdir(join(plan.agentDir, plan.target), { recursive: true });
  for (const file of plan.copy) await writeFile(join(plan.agentDir, file.path), file.bytes);
  for (const path of plan.remove) await rm(join(plan.agentDir, path), { force: true });
  return { written: plan.copy.length, removed: plan.remove.length };
}

/** The plan as lines a person can act on. Never a file's contents, never a matched secret. */
export function formatIngestPlan(plan: IngestPlan): readonly string[] {
  const lines = [
    `  ${plan.copy.filter((c) => c.change === "new").length} new · ` +
      `${plan.copy.filter((c) => c.change === "changed").length} changed · ${plan.unchanged} unchanged · ` +
      `${plan.remove.length} gone from the source · ${new Set(plan.blocked.map((f) => f.path)).size} blocked`,
  ];
  for (const file of plan.copy) lines.push(`  ${file.change === "new" ? "+" : "~"} ${file.path}`);
  for (const path of plan.remove) lines.push(`  - ${path}`);
  for (const finding of plan.blocked) lines.push(`  ! ${formatFinding(finding)}`);
  for (const note of plan.ignored) lines.push(`  · ignored: ${note}`);
  return lines;
}
