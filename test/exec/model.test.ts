/**
 * D-142 — which backend a `--model` belongs to, and what may be handed to one at all.
 *
 * The routing is the whole of the chain rule: a model reaches the step it was chosen for and no other, a bare
 * name in a chain of several stays ollama's as it always was, and a backend that takes no model refuses one
 * rather than running its default. The shape check is the argv rule: one element, never a flag, never a second
 * argument, never something a shell or a terminal would read.
 */

import { describe, expect, test } from "bun:test";
import { LOCAL_BACKENDS } from "../../src/exec/local-cli.ts";
import { modelRefusal, routeModels, takesNoModel } from "../../src/exec/model.ts";
import { MODEL_MAX, modelProblem, VENDORS } from "../../src/exec/registry.ts";

const routed = (raw: string | undefined, chain: readonly string[]) => {
  const got = routeModels(raw, chain);
  if (!got.ok) throw new Error(`expected a route, got: ${got.reason}`);
  return Object.fromEntries(got.models);
};
const refused = (raw: string | undefined, chain: readonly string[]) => {
  const got = routeModels(raw, chain);
  if (got.ok) throw new Error(`expected a refusal, got a route: ${JSON.stringify(Object.fromEntries(got.models))}`);
  return got.reason;
};

describe("modelProblem — the shape a model name must have to go on argv", () => {
  test("real names from every kind of backend pass", () => {
    for (const name of [
      "opus",
      "claude-opus-5-5",
      "claude-haiku-4-5-20251001",
      "opus[1m]",
      "grok-4.7",
      "gpt-5.1-codex-mini",
      "qwen3.8:27b",
      "hf.co/org/Model-GGUF:Q4_K_M",
      "org/name@rev",
      "local-coder",
      "a".repeat(MODEL_MAX),
    ]) {
      expect(modelProblem(name), name).toBeUndefined();
    }
  });

  test("hostile and malformed strings are refused, each with a reason", () => {
    const cases: readonly [string, string][] = [
      ["", "is empty"],
      ["-rf", "starts with '-'"],
      ["--dangerously-skip-permissions", "starts with '-'"],
      ["a".repeat(MODEL_MAX + 1), "longer than"],
      ["opus --tools Bash", "a character"],
      ["opus;rm -rf /", "a character"],
      ["$(id)", "a character"],
      ["`id`", "a character"],
      ["opus\n--yes", "a character"],
      ["opus\u0000", "a character"],
      ["\u001b[31mopus", "a character"],
      ["‮opus", "a character"],
      ["'opus'", "a character"],
      ['"opus"', "a character"],
      ["opus=x", "a character"],
      ["a,b", "a character"],
      ["../../etc/passwd", "a character"],
      ["/abs/path.gguf", "a character"],
      ["~/.ssh/id", "a character"],
      [".hidden", "a character"],
      ["é-model", "a character"],
      [" opus", "a character"],
    ];
    for (const [name, reason] of cases) expect(modelProblem(name), JSON.stringify(name)).toContain(reason);
  });
});

describe("takesNoModel and modelRefusal", () => {
  test("every vendor takes one, ollama takes one, the local variants take none", () => {
    for (const spec of VENDORS) expect(takesNoModel(spec.id), spec.id).toBeUndefined();
    expect(takesNoModel("ollama")).toBeUndefined();
    for (const id of LOCAL_BACKENDS) expect(takesNoModel(id)).toContain("local-coder");
    // Never a throw: `web` and `chat serve` ask this of a --backend nobody has checked yet.
    expect(takesNoModel("nonesuch")).toContain(`"nonesuch" is not a backend Mind knows`);
    expect(refused("x", ["nonesuch"])).toContain("is not a backend Mind knows");
  });

  test("a refusal names the backend or the shape; a fit is undefined", () => {
    expect(modelRefusal("claude", "opus")).toBeUndefined();
    expect(modelRefusal("claude-local", "opus")).toContain("claude-local runs local-coder");
    expect(modelRefusal("claude", "-x")).toContain(`the model "-x" starts with '-'`);
  });
});

describe("routeModels — each step its own model, or none", () => {
  test("no --model: no step gets one", () => {
    expect(routed(undefined, ["claude", "codex", "ollama"])).toEqual({});
    expect(routed("", ["claude"])).toEqual({});
    expect(routed("   ", ["claude"])).toEqual({});
  });

  test("a bare name goes to the only backend named — a vendor CLI included, which is what D-142 fixes", () => {
    expect(routed("opus", ["claude"])).toEqual({ claude: "opus" });
    expect(routed("grok-4.7", ["grok"])).toEqual({ grok: "grok-4.7" });
    expect(routed("qwen3:8b", ["ollama"])).toEqual({ ollama: "qwen3:8b" });
  });

  test("a bare name in a chain of several stays ollama's, and reaches no vendor", () => {
    // What `--model` always meant with the default chain: `turn --model stub` answers on ollama.
    expect(routed("stub", ["claude", "codex", "ollama"])).toEqual({ ollama: "stub" });
    expect(routed("stub", ["claude-local", "grok-local", "claude", "codex", "ollama"])).toEqual({ ollama: "stub" });
  });

  test("a bare name in a chain of several without ollama is refused: which step was meant cannot be known", () => {
    const reason = refused("opus", ["claude", "codex"]);
    expect(reason).toContain("chain has 2 backends (claude, codex)");
    expect(reason).toContain("--model claude=opus");
  });

  test("backend=model gives each named step its own, and the rest none", () => {
    expect(routed("claude=opus", ["claude", "codex", "ollama"])).toEqual({ claude: "opus" });
    expect(routed("claude=opus,ollama=qwen3:8b", ["claude", "codex", "ollama"])).toEqual({ claude: "opus", ollama: "qwen3:8b" });
    expect(routed(" codex = gpt-5.1 , grok=grok-4.7 ", ["codex", "grok"])).toEqual({ codex: "gpt-5.1", grok: "grok-4.7" });
  });

  test("backend=model that does not fit the chain, or is not one, is refused", () => {
    expect(refused("grok=grok-4.7", ["claude", "ollama"])).toContain("grok, which is not in the chain");
    expect(refused("claude=opus,claude=haiku", ["claude"])).toContain("two models for claude");
    expect(refused("=opus", ["claude"])).toContain("is not <backend>=<model>");
    expect(refused("claude=", ["claude"])).toContain("is not <backend>=<model>");
    expect(refused("claude=opus,", ["claude"])).toContain("is not <backend>=<model>");
    expect(refused("claude=opus,ollama", ["claude", "ollama"])).toContain('"ollama" is not <backend>=<model>');
  });

  test("a step that takes no model, or a name of the wrong shape, is refused — never passed on or dropped", () => {
    expect(refused("opus", ["claude-local"])).toContain("claude-local runs local-coder");
    expect(refused("grok-local=x", ["grok-local", "ollama"])).toContain("grok-local runs local-coder");
    expect(refused("-rf", ["claude"])).toContain("starts with '-'");
    expect(refused("claude=--yes", ["claude", "ollama"])).toContain("starts with '-'");
    expect(refused("claude=$(id)", ["claude"])).toContain("a character");
  });
});
