import { describe, expect, test } from "bun:test";
import { DEFAULT_TICK_MAX, MAX_RUNNERS, tickChoices } from "../../src/task/tick.ts";
import { aTask } from "./fixture.ts";

const NOW = Date.parse("2026-10-27T10:00:00Z");
const dead = () => null;
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

describe("which tasks a tick carries on (S22.10)", () => {
  test("a parked task whose time has come, and an interrupted one, are resumed; one whose time has not come is not", () => {
    const choices = tickChoices(
      [
        aTask({ id: "t-00000001", status: "parked", resumeAfter: at(-1), generation: 1, createdAt: at(-30) }),
        aTask({ id: "t-00000002", status: "parked", resumeAfter: at(30), generation: 1, createdAt: at(-20) }),
        aTask({ id: "t-00000003", status: "running", runner: null, generation: 1, createdAt: at(-10) }),
      ],
      NOW,
      3,
      dead,
    );
    expect(choices.map((c) => [c.id, c.action])).toEqual([["t-00000001", "resume"], ["t-00000002", "skip"], ["t-00000003", "resume"]]);
    expect(choices[1]!.why).toContain("parked until");
  });

  test("a task parked with no time is a person's decision, and a task that is done or queued is not mentioned", () => {
    const choices = tickChoices(
      [
        aTask({ id: "t-00000004", status: "parked", generation: 1 }),
        aTask({ id: "t-00000005", status: "done", generation: 1 }),
        aTask({ id: "t-00000006", status: "queued", generation: 0 }),
      ],
      NOW,
      3,
      dead,
    );
    expect(choices).toHaveLength(1);
    expect(choices[0]).toMatchObject({ id: "t-00000004", action: "skip" });
    expect(choices[0]!.why).toContain("person's decision");
  });

  test("a task that has had too many runners is left to a person, however long it has waited", () => {
    const [choice] = tickChoices([aTask({ id: "t-00000007", status: "running", runner: null, generation: MAX_RUNNERS })], NOW, 3, dead);
    expect(choice).toMatchObject({ action: "skip" });
    expect(choice!.why).toContain(`${MAX_RUNNERS} runners`);
  });

  test("no more than the limit start in one tick, oldest first; the rest wait for the next", () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      aTask({ id: `t-0000000${i}`, status: "running", runner: null, generation: 1, createdAt: at(-100 + i) }),
    );
    const choices = tickChoices(records.reverse(), NOW, 2, dead);
    expect(choices.filter((c) => c.action === "resume").map((c) => c.id)).toEqual(["t-00000000", "t-00000001"]);
    expect(choices.filter((c) => c.action === "skip").every((c) => c.why.includes("limit of 2"))).toBe(true);
    expect(DEFAULT_TICK_MAX).toBe(3);
  });

  test("a task whose runner is alive is not touched", () => {
    const alive = () => ({ startTicks: 1 });
    const record = aTask({ id: "t-00000008", status: "running", runner: { pid: 1, start: 1, since: at(-5) }, generation: 1 });
    expect(tickChoices([record], NOW, 3, alive)).toEqual([]);
  });
});
