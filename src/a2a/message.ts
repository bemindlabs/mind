/**
 * S8.2 — one A2A 1.0.0 message, in and out (D-063).
 *
 * The shape `bwoc a2a` speaks: JSON-RPC 2.0, method `SendMessage`, params
 * `{ message: { role, parts: [{ text }], messageId, contextId? } }`, and an
 * ack that is itself a Message from the agent. Text parts only, like bwoc's v1;
 * anything else is said, not silently dropped.
 *
 * Every message in or out is written to the ledger *before* it is delivered
 * or sent (AC5), as a line whose backend names the direction and the peer
 * (`a2a:in:<peer>`, `a2a:out:<peer>`) — the same record a turn leaves, so
 * `ledger show`, `ledger forget` and `erase` reach it with no new path.
 */

import type { LedgerEntry } from "../ledger/entry.ts";
import type { SubjectId } from "../types.ts";
import type { Peer } from "./peers.ts";

export const SEND_MESSAGE = "SendMessage";
/** A2A's cap on what this side accepts in one request. */
export const MAX_BODY_BYTES = 64 * 1024;

export const RPC = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  unauthorized: -32001,
  tooMany: -32002,
});

export interface Inbound {
  readonly id: string | number | null;
  readonly messageId: string;
  readonly contextId: string | null;
  readonly text: string;
  readonly nonText: boolean;
}

export type InboundParse = { readonly ok: true; readonly message: Inbound } | { readonly ok: false; readonly id: string | number | null; readonly code: number; readonly error: string };

/** Read a JSON-RPC request as a `SendMessage`, or say why it is not one. */
export function parseInbound(body: unknown): InboundParse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, id: null, code: RPC.invalidRequest, error: "not a JSON-RPC request" };
  const req = body as Record<string, unknown>;
  const id = typeof req["id"] === "string" || typeof req["id"] === "number" ? req["id"] : null;
  if (req["jsonrpc"] !== "2.0") return { ok: false, id, code: RPC.invalidRequest, error: 'jsonrpc must be "2.0"' };
  if (req["method"] !== SEND_MESSAGE) return { ok: false, id, code: RPC.methodNotFound, error: `only ${SEND_MESSAGE} is served here` };
  const message = (req["params"] as Record<string, unknown> | undefined)?.["message"] as Record<string, unknown> | undefined;
  const messageId = message?.["messageId"];
  const parts = message?.["parts"];
  if (typeof messageId !== "string" || messageId === "" || !Array.isArray(parts)) {
    return { ok: false, id, code: RPC.invalidParams, error: "params.message needs messageId and parts" };
  }
  const texts: string[] = [];
  let nonText = false;
  for (const part of parts as Record<string, unknown>[]) {
    if (typeof part?.["text"] === "string" && Object.keys(part).length === 1) texts.push(part["text"] as string);
    else nonText = true;
  }
  const contextId = typeof message?.["contextId"] === "string" ? (message["contextId"] as string) : null;
  return { ok: true, message: { id, messageId, contextId, text: texts.join("\n"), nonText } };
}

export function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** The ack a sender gets: a Message from this agent. */
export function ackFor(message: Inbound, agentName: string): Record<string, unknown> {
  return {
    role: "ROLE_AGENT",
    parts: [{ text: `delivered to ${agentName}'s inbox — a person reads it before anything is done` }],
    messageId: `ack-${message.messageId}`,
    ...(message.contextId === null ? {} : { contextId: message.contextId }),
  };
}

/** The request we send to a peer. */
export function sendRequest(text: string, messageId: string, contextId?: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: messageId,
    method: SEND_MESSAGE,
    params: { message: { role: "ROLE_USER", parts: [{ text }], messageId, ...(contextId === undefined ? {} : { contextId }) } },
  };
}

/** The text of a peer's answer, whatever shape of success it came back as. */
export function answerText(body: unknown): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
  const b = body as Record<string, unknown> | null;
  const error = b?.["error"] as { message?: unknown } | undefined;
  if (error !== undefined) return { ok: false, reason: typeof error.message === "string" ? error.message : "the peer answered with an error" };
  const result = b?.["result"] as Record<string, unknown> | undefined;
  if (result === undefined) return { ok: false, reason: "the peer's answer had no result" };
  const parts = (result["parts"] ?? (result["status"] as Record<string, unknown> | undefined)?.["message"]) as unknown;
  const list = Array.isArray(parts) ? parts : Array.isArray((parts as Record<string, unknown> | undefined)?.["parts"]) ? ((parts as Record<string, unknown>)["parts"] as unknown[]) : [];
  const text = list.map((p) => (typeof (p as Record<string, unknown>)?.["text"] === "string" ? (p as Record<string, string>)["text"] : "")).filter((t) => t !== "").join("\n");
  return { ok: true, text };
}

/** One ledger line for one message, written before it is delivered or sent (AC5). */
export function messageEntry(options: {
  readonly subject: SubjectId;
  readonly direction: "in" | "out";
  readonly peer: string;
  readonly messageId: string;
  readonly text: string;
  readonly at: Date;
  readonly content: "full" | "withheld";
}): LedgerEntry {
  const full = options.content === "full";
  return {
    v: 1,
    kind: "turn",
    id: crypto.randomUUID(),
    turn: options.messageId,
    at: options.at.toISOString(),
    subject: options.subject,
    backend: `a2a:${options.direction}:${options.peer}`,
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

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Send one message to an allowed peer. Never throws. */
export async function sendToPeer(
  peer: Peer,
  text: string,
  messageId: string,
  fetchImpl: Fetch = fetch,
): Promise<{ readonly ok: true; readonly answer: string } | { readonly ok: false; readonly reason: string }> {
  try {
    const response = await fetchImpl(peer.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(peer.outboundToken === null ? {} : { authorization: `Bearer ${peer.outboundToken}` }),
      },
      body: JSON.stringify(sendRequest(text, messageId)),
      signal: AbortSignal.timeout(30_000),
      // The endpoint is the one the owner allowed. A 307 or 308 would send this message, and the bearer, to a host
      // nobody allowed (EEA-14), so a redirect is an error to the sender, not something followed.
      redirect: "error",
    });
    if (!response.ok) return { ok: false, reason: `${peer.name} answered HTTP ${response.status}` };
    const answer = answerText(await response.json());
    return answer.ok ? { ok: true, answer: answer.text } : answer;
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
