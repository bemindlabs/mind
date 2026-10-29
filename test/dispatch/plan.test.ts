import { describe, expect, test } from "bun:test";
import { MIN_N } from "../../src/dispatch/choose.ts";
import type { Measure } from "../../src/dispatch/measure.ts";
import { currentModelsOf, plan, type PlanIo } from "../../src/dispatch/plan.ts";
import { changeWords, evalCommand, watch } from "../../src/dispatch/watch.ts";

function measure(backend: string, model: string | null, kind: string, status: Measure["status"] = "done", at = "2026-10-28T00:00:00.000Z"): Measure {
  return { v: 1, task: `t-${Math.random().toString(16).slice(2, 10).padEnd(8, "0")}`, subject: "s", at, kind, status, backend, model, steps: model === null ? [] : [{ backend, model, n: 1 }], turns: 3, tokens: 100, tokensUnknown: 0, activeMs: 1000, review: null };
}

describe("the models a backend runs (S22.15)", () => {
  test("the newest model each backend's output named in a finished task; a step that named none is no evidence", () => {
    const models = currentModelsOf([
      measure("claude", "claude-opus-5", "bugfix", "done", "2026-10-20T00:00:00Z"),
      measure("claude", "claude-opus-5-5", "bugfix", "done", "2026-10-27T00:00:00Z"),
      measure("claude", null, "bugfix", "done", "2026-10-28T00:00:00Z"),
      measure("codex", "gpt-6-sol", "bugfix", "done", "2026-10-26T00:00:00Z"),
    ]);
    expect(Object.fromEntries(models)).toEqual({ claude: "claude-opus-5-5", codex: "gpt-6-sol" });
  });
});

describe("watching for a change of model (S22.15 AC1)", () => {
  const lines = [measure("claude", "claude-opus-5", "bugfix", "done", "2026-10-20T00:00:00Z"), measure("claude", "claude-opus-5-5", "bugfix", "done", "2026-10-27T00:00:00Z"), measure("claude", "claude-opus-5-5", "bugfix", "done", "2026-10-28T00:00:00Z"), measure("codex", "gpt-6-sol", "bugfix", "done", "2026-10-26T00:00:00Z")];

  test("a model different from the one last seen is a change, with when a finished task first showed it", () => {
    const out = watch(lines, { claude: { model: "claude-opus-5", since: "2026-10-01T00:00:00Z" }, codex: { model: "gpt-6-sol", since: "2026-10-01T00:00:00Z" } });
    expect(out.changes).toEqual([{ backend: "claude", from: "claude-opus-5", to: "claude-opus-5-5", since: "2026-10-27T00:00:00Z" }]);
    expect(out.first).toEqual([]);
    expect(out.next["claude"]!.model).toBe("claude-opus-5-5");
  });

  test("a backend seen for the first time is recorded, not alarmed about", () => {
    const out = watch(lines, {});
    expect(out.changes).toEqual([]);
    expect(out.first.map((f) => f.backend).sort()).toEqual(["claude", "codex"]);
  });

  test("an unchanged model is silent", () => {
    const out = watch(lines, { claude: { model: "claude-opus-5-5", since: "x" }, codex: { model: "gpt-6-sol", since: "x" } });
    expect(out.changes).toEqual([]);
    expect(out.first).toEqual([]);
  });

  test("the words say the new model starts at zero, the old one is a prior, no price is guessed, and what to run", () => {
    const text = changeWords({ backend: "claude", from: "a", to: "b", since: "2026-10-27T00:00:00Z" }, 12).join("\n");
    expect(text).toContain("claude: a → b (first seen 2026-10-27)");
    expect(text).toContain("start independently");
    expect(text).toContain("12 outcome(s) of older models are a prior");
    expect(text).toContain("A price is never guessed");
    expect(text).toContain("mind eval code <agent-dir> --subject <id> --set evals/code --backend claude");
    expect(evalCommand("claude", "agent dir", "owner")).toBe("mind eval code 'agent dir' --subject owner --set evals/code --backend claude");
  });
});

describe("the plan (S22.14)", () => {
  const io = (over: Partial<PlanIo> = {}): PlanIo => ({
    measures: async (subject) => (subject === "a" ? [...Array(MIN_N)].map(() => measure("claude", "claude-opus-5-5", "bugfix")) : [...Array(MIN_N)].map(() => measure("codex", "gpt-6-sol", "bugfix", "failed"))),
    unusable: async () => undefined,
    ...over,
  });

  test("pools only the subjects it is told to, and ranks by the current model's own outcomes", async () => {
    const alone = await plan({ kind: "bugfix", candidates: ["codex", "claude"], subjects: ["a"], rand: () => 0.99 }, io());
    expect(alone.chain[0]).toBe("claude");
    expect(alone.subjects).toEqual(["a"]);
    expect(alone.considered.find((c) => c.id === "codex")!.n).toBe(0);
    const both = await plan({ kind: "bugfix", candidates: ["codex", "claude"], subjects: ["a", "b", "a"], rand: () => 0.99 }, io());
    expect(both.subjects).toEqual(["a", "b"]);
    expect(both.considered.find((c) => c.id === "codex")).toMatchObject({ n: MIN_N, trusted: true });
    expect(both.chain[0]).toBe("claude");
  });

  test("a resting backend is last, with its reason, and a new current model makes the old one's outcomes a prior", async () => {
    const out = await plan(
      { kind: "bugfix", candidates: ["claude", "codex"], subjects: ["a"], rand: () => 0.99 },
      io({ unusable: async (id) => (id === "claude" ? "resting until 12:00" : undefined) }),
    );
    expect(out.chain).toEqual(["codex", "claude"]);
    expect(out.considered.find((c) => c.id === "claude")!.note).toContain("resting until 12:00");
    const moved = await plan({ kind: "bugfix", candidates: ["claude"], subjects: ["a"], rand: () => 0.99 }, io({ measures: async () => [...[...Array(MIN_N)].map(() => measure("claude", "claude-opus-5-5", "bugfix", "done", "2026-10-20T00:00:00Z")), measure("claude", "claude-opus-6", "refactor", "done", "2026-10-28T00:00:00Z")] }));
    expect(moved.considered[0]!.note).toContain("older models are a prior, not measured for this model and not counted");
    expect(moved.mode).toBe("no-data");
  });
});
