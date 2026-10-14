/**
 * What git keeps after somebody deletes a file — said before the commit, not
 * after the regret.
 *
 * `ledger forget` already carries this shape: {@link UNDELETABLE} in
 * `src/ledger/store.ts` is printed on every run, including the dry one, because
 * a promise of deletion that quietly excludes the vendor's copy is worse than
 * no promise. S0.4 AC5 asks for the same honesty about git, and the timing is
 * the part that matters: `erase` (S7.2) has not been written yet, and even when
 * it is, the moment to tell somebody that a commit is forever is *before* they
 * make it. So {@link GIT_UNDELETABLE} is printed by `mind new` and by
 * `mind guard status`, which are the two commands that run before the first
 * commit and after it.
 *
 * **That half of AC5 is closed as of S7.2 (w3).** `mind erase` prints this
 * same array — by importing it through `src/erase/places.ts`, which holds it by
 * reference on the `soul` place, so a test can assert `toBe` and a second copy
 * of the words cannot appear. The command also says what it did *not* search,
 * and git objects are the first line of that list: the commit count comes from
 * {@link historyFacts}, and the object database is never grepped, because a
 * zero there would need a history rewrite to become true and Mind does not
 * rewrite history.
 *
 * Three moments now print this list rather than two: `mind new` (before
 * anything is committable), `mind guard status` (after), and every run of
 * `mind erase`, including the dry one.
 */

import { SpawnRefused, runGuarded } from "../spawn.ts";

/**
 * What a commit puts beyond Mind's reach. Printed, never only documented.
 *
 * The last line is the one people are most surprised by and the reason Mind
 * does not offer to rewrite history: a rewrite fixes this copy of the
 * repository and no other, and "no other" includes the copy on a host that has
 * already made its own.
 */
export const GIT_UNDELETABLE: readonly string[] = [
  "A commit is not undone by deleting the file and committing again. The old blob stays " +
    "reachable from the old commit, and `git log -p` still prints it.",
  "Rewriting history (`git filter-repo`, `git rebase`) changes this clone only, and even here the " +
    "original objects survive in the reflog and in packfiles until they are garbage-collected.",
  "Every clone anybody has taken, and every remote it was ever pushed to, keeps its own copy. " +
    "Mind cannot reach any of them.",
  "A host that received a push may hold forks, pull requests, caches and backups of objects that " +
    "are no longer in your branch. Those are the host's to delete, on the host's timetable.",
  "Mind does not rewrite history for you. A tool that offered to would be claiming the four " +
    "lines above are not true.",
];

/** One configured remote, as `remote.<name>.url` gives it. */
export interface Remote {
  readonly name: string;
  readonly url: string;
}

/**
 * What is knowable about a repository without asking anything on the network.
 *
 * A union, and the second arm is odd2's H3. This used to be one shape with a
 * `commits: number`, and `git rev-list` failing produced `commits: 0,
 * remotes: []` — the same answer as a repository that has neither. Three
 * callers read it; two of them happened to be protected by something else, and
 * the third printed `git 0 commit(s) · no remote configured` onto an erase
 * certificate.
 *
 * The dangerous direction is not the one it is easy to imagine. A directory
 * that is plainly no repository is caught by a dozen other things. What is not
 * caught is a **real repository, with history and a remote, that git refuses to
 * read**: a corrupt `.git/config` (measured: every git command exits 128), or
 * `safe.directory` declining a checkout owned by another uid, which is the
 * ordinary state inside a container or under `sudo`. `.git` is right there, so
 * every "is this a repository?" test passes — and the document then says zero
 * about a history that is not zero. A certificate that claims *less* than the
 * truth about what git kept is the exact failure S0.4 AC5 is written against.
 *
 * So "could not look" is a state of its own, and the compiler makes all three
 * callers deal with it.
 *
 * `no-git` is the third of those and arrived with dod1. Every arm above assumes
 * a `git` process ran and said something; on a machine with no git at all there
 * is no exit code to read, because the chokepoint in `src/spawn.ts` throws
 * before any child exists. That machine is not hypothetical — it is the bare container the MVP-lite DoD
 * is *defined* by, where `git` is on the forbidden list on purpose, and where
 * `mind erase --agent` therefore exited 1 with a stack trace and deleted
 * nothing at all. I-4 says a withdrawal must not claim more than it did; a
 * withdrawal that crashes before it starts fails that from the other side.
 */
export type HistoryFacts =
  | {
      readonly readable: true;
      /** Commits reachable from HEAD. 0 only before the first commit. */
      readonly commits: number;
      readonly remotes: readonly Remote[];
    }
  | {
      readonly readable: false;
      /**
       * Which kind of "no", because they mean different things to a reader.
       *
       * `not-a-repository` is a fact about the path — there is nothing here to
       * count. `unreadable` is a fact about *this repository*: there may well be
       * a history and a remote, and git declined to show them. `no-git` is a
       * fact about **this machine**: nothing was asked, because there is no git
       * here to ask.
       *
       * The last two are both warnings and they are still not one arm, because
       * they send a reader to different places: `no-git` says install git and
       * ask again, `unreadable` says fix this repository's config or its
       * ownership. Folding them together would print one of those instructions
       * at somebody who needs the other — the same damage D-026 undid when it
       * split "we looked and found nothing" from "we never looked".
       */
      readonly why: "not-a-repository" | "unreadable" | "no-git";
      /** git's own words, so a reader can act on them. */
      readonly detail: string;
    };

/**
 * The runtime's words when there was no `git` to start, or `undefined`.
 *
 * Narrow on purpose, and matched on the message rather than on the error code,
 * because the code does not separate the two states (measured, bun 1.4.2,
 * 2026-09-22):
 *
 * | what is wrong | `error.code` | `error.message` |
 * |---|---|---|
 * | no git on `PATH` | `ENOENT` | `Executable not found in $PATH: "git"` |
 * | the cwd does not exist | `ENOENT` | `ENOENT: no such file or directory, posix_spawn 'git'` |
 * | the cwd is a file | `ENOTDIR` | `ENOTDIR: not a directory, posix_spawn 'git'` |
 *
 * So `code === "ENOENT"` would report *this machine has no git* for a directory
 * that is simply not there — a sentence sending a reader to install software
 * they already have, about a path they mistyped.
 *
 * Matching a message is brittle and the brittleness is deliberate: if a future
 * runtime words this differently, nothing matches, the error is rethrown, and
 * the caller crashes exactly as it did before dod1. That is loud and wrong in
 * the direction nobody acts on. A wider match would be quiet and wrong in the
 * direction somebody quotes.
 *
 * {@link SpawnRefused} is never this: it means Mind declined the argv, which
 * is a fact about Mind and not about the machine.
 */
function notInstalled(error: unknown): string | undefined {
  if (error instanceof SpawnRefused) return undefined;
  if (!(error instanceof Error)) return undefined;
  return /executable not found in \$path/i.test(error.message) ? error.message : undefined;
}

/** git's stderr, trimmed, or a stand-in when it said nothing. */
function said(bytes: Uint8Array | string): string {
  const text = (typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes)).trim();
  return text === "" ? "git printed nothing" : text;
}

/**
 * Count the commits and list the remotes, locally.
 *
 * Deliberately no network call and no visibility check. Whether a remote is
 * private is a question only the host can answer, Mind does not ask hosts
 * anything, and an unchecked "private" printed next to a URL would be the most
 * expensive sentence in this repository. `guard status` prints the URLs and
 * says it cannot see.
 *
 * Four git invocations rather than two, and each one is a question whose answer
 * this function would otherwise have had to guess (every exit code below is
 * measured, `git` 2.x, 2026-09-22):
 *
 * | state | `rev-parse --git-dir` | `--verify HEAD` | `rev-list` | `config --get-regexp` |
 * |---|---|---|---|---|
 * | not a repository | 128 | 128 | 128 | 1 |
 * | repository, no commit yet | **0** | **1** | 128 | 1 |
 * | repository with history | 0 | 0 | 0 | 0 (or 1 with no remote) |
 * | `.git/config` corrupt | 128 | 128 | 128 | **128** |
 * | **no git installed** | *throws* | — | — | — |
 *
 * The two columns that matter are the ones that separate an honest zero from a
 * refusal: `--verify HEAD` answers **1** for an unborn branch and 128 when git
 * could not look, and `config --get-regexp` answers **1** for "no remote is
 * configured" and 128 when it could not read the config. Collapsing either pair
 * is how the old shape reported zero for both.
 *
 * The last row has no exit code because there is no child to have one, and that
 * is why it needs the `try` below rather than another comparison.
 */
export async function historyFacts(repo: string): Promise<HistoryFacts> {
  // Is this a repository at all, asked of git rather than of the filesystem?
  // A `.git` directory is not the question: it is present and useless in every
  // unreadable case above.
  let dir;
  try {
    dir = await runGuarded(["git", "rev-parse", "--git-dir"], { cwd: repo });
  } catch (error) {
    const missing = notInstalled(error);
    if (missing === undefined) throw error;
    return { readable: false, why: "no-git", detail: missing };
  }
  if (dir.code !== 0) {
    const detail = said(dir.stderr);
    return {
      readable: false,
      why: /not a git repository/i.test(detail) ? "not-a-repository" : "unreadable",
      detail,
    };
  }

  // Before the first commit there is no HEAD, and that is an honest zero —
  // the state `mind new` leaves behind, since D-013 says the first commit is
  // the owner's to make. Exit 1 is that; anything else is git declining.
  // `hasCommit` in ./staged.ts asks the same question and answers a boolean,
  // which is right for its caller and would lose the distinction here.
  const head = await runGuarded(["git", "rev-parse", "--verify", "--quiet", "HEAD"], { cwd: repo });
  if (head.code !== 0 && head.code !== 1) {
    return { readable: false, why: "unreadable", detail: said(head.stderr) };
  }

  let commits = 0;
  if (head.code === 0) {
    const counted = await runGuarded(["git", "rev-list", "--count", "HEAD"], { cwd: repo });
    const parsed = Number(new TextDecoder().decode(counted.stdout).trim());
    if (counted.code !== 0 || !Number.isFinite(parsed)) {
      return { readable: false, why: "unreadable", detail: said(counted.stderr) };
    }
    commits = parsed;
  }

  const configured = await runGuarded(
    ["git", "config", "--get-regexp", "^remote\\..*\\.url$"],
    { cwd: repo },
  );
  // 1 is `git config`'s way of saying nothing matched, which here means no
  // remote is configured. Anything else is a config it could not read, and an
  // empty remote list would then be a claim rather than a reading.
  if (configured.code !== 0 && configured.code !== 1) {
    return { readable: false, why: "unreadable", detail: said(configured.stderr) };
  }

  const remotes = new TextDecoder()
    .decode(configured.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const space = line.indexOf(" ");
      const key = line.slice(0, space);
      return { name: key.slice("remote.".length, -".url".length), url: line.slice(space + 1) };
    });

  return { readable: true, commits, remotes };
}

/**
 * One line about what git holds, for a reader who is about to delete something.
 *
 * Shared by the three callers so that the unreadable case cannot be spelled
 * three ways, and so that no caller can accidentally print a number it does not
 * have. Never `0 commit(s)`: before the first commit there is a sentence for
 * that, and where nothing was counted there is a different sentence again.
 */
export function historySentence(facts: HistoryFacts): string {
  return capitalise(rawSentence(facts));
}

/** A sentence starts with a capital; every caller here begins one. */
function capitalise(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function rawSentence(facts: HistoryFacts): string {
  if (!facts.readable) {
    switch (facts.why) {
      case "not-a-repository":
        return `no git repository here, so no commit and no remote was counted (${facts.detail})`;
      case "unreadable":
        return (
          `git could not read this repository, so the commit count and the remote list are ` +
          `UNKNOWN — not zero. Whatever is in this history is still in it (${facts.detail})`
        );
      case "no-git":
        // Not "there is no history": nothing was asked, so whether this is a
        // repository at all is also unknown from here. The sentence has to
        // survive being quoted on a machine where it *was* one.
        return (
          `git is not installed on this machine, so nothing was asked and the commit count and ` +
          `the remote list are UNKNOWN — not zero. If there is a repository here, everything ` +
          `already committed to it is still in it (${facts.detail})`
        );
    }
  }
  const commits =
    facts.commits === 0
      ? "no commit yet — the first commit is the owner's to make (D-013)"
      : `${facts.commits} commit(s) already in this repository's history`;
  return facts.remotes.length === 0
    ? `${commits} · no remote is configured, which is not the same as nothing having been pushed`
    : `${commits} · ${facts.remotes.length} remote(s): ${facts.remotes.map((r) => r.name).join(", ")}`;
}
