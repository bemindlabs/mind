/**
 * Reading the index rather than the working tree — the difference a scanner
 * that got it wrong would never notice.
 *
 * `git add secret.md && $EDITOR secret.md` leaves a clean file on disk and a
 * dirty blob in the index, and a commit keeps the blob. Every test here is a
 * variation on that: the bytes this module returns have to be the bytes the
 * commit would carry, not the ones somebody can see.
 *
 * The other case with teeth is the first commit, where there is no HEAD to
 * diff against. Getting that wrong means the guard never runs on the one
 * commit that lays down everything a repository starts with.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitFailed, hasCommit, stagedBytes, stagedFiles, stagedPaths } from "../../src/guard/staged.ts";
import { git } from "../support/trap-git.ts";

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function repo(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "mind-staged-"));
  scratch.push(parent);
  const path = join(parent, "agent");
  expect((await git(parent, ["init", "-q", path])).code).toBe(0);
  return path;
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("what is staged, before and after the first commit", () => {
  test("before any commit, everything in the index is what is about to be committed", async () => {
    const agent = await repo();
    await writeFile(join(agent, "a.md"), "a\n");
    await writeFile(join(agent, "b.md"), "b\n");
    expect((await git(agent, ["add", "a.md"])).code).toBe(0);

    expect(await hasCommit(agent)).toBe(false);
    // `b.md` is on disk and not in the index, so it is not about to be
    // committed and is not scanned.
    expect(await stagedPaths(agent)).toEqual(["a.md"]);
  });

  test("after the first commit, only what changed is scanned again", async () => {
    const agent = await repo();
    await writeFile(join(agent, "a.md"), "a\n");
    await git(agent, ["add", "-A"]);
    expect((await git(agent, ["commit", "-q", "-m", "first"])).code).toBe(0);

    expect(await hasCommit(agent)).toBe(true);
    expect(await stagedPaths(agent)).toEqual([]);

    await writeFile(join(agent, "b.md"), "b\n");
    await git(agent, ["add", "b.md"]);
    expect(await stagedPaths(agent)).toEqual(["b.md"]);
  });

  test("a deletion is not a finding — nobody should be blocked from removing a secret", async () => {
    const agent = await repo();
    await writeFile(join(agent, "a.md"), "a\n");
    await git(agent, ["add", "-A"]);
    await git(agent, ["commit", "-q", "-m", "first"]);

    await unlink(join(agent, "a.md"));
    await git(agent, ["add", "-A"]);
    expect(await stagedPaths(agent)).toEqual([]);
  });
});

describe("the bytes are the staged ones", () => {
  test("editing a file after staging it does not change what is scanned", async () => {
    const agent = await repo();
    const path = join(agent, "a.md");
    await writeFile(path, "what was staged\n");
    await git(agent, ["add", "a.md"]);
    await writeFile(path, "what is on disk now\n");

    expect(text(await stagedBytes(agent, "a.md"))).toBe("what was staged\n");
    const files = await stagedFiles(agent);
    expect(files).toHaveLength(1);
    expect(text(files[0]!.bytes)).toBe("what was staged\n");
  });

  test("bytes come back as bytes, so a binary blob is still binary", async () => {
    const agent = await repo();
    await Bun.write(join(agent, "blob.bin"), new Uint8Array([0x00, 0x01, 0xff, 0xfe]));
    await git(agent, ["add", "-A"]);

    const files = await stagedFiles(agent);
    expect([...files[0]!.bytes]).toEqual([0x00, 0x01, 0xff, 0xfe]);
  });

  test("a path git does not have in its index is an error, not an empty file", async () => {
    const agent = await repo();
    // Silence is the dangerous answer here: an empty blob passes every rule.
    expect(stagedBytes(agent, "nothing.md")).rejects.toBeInstanceOf(GitFailed);
  });
});
