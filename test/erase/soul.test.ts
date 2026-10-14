/**
 * "soul" is three locations on this machine, and this file is the evidence.
 *
 * The finding that shaped w3: `soul apply` writes an identity into more places
 * than the directory it read it from. Removing `<agent>/soul/` and stopping
 * would leave two working copies of the thing somebody just asked to have
 * deleted — the block inside every vendor instruction file, and the *backups*
 * Mind itself took before those writes, in which a later backup contains the
 * block an earlier apply wrote. The test at the bottom of this file is the one
 * the owner asked for: prove all three go, rather than believing it.
 *
 * Two properties are worth more than the mechanism:
 *
 * - **Somebody else's file survives.** The block is delimited; `strip` is
 *   `apply`'s own inverse and this module calls it rather than writing a second
 *   remover. A block whose body was edited by hand refuses, and the refusal
 *   stops the run — S1.5 `soul revoke` is specified to reuse the same function,
 *   so there will never be two answers to "what does removing a block mean".
 * - **Another identity's block is not touched** (I-3). Only markers that name
 *   this subject are removed, and the file holding somebody else's is byte
 *   identical afterwards.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupTree,
  commitBlocks,
  derivedTree,
  manifestTargets,
  personFile,
  planBlocks,
  soulTree,
} from "../../src/erase/soul.ts";
import { splice } from "../../src/soul/block.ts";
import { subjectId } from "../../src/types.ts";

const SUBJECT = subjectId("example");
const OTHER = subjectId("somebody-else");

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-erase-soul-"));
  scratch.push(dir);
  return dir;
}

/** A vendor instruction file with a human's text and one Mind block in it. */
async function withBlock(path: string, subject: typeof SUBJECT, human: string): Promise<string> {
  const spliced = splice(human, { subject, body: `# identity\n\nsubject ${subject}` });
  if (spliced.kind !== "spliced") throw new Error(spliced.reason);
  await Bun.write(path, spliced.next);
  return spliced.next;
}

// ---------------------------------------------------------------------------
// The addresses
// ---------------------------------------------------------------------------

describe("the three locations, named once each", () => {
  test("they are derived from the agent directory and the state root, not guessed", () => {
    const env = { home: "/nowhere", env: { XDG_STATE_HOME: "/nowhere/state" } };

    expect(soulTree("/a")).toBe(join("/a", "soul"));
    expect(derivedTree("/a")).toBe(join("/a", ".mind"));
    expect(personFile("/a")).toBe(join("/a", "soul", "person.md"));
    expect(backupTree(env, SUBJECT)).toBe(join("/nowhere/state", "mind", "backups", SUBJECT));
    // I-3: two subjects never share a backup tree.
    expect(backupTree(env, OTHER)).not.toBe(backupTree(env, SUBJECT));
  });
});

// ---------------------------------------------------------------------------
// The backup manifests — the source of the files the registry no longer knows
// ---------------------------------------------------------------------------

describe("manifestTargets", () => {
  test("it unions every file every manifest ever named, sorted and deduplicated", async () => {
    const root = await sandbox();
    await Bun.write(
      join(root, "20260101T000000000Z", "manifest.json"),
      JSON.stringify({ files: [{ path: "/h/CLAUDE.md" }, { path: "/h/AGENTS.md" }] }),
    );
    await Bun.write(
      join(root, "20260202T000000000Z", "manifest.json"),
      // The same file again, plus one from a CLI uninstalled since — which is
      // the case the registry-driven list cannot produce.
      JSON.stringify({ files: [{ path: "/h/CLAUDE.md" }, { path: "/h/.kimi/KIMI.md" }] }),
    );

    const found = await manifestTargets(root);
    expect(found.paths).toEqual(["/h/.kimi/KIMI.md", "/h/AGENTS.md", "/h/CLAUDE.md"]);
    expect(found.unreadable).toEqual([]);
  });

  test("a manifest that cannot be read is reported, not thrown", async () => {
    const root = await sandbox();
    await Bun.write(join(root, "20260101T000000000Z", "manifest.json"), "{not json");
    await Bun.write(join(root, "20260202T000000000Z", "manifest.json"), JSON.stringify({ files: 7 }));
    await Bun.write(join(root, "20260303T000000000Z", "manifest.json"), JSON.stringify({ files: [{}] }));

    const found = await manifestTargets(root);
    expect(found.paths).toEqual([]);
    // A year-old malformed backup is not a reason to refuse an erase; it is a
    // reason to say which files may still hold a block.
    expect(found.unreadable.length).toBe(2);
  });

  test("a backup tree that was never created is empty, not an error", async () => {
    const root = await sandbox();
    expect(await manifestTargets(join(root, "never"))).toEqual({ paths: [], unreadable: [] });
  });
});

// ---------------------------------------------------------------------------
// The blocks
// ---------------------------------------------------------------------------

describe("planBlocks", () => {
  test("a link is refused, never followed or renamed over (review 2026-09-27)", async () => {
    const root = await sandbox();
    const real = join(root, "real.md");
    await withBlock(real, SUBJECT, "# notes\n");
    const { symlink } = await import("node:fs/promises");
    await symlink(real, join(root, "link.md"));
    const [plan] = await planBlocks([join(root, "link.md")], SUBJECT);
    expect(plan!.outcome).toBe("refused");
    expect(plan!.reason).toContain("a symbolic link");
  });

  test("this subject's block is planned out, and the human's text is what is left", async () => {
    const root = await sandbox();
    const path = join(root, "CLAUDE.md");
    await withBlock(path, SUBJECT, "# my own notes\n\nkeep this.\n");

    const [plan] = await planBlocks([path], SUBJECT);
    expect(plan!.outcome).toBe("strip");
    expect(plan!.next).toBe("# my own notes\n\nkeep this.\n");
  });

  test("another subject's block is left alone, and says so (I-3)", async () => {
    const root = await sandbox();
    const path = join(root, "CLAUDE.md");
    const before = await withBlock(path, OTHER, "# notes\n");

    const [plan] = await planBlocks([path], SUBJECT);
    expect(plan!.outcome).toBe("other-subject");
    expect(plan!.reason).toContain(OTHER);
    expect(plan!.next).toBeUndefined();
    expect(await Bun.file(path).text()).toBe(before);
  });

  test("a hand-edited block refuses, rather than deleting what a human wrote", async () => {
    const root = await sandbox();
    const path = join(root, "CLAUDE.md");
    const written = await withBlock(path, SUBJECT, "# notes\n");
    await Bun.write(path, written.replace("# identity", "# identity, and a line I added"));

    const [plan] = await planBlocks([path], SUBJECT);
    expect(plan!.outcome).toBe("refused");
    expect(plan!.reason).toContain("edited by hand");
  });

  test("a file with no block, and a file that is not there, are both `absent`", async () => {
    const root = await sandbox();
    await Bun.write(join(root, "plain.md"), "# just a file\n");

    const plans = await planBlocks([join(root, "plain.md"), join(root, "missing.md")], SUBJECT);
    expect(plans.map((plan) => plan.outcome)).toEqual(["absent", "absent"]);
  });

  test("a directory, and bytes that are not text, are refused rather than rewritten", async () => {
    const root = await sandbox();
    await Bun.write(join(root, "binary.md"), new Uint8Array([0xff, 0xfe, 0x00]));

    const plans = await planBlocks([root, join(root, "binary.md")], SUBJECT);
    expect(plans.map((plan) => plan.outcome)).toEqual(["refused", "refused"]);
    expect(plans[1]!.reason).toContain("UTF-8");
  });

  test("a marker Mind cannot parse refuses rather than guessing its extent", async () => {
    const root = await sandbox();
    const path = join(root, "new.md");
    await Bun.write(path, "# notes\n<!-- mind:soul:begin what=is-this -->\n");

    const [plan] = await planBlocks([path], SUBJECT);
    expect(plan!.outcome).toBe("refused");
  });

  test("the same file named twice is planned once", async () => {
    const root = await sandbox();
    const path = join(root, "CLAUDE.md");
    await withBlock(path, SUBJECT, "# notes\n");

    // The registry and a backup manifest routinely name the same file.
    const plans = await planBlocks([path, path], SUBJECT);
    expect(plans.length).toBe(1);
  });
});

describe("commitBlocks", () => {
  test("it removes the block, keeps the mode, and leaves every other byte", async () => {
    const root = await sandbox();
    const path = join(root, "CLAUDE.md");
    await withBlock(path, SUBJECT, "# my own notes\n\nkeep this.\n");
    await chmod(path, 0o640);

    const results = await commitBlocks(await planBlocks([path], SUBJECT));
    expect(results).toEqual([{ path, outcome: "strip", removed: true }]);
    expect(await Bun.file(path).text()).toBe("# my own notes\n\nkeep this.\n");
    expect((await stat(path)).mode & 0o777).toBe(0o640);
  });

  test("everything it was not asked to strip is reported and untouched", async () => {
    const root = await sandbox();
    const mine = join(root, "CLAUDE.md");
    const theirs = join(root, "AGENTS.md");
    await withBlock(mine, SUBJECT, "# a\n");
    const theirsBefore = await withBlock(theirs, OTHER, "# b\n");

    const results = await commitBlocks(await planBlocks([mine, theirs], SUBJECT));
    expect(results.filter((result) => result.removed).map((result) => result.path)).toEqual([mine]);
    expect(results.find((result) => result.path === theirs)!.outcome).toBe("other-subject");
    expect(await Bun.file(theirs).text()).toBe(theirsBefore);
  });

  test("the control: a file that cannot be written is reported as refused, not as removed", async () => {
    const root = await sandbox();
    const locked = join(root, "locked");
    const path = join(locked, "CLAUDE.md");
    await withBlock(path, SUBJECT, "# notes\n");
    const before = await Bun.file(path).text();
    // Renaming a temp file over it needs write on the *directory*.
    await chmod(locked, 0o500);

    try {
      const results = await commitBlocks(await planBlocks([path], SUBJECT));
      expect(results[0]!.removed).toBe(false);
      expect(results[0]!.outcome).toBe("refused");
      expect(await Bun.file(path).text()).toBe(before);
    } finally {
      await chmod(locked, 0o700);
    }
  });
});
