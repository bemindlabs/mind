/**
 * The local path — the one that has to keep working when the others are gone.
 *
 * I-1 says every capability needs a local route that really works, and the
 * acceptance test is blunt: take the commercial CLIs off PATH and the work
 * still finishes. This file is what makes that passable, so it is not an
 * afterthought behind the same interface — it is the reason the interface
 * exists.
 *
 * It is also the only backend here that takes a system prompt as a first-class
 * field rather than a flag or a file, which is why a local model can carry an
 * identity at full strength while three of the vendor CLIs cannot.
 */

import { readMind } from "../env.ts";
import type {
  Availability,
  ExecBackend,
  IdentityStrength,
  TurnRequest,
  TurnResult,
} from "./backend.ts";
import { classify } from "./backend.ts";
import { tokenCount, type Usage } from "../types.ts";

/** Where ollama listens when nothing says otherwise. */
const DEFAULT_HOST = "http://127.0.0.1:11434";
const DEFAULT_TIMEOUT_MS = 300_000;

/** The model the local backend uses when a turn names none (D-070). */
export const OLLAMA_MODEL_ENV = "MIND_OLLAMA_MODEL";

export interface OllamaOptions {
  /** Base URL. Falls back to `OLLAMA_HOST`, then localhost. */
  readonly host?: string;
  /** Model to use when a request names none. */
  readonly defaultModel?: string;
}

/** Shape of the subset of ollama's chat response Mind reads. */
interface OllamaChatResponse {
  readonly message?: { readonly content?: string };
  readonly error?: string;
}

/** What every ollama usage says about the counts the daemon never prints. */
const OLLAMA_SHAPE = {
  total: null,
  cache_read: null,
  cache_write: null,
  cache_write_5m: null,
  cache_write_1h: null,
  not_printed: ["cache_read", "cache_write", "cache_write_5m", "cache_write_1h"] as const,
} satisfies Partial<Usage>;

/**
 * Read ollama's own token counts out of a chat response body.
 *
 * I-1 in one function: the local route reports what a turn used as completely
 * as a commercial CLI does, so choosing it costs nothing in what can be
 * accounted for. Measured 2026-09-21 against 0.32.13 — `prompt_eval_count` and
 * `eval_count` sit at the top level of the response beside the durations.
 *
 * No `total`, and no money. The daemon prints neither, and both would be
 * Mind inventing a figure: adding the two counts is arithmetic over a
 * tokenizer nobody named, and a `0` in a currency would be a claim that a
 * GPU-hour is free. What a local turn cost in time is already in `durationMs`;
 * what it cost in money is its owner's to say, in their price file (D-106,
 * D-139) — until they do, its turns are not charged.
 *
 * Anything that is not a parseable object with both counts in it — an error
 * body, an HTML page from a proxy, a turn that never left — is `missing`,
 * which is the same answer a vendor changing its shape would get.
 *
 * No cache counts either (S15.9): the measured response has no field for one,
 * so both are null on every turn and listed in `not_printed` — a statement
 * about the daemon, not about this turn, and never a 0. The split of a cache
 * write (D-143) likewise.
 */
export function extractOllamaUsage(raw: string): Usage {
  const missing: Usage = { ...OLLAMA_SHAPE, status: "missing", input: null, output: null };

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return missing;
  }
  if (typeof body !== "object" || body === null) return missing;

  const record = body as Record<string, unknown>;
  const input = tokenCount(record["prompt_eval_count"]);
  const output = tokenCount(record["eval_count"]);
  return { ...OLLAMA_SHAPE, status: input !== null && output !== null ? "reported" : "missing", input, output };
}


/** A model served over HTTP by a local ollama. */
export class OllamaExec implements ExecBackend {
  readonly id = "ollama";
  readonly display = "Ollama (local)";
  readonly kind = "http" as const;
  /** A first-class system field, so identity lands at full strength. */
  readonly identityStrength: IdentityStrength = "system";

  /**
   * Base URL this instance will talk to, as configured.
   *
   * Readable rather than private since S3.5: `asLocal` in `local.ts` has to be
   * able to look at it, because `OLLAMA_HOST` can point anywhere and "ollama
   * means local" is therefore a claim about run time, not about a class. It is
   * `readonly` and normalised in the constructor, so nothing can move it after
   * the check.
   */
  readonly host: string;
  /**
   * The model a turn that names none runs: the one it was built with, else MIND_OLLAMA_MODEL. Readable
   * since S15.9, because a turn's ledger line records the model that ran and is priced by it.
   */
  readonly defaultModel: string | undefined;

  constructor(options: OllamaOptions = {}) {
    this.host = (options.host ?? process.env["OLLAMA_HOST"] ?? DEFAULT_HOST).replace(/\/$/, "");
    // A chain like `claude,codex,ollama` names no model, and the model a vendor
    // wants is not one ollama has — so the local fallback needs its own:
    // MIND_OLLAMA_MODEL, when nothing more specific was given.
    const fromEnv = readMind(OLLAMA_MODEL_ENV, process.env)?.trim();
    this.defaultModel = options.defaultModel ?? (fromEnv === undefined || fromEnv === "" ? undefined : fromEnv);
  }

  /** Is the daemon answering? Lists tags, which loads no model and costs nothing. */
  async available(): Promise<Availability> {
    try {
      const response = await fetch(`${this.host}/api/tags`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) {
        return { ok: false, detail: `${this.host}: HTTP ${response.status}` };
      }
      const body = (await response.json()) as { models?: Array<{ name?: string }> };
      const count = body.models?.length ?? 0;
      return {
        ok: count > 0,
        detail:
          count > 0
            ? `${this.host}: ${count} model(s)`
            : `${this.host}: reachable but no models pulled`,
      };
    } catch (cause) {
      return { ok: false, detail: `${this.host}: unreachable (${String(cause)})` };
    }
  }

  async run(request: TurnRequest): Promise<TurnResult> {
    const model = request.model ?? this.defaultModel;
    const startedAt = performance.now();

    if (model === undefined) {
      // Not a model failure: nobody said which model to use, so no request ever
      // left this process. That is a failure to have run, which is what
      // `silent` means — and it is the caller's input that was missing, not a
      // programmer error, so it is reported rather than thrown.
      return this.result(request, "", `no model given and no default configured — pass --model, or set ${OLLAMA_MODEL_ENV}`, 0);
    }

    const messages = [
      ...(request.system === undefined
        ? []
        : [{ role: "system" as const, content: request.system }]),
      { role: "user" as const, content: request.prompt },
    ];

    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeout])
      : timeout;

    try {
      const response = await fetch(`${this.host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages, stream: false }),
        signal,
      });

      const raw = await response.text();
      const durationMs = Math.round(performance.now() - startedAt);

      if (!response.ok) {
        // The daemon never took the turn — the HTTP twin of a non-zero exit.
        // The body is diagnostics, so it goes in `raw` and not in `text`.
        return this.result(request, "", `HTTP ${response.status}: ${raw}`, durationMs);
      }

      let body: OllamaChatResponse;
      try {
        body = JSON.parse(raw) as OllamaChatResponse;
      } catch {
        // Reachable, answered, and unparseable. Bytes came back, but no usable
        // answer did — and calling the bytes an answer is how an HTML error
        // page becomes "what the model said". The difference from plain
        // silence is kept where it belongs, in `raw`.
        return this.result(request, "", `unparseable response: ${raw}`, durationMs);
      }

      if (body.error) {
        // "Not logged in", in HTTP. Whatever this says, it is not a reply.
        return this.result(request, "", body.error, durationMs);
      }

      const text = (body.message?.content ?? "").trim();
      return this.result(request, text, raw, durationMs);
    } catch (cause) {
      const durationMs = Math.round(performance.now() - startedAt);
      // Aborted or refused: nothing came back, so this is silence, not a
      // wrong answer.
      return this.result(request, "", String(cause), durationMs);
    }
  }

  /**
   * The only way out of `run`, which is what keeps one rule true here.
   *
   * `backend.ts` says this layer never returns `failed`: judging an answer
   * wrong needs to know what was asked, and only the caller does. That used to
   * be four separate decisions in `run`, each of which could get it wrong on
   * its own — and four of them did. Now the confidence is not a parameter at
   * all: it is derived from whether there is any text, once, here.
   */
  private result(
    request: TurnRequest,
    text: string,
    raw: string,
    durationMs: number,
  ): TurnResult {
    return {
      backend: this.id,
      text,
      // No exit code exists on this path; absence of one is not a failure.
      confidence: classify(text, undefined),
      identityStrength: request.system === undefined ? "none" : "system",
      evidence: {
        source: this.id,
        prompt: request.prompt,
        raw,
        durationMs,
        // `raw` is the whole response body on every route out of `run`, so
        // this is the one place the counts can be read — and reading them here
        // rather than at the four call sites is what keeps the failure routes
        // from each inventing their own answer.
        usage: extractOllamaUsage(raw),
      },
    };
  }
}
