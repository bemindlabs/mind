/**
 * The turn adapter: what `mind turn` records about itself.
 *
 * ## Why this door exists (D-032)
 *
 * The hook adapter watches claude from the outside and the seed reads what the
 * vendors left on disk. Neither sees a turn Mind ran on its own — through
 * ollama, in a container with no vendor CLI at all — and that is precisely the
 * turn I-1 says must keep working. A box that proves the local route and then
 * remembers nothing of it would have the observer switched off on the one path
 * the project is built around. So `mind turn` records itself, through the same
 * store, under the same consent, with the same shape.
 *
 * ## What one record is, and what it is not
 *
 * A local turn has no tool calls to report: `cli-exec` cannot see inside a
 * vendor's turn, and an ollama chat has nothing inside to see. What is left is
 * the one thing the hook adapter also keeps for a prompt — *that a turn
 * happened*, when, where, whether it was answered, and who set it going. Not a
 * word of the prompt, for the reason `record.ts` gives: a short prompt is
 * guessable from its hash, and the ledger already has a `--private` switch for
 * the text.
 *
 * ## `origin`, and the honesty it costs
 *
 * `S3.2 AC3` is the question this field answers, and the one D-024 found no
 * transcript could. A hook has the vendor's word (`source: "user"`). A turn has
 * only the process it is running in, and the process offers one structural fact:
 * whether a terminal is attached. That is the same handle claude's `user` is —
 * a person at a keyboard — so it is used, and it is written down as
 * `promptSource: "terminal"` in Mind's own word rather than borrowing the
 * vendor's.
 *
 * Two cases are deliberately `unknown`:
 *
 * - **No terminal.** A script, a fleet, a `docker exec` — nobody knows, so
 *   nobody guesses. A fleet that wants to stay out entirely already has
 *   `MIND_CAPTURE=off`.
 * - **A spent proposal.** The agent proposed and the owner approved, which is
 *   neither "the owner asked for it" nor "a schedule did". The origin vocabulary
 *   has no word for that yet, and adding one changes the counts that reach git
 *   (`S3.2 AC5`), which is a story of its own. Until then the safe direction is
 *   the one `deriveOrigin` takes for a word it does not know: say `unknown`,
 *   never `owner-prompted`. An agent that learned its own proposals as the
 *   owner's habits is the failure AC3 exists to prevent (D-024).
 *
 * `deriveOrigin` itself is not touched: it reasons over vendor words, and
 * "terminal" is not one. The rule lives here, next to the evidence it reads.
 */

import { CAPTURE_VERSION, TURN_KEY_PREFIX, type CaptureEvidence, type CaptureOrigin, type CaptureRecord } from "../record.ts";

/** The word Mind writes into `promptSource` when a terminal was attached. */
export const TERMINAL_SOURCE = "terminal";

/** What a turn knows about itself. Every field is a fact the command already has. */
export interface TurnCapture {
  /** The turn's id — the same one the ledger records, so the two can be matched. */
  readonly turnId: string;
  /** When the turn was sent, ISO-8601. */
  readonly at: string;
  /** The working directory the turn was run from. */
  readonly project: string;
  /** The backend that answered, or `""` when nothing did. */
  readonly backend: string;
  /** The vendor's confidence in its own answer, straight from `TurnResult`. */
  readonly confidence: "confirmed" | "partial" | "failed" | "silent";
  /** stdin and stderr were both terminals when the command ran. */
  readonly terminal: boolean;
  /** A proposal was spent on this turn — the agent set it going, not a person. */
  readonly proposal: boolean;
}

/**
 * The outcome word for a confidence word. Two vocabularies, mapped once.
 *
 * `silent` is `unknown` and not `failed`, for the reason the two are kept apart
 * everywhere else: a backend that printed nothing has not said the task failed.
 */
export function turnOutcome(confidence: TurnCapture["confidence"]): CaptureRecord["outcome"] {
  switch (confidence) {
    case "confirmed":
    case "partial":
      return "ok";
    case "failed":
      return "failed";
    case "silent":
      return "unknown";
  }
}

/** The evidence a turn leaves. `subagent` is always false: Mind has none. */
export function turnEvidence(capture: Pick<TurnCapture, "terminal">): CaptureEvidence {
  return {
    promptSource: capture.terminal ? TERMINAL_SOURCE : null,
    permissionMode: null,
    subagent: false,
    humanTurnsInSession: capture.terminal ? 1 : 0,
  };
}

/**
 * Who set this turn going, from the two facts above and nothing else.
 * Order matters: a spent proposal is `unknown` even at a terminal, because the
 * person at the terminal approved rather than asked.
 */
export function turnOrigin(capture: Pick<TurnCapture, "terminal" | "proposal">): CaptureOrigin {
  if (capture.proposal) return "unknown";
  return capture.terminal ? "owner-prompted" : "unknown";
}

/** The key for a turn — `<vendor>:prompt:<turnId>` with the engine's own vendor name, unique because the id is. */
export function turnKey(turnId: string): string {
  return `${TURN_KEY_PREFIX}${turnId}`;
}

/** One record for one turn. Pure: the caller decides whether to write it. */
export function turnRecord(capture: TurnCapture): CaptureRecord {
  return {
    v: CAPTURE_VERSION,
    key: turnKey(capture.turnId),
    at: capture.at,
    vendor: "mind",
    session: capture.turnId,
    project: capture.project,
    kind: "prompt",
    // The backend's name is behaviour — "asks ollama" — and not a secret; it
    // goes in `tool`, the slot the hook adapter uses for the tool's own name.
    tool: capture.backend,
    target: "",
    outcome: turnOutcome(capture.confidence),
    source: "turn",
    origin: turnOrigin(capture),
    evidence: turnEvidence(capture),
  };
}
