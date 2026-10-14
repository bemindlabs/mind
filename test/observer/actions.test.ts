/**
 * S3.2 — the three kinds, and the line between what may enter git and what may
 * not.
 *
 * Two questions are asked here over and over, because they are the two ways this
 * feature could quietly become something else:
 *
 * 1. **Did anything out of a record get out of the box?** Every leak test below
 *    puts a path, a project directory, an MCP server's name and a session id
 *    into the records and then greps the *bytes of the summary* for them. A
 *    assertion about keys would pass on the day somebody added a value.
 * 2. **Does a zero mean what a reader will take it to mean?** A `0` under
 *    `owner-prompted` is the case the owner named: it means nobody has turned
 *    capture on, and a row of zeros with no sentence beside it reads as "the
 *    owner did nothing". So the sentence is asserted, in the file and in the
 *    printed output.
 *
 * Every record here is invented (D-021). Nothing reads a real transcript, a real
 * home directory, or a real capture store.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  ACTION_KINDS,
  ACTIONS_LIMITS,
  actionsSummary,
  actionsVocabulary,
  countActions,
  formatActions,
  isAction,
  monthsOfFiles,
  OWNER_ROW_EMPTY,
  SUMMARY_PATH,
  SUMMARY_PROGRAMS,
  SUMMARY_SCHEMA,
} from "../../src/observer/actions.ts";
import { BUILTIN_TOOLS } from "../../src/observer/adapters/vocabulary.ts";
import { CAPTURE_VERSION, NO_EVIDENCE, type CaptureRecord } from "../../src/observer/record.ts";
import { flagPersonal } from "../../src/types.ts";

/** One invented record. Every field a string, as `parseRecord` guarantees. */
function record(fields: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    v: CAPTURE_VERSION,
    key: `claude:tool:${Math.random().toString(16).slice(2)}`,
    at: "2026-09-21T10:00:00.000Z",
    vendor: "claude",
    session: "s-1",
    project: "/invented/project",
    kind: "tool",
    tool: "Read",
    target: "",
    outcome: "ok",
    source: "seed",
    origin: "unknown",
    evidence: NO_EVIDENCE,
    ...fields,
  };
}

/** The summary of these records, for these months, as the CLI would build it. */
function summaryOf(records: readonly CaptureRecord[], months: readonly string[]) {
  return actionsSummary({
    counts: countActions(flagPersonal(records), months),
    months,
    records: records.length,
    at: new Date("2026-09-21T10:00:00.000Z"),
    generator: "mind@test",
  });
}

const SEPTEMBER = ["2026-09"];

// ---------------------------------------------------------------------------
// The three kinds (AC1)
// ---------------------------------------------------------------------------

describe("the three kinds AC1 keeps", () => {
  test("an action is anything that is not a prompt, and there are exactly three", () => {
    expect(ACTION_KINDS).toEqual(["file-edit", "command", "tool"]);

    expect(isAction(record({ kind: "file-edit" }))).toBe(true);
    expect(isAction(record({ kind: "command" }))).toBe(true);
    expect(isAction(record({ kind: "tool" }))).toBe(true);
    // A prompt is the evidence that a human turn happened, not a thing done.
    expect(isAction(record({ kind: "prompt", tool: "" }))).toBe(false);
  });

  test("a prompt is counted as a record and never as one of the three", () => {
    const summary = summaryOf(
      [record({ kind: "prompt", tool: "" }), record({ kind: "command", tool: "Bash", target: "git status" })],
      SEPTEMBER,
    );
    const month = summary.counts["2026-09"]!;

    expect(month.records).toBe(2);
    expect(month.kind).toEqual({ prompt: 1, "file-edit": 0, command: 1, tool: 0 });
    // And it contributes to no tool row: those are keyed by the action kinds.
    expect(Object.keys(month.tool).sort()).toEqual([...ACTION_KINDS].sort());
    expect(month.tool["command"]?.["Bash"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Months come from file names, not from records
// ---------------------------------------------------------------------------

describe("monthsOfFiles", () => {
  test("it reads months off capture file names and nothing else", () => {
    expect(
      monthsOfFiles([
        join("/invented/store/capture", "2026-09.jsonl"),
        join("/invented/store/capture", "2026-08.jsonl"),
        // Duplicated, out of order, and two things that are not month files.
        join("/invented/store/capture", "2026-08.jsonl"),
        join("/invented/store", "consent.json"),
        join("/invented/store/capture", "notes.jsonl"),
      ]),
    ).toEqual(["2026-08", "2026-09"]);
  });

  test("no files means no months, which is not an error", () => {
    expect(monthsOfFiles([])).toEqual([]);
    const summary = summaryOf([], []);
    expect(summary.months).toEqual([]);
    expect(summary.counts).toEqual({});
    expect(formatActions(summary)).toContain("no capture files, so no months and no counts");
  });

  test("a record whose month has no file is counted nowhere, and the run says so", () => {
    // The cost of taking months from file names, stated in ACTIONS_LIMITS and
    // reported per run rather than balanced quietly.
    const summary = summaryOf(
      [
        record({ at: "2026-09-01T00:00:00.000Z", kind: "command", tool: "Bash", target: "git log" }),
        record({ at: "2026-07-01T00:00:00.000Z", kind: "command", tool: "Bash", target: "git log" }),
      ],
      SEPTEMBER,
    );

    expect(summary.counts["2026-09"]?.records).toBe(1);
    expect(summary.uncounted).toBe(1);
    expect(summary.notes.join("\n")).toContain("belong to no column");
  });
});

// ---------------------------------------------------------------------------
// The counts (AC2's fields, at month resolution)
// ---------------------------------------------------------------------------

describe("countActions", () => {
  test("kind, outcome, origin and vendor are counted over their closed unions", () => {
    const summary = summaryOf(
      [
        record({ kind: "file-edit", tool: "Edit", target: "src/a.ts", outcome: "ok" }),
        record({ kind: "file-edit", tool: "Write", target: "src/b.ts", outcome: "failed" }),
        record({ kind: "command", tool: "Bash", target: "git commit", outcome: "ok" }),
        record({ kind: "tool", tool: "Read", outcome: "unknown", vendor: "grok", origin: "subagent" }),
      ],
      SEPTEMBER,
    );
    const month = summary.counts["2026-09"]!;

    expect(month.records).toBe(4);
    expect(month.kind).toEqual({ prompt: 0, "file-edit": 2, command: 1, tool: 1 });
    expect(month.outcome).toEqual({ ok: 2, failed: 1, unknown: 1 });
    expect(month.origin).toEqual({
      "owner-prompted": 0,
      unattended: 0,
      subagent: 1,
      unknown: 3,
    });
    // The engine's own name is in the vendor union since D-032 and is counted like the
    // others — at zero here, because nothing in this fixture came through the
    // turn door. A missing key would mean the table forgot a member.
    expect(month.vendor).toEqual({ claude: 3, grok: 1, mind: 0 });
  });

  test("`unknown` origin is never folded into the owner's row", () => {
    // AC3's whole point. A property over generated records rather than one
    // example: the owner row must equal the number of `owner-prompted` records
    // and nothing else, whatever the mixture.
    const origins = ["owner-prompted", "unattended", "subagent", "unknown"] as const;
    const records: CaptureRecord[] = [];
    // A fixed, unremarkable pattern rather than Math.random, so a failure is
    // reproducible: 60 records over the four origins.
    for (let index = 0; index < 60; index += 1) {
      const origin = origins[index % origins.length] ?? "unknown";
      records.push(record({ origin, kind: "tool", tool: "Read" }));
    }
    const expected = {
      "owner-prompted": records.filter((r) => r.origin === "owner-prompted").length,
      unattended: records.filter((r) => r.origin === "unattended").length,
      subagent: records.filter((r) => r.origin === "subagent").length,
      unknown: records.filter((r) => r.origin === "unknown").length,
    };

    expect(summaryOf(records, SEPTEMBER).counts["2026-09"]?.origin).toEqual(expected);
  });

  test("tool names outside the built-in list are counted as `other`, per kind", () => {
    const summary = summaryOf(
      [
        record({ kind: "tool", tool: "Read" }),
        record({ kind: "tool", tool: "mcp__acme__lookup" }),
        record({ kind: "tool", tool: "mcp__acme__other" }),
        record({ kind: "file-edit", tool: "Edit", target: "src/a.ts" }),
      ],
      SEPTEMBER,
    );
    const tools = summary.counts["2026-09"]!.tool;

    expect(tools["tool"]?.["Read"]).toBe(1);
    expect(tools["tool"]?.["other"]).toBe(2);
    expect(tools["file-edit"]?.["Edit"]).toBe(1);
    expect(tools["file-edit"]?.["other"]).toBe(0);
  });

  test("programs are counted for commands only, so a path is never one", () => {
    const summary = summaryOf(
      [
        record({ kind: "command", tool: "Bash", target: "git commit" }),
        record({ kind: "command", tool: "Bash", target: "docker restart" }),
        record({ kind: "command", tool: "Bash", target: "my-private-deploy thing" }),
        // A file edit's target is a path. Its first word must not be counted as a
        // program, not even under `other` — that bucket means "a command whose
        // program is not on the list", and a path is not a command.
        record({ kind: "file-edit", tool: "Edit", target: "src/observer/actions.ts" }),
        record({ kind: "tool", tool: "Read" }),
      ],
      SEPTEMBER,
    );
    const programs = summary.counts["2026-09"]!.program;

    expect(programs["git"]).toBe(1);
    expect(programs["docker"]).toBe(1);
    expect(programs["other"]).toBe(1);
    // Three commands were seen, and exactly three programs were counted.
    expect(Object.values(programs).reduce((sum, count) => sum + count, 0)).toBe(3);
  });

  test("the vocabulary is closed: every key is a month plus words from the lists", () => {
    const words = actionsVocabulary(["2026-09", "2026-08"]);

    expect(words.length).toBeGreaterThan(0);
    for (const word of words) {
      const parts = word.split("|");
      expect(["2026-09", "2026-08"]).toContain(parts[0] ?? "");
      expect(["records", "kind", "outcome", "origin", "vendor", "tool", "program"]).toContain(
        parts[1] ?? "",
      );
    }
    // Two months, and neither borrows from the other.
    expect(new Set(words).size).toBe(words.length);
    expect(words.filter((word) => word.startsWith("2026-09|")).length).toBe(words.length / 2);
    // Every tool word is a built-in name or the one bucket.
    for (const word of words.filter((w) => w.includes("|tool|"))) {
      const name = word.split("|")[3] ?? "";
      expect([...BUILTIN_TOOLS, "other"], word).toContain(name);
    }
    for (const word of words.filter((w) => w.includes("|program|"))) {
      const name = word.split("|")[3] ?? "";
      expect([...SUMMARY_PROGRAMS, "other"], word).toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// The line: what a committed file may say (AC5, I-4)
// ---------------------------------------------------------------------------

describe("what may enter git", () => {
  test("not one string out of a record reaches the summary's bytes", () => {
    const summary = summaryOf(
      [
        record({
          kind: "file-edit",
          tool: "mcp__acme__write",
          target: "clients/acme-corp/quarterly.ts",
          project: "/invented/home/someone/work/acme",
          session: "9f3c7e10-secret-session",
          at: "2026-09-21T10:00:00.000Z",
        }),
        record({
          kind: "command",
          tool: "Bash",
          target: "ssh jump-host-of-a-client",
          project: "/invented/home/someone/work/acme",
          session: "9f3c7e10-secret-session",
        }),
      ],
      SEPTEMBER,
    );

    // The bytes that would be written, not the object: a leak that shows up only
    // once something is serialised is still a leak.
    const bytes = JSON.stringify(summary, null, 2);
    for (
      const leak of [
        "acme",
        "someone",
        "9f3c7e10",
        "quarterly",
        "clients",
        "jump-host",
        "T10:00:00",
        "/invented",
      ]
    ) {
      expect(bytes, leak).not.toContain(leak);
    }

    // The behaviour did survive: a file edit and an ssh, in September.
    expect(summary.counts["2026-09"]?.kind["file-edit"]).toBe(1);
    expect(summary.counts["2026-09"]?.program["ssh"]).toBe(1);
    expect(summary.counts["2026-09"]?.tool["file-edit"]?.["other"]).toBe(1);
  });

  test("the file carries a date, a schema, a generator — and no subject", () => {
    const summary = summaryOf([record({ kind: "tool", tool: "Read" })], SEPTEMBER);

    expect(summary.schema).toBe(SUMMARY_SCHEMA);
    // A date, never an instant: a second-resolution timestamp in a committed
    // file says when somebody was at their desk.
    expect(summary.at).toBe("2026-09-21");
    expect(summary.generator).toBe("mind@test");
    // I-3: nothing in here says whose summary it is. The repository it is
    // written into is the only thing that does.
    expect(JSON.stringify(summary)).not.toContain("subject");
    expect(SUMMARY_PATH).toBe("actions/summary.json");
  });

  test("every value in the counts is a whole number", () => {
    const summary = summaryOf(
      [record({ kind: "command", tool: "Bash", target: "git commit" })],
      SEPTEMBER,
    );

    const walk = (value: unknown, where: string): void => {
      if (typeof value === "number") {
        expect(Number.isSafeInteger(value), where).toBe(true);
        expect(value, where).toBeGreaterThanOrEqual(0);
        return;
      }
      expect(typeof value, where).toBe("object");
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        walk(inner, `${where}.${key}`);
      }
    };
    walk(summary.counts, "counts");
  });
});

// ---------------------------------------------------------------------------
// The empty owner row, which is the sentence the owner asked for
// ---------------------------------------------------------------------------

describe("an empty owner row is explained, not left blank", () => {
  test("a store of seeded records says why `owner-prompted` is 0", () => {
    const summary = summaryOf(
      [record({ kind: "tool", tool: "Read", origin: "unknown", source: "seed" })],
      SEPTEMBER,
    );

    expect(summary.notes).toContain(OWNER_ROW_EMPTY);
    expect(OWNER_ROW_EMPTY).toContain("nobody has turned capture on");
    expect(OWNER_ROW_EMPTY).toContain("never as");
    // The note travels with the numbers, on screen as well as in the file.
    expect(formatActions(summary).join("\n")).toContain("nobody has turned capture on");
  });

  test("a store with hook records does not carry the sentence", () => {
    const summary = summaryOf(
      [record({ kind: "tool", tool: "Read", origin: "owner-prompted", source: "hook" })],
      SEPTEMBER,
    );

    expect(summary.counts["2026-09"]?.origin["owner-prompted"]).toBe(1);
    expect(summary.notes).not.toContain(OWNER_ROW_EMPTY);
  });

  test("an empty store carries neither note, because there is nothing to explain", () => {
    const summary = summaryOf([], SEPTEMBER);
    expect(summary.notes).toEqual([]);
    expect(summary.counts["2026-09"]?.records).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Printing, and the limits
// ---------------------------------------------------------------------------

describe("formatActions", () => {
  test("it prints a row per group and hides the words nothing happened under", () => {
    const summary = summaryOf(
      [
        record({ kind: "command", tool: "Bash", target: "git commit", outcome: "ok" }),
        record({ kind: "file-edit", tool: "Edit", target: "src/a.ts", outcome: "failed" }),
      ],
      SEPTEMBER,
    );
    const text = formatActions(summary).join("\n");

    expect(text).toContain("2026-09 · 2 record(s)");
    expect(text).toContain("file-edit 1");
    expect(text).toContain("ok 1");
    expect(text).toContain("failed 1");
    expect(text).toContain("git 1");
    // A group with nothing in it prints a dash rather than a wall of zeros.
    expect(text).toContain("—");
  });
});

describe("ACTIONS_LIMITS — the size of what a summary is", () => {
  test("it states the line, in the words the code enforces", () => {
    const limits = ACTIONS_LIMITS.join("\n");

    expect(limits).toContain("by construction rather than by filtering");
    expect(limits).toContain("MCP server");
    expect(limits).toContain("`other`");
    expect(limits).toContain("months come from the names of the capture files");
    expect(limits).toContain("never stages and never commits");
  });

  test("it says which AC1 case is deferred, to what, and why", () => {
    // The owner's ruling: skipping grok's decision kind is allowed, and the
    // output has to say where it went and on what grounds.
    const limits = ACTIONS_LIMITS.join("\n");

    expect(limits).toContain("permission_resolved");
    expect(limits).toContain("w5b");
    expect(limits).toContain("no seed has been run");
  });

  test("it says AC4 is unanswered, and refuses the fixtures as an answer", () => {
    const limits = ACTIONS_LIMITS.join("\n");

    expect(limits).toContain("not answered");
    expect(limits).toContain("observe audit");
    expect(limits).toContain("those records are invented");
  });

  test("it admits the thing a count cannot stop being", () => {
    expect(ACTIONS_LIMITS.join("\n")).toContain("a count is still a channel in principle");
  });
});
