/** S3.3 (D-057) — routines and sequences, on records nobody lived. */

import { describe, expect, test } from "bun:test";
import { TRIGGERS_SCHEMA, parseTriggers } from "../../src/decide/triggers.ts";
import {
  formatPatterns,
  isOwnersAction,
  labelOf,
  minePatterns,
  printPatterns,
  systemClock,
  triggerIdFor,
  type Clock,
} from "../../src/observer/patterns.ts";
import { NO_EVIDENCE, type CaptureRecord } from "../../src/observer/record.ts";
import { flagPersonal } from "../../src/types.ts";

/** UTC as the local clock, so hours in the fixtures are the hours asserted. */
const UTC: Clock = systemClock("UTC");
const HOME = "/home/someone";
const P = "/home/someone/work/app";

let n = 0;
function rec(at: string, target: string, extra: Partial<CaptureRecord> = {}): CaptureRecord {
  n += 1;
  return {
    v: 1,
    key: `k${n}`,
    at,
    vendor: "claude",
    session: "s1",
    project: P,
    kind: "command",
    tool: "Bash",
    target,
    outcome: "ok",
    source: "hook",
    origin: "unknown",
    evidence: NO_EVIDENCE,
    ...extra,
  };
}

/** One action on each of these days, at this UTC hour. */
const daily = (target: string, days: readonly string[], hour: number, extra: Partial<CaptureRecord> = {}) =>
  days.map((day) => rec(`${day}T${String(hour).padStart(2, "0")}:15:00Z`, target, { session: `s-${day}`, ...extra }));

// 2026-09-21 is a Monday.
const WEEKDAYS = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"];

describe("AC1 — whose actions, and which", () => {
  test("unattended and subagent are left out; owner-prompted and unknown are in", () => {
    expect(isOwnersAction(rec("2026-09-21T01:00:00Z", "bun test", { origin: "owner-prompted" }))).toBe(true);
    expect(isOwnersAction(rec("2026-09-21T01:00:00Z", "bun test", { origin: "unknown" }))).toBe(true);
    expect(isOwnersAction(rec("2026-09-21T01:00:00Z", "bun test", { origin: "unattended" }))).toBe(false);
    expect(isOwnersAction(rec("2026-09-21T01:00:00Z", "bun test", { origin: "subagent" }))).toBe(false);
    expect(isOwnersAction(rec("2026-09-21T01:00:00Z", "", { kind: "prompt" }))).toBe(false);
    expect(isOwnersAction(rec("2026-09-21T01:00:00Z", "Read", { kind: "tool" }))).toBe(false);
  });

  test("a routine made only of subagent actions is not found", () => {
    const found = minePatterns(daily("bun test", WEEKDAYS, 9, { origin: "subagent" }), UTC);
    expect(found.routines).toEqual([]);
    expect(found.considered).toBe(0);
  });

  test("labels: plumbing is not an action, a wrapper is seen through, an edit is where it was", () => {
    expect(labelOf(rec("x", "cd"))).toBeUndefined();
    expect(labelOf(rec("x", "rtk read"))).toBeUndefined();
    expect(labelOf(rec("x", "rtk git"))).toBe("git");
    expect(labelOf(rec("x", "sudo systemctl"))).toBe("systemctl");
    expect(labelOf(rec("x", "git commit"))).toBe("git commit");
    expect(labelOf(rec("x", "src/a/b.ts", { kind: "file-edit" }))).toBe("edit src");
    expect(labelOf(rec("x", "./README.md", { kind: "file-edit" }))).toBe("edit README.md");
  });
});

describe("AC2 — routines", () => {
  test("three days is a routine; two is not", () => {
    expect(minePatterns(daily("bun test", WEEKDAYS.slice(0, 2), 9), UTC).routines).toEqual([]);
    const [r] = minePatterns(daily("bun test", WEEKDAYS.slice(0, 3), 9), UTC).routines;
    expect(r).toMatchObject({ label: "bun test", project: P, days: 3, count: 3, first: "2026-09-21", last: "2026-09-23" });
  });

  test("a time window is named only when 60% of the days fall in it, and weekdays are noticed", () => {
    const timed = minePatterns(daily("bun test", WEEKDAYS, 9), UTC).routines[0]!;
    expect(timed.windowStart).not.toBeNull();
    expect(timed.windowShare).toBe(1);
    expect(timed.weekdaysOnly).toBe(true);

    const scattered = [
      ...daily("bun test", ["2026-09-21"], 2),
      ...daily("bun test", ["2026-09-22"], 8),
      ...daily("bun test", ["2026-09-23"], 14),
      ...daily("bun test", ["2026-09-26"], 20),
    ];
    const loose = minePatterns(scattered, UTC).routines[0]!;
    expect(loose.windowStart).toBeNull();
    expect(loose.weekdaysOnly).toBe(false);
  });

  test("the same command in two projects is two routines, and only a timed one gets a trigger", () => {
    const other = "/home/someone/work/site";
    const found = minePatterns([...daily("bun test", WEEKDAYS, 9), ...daily("bun test", WEEKDAYS, 9, { project: other })], UTC);
    expect(found.routines.map((r) => r.project).sort()).toEqual([P, other].sort());
  });

  test("the local clock decides the day and the hour", () => {
    const bangkok = systemClock("Asia/Bangkok");
    // 20:00 UTC is 03:00 the next day in Bangkok.
    expect(bangkok.local(new Date("2026-09-21T20:00:00Z"))).toMatchObject({ day: "2026-09-22", hour: 3 });
  });
});

describe("AC3 — sequences", () => {
  /** On each day, A then B `gap` minutes later, `times` times. */
  const pairs = (a: string, b: string, days: readonly string[], times: number, gap = 2) =>
    days.flatMap((day) =>
      Array.from({ length: times }, (_, i) => {
        const at = new Date(`${day}T10:00:00Z`).getTime() + i * 30 * 60_000;
        return [
          rec(new Date(at).toISOString(), a, { session: `s-${day}` }),
          rec(new Date(at + gap * 60_000).toISOString(), b, { session: `s-${day}` }),
        ];
      }).flat(),
    );

  test("five times on two days, followed every time", () => {
    const [s] = minePatterns(pairs("git commit", "git push", ["2026-09-21", "2026-09-22"], 3), UTC).sequences;
    expect(s).toMatchObject({ from: "git commit", to: "git push", count: 6, days: 2, confidence: 1 });
  });

  test("too few, one day, too far apart, or across sessions — none of them is a sequence", () => {
    expect(minePatterns(pairs("git commit", "git push", ["2026-09-21", "2026-09-22"], 2), UTC).sequences).toEqual([]);
    expect(minePatterns(pairs("git commit", "git push", ["2026-09-21"], 6), UTC).sequences).toEqual([]);
    expect(minePatterns(pairs("git commit", "git push", ["2026-09-21", "2026-09-22"], 3, 11), UTC).sequences).toEqual([]);
    const split = pairs("git commit", "git push", ["2026-09-21", "2026-09-22"], 3).map((r, i) => ({ ...r, session: `solo-${i}` }));
    expect(minePatterns(split, UTC).sequences).toEqual([]);
  });

  test("below 60% is not a sequence", () => {
    const followed = pairs("git commit", "git push", ["2026-09-21", "2026-09-22"], 3);
    const alone = daily("git commit", ["2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"], 18);
    expect(minePatterns([...followed, ...alone], UTC).sequences).toEqual([]);
  });
});

describe("AC4, AC5 — what is shown", () => {
  test("every line carries its evidence, and a timed routine becomes a trigger that parses", () => {
    const lines = formatPatterns(minePatterns(daily("bun test", WEEKDAYS, 9), UTC), { home: HOME, limit: 10 }).join("\n");
    expect(lines).toContain("bun test  in ~/work/app — 4 of 4 active day(s), 4 time(s), 2026-09-21 → 2026-09-24");
    expect(lines).toContain("usually 08:00–10:00 (100% of those days) · weekdays only");
    expect(lines).toContain("copy what you want into triggers.md yourself");
    const snippet = lines.slice(lines.indexOf("[bun-test-app]"), lines.indexOf("A trigger fires"));
    const parsed = parseTriggers("triggers.md", `+++\nschema = "${TRIGGERS_SCHEMA}"\n\n${snippet}+++\n`);
    expect(parsed.ok).toBe(true);
  });

  test("no timed routine, no snippet; nothing found says so", () => {
    const lines = formatPatterns(minePatterns([], UTC), { home: HOME, limit: 10 }).join("\n");
    expect(lines).toContain("none yet");
    expect(lines).not.toContain("triggers.md");
  });

  test("trigger ids are ids the trigger file accepts", () => {
    const [r] = minePatterns(daily("docker compose", WEEKDAYS, 9, { project: "/srv/My App" }), UTC).routines;
    expect(triggerIdFor(r!)).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
  });

  test("printPatterns opens the box and writes lines, returning only counts", () => {
    const lines: string[] = [];
    const out = printPatterns(flagPersonal(daily("bun test", WEEKDAYS, 9)), (l) => lines.push(l), { clock: UTC, home: HOME, limit: 5 });
    expect(out).toEqual({ routines: 1, sequences: 0 });
    expect(lines.join("\n")).toContain("bun test");
  });
});
