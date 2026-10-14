/** S5.3 (D-054) — the parts of a schedule that are arithmetic and files. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dueTriggers,
  exampleTriggers,
  firedPath,
  lockFired,
  markFired,
  MIN_EVERY_MS,
  nextDue,
  parseEvery,
  parseTriggers,
  readFired,
  triggeredCeiling,
  triggersDirFor,
  TRIGGERS_SCHEMA,
  type Trigger,
} from "../../src/decide/triggers.ts";
import { subjectId } from "../../src/types.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-triggers-unit-"));
  scratch.push(dir);
  return dir;
}

const file = (body: string) => `+++\nschema = "${TRIGGERS_SCHEMA}"\n${body}+++\n`;

describe("parseEvery", () => {
  test("minutes, hours and days, and nothing else", () => {
    expect(parseEvery("30m")).toBe(30 * 60_000);
    expect(parseEvery("6h")).toBe(6 * 3_600_000);
    expect(parseEvery("1d")).toBe(86_400_000);
    for (const bad of ["", "0m", "1s", "1w", "1.5h", "-1d", "1 d", "01d"]) expect(parseEvery(bad), bad).toBeUndefined();
  });
});

describe("parseTriggers (AC1)", () => {
  test("a valid file, in file order", () => {
    const parsed = parseTriggers("triggers.md", file(`\n[b-one]\nevery = "1h"\nprompt = "one"\n\n[a-two]\nevery = "2d"\nprompt = "two"\n`));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.map((t) => [t.id, t.every, t.prompt])).toEqual([
      ["b-one", "1h", "one"],
      ["a-two", "2d", "two"],
    ]);
  });

  test("the example it prints parses", () => {
    expect(parseTriggers("triggers.md", exampleTriggers()).ok).toBe(true);
  });

  test("every problem is reported with its line, and one bad trigger refuses the file", () => {
    const parsed = parseTriggers(
      "triggers.md",
      file(`\n[ok]\nevery = "1h"\nprompt = "fine"\n\n[fast]\nevery = "1m"\nprompt = "x"\n\n[level]\nevery = "1h"\nprompt = "x"\nlevel = 3\n\n[BAD]\nevery = "1h"\nprompt = "x"\n\n[empty]\nevery = "1h"\nprompt = " "\n`),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const byPath = new Map(parsed.issues.map((issue) => [issue.path, issue]));
    expect(byPath.get("fast.every")?.line).toBe(9);
    expect(byPath.get("fast.every")?.message).toContain("between 5m and 90d");
    expect(byPath.get("level.level")?.message).toContain("its level is always 1");
    expect(byPath.get("BAD")?.message).toContain("lower-case");
    expect(byPath.get("empty.prompt")?.message).toContain("empty");
    expect(byPath.has("ok.every")).toBe(false);
  });

  test("the schema is required, and a bare key is not a trigger", () => {
    const parsed = parseTriggers("triggers.md", `+++\nschema = "something-else"\nloose = "x"\n+++\n`);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.map((issue) => issue.path).sort()).toEqual(["loose", "schema"]);
  });
});

describe("due, once per window (AC5)", () => {
  const daily: Trigger = { id: "d", every: "1d", everyMs: 86_400_000, prompt: "p" };
  const now = new Date("2026-09-24T12:00:00Z");

  test("never fired is due now", () => {
    expect(dueTriggers([daily], {}, now)).toEqual([daily]);
    expect(nextDue(daily, {}, now)).toEqual(now);
  });

  test("inside the window is not due; at its end it is", () => {
    expect(dueTriggers([daily], { d: "2026-09-24T00:00:00Z" }, now)).toEqual([]);
    expect(dueTriggers([daily], { d: "2026-09-23T12:00:00Z" }, now)).toEqual([daily]);
  });

  test("a week away is one firing, not seven — there is one timestamp to compare", () => {
    expect(dueTriggers([daily], { d: "2026-09-17T12:00:00Z" }, now)).toHaveLength(1);
  });

  test("the smallest interval is a schedule, not a loop", () => {
    expect(MIN_EVERY_MS).toBe(5 * 60_000);
  });
});

describe("the ceiling a triggered turn runs under (AC2)", () => {
  test("1, or lower — never higher, and an unrecognised value is passed through to mean 0", () => {
    expect(triggeredCeiling(undefined)).toBe("1");
    expect(triggeredCeiling("3")).toBe("1");
    expect(triggeredCeiling("2")).toBe("1");
    expect(triggeredCeiling("1")).toBe("1");
    expect(triggeredCeiling("0")).toBe("0");
    expect(triggeredCeiling("3abc")).toBe("3abc");
  });
});

describe("the record and the lock (AC5, AC6)", () => {
  test("fire times round-trip, keep each other, and an unreadable record is none", async () => {
    const home = await temp();
    const dir = triggersDirFor({ home, env: { XDG_STATE_HOME: join(home, "state") } }, subjectId("example"));
    expect(dir).toBe(join(home, "state", "mind", "triggers", "example"));
    const path = firedPath("/some/agent", dir);
    expect(firedPath("/some/agent", dir)).toBe(path);
    expect(firedPath("/other/agent", dir)).not.toBe(path);

    await markFired(path, "a", new Date("2026-09-24T00:00:00Z"));
    await markFired(path, "b", new Date("2026-09-24T01:00:00Z"));
    expect(await readFired(path)).toEqual({ a: "2026-09-24T00:00:00.000Z", b: "2026-09-24T01:00:00.000Z" });
    await markFired(path, "b", null);
    await markFired(path, "a", "2026-09-20T00:00:00.000Z");
    expect(await readFired(path)).toEqual({ a: "2026-09-20T00:00:00.000Z" });

    await writeFile(path, "{ not json");
    expect(await readFired(path)).toEqual({});
    await writeFile(path, JSON.stringify({ a: "yesterday", b: 3 }));
    expect(await readFired(path)).toEqual({});
  });

  test("one tick at a time; a lock whose process is gone is taken over", async () => {
    const path = join(await temp(), "fired.json");
    const first = await lockFired(path);
    expect(first.ok).toBe(true);
    const second = await lockFired(path);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toContain(`pid ${process.pid}`);

    const stale = await lockFired(path, () => false);
    expect(stale.ok).toBe(true);
    if (stale.ok) await stale.release();
    if (first.ok) await first.release();
    expect((await lockFired(path)).ok).toBe(true);
  });
});
