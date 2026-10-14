/**
 * The Grok Bot adapter (S9, p5 step 5): xAI's assistant as a chat platform, behind `BotAdapter`.
 *
 * **Assumed wire.** What xAI's bot API looks like, whether its terms allow an automated agent to talk to it, and
 * what it costs are the owner's to supply (TBD-OWNER in the bridge plan). This file speaks the shape below, which
 * is ours and is run only against the fake bot server in `test/`; when the real API is known, this file is the one
 * that changes (S9.1 AC4) and the conformance suite says whether it still holds.
 *
 * - `GET  <origin>/v1/bot/updates` → `{ updates: [{ id, conversation: { id }, sender: { id }, content: { text } }] }`
 * - `POST <origin>/v1/bot/reply`   ← `{ conversation_id, content: { text } }`
 *
 * Off by default, twice over: nothing registers or imports this adapter, and it has **no default origin** — a caller
 * has to hand it one, so no build of mind can reach a vendor by accident (I-1: nothing depends on it; I-6: the only
 * text that reaches `send` has been through `guardBot`). The token is read from its file on each call, goes in the
 * `Authorization` header and nowhere else, and is never in an error.
 */

import { readFile } from "node:fs/promises";
import type { BotAdapter } from "./bot.ts";
import type { ChatMessage, SendResult } from "./chat.ts";

export const GROK_BOT_ID = "grok-bot";

export interface GrokBotOptions {
  /** `https://…` (or loopback http for a fake). There is no default: the vendor's address is the owner's to give. */
  readonly origin: string;
  readonly tokenFile: string;
  readonly timeoutMs?: number;
  /** The longest text one reply may carry, in bytes. Whatever the vendor's limit is; 4000 until it is known. */
  readonly maxTextBytes?: number;
}

interface Update {
  readonly id?: unknown;
  readonly conversation?: { readonly id?: unknown };
  readonly sender?: { readonly id?: unknown };
  readonly content?: { readonly text?: unknown };
}

export function grokBot(options: GrokBotOptions): BotAdapter {
  const timeout = options.timeoutMs ?? 5000;
  const authorization = async (): Promise<Record<string, string>> => ({
    authorization: `Bearer ${(await readFile(options.tokenFile, "utf8")).trim()}`,
  });
  // Only the kind of failure, never the error's message: it may carry a path, a URL or text that was being sent.
  const reasonOf = (error: unknown): string => (error instanceof Error ? error.name : "failed");

  return {
    botId: GROK_BOT_ID,
    platform: GROK_BOT_ID,
    endpointOrigin: options.origin,
    tokenFile: options.tokenFile,
    capabilities: { initiates: false, maxTextBytes: options.maxTextBytes ?? 4000 },

    async poll() {
      try {
        const res = await fetch(`${options.origin}/v1/bot/updates`, { headers: await authorization(), signal: AbortSignal.timeout(timeout) });
        if (!res.ok) return { messages: [], error: `${GROK_BOT_ID} answered ${res.status}` };
        const body = (await res.json()) as { updates?: unknown };
        const messages: ChatMessage[] = [];
        if (Array.isArray(body.updates)) {
          for (const update of body.updates as Update[]) {
            const chatId = update?.conversation?.id;
            const userId = update?.sender?.id;
            const messageId = update?.id;
            const text = update?.content?.text;
            if (typeof chatId === "string" && typeof userId === "string" && typeof messageId === "string" && typeof text === "string" && text !== "") {
              messages.push({ platform: GROK_BOT_ID, chatId, userId, messageId, text });
            }
          }
        }
        return { messages };
      } catch (error) {
        return { messages: [], error: `${GROK_BOT_ID} could not be polled (${reasonOf(error)})` };
      }
    },

    async send(chatId: string, text: string): Promise<SendResult> {
      try {
        const res = await fetch(`${options.origin}/v1/bot/reply`, {
          method: "POST",
          headers: { ...(await authorization()), "content-type": "application/json" },
          body: JSON.stringify({ conversation_id: chatId, content: { text } }),
          signal: AbortSignal.timeout(timeout),
        });
        return res.ok ? { ok: true } : { ok: false, reason: `${GROK_BOT_ID} answered ${res.status}` };
      } catch (error) {
        return { ok: false, reason: `${GROK_BOT_ID} could not be reached (${reasonOf(error)})` };
      }
    },
  };
}
