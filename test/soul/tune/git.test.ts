/** S21.5 — the git plumbing: candidates without a checkout, and the guard's list. */

import { afterEach, describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { refusal } from "../../../src/spawn.ts";
import { TUNE_SCRATCH, blobAt, branchCommit, changedPaths, commitWithBlob, createBranch, deleteBranch, git, moveHead, readCommit, recentCommits, repoFacts, writeBlob } from "../../../src/soul/tune/git.ts";
import { GIT_ENV, g, makeFixture, repoState, type Fixture } from "../../support/tune-fixture.ts";

const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});
const fx = async () => {
  const f = await makeFixture();
  fixtures.push(f);
  return f;
};
const who = { name: "Example Keeper (Mind agent)", email: "example@agents.mind.invalid" };

describe("the guard's list", () => {
  test("the plumbing verbs are let through; every way to a remote is still refused", () => {
    for (const verb of ["hash-object", "read-tree", "update-index", "write-tree", "commit-tree", "update-ref"]) expect(refusal(["git", verb])).toBeUndefined();
    for (const verb of ["push", "fetch", "pull", "clone", "remote", "commit", "checkout", "stash", "worktree", "revert", "reset", "branch", "merge"]) expect(refusal(["git", verb])).toBeDefined();
    expect(refusal(["git", "-C", "/x", "update-ref"])).toBeDefined();
    expect(refusal(["git", "-c", "alias.x=push", "update-ref"])).toBeDefined();
  });
});

describe("plumbing", () => {
  test("repoFacts: the prefix, HEAD and the branch; and why a directory is not a base", async () => {
    const f = await fx();
    const r = await repoFacts(f.soulDir);
    expect(r).toMatchObject({ ok: true, facts: { prefix: "soul/", head: f.head, branch: expect.stringMatching(/^refs\/heads\//) } });
    expect(await repoFacts(f.home)).toMatchObject({ ok: false });
    await g(f.agent, "checkout", "-q", "--detach");
    expect(await repoFacts(f.soulDir)).toMatchObject({ ok: true, facts: { branch: null } });
    await g(f.agent, "checkout", "-q", "-");
    await Bun.$`rm -rf ${join(f.agent, ".git")} && git init -q ${f.agent}`.quiet();
    expect(await repoFacts(f.soulDir)).toMatchObject({ ok: false, reason: expect.stringContaining("no commit yet") });
  });

  test("a commit with one blob replaced, a branch, and nothing else touched: scratch is gone, HEAD, index and tree as they were", async () => {
    const f = await fx();
    const before = await repoState(f);
    const blob = await writeBlob(f.agent, f.state, "new role\n");
    expect(await g(f.agent, "cat-file", "blob", blob)).toBe("new role");
    const commit = await commitWithBlob({ cwd: f.agent, stateRoot: f.state, parent: f.head, path: "soul/role.md", blob, message: "m\n", author: who, at: new Date("2026-10-20T08:00:00Z"), env: GIT_ENV });
    expect(await changedPaths(f.agent, f.head, commit)).toEqual(["soul/role.md"]);
    expect(await g(f.agent, "log", "-1", "--format=%an|%ae|%cn|%at", commit)).toBe(`${who.name}|${who.email}|${who.name}|1792483200`);
    await createBranch(f.agent, "tune/x", commit);
    expect(await branchCommit(f.agent, "tune/x")).toBe(commit);
    await expect(createBranch(f.agent, "tune/x", f.head)).rejects.toThrow("update-ref");
    expect(await repoState(f)).toBe(before);
    expect(await readdir(join(f.state, TUNE_SCRATCH))).toEqual([]);
    expect(await readFile(join(f.soulDir, "role.md"), "utf8")).toBe(f.baseRole);
    await deleteBranch(f.agent, "tune/x", f.head);
    expect(await branchCommit(f.agent, "tune/x")).toBe(commit);
    await deleteBranch(f.agent, "tune/x", commit);
    expect(await branchCommit(f.agent, "tune/x")).toBeNull();
  });

  test("a file's mode is kept, and a new path is added", async () => {
    const f = await fx();
    await Bun.write(join(f.soulDir, "run.sh"), "#!/bin/sh\n");
    await Bun.$`chmod 755 ${join(f.soulDir, "run.sh")}`.quiet();
    await g(f.agent, "add", "-A");
    await g(f.agent, "commit", "-qm", "script");
    const head = await g(f.agent, "rev-parse", "HEAD");
    const blob = await writeBlob(f.agent, f.state, "#!/bin/sh\necho\n");
    const c = await commitWithBlob({ cwd: f.agent, stateRoot: f.state, parent: head, path: "soul/run.sh", blob, message: "m", author: who, at: new Date(), env: GIT_ENV });
    expect(await g(f.agent, "ls-tree", c, "soul/run.sh")).toStartWith("100755");
    const added = await commitWithBlob({ cwd: f.agent, stateRoot: f.state, parent: head, path: "soul/new.md", blob, message: "m", author: who, at: new Date(), env: GIT_ENV });
    expect(await changedPaths(f.agent, head, added)).toEqual(["soul/new.md"]);
  });

  test("moveHead brings the index and tree along, and puts the ref back when it cannot", async () => {
    const f = await fx();
    const blob = await writeBlob(f.agent, f.state, "moved\n");
    const commit = await commitWithBlob({ cwd: f.agent, stateRoot: f.state, parent: f.head, path: "soul/role.md", blob, message: "m", author: who, at: new Date(), env: GIT_ENV });
    await moveHead(f.agent, f.head, commit, "test");
    expect(await readFile(join(f.soulDir, "role.md"), "utf8")).toBe("moved\n");
    expect(await g(f.agent, "status", "--porcelain")).toBe("");
    // A stale `from`: the ref is not moved.
    await expect(moveHead(f.agent, f.head, commit, "stale")).rejects.toThrow("update-ref");
    // A working-tree file the move would overwrite: refused, and HEAD goes back.
    const back = await commitWithBlob({ cwd: f.agent, stateRoot: f.state, parent: commit, path: "soul/role.md", blob: await writeBlob(f.agent, f.state, "again\n"), message: "m", author: who, at: new Date(), env: GIT_ENV });
    await Bun.write(join(f.soulDir, "role.md"), "local edit\n");
    await expect(moveHead(f.agent, commit, back, "dirty")).rejects.toThrow("read-tree");
    expect(await g(f.agent, "rev-parse", "HEAD")).toBe(commit);
  });

  test("blobAt, readCommit, recentCommits and failures that are values, not throws", async () => {
    const f = await fx();
    expect(await blobAt(f.agent, "HEAD", "soul/role.md")).toMatchObject({ text: f.baseRole });
    expect(await blobAt(f.agent, "HEAD", "nope")).toBeNull();
    const c = await readCommit(f.agent, f.head);
    expect(c).toMatchObject({ parents: [], authorEmail: "owner@example.test", message: "the soul\n" });
    expect(await readCommit(f.agent, "0".repeat(40))).toBeNull();
    expect(await recentCommits(f.agent, 5)).toEqual([f.head]);
    expect(await recentCommits(f.home, 5)).toEqual([]);
    expect((await git(f.agent, ["push"])).code).toBe(-1);
    await expect(writeBlob(join(f.home, "nowhere"), f.state, "x")).rejects.toThrow();
  });
});
