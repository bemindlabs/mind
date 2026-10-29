/**
 * S21.5 (D-193) — the git half of `mind soul tune`, in plumbing only.
 *
 * A candidate soul is a commit on a branch of its own in the agent's repository, made without ever touching
 * the working tree, the index or HEAD: the base's tree gets one blob replaced (`role.md`), through a
 * temporary index file under the state root, and `commit-tree` + `update-ref` write the commit and the
 * branch. No checkout, no stash, no worktree, no hook and no smudge filter runs (the spawn guard's list, see
 * `src/spawn.ts`, is the only door; none of these verbs reaches a remote).
 *
 * Only {@link adoptCommit} and {@link moveHead} ever change the current branch, and only the adopt and undo
 * paths call them (S21.5 itself never does: adoption refuses until the tuner is proved, S21.7).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runGuarded } from "../../spawn.ts";
import { STATE_DIR_MODE } from "../../state.ts";

/** Where temporary index files and blobs wait, under the state root. Removed after each use. */
export const TUNE_SCRATCH = join("scratch", "tune");

export const ZERO = "0".repeat(40);

export interface Run {
  readonly code: number;
  readonly out: string;
  readonly bytes: Uint8Array;
  readonly err: string;
}

/**
 * One guarded git call; a missing binary or a refusal is code -1, never a throw. `env` is the child's whole
 * environment when given (the caller merges what it needs: this module reads no ambient state), else the child
 * inherits the process's own.
 */
export async function git(cwd: string, args: readonly string[], env?: Readonly<Record<string, string | undefined>>): Promise<Run> {
  try {
    const run = await runGuarded(["git", ...args], { cwd, ...(env === undefined ? {} : { env }) });
    return { code: run.code, bytes: run.stdout, out: new TextDecoder().decode(run.stdout).trim(), err: run.stderr };
  } catch (cause) {
    return { code: -1, bytes: new Uint8Array(), out: "", err: cause instanceof Error ? cause.message : String(cause) };
  }
}

export interface RepoFacts {
  /** The soul directory's path relative to the repository root, `""` or ending in `/`. */
  readonly prefix: string;
  /** The commit HEAD names. */
  readonly head: string;
  /** `HEAD`'s branch (`refs/heads/…`), or null on a detached HEAD. */
  readonly branch: string | null;
}

/** Where a soul directory sits in its repository, or why it does not sit in one. */
export async function repoFacts(soulDir: string): Promise<{ readonly ok: true; readonly facts: RepoFacts } | { readonly ok: false; readonly reason: string }> {
  const inside = await git(soulDir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.out !== "true") return { ok: false, reason: `${soulDir} is not in a git repository: a candidate soul is a branch, and the base must be a commit` };
  const prefix = await git(soulDir, ["rev-parse", "--show-prefix"]);
  const head = await git(soulDir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (prefix.code !== 0 || head.code !== 0 || head.out === "") return { ok: false, reason: "the agent repository has no commit yet: the base of a tune must be a commit" };
  const branch = await git(soulDir, ["rev-parse", "--symbolic-full-name", "HEAD"]);
  return { ok: true, facts: { prefix: prefix.out, head: head.out, branch: branch.out.startsWith("refs/heads/") ? branch.out : null } };
}

/** The bytes of `path` at `rev`, or null. */
export async function blobAt(cwd: string, rev: string, path: string): Promise<{ readonly sha: string; readonly text: string } | null> {
  const sha = await git(cwd, ["rev-parse", "--verify", "--quiet", `${rev}:${path}`]);
  if (sha.code !== 0 || sha.out === "") return null;
  const blob = await git(cwd, ["cat-file", "blob", sha.out]);
  return blob.code === 0 ? { sha: sha.out, text: new TextDecoder().decode(blob.bytes) } : null;
}

export interface Identity {
  readonly name: string;
  readonly email: string;
}

const identityEnv = (who: Identity, at: Date): Record<string, string> => {
  const when = `${Math.floor(at.getTime() / 1000)} +0000`;
  return { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_AUTHOR_DATE: when, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email, GIT_COMMITTER_DATE: when };
};

/** `text` written as a blob into the object store; its id. */
export async function writeBlob(cwd: string, stateRoot: string, text: string): Promise<string> {
  const scratch = join(stateRoot, TUNE_SCRATCH);
  await mkdir(scratch, { recursive: true, mode: STATE_DIR_MODE });
  const temp = await mkdtemp(join(scratch, "blob-"));
  try {
    const file = join(temp, "blob");
    await writeFile(file, text, { mode: 0o600 });
    const made = await git(cwd, ["hash-object", "-w", file]);
    if (made.code !== 0 || made.out === "") throw new Error(`git hash-object: ${made.err}`);
    return made.out;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export interface CommitInput {
  readonly cwd: string;
  readonly stateRoot: string;
  /** The commit whose tree is the starting point, and the new commit's parent. */
  readonly parent: string;
  /** The file to replace, relative to the repository root. */
  readonly path: string;
  /** The blob that goes there. */
  readonly blob: string;
  readonly message: string;
  readonly author: Identity;
  readonly at: Date;
  /** The environment git runs in (the caller's own, read in `bin/`); the throwaway index and the identity are added to it. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * A commit with the parent's tree but for one blob. The real index is never read or written: the new tree is
 * built in a throwaway index file.
 */
export async function commitWithBlob(input: CommitInput): Promise<string> {
  const scratch = join(input.stateRoot, TUNE_SCRATCH);
  await mkdir(scratch, { recursive: true, mode: STATE_DIR_MODE });
  const temp = await mkdtemp(join(scratch, "index-"));
  const env = { ...input.env, GIT_INDEX_FILE: join(temp, "index") };
  try {
    const must = async (args: readonly string[], extra: Record<string, string> = {}) => {
      const run = await git(input.cwd, args, { ...env, ...extra });
      if (run.code !== 0) throw new Error(`git ${args[0]}: ${run.err || `exit ${run.code}`}`);
      return run.out;
    };
    await must(["read-tree", input.parent]);
    const entry = await must(["ls-files", "--stage", "--", input.path]);
    const mode = /^(\d+) /.exec(entry)?.[1] ?? "100644";
    await must(["update-index", "--add", "--cacheinfo", `${mode},${input.blob},${input.path}`]);
    const tree = await must(["write-tree"]);
    return await must(["commit-tree", tree, "-p", input.parent, "-m", input.message], identityEnv(input.author, input.at));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/** Create `refs/heads/<name>` at `commit`; it must not exist. */
export async function createBranch(cwd: string, name: string, commit: string): Promise<void> {
  const run = await git(cwd, ["update-ref", `refs/heads/${name}`, commit, ZERO]);
  if (run.code !== 0) throw new Error(`git update-ref: ${run.err || `exit ${run.code}`}`);
}

/** Delete `refs/heads/<name>` if it still names `commit`. */
export async function deleteBranch(cwd: string, name: string, commit: string): Promise<void> {
  await git(cwd, ["update-ref", "-d", `refs/heads/${name}`, commit]);
}

/** The commit a branch names, or null. */
export async function branchCommit(cwd: string, name: string): Promise<string | null> {
  const run = await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`]);
  return run.code === 0 && run.out !== "" ? run.out : null;
}

/**
 * Move the current branch (or a detached HEAD) from `from` to `to`, then bring the index and working tree
 * with it (`read-tree -m -u`, which refuses to overwrite a file with local changes). If the working tree
 * cannot follow, the ref goes back and the error is thrown: nothing is left half done.
 */
export async function moveHead(cwd: string, from: string, to: string, reason: string): Promise<void> {
  const moved = await git(cwd, ["update-ref", "-m", reason, "HEAD", to, from]);
  if (moved.code !== 0) throw new Error(`git update-ref: ${moved.err || `exit ${moved.code}`}`);
  const tree = await git(cwd, ["read-tree", "-m", "-u", from, to]);
  if (tree.code !== 0) {
    await git(cwd, ["update-ref", "-m", `${reason} (undone)`, "HEAD", from, to]);
    throw new Error(`git read-tree: ${tree.err || `exit ${tree.code}`}`);
  }
}

/** Paths that differ between two commits, from `git diff --name-only`. */
export async function changedPaths(cwd: string, a: string, b: string): Promise<string[]> {
  const run = await git(cwd, ["diff", "--name-only", a, b]);
  return run.out === "" ? [] : run.out.split("\n");
}

/** The headers and message of a commit, from `git cat-file commit`. */
export async function readCommit(cwd: string, commit: string): Promise<{ readonly tree: string; readonly parents: readonly string[]; readonly authorEmail: string; readonly message: string } | null> {
  const run = await git(cwd, ["cat-file", "commit", commit]);
  if (run.code !== 0) return null;
  const text = new TextDecoder().decode(run.bytes);
  const cut = text.indexOf("\n\n");
  const head = (cut === -1 ? text : text.slice(0, cut)).split("\n");
  const message = cut === -1 ? "" : text.slice(cut + 2);
  const tree = head.find((l) => l.startsWith("tree "))?.slice(5) ?? "";
  const parents = head.filter((l) => l.startsWith("parent ")).map((l) => l.slice(7));
  const author = /^author .*<([^>]*)>/m.exec(head.join("\n"))?.[1] ?? "";
  return { tree, parents, authorEmail: author, message };
}

/** The most recent commits reachable from HEAD, newest first. */
export async function recentCommits(cwd: string, limit: number): Promise<string[]> {
  const run = await git(cwd, ["rev-list", `--max-count=${limit}`, "HEAD"]);
  return run.out === "" ? [] : run.out.split("\n");
}
