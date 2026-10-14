/**
 * What recall is built from — the files in git, cut into pieces a search can
 * return (D-037, S4.1 AC5).
 *
 * The source of truth for an agent's knowledge is `memory/**\/*.md` in its own
 * repository. Everything S4.1 writes elsewhere — the full-text file under
 * `.mind/index/`, the vector collection in Qdrant — is derived from what this
 * file returns, and must be rebuildable from it alone. So this is pure over
 * the file contents, and the id of each piece is a hash of *where it came
 * from*, never of when it was read: two rebuilds over the same tree produce the
 * same ids, which is what lets "drop the index and build it again" be checked
 * rather than hoped.
 *
 * ## How a file is cut
 *
 * At its headings (`#` through `######`), so a piece is something a person
 * wrote as one section. A section longer than {@link CHUNK_MAX} is split again
 * at blank lines, and a paragraph longer than that at the limit itself — a hit
 * that returns ten thousand characters is not a recall, it is a file.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isUntouchedMemoryReadme } from "../agent/template.ts";
import { ACTION_KINDS, SUMMARY_PATH, SUMMARY_PROGRAMS, type ActionsSummary } from "../observer/actions.ts";

/** Where the sources live, relative to the agent repository (D-014). */
export const MEMORY_DIR = "memory";

/** The longest piece, in characters. bge-m3 reads 8192 tokens; this stays far inside it. */
export const CHUNK_MAX = 1500;

/** One piece of one file. */
export interface MemoryChunk {
  /** Stable across rebuilds: derived from `path` and `ordinal` only. */
  readonly id: string;
  /** Relative to the agent repository, with `/` separators. */
  readonly path: string;
  /** The heading this piece sits under, or `""` for text before the first one. */
  readonly heading: string;
  /** Position of this piece within its file, from 0. */
  readonly ordinal: number;
  readonly text: string;
}

/**
 * A UUID-shaped id for a piece, from its address.
 *
 * Qdrant takes an unsigned integer or a UUID as a point id and nothing else,
 * so the hash is folded into that shape. The version and variant nibbles are
 * set so the string is a well-formed v8 (custom) UUID.
 */
export function chunkId(path: string, ordinal: number): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${path}#${ordinal}`);
  const hex = hasher.digest("hex");
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Cut one file's text into pieces. Pure. */
export function chunkMarkdown(path: string, text: string): readonly MemoryChunk[] {
  const sections: { heading: string; body: string[] }[] = [{ heading: "", body: [] }];
  let fenced = false;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    // A `#` inside a code fence is a shell comment, not a heading.
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (heading !== null) {
      sections.push({ heading: heading[1] ?? "", body: [line] });
    } else {
      sections.at(-1)?.body.push(line);
    }
  }

  const pieces: { heading: string; text: string }[] = [];
  for (const section of sections) {
    for (const text of splitLong(section.body.join("\n").trim())) {
      pieces.push({ heading: section.heading, text });
    }
  }
  return pieces.map((piece, ordinal) => ({
    id: chunkId(path, ordinal),
    path,
    heading: piece.heading,
    ordinal,
    text: piece.text,
  }));
}

/** At blank lines first, then at the limit. An empty section yields nothing. */
function splitLong(text: string): string[] {
  if (text === "") return [];
  if (text.length <= CHUNK_MAX) return [text];
  const out: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/)) {
    const joined = current === "" ? paragraph : `${current}\n\n${paragraph}`;
    if (joined.length <= CHUNK_MAX) {
      current = joined;
      continue;
    }
    if (current !== "") out.push(current);
    current = paragraph;
    while (current.length > CHUNK_MAX) {
      out.push(current.slice(0, CHUNK_MAX));
      current = current.slice(CHUNK_MAX);
    }
  }
  if (current.trim() !== "") out.push(current);
  return out;
}

/** What reading an agent's memory found. */
export interface MemorySources {
  readonly root: string;
  readonly files: readonly string[];
  readonly chunks: readonly MemoryChunk[];
  /** Files that could not be read, relative, with why. Reported; never fatal. */
  readonly unreadable: readonly { readonly path: string; readonly reason: string }[];
}

/**
 * Every `*.md` under `<agentDir>/memory/`, cut into pieces, in path order.
 *
 * Symlinks are not followed: a link out of `memory/` would put a file that is
 * not in the agent's repository into its recall, and a rebuild on another
 * machine could not reproduce it. A missing `memory/` is an empty result.
 */
export async function readMemory(agentDir: string): Promise<MemorySources> {
  const root = join(agentDir, MEMORY_DIR);
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) found.push(path);
    }
  };
  await walk(root);
  found.sort();

  const files: string[] = [];
  const chunks: MemoryChunk[] = [];
  const unreadable: { path: string; reason: string }[] = [];
  for (const absolute of found) {
    const rel = relative(agentDir, absolute).split(sep).join("/");
    try {
      const text = await readFile(absolute, "utf8");
      // The README `mind new` writes is instructions for a person, not
      // something the agent knows. Untouched, it would ride along on every turn
      // of every new agent (seen in the bare-container demo, 2026-09-23); the
      // moment somebody edits it, it is theirs and is read like any note.
      if (rel === `${MEMORY_DIR}/README.md` && isUntouchedMemoryReadme(text)) continue;
      chunks.push(...chunkMarkdown(rel, text));
      files.push(rel);
    } catch (cause) {
      unreadable.push({ path: rel, reason: String(cause) });
    }
  }
  // D-040: the one piece of capture recall may carry is the committed summary —
  // counts keyed by words Mind holds in its own source, never a path, a
  // session or a command line — rendered as a sentence a model can read.
  try {
    const summary = JSON.parse(await readFile(join(agentDir, SUMMARY_PATH), "utf8")) as ActionsSummary;
    const text = summaryProse(summary);
    if (text !== "") {
      chunks.push({ id: chunkId(SUMMARY_PATH, 0), path: SUMMARY_PATH, heading: "How the owner works", ordinal: 0, text });
      files.push(SUMMARY_PATH);
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      unreadable.push({ path: SUMMARY_PATH, reason: String(cause) });
    }
  }
  return { root, files, chunks, unreadable };
}

/** Outcome words a capture record can hold (`src/observer/record.ts`). */
const OUTCOMES: readonly string[] = ["ok", "failed", "unknown"];

/**
 * The largest few entries of a count table, as `name n`.
 *
 * Only names on `allowed` — Mind's own vocabulary — come out, and only
 * integers beside them. The summary is a file in a working tree and somebody
 * can edit it; a key that is not one of these words is dropped rather than
 * trusted, so a path typed into it by hand cannot ride into a prompt.
 */
function top(counts: Readonly<Record<string, number>> | undefined, n: number, allowed: readonly string[]): string {
  return Object.entries(counts ?? {})
    .filter(([name, count]) => Number.isInteger(count) && count > 0 && allowed.includes(name))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([name, count]) => `${name} ${count}`)
    .join(", ");
}

/**
 * The summary as prose, one line per month. Pure.
 *
 * Only reads keys the summary's own vocabulary put there, and only numbers
 * come out of it beside them — the same property that made the file safe to
 * commit makes it safe to recall.
 */
export function summaryProse(summary: ActionsSummary): string {
  const lines: string[] = [];
  for (const month of summary.months ?? []) {
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const m = summary.counts?.[month];
    if (m === undefined || !Number.isInteger(m.records) || m.records === 0) continue;
    const parts = [`${m.records} captured action(s)`];
    const kinds = top(m.kind, 4, ACTION_KINDS);
    if (kinds !== "") parts.push(`by kind: ${kinds}`);
    const programs = top(m.program, 6, SUMMARY_PROGRAMS);
    if (programs !== "") parts.push(`most-run programs: ${programs}`);
    const outcomes = top(m.outcome, 3, OUTCOMES);
    if (outcomes !== "") parts.push(`outcomes: ${outcomes}`);
    lines.push(`- ${month}: ${parts.join("; ")}.`);
  }
  if (lines.length === 0) return "";
  return [
    "Counts of what the owner did, from Mind's capture (actions/summary.json). Numbers only; " +
      "no file, project or command line is recorded here.",
    ...lines,
  ].join("\n");
}
