/**
 * Which local-CLI homes belong to this erase (S7.1, S7.2, I-4) — and the words that say so.
 *
 * ## The problem this decides
 *
 * The home of a local backend (`<state root>/vendors/claude-local`, `.../grok-local`) holds the vendor CLI's
 * session transcripts, history and scratch for **every** subject that ran a turn there. Nothing in it is keyed by
 * subject: the home is one per backend, a vendor files a session by its own ids and the directory the turn ran in,
 * and neither says who asked. So per-subject removal is impossible, and the choice is between
 * leaving the transcripts (an I-4 hole: the subject's text stays, and the certificate would not have named it) and
 * removing them whole.
 *
 * Erase removes them whole — **when this subject is tied to the home**, and says that it did. Removing a shared
 * home for any id at all would make a mistyped id delete other subjects' transcripts and certify the typo, which
 * is the failure `nothing-found` exists to prevent (S7.2 AC6: a subject never held touches nothing).
 *
 * ## What ties a subject to a home
 *
 * Either of two facts, both read from disk and neither guessed:
 *
 * - the subject's own ledger holds a line whose backend is this home's backend — the subject ran a turn there; or
 * - one of this run's needles (the subject id, the soul's name, any `--needle`) is in the home, in a file's bytes
 *   or in a name — its text is there, whoever else's is too.
 *
 * A home that is not tied is **left alone and said so**, with a way to tie it: a `--needle` for a phrase that is in
 * it. The certificate names it too, so a reader is never told a transcript store was cleaned when it was not
 * looked into.
 *
 * ## What it does not do
 *
 * No removal and no change: this reads. The removal is the ordinary purge of a tree (`commitPurge`) over the plan
 * that `planErase` builds from the homes this file calls tied, so what is counted before, removed, recounted after
 * and searched for is the same as for every other tree.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { census } from "../observer/store.ts";
import type { SubjectId } from "../types.ts";
import type { SharedTree } from "./map.ts";
import { searchTree, type Needle } from "./search.ts";

/** One home on the state root, and the subject's ledger beside it. */
export interface HomeCandidate {
  readonly tree: SharedTree;
  /** The home under this root. */
  readonly dir: string;
  /** This subject's ledger directory under the same root. */
  readonly ledger: string;
}

/** What `planErase` decided about one home that holds something. */
export interface LocalCliHome {
  readonly key: SharedTree["key"];
  readonly backend: SharedTree["backend"];
  readonly dir: string;
  /** The map's words for the tree. */
  readonly label: string;
  readonly files: number;
  readonly bytes: number;
  /** What tied the subject to it. Empty when it was left alone. */
  readonly because: readonly string[];
  /**
   * `removed-whole` — tied to the subject, and goes. `left-alone` — nothing ties the subject to it, and it stays.
   * `unreadable` — it is there and could not be read, so it is neither tied nor cleared, and the run is refused.
   */
  readonly handling: "removed-whole" | "left-alone" | "unreadable";
  /** The plan's sentence, and the certificate's: which it is, and why. */
  readonly sentence: string;
}

/**
 * Why a directory that is there cannot be read, or `undefined` when it is readable or is not there at all.
 *
 * `census` answers zero for a directory it cannot open, exactly as for one that is not there, and for a home that
 * is the difference between "nothing was written" and "something was, and Mind cannot look".
 */
async function unreadableReason(dir: string): Promise<string | undefined> {
  try {
    await readdir(dir);
    return undefined;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? undefined : String(cause);
  }
}

/**
 * The backends this subject's ledger names, for the lines that are this subject's.
 *
 * Read by hand rather than through the ledger's reader. A line that does not parse, and a line filed under another subject (I-3), contributes nothing.
 */
export async function ledgerBackends(dir: string, subject: SubjectId): Promise<ReadonlySet<string>> {
  const found = new Set<string>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return found;
  }
  for (const name of names.filter((entry) => /^\d{4}-\d{2}\.jsonl$/.test(entry)).sort()) {
    let text: string;
    try {
      text = await Bun.file(join(dir, name)).text();
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const entry: unknown = JSON.parse(line);
        if (typeof entry !== "object" || entry === null) continue;
        const record = entry as { subject?: unknown; backend?: unknown };
        if (record.subject === subject && typeof record.backend === "string") found.add(record.backend);
      } catch {
        // Not a line this reads; the ledger's own plan counts those.
      }
    }
  }
  return found;
}

/** The sentence for a home that goes — the same in the plan's notes and, past tense aside, in the certificate. */
function removedSentence(home: Pick<LocalCliHome, "backend" | "dir" | "files" | "because">): string {
  return (
    `${home.backend}'s own home (${home.dir}, ${home.files} file(s)) is tied to this subject ` +
    `(${home.because.join("; ")}). It holds the vendor CLI's session transcripts, prompt history and scratch ` +
    `for every subject that ran a turn there, and nothing in it is keyed by subject — one home per backend, ` +
    `and a vendor files a session by its own ids and the directory the turn ran in, not by who asked — so it ` +
    `is removed WHOLE, not per subject: other ` +
    `subjects' transcripts in it go with it. Nothing in Mind reads one back (each turn starts a fresh vendor ` +
    `session), and the next local turn makes the home and its config again.`
  );
}

/** The sentence for a home that is not touched. */
function leftSentence(home: Pick<LocalCliHome, "backend" | "dir" | "files">): string {
  return (
    `${home.backend}'s own home (${home.dir}) holds ${home.files} file(s) of vendor session transcripts and ` +
    `nothing ties this subject to it: its ledger names no turn on ${home.backend}, and none of this run's ` +
    `needles (the subject id, the soul's name, any --needle) is inside it. It is NOT touched — it is shared ` +
    `by every subject, and removing it for one that never used it would delete other subjects' transcripts. ` +
    `This run certifies nothing about those files. If this subject's text could be there anyway (its ledger ` +
    `was forgotten earlier and the text carries neither its id nor its name), run again with --needle and a ` +
    `phrase from it: a hit ties the home to this run, and the home then goes whole.`
  );
}

/** The sentence for a home that is there and cannot be read. */
function unreadableSentence(home: Pick<LocalCliHome, "backend" | "dir">, reason: string): string {
  return (
    `${home.backend}'s own home (${home.dir}) exists and could not be read (${reason}), so Mind cannot say ` +
    `whether this subject's transcripts are in it, and cannot clear it. Nothing was certified: fix the ` +
    `permissions, or remove the directory yourself, and run again.`
  );
}

/**
 * Decide, home by home, which go with this erase. A home with nothing in it is not reported at all: there is
 * nothing to remove and nothing to say.
 */
export async function tieLocalCliHomes(
  subject: SubjectId,
  candidates: readonly HomeCandidate[],
  needles: readonly Needle[],
): Promise<readonly LocalCliHome[]> {
  const homes: LocalCliHome[] = [];
  for (const candidate of candidates) {
    const unreadable = await unreadableReason(candidate.dir);
    const before = await census(candidate.dir);
    if (unreadable === undefined && before.files === 0) continue;

    const identity = {
      key: candidate.tree.key,
      backend: candidate.tree.backend,
      dir: candidate.dir,
      label: candidate.tree.label,
    };
    if (unreadable !== undefined) {
      homes.push({
        ...identity,
        files: 0,
        bytes: 0,
        because: [],
        handling: "unreadable",
        sentence: unreadableSentence(identity, unreadable),
      });
      continue;
    }

    const because: string[] = [];
    const backends = await ledgerBackends(candidate.ledger, subject);
    if (backends.has(candidate.tree.backend)) {
      because.push(`the subject's ledger names turns on ${candidate.tree.backend}`);
    }
    const searched = await searchTree(candidate.tree.label, candidate.dir, needles);
    if (searched.hits.length > 0) {
      const labels = [...new Set(searched.hits.map((hit) => hit.needle))];
      because.push(`${labels.join(", ")} found inside it, ${searched.hits.length} hit(s)`);
    }

    const base = { ...identity, files: before.files, bytes: before.bytes, because };
    homes.push(
      because.length > 0
        ? { ...base, handling: "removed-whole", sentence: removedSentence(base) }
        : { ...base, handling: "left-alone", sentence: leftSentence(base) },
    );
  }
  return homes;
}
