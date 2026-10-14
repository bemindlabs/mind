/**
 * Where the egress filter's knowledge and its record live — the subject's
 * personal directory, outside git, reached by `erase` (D-048, D-014).
 *
 * `needles.txt` is the owner's own list of what may not leave: one phrase per
 * line, `#` for a comment. It is personal by construction — a list of your
 * secrets is itself a secret — so it lives where the capture store lives and
 * goes where that goes.
 *
 * `blocked.jsonl` is AC4: every message kept in, with when, where it was going,
 * and which rule stopped it. Never the text, never the needle — the needle's
 * number points back into the file the owner already has.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ensurePersonalDir, personalDir, type PersonalEnv } from "../guard/personal.ts";
import type { SubjectId } from "../types.ts";
import type { EgressFinding, Lexicon } from "./filter.ts";

export const EGRESS_DIR = "egress";
export const NEEDLES_FILE = "needles.txt";
export const BLOCKED_FILE = "blocked.jsonl";

/** Parse a needles file: one per line, blank lines and `#` comments skipped. */
export function parseNeedles(text: string): readonly string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/**
 * The lexicon for one subject: the owner's needles plus the names the soul
 * says it inherits from. A file that is not there (`ENOENT`) is no needles —
 * the owner has declared nothing, the shape patterns still apply, and that is
 * said by the caller, not guessed. A file that is there and cannot be read, or
 * a personal directory that is refused because it sits inside a git checkout,
 * is not "no needles": it is needles nobody can see, so the lexicon says why
 * (`unreadable`) and {@link screen} keeps every text in until it is fixed (EEA-05).
 */
export async function loadLexicon(
  env: PersonalEnv,
  subject: SubjectId,
  inheritsFrom: readonly string[],
): Promise<{ readonly lexicon: Lexicon; readonly source: string | null }> {
  const dir = await personalDir(env, subject);
  let needles: readonly string[] = [];
  let source: string | null = null;
  let unreadable: string | undefined;
  if (!dir.ok) {
    unreadable = dir.reason;
  } else {
    const path = join(dir.path, EGRESS_DIR, NEEDLES_FILE);
    try {
      needles = parseNeedles(await readFile(path, "utf8"));
      source = path;
    } catch (error) {
      // No file: the owner has declared nothing. Any other failure is a list that exists and is not being applied.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        unreadable = `${path} could not be read: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  return { lexicon: { needles: [...needles, ...inheritsFrom], ...(unreadable === undefined ? {} : { unreadable }) }, source };
}

/** One kept-in message. */
export interface BlockedEntry {
  readonly at: string;
  readonly backend: string;
  readonly findings: readonly EgressFinding[];
}

/** Append to the record. Failure to record is reported by the caller, never fatal to the block. */
export async function recordBlocked(env: PersonalEnv, subject: SubjectId, entry: BlockedEntry): Promise<string> {
  const dir = await ensurePersonalDir(env, subject);
  if (!dir.ok) throw new Error(dir.reason);
  const egress = join(dir.path, EGRESS_DIR);
  await mkdir(egress, { recursive: true, mode: 0o700 });
  const path = join(egress, BLOCKED_FILE);
  await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return path;
}

/** Read the record back, newest last. */
export async function readBlocked(env: PersonalEnv, subject: SubjectId): Promise<readonly BlockedEntry[]> {
  const dir = await personalDir(env, subject);
  if (!dir.ok) return [];
  try {
    return (await readFile(join(dir.path, EGRESS_DIR, BLOCKED_FILE), "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as BlockedEntry];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
