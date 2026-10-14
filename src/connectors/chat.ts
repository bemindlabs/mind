/**
 * E9 — the agent in a chat app, where the other side is a real person (D-066).
 *
 * A connector is an adapter (S9.1 AC4): it polls a platform for messages and
 * sends text back, and knows nothing else. Everything that decides — who may
 * be answered, what must be said, what may leave — is here, once, for every
 * platform a connector is written for.
 *
 * The gate is E8's and stricter (S9.2): the reader is a person, and a message
 * on somebody else's platform stays there.
 * - Only people on the allowlist are answered; anyone else gets **nothing** —
 *   not a refusal, which would confirm an agent is there (AC2).
 * - The agent says it is an AI in its first message to each person, and
 *   whenever it is asked (AC1).
 * - An answer carrying anything flagged personal is never sent: not with a
 *   warning, not with a human's approval — there is no approval path at all
 *   (AC3). The person is told it cannot be shared here.
 * - Every message in and out is in the ledger (S9.1 AC3).
 */

import { PROPOSAL_FENCE } from "../decide/agent-proposal.ts";
import type { EgressFinding } from "../egress/filter.ts";
import type { LedgerEntry } from "../ledger/entry.ts";
import type { SubjectId } from "../types.ts";

export interface ChatMessage {
  readonly platform: string;
  readonly chatId: string;
  readonly userId: string;
  readonly messageId: string;
  readonly text: string;
}

export type SendResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** What a platform adapter is. Adding a platform is a new file with one of these (S9.1 AC4). */
export interface ChatConnector {
  readonly platform: string;
  /** New messages since the last poll. Never throws; an error is an empty poll and a reason. */
  poll(): Promise<{ readonly messages: readonly ChatMessage[]; readonly error?: string }>;
  send(chatId: string, text: string): Promise<SendResult>;
}

/** Asked whether it is a person, in English or Thai — answered with the disclosure every time. */
export const ASKED_IF_HUMAN =
  /\b(are|r)\s+(you|u)\s+(a\s+)?(human|person|real|bot|ai|robot|machine)\b|\bis this (a )?(bot|human|person|ai)\b|เป็นคน(จริง)?(ไหม|หรือเปล่า|รึเปล่า|มั้ย)|เป็น\s*(ai|เอไอ|บอท|หุ่นยนต์)(ไหม|หรือเปล่า|รึเปล่า|มั้ย)?|คุยกับ(คน|บอท|ai)/i;

export function disclosure(agentName: string): string {
  return `I'm ${agentName}, an AI agent — not a person.`;
}

/** Said in place of a proposal the turn filed: the person learns the owner was asked, not what about. */
export const ASKED_OWNER_REPLY = "I've passed that to the owner to decide.";

/**
 * The answer as a person should read it. A level-1 turn files what it would
 * do as a fenced proposal for the owner (S5.2); that block is the owner's to
 * read, not the person's — it names this machine's internals — so it is taken
 * out here, before screening, and said in one sentence instead.
 */
export function forChat(text: string): string {
  const fence = new RegExp("```" + PROPOSAL_FENCE + "[ \\t]*\\r?\\n[\\s\\S]*?(```|$)", "g");
  const stripped = text.replace(fence, "");
  if (stripped === text) return text.trim();
  const rest = stripped.replace(/\n{3,}/g, "\n\n").trim();
  return rest === "" ? ASKED_OWNER_REPLY : `${rest}\n\n${ASKED_OWNER_REPLY}`;
}

/** Said instead of an answer that may not leave on this channel. Carries nothing of it. */
export const WITHHELD_REPLY = "I can't share that here.";

export interface ChatDeps {
  readonly agentName: string;
  readonly allowed: (platform: string, userId: string) => Promise<boolean>;
  /** Whether this person has not yet been told it is an AI. */
  readonly firstContact: (platform: string, userId: string) => Promise<boolean>;
  /** They have now been told — called only once the telling was sent. */
  readonly contacted: (platform: string, userId: string) => Promise<void>;
  /**
   * One ledger line; throws if it cannot be written, and then nothing is sent.
   * `withheld` keeps only the size: an outsider's words are not ours to keep.
   */
  readonly record: (direction: "in" | "out", message: ChatMessage, text: string, content: "full" | "withheld") => Promise<void>;
  /** A turn, held at level 1 by the caller. The answer's text, or why there is none. */
  readonly turn: (text: string) => Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string }>;
  /** The filter and the local judge, both. Any finding keeps the answer in. */
  readonly screen: (text: string) => Promise<readonly EgressFinding[]>;
  readonly onBlocked: (findings: readonly EgressFinding[]) => Promise<void>;
  readonly send: (chatId: string, text: string) => Promise<SendResult>;
}

export type Handled =
  | { readonly kind: "ignored" }
  | { readonly kind: "answered"; readonly text: string }
  | { readonly kind: "withheld" }
  | { readonly kind: "failed"; readonly reason: string };

/** One incoming message, start to finish. */
export async function handleMessage(message: ChatMessage, deps: ChatDeps): Promise<Handled> {
  if (!(await deps.allowed(message.platform, message.userId))) {
    // AC2: no answer at all. The message is still in the ledger (S9.1 AC3), by size only.
    await deps.record("in", message, message.text, "withheld");
    return { kind: "ignored" };
  }
  await deps.record("in", message, message.text, "full");

  const answer = await deps.turn(message.text);
  const first = await deps.firstContact(message.platform, message.userId);
  const mustDisclose = first || ASKED_IF_HUMAN.test(message.text);

  let body = answer.ok ? forChat(answer.text) : "";
  if (body === "") body = answer.ok ? "" : "I couldn't answer that just now.";
  const findings = body === "" ? [] : await deps.screen(body);
  let withheld = false;
  if (findings.length > 0) {
    await deps.onBlocked(findings);
    body = WITHHELD_REPLY;
    withheld = true;
  }
  const text = mustDisclose ? `${disclosure(deps.agentName)}${body === "" ? "" : `\n\n${body}`}` : body;
  if (text === "") return { kind: "failed", reason: answer.ok ? "empty answer" : answer.reason };

  await deps.record("out", message, text, "full");
  const sent = await deps.send(message.chatId, text);
  if (!sent.ok) return { kind: "failed", reason: sent.reason };
  if (first) await deps.contacted(message.platform, message.userId);
  return withheld ? { kind: "withheld" } : { kind: "answered", text };
}

/**
 * One ledger line for one chat message, written before anything is sent
 * (S9.1 AC3). The backend names the platform, the direction and the person —
 * `chat:telegram:in:<user>` — so `ledger show`, `ledger forget` and `erase`
 * reach it by the path every turn already uses.
 */
export function chatEntry(options: {
  readonly subject: SubjectId;
  readonly direction: "in" | "out";
  readonly message: ChatMessage;
  readonly text: string;
  readonly at: Date;
  readonly content: "full" | "withheld";
}): LedgerEntry {
  const full = options.content === "full";
  return {
    v: 1,
    kind: "turn",
    id: crypto.randomUUID(),
    turn: `${options.message.platform}:${options.message.chatId}:${options.message.messageId}`,
    at: options.at.toISOString(),
    subject: options.subject,
    backend: `chat:${options.message.platform}:${options.direction}:${options.message.userId}`,
    model: null,
    content: options.content,
    prompt: full ? options.text : null,
    prompt_bytes: new TextEncoder().encode(options.text).length,
    text: null,
    text_bytes: 0,
    confidence: "confirmed",
    exit: null,
    duration_ms: null,
    cost: null,
    identity: "none",
    soul_sha: null,
  };
}

/** What the turn is asked: the person's words, framed so the agent knows who is reading. */
export function chatPrompt(message: ChatMessage): string {
  return (
    `A message from ${message.platform} user ${message.userId}, a person the owner allowed. ` +
    "Your answer is sent to them as a chat message; they are not the owner.\n\n" +
    message.text
  );
}
