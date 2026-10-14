/** D-093 — facts drawn out of memory: each quotes its note, or it is cut; only yeses become notes. */

import { describe, expect, test } from "bun:test";
import { checkFacts, distillPrompt, factChunks, factNotes, readFacts, type FactDraft } from "../../src/memory/distill.ts";

const NOTE = "# vLLM\n\nvLLM listens on 127.0.0.1:10410 and every service goes through LiteLLM on port 10400.\nSnapshots run nightly.\n";

describe("distilling facts", () => {
  test("the prompt names the note and asks for quotes copied exactly", () => {
    const [chunk] = factChunks("memory/knowledge/vllm.md", NOTE);
    const p = distillPrompt(chunk!);
    expect(p.user.startsWith("NOTE: memory/knowledge/vllm.md (from line 1)")).toBe(true);
    expect(p.system).toContain("copied EXACTLY");
    expect(p.system).toContain("No credentials");
  });

  test("a reply is read for shape; a fact whose quote is not in the note is cut; a repeat is kept once", () => {
    const reply = `Here you go:\n${JSON.stringify([
      { fact: "vLLM listens on port 10410.", quote: "listens on 127.0.0.1:10410", topic: "vLLM Ports" },
      { fact: "Services reach vLLM through LiteLLM.", quote: "goes through LiteLLM on port 10400", topic: "" },
      { fact: "Backups run at 03:00.", quote: "backups run at three in the morning", topic: "backups" },
      { fact: "vllm listens on port 10410", quote: "listens on 127.0.0.1:10410", topic: "ports" },
      { fact: "", quote: "x" },
      "not an object",
    ])}`;
    const offered = readFacts(reply);
    expect(offered.map((f) => f.topic)).toEqual(["vllm-ports", "general", "backups", "ports"]);
    const [chunk] = factChunks("memory/knowledge/vllm.md", NOTE);
    const checked = checkFacts(offered, chunk!, new Set());
    expect(checked.cut).toBe(1);
    expect(checked.facts.map((f) => [f.fact, f.source.line])).toEqual([["vLLM listens on port 10410.", 3], ["Services reach vLLM through LiteLLM.", 3]]);
    expect(checked.facts.every((f) => /^[0-9a-f]{8}$/.test(f.id) && f.decision === null)).toBe(true);
    for (const bad of ["no json here", "[not json", "{}"]) expect(readFacts(bad)).toEqual([]);
  });

  test("the yeses become one note per topic; a note already there gains only the lines it lacks", () => {
    const fact = (id: string, text: string, topic: string, decision: "yes" | "no" | null) => ({ id, fact: text, quote: "q".repeat(8), topic, source: { path: "memory/knowledge/vllm.md", line: 3 }, decision });
    const draft: FactDraft = { v: 1, id: "d", at: "t", subject: "s", model: "m", sources: [], chunks: 1, cut: 0, facts: [fact("a", "vLLM is on 10410.", "ports", "yes"), fact("b", "LiteLLM is on 10400.", "ports", "yes"), fact("c", "Wrong one.", "ports", "no"), fact("d", "Snapshots nightly.", "backups", null)] };
    const now = new Date("2026-09-26T12:00:00Z");
    const fresh = factNotes(draft, () => undefined, now);
    expect(fresh.map((n) => [n.path, n.added])).toEqual([["memory/knowledge/facts/ports.md", 2]]);
    expect(fresh[0]!.text).toContain("tags: [facts, ports]");
    expect(fresh[0]!.text).toContain("- vLLM is on 10410. — `memory/knowledge/vllm.md:3`\n- LiteLLM is on 10400. — `memory/knowledge/vllm.md:3`\n");
    expect(fresh[0]!.text).not.toContain("Wrong one");
    const again = factNotes(draft, () => fresh[0]!.text, now);
    expect(again).toEqual([]);
    const partly = factNotes(draft, () => "---\nname: x\n---\n\n- vLLM is on 10410. — `elsewhere.md:1`\n", now);
    expect(partly[0]!.added).toBe(1);
    expect(partly[0]!.text.endsWith("- vLLM is on 10410. — `elsewhere.md:1`\n- LiteLLM is on 10400. — `memory/knowledge/vllm.md:3`\n")).toBe(true);
  });
});
