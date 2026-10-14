/**
 * The conversation a turn belongs to (D-095). A turn is otherwise alone: the web page's chat sends the last
 * exchanges with each message, and they ride in the system prompt under a heading of their own — not in the
 * prompt, so the ledger's "asked" stays what the person typed this time.
 *
 * What leaves the machine is screened like everything else, one message at a time: a message that trips the
 * egress filter is held back from a cloud backend rather than holding the whole turn back, so saying one's
 * own name once does not keep every later turn on the local model.
 */

export interface Exchange {
  readonly role: "you" | "agent";
  readonly text: string;
}

/** Six exchanges: a question and its answer, six times. */
export const MAX_MESSAGES = 12;
export const MAX_MESSAGE_CHARS = 4000;

/** The history a caller passed, checked for shape; each message trimmed to its limit. */
export function parseHistory(raw: string): { readonly ok: true; readonly items: readonly Exchange[] } | { readonly ok: false; readonly reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "the history is not JSON" };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: "the history is a list of {role, text}" };
  const items: Exchange[] = [];
  for (const entry of parsed.slice(-MAX_MESSAGES)) {
    const e = (entry ?? {}) as Record<string, unknown>;
    if ((e["role"] !== "you" && e["role"] !== "agent") || typeof e["text"] !== "string") return { ok: false, reason: "each message is {role: you|agent, text}" };
    const text = e["text"].trim().slice(0, MAX_MESSAGE_CHARS);
    if (text !== "") items.push({ role: e["role"], text });
  }
  return { ok: true, items };
}

/** The messages a cloud backend may be shown, and how many were held back on this machine. */
export function forCloud(items: readonly Exchange[], clean: (text: string) => boolean): { readonly kept: readonly Exchange[]; readonly held: number } {
  const kept = items.filter((m) => clean(m.text));
  return { kept, held: items.length - kept.length };
}

/** The heading and the messages, for the system prompt; nothing when there is none. */
export function conversationBlock(items: readonly Exchange[], held = 0): string {
  if (items.length === 0 && held === 0) return "";
  const lines = items.map((m) => `${m.role === "you" ? "The person" : "You"}: ${m.text}`);
  const note = held > 0 ? `\n\n(${held} earlier message(s) are not shown here: they hold personal details that stay on this machine.)` : "";
  return `## This conversation so far\n\nEarlier in this conversation, oldest first. The person's new message is the prompt.\n\n${lines.join("\n\n")}${note}`;
}
