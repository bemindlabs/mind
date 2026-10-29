import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGuarded } from "../../src/spawn.ts";
import { createTaskWorktree, defaultWorktreeRoot, protectedBranchAt, worktreeBranch, type GitRun } from "../../src/task/worktree.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true });
});

const GIT_IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

/** The production runner: Mind's own guarded spawn, which refuses anything outside its git allowlist. */
const run: GitRun = async (argv, cwd) => {
  const result = await runGuarded(argv, { cwd, env: { ...process.env, ...GIT_IDENTITY } });
  return { code: result.code, stdout: new TextDecoder().decode(result.stdout), stderr: result.stderr };
};

/** The test's own setup, which may run verbs Mind itself may not (commit, add, checkout, init -b). */
async function plainGit(cwd: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...GIT_IDENTITY } });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  expect(code, stderr).toBe(0);
}

/** A real repository on `main` with one commit, under `<workspace>/projects/repo`, and the workspace's `worktrees/`. */
async function workspace() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "mind-worktree-")));
  scratch.push(root);
  const repo = join(root, "projects", "repo");
  await mkdir(repo, { recursive: true });
  await mkdir(join(root, "worktrees"));
  const git = (...args: string[]) => plainGit(repo, ...args);
  await git("init", "-q", "-b", "main");
  await writeFile(join(repo, "a.txt"), "one");
  await git("add", "a.txt");
  await git("commit", "-q", "-m", "one");
  return { root, repo, worktrees: join(root, "worktrees") };
}

describe("a worktree per task (S22.8 AC3)", () => {
  test("is made beside the repo's other worktrees, on a branch of its own, from main", async () => {
    const w = await workspace();
    const result = await createTaskWorktree({ repo: w.repo, root: w.worktrees, taskId: "t-0000abcd", base: "main" }, run);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.worktree.path).toBe(join(w.worktrees, "repo-t-0000abcd"));
    expect(result.worktree.branch).toBe(worktreeBranch("t-0000abcd"));
    expect(existsSync(join(result.worktree.path, "a.txt"))).toBe(true);
    const head = await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], result.worktree.path);
    expect(head.stdout.trim()).toBe("feat/t-0000abcd");
    // The main checkout is untouched and still on main.
    expect((await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], w.repo)).stdout.trim()).toBe("main");
  });

  test("two tasks get two worktrees, never a shared one", async () => {
    const w = await workspace();
    const a = await createTaskWorktree({ repo: w.repo, root: w.worktrees, taskId: "t-00000001", base: "main" }, run);
    const b = await createTaskWorktree({ repo: w.repo, root: w.worktrees, taskId: "t-00000002", base: "main" }, run);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.worktree.path).not.toBe(b.worktree.path);
  });

  test("refuses, leaving nothing behind: not a repository, a base that is not a commit, a path or branch already taken", async () => {
    const w = await workspace();
    const notRepo = await createTaskWorktree({ repo: w.root, root: w.worktrees, taskId: "t-00000003", base: "main" }, run);
    expect(notRepo.ok).toBe(false);
    const badBase = await createTaskWorktree({ repo: w.repo, root: w.worktrees, taskId: "t-00000004", base: "nope" }, run);
    expect(badBase.ok).toBe(false);
    if (!badBase.ok) expect(badBase.reason).toContain("is not a commit");
    expect(existsSync(join(w.worktrees, "repo-t-00000004"))).toBe(false);
    const first = await createTaskWorktree({ repo: w.repo, root: w.worktrees, taskId: "t-00000005", base: "main" }, run);
    expect(first.ok).toBe(true);
    const again = await createTaskWorktree({ repo: w.repo, root: w.worktrees, taskId: "t-00000005", base: "main" }, run);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toContain("git worktree add failed");
  });

  test("the default root is the workspace's worktrees/ for projects/<repo>, and there is none for another layout", () => {
    expect(defaultWorktreeRoot("/ws/projects/mind-dev")).toBe("/ws/worktrees");
    expect(defaultWorktreeRoot("/home/me/code/mind-dev")).toBeUndefined();
  });

  test("a turn starting on main or master is named, one on a task branch or outside a repository is not", async () => {
    const w = await workspace();
    expect(await protectedBranchAt(w.repo, run)).toBe("main");
    const made = await createTaskWorktree({ repo: w.repo, root: w.worktrees, taskId: "t-00000006", base: "main" }, run);
    if (!made.ok) throw new Error(made.reason);
    expect(await protectedBranchAt(made.worktree.path, run)).toBeUndefined();
    expect(await protectedBranchAt(w.root, run)).toBeUndefined();
    await plainGit(w.repo, "checkout", "-q", "-b", "master");
    expect(await protectedBranchAt(w.repo, run)).toBe("master");
    await plainGit(w.repo, "checkout", "-q", "--detach");
    expect(await protectedBranchAt(w.repo, run)).toBeUndefined();
  });
});

describe("guardedGit", () => {
  test("a git that cannot be started is a failed run, not an exception thrown into a turn", async () => {
    const { guardedGit } = await import("../../src/task/worktree.ts");
    const result = await guardedGit(["git", "status"], "/");
    expect(result.code).not.toBe(0);
    const refused = await guardedGit(["git", "push"], "/");
    expect(refused.code).toBe(127);
    expect(refused.stderr).toContain("not one of the verbs Mind may run");
  });
});
