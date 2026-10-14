/**
 * What the chat's backend and model picker offers (D-085, D-142).
 *
 * Only names that have a reason to work, and only from the vendor's side: the
 * names a vendor CLI documents for its own model flag (`ModelSpec.listed`, read
 * off its `--help`), the names a price table in force lists for that backend,
 * the local model this page was started with, and what the local Ollama lists.
 *
 * Not the ledger. It used to be: models that had answered on a backend, newest
 * first. But a line's `model` was not always a model the backend was handed — a
 * claude line from before S15.9 says `qwen3:8b` — and a stale name offered as a
 * suggestion is a turn that fails. A backend that takes no model (the local CLI
 * variants run `local-coder` and nothing else) is offered none. The box stays
 * free text, so any other name can still be typed.
 */

/** What the composer's picker receives from `/api/models`. */
export interface ModelsState {
  readonly backends: readonly { readonly id: string; readonly available: boolean }[];
  /** The chain a turn tries when the page names no backend. */
  readonly chain: readonly string[];
  /** What `mind web` was started with. */
  readonly defaultTurn: { readonly backend: string | null; readonly model: string | null };
  /** Per backend id, the model names worth suggesting, best first. */
  readonly models: Readonly<Record<string, readonly string[]>>;
}

const MAX_PER_BACKEND = 16;
/** An embedding model answers no chat turn. */
const EMBEDDING = /embed|bge-|nomic|minilm|e5-/i;

export function modelChoices(input: {
  readonly backends: readonly string[];
  /** Per vendor id, the names its own `--help` documents; absent for a backend that takes no model. */
  readonly listed: Readonly<Record<string, readonly string[]>>;
  /** The price entries in force (owner's first), as `usage prices` lists them. */
  readonly priced: readonly { readonly backend: string; readonly model: string }[];
  /** Backends that take no model at all. */
  readonly modelless: readonly string[];
  readonly localModel: string | null;
  readonly ollama: readonly string[];
}): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const id of input.backends) {
    if (input.modelless.includes(id)) {
      out[id] = [];
      continue;
    }
    const names: string[] = [...(input.listed[id] ?? []), ...input.priced.filter((p) => p.backend === id).map((p) => p.model)];
    if (id === "ollama") {
      if (input.localModel !== null) names.unshift(input.localModel);
      names.push(...input.ollama.filter((m) => !EMBEDDING.test(m)));
    }
    out[id] = [...new Set(names)].slice(0, MAX_PER_BACKEND);
  }
  return out;
}

/** Model names out of an Ollama `/api/tags` body; none for anything else. */
export function ollamaTags(body: unknown): string[] {
  const models = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return [];
  return models.map((m) => (m as { name?: unknown })?.name).filter((n): n is string => typeof n === "string" && n !== "");
}
