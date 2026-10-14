/**
 * S3.4 — what the owner is into *now*, not last year (D-064).
 *
 * Counted, not read. S3.3 needed the third door on `Personal` (D-057); this
 * does not, and ADR 0002 §8 says it must not: the tallies go through
 * `countPersonal` with a vocabulary the owner's own disk supplies — the
 * project directories under roots they name — so no word in a key ever comes
 * out of a record. A record whose working directory is not one of those
 * directories is simply not counted.
 *
 * The score is frequency × recency: every action on a day adds
 * `0.5 ^ (age in days / half-life)`, so a week-old day counts half at the
 * default half-life of 7 days (AC1, tunable). Recomputed on every run, so it
 * moves as capture grows with nothing to reset (AC3).
 */

import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { countPersonal, type CountTally, type Personal } from "../types.ts";
import type { CaptureRecord } from "./record.ts";

/** Directories that are never a project somebody is interested in. */
const SKIP = new Set(["node_modules", "dist", "build", "target", "venv", ".venv", "__pycache__", "vendor", "coverage"]);

export const INTEREST_LIMITS = Object.freeze({ maxDepth: 4, maxDirs: 3000, windowHalfLives: 6 });

/** Every directory under the roots, to a depth — the only words a key may hold. */
export async function candidateDirs(
  roots: readonly string[],
  maxDepth: number = INTEREST_LIMITS.maxDepth,
  maxDirs: number = INTEREST_LIMITS.maxDirs,
): Promise<readonly string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (found.length >= maxDirs) return;
    found.push(dir);
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP.has(e.name)) continue;
      await walk(join(dir, e.name), depth + 1);
    }
  };
  for (const root of roots) await walk(root, 0);
  return found;
}

/** The last `days` calendar dates (UTC), newest first. */
export function recentDays(now: Date, days: number): readonly string[] {
  return Array.from({ length: days }, (_, i) => new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
}

const ORIGINS = ["owner-prompted", "unknown"] as const;

export const INTEREST_TALLY: CountTally = {
  key: { parts: [{ field: "project" }, { field: "origin" }, { field: "at", take: "day" }] },
};

export interface Interest {
  /** The directory directly under a root that the counted directories roll up to. */
  readonly project: string;
  readonly score: number;
  readonly actions: number;
  readonly days: number;
  readonly last: string;
}

/** The top-level project a directory belongs to: its first component under whichever root holds it. */
export function topOf(dir: string, roots: readonly string[]): string | undefined {
  for (const root of roots) {
    const rel = relative(root, dir);
    if (rel === "" || rel.startsWith("..")) continue;
    return join(root, rel.split(sep)[0]!);
  }
  return undefined;
}

/**
 * Rank projects by frequency × recency. Counts only: the box is never opened.
 *
 * @param halfLifeDays how many days until a day's actions count half (AC1).
 */
export function rankInterests(
  records: Personal<readonly CaptureRecord[]>,
  options: { readonly dirs: readonly string[]; readonly roots: readonly string[]; readonly now: Date; readonly halfLifeDays: number },
): readonly Interest[] {
  const days = recentDays(options.now, Math.max(1, Math.ceil(options.halfLifeDays * INTEREST_LIMITS.windowHalfLives)));
  const vocabulary: string[] = [];
  for (const dir of options.dirs) for (const origin of ORIGINS) for (const day of days) vocabulary.push(`${dir}|${origin}|${day}`);
  const counts = countPersonal(records, [INTEREST_TALLY], vocabulary);

  const byProject = new Map<string, { score: number; actions: number; days: Set<string>; last: string }>();
  const today = Date.parse(`${days[0]}T00:00:00Z`);
  for (const [key, n] of Object.entries(counts)) {
    if (n === 0) continue;
    const [dir, , day] = key.split("|") as [string, string, string];
    const project = topOf(dir, options.roots);
    if (project === undefined) continue;
    const age = (today - Date.parse(`${day}T00:00:00Z`)) / 86_400_000;
    const entry = byProject.get(project) ?? { score: 0, actions: 0, days: new Set<string>(), last: day };
    entry.score += n * Math.pow(0.5, age / options.halfLifeDays);
    entry.actions += n;
    entry.days.add(day);
    if (day > entry.last) entry.last = day;
    byProject.set(project, entry);
  }
  return [...byProject.entries()]
    .map(([project, e]) => ({ project, score: e.score, actions: e.actions, days: e.days.size, last: e.last }))
    .sort((a, b) => b.score - a.score || b.actions - a.actions || a.project.localeCompare(b.project));
}

/** Lines a person reads. */
export function formatInterests(ranked: readonly Interest[], options: { readonly limit: number; readonly halfLifeDays: number; readonly home: string }): readonly string[] {
  const short = (p: string) => (options.home !== "" && p.startsWith(`${options.home}/`) ? `~${p.slice(options.home.length)}` : p);
  const lines = [`what you are into now — each action counts half again every ${options.halfLifeDays} day(s)`];
  if (ranked.length === 0) lines.push("  nothing counted yet under the roots you named");
  const top = ranked[0]?.score ?? 1;
  for (const [i, x] of ranked.slice(0, options.limit).entries()) {
    const bar = "█".repeat(Math.max(1, Math.round((x.score / top) * 20)));
    lines.push(`  ${String(i + 1).padStart(2)}. ${short(x.project).padEnd(40)} ${bar} ${x.score.toFixed(1)}  (${x.actions} action(s) on ${x.days} day(s), last ${x.last})`);
  }
  return lines;
}
