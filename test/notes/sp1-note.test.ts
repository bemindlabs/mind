/**
 * The SP-1 note, watched after the script that produced it was deleted.
 *
 * `scripts/sp1-transcript-survey.ts` is gone (gate4): D-024 chose capture over
 * a backfill, no decision was left waiting on a second reading of the same
 * seven-week window, and it was the one file in this repository that read the
 * owner's real transcripts — so deleting it removed surface from I-3 and I-6
 * rather than only removing lines. `test/scripts/sp1-survey.test.ts` went with
 * it, because every assertion in it was about the script's guards and a guard
 * with nothing behind it is a test that passes for free.
 *
 * These three did not go, and they are why this file exists. The note is the
 * deliverable, `.scrum/decisions.md` cites it, and it is the one artefact a
 * person edits by hand after the guards have already done their work. A
 * sentence added later to make a number clearer is exactly how a path or a
 * session id gets into a file that is meant to be openable — and that risk did
 * not end when the script did. It went up: the guards that used to scrub this
 * text on the way out are no longer in the repository, so what is written here
 * now is whatever somebody types.
 */

import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const NOTE = join(ROOT, "notes", "sp1-transcript-yield.md");

describe("the note carries numbers, and nothing that was measured", () => {
  test("no home path, no tilde path, no transcript file name, no session id", async () => {
    const note = await Bun.file(NOTE).text();

    expect(note).not.toMatch(/\/(?:home|Users)\//);
    expect(note).not.toMatch(/~\//);
    // A bare "JSONL" is a format; `something.jsonl` is a file somebody owns.
    expect(note).not.toMatch(/\S+\.jsonl\b/);
    expect(note).not.toMatch(/\S+\.json\b/);
    expect(note).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
  });

  test("the limits a reader would overstate are still stated", async () => {
    const note = await Bun.file(NOTE).text();

    // Presence is not correctness: the hand-check stays open.
    expect(note).toContain("still open after this note");
    expect(note).toContain("S3.2 AC4");
    // The numbers are a floor, not a cold-start measurement.
    expect(note).toContain("Warm page cache");
    // And the recommendation the whole spike turns on.
    expect(note).toContain("Do not build E3 as a backfill");
  });

  test("both bars are quoted as they were fixed, and every vendor gets a verdict", async () => {
    const note = await Bun.file(NOTE).text();

    expect(note).toContain("≥ 85%");
    expect(note).toContain("≥ 60%");
    for (const vendor of ["claude", "codex", "grok", "kimi"]) {
      expect(note).toContain(vendor);
    }
    expect(note).toContain("**PASS**");
    expect(note).toContain("**FAIL**");
  });
});

describe("the numbers can still be re-derived, which is what makes them numbers", () => {
  test("the note points at a commit that has the script, not at a command that is gone", async () => {
    // A note whose "How to reproduce" runs `npm run sp1` after `sp1` was
    // removed from package.json is worse than one with no reproduce section:
    // it reads as a live instruction and fails with "missing script", which
    // looks like a broken checkout rather than a deleted spike.
    const note = await Bun.file(NOTE).text();
    const manifest = await Bun.file(join(ROOT, "package.json")).json();

    expect(manifest.scripts.sp1).toBeUndefined();
    expect(note).not.toContain("npm run sp1");
    expect(note).toContain("git show ");
    expect(note).toContain("scripts/sp1-transcript-survey.ts");
  });

  // The public repository starts from a one-commit snapshot of a release
  // (D-058), and says so in `.snapshot`. The sha the note cites is in the
  // development history, which a snapshot does not carry by design; there the
  // citation cannot be checked, and this says so rather than passing.
  const snapshot = existsSync(join(ROOT, ".snapshot"));
  test.skipIf(snapshot)("the commit it names is a full sha that this repository actually has", async () => {
    // An abbreviated sha is the thing that stops resolving once the repository
    // grows, and a sha nobody checked is a citation of nothing. Both are read
    // out of the note rather than written down twice.
    const note = await Bun.file(NOTE).text();
    const [sha] = note.match(/\b[0-9a-f]{40}\b/) ?? [];
    expect(sha, "the note names no 40-character commit sha").toBeDefined();

    const shown = Bun.spawn(
      ["git", "-C", ROOT, "cat-file", "-e", `${sha}:scripts/sp1-transcript-survey.ts`],
      { stdout: "pipe", stderr: "pipe" },
    );
    await shown.exited;
    expect(shown.exitCode, `${sha} does not hold scripts/sp1-transcript-survey.ts`).toBe(0);
  });

  test("the script really is gone, so this file is the whole of what is left", async () => {
    expect(await Bun.file(join(ROOT, "scripts", "sp1-transcript-survey.ts")).exists()).toBe(false);
    expect(await Bun.file(join(ROOT, "test", "scripts", "sp1-survey.test.ts")).exists()).toBe(false);
  });
});
