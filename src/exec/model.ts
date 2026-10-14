/**
 * Which backend a `--model` belongs to, and whether that backend can take one at all (D-142).
 *
 * A model is a fact about one backend, never about a turn. `opus` means something to claude and nothing to
 * ollama; `qwen3:8b` is the other way round. So a model is bound to the backend it was chosen for when that
 * backend is built (`backend(id, { model })`), and a fallback chain carries no model of its own — each step
 * runs the model it was given, or its own default.
 *
 * The command line says which step a model is for in one of two ways:
 *
 * - `--model <name>` — the chain's only backend; or, in a chain of several, its `ollama` step. That second rule is
 *   what `--model` always meant (`turn --model stub` with the default chain `claude → codex → ollama`), and it
 *   stays: a bare name in a chain of several never reaches a vendor CLI. A chain of several without ollama is
 *   refused, because which step was meant cannot be known.
 * - `--model <backend>=<name>[,<backend>=<name>…]` — each named step its own model. `=` and `,` never occur in a
 *   model name (`modelProblem`), so the two forms cannot be confused.
 *
 * Every model is checked before anything is sent: its shape, and that the backend takes one — the local CLI
 * variants run `local-coder` and nothing else, and a vendor without a {@link import("./registry.ts").ModelSpec}
 * has no flag Mind has read off its `--help`. A refusal says so; nothing runs on a default in its place.
 */

import { isLocalCliId, LOCAL_MODEL } from "./local-cli.ts";
import { modelProblem, VENDORS } from "./registry.ts";

/** Why this backend can be handed no model at all, or undefined when it can. */
export function takesNoModel(id: string): string | undefined {
  if (id === "ollama") return undefined;
  if (isLocalCliId(id)) return `${id} runs ${LOCAL_MODEL} through LiteLLM on this machine and takes no other model`;
  const spec = VENDORS.find((v) => v.id === id);
  if (spec === undefined) return `${JSON.stringify(id)} is not a backend Mind knows`;
  return spec.model === undefined ? `${id} has no model flag Mind has read off its --help` : undefined;
}

/** Why this model may not be handed to this backend, or undefined when it may. */
export function modelRefusal(id: string, model: string): string | undefined {
  const cannot = takesNoModel(id);
  if (cannot !== undefined) return cannot;
  const bad = modelProblem(model);
  return bad === undefined ? undefined : `the model ${JSON.stringify(model)} ${bad}`;
}

/** The model each step of a chain is handed — only the steps named — or why the command line cannot be read so. */
export type ModelRoute =
  | { readonly ok: true; readonly models: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly reason: string };

/**
 * `--model` as the command line wrote it, against the chain it will run on. See the file comment for the two
 * forms. A backend Mind does not know is refused if a model is routed to it; saying so for the rest of the
 * chain is the caller's job, as it was before D-142.
 */
export function routeModels(raw: string | undefined, chain: readonly string[]): ModelRoute {
  const text = (raw ?? "").trim();
  const models = new Map<string, string>();
  if (text === "") return { ok: true, models };

  if (!text.includes("=")) {
    const target = chain.length === 1 ? chain[0] : chain.includes("ollama") ? "ollama" : undefined;
    if (target === undefined) {
      return {
        ok: false,
        reason:
          `--model names one model and the chain has ${chain.length} backends (${chain.join(", ")}), none of them ollama — ` +
          `say which one it is for: --model ${chain[0] ?? "<backend>"}=${text}`,
      };
    }
    models.set(target, text);
  } else {
    for (const part of text.split(",")) {
      const at = part.indexOf("=");
      const id = part.slice(0, Math.max(at, 0)).trim();
      const name = part.slice(at + 1).trim();
      if (at <= 0 || id === "" || name === "") {
        return { ok: false, reason: `--model ${JSON.stringify(part.trim())} is not <backend>=<model>` };
      }
      if (!chain.includes(id)) {
        return { ok: false, reason: `--model names a model for ${id}, which is not in the chain (${chain.join(", ")})` };
      }
      if (models.has(id)) return { ok: false, reason: `--model names two models for ${id}` };
      models.set(id, name);
    }
  }

  for (const [id, name] of models) {
    const refused = modelRefusal(id, name);
    if (refused !== undefined) return { ok: false, reason: `--model: ${refused}` };
  }
  return { ok: true, models };
}
