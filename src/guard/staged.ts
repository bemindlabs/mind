/**
 * Reading the index: the bytes a commit would actually keep.
 *
 * Separate from `scan.ts` so that the rules stay a pure function of bytes and
 * this file stays the only part of the scan that needs a git process. It is
 * also the part with the awkward case in it, which is worth stating once
 * rather than discovering during somebody's first commit:
 *
 * **Before the first commit there is no HEAD to diff against.** `git diff
 * --cached` needs one. git's own sample pre-commit hook works around it with
 * the hash of the empty tree, which is a different hash in a SHA-256
 * repository; `git ls-files --cached` answers the same question — *what is in
 * the index* — without naming a hash at all, and before the first commit the
 * whole index is what is about to be committed. After it, `git diff --cached`
 * narrows to what changed, because a guard that re-reported every tracked file
 * on every commit would be a guard people turn off.
 *
 * Both paths go through {@link runGuarded}, so `git` here is subject to the
 * same verb allowlist as everywhere else (S0.4 AC2).
 */

import { runGuarded } from "../spawn.ts";
import type { StagedFile } from "./scan.ts";

const text = new TextDecoder("utf-8", { fatal: false });

/** A git command that failed, with the stderr that said why. */
export class GitFailed extends Error {
  constructor(
    readonly argv: readonly string[],
    readonly code: number,
    readonly detail: string,
  ) {
    super(`\`${argv.join(" ")}\` exited ${code}${detail === "" ? "" : `: ${detail}`}`);
    this.name = "GitFailed";
  }
}

async function git(repo: string, argv: readonly string[]): Promise<string> {
  const command = ["git", ...argv];
  const result = await runGuarded(command, { cwd: repo });
  if (result.code !== 0) throw new GitFailed(command, result.code, result.stderr);
  return text.decode(result.stdout);
}

/** Does this repository have a commit yet? */
export async function hasCommit(repo: string): Promise<boolean> {
  const result = await runGuarded(["git", "rev-parse", "--verify", "--quiet", "HEAD"], {
    cwd: repo,
  });
  return result.code === 0;
}

/**
 * What the scan asks git for: everything staged that carries bytes.
 *
 * **`T` is in this list and it was not.** A typechange is git's word for a path
 * whose mode changed between blob kinds — most usefully, a **symlink replaced
 * by a real file**. Measured on a real repository (2026-09-22): commit a
 * symlink, replace it with a regular file holding a token, `git add -A`, and
 * `--diff-filter=ACMR` returns *nothing at all* while `git cat-file blob :path`
 * hands back the token. Forty lines of scan rules over an empty list.
 *
 * Adding `T` makes the scan read strictly more than it did, which is the only
 * direction I-6 permits a change here to go.
 *
 * `D` stays out, and for a reason rather than an oversight: a file being
 * removed carries no bytes into the commit, and blocking somebody from deleting
 * a secret would be precisely backwards.
 */
const CARRIES_BYTES = "--diff-filter=ACMRT";

/** The repo-relative paths a commit right now would add or change. */
export async function stagedPaths(repo: string): Promise<readonly string[]> {
  const output = (await hasCommit(repo))
    ? await git(repo, ["diff", "--cached", "--name-only", "-z", CARRIES_BYTES])
    : await git(repo, ["ls-files", "--cached", "-z"]);

  return output.split("\0").filter((path) => path !== "");
}

/**
 * The paths staged for deletion — read only to explain an empty scan.
 *
 * A commit that only removes files reaches the scanner with nothing to read,
 * and the honest report of that is "nothing was scanned", not "18 rules
 * passed". Saying *how many* deletions there were is what turns that from a
 * puzzle into a sentence. Asked only when the scan list came back empty, so an
 * ordinary commit pays nothing for it.
 *
 * Empty before the first commit: there is no HEAD to have deleted anything from.
 */
export async function stagedDeletions(repo: string): Promise<readonly string[]> {
  if (!(await hasCommit(repo))) return [];
  const output = await git(repo, ["diff", "--cached", "--name-only", "-z", "--diff-filter=D"]);
  return output.split("\0").filter((path) => path !== "");
}

/** The staged bytes of one path — the blob, not whatever is on disk now. */
export async function stagedBytes(repo: string, path: string): Promise<Uint8Array> {
  const argv = ["git", "cat-file", "blob", `:${path}`];
  const result = await runGuarded(argv, { cwd: repo });
  if (result.code !== 0) throw new GitFailed(argv, result.code, result.stderr);
  return result.stdout;
}

/** Everything the index holds for the paths about to be committed. */
export async function stagedFiles(repo: string): Promise<readonly StagedFile[]> {
  const files: StagedFile[] = [];
  for (const path of await stagedPaths(repo)) {
    files.push({ path, bytes: await stagedBytes(repo, path) });
  }
  return files;
}
