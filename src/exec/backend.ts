/**
 * The hand Mind works with — and the seam that keeps it unowned.
 *
 * I-1 says every capability must have a local path that really works. That is
 * only true if nothing above this file knows whether a turn was served by a
 * vendor CLI over a pipe or by a model on this machine over HTTP. So the
 * interface is written for the *harder* of the two (a subprocess that can
 * hang, exit 0 with nothing, or write its answer to the wrong stream) and the
 * HTTP path conforms to it, rather than the other way round.
 *
 * The acceptance test for this seam is blunt (S0.1 → A5/AC6): take
 * `claude` and `codex` off PATH and the work still finishes on a local model
 * alone.
 */

import type { Confidence, Evidence, SubjectId } from "../types.ts";
import type { BrowserHands } from "../browser/mcp-config.ts";
import type { FencePolicy } from "./fence.ts";
import type { Restraint } from "./restraint.ts";

/** How a backend is reached. Callers should not branch on this; reporting may. */
export type BackendKind =
  /** A subprocess: argv, stdio, exit code. */
  | "cli"
  /** An HTTP endpoint on this machine or a reachable host. */
  | "http"
  /**
   * Inference inside the Mind process (D-002's "grow into native"). Reserved:
   * nothing in `src/` implements it yet. It is here so the day one does, it
   * fits `ExecBackend` as it stands — `test/exec/native-stub.test.ts` compiles
   * and runs a stub against the trait to keep that true (S2.1 AC5).
   */
  | "native";

/**
 * How strongly a backend can carry an identity.
 *
 * Measured per vendor, not assumed. Only some CLIs accept a system prompt on
 * the command line; the rest read a file and treat it as user-level text,
 * which a model may weigh less. Mind reports the difference instead of
 * pretending the backends are equivalent.
 */
export type IdentityStrength =
  /** Delivered as a real system prompt through a documented flag or field. */
  | "system"
  /** Delivered as user-level instructions in a file the vendor reads. */
  | "user"
  /** No channel at this scope at all. */
  | "none";

/** One turn to run, always on behalf of exactly one subject (AC4). */
export interface TurnRequest {
  /** Whose identity this turn belongs to. Never implicit. */
  readonly subject: SubjectId;
  /** What to ask. Sent verbatim. */
  readonly prompt: string;
  /**
   * Proof that the autonomy dial decided this turn's level (S5.1).
   *
   * Required, with no default, and the requirement is the whole mechanism. A
   * `Restraint` can only be minted by `restrain()` from an `EffectiveDial`, so
   * a turn cannot be composed by code that skipped the file, the environment
   * ceiling, the stop flag and the minimum — `tsc` refuses it rather than a
   * reviewer noticing. The direction is the one that surprises people: the
   * restraint is on by default and this value is what can take it off. See
   * `src/exec/restraint.ts`.
   *
   * Backends that are not a vendor CLI still carry it. They have no read-only
   * flag to drop, but level 0 means *do not run this turn*, and that is a
   * decision about the turn rather than about the vendor.
   */
  readonly restraint: Restraint;
  /**
   * Identity text to carry as a system prompt, when the backend has a channel
   * for it. Backends with `identityStrength === "user"` ignore this and rely
   * on the file `mind soul apply` wrote; they must say so in the result.
   */
  readonly system?: string;
  /** Vendor model id. Omitted means the backend's own default. */
  readonly model?: string;
  /** Hard wall-clock ceiling. A backend that blows it is `silent`, not `failed`. */
  readonly timeoutMs?: number;
  /**
   * How long a timed-out or cancelled turn's processes get after SIGTERM before SIGKILL (D-044). Omitted means the
   * engine's own 4 s; a test passes a short one so that the ending is not a seconds-long wait.
   */
  readonly killAfterMs?: number;
  /** Lets a caller cancel without waiting out the timeout. */
  readonly signal?: AbortSignal;
  /**
   * Environment overrides for a backend that spawns a process.
   *
   * Exists for one measurable reason: the file a vendor CLI reads is chosen by
   * `$HOME` (and `$CODEX_HOME`) at spawn time, so a caller that wants to ask
   * "did the identity in *this* home arrive?" has to be able to say which home.
   * Without it, a turn would silently read the operator's real instruction file
   * while the report talked about another one. Backends reached over HTTP
   * ignore this.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Working directory for a backend that spawns a process.
   *
   * Two of the vendors here resolve their only instruction file against the
   * working directory, so this is part of the same question as `env`.
   */
  readonly cwd?: string;
  /**
   * Kernel boundary for a vendor CLI that runs tools against a model on this
   * machine (D-118). Omitted for cloud turns and backends that do not spawn.
   * A present policy is fail-closed: if the kernel cannot enforce it, the turn
   * is refused rather than run on the vendor's flags alone.
   */
  readonly fence?: FencePolicy;
  /**
   * A task's browser (D-151, D-155): the one MCP server this turn is handed,
   * through a config file Mind writes (`src/browser/mcp-config.ts`). A
   * backend that cannot be handed *only* that server refuses the turn rather
   * than run it without the browser it was asked to use. A local backend adds
   * the container's port — and only that — to its fence.
   *
   * Nothing in `mind turn` sets this yet: the `operate` dial (D-153) is what
   * will decide when a turn gets hands on a browser.
   */
  readonly browser?: BrowserHands;
}

/**
 * What came back, plus enough evidence for a human to disagree with it.
 *
 * S2.1 AC1 asks this interface for `(output, exit_code, duration, cost)`. The
 * first three are `text`, `evidence.exitCode` and `evidence.durationMs`. The
 * fourth is `evidence.usage`, and a backend reports it in **tokens, never in
 * money** — a decision, not a gap left for later.
 *
 * The vendor's money was measurable and was rejected. claude prints
 * `total_cost_usd` and it came back at $0.81 for a two-character answer, nearly
 * all of it the list price of writing 81,000 tokens into a cache that a
 * subscription holder is not billed for. codex quotes API rates the same way. A
 * local model has no bill at all, and writing `0` there would claim that
 * electricity and a GPU-hour are free. None of those figures is read.
 *
 * Tokens survive that test because they are read rather than priced: they are
 * what the backend itself printed about its own turn. Pricing them is a
 * separate step with its own claim — the ledger line does it (S15.9, D-139),
 * against a price table it names, and says so when it cannot.
 */
export interface TurnResult {
  readonly backend: string;
  /** The model's answer, extracted from whatever shape the vendor printed. */
  readonly text: string;
  /**
   * Note that `silent` is a distinct outcome from `failed`: a CLI that exits 0
   * having printed nothing has not failed at the task, it has failed to run,
   * and the two need different fixes.
   */
  readonly confidence: Confidence;
  readonly evidence: Evidence;
  /** How the identity actually reached this turn. */
  readonly identityStrength: IdentityStrength;
  /**
   * Set when this turn was held below the dial because its backend is not kernel-fenced (D-163, Q4-D2):
   * the plain sentence saying what was capped and why. Absent on every other turn.
   */
  readonly capped?: string;
}

/** Whether a backend can be used right now, and why not when it cannot. */
export interface Availability {
  readonly ok: boolean;
  /** One line a human can act on. */
  readonly detail: string;
  /** Vendor version string when cheaply obtainable. */
  readonly version?: string;
}

/**
 * A place a turn can be sent.
 *
 * Implementations must not throw for an unavailable backend or a failed turn —
 * both are results. Throwing is reserved for programmer error, so that a
 * caller looping over every backend cannot be derailed by one of them missing.
 */
export interface ExecBackend {
  readonly id: string;
  readonly display: string;
  readonly kind: BackendKind;
  /** The strongest channel this backend offers for identity. */
  readonly identityStrength: IdentityStrength;

  /**
   * Whether **this backend's own exec path** puts this request behind the D-118 kernel fence.
   *
   * Optional, and absent means no: a backend that does not say is not fenced, so a turn on it is held at write
   * and run 1 (D-163, Q4-D2). Fail closed — a new backend is capped until it can prove, per request, that its
   * `run` applies the fence. See `src/exec/cap.ts`.
   */
  appliesFence?(request: TurnRequest): boolean;

  /** Cheap readiness check. Must not run a turn or spend quota. */
  available(): Promise<Availability>;

  /** Run one turn. Never throws for an ordinary failure. */
  run(request: TurnRequest): Promise<TurnResult>;
}

/**
 * Classify what a backend produced — as far as this layer can honestly tell.
 *
 * This layer can distinguish "a reply arrived" from "nothing did". It cannot
 * tell whether a reply is *right*: that needs to know what was asked, which
 * only the caller does. So `failed` is never returned here. A caller that can
 * judge the content narrows `confirmed` to `failed` itself.
 *
 * The return type says so as well as the prose does. It is deliberately
 * narrower than `Confidence`: a rule a comment states is a rule a test has to
 * catch after the fact, and this one is worth having `tsc` refuse.
 *
 * A non-zero exit means the CLI did not finish its turn. Whatever it printed
 * is diagnostics — "Not logged in", a usage error, a stack trace — not an
 * answer, and reading it as one is the mistake this function used to make:
 * an unauthenticated CLI was reported as a model that answered wrongly, and
 * the report went on to blame the identity channel for a login problem. Two
 * different faults, two different fixes, and the wrong one named.
 */
export function classify(text: string, exitCode: number | undefined): "confirmed" | "silent" {
  if (exitCode !== undefined && exitCode !== 0) return "silent";
  if (text.trim().length === 0) return "silent";
  return "confirmed";
}
