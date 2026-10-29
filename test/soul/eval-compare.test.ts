/** S21.3 — two souls on the same tasks: per-task changes, per-split deltas, and the owner's T6 rule, mechanically. */

import { describe, expect, test } from "bun:test";
import { changeOf, comparable, compareLines, compareSides, newCompareId, REGRESSIONS, selectByRule, type CompareSide } from "../../src/soul/eval-compare.ts";
import { EVAL_RUN_SCHEMA, repeatedReport, type EvalAttempt, type EvalRunRecord } from "../../src/soul/eval-runs.ts";
import type { EvalTask, Mode, Split } from "../../src/soul/evals.ts";

/** Rows for one task: per mode, the pass/fail of each attempt. */
function rows(task: string, split: Split, outcomes: Partial<Record<Mode, readonly boolean[]>>): EvalAttempt[] {
  return (Object.entries(outcomes) as [Mode, readonly boolean[]][]).flatMap(([mode, passes]) =>
    passes.map((pass, i) => ({ task, kind: "k", mode, attempt: i + 1, split, pass, missing: [], rejected: [], route: "stub" })),
  );
}
const side = (...parts: EvalAttempt[][]): CompareSide => ({ results: parts.flat() });
/** Six held-out tasks, each passing in the soul mode as given. */
const held = (passes: readonly boolean[]) => side(...passes.map((p, i) => rows(`h${i}`, "heldout", { soul: [p] })));

describe("changes", () => {
  test("verdict to verdict; two flaky readings are the same", () => {
    expect(changeOf("stable pass", "stable fail")).toBe("pass→fail");
    expect(changeOf("stable fail", "stable pass")).toBe("fail→pass");
    expect(changeOf("stable pass", "flaky")).toBe("pass→flaky");
    expect(changeOf("flaky", "stable fail")).toBe("flaky→fail");
    expect(changeOf("flaky", "flaky")).toBe("same");
    expect([...REGRESSIONS].sort()).toEqual(["flaky→fail", "pass→fail", "pass→flaky"]);
  });

  test("per task × mode and per split, from the rows alone; a task on one side only is left out", () => {
    const base = side(rows("a", "train", { soul: [true, true], "soul+rag": [true, false] }), rows("b", "heldout", { soul: [false, false] }), rows("gone", "train", { soul: [true] }));
    const cand = side(rows("a", "train", { soul: [false, false], "soul+rag": [false, true] }), rows("b", "heldout", { soul: [true, false] }));
    const c = compareSides(base, cand);
    expect(c.rows.map((r) => [r.task, r.mode, r.change])).toEqual([["a", "soul", "pass→fail"], ["a", "soul+rag", "same"], ["b", "soul", "fail→flaky"]]);
    expect(c.rows[0]!.base).toEqual({ passes: 2, attempts: 2, verdict: "stable pass" });
    expect(c.bySplit).toEqual([
      { split: "train", tasks: 1, base: 75, candidate: 25, delta: -50 },
      { split: "heldout", tasks: 1, base: 0, candidate: 50, delta: 50 },
    ]);
    // A row from a pre-split record counts as train.
    const { split: _, ...old } = rows("x", "train", { soul: [true] })[0]!;
    expect(compareSides({ results: [old as EvalAttempt] }, { results: [old as EvalAttempt] }).rows[0]!.split).toBe("train");
  });
});

describe("selectByRule (T6)", () => {
  // The truth table: held-out rate rises? × a held-out task loses a pass? (+ tie, fall, none, train-only changes).
  test("rises, no held-out pass lost → adopt", () => {
    const s = selectByRule(held([true, true, true, false, false, false]), held([true, true, true, true, false, false]));
    expect(s.verdict).toBe("adopt");
    expect(s.reason).toBe("held-out pass rate rose 50% → 66.7% and no held-out task flipped pass→fail");
    expect(s.heldout).toEqual({ tasks: 6, base: 50, candidate: 66.7 });
    expect(s.tooSmall).toBe(false);
  });

  test("rises, but a held-out task flips pass→fail → keep-base, naming it", () => {
    const s = selectByRule(held([true, false, false, false, false, false]), held([false, true, true, false, false, false]));
    expect(s.verdict).toBe("keep-base");
    expect(s.reason).toBe("held-out h0 [soul] pass→fail");
    expect(s.regressions.map((r) => r.task)).toEqual(["h0"]);
  });

  test("a stable pass turning flaky, or flaky turning to a stable fail, is a loss too", () => {
    const base = side(rows("a", "heldout", { soul: [true, true] }), rows("b", "heldout", { soul: [true, false] }), rows("c", "heldout", { soul: [false, false] }));
    const cand = side(rows("a", "heldout", { soul: [true, false] }), rows("b", "heldout", { soul: [false, false] }), rows("c", "heldout", { soul: [true, true] }));
    const s = selectByRule(base, cand);
    expect(s.verdict).toBe("keep-base");
    expect(s.reason).toBe("held-out a [soul] pass→flaky, b [soul] flaky→fail");
    expect(s.tooSmall).toBe(true);
  });

  test("tie → keep-base; fall → keep-base; no held-out tasks → keep-base", () => {
    const same = held([true, false, true, false, true, false]);
    expect(selectByRule(same, same)).toMatchObject({ verdict: "keep-base", reason: "held-out pass rate tied at 50%" });
    // A flaky rate moving down is not a flip, but the rate fell.
    const fell = selectByRule(side(rows("a", "heldout", { soul: [true, true, false] })), side(rows("a", "heldout", { soul: [true, false, false] })));
    expect(fell).toMatchObject({ verdict: "keep-base", reason: "held-out pass rate fell 66.7% → 33.3%" });
    const train = side(rows("a", "train", { soul: [false] }));
    const trainBetter = side(rows("a", "train", { soul: [true] }));
    expect(selectByRule(train, trainBetter)).toMatchObject({ verdict: "keep-base", reason: "no held-out tasks: there is nothing to judge on", tooSmall: true });
  });

  test("train changes never decide it: a train regression does not block, a train gain does not adopt", () => {
    const base = side(rows("t", "train", { soul: [true] }), ...held([false, false, false, false, false, false]).results.map((r) => [r]));
    const cand = side(rows("t", "train", { soul: [false] }), ...held([true, false, false, false, false, false]).results.map((r) => [r]));
    expect(selectByRule(base, cand).verdict).toBe("adopt");
  });
});

const TASK = (id: string, split: Split): EvalTask => ({ id, kind: "k", ask: id, expect: ["x"], reject: [], source: "", split });
function run(over: Partial<EvalRunRecord>, results: EvalAttempt[]): EvalRunRecord {
  const tasks = [...new Set(results.map((r) => r.task))].map((id) => TASK(id, results.find((r) => r.task === id)!.split));
  return {
    schema: EVAL_RUN_SCHEMA,
    runId: "ev-20261019T080000Z-aaaa",
    startedAt: "2026-10-19T08:00:00.000Z",
    finishedAt: "2026-10-19T08:01:00.000Z",
    subject: "example",
    soul: { gitTree: "1a2b3c4d5e", dirty: true, contentSha256: "9f".repeat(32), files: ["role.md"] },
    evalsSha256: "e".repeat(64),
    backend: null,
    model: null,
    recallChars: 4000,
    repeat: 1,
    modes: ["soul", "soul+rag"],
    tasks: tasks.map((t) => t.id),
    split: "all",
    keptAnswers: false,
    results,
    report: repeatedReport(tasks, results, 1),
    ...over,
  };
}

describe("comparing two records", () => {
  const a = run({}, [...rows("port", "train", { soul: [true], "soul+rag": [true] }), ...rows("disk", "heldout", { soul: [false], "soul+rag": [false] })]);

  test("refused across different task sets, subjects, tasks or modes, saying why", () => {
    expect(comparable(a, a)).toEqual({ ok: true });
    const other = comparable(a, { ...a, evalsSha256: "f".repeat(64) });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.reason).toContain("different task sets (evalsSha256 eeeeeeeeeeee vs ffffffffffff)");
    for (const [over, needle] of [
      [{ subject: "other" }, "different subjects"],
      [{ tasks: ["port"] }, "different tasks"],
      [{ tasks: ["port", "x"] }, "different tasks"],
      [{ modes: ["soul"] as const }, "different modes"],
    ] as const) {
      const r = comparable(a, { ...a, ...over });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(needle);
    }
    // Order of tasks does not matter.
    expect(comparable(a, { ...a, tasks: ["disk", "port"] }).ok).toBe(true);
  });

  test("compare ids look like run ids", () => {
    expect(newCompareId(new Date("2026-10-19T08:09:10.5Z"))).toMatch(/^cmp-20261019T080910Z-[0-9a-f]{4}$/);
  });

  test("the printed comparison: both sides, per split, each change, the verdict, and that nothing changed", () => {
    const link = { id: "cmp-20261019T080000Z-abcd", ref: "HEAD~1", commit: "c0ffee00".repeat(5) };
    const base = { ...a, compare: { ...link, role: "base" as const } };
    const cand = run({ runId: "ev-20261019T080500Z-bbbb", soul: { gitTree: "5e6f7a8b9c", dirty: false, contentSha256: "ab".repeat(32), files: ["role.md"] }, compare: { ...link, role: "candidate" } }, [
      ...rows("port", "train", { soul: [false], "soul+rag": [true] }),
      ...rows("disk", "heldout", { soul: [true], "soul+rag": [true] }),
    ]);
    const plain = { bold: (x: string) => x, dim: (x: string) => x };
    const lines = compareLines(base, cand, plain).join("\n");
    expect(lines).toContain("cmp-20261019T080000Z-abcd — 2 task(s) × 2 modes, base ×1, candidate ×1");
    expect(lines).toMatch(/base {7}tree 1a2b3c4d\* +working tree +ev-20261019T080000Z-aaaa/);
    expect(lines).toMatch(/candidate {2}tree 5e6f7a8b +HEAD~1 = c0ffee00 +ev-20261019T080500Z-bbbb/);
    expect(lines).toMatch(/train +1 task\(s\) +100% +50% +-50/);
    expect(lines).toMatch(/heldout +1 task\(s\) +0% +100% +\+100/);
    expect(lines).toContain("changes (task × mode) — 3 changed, 1 the same");
    expect(lines).toMatch(/port +soul +train +pass→fail +1\/1 → 0\/1\n/);
    expect(lines).toMatch(/disk +soul\+rag +heldout +fail→pass +0\/1 → 1\/1/);
    expect(lines).toContain("T6 verdict: adopt — held-out pass rate rose 0% → 100% and no held-out task flipped pass→fail");
    expect(lines).toContain("Held-out is 1 task(s): too small to judge a tuning decision (at least 6).");
    expect(lines).toContain("Nothing was changed: adopting a candidate is S21.5's.");
    // Reversed: the held-out loss is marked as what blocks adoption; two plain records are "recorded run".
    const back = compareLines({ ...cand, compare: undefined } as unknown as EvalRunRecord, a, plain).join("\n");
    expect(back).toContain("recorded run");
    expect(back).toMatch(/disk +soul +heldout +pass→fail +1\/1 → 0\/1 {2}← blocks adoption/);
    expect(back).toContain("T6 verdict: keep-base");
    expect(compareLines(a, a, plain).join("\n")).toContain("changes (task × mode) — 0 changed, 4 the same\n  none");
    const noHeld = run({}, rows("port", "train", { soul: [true] }));
    const printed = compareLines(noHeld, noHeld, plain);
    expect(printed.join("\n")).toMatch(/heldout +0 task\(s\) +—/);
    expect(printed.some((l) => l.startsWith("Held-out is"))).toBe(false);
  });
});
