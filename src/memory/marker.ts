/**
 * The record that Mind wrote a subject's vectors somewhere — so that `erase`
 * knows where to look, and knows when it must not certify.
 *
 * A vector collection lives in another program's storage. When that program is
 * down, "I asked and it was not there" and "I could not ask" look the same from
 * the outside, and only the second one may still hold the subject's text. So
 * {@link indexAgent}'s vector half writes this file **before** it creates the
 * collection: if the file exists, a collection may exist, and an `erase` that
 * cannot reach the store refuses rather than certifying over it.
 *
 * It lives under the state root, per subject, and `erase` removes it as a tree
 * of the `rag` place — the file names the subject, and AC3 searches the state
 * root for the subject afterwards.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stateRoot } from "../state.ts";
import type { SubjectId } from "../types.ts";
import { collectionFor } from "./collection.ts";

/** The directory under the state root. */
export const RAG_STATE_DIR = "rag";
/** The one file in it. */
export const RAG_MARKER_FILE = "collection.json";
/**
 * The id the marker is written under. {@link readRagMarker} looks at the two fields it needs (`qdrantUrl`,
 * `collection`) and never at the id.
 */
const MARKER_SCHEMA = "mind/rag-marker/1";

/** Where one subject's marker directory is. */
export function ragDirFor(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  subject: SubjectId,
): string {
  return join(stateRoot(home, env), RAG_STATE_DIR, subject);
}

/** What the marker says. */
export interface RagMarker {
  readonly schema: string;
  readonly subject: SubjectId;
  readonly collection: string;
  readonly qdrantUrl: string;
  readonly at: string;
}

/** Write the marker, atomically. Before the collection, never after. */
export async function writeRagMarker(dir: string, subject: SubjectId, qdrantUrl: string, at: Date): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const marker: RagMarker = {
    schema: MARKER_SCHEMA,
    subject,
    collection: collectionFor(subject),
    qdrantUrl,
    at: at.toISOString(),
  };
  const path = join(dir, RAG_MARKER_FILE);
  const temp = `${path}.${process.pid}`;
  await writeFile(temp, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

/**
 * Read the marker. Absent is `null`; present but unreadable is `"unreadable"`,
 * which a caller must treat as present — a file that says *something* was
 * written is evidence even when it cannot say what.
 */
export async function readRagMarker(dir: string): Promise<RagMarker | null | "unreadable"> {
  let text: string;
  try {
    text = await readFile(join(dir, RAG_MARKER_FILE), "utf8");
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
  }
  try {
    const raw = JSON.parse(text) as Partial<RagMarker>;
    if (typeof raw.qdrantUrl !== "string" || typeof raw.collection !== "string") return "unreadable";
    return raw as RagMarker;
  } catch {
    return "unreadable";
  }
}
