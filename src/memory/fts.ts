/**
 * The full-text half of recall — SQLite FTS5 with the `trigram` tokenizer
 * (D-037).
 *
 * Why this exists beside the vector store: a semantic search misses the things
 * a person searches for by exact spelling — a ticket number, a file name, a
 * port — and an ordinary FTS tokenizer cannot cut Thai, which has no spaces
 * between words. `trigram` indexes every three-character window, so it needs
 * no word boundaries at all. The price is that a query shorter than three
 * characters cannot use the index; {@link searchFts} falls back to a scan for
 * those rather than returning nothing.
 *
 * ## Where the file lives, and why it can always be thrown away
 *
 * `<agent>/.mind/index/fts.sqlite`. Under `.mind/`, which D-014 says must be
 * deletable at any moment and rebuilt from git, and which `erase` removes whole
 * in both scopes. {@link buildFts} writes a new file beside the old one and
 * renames it into place, so a reader never sees half an index and a failed
 * build leaves the previous one standing.
 */

import { Database } from "bun:sqlite";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DERIVED_DIR } from "../agent/template.ts";
import type { MemoryChunk } from "./sources.ts";

/** The index directory D-014 reserved for `rag`, relative to the agent repository. */
export const INDEX_DIR = `${DERIVED_DIR}/index`;

/** The full-text file, relative to `.mind/` — the form `rebuild` owns paths in. */
export const FTS_IN_DERIVED = "index/fts.sqlite";

/** The full-text file, relative to the agent repository. */
export const FTS_FILE = `${DERIVED_DIR}/${FTS_IN_DERIVED}`;

/** Absolute path of the full-text file for one agent. */
export function ftsPath(agentDir: string): string {
  return join(agentDir, FTS_FILE);
}

/** One hit, best first. `rank` is FTS5's bm25: lower is better. */
export interface FtsHit {
  readonly id: string;
  readonly path: string;
  readonly heading: string;
  readonly text: string;
  readonly rank: number;
}

/** Build one agent's file from scratch, atomically. Returns how many pieces went in. */
export async function buildFts(agentDir: string, chunks: readonly MemoryChunk[]): Promise<number> {
  return buildFtsFile(ftsPath(agentDir), chunks);
}

/**
 * Build a full-text file at `target`, atomically.
 *
 * Separate from {@link buildFts} because `mind rebuild` writes into a staging
 * directory and swaps the whole of `.mind/` into place: the file has to be
 * built where the staging is, not where the agent's live `.mind/` is.
 */
export async function buildFtsFile(target: string, chunks: readonly MemoryChunk[]): Promise<number> {
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.building-${process.pid}`;
  await rm(temp, { force: true });
  const db = new Database(temp, { create: true });
  try {
    db.run(
      "CREATE VIRTUAL TABLE chunks USING fts5(" +
        "id UNINDEXED, path UNINDEXED, heading, text, tokenize = 'trigram')",
    );
    const insert = db.prepare("INSERT INTO chunks (id, path, heading, text) VALUES (?, ?, ?, ?)");
    db.transaction((rows: readonly MemoryChunk[]) => {
      for (const row of rows) insert.run(row.id, row.path, row.heading, row.text);
    })(chunks);
  } finally {
    db.close();
  }
  await rename(temp, target);
  return chunks.length;
}

/** Thai, Lao, Khmer, Myanmar: scripts written without spaces between words. */
const UNSPACED = /[\u0E00-\u0EFF\u1000-\u109F\u1780-\u17FF]/;
/** Window length and step for an unspaced run, in characters. */
const WINDOW = 4;
const STEP = 2;
/** The most terms one query becomes. bm25 over a hundred ORs ranks noise. */
export const MAX_TERMS = 32;

/**
 * The terms an `any` search looks for in a prompt.
 *
 * A prompt is a sentence, not a query: requiring every word (`all`) matches
 * almost nothing, so recall ORs its terms and lets bm25 rank. A run of Thai
 * has no spaces to split on, so a long one is cut into overlapping windows —
 * "ราคาทองวันนี้" becomes "ราคา", "คาทอ", "ทองว", … — each of which a trigram
 * index can find. Words under three characters are dropped: the index cannot
 * use them and a scan over every row for "a" is not recall.
 */
/**
 * Words that say how a question is asked, not what it is about. With the
 * index matching trigrams inside words, "which" or "the" OR-ed into a query
 * find nearly every note, and the note that answers ends up below the ceiling
 * of what recall attaches (D-075: measured with `eval --recall-only`).
 */
export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    "the and for are was were been being has have had does did doing done not but nor yet " +
    "this that these those there their them they then than what which who whom whose when where why how " +
    "with without within into onto from about above below over under again further once here " +
    "all any both each few more most other some such only own same very can will just should would could must might shall " +
    "you your yours our ours his her hers its itself myself yourself what's it's i'm " +
    "also still ever never always really actually instead please tell know need needs want wants make makes made " +
    "use used using get got gets keep keeps kept pick picks thing things way ways one two"
  ).split(" "),
);

export function queryTerms(text: string): readonly string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s\p{P}]+/u)) {
    const chars = [...raw];
    if (chars.length < 3) continue;
    if (STOPWORDS.has(raw.toLowerCase())) continue;
    if (UNSPACED.test(raw) && chars.length > WINDOW + STEP) {
      for (let at = 0; at + WINDOW <= chars.length; at += STEP) out.push(chars.slice(at, at + WINDOW).join(""));
    } else {
      out.push(raw);
    }
  }
  return [...new Set(out.map((term) => term.toLowerCase()))].slice(0, MAX_TERMS);
}

/**
 * Search the file. A missing file is no hits, not an error: recall is allowed
 * to be absent (I-1), and "never built" is an ordinary state.
 *
 * `all` (the default) is what a person typing a search means: every word.
 * `any` is what a turn's recall needs — see {@link queryTerms}.
 */
export async function searchFts(
  agentDir: string,
  query: string,
  limit: number,
  mode: "all" | "any" = "all",
): Promise<FtsHit[]> {
  const path = ftsPath(agentDir);
  if (!(await Bun.file(path).exists())) return [];
  if (mode === "any") {
    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    const db = new Database(path, { readonly: true });
    try {
      const match = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ");
      return db
        .query(
          `SELECT id, path, heading, text, bm25(chunks) AS rank FROM chunks ` +
            `WHERE chunks MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(match, limit) as FtsHit[];
    } finally {
      db.close();
    }
  }
  const words = query.split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return [];

  const db = new Database(path, { readonly: true });
  try {
    // Every word is quoted, so nothing the caller typed is FTS5 syntax. Words
    // under three characters cannot be matched by a trigram index and are
    // matched with LIKE instead, over the rows the long words already found.
    const long = words.filter((word) => [...word].length >= 3);
    const short = words.filter((word) => [...word].length < 3);
    const likes = short.map(() => "text LIKE ? ESCAPE '\\'").join(" AND ");
    const likeArgs = short.map((word) => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);

    if (long.length > 0) {
      const match = long.map((word) => `"${word.replace(/"/g, '""')}"`).join(" ");
      const where = likes === "" ? "" : ` AND ${likes}`;
      return db
        .query(
          `SELECT id, path, heading, text, bm25(chunks) AS rank FROM chunks ` +
            `WHERE chunks MATCH ?${where} ORDER BY rank LIMIT ?`,
        )
        .all(match, ...likeArgs, limit) as FtsHit[];
    }
    return db
      .query(`SELECT id, path, heading, text, 0 AS rank FROM chunks WHERE ${likes} LIMIT ?`)
      .all(...likeArgs, limit) as FtsHit[];
  } finally {
    db.close();
  }
}
