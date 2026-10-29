/**
 * S22.8 AC3 (D-197) — one git worktree per task, and no writing turn started on `main`.
 *
 * A fleet bot that changes a repository does it in a worktree of its own, on a branch of its own, so two bots never
 * share a checkout and nothing is ever written on `main` (workspace git rules). Mind makes that the easy path rather than
 * a request: `mind task new --worktree <repo>` makes the worktree and points the task's working directory at it.
 *
 * What this does not do: it does not stop a bot that was started somewhere else from running `git checkout main`
 * or editing a file in the main checkout with an absolute path. The check at turn time looks at the directory the turn
 * starts in, and says so. Nothing here deletes a worktree: removing them after a merged batch stays a person's act.
 *
 * Git is run through the `run` argument, so a test hands in a real repository and a refusal needs no mock.
 */

import { basename, dirname, join, resolve } from "node:path";
import { runGuarded } from "../spawn.ts";

export interface GitRun {
  (argv: readonly string[], cwd: string): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
}

/** The production runner: Mind's guarded spawn, which refuses every git verb outside its allowlist (`src/spawn.ts`). */
export const guardedGit: GitRun = async (argv, cwd) => {
  try {
    const result = await runGuarded(argv, { cwd });
    return { code: result.code, stdout: new TextDecoder().decode(result.stdout), stderr: result.stderr };
  } catch (cause) {
    // No git on PATH, or a refused verb: reported as a failed run, never thrown into a turn. Without git there is no
    // branch to read, so {@link protectedBranchAt} says nothing; creating a worktree says why it could not.
    return { code: 127, stdout: "", stderr: cause instanceof Error ? cause.message.split("\n")[0] ?? "git could not be run" : "git could not be run" };
  }
};

export interface TaskWorktree {
  /** The repository's top directory, as git reports it. */
  readonly repo: string;
  readonly path: string;
  readonly branch: string;
  readonly base: string;
}

export type WorktreeResult =
  | { readonly ok: true; readonly worktree: TaskWorktree }
  | { readonly ok: false; readonly reason: string };

/** Branches a writing turn is not started on. */
export const PROTECTED_BRANCHES: readonly string[] = ["main", "master"];

/** The branch a task's worktree gets: the repo's own `<type>/<taskId>` form. */
export function worktreeBranch(taskId: string): string {
  return `feat/${taskId}`;
}

/**
 * Where worktrees go when the person did not say: the workspace's `worktrees/`, which sits beside `projects/` when
 * the repository is `<workspace>/projects/<repo>`. Any other layout has no default, and the person is asked.
 */
export function defaultWorktreeRoot(repo: string): string | undefined {
  const parent = dirname(repo);
  return basename(parent) === "projects" ? join(dirname(parent), "worktrees") : undefined;
}

const firstLine = (text: string): string => text.split("\n")[0]?.trim() ?? "";

/** Make the worktree for a task, or say why not. Nothing is left behind on a refusal. */
export async function createTaskWorktree(
  input: { readonly repo: string; readonly root: string; readonly taskId: string; readonly base: string },
  run: GitRun,
): Promise<WorktreeResult> {
  const top = await run(["git", "rev-parse", "--show-toplevel"], input.repo);
  if (top.code !== 0) return { ok: false, reason: `${input.repo} is not inside a git repository` };
  const repo = firstLine(top.stdout);
  const base = await run(["git", "rev-parse", "--verify", "--quiet", `${input.base}^{commit}`], repo);
  if (base.code !== 0) return { ok: false, reason: `the base ${JSON.stringify(input.base)} is not a commit in ${repo} (--base names it)` };
  const path = resolve(input.root, `${basename(repo)}-${input.taskId}`);
  const branch = worktreeBranch(input.taskId);
  const added = await run(["git", "worktree", "add", path, "-b", branch, input.base], repo);
  if (added.code !== 0) return { ok: false, reason: `git worktree add failed: ${firstLine(added.stderr) || "no message"}` };
  return { ok: true, worktree: { repo, path, branch, base: input.base } };
}

/** The protected branch `cwd` is on, or `undefined` — not a repository, a detached HEAD, or any other branch. */
export async function protectedBranchAt(cwd: string, run: GitRun): Promise<string | undefined> {
  // `rev-parse --abbrev-ref` rather than `symbolic-ref`: Mind may run the one and not the other (src/spawn.ts), and
  // it says `HEAD` for a detached head, which is on no protected branch.
  const head = await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (head.code !== 0) return undefined;
  const branch = firstLine(head.stdout);
  return PROTECTED_BRANCHES.includes(branch) ? branch : undefined;
}
