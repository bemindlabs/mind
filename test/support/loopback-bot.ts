/**
 * A reference `BotAdapter` for the fake bot server's default routes (p5 step 2). Test-only: it exists so the
 * conformance suite has an adapter to run against before a real vendor's adapter is written, and so a failure of
 * the suite can be told apart from a failure of an adapter. It speaks to no vendor.
 *
 * The shape: `GET /poll` → `{ messages: [{ chat, from, id, text }] }`; `POST /send` ← `{ chat_id, text }`. The token
 * is read from its file on each call and goes in an `Authorization` header only.
 */

import { readFile } from "node:fs/promises";
import type { BotAdapter } from "../../src/connectors/bot.ts";
import type { ChatMessage, SendResult } from "../../src/connectors/chat.ts";

export interface LoopbackBotOptions {
  readonly origin: string;
  readonly tokenFile: string;
  readonly botId?: string;
  readonly timeoutMs?: number;
}

export function loopbackBot(options: LoopbackBotOptions): BotAdapter {
  const botId = options.botId ?? "loopback-bot";
  const timeout = options.timeoutMs ?? 400;
  const authorization = async (): Promise<Record<string, string>> => ({
    authorization: `Bearer ${(await readFile(options.tokenFile, "utf8")).trim()}`,
  });
  const reasonOf = (error: unknown): string => (error instanceof Error ? error.name : "failed");

  return {
    botId,
    platform: botId,
    endpointOrigin: options.origin,
    tokenFile: options.tokenFile,
    capabilities: { initiates: false, maxTextBytes: 2000 },

    async poll() {
      try {
        const res = await fetch(`${options.origin}/poll`, { headers: await authorization(), signal: AbortSignal.timeout(timeout) });
        if (!res.ok) return { messages: [], error: `${botId} answered ${res.status}` };
        const body = (await res.json()) as { messages?: unknown };
        const messages: ChatMessage[] = [];
        if (Array.isArray(body.messages)) {
          for (const raw of body.messages as Record<string, unknown>[]) {
            const { chat, from, id, text } = raw;
            if (typeof chat === "string" && typeof from === "string" && typeof id === "string" && typeof text === "string") {
              messages.push({ platform: botId, chatId: chat, userId: from, messageId: id, text });
            }
          }
        }
        return { messages };
      } catch (error) {
        return { messages: [], error: `${botId} could not be polled (${reasonOf(error)})` };
      }
    },

    async send(chatId: string, text: string): Promise<SendResult> {
      try {
        const res = await fetch(`${options.origin}/send`, {
          method: "POST",
          headers: { ...(await authorization()), "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
          signal: AbortSignal.timeout(timeout),
        });
        return res.ok ? { ok: true } : { ok: false, reason: `${botId} answered ${res.status}` };
      } catch (error) {
        return { ok: false, reason: `${botId} could not be reached (${reasonOf(error)})` };
      }
    },
  };
}
