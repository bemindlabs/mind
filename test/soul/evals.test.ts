/** S6.5 (D-073) — the task set, the mechanical grade, and the report; S21.2 — the split. */

import { describe, expect, test } from "bun:test";
import { bySplit, EVALS_SCHEMA, grade, MIN_HELDOUT, MIN_TASKS, NOT_MEASURED, parseEvals, parseSplitFilter, report, type EvalResult, type EvalTask } from "../../src/soul/evals.ts";

const SET = `+++
schema = "mind/evals@1"

[vllm-port]
kind = "ports"
ask = "Which port does vLLM use?"
expect = ["10410"]
reject = ["11434"]
source = "memory/ports.md"

[restart]
ask = "How do I restart the web page?"
expect = "systemctl --user restart"
+++

notes
`;

describe("the task set", () => {
  test("parses tasks, with a default kind and a single expect as a list", () => {
    const parsed = parseEvals("evals.md", SET);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    expect(parsed.value).toEqual([
      { id: "vllm-port", kind: "ports", ask: "Which port does vLLM use?", expect: ["10410"], reject: ["11434"], source: "memory/ports.md", split: "train" },
      { id: "restart", kind: "general", ask: "How do I restart the web page?", expect: ["systemctl --user restart"], reject: [], source: "", split: "train" },
    ]);
    expect(MIN_TASKS).toBe(20);
  });

  test("says what is wrong, by line", () => {
    const bad = parseEvals("evals.md", `+++\nschema = "x"\n\n[Bad_Id]\nask = "a"\nexpect = ["b"]\n\n[no-ask]\nexpect = ["b"]\n\n[no-expect]\nask = "a"\nexpect = []\nweird = 1\n\n[blank]\nask = "a"\nexpect = [""]\nreject = [""]\n\nloose = 3\n+++\n`);
    expect(bad.ok).toBe(false);
    const messages = bad.ok ? "" : bad.issues.map((i) => `${i.path}: ${i.message}`).join("\n");
    for (const needle of ["schema must be", "Bad_Id", "no-ask.ask", "no-expect.expect", "no-expect.weird", "blank.expect", "blank.reject", "loose is not a task"]) expect(messages).toContain(needle);
  });
});

describe("the grade", () => {
  const task: EvalTask = { id: "t", kind: "k", ask: "a", expect: ["10410", "LiteLLM"], reject: ["11434"], source: "", split: "train" };
  test("every expect present, no reject present — spacing, case and emphasis forgiven", () => {
    expect(grade(task, "vLLM is on **10410**; call litellm instead").pass).toBe(true);
    expect(grade(task, "vLLM is on 10410").missing).toEqual(["LiteLLM"]);
    expect(grade(task, "10410 via LiteLLM, or 11434").rejected).toEqual(["11434"]);
    expect(grade({ ...task, expect: ["x"], reject: [] }, "").pass).toBe(false);
  });
});

describe("the report", () => {
  test("per mode, per kind, what is not yet replaceable, and LoRA said as not measured", () => {
    const tasks: EvalTask[] = [
      { id: "a", kind: "ports", ask: "", expect: ["x"], reject: [], source: "", split: "train" },
      { id: "b", kind: "ports", ask: "", expect: ["x"], reject: [], source: "", split: "train" },
      { id: "c", kind: "incidents", ask: "", expect: ["x"], reject: [], source: "", split: "train" },
    ];
    const r = (task: string, kind: string, mode: "soul" | "soul+rag", pass: boolean): EvalResult => ({ task, kind, mode, pass, missing: [], rejected: [], route: "" });
    const out = report(tasks, [r("a", "ports", "soul", false), r("a", "ports", "soul+rag", true), r("b", "ports", "soul", false), r("b", "ports", "soul+rag", true), r("c", "incidents", "soul", false), r("c", "incidents", "soul+rag", false)]);
    expect(out.byMode).toEqual([{ mode: "soul", passed: 0, percent: 0 }, { mode: "soul+rag", passed: 2, percent: 66.7 }]);
    expect(out.byKind.find((k) => k.kind === "ports")!.percent).toEqual({ soul: 0, "soul+rag": 100 });
    expect(out.notYet).toEqual(["incidents"]);
    expect(out.notMeasured).toBe(NOT_MEASURED);
    expect(NOT_MEASURED[0]!.mode).toBe("soul+rag+fine-tune");
  });
});

describe("the split (S21.2, owner ruling T3)", () => {
  const V2 = `+++
schema = "mind/evals@2"

[a]
ask = "a?"
expect = ["x"]

[b]
ask = "b?"
expect = ["x"]
split = "heldout"

[c]
ask = "c?"
expect = ["x"]
split = "train"
+++
`;

  test("@2: split per task, train by default; @1 still parses, every task train", () => {
    const two = parseEvals("evals.md", V2);
    if (!two.ok) throw new Error(JSON.stringify(two.issues));
    expect(two.value.map((t) => [t.id, t.split])).toEqual([["a", "train"], ["b", "heldout"], ["c", "train"]]);
    expect(EVALS_SCHEMA).toBe("mind/evals@2");
    const one = parseEvals("evals.md", SET);
    if (!one.ok) throw new Error(JSON.stringify(one.issues));
    expect(one.value.every((t) => t.split === "train")).toBe(true);
  });

  test("an unknown split, or a split under @1, is refused by line", () => {
    const bad = parseEvals("evals.md", V2.replace('split = "heldout"', 'split = "test"'));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.map((i) => i.message).join()).toContain('split is "train" or "heldout", not "test"');
    const old = parseEvals("evals.md", V2.replace("mind/evals@2", "mind/evals@1"));
    expect(old.ok).toBe(false);
    if (!old.ok) expect(old.issues.map((i) => i.path)).toEqual(["b.split", "c.split"]);
    const notString = parseEvals("evals.md", V2.replace('split = "heldout"', "split = 1"));
    expect(notString.ok).toBe(false);
  });

  test("--split: all by default, one side or both; anything else refused", () => {
    expect(parseSplitFilter(undefined)).toEqual({ ok: true, value: "all" });
    for (const v of ["train", "heldout", "all"] as const) expect(parseSplitFilter(v)).toEqual({ ok: true, value: v });
    const bad = parseSplitFilter("test");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("train, heldout or all");
    const parsed = parseEvals("evals.md", V2);
    if (!parsed.ok) throw new Error("set");
    expect(bySplit(parsed.value, "heldout").map((t) => t.id)).toEqual(["b"]);
    expect(bySplit(parsed.value, "train").map((t) => t.id)).toEqual(["a", "c"]);
    expect(bySplit(parsed.value, "all")).toHaveLength(3);
    expect(MIN_HELDOUT).toBe(6);
  });
});
