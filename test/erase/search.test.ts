/**
 * AC3 — "ค้นตัวระบุของ subject ทั้งระบบได้ 0 ผลลัพธ์", and the definition of
 * *ทั้งระบบ* that has to be printed beside the zero.
 *
 * Two kinds of test here, and they are about different failures.
 *
 * The first kind is precision: `demo` must be found in `subject = "demo"` and
 * not in `demonstration`, because a search that fires on every longer word
 * makes every run report a remainder and teaches whoever reads it to ignore the
 * number. The subject alphabet is `[a-z0-9_-]`, so that is where the boundary
 * comes from — not `\b`, which would split on the dash a subject id may
 * legitimately contain.
 *
 * The second kind is honesty about what this cannot do. Free text has no
 * boundary to take, Thai has no word boundary at all, and the assertions at the
 * bottom hold `SEARCH_LIMITS` to saying so — because the alternative is a
 * count somebody reads as precise. The same tests hold `NOT_SEARCHED` to naming
 * vendor transcripts and git objects, which is where the data actually is on
 * the day somebody is disappointed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  linesMatching,
  nameMatches,
  NOT_SEARCHED,
  SEARCH_LIMITS,
  SEARCHED,
  searchFiles,
  searchScopes,
  searchTree,
  type Needle,
} from "../../src/erase/search.ts";

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-erase-search-"));
  scratch.push(dir);
  return dir;
}

const ID: Needle = { label: "subject id", text: "demo", boundary: true, quotable: true };
const FREE: Needle = { label: "--needle #1", text: "หนู", boundary: false, quotable: false };

// ---------------------------------------------------------------------------
// The boundary rule
// ---------------------------------------------------------------------------

describe("an identifier, matched on the alphabet it is allowed to use", () => {
  test("it is found where it stands alone, whatever punctuation is around it", () => {
    expect(linesMatching(`subject = "demo"`, ID)).toEqual([1]);
    expect(linesMatching(`/home/x/demo/soul`, ID)).toEqual([1]);
    expect(linesMatching(`demo`, ID)).toEqual([1]);
    expect(linesMatching(`{"subject":"demo","at":1}`, ID)).toEqual([1]);
    expect(linesMatching(`a\nb\ndemo\n`, ID)).toEqual([3]);
  });

  test("it is not found inside a longer word built from the same alphabet", () => {
    expect(linesMatching(`demonstration`, ID)).toEqual([]);
    expect(linesMatching(`a-demo-agent`, ID)).toEqual([]);
    expect(linesMatching(`demo_2`, ID)).toEqual([]);
    expect(linesMatching(`predemo`, ID)).toEqual([]);
    // `\b` would have matched this one, which is why the rule is the subject
    // alphabet and not a word boundary: a dash is legal inside a subject id.
    expect(linesMatching(`demo-two`, ID)).toEqual([]);
  });

  test("a line holding it twice is reported once — a line is the unit", () => {
    expect(linesMatching(`demonstration and demo`, ID)).toEqual([1]);
  });

  test("free text has no boundary, and over-reports on purpose", () => {
    // The owner's ruling: erring towards finding too much is the safe side for
    // a deletion check, and it is still not precision.
    expect(linesMatching(`หนู`, FREE)).toEqual([1]);
    expect(linesMatching(`หนูน้อยหมวกแดง`, FREE)).toEqual([1]);
    expect(SEARCH_LIMITS.join("\n")).toContain("over-report");
  });

  test("an empty needle matches nothing, rather than every line", () => {
    expect(linesMatching(`anything`, { ...ID, text: "" })).toEqual([]);
  });

  test("a name that *is* the identifier counts; a path that contains one does not", () => {
    expect(nameMatches("demo", ID)).toBe(true);
    expect(nameMatches("demo.jsonl", ID)).toBe(false);
    expect(nameMatches("demo", FREE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Over a tree
// ---------------------------------------------------------------------------

describe("searchTree", () => {
  test("it reads bytes, reports file:line, and names a directory that is the id", async () => {
    const root = await sandbox();
    await Bun.write(join(root, "notes.md"), "nothing here\nsubject = \"demo\"\n");
    await Bun.write(join(root, "demo", "inner.txt"), "unrelated\n");
    await Bun.write(join(root, "clean.txt"), "demonstration only\n");

    const found = await searchTree("tree", root, [ID]);

    expect(found.filesRead).toBe(3);
    expect(found.hits.filter((hit) => !hit.inName)).toEqual([
      { path: join(root, "notes.md"), line: 2, needle: "subject id", inName: false },
    ]);
    expect(found.hits.filter((hit) => hit.inName).map((hit) => hit.path)).toEqual([
      join(root, "demo"),
    ]);
  });

  test("it never descends into .git — history is disclosed, not searched", async () => {
    const root = await sandbox();
    await Bun.write(join(root, ".git", "objects", "blob"), "demo\n");
    await Bun.write(join(root, "kept.md"), "clean\n");

    const found = await searchTree("tree", root, [ID]);
    expect(found.hits).toEqual([]);
    expect(found.filesRead).toBe(1);
    // And the output says why, rather than leaving a reader to assume it looked.
    expect(NOT_SEARCHED.join("\n")).toContain("git objects");
  });

  test("a symlink is named, never followed", async () => {
    const root = await sandbox();
    const outside = join(root, "..", "elsewhere-demo.txt");
    await Bun.write(outside, "demo\n");
    scratch.push(outside);
    await mkdir(join(root, "inside"), { recursive: true });
    await symlink(outside, join(root, "inside", "link.txt"));

    const found = await searchTree("tree", root, [ID]);
    expect(found.filesRead).toBe(0);
    expect(found.hits).toEqual([]);
  });

  test("a root that is not there is zero, not an error", async () => {
    const root = await sandbox();
    const found = await searchTree("gone", join(root, "never-created"), [ID]);

    expect(found.hits).toEqual([]);
    expect(found.filesRead).toBe(0);
    expect(found.unreadable).toBeUndefined();
  });

  test("bytes that are not text still count, and do not throw", async () => {
    const root = await sandbox();
    await Bun.write(join(root, "blob.bin"), new Uint8Array([0x00, 0xff, 0xfe, 0x0a]));
    await Bun.write(join(root, "mixed.bin"), new Uint8Array([0xff, ...new TextEncoder().encode(" demo ")]));

    const found = await searchTree("tree", root, [ID]);
    expect(found.filesRead).toBe(2);
    expect(found.hits.map((hit) => hit.path)).toEqual([join(root, "mixed.bin")]);
  });
});

// ---------------------------------------------------------------------------
// Over a list of files, and over several scopes at once
// ---------------------------------------------------------------------------

describe("searchFiles and searchScopes", () => {
  test("a file that does not exist is not a finding", async () => {
    const root = await sandbox();
    await Bun.write(join(root, "CLAUDE.md"), "# notes\ndemo\n");

    const found = await searchFiles("instruction files", [
      join(root, "CLAUDE.md"),
      join(root, "AGENTS.md"),
    ], [ID]);

    expect(found.filesRead).toBe(1);
    expect(found.hits).toEqual([
      { path: join(root, "CLAUDE.md"), line: 2, needle: "subject id", inName: false },
    ]);
  });

  test("hits are counted separately for what must be empty and what merely is not", async () => {
    const state = await sandbox();
    const agent = await sandbox();
    await Bun.write(join(state, "leftover.jsonl"), `{"subject":"demo"}\n`);
    await Bun.write(join(agent, "memory", "note.md"), "wrote this with demo\n");

    const report = await searchScopes(
      [
        { label: "state root", kind: "deletable", tree: state },
        { label: "working tree", kind: "git", tree: agent },
        { label: "instruction files", kind: "deletable", files: [] },
      ],
      [ID],
    );

    // The distinction the verdict turns on: one of these is Mind having
    // failed, the other is the owner's file to decide about.
    expect(report.deletableHits).toBe(1);
    expect(report.gitHits).toBe(1);
    expect(report.scopes.map((scope) => scope.label)).toEqual([
      "state root",
      "working tree",
      "instruction files",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The definition, and the limits, printed rather than assumed
// ---------------------------------------------------------------------------

describe("what `the whole system` is defined to mean", () => {
  test("SEARCHED names all four scopes the code really reads", () => {
    const text = SEARCHED.join("\n");
    expect(text).toContain("state root");
    expect(text).toContain("data root");
    expect(text).toContain("instruction file");
    expect(text).toContain("working tree");
    expect(SEARCHED.length).toBe(4);
  });

  test("NOT_SEARCHED leads with the places the data demonstrably still is", () => {
    const text = NOT_SEARCHED.join("\n");
    expect(text).toContain("vendor transcripts");
    expect(text).toContain("shell history");
    expect(text).toContain("any service on the network");
    expect(text).toContain("Qdrant");
    expect(text).toContain("clones and remotes");
    expect(text).toContain("git objects");
    expect(text).toContain("freed disk blocks");
  });

  test("the Qdrant line names its one exception and what stays outside it (D-038)", () => {
    const line = NOT_SEARCHED.find((note) => note.includes("Qdrant"))!;
    expect(line).toContain("one exception");
    expect(line).toContain("by name on a loopback address");
    // The collection nobody gave Mind, and text somebody else put elsewhere.
    expect(line).toContain("`docs` included");
    expect(line).toContain("outside this run");
  });

  test("SEARCH_LIMITS says the needle text is never printed", () => {
    expect(SEARCH_LIMITS.join("\n")).toContain("counted and never printed");
  });
});
