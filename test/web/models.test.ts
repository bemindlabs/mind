/** D-085, D-142 — what the chat's backend and model picker offers. */

import { describe, expect, test } from "bun:test";
import { takesNoModel, VENDORS } from "../../src/exec/index.ts";
import { DEFAULT_PRICES } from "../../src/pricing/table.ts";
import { modelChoices, ollamaTags } from "../../src/web/models.ts";

describe("the chat's model choices", () => {
  test("a vendor's own documented names, then the price table's for that backend; the local model and Ollama's list, no embedders", () => {
    const got = modelChoices({
      backends: ["claude", "codex", "ollama", "kimi", "claude-local"],
      listed: { claude: ["fable", "opus"], codex: [], kimi: [] },
      priced: [
        { backend: "claude", model: "claude-opus-5-5" },
        { backend: "claude", model: "opus" },
        { backend: "grok", model: "grok-4.7" },
        { backend: "ollama", model: "typhoon-4b" },
      ],
      modelless: ["claude-local"],
      localModel: "qwen3.8:27b",
      ollama: ["bge-m3:latest", "typhoon-4b", "nomic-embed-text", "gemma3:27b"],
    });
    // Once each, the vendor's names first; a price for another backend is not offered here.
    expect(got["claude"]).toEqual(["fable", "opus", "claude-opus-5-5"]);
    expect(got["codex"]).toEqual([]);
    expect(got["ollama"]).toEqual(["qwen3.8:27b", "typhoon-4b", "gemma3:27b"]);
    expect(got["kimi"]).toEqual([]);
    // A backend that takes no model is offered none, even one a table prices.
    expect(got["claude-local"]).toEqual([]);
    expect(modelChoices({ backends: ["ollama"], listed: {}, priced: [], modelless: [], localModel: null, ollama: [] })["ollama"]).toEqual([]);
  });

  test("nothing comes from the ledger: the input has no field for it, and the real inputs name only vendor and table names", () => {
    // The ledger's history carried wrong names (a claude line from before S15.9 said `qwen3:8b`). The picker is
    // built from the registry and the price table alone — the same inputs `mind web` passes.
    const listed = Object.fromEntries(VENDORS.flatMap((v) => (v.model === undefined ? [] : [[v.id, v.model.listed] as const])));
    const backends = ["claude", "grok", "ollama", "claude-local", "grok-local"];
    const got = modelChoices({
      backends,
      listed,
      priced: DEFAULT_PRICES.entries,
      modelless: backends.filter((b) => takesNoModel(b) !== undefined),
      localModel: null,
      ollama: [],
    });
    expect(got["claude"]).toContain("opus");
    expect(got["claude"]).toContain("claude-opus-5-5");
    expect(got["grok"]).toContain("grok-4.7");
    expect(got["claude-local"]).toEqual([]);
    expect(got["grok-local"]).toEqual([]);
    for (const names of Object.values(got)) expect(names).not.toContain("qwen3:8b");
  });

  test("an Ollama tag list, and anything else is none", () => {
    expect(ollamaTags({ models: [{ name: "a:1" }, { name: "" }, { nope: 1 }, { name: "b" }] })).toEqual(["a:1", "b"]);
    for (const bad of [null, {}, { models: "x" }, 3]) expect(ollamaTags(bad)).toEqual([]);
  });
});
