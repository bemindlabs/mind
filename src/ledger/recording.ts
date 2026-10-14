/**
 * The seam where a turn becomes a line.
 *
 * A wrapper around one backend rather than a hook inside `FallbackExec`, for a
 * reason that is the whole design of S2.2: `run` is called exactly when a
 * prompt is really handed over. A backend the chain found `unavailable` never
 * had the text and gets no line; a chain that tried three backends and got an
 * answer from the third produces three lines only if three of them were
 * actually asked. "Who received this prompt?" is the question I-6 turns on,
 * and wrapping `run` is the only place where the answer is a fact rather than
 * an inference from the shape of the chain.
 *
 * Nothing here imports anything from `src/exec/` but types. The ledger must
 * stay provably free of network access (AC4), and a test walks this file's
 * import graph looking for exactly that.
 */

import type { ExecBackend, TurnRequest, TurnResult } from "../exec/backend.ts";
import type { Availability, BackendKind, IdentityStrength } from "../exec/backend.ts";
import { byteLength, LEDGER_VERSION, type LedgerContent, type LedgerEntry } from "./entry.ts";
import { RECORD_TIMING } from "./lock.ts";
import { append, type LedgerEnv } from "./store.ts";
import { chargeTurn } from "../pricing/cost.ts";
import type { PricesInForce } from "../pricing/table.ts";
import { UNREPORTED_USAGE, type TurnModel } from "../types.ts";

/** What one line says about its model (D-142): see `LedgerEntry.model` and `model_requested`. */
export interface ModelOfTurn {
  /** The model the turn ran on, as far as it is known; what the line is priced by. */
  readonly model: string | null;
  /** The model Mind asked the backend for, or null for the backend's own default. */
  readonly requested: string | null;
  /**
   * True when a vendor CLI's output named no model at all — the one case {@link requested} may price the line,
   * and then only by an exact price-table name (`pricingModel`). False when it named one or more, and for a
   * backend that runs its model by construction.
   */
  readonly silent: boolean;
}

/**
 * The model facts of one turn, from what the backend said and what Mind knows it handed over (D-142).
 *
 * @param told A vendor CLI's own account (`evidence.model`), or undefined from a backend that gives none.
 * @param named The model the request itself named, when a caller ran one backend directly with one.
 * @param runs The model this backend runs by construction — ollama's, a local CLI's `local-coder` — or null for a
 *   vendor CLI, whose model is whatever it says it ran.
 */
export function modelOfTurn(told: TurnModel | undefined, named: string | null, runs: string | null): ModelOfTurn {
  if (told === undefined) {
    const model = named ?? runs;
    return { model, requested: model, silent: false };
  }
  const reported = told.reported;
  // One name, and a readable one, or nothing: a turn that called two models ran on neither alone, and a slot
  // the reader could not read is a name nobody may price by.
  const single = reported.length === 1 ? (reported[0] ?? null) : null;
  return {
    model: single ?? (reported.length === 0 ? runs : null),
    requested: told.requested ?? runs,
    silent: reported.length === 0,
  };
}

export interface RecordingOptions {
  readonly ledger: LedgerEnv;
  /** Shared by every line this one `mind turn` writes. */
  readonly turnId: string;
  /** Unique per line. Injected so a test does not have to accept a uuid it cannot predict. */
  readonly newId: () => string;
  /** `withheld` is `--private`: the line is written, the text is not. */
  readonly content: LedgerContent;
  /**
   * The model this backend runs by construction, or null for a vendor CLI (S15.9, D-142).
   *
   * ollama runs the model Mind hands the daemon; a local CLI runs `local-coder`. A vendor CLI is different:
   * the model it was handed is only a request (`opus` is an alias), so its line names the model its own output
   * reports and records the request apart, as `model_requested` — see {@link modelOfTurn}. A model named in the
   * request itself wins over this, because that is the one the backend received.
   */
  readonly model: string | null;
  /**
   * The price tables in force when this turn began (S15.9). Every line is priced against them at the moment
   * it is written, and records which table and which rates — nothing is priced afterwards, when the table
   * that was in force can no longer be known.
   */
  readonly prices: PricesInForce;
  /** sha256 of the rendered soul this turn wore. */
  readonly soulSha: string | null;
  /**
   * Where a failed write goes.
   *
   * Not a thrown error: {@link ExecBackend} promises never to throw for an
   * ordinary failure, and a caller looping over a chain must not be derailed.
   * Not swallowed either — the caller is expected to print these and exit
   * non-zero, because a turn that happened with no record of it is precisely
   * what S2.2 exists to prevent.
   */
  readonly onWriteFailure: (error: Error) => void;
}

/** One backend, plus a line in the ledger for every prompt it is handed. */
export class RecordingExec implements ExecBackend {
  constructor(
    private readonly inner: ExecBackend,
    private readonly options: RecordingOptions,
  ) {}

  // Every identifying property is the wrapped backend's, so a fallback trail
  // reads `claude: unavailable (…)` and not `recording(claude): …`. Recording
  // is not a backend an operator chose and should not appear as one.
  get id(): string {
    return this.inner.id;
  }
  get display(): string {
    return this.inner.display;
  }
  get kind(): BackendKind {
    return this.inner.kind;
  }
  get identityStrength(): IdentityStrength {
    return this.inner.identityStrength;
  }

  /** Delegated, and never recorded: a readiness probe sends no prompt. */
  available(): Promise<Availability> {
    return this.inner.available();
  }

  async run(request: TurnRequest): Promise<TurnResult> {
    // Taken before the call, so the line says when the prompt left rather than
    // when the answer came back.
    const at = this.options.ledger.now().toISOString();
    const result = await this.inner.run(request);

    try {
      // After the send: the prompt has gone, so the line waits a minute for the lock rather than the five
      // seconds a gate gets — giving up now would lose the record of something that happened (D-145).
      await append(this.options.ledger, this.entryFor(at, request, result), RECORD_TIMING);
    } catch (cause) {
      this.options.onWriteFailure(cause instanceof Error ? cause : new Error(String(cause)));
    }
    return result;
  }

  private entryFor(at: string, request: TurnRequest, result: TurnResult): LedgerEntry {
    const withheld = this.options.content === "withheld";
    // A backend that reported nothing still gets a usage object rather than
    // an absent field, so that "written before counts existed" (absent) and
    // "written by a backend nobody surveyed" (`unreported`) stay two
    // different facts a reader can tell apart.
    const usage = result.evidence.usage ?? UNREPORTED_USAGE;
    const about = modelOfTurn(result.evidence.model, request.model ?? null, this.options.model);
    // D-142: the requested name is offered to the price table only when the output named no model at all.
    const charge = chargeTurn(usage, this.inner.id, about.model, this.options.prices, about.silent ? about.requested : null);
    return {
      v: LEDGER_VERSION,
      kind: "turn",
      id: this.options.newId(),
      turn: this.options.turnId,
      at,
      subject: request.subject,
      // The wrapped backend's id, not `result.backend`: a `FallbackExec` above
      // this one rewrites that field to name the chain, and the line has to
      // say which single backend held the text.
      backend: this.inner.id,
      model: about.model,
      model_requested: about.requested,
      content: this.options.content,
      prompt: withheld ? null : request.prompt,
      prompt_bytes: byteLength(request.prompt),
      text: withheld ? null : result.text,
      text_bytes: byteLength(result.text),
      confidence: result.confidence,
      exit: result.evidence.exitCode ?? null,
      duration_ms: result.evidence.durationMs ?? null,
      // See `LedgerEntry.cost`: Mind's price for the counts below, never the
      // vendor's own figure — or null, and `not_charged` says why (D-110).
      cost: charge.cost,
      not_charged: charge.not_charged,
      usage,
      identity: result.identityStrength,
      soul_sha: this.options.soulSha,
    };
  }
}
