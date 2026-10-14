/** S3.4 (D-064) — interests counted over the owner's own directories, weighted by recency. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateDirs, formatInterests, rankInterests, recentDays, topOf } from "../../src/observer/interests.ts";
import { NO_EVIDENCE, type CaptureRecord } from "../../src/observer/record.ts";
import { countPersonal, flagPersonal } from "../../src/types.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

let n = 0;
const rec = (project: string, at: string, origin: CaptureRecord["origin"] = "unknown"): CaptureRecord => ({
  v: 1, key: `k${(n += 1)}`, at, vendor: "claude", session: "s", project, kind: "command", tool: "Bash", target: "git status", outcome: "ok", source: "hook", origin, evidence: NO_EVIDENCE,
});

describe("the vocabulary comes from disk, not from records", () => {
  test("directories under the roots, skipping hidden and build trees, to a depth", async () => {
    const root = await mkdtemp(join(tmpdir(), "mind-interests-"));
    scratch.push(root);
    for (const d of ["a/projects/app", "a/node_modules/x", "b", ".hidden/x", "a/dist"]) await mkdir(join(root, d), { recursive: true });
    const dirs = await candidateDirs([root], 3);
    expect(dirs).toContain(join(root, "a", "projects", "app"));
    expect(dirs).toContain(join(root, "b"));
    expect(dirs.some((d) => d.includes("node_modules") || d.includes(".hidden") || d.endsWith("dist"))).toBe(false);
    expect((await candidateDirs([root], 3, 2)).length).toBe(2);
    expect(await candidateDirs([join(root, "missing")])).toEqual([join(root, "missing")]);
  });

  test("the day take is ten characters, like the month take is seven", () => {
    const counts = countPersonal(flagPersonal([{ at: "2026-09-24T10:00:00.000Z" }]), [{ key: { parts: [{ field: "at", take: "day" }] } }], ["2026-09-24"]);
    expect(counts).toEqual({ "2026-09-24": 1 });
  });

  test("days and roll-up", () => {
    expect(recentDays(new Date("2026-09-24T12:00:00Z"), 3)).toEqual(["2026-09-24", "2026-09-23", "2026-09-22"]);
    expect(topOf("/r/mind/projects/mind", ["/r"])).toBe("/r/mind");
    expect(topOf("/r", ["/r"])).toBeUndefined();
    expect(topOf("/elsewhere/x", ["/r"])).toBeUndefined();
  });
});

describe("ranking (AC1, AC3)", () => {
  const roots = ["/r"];
  const dirs = ["/r/old", "/r/new", "/r/new/sub", "/r/fleet"];
  const now = new Date("2026-09-24T12:00:00Z");

  test("recent beats frequent-but-old at a short half-life; a longer half-life lets frequency win", () => {
    const records = [
      ...Array.from({ length: 10 }, () => rec("/r/old", "2026-09-10T10:00:00Z")),
      ...Array.from({ length: 3 }, () => rec("/r/new/sub", "2026-09-24T09:00:00Z")),
    ];
    const short = rankInterests(flagPersonal(records), { dirs, roots, now, halfLifeDays: 3 });
    expect(short.map((x) => x.project)).toEqual(["/r/new", "/r/old"]);
    expect(short[0]).toMatchObject({ actions: 3, days: 1, last: "2026-09-24" });
    const long = rankInterests(flagPersonal(records), { dirs, roots, now, halfLifeDays: 60 });
    expect(long[0]!.project).toBe("/r/old");
    // Beyond six half-lives a day is not counted at all: 14 days is outside a 2-day half-life's window.
    expect(rankInterests(flagPersonal(records), { dirs, roots, now, halfLifeDays: 2 }).map((x) => x.project)).toEqual(["/r/new"]);
  });

  test("subagent and unattended work is not interest; a directory off the list is not counted", () => {
    const records = [rec("/r/fleet", "2026-09-24T09:00:00Z", "subagent"), rec("/r/fleet", "2026-09-24T09:00:00Z", "unattended"), rec("/elsewhere", "2026-09-24T09:00:00Z")];
    expect(rankInterests(flagPersonal(records), { dirs, roots, now, halfLifeDays: 7 })).toEqual([]);
  });

  test("the list prints scores, evidence and a bar, and says when nothing counted", () => {
    const ranked = rankInterests(flagPersonal([rec("/r/new", "2026-09-24T09:00:00Z")]), { dirs, roots, now, halfLifeDays: 7 });
    const lines = formatInterests(ranked, { limit: 5, halfLifeDays: 7, home: "/r" }).join("\n");
    expect(lines).toContain("~/new");
    expect(lines).toContain("1 action(s) on 1 day(s), last 2026-09-24");
    expect(formatInterests([], { limit: 5, halfLifeDays: 7, home: "" }).join("\n")).toContain("nothing counted yet");
  });
});
