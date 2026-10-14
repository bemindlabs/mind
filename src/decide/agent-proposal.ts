/**
 * Level 1 means *propose*: the agent says what it would do instead of doing it
 * — S5.2 AC1 (D-045).
 *
 * At level 1 every vendor already runs with its read-only flag, so nothing the
 * model decides to do can happen. What was missing is the other half: the
 * thing it *would* have done going somewhere a person can approve it. This
 * file is that half — the instruction the turn adds to the system prompt, and
 * the reader that turns what came back into proposals for the store S5.2
 * already has.
 *
 * The format is a fenced block with its own language tag, because it survives
 * every backend's markdown and is unambiguous to find: a model that writes
 * JSON in prose has not filed anything.
 */

/** The fence's language tag. */
export const PROPOSAL_FENCE = "mind-proposal";

/** Added to the system prompt of a turn at level 1. */
export const PROPOSE_INSTRUCTION = [
  "## Acting level: 1 — propose (Mind)",
  "",
  "You may read and answer, but you cannot change anything: no file is written, no command " +
    "with side effects runs, nothing outside is contacted. If a complete answer would need " +
    "any of those, do not say or imply it was done. Say what you would do, and end your " +
    "answer with one block per action, exactly in this form:",
  "",
  "```" + PROPOSAL_FENCE,
  '{"what": "the action, in one sentence", "why": "the reason", "impact": "what it would change or affect"}',
  "```",
  "",
  "The owner will approve or refuse each one. If nothing needs doing, write no block.",
].join("\n");

/** One action the agent asked for. */
export interface AgentAsk {
  readonly what: string;
  readonly why: string;
  readonly impact: string;
}

/** What was found in an answer. */
export interface AgentAsks {
  readonly asks: readonly AgentAsk[];
  /** Blocks with the tag that did not hold three non-empty strings. */
  readonly unreadable: number;
}

/** The longest a field may be; beyond it the block is not a proposal but a dump. */
const FIELD_MAX = 2000;

/** Find every proposal block in an answer. Pure. */
export function extractAsks(text: string): AgentAsks {
  const asks: AgentAsk[] = [];
  let unreadable = 0;
  const fence = new RegExp("```" + PROPOSAL_FENCE + "[ \\t]*\\r?\\n([\\s\\S]*?)```", "g");
  for (const match of text.matchAll(fence)) {
    let raw: unknown;
    try {
      raw = JSON.parse(match[1] ?? "");
    } catch {
      unreadable += 1;
      continue;
    }
    const field = (key: string): string | undefined => {
      const value = (raw as Record<string, unknown> | null)?.[key];
      return typeof value === "string" && value.trim() !== "" && value.length <= FIELD_MAX
        ? value.trim()
        : undefined;
    };
    const what = field("what");
    const why = field("why");
    const impact = field("impact");
    if (what === undefined || why === undefined || impact === undefined) {
      unreadable += 1;
      continue;
    }
    asks.push({ what, why, impact });
  }
  return { asks, unreadable };
}
