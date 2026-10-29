/** S21.2 — `mind eval split`: a held-out set stratified by kind, fixed by its seed, written only on request. */

import { describe, expect, test } from "bun:test";
import { applySplit, DEFAULT_SEED, parseHeldout, proposalLines, proposeSplit } from "../../src/soul/eval-split.ts";
import { parseEvals, type EvalTask } from "../../src/soul/evals.ts";

const t = (id: string, kind: string): EvalTask => ({ id, kind, ask: `${id}?`, expect: ["x"], reject: [], source: "", split: "train" });
/** 12 ports, 8 incidents, 4 billing: 24 tasks, the plan's size. */
const TASKS: readonly EvalTask[] = [
  ...Array.from({ length: 12 }, (_, i) => t(`port-${i}`, "ports")),
  ...Array.from({ length: 8 }, (_, i) => t(`inc-${i}`, "incidents")),
  ...Array.from({ length: 4 }, (_, i) => t(`bill-${i}`, "billing")),
];

describe("the proposal", () => {
  test("stratified by kind: each kind its share of n, by largest remainder", () => {
    const p = proposeSplit(TASKS, 6);
    expect(p.seed).toBe(DEFAULT_SEED);
    expect(p.heldout).toHaveLength(6);
    expect(p.byKind.map((k) => [k.kind, k.heldout.length, k.train.length])).toEqual([["billing", 1, 3], ["incidents", 2, 6], ["ports", 3, 9]]);
    // 5 of 24: shares 2.5, 1.67, 0.83 → floors 2, 1, 0; the two largest remainders (billing .83, incidents .67) get one each.
    expect(proposeSplit(TASKS, 5).byKind.map((k) => k.heldout.length)).toEqual([1, 2, 2]);
    // Every task is on exactly one side.
    const sides = p.byKind.flatMap((k) => [...k.heldout, ...k.train]).sort();
    expect(sides).toEqual(TASKS.map((x) => x.id).sort());
  });

  test("the same seed gives the same split, whatever the file's order; another seed draws again", () => {
    const a = proposeSplit(TASKS, 6, "s1");
    expect(proposeSplit([...TASKS].reverse(), 6, "s1").byKind).toEqual(a.byKind);
    expect(proposeSplit(TASKS, 6, "s1")).toEqual(a);
    const draws = new Set(["s2", "s3", "s4", "s5"].map((s) => proposeSplit(TASKS, 6, s).heldout.join()));
    expect(draws.size).toBeGreaterThan(1);
    // Held-out ids come back in the file's order.
    expect(a.heldout).toEqual(TASKS.map((x) => x.id).filter((id) => a.heldout.includes(id)));
  });

  test("--heldout: 1 to tasks − 1", () => {
    expect(parseHeldout("6", 24)).toEqual({ ok: true, value: 6 });
    for (const bad of [undefined, "", "0", "24", "2.5", "x"]) expect(parseHeldout(bad, 24).ok, String(bad)).toBe(false);
    const one = parseHeldout("1", 1);
    expect(one.ok).toBe(false);
    if (!one.ok) expect(one.reason).toContain("the set has 1 task(s)");
  });

  test("printed per kind", () => {
    const lines = proposalLines(proposeSplit(TASKS.slice(0, 3), 1, "x"), 3);
    expect(lines[0]).toBe('1 of 3 task(s) held out, stratified by kind, seed "x":');
    expect(lines[1]).toMatch(/^ {2}ports\s+heldout port-\d {3}train port-\d, port-\d$/);
    expect(proposalLines({ seed: "s", heldout: [], byKind: [{ kind: "k", heldout: [], train: [] }] }, 0)[1]).toContain("heldout —   train —");
  });
});

const SET = `+++
schema = "mind/evals@1" # old

[a]
ask = "a?"
expect = ["x"]

["b"]
ask = "b?"
expect = ["x"]

[c]
ask = "c?"
expect = ["x"]
+++

Notes stay.
`;

describe("writing the split", () => {
  test("held-out lines under the chosen headers, old split lines gone, schema raised, body kept", () => {
    const first = applySplit(SET, new Set(["b"]));
    if (!first.ok) throw new Error(first.reason);
    expect(first.text).toContain('schema = "mind/evals@2" # old');
    expect(first.text).toContain('["b"]\nsplit = "heldout"\nask = "b?"');
    expect(first.text.endsWith("+++\n\nNotes stay.\n")).toBe(true);
    const parsed = parseEvals("evals.md", first.text);
    if (!parsed.ok) throw new Error("parse");
    expect(parsed.value.map((x) => x.split)).toEqual(["train", "heldout", "train"]);
    // A second write replaces the first: b back to train, c held out.
    const second = applySplit(first.text, new Set(["c"]));
    if (!second.ok) throw new Error(second.reason);
    expect(second.text.match(/split =/g)).toHaveLength(1);
    const again = parseEvals("evals.md", second.text);
    if (!again.ok) throw new Error("parse");
    expect(again.value.map((x) => x.split)).toEqual(["train", "train", "heldout"]);
  });

  test("refused, with the reason, when the text cannot be edited safely", () => {
    const none = applySplit("no frontmatter", new Set(["a"]));
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toContain("no +++ frontmatter");
    const unknown = applySplit(SET, new Set(["zzz"]));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toContain("zzz");
    const dotted = applySplit('+++\nschema = "mind/evals@2"\na = { ask = "a?", expect = ["x"] }\n+++\n', new Set(["a"]));
    expect(dotted.ok).toBe(false);
    if (!dotted.ok) expect(dotted.reason).toContain("by hand");
    const broken = applySplit('+++\nschema = "mind/evals@2"\n[a]\nask = "a?"\n+++\n', new Set(["a"]));
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.reason).toContain("would not parse");
  });
});
