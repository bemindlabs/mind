/**
 * The AC4 instrument — what it must do, and the number it must refuse to make up.
 *
 * `S3.2 AC4` is a person reading twenty files. Nothing here can answer it, and
 * the point of these tests is that the code knows that: the percentages below
 * are over records this file invented, so they measure the instrument. The
 * assertion that says so out loud is the one over {@link AUDIT_LIMITS}.
 *
 * What *is* checked mechanically is the part a person cannot see for themselves:
 * that the sample is bounded, that the excerpt cannot be a whole 663 MB line,
 * that a skip is not counted as either right or wrong, that the index pass reads
 * every file so an outcome living in another file is still resolved (`S3.1 AC8`)
 * — and that a run writes nothing at all.
 *
 * Every transcript below is invented (D-021), in a temporary directory. No real
 * vendor directory is read.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUDIT_EXCERPT,
  AUDIT_FIELDS,
  AUDIT_FILES,
  AUDIT_FLOOR,
  AUDIT_LIMITS,
  AUDIT_PER_FILE,
  auditClears,
  formatAudit,
  judgeSample,
  sampleActions,
  type AuditIo,
  type AuditSample,
  type AuditVerdict,
} from "../../src/observer/audit.ts";

const NOW = new Date("2026-09-21T10:00:00.000Z");

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-audit-"));
  scratch.push(dir);
  return dir;
}

/** A human turn, so `claudeTranscript` does not skip the session as fleet work. */
function typed(session: string, uuid: string): string {
  return JSON.stringify({
    uuid,
    sessionId: session,
    timestamp: "2026-09-20T09:00:00.000Z",
    cwd: "/invented/project",
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "invented" }] },
  });
}

/** One tool call, as claude writes it. */
function call(session: string, uuid: string, id: string, name: string, input: unknown): string {
  return JSON.stringify({
    uuid,
    sessionId: session,
    timestamp: "2026-09-20T09:00:01.000Z",
    cwd: "/invented/project",
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });
}

/** Its answer, which may be in another file entirely. */
function answer(session: string, uuid: string, id: string, isError: boolean): string {
  return JSON.stringify({
    uuid,
    sessionId: session,
    timestamp: "2026-09-20T09:00:02.000Z",
    cwd: "/invented/project",
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError }] },
  });
}

async function writeLines(path: string, lines: readonly string[]): Promise<void> {
  await Bun.write(path, `${lines.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// The sample
// ---------------------------------------------------------------------------

describe("sampleActions", () => {
  test("it pairs each derived record with the line it came from", async () => {
    const root = await sandbox();
    await writeLines(join(root, "sess-a.jsonl"), [
      typed("a", "u-1"),
      call("a", "u-2", "t-1", "Edit", { file_path: "/invented/project/src/a.ts" }),
      answer("a", "u-3", "t-1", false),
    ]);

    const sample = await sampleActions({ root, vendor: "claude", now: NOW });

    expect(sample.filesFound).toBe(1);
    expect(sample.filesRead).toEqual([join(root, "sess-a.jsonl")]);
    expect(sample.pairs.length).toBe(1);

    const pair = sample.pairs[0]!;
    // The line number is the one a person would open the file at.
    expect(pair.line).toBe(2);
    expect(pair.file).toBe(join(root, "sess-a.jsonl"));
    expect(pair.excerpt).toContain("tool_use");
    expect(pair.excerpt).toContain("/invented/project/src/a.ts");
    // And what Mind made of it, which is what is being graded.
    expect(pair.record.kind).toBe("file-edit");
    expect(pair.record.target).toBe("src/a.ts");
    expect(pair.record.outcome).toBe("ok");
    // A prompt is not an action and is never put in front of a judge.
    expect(sample.pairs.every((p) => p.record.kind !== "prompt")).toBe(true);
  });

  test("the index pass reads every file, so an outcome in another one is found", async () => {
    // `S3.1 AC8` in the audit path: a reader that indexed only the file it
    // sampled would show `unknown` and have a person grade that shortcut.
    const root = await sandbox();
    await writeLines(join(root, "sess-a.jsonl"), [
      typed("a", "u-1"),
      call("a", "u-2", "t-1", "Bash", { command: "git push origin main" }),
    ]);
    await writeLines(join(root, "sess-b.jsonl"), [answer("a", "u-3", "t-1", true)]);

    const sample = await sampleActions({ root, vendor: "claude", now: NOW });
    const pair = sample.pairs.find((p) => p.record.tool === "Bash");

    expect(pair?.record.outcome).toBe("failed");
    // And the reduction w4 decided on: a program and its first subcommand.
    expect(pair?.record.target).toBe("git push");
  });

  test("it is bounded per file and over files, and the defaults are AC4's", async () => {
    const root = await sandbox();
    for (const name of ["a", "b", "c"]) {
      await writeLines(join(root, `sess-${name}.jsonl`), [
        typed(name, `${name}-u-0`),
        ...[1, 2, 3, 4].map((n) =>
          call(name, `${name}-u-${n}`, `${name}-t-${n}`, "Read", { file_path: `/invented/${n}.ts` }),
        ),
      ]);
    }

    const sample = await sampleActions({
      root,
      vendor: "claude",
      now: NOW,
      files: 2,
      perFile: 3,
      // Deterministic, so a failure here is reproducible.
      random: () => 0,
    });

    expect(sample.filesFound).toBe(3);
    expect(sample.filesRead.length).toBe(2);
    expect(sample.pairs.length).toBe(6);
    for (const file of sample.filesRead) {
      expect(sample.pairs.filter((pair) => pair.file === file).length).toBe(3);
    }

    // The defaults are the numbers AC4 names, kept in one place.
    expect(AUDIT_FILES).toBe(20);
    expect(AUDIT_PER_FILE).toBe(5);
  });

  test("an excerpt is one line and never the whole line", async () => {
    const root = await sandbox();
    await writeLines(join(root, "sess-a.jsonl"), [
      typed("a", "u-1"),
      call("a", "u-2", "t-1", "Edit", {
        file_path: "/invented/project/src/a.ts",
        // A line can be megabytes. A terminal cannot.
        old_string: "x".repeat(50_000),
      }),
    ]);

    const excerpt = (await sampleActions({ root, vendor: "claude", now: NOW })).pairs[0]?.excerpt ?? "";

    expect(excerpt.length).toBe(AUDIT_EXCERPT);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt).not.toContain("\n");
  });

  test("a directory with nothing in it is a sample of nothing, not an error", async () => {
    const sample = await sampleActions({ root: await sandbox(), vendor: "claude", now: NOW });

    expect(sample.filesFound).toBe(0);
    expect(sample.pairs).toEqual([]);
    expect(sample.linesRead).toBe(0);
  });

  test("an unreadable line is skipped rather than ending the run", async () => {
    const root = await sandbox();
    await writeLines(join(root, "sess-a.jsonl"), [
      "{ this is not json",
      typed("a", "u-1"),
      call("a", "u-2", "t-1", "Read", { file_path: "/invented/a.ts" }),
    ]);

    const sample = await sampleActions({ root, vendor: "claude", now: NOW });
    expect(sample.pairs.length).toBe(1);
  });

  test("it writes nothing — the property that lets it run before capture exists", async () => {
    const root = await sandbox();
    await writeLines(join(root, "sess-a.jsonl"), [
      typed("a", "u-1"),
      call("a", "u-2", "t-1", "Read", { file_path: "/invented/a.ts" }),
    ]);
    const before = await tree(root);

    const sample = await sampleActions({ root, vendor: "claude", now: NOW });
    await judgeSample(scripted(["y", "y", "y"]), sample);

    expect(await tree(root)).toEqual(before);
  });
});

/** Every file under a tree with its size, so "nothing was written" is checked. */
async function tree(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await tree(path)));
    else found.push(`${path} ${(await stat(path)).size}`);
  }
  return found.sort();
}

// ---------------------------------------------------------------------------
// The judging
// ---------------------------------------------------------------------------

/** A terminal that answers from a list, and remembers what it was shown. */
function scripted(answers: readonly string[]): AuditIo & { readonly shown: string[] } {
  const queue = [...answers];
  const shown: string[] = [];
  return {
    isTTY: true,
    shown,
    write: (line) => shown.push(line),
    readLine: async () => queue.shift() ?? "",
  };
}

/** One pair, without going near a filesystem. */
function sampleOf(pairs: number): AuditSample {
  return {
    root: "/invented/transcripts",
    vendor: "claude",
    filesFound: 1,
    filesRead: ["/invented/transcripts/sess-a.jsonl"],
    linesRead: pairs * 2,
    pairs: Array.from({ length: pairs }, (_, index) => ({
      file: "/invented/transcripts/sess-a.jsonl",
      line: index + 1,
      excerpt: `{"type":"tool_use","name":"Edit","input":{"file_path":"/invented/${index}.ts"}}`,
      record: {
        v: 1,
        key: `claude:tool:t-${index}`,
        at: "2026-09-20T09:00:01.000Z",
        vendor: "claude" as const,
        session: "a",
        project: "/invented/project",
        kind: "file-edit" as const,
        tool: "Edit",
        target: `${index}.ts`,
        outcome: "ok" as const,
        source: "seed" as const,
        origin: "unknown" as const,
        evidence: {
          promptSource: null,
          permissionMode: null,
          subagent: false,
          humanTurnsInSession: 1,
        },
      },
    })),
  };
}

function verdictOf(verdicts: readonly AuditVerdict[], field: string): AuditVerdict {
  return verdicts.find((verdict) => verdict.field === field)!;
}

describe("judgeSample", () => {
  test("three fields per pair, in order, and `origin` is not one of them", () => {
    // A transcript cannot answer "who set this going" (S3.2 AC3, D-024), so
    // asking a human to grade it would manufacture agreement.
    expect(AUDIT_FIELDS).toEqual(["kind", "target", "outcome"]);
    expect([...AUDIT_FIELDS]).not.toContain("origin");
  });

  test("y and n are counted, and a skip is neither right nor wrong", async () => {
    const io = scripted(["y", "n", "skip", "y", "y", ""]);
    const verdicts = await judgeSample(io, sampleOf(2));

    expect(verdictOf(verdicts, "kind")).toEqual({ field: "kind", judged: 2, correct: 2, pct: 100 });
    expect(verdictOf(verdicts, "target")).toEqual({ field: "target", judged: 2, correct: 1, pct: 50 });
    // Skipped once and answered with an empty line once: nothing judged at all.
    expect(verdictOf(verdicts, "outcome")).toEqual({
      field: "outcome",
      judged: 0,
      correct: 0,
      pct: 0,
    });

    // What it showed: the raw line beside what Mind derived from it.
    const shown = io.shown.join("\n");
    expect(shown).toContain("sess-a.jsonl:1");
    expect(shown).toContain("tool_use");
    expect(shown).toContain("file-edit");
  });

  test("`q` stops the run and keeps what was already answered", async () => {
    const verdicts = await judgeSample(scripted(["y", "q", "y", "y", "y"]), sampleOf(3));

    expect(verdictOf(verdicts, "kind").judged).toBe(1);
    expect(verdictOf(verdicts, "target").judged).toBe(0);
    expect(verdictOf(verdicts, "outcome").judged).toBe(0);
  });

  test("a percentage is one decimal of what was judged, never of what was shown", async () => {
    // Two of three right is 66.7%, not "2 out of the 3 pairs I displayed".
    const verdicts = await judgeSample(
      scripted(["y", "skip", "skip", "y", "skip", "skip", "n", "skip", "skip"]),
      sampleOf(3),
    );

    expect(verdictOf(verdicts, "kind")).toEqual({
      field: "kind",
      judged: 3,
      correct: 2,
      pct: 66.7,
    });
  });
});

describe("the verdict, and the floor", () => {
  test("a field under the floor does not clear, and neither does nothing at all", async () => {
    expect(AUDIT_FLOOR).toBe(80);

    const clears = await judgeSample(scripted(["y", "y", "y"]), sampleOf(1));
    expect(auditClears(clears)).toBe(true);

    const fails = await judgeSample(scripted(["n", "y", "y"]), sampleOf(1));
    expect(auditClears(fails)).toBe(false);

    // Nothing judged is not a pass. An exit 0 there would read as ≥ 80%.
    const nothing = await judgeSample(scripted(["skip", "skip", "skip"]), sampleOf(1));
    expect(auditClears(nothing)).toBe(false);
  });

  test("a field nobody judged says so rather than printing a 0%", async () => {
    const verdicts = await judgeSample(scripted(["y", "skip", "skip"]), sampleOf(1));
    const lines = formatAudit(verdicts).join("\n");

    expect(lines).toContain("1/1 correct · 100.0% · floor 80%");
    expect(lines).toContain("nothing judged — no number, and none will be invented");
  });
});

describe("AUDIT_LIMITS — what this instrument measures", () => {
  test("it refuses the test suite's own numbers as an answer to AC4", () => {
    const limits = AUDIT_LIMITS.join("\n");

    expect(limits).toContain("a number from the test suite is not this number");
    expect(limits).toContain("invented by the");
  });

  test("it says why there is no --yes, and what a terminal proves", () => {
    const limits = AUDIT_LIMITS.join("\n");

    expect(limits).toContain("no --yes");
    expect(limits).toContain("script(1)");
    expect(limits).toContain("writes nothing");
  });

  test("it says the hook path is a separate reading, still unanswered", () => {
    const limits = AUDIT_LIMITS.join("\n");

    expect(limits).toContain("`origin` is not judged");
    expect(limits).toContain("stays unanswered");
    expect(limits).toContain("first week of capture");
  });
});
