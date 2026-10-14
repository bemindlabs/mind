/** S6.5 (D-073) — the task set, the mechanical grade, and the report. */

import { describe, expect, test } from "bun:test";
import { grade, MIN_TASKS, NOT_MEASURED, parseEvals, report, type EvalResult, type EvalTask } from "../../src/soul/evals.ts";

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
      { id: "vllm-port", kind: "ports", ask: "Which port does vLLM use?", expect: ["10410"], reject: ["11434"], source: "memory/ports.md" },
      { id: "restart", kind: "general", ask: "How do I restart the web page?", expect: ["systemctl --user restart"], reject: [], source: "" },
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
  const task: EvalTask = { id: "t", kind: "k", ask: "a", expect: ["10410", "LiteLLM"], reject: ["11434"], source: "" };
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
      { id: "a", kind: "ports", ask: "", expect: ["x"], reject: [], source: "" },
      { id: "b", kind: "ports", ask: "", expect: ["x"], reject: [], source: "" },
      { id: "c", kind: "incidents", ask: "", expect: ["x"], reject: [], source: "" },
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
