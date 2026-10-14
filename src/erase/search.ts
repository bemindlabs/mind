/**
 * AC3 — "ตรวจซ้ำ: ค้นตัวระบุของ subject ทั้งระบบได้ 0 ผลลัพธ์", with "ทั้งระบบ"
 * given a definition that is printed rather than assumed.
 *
 * A criterion that says *the whole system* and a program that searches four
 * directories are not the same claim, and the gap between them is where a
 * verification stops being evidence. So this file exports both halves:
 * {@link SEARCHED}, which is what a run really reads, and {@link NOT_SEARCHED},
 * which is what it cannot and does not — printed on every run, including the
 * ones that find nothing.
 *
 * ## How a hit is decided
 *
 * Bytes, not parsing. A half-written JSONL record, a file that is not valid
 * UTF-8 and a Markdown document are all the same thing to this: a sequence of
 * bytes that either contains the needle or does not. Anything schema-aware
 * would stop finding things on the day a schema changed, which is the failure
 * mode `census` avoids for the same reason.
 *
 * A subject id is matched on **subject-alphabet boundaries**: the id `demo` is
 * a hit in `subject = "demo"` and not in `demonstration`, because the alphabet
 * a `SubjectId` may use is `[a-z0-9_-]` and a character from it on either side
 * means the match is part of a longer word. Directory and file *names* equal to
 * the id count as hits too — a tree called `.../demo/` holds the identifier in
 * its path whether or not any byte inside it does.
 *
 * Everything else — a soul's display name, a `--needle` somebody passed — is a
 * plain substring search, and **that is coarse on purpose**. Thai has no word
 * boundary: a needle like `หนู` will match inside longer words and report more
 * than it should. Over-reporting is the safe direction for a deletion check, but
 * it is not precision, and {@link SEARCH_LIMITS} says so in the output so that
 * a reader knows what a number means before acting on it.
 *
 * ## What is never in the result
 *
 * The needle text for a `--needle` is counted and never echoed. A verification
 * report that printed the secret somebody asked to have deleted would have put
 * it in terminal scrollback, in whatever the output was piped to, and possibly
 * in the certificate file — none of which any erase can reach. The same rule
 * `guard scan` already follows.
 */

import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";

/** One thing to look for, and how it is allowed to be reported. */
export interface Needle {
  /** How it is named in output, e.g. `subject id` or `--needle #1`. */
  readonly label: string;
  /** The bytes to look for. Printed only when {@link quotable}. */
  readonly text: string;
  /**
   * Match only where neither neighbour is a character a subject id may use.
   *
   * True for the subject id itself. False for free text, where there is no
   * alphabet to take a boundary from.
   */
  readonly boundary: boolean;
  /** Whether the text may appear in output. False for anything user-supplied. */
  readonly quotable: boolean;
}

/** One place a needle was found. `line` is 1-based; the matched text is never here. */
export interface Hit {
  readonly path: string;
  /** 1-based line, or 0 when the hit is in the path rather than in the bytes. */
  readonly line: number;
  readonly needle: string;
  /** True when the identifier is in a path segment rather than in file contents. */
  readonly inName: boolean;
}

/** One root that was searched, and what it held afterwards. */
export interface ScopeResult {
  /** How the scope is named in output, e.g. `state root`. */
  readonly label: string;
  /** The directory walked, or a count for a scope that is a list of files. */
  readonly where: string;
  /** Regular files whose bytes were read. */
  readonly filesRead: number;
  readonly hits: readonly Hit[];
  /** Set when the root could not be read at all, rather than being empty. */
  readonly unreadable?: string;
}

/**
 * Whether hits in a scope count against the verdict.
 *
 * `deletable` — Mind was supposed to have emptied this, so a hit is a
 * failure. `git` — the agent's working tree, where a hit is a *remainder* the
 * owner has to decide about: deleting somebody's committed file on their behalf
 * is not Mind's call, and a result that is not clean and says so beats a
 * clean one that lies. `kept` — what the scope the owner asked for keeps on
 * purpose outside git: `erase --personal` keeps the agent's signing key, whose
 * path names the subject (S15.8, D-138). Reported, never deleted, and still a
 * remainder: the identifier is on disk, and saying so is the point.
 */
export type ScopeKind = "deletable" | "git" | "kept";

/**
 * Somewhere to search: one tree to walk, or an explicit list of files.
 *
 * A tree may name **files** under it that are `kept`. A hit is filed as kept only when it is on one of those
 * files, or on a directory that holds nothing — checked on disk, at search time — but kept files and
 * directories that themselves hold only kept files. Everything else stays in this scope's kind.
 *
 * Narrow on purpose (S15.8 re-review). The first version classed a hit as kept if a kept path merely sat
 * *under* it, by string prefix: under `--personal` the name hit on `$DATA/mind/<subject>` then always went
 * to `kept`, key or no key — and that name hit is often the only sign of a place nobody knows about. A
 * directory that holds anything besides the key is a leftover, and says so.
 */
export type Scope =
  | { readonly label: string; readonly kind: ScopeKind; readonly tree: string; readonly kept?: readonly string[] }
  | { readonly label: string; readonly kind: ScopeKind; readonly files: readonly string[] };

/** Characters a {@link import("../types.ts").SubjectId} may contain. */
const ID_CHARACTER = /[a-z0-9_-]/;

/** Directory names never descended into. `.git` is history, not state. */
const SKIPPED_DIRS: readonly string[] = [".git"];

/**
 * Every 1-based line of `text` on which `needle` occurs, by the needle's rule.
 *
 * Exported because the boundary rule is the part worth arguing with, and an
 * argument about it should not need a filesystem.
 */
export function linesMatching(text: string, needle: Needle): number[] {
  if (needle.text === "") return [];
  const found: number[] = [];
  const lines = text.split("\n");

  for (const [index, line] of lines.entries()) {
    let at = line.indexOf(needle.text);
    while (at !== -1) {
      if (!needle.boundary || isBounded(line, at, needle.text.length)) {
        found.push(index + 1);
        break;
      }
      at = line.indexOf(needle.text, at + 1);
    }
  }
  return found;
}

/** True when neither neighbour of the match is a subject-id character. */
function isBounded(line: string, at: number, length: number): boolean {
  const before = at === 0 ? "" : line[at - 1]!;
  const after = line[at + length] ?? "";
  return !ID_CHARACTER.test(before) && !ID_CHARACTER.test(after);
}

/**
 * True when an entry is *named* exactly the needle. Names carry identifiers too.
 *
 * The entry's own name, never the whole path. Matching the path would make
 * every file under an agent directory called `demo` a hit for the subject
 * `demo`, which is one true statement repeated a hundred times and no signal at
 * all. What is worth reporting is a directory or file that *is* the identifier
 * — `ledger/demo/`, `demo.jsonl` — and that is this.
 */
export function nameMatches(name: string, needle: Needle): boolean {
  return needle.boundary && name === needle.text;
}

/**
 * Read every regular file under `root` and report where the needles are.
 *
 * Symlinks are named rather than followed, for the reason `census` gives: a
 * link points outside the tree this is a claim about, and following one would
 * make the report either wrong or about somewhere else. A root that does not
 * exist is zero hits and zero files — "it was deleted" and "it was never there"
 * are the same fact on disk.
 */
export async function searchTree(
  label: string,
  root: string,
  needles: readonly Needle[],
): Promise<ScopeResult> {
  const hits: Hit[] = [];
  let filesRead = 0;
  let unreadable: string | undefined;

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (cause) {
      // A root that is not there is zero, not a problem: "it was deleted" and
      // "it was never created" are the same fact on disk, and the first is the
      // expected outcome of the command this serves.
      if (dir === root && !String(cause).includes("ENOENT")) unreadable = String(cause);
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      for (const needle of needles) {
        if (nameMatches(entry.name, needle)) {
          hits.push({ path, line: 0, needle: needle.label, inName: true });
        }
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.includes(entry.name)) continue;
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;

      filesRead++;
      // Lossy on purpose: invalid bytes become replacement characters, which
      // cannot create a match that was not there and cannot hide one that was,
      // for any needle that is itself valid text.
      const text = new TextDecoder().decode(new Uint8Array(await Bun.file(path).arrayBuffer()));
      for (const needle of needles) {
        for (const line of linesMatching(text, needle)) {
          hits.push({ path, line, needle: needle.label, inName: false });
        }
      }
    }
  };

  await walk(root);
  return {
    label,
    where: root,
    filesRead,
    hits,
    ...(unreadable === undefined ? {} : { unreadable }),
  };
}

/**
 * The same search over a list of files rather than a tree.
 *
 * This is how the vendor instruction files are checked: they are scattered
 * across several home directories that Mind has no business walking, so the
 * scope is exactly the files `soul apply` knows how to write and nothing else.
 * A path that does not exist contributes nothing — a vendor that was never
 * installed is not a finding.
 */
export async function searchFiles(
  label: string,
  paths: readonly string[],
  needles: readonly Needle[],
): Promise<ScopeResult> {
  const hits: Hit[] = [];
  let filesRead = 0;

  for (const path of [...new Set(paths)].sort()) {
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    filesRead++;
    const text = new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()));
    for (const needle of needles) {
      for (const line of linesMatching(text, needle)) {
        hits.push({ path, line, needle: needle.label, inName: false });
      }
    }
  }

  return { label, where: `${filesRead} file(s) that exist`, filesRead, hits };
}

/** Everything one verification pass found, scope by scope. */
export interface SearchReport {
  readonly scopes: readonly (ScopeResult & { readonly kind: ScopeKind })[];
  /** Hits in scopes Mind was supposed to have emptied. Must be zero. */
  readonly deletableHits: number;
  /** Hits in the agent's working tree. Reported, never deleted for you. */
  readonly gitHits: number;
  /** Hits in what the requested scope keeps on purpose — the signing key under `--personal`. */
  readonly keptHits: number;
}

/** Search every scope, in the order given. */
export async function searchScopes(
  scopes: readonly Scope[],
  needles: readonly Needle[],
): Promise<SearchReport> {
  const results: (ScopeResult & { kind: ScopeKind })[] = [];
  for (const scope of scopes) {
    const found =
      "tree" in scope
        ? await searchTree(scope.label, scope.tree, needles)
        : await searchFiles(scope.label, scope.files, needles);
    const kept = "tree" in scope ? (scope.kept ?? []) : [];
    if (kept.length === 0) {
      results.push({ ...found, kind: scope.kind });
      continue;
    }
    const keptHits: Hit[] = [];
    const otherHits: Hit[] = [];
    for (const hit of found.hits) (await isKept(hit.path, kept) ? keptHits : otherHits).push(hit);
    results.push({ ...found, hits: otherHits, kind: scope.kind });
    results.push({ label: `${scope.label}: kept on purpose`, where: kept.join(", "), filesRead: 0, hits: keptHits, kind: "kept" });
  }
  return {
    scopes: results,
    deletableHits: count(results, "deletable"),
    gitHits: count(results, "git"),
    keptHits: count(results, "kept"),
  };
}

/** A kept file itself, or a directory holding nothing but kept files — asked of the disk, not of the string. */
async function isKept(path: string, kept: readonly string[]): Promise<boolean> {
  if (kept.includes(path)) return true;
  return kept.some((file) => file.startsWith(path + sep)) && (await holdsOnlyKept(path, kept));
}

/** Whether `dir` holds at least one kept file and nothing else — no other file, link or directory. */
async function holdsOnlyKept(dir: string, kept: readonly string[]): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.length === 0) return false;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && kept.includes(path)) continue;
    if (entry.isDirectory() && kept.some((file) => file.startsWith(path + sep)) && (await holdsOnlyKept(path, kept))) continue;
    return false;
  }
  return true;
}

function count(
  results: readonly (ScopeResult & { kind: ScopeKind })[],
  kind: ScopeKind,
): number {
  return results
    .filter((result) => result.kind === kind)
    .reduce((total, result) => total + result.hits.length, 0);
}

/**
 * What "ทั้งระบบ" means here, printed beside every verdict.
 *
 * Proposed wording for the owner to put in `.scrum/backlog.md` AC3, written to
 * match what the code actually does: *ค้นตัวระบุใน stateRoot · dataRoot · ไฟล์
 * instruction ที่ apply เคยเขียน · working tree ของ agent ได้ 0 — ขอบเขตที่ไม่ได้
 * ค้นพิมพ์ทุกครั้ง (`NOT_SEARCHED`)*.
 */
export const SEARCHED: readonly string[] = [
  "the whole state root ($XDG_STATE_HOME/mind) — not only this subject's subtree, because a " +
    "leak into another subject's directory is exactly the one worth finding (I-3). The homes of " +
    "Mind's own local backends (vendors/claude-local, vendors/grok-local) are inside it: that is " +
    "where a local turn's vendor transcripts are, and what is left of them is named.",
  "the whole data root ($XDG_DATA_HOME/mind), on the same reasoning.",
  "every vendor instruction file `soul apply` knows how to write, whether or not it wrote one.",
  "the agent's git working tree, minus .git — so memory/ and consent/ are read, and the object " +
    "database is not.",
];

/**
 * What no `erase` reaches, and therefore what no search here covers.
 *
 * Printed on every run including the dry one. A verification that reported
 * "0 results" without this list beside it would be read as "it is gone", and
 * four of these five lines are places where it demonstrably is not.
 */
export const NOT_SEARCHED: readonly string[] = [
  "vendor transcripts of the cloud CLIs. Every cloud CLI writes its own copy of a session in its own " +
    "directory (~/.claude/projects/*.jsonl and the like). Mind does not read them, does not delete " +
    "them, and will not pretend a zero here says anything about them. The local backends' homes " +
    "under Mind's own state root are the exception, and are covered when the subject is tied to " +
    "one; a home nothing ties to it is left alone and said to be.",
  "shell history, the process list and terminal scrollback. A prompt passed as `--prompt <text>` " +
    "was on a command line, and nothing Mind has can reach any of those.",
  "any service on the network, with one exception: the subject's own Qdrant collection is asked " +
    "about and dropped by name on a loopback address (D-038). Nothing inside any other collection " +
    "on that store is read or searched — `docs` included — and a collection somebody else wrote " +
    "the subject's text into is outside this run.",
  "clones and remotes. Every copy of the agent repository anybody has taken keeps its own " +
    "history, and Mind cannot reach one.",
  "git objects. The count of commits is read with `git rev-list`; the contents of the object " +
    "database are never searched, because a zero there would need a rewrite to become true and " +
    "Mind does not rewrite history (see GIT_UNDELETABLE).",
  "freed disk blocks, and any snapshot or backup another program on this machine has taken.",
  "a push relay (D-130). The handles on this machine go, but a relay keeps a phone's registration " +
    "until it is told to forget it or its retention drops it — press \"Unpair every phone\" on " +
    "the agent's page before erasing, and the relays are told.",
];

/**
 * How coarse this search is — printed so a number is read for what it is.
 *
 * The second line is the one the owner asked for out loud: over-reporting is
 * the safe direction, and it is still not precision.
 */
export const SEARCH_LIMITS: readonly string[] = [
  "the subject id is matched on subject-alphabet boundaries, so `demo` is not found inside " +
    "`demonstration`. A path segment equal to the id counts as a hit on its own.",
  "every other needle — a soul's name, anything passed as --needle — is a plain substring " +
    "search. Thai and other scripts without a word boundary will over-report: `หนู` matches " +
    "inside longer words. That errs towards finding too much rather than too little, which is " +
    "the safe side for a deletion check and is not the same thing as being accurate.",
  "the text of a --needle is counted and never printed. Echoing it would put the thing somebody " +
    "asked to delete into scrollback and into the certificate.",
  "a file is read as bytes and never parsed, so a needle split across two lines is not found.",
];
