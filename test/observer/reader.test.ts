/**
 * The one pipe — `S3.1` AC1, AC2, AC3, AC4 and AC7, which are all properties of
 * the same function.
 *
 * Each test below has a control, because every one of these criteria can be
 * met vacuously. "Nothing failed the run" is also what a reader that read
 * nothing reports; "no duplicates" is also what a reader that accepted nothing
 * reports; "100% readable" is what an empty directory gives. So every assertion
 * that something did not happen is paired with one proving the pipe was moving.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatReport,
  READABLE_FLOOR,
  readInto,
  streamLines,
  textLines,
  type Adapted,
} from "../../src/observer/reader.ts";
import { CAPTURE_VERSION, type CaptureRecord } from "../../src/observer/record.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-reader-"));
  scratch.push(dir);
  return dir;
}

/** A record built from an invented line, for an adapter that just relabels. */
function recordOf(key: string, at = "2026-09-21T10:00:00.000Z"): CaptureRecord {
  return {
    v: CAPTURE_VERSION,
    key,
    at,
    vendor: "claude",
    session: "s-1",
    project: "/synthetic/project",
    kind: "tool",
    tool: "Read",
    target: "",
    outcome: "unknown",
    source: "seed",
    origin: "unknown",
    evidence: { promptSource: null, permissionMode: null, subagent: false, humanTurnsInSession: 1 },
  };
}

/** An adapter that turns `{"key":"x"}` into one record, and skips anything else. */
function keyAdapter(value: unknown): Adapted {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { skip: "not-an-object" };
  }
  const key = (value as Record<string, unknown>)["key"];
  if (typeof key !== "string") return { skip: "no-key" };
  if (key === "") return { records: [] };
  return { records: [recordOf(key)] };
}

describe("AC2 — a bad line is skipped and counted, and the run finishes", () => {
  test("one line in ten is broken: pct 90, and the other nine are kept", async () => {
    const lines: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      lines.push(index === 4 ? '{"key": "broken"' : JSON.stringify({ key: `k-${index}` }));
    }

    const kept: CaptureRecord[] = [];
    const report = await readInto(textLines(lines.join("\n")), keyAdapter, (r) => void kept.push(r));

    expect(report.lines).toBe(10);
    expect(report.parsed).toBe(9);
    expect(report.pct).toBe(90);
    expect(report.accepted).toBe(9);
    expect(report.skipped["unparsable"]).toBe(1);
    expect(kept.length).toBe(9);
  });

  test("the control: a run where nothing is broken reports 100, so 90 means something", async () => {
    const lines = [0, 1, 2].map((n) => JSON.stringify({ key: `k-${n}` })).join("\n");
    const report = await readInto(textLines(lines), keyAdapter, () => undefined);
    expect(report.pct).toBe(100);
    expect(report.skipped["unparsable"]).toBeUndefined();
  });

  test("the reason never carries the line that caused it", async () => {
    const secret = '{"key": "sk-ant-not-a-real-key"';
    const report = await readInto(textLines(secret), keyAdapter, () => undefined);
    expect(Object.keys(report.skipped)).toEqual(["unparsable"]);
    expect(JSON.stringify(report)).not.toContain("sk-ant");
  });

  test("an adapter's own skip reason is counted under its own word", async () => {
    const report = await readInto(
      textLines(['{"key":123}', '{"key":"good"}', "[]"].join("\n")),
      keyAdapter,
      () => undefined,
    );
    expect(report.skipped["no-key"]).toBe(1);
    expect(report.skipped["not-an-object"]).toBe(1);
    expect(report.accepted).toBe(1);
  });

  test("an adapter that finds nothing is `no-action`, not a failure", async () => {
    const report = await readInto(textLines('{"key":""}'), keyAdapter, () => undefined);
    expect(report.skipped["no-action"]).toBe(1);
    expect(report.pct).toBe(100);
  });

  test("a record the adapter built wrong is refused on the way out, with the reason", async () => {
    const broken = (): Adapted => ({
      records: [{ ...recordOf("k"), at: "not a date" } as CaptureRecord],
    });
    const report = await readInto(textLines("{}"), broken, () => undefined);
    expect(report.accepted).toBe(0);
    expect(report.skipped["invalid:no-time"]).toBe(1);
  });
});

describe("AC7 — the same key is never counted twice", () => {
  test("a record repeated three times is kept once", async () => {
    const lines = [
      JSON.stringify({ key: "same" }),
      JSON.stringify({ key: "same" }),
      JSON.stringify({ key: "other" }),
      JSON.stringify({ key: "same" }),
    ].join("\n");

    const kept: CaptureRecord[] = [];
    const report = await readInto(textLines(lines), keyAdapter, (r) => void kept.push(r));

    expect(report.accepted).toBe(2);
    expect(report.duplicates).toBe(2);
    expect(kept.map((r) => r.key)).toEqual(["same", "other"]);
  });

  test("the seen set carries across runs, which is what joins two files", async () => {
    const seen = new Set<string>();
    const first = await readInto(textLines('{"key":"a"}'), keyAdapter, () => undefined, seen);
    const second = await readInto(textLines('{"key":"a"}'), keyAdapter, () => undefined, seen);

    expect(first.accepted).toBe(1);
    expect(second.accepted).toBe(0);
    expect(second.duplicates).toBe(1);
  });

  test("the control: two different keys in two runs are both kept", async () => {
    const seen = new Set<string>();
    const first = await readInto(textLines('{"key":"a"}'), keyAdapter, () => undefined, seen);
    const second = await readInto(textLines('{"key":"b"}'), keyAdapter, () => undefined, seen);
    expect(first.accepted + second.accepted).toBe(2);
    expect(second.duplicates).toBe(0);
  });
});

describe("AC1 — one pipe, two sources of lines", () => {
  test("a file and a string go through the same function and agree", async () => {
    const dir = await sandbox();
    const lines = [0, 1, 2].map((n) => JSON.stringify({ key: `k-${n}` })).join("\n") + "\n";
    const path = join(dir, "a.jsonl");
    await Bun.write(path, lines);

    const fromFile = await readInto(streamLines(path), keyAdapter, () => undefined);
    const fromText = await readInto(textLines(lines), keyAdapter, () => undefined);

    expect(fromFile.accepted).toBe(3);
    expect({ ...fromFile }).toEqual({ ...fromText });
  });

  test("blank lines are not counted as lines, so a trailing newline is not a failure", async () => {
    const report = await readInto(textLines('{"key":"a"}\n\n\n'), keyAdapter, () => undefined);
    expect(report.lines).toBe(1);
    expect(report.pct).toBe(100);
  });
});

describe("AC4 — streaming, not loading", () => {
  test("a file much larger than the heap delta it causes", async () => {
    const dir = await sandbox();
    const path = join(dir, "big.jsonl");

    // One line repeated until the file is comfortably larger than anything a
    // reader should be holding. Built with Bun.write once rather than appended,
    // so the write itself is not what is being measured.
    const line = `${JSON.stringify({ key: "k", filler: "x".repeat(900) })}\n`;
    const bytes = 16 * 1024 * 1024;
    await Bun.write(path, line.repeat(Math.ceil(bytes / line.length)));
    const size = (await Bun.file(path).stat()).size;
    expect(size).toBeGreaterThan(bytes);

    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;
    let seen = 0;
    for await (const text of streamLines(path)) {
      if (text !== "") seen += 1;
    }
    // Collected before reading the number, not after: the pass produces a
    // string per line and every one of them is garbage the moment the loop
    // moves on, so without this the measurement is of how lazily the runtime
    // happened to collect rather than of what the reader held.
    Bun.gc(true);
    const after = process.memoryUsage().heapUsed;

    // Proof the loop really read the file, so the heap number is about a real
    // pass rather than an early return.
    expect(seen).toBeGreaterThan(10_000);
    // A reader that did `await Bun.file(path).text()` would show a delta of at
    // least the file's size. The bound is deliberately loose — this is a
    // garbage-collected runtime — and still an order of magnitude under it.
    expect(after - before).toBeLessThan(size / 4);
  }, 60_000);
});

describe("the report a human reads", () => {
  test("it names the counts and the reasons", async () => {
    const report = await readInto(
      textLines(['{"key":"a"}', '{"key":"a"}', "{oops"].join("\n")),
      keyAdapter,
      () => undefined,
    );
    const line = formatReport(report);
    expect(line).toContain("3 line(s)");
    expect(line).toContain("1 kept");
    expect(line).toContain("1 duplicate(s)");
    expect(line).toContain("unparsable=1");
  });

  test("an empty run reports 100%, which is why the floor is checked beside a count", async () => {
    const report = await readInto(textLines(""), keyAdapter, () => undefined);
    expect(report.pct).toBe(100);
    expect(report.lines).toBe(0);
    expect(READABLE_FLOOR).toBe(85);
  });
});
